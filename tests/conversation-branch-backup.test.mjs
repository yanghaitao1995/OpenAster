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
import { prepareConversationBranch, previewConversationBranch } from '../core/conversation-branch.mjs';

const time = '2026-10-28T00:00:00.000Z';
const digest = value => createHash('sha256').update(value).digest('hex');
const snapshot = (name, content) => ({ path: name, content, sha256: digest(content) });
const missing = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
const usage = { inputTokens: 13, outputTokens: 4, totalTokens: 17, cachedInputTokens: 3, cacheWriteInputTokens: null, reasoningOutputTokens: 2 };
function run(session, status = 'completed') {
  return { id: randomUUID(), status, startedAt: time, finishedAt: status === 'completed' ? time : null,
    requestMessageId: session.messages.at(-1).id, requestPreview: session.messages.at(-1).content,
    steps: [{ id: randomUUID(), type: 'model', status: 'completed', title: '模型响应', detail: '', createdAt: time, usage: structuredClone(usage) }] };
}
async function fixture(t, mode = 'prefix') {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-branch-backup-'));
  const identity = await fs.lstat(root, { bigint: true });
  t.after(async () => {
    const canonical = await fs.realpath(root), actual = await fs.lstat(root, { bigint: true });
    assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-branch-backup-[a-zA-Z0-9]+$/);
    assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
    await fs.rm(canonical, { recursive: true, force: true });
  });
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace'); await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'note.txt'), 'new disk content\r\n');
  const store = new Store(dataDir), source = store.createSession({ title: '原任务' });
  source.messages = [
    { id: randomUUID(), role: 'user', content: '最初请求', createdAt: time, contextFiles: [snapshot('deleted.txt', '\ufeff最初快照\r\n')] },
    { id: randomUUID(), role: 'assistant', content: '最初答复', createdAt: time },
    { id: randomUUID(), role: 'user', content: '待编辑请求', createdAt: time, contextFiles: [snapshot('note.txt', '\ufeff旧内容\r\n第二行\r\n')] },
  ];
  source.run = run(source); store.putSession(source);
  const preview = previewConversationBranch(source, source.messages.at(-1).id);
  const prepared = prepareConversationBranch(source, { messageId: preview.source.messageId, expectedPrefixHash: preview.source.prefixHash,
    mode, content: '修改后的请求', providerId: 'demo' }, { now: () => time });
  const branch = prepared.session;
  branch.messages.push({ id: randomUUID(), role: 'user', content: prepared.content, createdAt: time, contextFiles: prepared.contextFiles });
  branch.run = run(branch); store.putSession(branch, { createOnly: true });
  const expectedUsage = store.getUsageOverview().summary; store.close();
  return { root, dataDir, workspace, source, branch, expectedUsage, output: path.join(root, 'backup.json'), restored: path.join(root, 'restored') };
}
async function archive(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function rewrite(file, envelope) { envelope.sha256 = digest(JSON.stringify(envelope.payload)); await fs.writeFile(file, JSON.stringify(envelope)); }
function branchIn(envelope, f) { return envelope.payload.sessions.find(session => session.id === f.branch.id); }

for (const mode of ['prefix', 'message']) test(`v7 roundtrips ${mode} branch provenance and exact snapshots without duplicating source usage`, async t => {
  const f = await fixture(t, mode), before = await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'));
  await createBackup(f); const value = await archive(f.output);
  assert.equal(value.version, 9); assert.equal(value.payload.runHistory.length, 2);
  assert.deepEqual(branchIn(value, f), f.branch);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')), before);
  await restoreBackup({ input: f.output, dataDir: f.restored });
  const store = new Store(f.restored);
  try {
    assert.deepEqual(store.getSession(f.source.id), f.source); assert.deepEqual(store.getSession(f.branch.id), f.branch);
    assert.deepEqual(store.getUsageOverview().summary, f.expectedUsage);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM run_history').get().n, 2);
  } finally { store.close(); }
  assert.equal(await fs.readFile(path.join(f.restored, 'workspace', 'note.txt'), 'utf8'), 'new disk content\r\n');
  await missing(path.join(f.restored, 'workspace', 'deleted.txt'));
});

test('branch source may be deleted; its provenance is descriptive, not a foreign execution permission', async t => {
  const f = await fixture(t), store = new Store(f.dataDir); store.deleteSession(f.source.id); store.close();
  await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const restored = new Store(f.restored);
  try {
    assert.equal(restored.getSession(f.source.id), null); assert.deepEqual(restored.getSession(f.branch.id), f.branch);
    assert.equal(restored.getUsageOverview().summary.runs.total, 1);
  } finally { restored.close(); }
});

test('restoring an active branch cancels execution and revokes approvals while preserving its origin and usage', async t => {
  const f = await fixture(t), store = new Store(f.dataDir), branch = store.getSession(f.branch.id);
  branch.run = run(branch, 'awaiting_approval');
  branch.approvals = [{ id: randomUUID(), sessionId: branch.id, runId: branch.run.id, tool: 'write_file',
    args: { path: 'note.txt', content: 'do not replay' }, status: 'pending', createdAt: time }];
  store.putSession(branch); store.close(); await createBackup(f);
  await restoreBackup({ input: f.output, dataDir: f.restored });
  const restored = new Store(f.restored);
  try {
    const actual = restored.getSession(branch.id);
    assert.deepEqual(actual.branch, branch.branch); assert.deepEqual(actual.messages, branch.messages);
    assert.equal(actual.run.status, 'cancelled'); assert.deepEqual(actual.run.steps[0].usage, usage);
    assert.equal(actual.approvals[0].status, 'denied'); assert.equal(actual.approvals[0].revoked, true);
    assert.equal(restored.getUsageOverview().summary.runs.total, 3);
  } finally { restored.close(); }
  assert.equal(await fs.readFile(path.join(f.restored, 'workspace', 'note.txt'), 'utf8'), 'new disk content\r\n');
});

test('v1 through v4 reject branch fields even with valid checksums', async t => {
  const f = await fixture(t); await createBackup(f); const original = await archive(f.output);
  for (const version of [1, 2, 3, 4]) {
    const value = structuredClone(original); value.version = version; delete value.payload.summaryJobs; delete value.payload.steeringInputs;
    if (version < 4) delete value.payload.toolArtifacts;
    if (version < 3) for (const session of value.payload.sessions) for (const message of session.messages) delete message.contextFiles;
    if (version === 1) delete value.payload.runHistory;
    const input = path.join(f.root, `legacy-${version}.json`), dataDir = path.join(f.root, `legacy-${version}`); await rewrite(input, value);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' }); await missing(dataDir);
  }
});

test('invalid v7 branch metadata and relations are rejected before creating a destination', async t => {
  const f = await fixture(t); await createBackup(f); const original = await archive(f.output);
  const mutations = [
    session => session.branch = null,
    session => session.branch.version = 2,
    session => session.branch.sourceSessionId = '../outside',
    session => session.branch.sourceSessionId = session.id,
    session => session.branch.sourceMessageId = '',
    session => session.branch.sourceTitle = 'x'.repeat(161),
    session => session.branch.sourceTitle = '\ud800',
    session => session.branch.sourcePrefixHash = 'A'.repeat(64),
    session => session.branch.mode = 'replay',
    session => session.branch.mode = 'message',
    session => session.branch.retainedMessages = -1,
    session => session.branch.retainedMessages = 0.5,
    session => session.branch.retainedMessages = session.messages.length,
    session => session.branch.retainedMessages = 1,
    session => session.branch.createdAt = 'yesterday',
    session => session.branch.createdAt = '2026-10-29T00:00:00.000Z',
    session => session.branch.approved = true,
    session => delete session.branch.sourcePrefixHash,
    session => session.messages[0].role = 'system',
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = structuredClone(original); mutate(branchIn(value, f));
    const input = path.join(f.root, `bad-${index}.json`), dataDir = path.join(f.root, `bad-${index}`); await rewrite(input, value);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' }, `mutation ${index}`); await missing(dataDir);
  }
});

test('invalid provenance in the source database refuses readonly export without altering source bytes', async t => {
  const f = await fixture(t), file = path.join(f.dataDir, 'openaster.sqlite'), db = new DatabaseSync(file);
  const branch = structuredClone(f.branch); branch.branch.permission = 'approved';
  db.prepare('UPDATE sessions SET value=? WHERE id=?').run(JSON.stringify(branch), branch.id); db.close();
  const before = await fs.readFile(file);
  await assert.rejects(createBackup(f), { code: 'INVALID_BACKUP' }); await missing(f.output);
  assert.deepEqual(await fs.readFile(file), before);
});
