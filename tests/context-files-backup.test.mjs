// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { CONTEXT_FILES_LIMITS } from '../core/context-files.mjs';

const now = '2026-10-28T00:00:00.000Z';
const maxBytes = 256 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const snapshot = (file, content) => ({ path: file, sha256: hash(Buffer.from(content, 'utf8')), content });
const missing = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
async function fixture(t, withContext = true) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'openaster-context-backup-')));
  const identity = await fs.lstat(root, { bigint: true });
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), await fs.realpath(tmpdir()));
    const actual = await fs.lstat(root, { bigint: true });
    assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace');
  await fs.mkdir(workspace, { recursive: true }); await fs.writeFile(path.join(workspace, 'note.txt'), 'current workspace text\r\n');
  const store = new Store(dataDir), session = store.createSession({ title: '附件快照备份' });
  const user = { id: randomUUID(), role: 'user', content: '请参考当时选择的文件', createdAt: now };
  if (withContext) user.contextFiles = [snapshot('note.txt', '\ufeff旧版内容\r\n下一行\r\n')];
  session.messages.push(user); store.putSession(session); store.close();
  return { root, dataDir, workspace, session, output: path.join(root, 'backup.json'), restored: path.join(root, 'restored') };
}
async function archive(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function rewrite(file, value) { value.sha256 = hash(JSON.stringify(value.payload)); await fs.writeFile(file, JSON.stringify(value)); }
function readSession(dataDir, id) { const store = new Store(dataDir); try { return store.getSession(id); } finally { store.close(); } }
function updateSession(f, change) { const store = new Store(f.dataDir); try { const session = store.getSession(f.session.id); change(session); store.putSession(session); return session; } finally { store.close(); } }

test('v7 preserves exact context snapshots across runs without rereading, recreating files, replaying approvals or calling providers', async t => {
  const f = await fixture(t); let calls = 0;
  const upstream = createServer((_request, response) => { calls++; response.writeHead(500); response.end(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const store = new Store(f.dataDir), session = store.getSession(f.session.id);
  store.putProvider({ id: 'remote', name: '本机模拟模型', type: 'openai', model: 'fixture', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, enabled: true });
  session.providerId = 'remote';
  session.messages[0].contextFiles.push(snapshot('no-longer-present.txt', 'snapshot only; never recreate this file'));
  session.run = { id: 'first-run', status: 'completed', steps: [], output: null, error: null, startedAt: now, finishedAt: now, requestMessageId: session.messages[0].id, requestPreview: session.messages[0].content };
  store.putSession(session);
  const nextUser = { id: randomUUID(), role: 'user', content: '使用第二次选择的版本', createdAt: now, contextFiles: [snapshot('note.txt', 'a later attachment snapshot\n')] };
  session.messages.push(nextUser);
  session.run = { id: 'second-run', status: 'awaiting_approval', steps: [], output: null, error: null, startedAt: now, finishedAt: null, requestMessageId: nextUser.id, requestPreview: nextUser.content };
  session.approvals = [{ id: 'never-replay', sessionId: session.id, runId: session.run.id, tool: 'write_file', args: { path: 'note.txt', content: 'must never be restored as a write' }, status: 'pending', createdAt: now }];
  store.putSession(session); store.close();
  const before = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
  await createBackup(f); const value = await archive(f.output);
  assert.equal(value.version, 9); assert.deepEqual(value.payload.sessions[0].messages, session.messages);
  assert.equal(value.payload.runHistory.length, 1);
  assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), before);
  await restoreBackup({ input: f.output, dataDir: f.restored });
  const restored = readSession(f.restored, session.id);
  assert.deepEqual(restored.messages, session.messages); assert.equal(restored.run.status, 'cancelled');
  assert.equal(restored.approvals[0].status, 'denied'); assert.equal(restored.approvals[0].revoked, true);
  assert.equal(await fs.readFile(path.join(f.restored, 'workspace', 'note.txt'), 'utf8'), 'current workspace text\r\n');
  await missing(path.join(f.restored, 'workspace', 'no-longer-present.txt'));
  const db = new DatabaseSync(path.join(f.restored, 'openaster.sqlite'), { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM run_history').get().n, 2); db.close();
  const app = await startServer({ dataDir: f.restored });
  try {
    const response = await fetch(`${app.url}/api/bootstrap`), state = await response.json();
    assert.equal(state.providers.find(provider => provider.id === 'remote').enabled, false);
    const replay = await fetch(`${app.url}/api/approvals/never-replay`, { method: 'POST', headers: { cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': state.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) });
    assert.equal(replay.status, 409); assert.equal(calls, 0);
  } finally { await app.close(); }
  assert.equal(await fs.readFile(path.join(f.restored, 'workspace', 'note.txt'), 'utf8'), 'current workspace text\r\n');
});

test('five context files at the exact raw UTF-8 byte limit roundtrip with BOM and original paths intact', async t => {
  const f = await fixture(t);
  assert.ok(Object.values(CONTEXT_FILES_LIMITS).includes(maxBytes), 'backup fixture follows the shared raw-byte contract');
  const files = [snapshot(' leading-space.txt', '\ufeff' + 'x'.repeat(maxBytes - 3)), ...['a/note.txt', 'b/note.txt', 'empty.txt', 'last.txt'].map(file => snapshot(file, ''))];
  assert.equal(files.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0), maxBytes);
  updateSession(f, session => { session.messages[0].contextFiles = files; });
  await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  assert.deepEqual(readSession(f.restored, f.session.id).messages[0].contextFiles, files);
  await missing(path.join(f.restored, 'workspace', ' leading-space.txt'));
});

test('v1 and v2 without context files remain accepted, while any contextFiles field is rejected in both legacy formats', async t => {
  const f = await fixture(t, false); await createBackup(f); const original = await archive(f.output);
  for (const version of [1, 2]) {
    const legacy = structuredClone(original); legacy.version = version; delete legacy.payload.summaryJobs; delete legacy.payload.steeringInputs; delete legacy.payload.toolArtifacts;
    if (version === 1) delete legacy.payload.runHistory;
    const input = path.join(f.root, `legacy-${version}.json`), dataDir = path.join(f.root, `legacy-${version}`);
    await rewrite(input, legacy); await restoreBackup({ input, dataDir });
    assert.deepEqual(readSession(dataDir, f.session.id).messages, f.session.messages);
    for (const [index, field] of [null, [], [snapshot('note.txt', 'valid snapshot')]].entries()) {
      const tampered = structuredClone(legacy); tampered.payload.sessions[0].messages[0].contextFiles = field;
      const badInput = path.join(f.root, `legacy-${version}-smuggle-${index}.json`), badDir = path.join(f.root, `legacy-${version}-smuggle-${index}`);
      await rewrite(badInput, tampered);
      await assert.rejects(restoreBackup({ input: badInput, dataDir: badDir }), { code: 'INVALID_BACKUP' }); await missing(badDir);
    }
  }
});

test('old schema 1 and schema 2 sessions export valid v7 without inventing context files', async t => {
  for (const version of [1, 2]) {
    const f = await fixture(t, false);
    { const db = new DatabaseSync(path.join(f.dataDir, 'openaster.sqlite')); db.exec('DROP TABLE tool_artifacts;'); if(version===1)db.exec('DROP TABLE run_history;'); db.exec('PRAGMA user_version='+version+';'); db.close(); }
    const before = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
    await createBackup(f); const value = await archive(f.output);
    assert.equal(value.version, 9); assert.ok(Array.isArray(value.payload.runHistory));
    assert.equal(Object.hasOwn(value.payload.sessions[0].messages[0], 'contextFiles'), false);
    assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), before);
    await restoreBackup({ input: f.output, dataDir: f.restored });
    assert.deepEqual(readSession(f.restored, f.session.id).messages, f.session.messages);
  }
});

test('recomputed payload checksums cannot bypass context hashes, roles, UTF-8 budgets or strict shapes', async t => {
  const f = await fixture(t); await createBackup(f); const original = await archive(f.output);
  const mutations = [
    ['null', message => message.contextFiles = null],
    ['empty', message => message.contextFiles = []],
    ['not an array', message => message.contextFiles = {}],
    ['too many', message => message.contextFiles = Array.from({ length: 6 }, (_, index) => snapshot(`file-${index}.txt`, ''))],
    ['hash mismatch', message => message.contextFiles[0].sha256 = '0'.repeat(64)],
    ['upper-case hash', message => message.contextFiles[0].sha256 = message.contextFiles[0].sha256.toUpperCase()],
    ['missing BOM in hash', message => message.contextFiles[0].sha256 = hash(message.contextFiles[0].content.slice(1))],
    ['nul content', message => message.contextFiles = [snapshot('note.txt', 'secret\0text')]],
    ['unpaired high surrogate', message => message.contextFiles = [snapshot('note.txt', '\ud800')]],
    ['unpaired low surrogate', message => message.contextFiles = [snapshot('note.txt', '\udc00')]],
    ['single file over limit', message => message.contextFiles = [snapshot('note.txt', 'x'.repeat(maxBytes + 1))]],
    ['aggregate UTF-8 over limit', message => message.contextFiles = [snapshot('one.txt', '汉'.repeat(50000)), snapshot('two.txt', '汉'.repeat(50000))]],
    ['unknown item field', message => message.contextFiles[0].approved = true],
    ['missing content', message => delete message.contextFiles[0].content],
    ['numeric content', message => message.contextFiles[0].content = 1],
    ['unknown message field', message => message.permissions = 'write'],
    ['assistant attachment', message => message.role = 'assistant'],
    ['traversal path', message => message.contextFiles[0].path = '../outside.txt'],
    ['absolute path', message => message.contextFiles[0].path = 'C:/outside.txt'],
    ['duplicate path', message => message.contextFiles.push(structuredClone(message.contextFiles[0]))],
    ['case alias', message => message.contextFiles.push(snapshot('NOTE.TXT', 'other'))],
  ];
  for (const [index, [label, mutate]] of mutations.entries()) {
    const value = structuredClone(original); mutate(value.payload.sessions[0].messages[0]);
    const input = path.join(f.root, `bad-${index}.json`), dataDir = path.join(f.root, `bad-${index}`); await rewrite(input, value);
    const before = await fs.readFile(input);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' }, label); await missing(dataDir);
    assert.deepEqual(await fs.readFile(input), before, label);
  }
});

test('context snapshots remain subject to the existing per-session backup budget', async t => {
  const f = await fixture(t); await createBackup(f); const value = await archive(f.output), content = 'x'.repeat(maxBytes);
  value.payload.sessions[0].messages = Array.from({ length: 32 }, (_, index) => ({ id: `large-message-${index}`, role: 'user', content: 'context', createdAt: now, contextFiles: [snapshot('note.txt', content)] }));
  const input = path.join(f.root, 'large-session.json'); await rewrite(input, value);
  await assert.rejects(restoreBackup({ input, dataDir: f.restored }), { code: 'INVALID_BACKUP' }); await missing(f.restored);
});

test('invalid snapshots in the actual source database fail export without altering data or creating an archive', async t => {
  const f = await fixture(t); updateSession(f, session => { session.messages[0].contextFiles[0].content += 'changed without updating its hash'; });
  const before = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
  await assert.rejects(createBackup(f), { code: 'INVALID_BACKUP' }); await missing(f.output);
  assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), before);
});

test('format version boundaries do not weaken legacy history or strict future-version rejection', async t => {
  const f = await fixture(t, false); await createBackup(f); const original = await archive(f.output);
  for (const [index, version] of [0, 9, '8', 2.5].entries()) {
    const value = structuredClone(original); value.version = version; delete value.payload.summaryJobs; delete value.payload.steeringInputs;
    const input = path.join(f.root, `unknown-${index}.json`), dataDir = path.join(f.root, `unknown-${index}`); await rewrite(input, value);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' }); await missing(dataDir);
  }
  for (const version of [2, 3]) {
    const value = structuredClone(original); value.version = version; delete value.payload.summaryJobs; delete value.payload.steeringInputs; delete value.payload.toolArtifacts; delete value.payload.runHistory;
    const input = path.join(f.root, `missing-history-${version}.json`), dataDir = path.join(f.root, `missing-history-${version}`); await rewrite(input, value);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' }); await missing(dataDir);
  }
});
