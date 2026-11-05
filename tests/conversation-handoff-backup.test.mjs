// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { prepareConversationHandoff, previewConversationHandoff } from '../core/conversation-handoff.mjs';
import { prepareConversationBranch, previewConversationBranch } from '../core/conversation-branch.mjs';

const time = '2026-10-29T08:00:00.000Z';
const later = '2026-10-29T09:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const fileSnapshot = (name, content) => ({ path: name, content, sha256: hash(content) });
const missing = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
const readArchive = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function writeArchive(file, envelope) { envelope.sha256 = hash(JSON.stringify(envelope.payload)); await fs.writeFile(file, JSON.stringify(envelope)); }
function sourceSession() {
  return { id: randomUUID(), title: '保留全部原文的来源', providerId: 'demo', createdAt: time, updatedAt: time, run: null, approvals: [], messages: [
    { id: randomUUID(), role: 'user', content: '原任务的真实请求', createdAt: time, contextFiles: [fileSnapshot('gone.txt', '\ufeff历史文件\r\n')] },
    { id: randomUUID(), role: 'assistant', content: '原任务答复；不继承任何写入批准。', createdAt: time },
  ] };
}
function continuation(source, summary = '\ufeff  用户审阅的摘要\r\n保留精确格式。\r\n') {
  const preview = previewConversationHandoff(source);
  const prepared = prepareConversationHandoff(source, { requestId: randomUUID(), expectedSourceHash: preview.source.hash, summary, content: '请从这里继续', providerId: 'demo' }, { now: () => later });
  prepared.session.messages.push({ id: randomUUID(), role: 'user', content: prepared.content, createdAt: later, contextHandoff: prepared.contextHandoff });
  return prepared.session;
}
function completedRun(session, id = randomUUID()) {
  return { id, status: 'completed', steps: [{ id: randomUUID(), type: 'model', title: '模型响应', detail: '', status: 'completed', createdAt: later,
    usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null } }],
  output: null, error: null, startedAt: later, finishedAt: later, requestMessageId: session.messages[0].id, requestPreview: session.messages[0].content };
}
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-handoff-backup-'));
  const identity = await fs.lstat(root, { bigint: true }), stores = new Set();
  const f = { root, dataDir: path.join(root, 'data'), output: path.join(root, 'archive.json'), restored: path.join(root, 'restored') };
  f.workspace = path.join(f.dataDir, 'workspace');
  await fs.mkdir(f.workspace, { recursive: true }); await fs.writeFile(path.join(f.workspace, 'note.txt'), 'current file remains unchanged\r\n');
  f.open = (directory = f.dataDir) => { const store = new Store(directory); stores.add(store); return store; };
  f.close = store => { store.close(); stores.delete(store); };
  t.after(async () => {
    for (const store of stores) store.close();
    const canonical = await fs.realpath(root), actual = await fs.lstat(root, { bigint: true });
    assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-handoff-backup-[a-zA-Z0-9]+$/u);
    assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
    await fs.rm(canonical, { recursive: true, force: true });
  });
  const store = f.open(); f.source = sourceSession(); f.session = continuation(f.source);
  store.putSession(f.source, { createOnly: true }); store.putSession(f.session, { createOnly: true }); f.close(store);
  return f;
}

test('schema4 migrates to schema6 without rewriting messages, provenance, history or usage', async t => {
  const f = await fixture(t), store = f.open();
  store.deleteSession(f.session.id);
  const source = store.getSession(f.source.id); source.run = completedRun(source); store.putSession(source);
  const before = store.exportSessionsWithHistory(), usage = store.getUsageOverview();
  store.db.exec('PRAGMA user_version=4;'); f.close(store);
  const upgraded = f.open();
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.deepEqual(upgraded.exportSessionsWithHistory(), before);
  const { generatedAt: _beforeTime, ...priorUsage } = usage, { generatedAt: _afterTime, ...currentUsage } = upgraded.getUsageOverview();
  assert.deepEqual(currentUsage, priorUsage);
  assert.equal(Object.hasOwn(upgraded.getSession(source.id).messages[0], 'contextHandoff'), false);
});

test('future schema7 is rejected before writable pragmas or table creation', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'future'); await fs.mkdir(directory);
  const file = path.join(directory, 'openaster.sqlite'), db = new DatabaseSync(file);
  db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('unchanged'); PRAGMA user_version=7;"); db.close();
  const before = await fs.readFile(file);
  assert.throws(() => new Store(directory), { code: 'UNSUPPORTED_DATABASE_VERSION', status: 503 });
  assert.deepEqual(await fs.readFile(file), before);
  const reader = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(reader.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.deepEqual(reader.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name), ['sentinel']);
    assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 7);
  } finally { reader.close(); }
});

test('schema6 still refuses missing usage projection tables instead of silently rebuilding corruption', async t => {
  const f = await fixture(t), file = path.join(f.dataDir, 'openaster.sqlite'), db = new DatabaseSync(file);
  db.exec('DROP TABLE usage_meta;'); db.close(); const before = await fs.readFile(file);
  assert.throws(() => new Store(f.dataDir), { code: 'INVALID_USAGE_PROJECTION' });
  assert.deepEqual(await fs.readFile(file), before);
});

test('confirmed handoff survives restart and online export without duplicating source messages or usage', async t => {
  const f = await fixture(t), store = f.open(), value = store.getSession(f.session.id);
  assert.deepEqual(value, f.session); assert.equal(value.messages.length, 1);
  assert.deepEqual(store.getSession(f.source.id), f.source);
  assert.equal(store.getUsageOverview().summary.runs.total, 0);
  assert.equal(store.getRunHistory(f.session.id, 'not-created'), null);
  const exported = store.exportSessionsWithHistory();
  assert.deepEqual(exported.sessions.find(session => session.id === f.session.id), f.session);
  assert.deepEqual(exported.runHistory, []); assert.deepEqual(exported.toolArtifacts, []);
  assert.equal(value.messages[0].contextHandoff.summaryHash, hash(value.messages[0].contextHandoff.summary));
  value.messages[0].contextHandoff.summary = 'caller-only change';
  assert.deepEqual(store.getSession(f.session.id), f.session);
});

test('saved snapshot and owning message identity cannot be changed, removed or introduced later', async t => {
  const f = await fixture(t), store = f.open(), before = store.exportSessionsWithHistory(), usage = store.getUsageOverview();
  const mutations = [
    session => { session.messages[0].contextHandoff.summary += 'changed'; session.messages[0].contextHandoff.summaryHash = hash(session.messages[0].contextHandoff.summary); },
    session => { session.messages[0].contextHandoff.sourceTitle = 'changed'; },
    session => { session.messages[0].contextHandoff.continuationId = randomUUID(); },
    session => { session.messages[0].contextHandoff.requestHash = 'a'.repeat(64); },
    session => { delete session.messages[0].contextHandoff; },
    session => { session.messages[0].id = randomUUID(); },
    session => { session.messages = []; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(f.session); mutate(candidate);
    assert.throws(() => store.putSession(candidate), { code: 'CONTEXT_HANDOFF_IMMUTABLE', status: 409 });
    assert.deepEqual(store.exportSessionsWithHistory(), before); assert.deepEqual(store.getUsageOverview(), usage);
  }
  const legacy = store.getSession(f.source.id); legacy.messages[0].contextHandoff = { ...f.session.messages[0].contextHandoff, sourceSessionId: 'other-origin' };
  assert.throws(() => store.putSession(legacy), { code: 'CONTEXT_HANDOFF_IMMUTABLE', status: 409 });
  const empty = store.createSession(); empty.messages = structuredClone(f.session.messages);
  assert.throws(() => store.putSession(empty), { code: 'CONTEXT_HANDOFF_IMMUTABLE', status: 409 });
  const accepted = store.getSession(f.session.id); accepted.title = 'rename is allowed'; accepted.messages.push({ id: randomUUID(), role: 'assistant', content: 'new reply', createdAt: later });
  store.putSession(accepted); assert.deepEqual(store.getSession(accepted.id), accepted);
});

test('Store validates first-user-only handoffs, hash, source identity and data descriptors before insertion', async t => {
  const f = await fixture(t), store = f.open(); let getterCalls = 0;
  const mutations = [
    session => { session.messages[0].role = 'assistant'; },
    session => { session.messages.unshift({ id: randomUUID(), role: 'user', content: 'preceding message', createdAt: later }); },
    session => { session.messages.push({ ...structuredClone(session.messages[0]), id: randomUUID() }); },
    session => { session.messages[0].contextHandoff.sourceSessionId = session.id; },
    session => { session.messages[0].contextHandoff.summary += 'hash mismatch'; },
    session => { session.messages[0].contextHandoff = null; },
    session => { Object.defineProperty(session.messages[0], 'contextHandoff', { enumerable: true, get() { getterCalls++; throw new Error('must not execute'); } }); },
  ];
  for (const mutate of mutations) {
    const candidate = continuation(f.source); mutate(candidate);
    assert.throws(() => store.putSession(candidate, { createOnly: true }), { code: 'INVALID_CONTEXT_HANDOFF' });
    assert.equal(store.hasSession(candidate.id), false);
  }
  assert.equal(getterCalls, 0);
});

test('first-save transaction failure leaves no continuation, history or usage and never changes the source', async t => {
  const f = await fixture(t), store = f.open(), before = store.exportSessionsWithHistory(), usage = store.getUsageOverview();
  const candidate = continuation(f.source); candidate.run = completedRun(candidate);
  store.db.exec("CREATE TRIGGER fail_handoff_usage BEFORE INSERT ON usage_runs BEGIN SELECT RAISE(ABORT,'handoff transaction rollback'); END;");
  assert.throws(() => store.putSession(candidate, { createOnly: true }), /handoff transaction rollback/u);
  assert.equal(store.hasSession(candidate.id), false); assert.deepEqual(store.exportSessionsWithHistory(), before); assert.deepEqual(store.getUsageOverview(), usage);
  store.db.exec('DROP TRIGGER fail_handoff_usage;'); store.putSession(candidate, { createOnly: true });
  assert.throws(() => store.putSession(candidate, { createOnly: true }), { code: 'BRANCH_ID_CONFLICT' });
  assert.equal(store.getUsageOverview().summary.runs.total, 1);
});

test('v7 exports and restores exact handoff text and independent source records with source bytes unchanged', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'));
  await createBackup(f); const envelope = await readArchive(f.output);
  assert.equal(envelope.version, 8); assert.deepEqual(envelope.payload.runHistory, []); assert.deepEqual(envelope.payload.toolArtifacts, []);
  assert.deepEqual(envelope.payload.sessions.find(session => session.id === f.session.id), f.session);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')), before);
  await restoreBackup({ input: f.output, dataDir: f.restored }); const restored = f.open(f.restored);
  assert.deepEqual(restored.getSession(f.session.id), f.session); assert.deepEqual(restored.getSession(f.source.id), f.source);
  assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(restored.getUsageOverview().summary.runs.total, 0);
  assert.equal(await fs.readFile(path.join(f.restored, 'workspace', 'note.txt'), 'utf8'), 'current file remains unchanged\r\n');
  await missing(path.join(f.restored, 'workspace', 'gone.txt'));
});

test('source rename, later messages and deletion do not invalidate a frozen descriptive handoff on restore', async t => {
  const f = await fixture(t), store = f.open(), source = store.getSession(f.source.id);
  source.title = 'renamed origin'; source.messages.push({ id: randomUUID(), role: 'user', content: 'later content excluded from the earlier summary', createdAt: later }); store.putSession(source);
  f.close(store); await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const restored = f.open(f.restored); assert.deepEqual(restored.getSession(f.session.id), f.session); f.close(restored);
  const origin = f.open(); origin.deleteSession(f.source.id); f.close(origin);
  const output = path.join(f.root, 'deleted-origin.json'), target = path.join(f.root, 'deleted-origin');
  await createBackup({ dataDir: f.dataDir, output }); await restoreBackup({ input: output, dataDir: target });
  const reader = f.open(target); assert.equal(reader.getSession(f.source.id), null); assert.deepEqual(reader.getSession(f.session.id), f.session);
});

test('branch copies keep the original handoff timestamp and continuation ID without binding them to the branch task', async t => {
  const f = await fixture(t), store = f.open(), source = store.getSession(f.session.id);
  source.messages[0].contextFiles = [fileSnapshot('gone.txt', '\ufeffsnapshot carried with summary\r\n')];
  source.messages.push({ id: randomUUID(), role: 'assistant', content: 'reply', createdAt: later }, { id: randomUUID(), role: 'user', content: 'next question', createdAt: later }); store.putSession(source);
  const branches = [];
  for (const [mode, index] of [['prefix', 2], ['message', 0], ['message', 2]]) {
    const preview = previewConversationBranch(source, source.messages[index].id);
    const prepared = prepareConversationBranch(source, { mode, messageId: preview.source.messageId, expectedPrefixHash: preview.source.prefixHash, content: 'edited branch prompt', providerId: 'demo' }, { now: () => '2026-10-29T10:00:00.000Z' });
    const branch = prepared.session;
    branch.messages.push({ id: randomUUID(), role: 'user', content: prepared.content, createdAt: branch.createdAt,
      ...(prepared.contextFiles.length ? { contextFiles: prepared.contextFiles } : {}), ...(prepared.contextHandoff ? { contextHandoff: prepared.contextHandoff } : {}) });
    store.putSession(branch, { createOnly: true }); branches.push(branch);
  }
  assert.deepEqual(branches[0].messages[0].contextHandoff, source.messages[0].contextHandoff);
  assert.deepEqual(branches[1].messages[0].contextHandoff, source.messages[0].contextHandoff);
  assert.equal(Object.hasOwn(branches[2].messages[0], 'contextHandoff'), false);
  f.close(store); await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored }); const restored = f.open(f.restored);
  for (const branch of branches) assert.deepEqual(restored.getSession(branch.id), branch);
});

test('active continuation restore cancels its own run, revokes pending approval and disables external providers', async t => {
  const f = await fixture(t), store = f.open(), source = store.getSession(f.source.id), session = store.getSession(f.session.id);
  source.run = completedRun(source); store.putSession(source);
  store.putProvider({ id: 'remote', name: 'Uncalled fixture', type: 'openai', model: 'test', baseUrl: 'http://127.0.0.1:9/v1', enabled: true }); session.providerId = 'remote';
  session.run = { ...completedRun(session), status: 'awaiting_approval', finishedAt: null };
  session.approvals = [{ id: randomUUID(), sessionId: session.id, runId: session.run.id, tool: 'write_file', args: { path: 'note.txt', content: 'never replay' }, status: 'pending', createdAt: later }];
  store.putSession(session); f.close(store); await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const restored = f.open(f.restored), actual = restored.getSession(session.id);
  assert.deepEqual(actual.messages, session.messages); assert.equal(actual.run.status, 'cancelled'); assert.equal(actual.approvals[0].status, 'denied'); assert.equal(actual.approvals[0].revoked, true);
  assert.equal(restored.getProvider('remote').enabled, false); assert.equal(restored.getUsageOverview().summary.runs.total, 2);
  assert.equal(restored.getUsageOverview().summary.tokens.totalTokens.knownSum, '18');
  assert.equal(await fs.readFile(path.join(f.restored, 'workspace', 'note.txt'), 'utf8'), 'current file remains unchanged\r\n');
});

test('v1 through v5 remain restorable without handoff fields and reject any smuggled handoff field', async t => {
  const f = await fixture(t); await createBackup(f); const current = await readArchive(f.output);
  for (const version of [1, 2, 3, 4, 5]) {
    const envelope = structuredClone(current); envelope.version = version; delete envelope.payload.summaryJobs;
    for (const session of envelope.payload.sessions) for (const message of session.messages) { delete message.contextHandoff; if (version < 3) delete message.contextFiles; }
    if (version < 2) delete envelope.payload.runHistory;
    if (version < 4) delete envelope.payload.toolArtifacts;
    const input = path.join(f.root, `legacy-${version}.json`), target = path.join(f.root, `legacy-${version}`);
    await writeArchive(input, envelope); await restoreBackup({ input, dataDir: target });
    const reader = f.open(target); assert.equal(Object.hasOwn(reader.getSession(f.session.id).messages[0], 'contextHandoff'), false); f.close(reader);
    for (const [index, value] of [null, f.session.messages[0].contextHandoff].entries()) {
      const smuggled = structuredClone(envelope); smuggled.payload.sessions.find(session => session.id === f.session.id).messages[0].contextHandoff = value;
      const bad = path.join(f.root, `legacy-${version}-bad-${index}.json`), destination = path.join(f.root, `legacy-${version}-bad-${index}`);
      await writeArchive(bad, smuggled); await assert.rejects(restoreBackup({ input: bad, dataDir: destination }), { code: 'INVALID_BACKUP' }); await missing(destination);
    }
  }
});

test('v7 rejects malformed snapshot fields, limits, role, position and self-origin despite recomputed archive checksum', async t => {
  const f = await fixture(t); await createBackup(f); const current = await readArchive(f.output);
  const changes = [
    session => { session.messages[0].contextHandoff = null; },
    session => { session.messages[0].contextHandoff.summary += 'mismatch'; },
    session => { session.messages[0].contextHandoff.summaryHash = 'A'.repeat(64); },
    session => { session.messages[0].contextHandoff.sourceHash = 'A'.repeat(64); },
    session => { session.messages[0].contextHandoff.requestHash = 'invalid'; },
    session => { session.messages[0].contextHandoff.continuationId = '../escape'; },
    session => { session.messages[0].contextHandoff.sourceSessionId = session.id; },
    session => { session.messages[0].contextHandoff.sourceMessageCount = 0; },
    session => { session.messages[0].contextHandoff.sourceMessageCount = 202; },
    session => { session.messages[0].contextHandoff.createdAt = 'yesterday'; },
    session => { session.messages[0].contextHandoff.approved = true; },
    session => { delete session.messages[0].contextHandoff.requestHash; },
    session => { session.messages[0].role = 'assistant'; },
    session => { session.messages.unshift({ id: randomUUID(), role: 'user', content: 'before', createdAt: later }); },
    session => { session.messages.push({ ...structuredClone(session.messages[0]), id: randomUUID() }); },
    ...['\0', '\ud800', ' ', 'x'.repeat(24001), '中'.repeat(22000)].map(summary => session => { session.messages[0].contextHandoff.summary = summary; session.messages[0].contextHandoff.summaryHash = hash(summary); }),
  ];
  for (const [index, mutate] of changes.entries()) {
    const envelope = structuredClone(current); mutate(envelope.payload.sessions.find(session => session.id === f.session.id));
    const input = path.join(f.root, `invalid-${index}.json`), target = path.join(f.root, `invalid-${index}`); await writeArchive(input, envelope);
    await assert.rejects(restoreBackup({ input, dataDir: target }), { code: 'INVALID_BACKUP' }, `snapshot mutation ${index}`); await missing(target);
  }
});

test('corrupt persisted handoff refuses readonly export without changing source or creating an archive', async t => {
  const f = await fixture(t), file = path.join(f.dataDir, 'openaster.sqlite'), db = new DatabaseSync(file), corrupt = structuredClone(f.session);
  corrupt.messages[0].contextHandoff.summary += 'changed behind Store'; db.prepare('UPDATE sessions SET value=? WHERE id=?').run(JSON.stringify(corrupt), corrupt.id); db.close();
  const before = await fs.readFile(file); await assert.rejects(createBackup(f), { code: 'INVALID_BACKUP' }); await missing(f.output); assert.deepEqual(await fs.readFile(file), before);
});

test('handoff text remains inside the existing whole-session backup budget', async t => {
  const f = await fixture(t); await createBackup(f); const envelope = await readArchive(f.output), session = envelope.payload.sessions.find(value => value.id === f.session.id);
  session.messages.push(...Array.from({ length: 32 }, () => ({ id: randomUUID(), role: 'user', content: 'context', createdAt: later, contextFiles: [fileSnapshot('large.txt', 'x'.repeat(256 * 1024))] })));
  const input = path.join(f.root, 'over-budget.json'); await writeArchive(input, envelope);
  await assert.rejects(restoreBackup({ input, dataDir: f.restored }), { code: 'INVALID_BACKUP' }); await missing(f.restored);
});

test('failed handoff restore rolls back the new target and preserves original archive and source', async t => {
  const f = await fixture(t); await createBackup(f); const before = await fs.readFile(f.output), database = await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'));
  const original = Store.prototype.putSession;
  t.mock.method(Store.prototype, 'putSession', function (value, options) {
    const result = original.call(this, value, options);
    if (value.id === f.session.id) throw new Error('injected handoff restore failure');
    return result;
  });
  try { await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), /injected handoff restore failure/u); }
  finally { t.mock.restoreAll(); }
  await missing(f.restored); assert.deepEqual(await fs.readFile(f.output), before); assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')), database);
});
