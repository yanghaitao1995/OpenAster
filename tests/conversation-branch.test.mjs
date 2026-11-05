// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { previewConversationBranch, prepareConversationBranch, validateBranchMetadata, validateBranchRequest } from '../core/conversation-branch.mjs';

const time = '2026-10-28T00:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const file = (content = '\ufeff中文\r\n$&🙂') => ({ path: ' original.txt', sha256: hash(content), content });
const message = (id, role, content, extra = {}) => ({ id, role, content, createdAt: time, ...extra });
const source = () => ({ id: 'source', title: '原任务', providerId: 'model', createdAt: time, updatedAt: time, messages: [message('user-one', 'user', '原始约束'), message('answer-one', 'assistant', '已保存回答'), message('user-two', 'user', '原始问题', { contextFiles: [file()] }), message('answer-two', 'assistant', '不要复制的后续答复')], run: null, approvals: [] });
const request = (session, mode = 'prefix') => ({ messageId: 'user-two', expectedPrefixHash: previewConversationBranch(session, 'user-two').source.prefixHash, mode, content: '编辑后的问题', providerId: 'model' });
const metadata = () => prepareConversationBranch(source(), request(source())).session.branch;
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) { const deadline = performance.now() + 5000; while (performance.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Branch fixture timed out'); }
async function fixture(t, { limits, providerCall = async () => ({ content: '新结果', toolCalls: [] }), providers, afterSave } = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-branch-'));
  const workspace = createWorkspace(path.join(root, 'workspace')); await workspace.list();
  let store = new Store(root); store.putProvider({ id: 'model', name: '模型', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', toolMode: 'none' });
  const original = source(); store.putSession(original); let calls = 0;
  const runtime = createRuntime({ workspace: { ...workspace, read() { throw new Error('Branch must not read current disk snapshots'); } }, getSession: async id => store.getSession(id), providers: providers ?? (async id => store.getProvider(id)), saveSession: async (value, options) => { store.putSession(value, options); await afterSave?.(value, options, runtime); }, audit: value => store.audit(value), providerCall: async (...args) => { calls++; return providerCall(...args); }, limits });
  t.after(async () => { await runtime.shutdown(); store.close(); const canonical = await fs.realpath(root); assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-branch-[a-zA-Z0-9]+$/u); await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, original, runtime, get store() { return store; }, calls: () => calls, restart() { store.close(); store = new Store(root); }, done: id => until(() => !runtime.isActive(id)), start(prepared) { return runtime.startBranch(prepared.session, { content: prepared.content, providerId: 'model', contextFiles: prepared.contextFiles }); } };
}

test('preview binds the exact source prefix, identity and title without exposing attachment bodies', () => {
  const original = source(), preview = previewConversationBranch(original, 'user-two');
  assert.equal(preview.previousMessages, 2); assert.equal(preview.content, '原始问题');
  assert.deepEqual(preview.files, [{ path: file().path, bytes: Buffer.byteLength(file().content), sha256: file().sha256 }]);
  assert.equal(JSON.stringify(preview).includes(file().content), false);
  const later = structuredClone(original); later.messages.at(-1).content = 'later changed'; later.updatedAt = new Date().toISOString();
  assert.equal(previewConversationBranch(later, 'user-two').source.prefixHash, preview.source.prefixHash);
  for (const change of [value => value.title += '!', value => value.messages[0].content += '!', value => { value.messages[2].contextFiles = [file('changed')]; }, value => value.id = 'other']) {
    const changed = structuredClone(original); change(changed);
    assert.notEqual(previewConversationBranch(changed, 'user-two').source.prefixHash, preview.source.prefixHash);
    assert.throws(() => prepareConversationBranch(changed, request(original)), { code: 'BRANCH_SOURCE_CHANGED', status: 409 });
  }
});

test('prefix and message branches copy exact snapshots with new IDs and no executable history', () => {
  const original = source(), before = structuredClone(original);
  for (const mode of ['prefix', 'message']) {
    const prepared = prepareConversationBranch(original, request(original, mode));
    assert.notEqual(prepared.session.id, original.id); assert.equal(prepared.session.messages.length, mode === 'prefix' ? 2 : 0);
    for (const [index, copied] of prepared.session.messages.entries()) { assert.notEqual(copied.id, original.messages[index].id); assert.deepEqual({ ...copied, id: original.messages[index].id }, original.messages[index]); }
    assert.deepEqual(prepared.contextFiles, original.messages[2].contextFiles); assert.deepEqual(prepared.session.approvals, []); assert.equal(prepared.session.run, null);
    assert.equal(prepared.session.branch.retainedMessages, prepared.session.messages.length);
    prepared.contextFiles[0].content = 'local mutation';
  }
  assert.deepEqual(original, before);
});

test('branch contracts reject unknown fields, malformed values and accessors without invoking them', () => {
  const valid = metadata();
  for (const patch of [{ version: 2 }, { sourceSessionId: '' }, { sourceMessageId: '../x' }, { sourceTitle: '\ud800' }, { sourcePrefixHash: 'A'.repeat(64) }, { mode: 'automatic' }, { retainedMessages: 201 }, { retainedMessages: -1 }, { retainedMessages: 0.5 }, { mode: 'message', retainedMessages: 2 }, { createdAt: '2026-02-30T00:00:00.000Z' }, { extra: true }]) assert.throws(() => validateBranchMetadata({ ...valid, ...patch }), { code: 'INVALID_BRANCH_REQUEST' });
  assert.throws(() => validateBranchMetadata(null));
  let invoked = false; const accessor = { ...valid }; Object.defineProperty(accessor, 'sourceTitle', { get() { invoked = true; throw new Error(); } });
  assert.throws(() => validateBranchMetadata(accessor)); assert.equal(invoked, false);
  const input = request(source());
  assert.throws(() => prepareConversationBranch(source(), {...input, content: ' '}), {code:'INVALID_BRANCH_REQUEST'}); // Empty text is valid only when the selected source contains images.
  for (const patch of [{ files: [] }, { content: '\0' }, { content: '\ud800' }, { providerId: null }, { skillId: null }, { expectedPrefixHash: 'bad' }]) assert.throws(() => validateBranchRequest({ ...input, ...patch }), { code: 'INVALID_BRANCH_REQUEST' });
});

test('invalid source roles, ambiguous identifiers and altered snapshot hashes cannot silently disappear', () => {
  assert.throws(() => previewConversationBranch(source(), 'answer-one'), { code: 'BRANCH_MESSAGE_NOT_FOUND' });
  assert.throws(() => previewConversationBranch(source(), 'absent'), { code: 'BRANCH_MESSAGE_NOT_FOUND' });
  for (const change of [value => value.messages[0].role = 'system', value => delete value.messages[0], value => value.messages[0].content = '\ud800', value => value.messages[2].contextFiles[0].sha256 = '0'.repeat(64), value => value.messages.push({ ...value.messages[2] })]) {
    const original = source(); change(original); assert.throws(() => previewConversationBranch(original, 'user-two'), { code: 'INVALID_BRANCH_SOURCE' });
  }
  assert.throws(() => prepareConversationBranch(source(), request(source()), { createId: () => 'source' }), { code: 'BRANCH_ID_CONFLICT' });
});

test('real runtime branch keeps source immutable, excludes later replies and uses stored BOM snapshots in none mode', async t => {
  const received = []; const f = await fixture(t, { providerCall: async (_provider, options) => { received.push(options); return { content: '新结果', toolCalls: [], usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }; } });
  const prepared = prepareConversationBranch(f.original, request(f.original)); await f.start(prepared); await f.done(prepared.session.id);
  assert.deepEqual(f.store.getSession('source'), f.original); assert.equal(received.length, 1); assert.deepEqual(received[0].tools, []);
  assert.equal(received[0].messages.length, 3); assert.equal(received[0].messages[0].content, '原始约束');
  const sent = JSON.parse(received[0].messages.at(-1).content); assert.equal(sent.user_request, '编辑后的问题'); assert.equal(sent.attached_files[0].content, file().content);
  const saved = f.store.getSession(prepared.session.id); assert.equal(saved.run.status, 'completed'); assert.equal(saved.messages.length, 4); assert.equal(saved.approvals.length, 0);
  assert.equal(f.store.listRunHistory('source').runs.length, 0); assert.equal(f.store.listRunHistory(saved.id).runs.length, 1);
  assert.equal(f.store.getUsageOverview().summary.tokens.totalTokens.knownSum, '3');
  f.store.deleteSession('source'); f.restart(); assert.deepEqual(f.store.getSession(saved.id), saved); assert.equal(f.store.getSession('source'), null);
});

test('message-only branch visibly discards preceding messages without changing the source', async t => {
  let sent; const f = await fixture(t, { providerCall: async (_provider, options) => { sent = options.messages; return { content: 'done', toolCalls: [] }; } });
  const prepared = prepareConversationBranch(f.original, request(f.original, 'message')); await f.start(prepared); await f.done(prepared.session.id);
  assert.equal(sent.length, 1); assert.equal(f.store.getSession(prepared.session.id).branch.retainedMessages, 0); assert.deepEqual(f.store.getSession('source'), f.original);
});

test('a full conversation can explicitly restart from just the selected message while prefix mode refuses', async t => {
  const f = await fixture(t); const original = source();
  original.messages = [...Array.from({ length: 200 }, (_, i) => message(`old-${i}`, i % 2 ? 'assistant' : 'user', `message ${i}`)), message('user-two', 'user', '最后的问题', { contextFiles: [file()] })];
  f.store.putSession(original);
  const prefix = prepareConversationBranch(original, request(original));
  await assert.rejects(f.start(prefix), { code: 'SESSION_FULL' }); assert.equal(f.store.hasSession(prefix.session.id), false); assert.equal(f.calls(), 0);
  const only = prepareConversationBranch(original, request(original, 'message')); await f.start(only); await f.done(only.session.id);
  assert.equal(f.store.getSession(only.session.id).run.status, 'completed'); assert.equal(f.store.getSession(only.session.id).messages.length, 2);
  assert.deepEqual(f.store.getSession('source'), original);
});

test('a branch never reuses old approvals or rolls back files and every new write needs fresh consent', async t => {
  let round = 0; const f = await fixture(t, { providerCall: async () => ++round === 1 ? { content: '', toolCalls: [{ id: 'new-call', name: 'write_file', args: { path: 'target.txt', content: 'new branch text' } }] } : { content: 'done', toolCalls: [] } });
  f.store.putProvider({ ...f.store.getProvider('model'), toolMode: 'workspace' });
  const target = path.join(f.root, 'workspace', 'target.txt'); await fs.writeFile(target, 'existing side effect');
  const original = structuredClone(f.original); original.approvals = [{ id: 'old-approval', sessionId: original.id, runId: 'old-run', tool: 'write_file', args: { path: 'target.txt', content: 'old text' }, status: 'approved', createdAt: time, resolvedAt: time, appliedAt: time }]; f.store.putSession(original);
  const prepared = prepareConversationBranch(original, request(original)); await f.start(prepared);
  await until(() => f.store.getSession(prepared.session.id)?.run.status === 'awaiting_approval');
  const saved = f.store.getSession(prepared.session.id); assert.equal(saved.approvals.length, 1); assert.notEqual(saved.approvals[0].id, 'old-approval');
  await assert.rejects(f.runtime.decide('old-approval', 'approve'), { code: 'APPROVAL_NOT_PENDING' });
  assert.equal(await fs.readFile(target, 'utf8'), 'existing side effect');
  await f.runtime.decide(saved.approvals[0].id, 'approve'); await f.done(saved.id);
  assert.equal(await fs.readFile(target, 'utf8'), 'new branch text'); assert.deepEqual(f.store.getSession('source'), original);
});

test('exact request budget failure does not create a branch, audit entry or model call', async t => {
  const f = await fixture(t, { limits: { maxRequestBytes: 100 } }); const prepared = prepareConversationBranch(f.original, request(f.original));
  const before = f.store.listAudit(); await assert.rejects(f.start(prepared), { code: 'CONTEXT_TOO_LARGE' });
  assert.equal(f.store.hasSession(prepared.session.id), false); assert.equal(f.store.listSessions().length, 1); assert.deepEqual(f.store.listAudit(), before); assert.equal(f.calls(), 0);
});

test('cancellation while resolving a branch provider leaves no new task or active reservation', async t => {
  const entered = gate(), release = gate(); const f = await fixture(t, { providers: async () => { entered.resolve(); await release.promise; return { id: 'model', name: 'Model', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' }; } });
  const prepared = prepareConversationBranch(f.original, request(f.original)); const pending = f.start(prepared); await entered.promise; f.runtime.cancel(prepared.session.id); release.resolve();
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(f.store.hasSession(prepared.session.id), false); assert.equal(f.runtime.isActive(prepared.session.id), false); assert.equal(f.calls(), 0);
});

test('initial projection failure rolls back the branch and createOnly cannot overwrite a task', async t => {
  const f = await fixture(t); const prepared = prepareConversationBranch(f.original, request(f.original));
  f.store.db.exec("CREATE TRIGGER fail_branch BEFORE INSERT ON usage_runs BEGIN SELECT RAISE(ABORT,'branch fixture failure'); END;");
  await assert.rejects(f.start(prepared), /branch fixture failure/u); assert.equal(f.store.hasSession(prepared.session.id), false); assert.equal(f.calls(), 0);
  f.store.db.exec('DROP TRIGGER fail_branch;'); const other = f.store.createSession(); prepared.session.id = other.id;
  await assert.rejects(f.start(prepared), { code: 'BRANCH_ID_CONFLICT' }); assert.deepEqual(f.store.getSession(other.id), other); assert.equal(f.calls(), 0);
});

test('cancellation after durable first save returns the created branch identity without a model call', async t => {
  const f = await fixture(t, { afterSave(session, options, runtime) { if (options?.createOnly) runtime.cancel(session.id); } });
  const prepared = prepareConversationBranch(f.original, request(f.original)); const started = await f.start(prepared);
  const saved = f.store.getSession(prepared.session.id); assert.equal(started.runId, saved.run.id); assert.equal(saved.run.status, 'cancelled');
  assert.equal(saved.run.error.code, 'CANCELLED'); assert.equal(f.calls(), 0); assert.equal(f.store.listRunHistory(saved.id).runs.length, 1);
  assert.equal(f.runtime.isActive(saved.id), false); assert.deepEqual(f.store.getSession('source'), f.original);
});

test('branch creation enforces the task limit inside its transaction and provenance remains immutable', async t => {
  const f = await fixture(t); const prepared = prepareConversationBranch(f.original, request(f.original));
  f.store.transaction(() => { for (let i = 0; i < 999; i++) f.store.putSession({ ...source(), id: `other-${i}`, messages: [] }); });
  await assert.rejects(f.start(prepared), { code: 'SESSION_LIMIT' }); assert.equal(f.store.hasSession(prepared.session.id), false); assert.equal(f.calls(), 0);
  f.store.deleteSession('other-0'); await f.start(prepared); await f.done(prepared.session.id);
  const saved = f.store.getSession(prepared.session.id), changed = structuredClone(saved); changed.branch.sourceTitle = 'forged';
  assert.throws(() => f.store.putSession(changed), { code: 'BRANCH_IMMUTABLE' }); delete changed.branch;
  assert.throws(() => f.store.putSession(changed), { code: 'BRANCH_IMMUTABLE' }); assert.deepEqual(f.store.getSession(saved.id), saved);
});
