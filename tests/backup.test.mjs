// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { acquireDataLock } from '../server/lock.mjs';
import { startServer } from '../server/index.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { createBackup, restoreBackup, BACKUP_LIMITS } from '../server/backup.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const now = '2026-10-27T00:00:00.000Z';
const missing = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'openaster-backup-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, 'data');
  const workspace = path.join(dataDir, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const store = new Store(dataDir);
  const session = store.createSession({ title: '本地备份测试' });
  store.audit({ action: 'fixture.created', detail: '原始审计', sessionId: session.id });
  store.close();
  await fs.mkdir(path.join(workspace, '空目录'));
  await fs.writeFile(path.join(workspace, '笔记.md'), '\ufeff# 原始内容\r\n你好 🌍\n');
  return { root, dataDir, workspace, session, output: path.join(root, 'backup.json'), restored: path.join(root, 'restored') };
}
async function envelope(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function change(file, update, fixHash = true) {
  const value = await envelope(file); update(value);
  if (fixHash) value.sha256 = hash(JSON.stringify(value.payload));
  await fs.writeFile(file, JSON.stringify(value));
}
function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/backup.mjs', ...args], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => stdout += part); child.stderr.on('data', part => stderr += part);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('offline roundtrip preserves all logical records, text bytes and empty directories but no credentials', async t => {
  const f = await fixture(t);
  const external = randomUUID();
  const store = new Store(f.dataDir);
  store.putProvider({ id: external, name: '模型连接', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true, streaming: false, envKey: 'OPENASTER_KEY_BACKUP_TEST', credential: { password: 'forbidden-secret' } });
  const session = store.getSession(f.session.id);
  session.providerId = external;
  session.messages = [{ id: randomUUID(), role: 'user', content: '请保留会话', createdAt: now }];
  session.run = { id: randomUUID(), status: 'awaiting_approval', steps: [{ id: randomUUID(), type: 'tool', title: '准备写入', detail: '', status: 'running', createdAt: now }], output: { stepId: randomUUID(), status: 'streaming', content: '尚未完成' }, startedAt: now, finishedAt: null, error: null };
  session.approvals = [{ id: randomUUID(), sessionId: session.id, runId: session.run.id, tool: 'write_file', args: { path: 'new.txt', content: '不应写入' }, description: '写入提案', preview: { before: null, after: '不应写入', originalHash: null, newHash: hash('不应写入') }, status: 'pending', createdAt: now }];
  store.putSession(session);
  for (let n = 0; n < 400; n++) store.audit({ action: 'fixture.more', detail: String(n), sessionId: session.id });
  store.close();
  await fs.mkdir(path.join(f.dataDir, 'secrets')); await fs.writeFile(path.join(f.dataDir, 'secrets', 'private.secret'), 'do-not-export');
  const dbBefore = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
  const summary = await createBackup(f);
  assert.equal(summary.sessions, 1); assert.equal(summary.audit, 401); assert.equal(summary.workspaceEntries, 2);
  const archive = await envelope(f.output);
  assert.equal(archive.payload.sessions[0].run.status, 'awaiting_approval');
  assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), dbBefore, 'source database is unchanged');
  const serialized = await fs.readFile(f.output, 'utf8');
  for (const secret of ['forbidden-secret', 'do-not-export', 'envKey', 'apiKey', 'hasKey', 'credential']) assert.ok(!serialized.includes(secret));
  await restoreBackup({ input: f.output, dataDir: f.restored });
  assert.deepEqual(await fs.readFile(path.join(f.restored, 'workspace', '笔记.md')), await fs.readFile(path.join(f.workspace, '笔记.md')));
  assert.ok((await fs.stat(path.join(f.restored, 'workspace', '空目录'))).isDirectory());
  await missing(path.join(f.restored, 'secrets')); await missing(path.join(f.restored, 'workspace', 'new.txt'));
  const db = new DatabaseSync(path.join(f.restored, 'openaster.sqlite'), { readOnly: true });
  const restored = JSON.parse(db.prepare('SELECT value FROM sessions').get().value);
  const provider = JSON.parse(db.prepare('SELECT value FROM providers WHERE id=?').get(external).value);
  assert.equal(restored.run.status, 'cancelled'); assert.equal(restored.run.steps[0].status, 'cancelled'); assert.equal(restored.run.output.status, 'interrupted');
  assert.equal(restored.approvals[0].status, 'denied'); assert.equal(provider.enabled, false); assert.equal(provider.envKey, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 401); db.close();
  const app = await startServer({ dataDir: f.restored });
  try {
    const response = await fetch(`${app.url}/api/bootstrap`); const state = await response.json();
    assert.equal(response.status, 200); assert.equal(state.providers.find(p => p.id === external).hasKey, false);
    const result = await fetch(`${app.url}/api/approvals/${restored.approvals[0].id}`, { method: 'POST', headers: { cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': state.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) });
    assert.equal(result.status, 409);
  } finally { await app.close(); }
});

test('all historical pending approvals are denied even for completed tasks', async t => {
  const f = await fixture(t); const store = new Store(f.dataDir); const session = store.getSession(f.session.id);
  session.run = { id: 'old-run', status: 'completed' };
  session.approvals = [{ id: 'historical-pending', status: 'pending' }, { id: 'old-approved', status: 'approved' }];
  store.putSession(session); store.close(); await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const reader = new Store(f.restored); const restored = reader.getSession(f.session.id); reader.close();
  assert.equal(restored.run.status, 'completed'); assert.deepEqual(restored.approvals.map(item => item.status), ['denied', 'approved']);
});

test('active source data lock refuses backup and leaves no output', async t => {
  const f = await fixture(t); const release = await acquireDataLock(f.dataDir);
  try { await assert.rejects(createBackup(f), { code: 'DATA_LOCKED' }); await missing(f.output); }
  finally { await release(); }
  await createBackup(f);
});

test('exclusive output and restore directory refuse existing files or directories without changing them', async t => {
  const f = await fixture(t); await fs.writeFile(f.output, 'existing backup');
  await assert.rejects(createBackup(f), { code: 'BACKUP_EXISTS' }); assert.equal(await fs.readFile(f.output, 'utf8'), 'existing backup');
  await fs.unlink(f.output); await createBackup(f); await fs.mkdir(f.restored); await fs.writeFile(path.join(f.restored, 'keep.txt'), 'keep');
  await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), { code: 'RESTORE_EXISTS' });
  assert.equal(await fs.readFile(path.join(f.restored, 'keep.txt'), 'utf8'), 'keep');
});

test('bad outer hash and per-file hash are rejected before any target is created', async t => {
  for (const kind of ['outer', 'file']) {
    const f = await fixture(t); await createBackup(f);
    await change(f.output, value => { if (kind === 'outer') value.payload.createdAt = '2026-10-28T00:00:00.000Z'; else value.payload.workspace.find(item => item.type === 'file').sha256 = '0'.repeat(64); }, kind !== 'outer');
    await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), { code: kind === 'outer' ? 'BACKUP_HASH_MISMATCH' : 'INVALID_BACKUP' }); await missing(f.restored);
  }
});

test('duplicates, credential-bearing providers, unknown fields and dangling providers fail validation', async t => {
  for (const mutate of [
    p => p.sessions.push(structuredClone(p.sessions[0])),
    p => p.audit.push(structuredClone(p.audit[0])),
    p => p.providers.push(structuredClone(p.providers[0])),
    p => p.providers[0].envKey = 'OPENASTER_KEY_ATTACK',
    p => p.sessions[0].providerId = 'missing',
    p => p.sessions[0].execute = 'do not run',
    p => p.sessions[0].id = '../escape',
    p => p.sessions[0].messages = [null],
  ]) {
    const f = await fixture(t); await createBackup(f); await change(f.output, value => mutate(value.payload));
    await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored })); await missing(f.restored);
  }
});

test('path traversal, missing ancestors, case conflicts, Unicode conflicts and reserved files are rejected', async t => {
  const directory = name => ({ path: name, type: 'directory', sha256: hash(`directory\0${name}`) });
  for (const entries of [
    [directory('../escape')], [directory('C:/escape')], [directory('a/b')],
    [directory('Folder'), directory('folder')], [directory('é'), directory('e\u0301')],
    [directory('CON')], [directory('credentials.json')], [directory('.env')],
    [directory('Folder'), directory('folder/sub')],
  ]) {
    const f = await fixture(t); await createBackup(f); await change(f.output, value => value.payload.workspace = entries);
    await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored })); await missing(f.restored);
  }
});

test('source unsafe file contents and credential names reject entire backup', async t => {
  for (const [name, value] of [['binary.txt', Buffer.from([0x00])], ['invalid.txt', Buffer.from([0xff])], ['.env', 'SECRET=private'], ['secret.secret', 'encrypted'], ['openaster.sqlite', 'db']]) {
    const f = await fixture(t); await fs.writeFile(path.join(f.workspace, name), value);
    await assert.rejects(createBackup(f)); await missing(f.output);
  }
});

test('hard links, workspace junctions, linked ancestors and input links are refused', async t => {
  const f = await fixture(t);
  await fs.link(path.join(f.workspace, '笔记.md'), path.join(f.workspace, 'linked.md'));
  await assert.rejects(createBackup(f), { code: 'UNSAFE_BACKUP_PATH' }); await missing(f.output); await fs.unlink(path.join(f.workspace, 'linked.md'));
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.workspace, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createBackup(f), { code: 'UNSAFE_BACKUP_PATH' }); await fs.unlink(path.join(f.workspace, 'redirect'));
  await createBackup(f);
  await fs.link(f.output, path.join(f.root, 'linked-backup.json'));
  await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), { code: 'UNSAFE_BACKUP_PATH' });
  await fs.unlink(path.join(f.root, 'linked-backup.json'));
  const redirect = path.join(f.root, 'parent-redirect'); await fs.symlink(outside, redirect, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(restoreBackup({ input: f.output, dataDir: path.join(redirect, 'new') }), { code: 'UNSAFE_BACKUP_PATH' });
});

test('output/data overlap and credential directory selected as workspace are refused', async t => {
  const f = await fixture(t);
  for (const output of [path.join(f.dataDir, 'backup.json'), path.join(f.workspace, 'backup.json')]) await assert.rejects(createBackup({ ...f, output }), { code: 'UNSAFE_BACKUP_PATH' });
  await fs.mkdir(path.join(f.dataDir, 'secrets'));
  await assert.rejects(createBackup({ ...f, workspace: path.join(f.dataDir, 'secrets') }), { code: 'UNSAFE_BACKUP_PATH' });
  await assert.rejects(createBackup({ ...f, workspace: f.root }), { code: 'UNSAFE_BACKUP_PATH' });
});

test('bounded reads refuse oversized files and archives before allocation; count limits reject malformed imports', async t => {
  const f = await fixture(t); const large = await fs.open(path.join(f.workspace, 'large.txt'), 'wx');
  await large.truncate(BACKUP_LIMITS.fileBytes + 1); await large.close();
  await assert.rejects(createBackup(f), { code: 'BACKUP_LIMIT' }); await missing(f.output);
  await fs.unlink(path.join(f.workspace, 'large.txt')); await createBackup(f);
  await change(f.output, value => value.payload.sessions = Array.from({ length: 1001 }, (_, index) => ({ ...value.payload.sessions[0], id: `session-${index}` })));
  await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), { code: 'INVALID_BACKUP' }); await missing(f.restored);
  const archive = await fs.open(f.output, 'w'); await archive.truncate(BACKUP_LIMITS.archiveBytes + 1); await archive.close();
  await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), { code: 'BACKUP_LIMIT' });
});

test('aggregate logical size is capped even when each individual file is within its limit', async t => {
  const f = await fixture(t); await createBackup(f);
  const value = await envelope(f.output), content = 'x'.repeat(BACKUP_LIMITS.fileBytes);
  value.payload.workspace = Array.from({ length: 4 }, (_, index) => ({ path: `file-${index}.txt`, type: 'file', content, bytes: Buffer.byteLength(content), sha256: hash(content) }));
  value.sha256 = hash(JSON.stringify(value.payload)); await fs.writeFile(f.output, JSON.stringify(value));
  await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), { code: 'INVALID_BACKUP' }); await missing(f.restored);
});

test('restore failure cleans only its owned new directory and preserves input/source', async t => {
  const f = await fixture(t); await createBackup(f); const sourceBytes = await fs.readFile(f.output);
  const original = Store.prototype.putSession;
  Store.prototype.putSession = function () { throw new Error('injected database insertion failure'); };
  try { await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), /injected database insertion failure/); }
  finally { Store.prototype.putSession = original; }
  await missing(f.restored); assert.deepEqual(await fs.readFile(f.output), sourceBytes); assert.ok((await fs.stat(f.dataDir)).isDirectory());
});

test('restore cleanup refuses to remove an unexpected file created by another actor', async t => {
  for (const name of ['unexpected.txt', 'openaster.sqlite-journal']) {
    const f = await fixture(t); await createBackup(f);
    const original = Store.prototype.putSession;
    Store.prototype.putSession = function () { writeFileSync(path.join(f.restored, name), 'must remain'); throw new Error('injected failure'); };
    try { await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), { code: 'RESTORE_CLEANUP_INCOMPLETE' }); }
    finally { Store.prototype.putSession = original; }
    assert.equal(await fs.readFile(path.join(f.restored, name), 'utf8'), 'must remain');
  }
});

test('a real completed runtime turn with 199 previous messages roundtrips all 201 messages', async t => {
  const f = await fixture(t); const store = new Store(f.dataDir); const session = store.getSession(f.session.id);
  session.messages = Array.from({ length: 199 }, (_, index) => ({ id: randomUUID(), role: index % 2 ? 'assistant' : 'user', content: '历史消息', createdAt: now }));
  store.putSession(session);
  const runtime = createRuntime({ workspace: f.workspace, providers: async id => store.getProvider(id), getSession: async id => store.getSession(id), saveSession: async (value, metadata) => store.putSession(value, metadata), audit: entry => store.audit(entry) });
  try {
    await runtime.start(session.id, { content: '统计工作区' });
    const deadline = Date.now() + 5000;
    while (runtime.isActive(session.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.getSession(session.id).run.status, 'completed'); assert.equal(store.getSession(session.id).messages.length, 201);
  } finally { await runtime.shutdown(); store.close(); }
  await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const reader = new Store(f.restored); assert.equal(reader.getSession(session.id).messages.length, 201); reader.close();
});

test('a real append after the first snapshot read is detected deterministically', async t => {
  const f = await fixture(t); const file = path.join(f.workspace, 'changing.txt');
  await fs.writeFile(file, 'a'.repeat(2 * 1024 * 1024));
  const probe = await fs.open(file, 'r');
  const target = await probe.stat({ bigint: true });
  const prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
  await probe.close();
  let appended = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await originalRead.apply(this, args);
    if (!appended && args[3] === 0 && result.bytesRead > 0) {
      const current = await this.stat({ bigint: true });
      if (current.dev === target.dev && current.ino === target.ino) {
        appended = true;
        // Change the real file after a snapshot chunk has been read. Closing the writer
        // makes the size change observable without depending on Windows mtime flushing.
        const writer = await fs.open(file, 'a');
        try { await writer.write('x'); } finally { await writer.close(); }
      }
    }
    return result;
  });
  try {
    await assert.rejects(createBackup(f), { code: 'SOURCE_CHANGED' });
    assert.equal(appended, true); assert.equal((await fs.stat(file)).size, 2 * 1024 * 1024 + 1);
    await missing(f.output);
  } finally { t.mock.restoreAll(); }
});

test('CLI help, backup, restore and duplicate argument errors are usable without dependencies', async t => {
  const f = await fixture(t); const help = await cli(['--help']); assert.equal(help.code, 0); assert.match(help.stdout, /--workspace/);
  const made = await cli(['backup', '--data-dir', f.dataDir, '--output', f.output]); assert.equal(made.code, 0, made.stderr); assert.equal(JSON.parse(made.stdout).ok, true);
  const restored = await cli(['restore', '--input', f.output, '--data-dir', f.restored]); assert.equal(restored.code, 0, restored.stderr);
  const bad = await cli(['backup', '--data-dir', f.dataDir, '--data-dir', f.dataDir, '--output', f.output]); assert.equal(bad.code, 1); assert.match(bad.stderr, /参数无效/);
});
