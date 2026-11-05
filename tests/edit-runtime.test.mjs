// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { CoreError } from '../core/errors.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const reply = (toolCalls = []) => ({ content: toolCalls.length ? '' : 'Finished.', toolCalls });
const call = (name, args) => ({ id: `call-${name}`, name, args });
const result = request => JSON.parse(request.messages.at(-1).content);
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Edit runtime fixture timed out');
}
async function fixture(t, options) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-edit-runtime-'));
  const workspace = createWorkspace(root);
  const sessions = new Map([['session', { id: 'session', title: 'Edit test', providerId: 'fixture', createdAt: new Date().toISOString(), messages: [], approvals: [], run: null }]]);
  const audits = [];
  const runtime = createRuntime({
    workspace: options.wrap ? options.wrap(workspace) : workspace,
    providers: async () => ({ id: 'fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', streaming: false }),
    getSession: async id => structuredClone(sessions.get(id)),
    saveSession: async session => sessions.set(session.id, structuredClone(session)),
    audit: async entry => audits.push(entry), providerCall: options.providerCall,
    limits: { maxRunMs: 5000, ...options.limits },
  });
  t.after(async () => {
    await runtime.shutdown();
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^openaster-edit-runtime-[A-Za-z0-9]+$/u);
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, workspace, runtime, audits, get: () => sessions.get('session'), start: () => runtime.start('session', { content: 'Apply the requested exact edit.' }), done: () => until(() => !runtime.isActive('session') && sessions.get('session').run), pending: () => until(() => sessions.get('session').approvals.find(item => item.status === 'pending')) };
}

test('read-derived edit approval binds complete exact text despite later provider argument mutation', async t => {
  const before = '\uFEFF' + 'unchanged 中文🙂\r\n'.repeat(2000) + 'unique=old\r\nlast';
  const after = before.replace('unique=old', () => 'unique=$&new'); let requests = 0, mutable, written, artifactId, offset = 0;
  const chunks = [];
  // Still smaller than the source artifact; leave room for the newly approved
  // shell tool schema while exercising explicit excerpt/page reconstruction.
  const f = await fixture(t, { limits: { maxRequestBytes: 40000 }, providerCall: async (_provider, request) => {
    if (++requests === 1) return reply([call('read_file', { path: 'source.txt' })]);
    if (!mutable) {
      const current = result(request);
      if (current.tool_result_view) {
        const view = current.tool_result_view;
        assert.equal(view.mode, 'excerpt'); artifactId = view.artifactId;
        chunks.push(Buffer.from(view.content)); offset = view.endOffset;
        return reply([call('read_tool_result', { artifactId, offset, maxBytes: 16384 })]);
      }
      const page = current.result; assert.equal(page.artifactId, artifactId); assert.equal(page.offset, offset);
      chunks.push(Buffer.from(page.content)); offset = page.endOffset;
      if (page.nextOffset !== null) return reply([call('read_tool_result', { artifactId, offset: page.nextOffset, maxBytes: 16384 })]);
      const original = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(original.result.sha256, sha(before)); assert.equal(original.result.content, before);
      mutable = { path: 'source.txt', oldText: 'unique=old', newText: 'unique=$&new', expectedHash: original.result.sha256 };
      return reply([call('edit_file', mutable)]);
    }
    written = result(request); return reply();
  } });
  await fs.writeFile(path.join(f.root, 'source.txt'), before); await f.start(); const approval = await f.pending().catch(error => {
    error.message += `; model calls=${requests}; terminal=${JSON.stringify(f.get().run?.error)}`; throw error;
  });
  assert.equal(approval.tool, 'edit_file'); assert.deepEqual(approval.args, { path: 'source.txt', content: after });
  assert.deepEqual(approval.preview, { before, after, originalHash: sha(before), newHash: sha(after) });
  assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), before);
  mutable.newText = 'ATTACK'; mutable.path = 'other.txt'; mutable.expectedHash = '0'.repeat(64);
  await f.runtime.decide(approval.id, 'approve'); await f.done();
  assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), after);
  await assert.rejects(fs.stat(path.join(f.root, 'other.txt')), { code: 'ENOENT' });
  assert.equal(written.result.sha256, sha(after)); assert.ok(f.get().approvals[0].appliedAt);
  assert.equal(f.audits.filter(item => item.action === 'workspace.written').length, 1);
  await assert.rejects(f.runtime.decide(approval.id, 'approve'), { code: 'APPROVAL_NOT_PENDING' });
});

for (const first of ['edit_file', 'write_file']) test(`denying ${first} prohibits fallback through the other write tool`, async t => {
  let requests = 0, outcome; const before = 'before';
  const args = name => name === 'edit_file' ? { path: requests > 1 ? 'SOURCE.txt' : 'source.txt', oldText: before, newText: 'edited', expectedHash: sha(before) } : { path: requests > 1 ? 'SOURCE.txt' : 'source.txt', content: 'rewritten' };
  const f = await fixture(t, { providerCall: async (_provider, request) => {
    requests++;
    if (requests === 1) return reply([call(first, args(first))]);
    if (requests === 2) { assert.equal(result(request).error.code, 'APPROVAL_DENIED'); const other = first === 'edit_file' ? 'write_file' : 'edit_file'; return reply([call(other, args(other))]); }
    outcome = result(request); return reply();
  } });
  await fs.writeFile(path.join(f.root, 'source.txt'), before); await f.start(); await f.runtime.decide((await f.pending()).id, 'deny'); await f.done();
  assert.equal(f.get().approvals.length, 1); assert.equal(outcome.error.code, 'APPROVAL_DENIED');
  assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), before); assert.ok(!f.audits.some(item => item.action === 'workspace.written'));
});

test('a stale read creates no approval; a fresh read permits a new exact proposal', async t => {
  let requests = 0, stale; const f = await fixture(t, { providerCall: async (_provider, request) => {
    if (++requests === 1) return reply([call('edit_file', { path: 'source.txt', oldText: 'old', newText: 'new', expectedHash: sha('outdated') })]);
    if (requests === 2) { stale = result(request); assert.equal(f.get().approvals.length, 0); return reply([call('read_file', { path: 'source.txt' })]); }
    if (requests === 3) return reply([call('edit_file', { path: 'source.txt', oldText: 'old', newText: 'new', expectedHash: result(request).result.sha256 })]);
    return reply();
  } });
  await fs.writeFile(path.join(f.root, 'source.txt'), 'old'); await f.start(); await f.runtime.decide((await f.pending()).id, 'approve'); await f.done();
  assert.equal(stale.error.code, 'WRITE_CONFLICT'); assert.equal(f.get().approvals.length, 1); assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), 'new');
});

test('edit approval after an external change preserves that change and reports no applied write', async t => {
  let requests = 0, outcome; const f = await fixture(t, { providerCall: async (_provider, request) => {
    if (++requests === 1) return reply([call('edit_file', { path: 'source.txt', oldText: 'old', newText: 'new', expectedHash: sha('old') })]);
    outcome = result(request); return reply();
  } });
  await fs.writeFile(path.join(f.root, 'source.txt'), 'old'); await f.start(); const pending = await f.pending();
  await fs.writeFile(path.join(f.root, 'source.txt'), 'external change'); await f.runtime.decide(pending.id, 'approve'); await f.done();
  assert.equal(outcome.error.code, 'WRITE_CONFLICT'); assert.equal(f.get().approvals[0].status, 'approved'); assert.equal(f.get().approvals[0].appliedAt, undefined);
  assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), 'external change'); assert.ok(!f.audits.some(item => item.action === 'workspace.written'));
});

test('cancellation immediately after preparation discards the proposal before publishing approval', async t => {
  let captured; const f = await fixture(t, {
    wrap: workspace => ({ ...workspace, prepareEdit: async (...args) => { captured = await workspace.prepareEdit(...args); f.runtime.cancel('session'); return captured; } }),
    providerCall: async () => reply([call('edit_file', { path: 'source.txt', oldText: 'old', newText: 'new', expectedHash: sha('old') })]),
  });
  await fs.writeFile(path.join(f.root, 'source.txt'), 'old'); await f.start(); await f.done();
  assert.equal(f.get().run.status, 'cancelled'); assert.equal(f.get().approvals.length, 0); assert.ok(!f.audits.some(item => item.action === 'approval.requested'));
  assert.ok(captured); await assert.rejects(f.workspace.commitWrite(captured), { code: 'INVALID_APPROVAL' }); assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), 'old');
});

test('approval budget exhaustion discards an exact edit capability and retains the file', async t => {
  let captured, requests = 0, outcome; const f = await fixture(t, {
    limits: { maxApprovalBytes: 1 },
    wrap: workspace => ({ ...workspace, prepareEdit: async (...args) => { captured = await workspace.prepareEdit(...args); return captured; } }),
    providerCall: async (_provider, request) => { if (++requests === 1) return reply([call('edit_file', { path: 'source.txt', oldText: 'old', newText: 'new', expectedHash: sha('old') })]); outcome = result(request); return reply(); },
  });
  await fs.writeFile(path.join(f.root, 'source.txt'), 'old'); await f.start(); await f.done();
  assert.equal(outcome.error.code, 'APPROVAL_BUDGET'); assert.equal(f.get().approvals.length, 0); assert.ok(captured);
  await assert.rejects(f.workspace.commitWrite(captured), { code: 'INVALID_APPROVAL' }); assert.equal(await fs.readFile(path.join(f.root, 'source.txt'), 'utf8'), 'old');
});

test('post-write cleanup failure stops model work while preserving the actual write and audit fact', async t => {
  let requests = 0;
  const f = await fixture(t, {
    wrap: workspace => ({ ...workspace, commitWrite: async (...args) => { await workspace.commitWrite(...args); throw new CoreError('POST_WRITE_CLEANUP_FAILED', '文件已写入，但临时文件未能安全清理；请检查工作区。', 503); } }),
    providerCall: async () => { requests++; return reply([call('write_file', { path: 'created.txt', content: 'confirmed' })]); },
  });
  await f.start(); await f.runtime.decide((await f.pending()).id, 'approve'); await f.done();
  assert.equal(requests, 1); assert.equal(f.get().run.status, 'failed'); assert.equal(f.get().run.error.code, 'POST_WRITE_CLEANUP_FAILED');
  assert.match(f.get().run.error.message, /已写入/); assert.ok(f.get().approvals[0].appliedAt);
  assert.equal(await fs.readFile(path.join(f.root, 'created.txt'), 'utf8'), 'confirmed');
  const writes = f.audits.filter(item => item.action === 'workspace.written'); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].detail, { path: 'created.txt', bytes: 9, sha256: sha('confirmed'), cleanupPending: true });
});
