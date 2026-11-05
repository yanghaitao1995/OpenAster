// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { startServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';
import { acquireDataLock } from '../server/lock.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const cleanupOperations = new Map();
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Draft lifecycle deadline exceeded')), 10000); })]); }
  finally { clearTimeout(timer); }
}
function draft(overrides = {}) {
  return { slot: 'new', text: 'UNSENT_PRIVATE_BODY_草稿', files: [{ path: 'notes/ selected.md', sha256: 'a'.repeat(64), bytes: 17 }], providerId: 'demo', skillId: '', updatedAt: '2026-10-30T08:00:00.000Z', revision: randomUUID(), uncertain: false, ...overrides };
}
function memoryRepository() {
  const entries = new Map(), calls = [], events = [];
  let hook = async () => {}, closed = false;
  const repo = {
    async read(storageId) { calls.push({ operation: 'read', storageId }); events.push('read-start'); await hook('read'); assert.equal(closed, false); events.push('read-end'); return structuredClone(entries.get(storageId) ?? { version: 1, revision: '0', drafts: [] }); },
    async compareAndSwap(storageId, expectedRevision, drafts) {
      calls.push({ operation: 'cas', storageId, expectedRevision, drafts: structuredClone(drafts) }); events.push('cas-start'); await hook('cas'); assert.equal(closed, false);
      const current = entries.get(storageId) ?? { version: 1, revision: '0', drafts: [] };
      if (current.revision !== expectedRevision) throw Object.assign(new Error('PRIVATE conflict detail'), { code: 'DRAFT_CONFLICT' });
      const next = { version: 1, revision: randomUUID(), drafts: structuredClone(drafts) }; entries.set(storageId, next); events.push('cas-end'); return structuredClone(next);
    },
    async drain() { events.push('drain'); },
    async close() { events.push('close'); closed = true; },
  };
  return { repo, calls, events, entries, setHook(value) { hook = value; } };
}
async function directory(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-device-drafts-'));
  const identity = await fs.lstat(root, { bigint: true });
  t.after(async () => {
    await cleanupOperations.get(root)?.(); cleanupOperations.delete(root);
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^openaster-device-drafts-[A-Za-z0-9]+$/u);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return root;
}
async function fixture(t, { enabled = true, repository = memoryRepository(), ...options } = {}) {
  const root = await directory(t), dataDir = path.join(root, 'data');
  const app = await startServer({ port: 0, dataDir, ...(enabled ? { deviceDraftStore: repository.repo } : {}), ...options });
  let cookie, csrf, storageId;
  const gates = [];
  cleanupOperations.set(root, async () => { for (const gate of gates) gate.resolve(); await app.close(); });
  async function request(endpoint, { method = 'GET', data, raw, auth = true, headers = {} } = {}) {
    const response = await fetch(app.url + endpoint, { method, headers: {
      ...(auth && cookie ? { cookie, 'x-csrf-token': csrf, 'x-openaster-storage-id': storageId } : {}),
      ...(data !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers,
    }, body: raw ?? (data === undefined ? undefined : JSON.stringify(data)), signal: AbortSignal.timeout(10000) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  const bootstrap = await request('/api/bootstrap');
  cookie = bootstrap.headers.get('set-cookie').split(';')[0]; csrf = bootstrap.data.csrfToken; storageId = bootstrap.data.workspace.storageId;
  function hold(operation) {
    const entered = deferred(), release = deferred(); gates.push(release);
    repository.setHook(async name => { if (name === operation) { entered.resolve(); await release.promise; } });
    return { entered: entered.promise, release: release.resolve };
  }
  return { app, root, dataDir, bootstrap: bootstrap.data, repository, request, hold, storageId, headers: { cookie, 'x-csrf-token': csrf, 'x-openaster-storage-id': storageId } };
}

test('storage identity is read-only, restart-stable, distinct for new databases and regenerated by logical restore', async t => {
  const root = await directory(t), dataDir = path.join(root, 'data'), otherDir = path.join(root, 'other');
  await fs.mkdir(path.join(dataDir, 'workspace'), { recursive: true });
  let store = new Store(dataDir);
  const before = { version: store.db.prepare('PRAGMA user_version').get().user_version, meta: { ...store.db.prepare('SELECT * FROM usage_meta').get() } };
  const id = store.getStorageIdentity(); assert.match(id, UUID); assert.equal(store.getStorageIdentity(), id);
  assert.deepEqual({ version: store.db.prepare('PRAGMA user_version').get().user_version, meta: { ...store.db.prepare('SELECT * FROM usage_meta').get() } }, before);
  store.close(); store = new Store(dataDir); assert.equal(store.getStorageIdentity(), id); store.close();
  const other = new Store(otherDir); assert.notEqual(other.getStorageIdentity(), id); other.close();
  const output = path.join(root, 'backup.json'), restored = path.join(root, 'restored');
  await createBackup({ dataDir, output }); await restoreBackup({ input: output, dataDir: restored });
  const restoredStore = new Store(restored); assert.notEqual(restoredStore.getStorageIdentity(), id); restoredStore.close();
});

test('default server exposes stable storage identity but neither draft capability nor draft endpoint', async t => {
  const f = await fixture(t, { enabled: false }); assert.match(f.storageId, UUID);
  assert.equal(Object.hasOwn(f.bootstrap.capabilities, 'deviceDrafts'), false);
  const state = await f.request('/api/state'); assert.equal(state.data.workspace.storageId, f.storageId); assert.equal(Object.hasOwn(state.data.capabilities, 'deviceDrafts'), false);
  assert.equal((await f.request('/api/device-drafts')).status, 404);
  assert.equal((await f.request('/api/device-drafts', { method: 'POST', data: { storageId: f.storageId, expectedRevision: '0', drafts: [] } })).status, 404);
});

test('gateway/repository combination and invalid repository shape fail before creating directories or acquiring locks', async t => {
  const root = await directory(t), dataDir = path.join(root, 'new-data'); const memory = memoryRepository();
  await assert.rejects(startServer({ dataDir, gatewayOrigin: 'https://gateway.example', token: 'a'.repeat(32), deviceDraftStore: memory.repo }), { code: 'DEVICE_DRAFTS_LOCAL_ONLY' });
  await assert.rejects(fs.lstat(dataDir), { code: 'ENOENT' }); assert.equal(memory.calls.length, 0);
  await assert.rejects(startServer({ dataDir, deviceDraftStore: { read() {} } }), { code: 'INVALID_DEVICE_DRAFT_STORE' });
  await assert.rejects(fs.lstat(dataDir), { code: 'ENOENT' });
  const app = await startServer({ dataDir }); await app.close();
});

test('draft APIs require local authentication, CSRF, trusted origin and exact storage preconditions', async t => {
  const f = await fixture(t); assert.equal(f.bootstrap.capabilities.deviceDrafts, 1);
  const data = { storageId: f.storageId, expectedRevision: '0', drafts: [draft()] };
  assert.equal((await f.request('/api/device-drafts', { auth: false })).status, 401);
  assert.equal((await f.request('/api/device-drafts', { method: 'POST', auth: false, data })).status, 401);
  assert.equal((await f.request('/api/device-drafts', { method: 'POST', data, headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await f.request('/api/device-drafts', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await f.request('/api/device-drafts', { method: 'POST', data, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await f.request('/api/device-drafts', { headers: { 'x-openaster-storage-id': '' } })).status, 400);
  for (const query of ['?storageId=' + f.storageId, '?x=1', '?x=1&x=2']) assert.equal((await f.request('/api/device-drafts' + query)).status, 400);
  const oldStore = new Store(path.join(f.root, 'old-workspace')), oldId = oldStore.getStorageIdentity(); oldStore.close();
  let result = await f.request('/api/device-drafts', { headers: { 'x-openaster-storage-id': oldId } });
  assert.equal(result.status, 409); assert.equal(result.data.error.code, 'DRAFT_CONTEXT_CHANGED');
  result = await f.request('/api/device-drafts', { method: 'POST', data: { ...data, storageId: oldId } });
  assert.equal(result.status, 409); assert.equal(result.data.error.code, 'DRAFT_CONTEXT_CHANGED'); assert.equal(f.repository.calls.length, 0);
});

test('successful CAS persists only the device repository, has no model/task/history/audit/file side effects and returns no-store snapshots', async t => {
  let modelCalls = 0;
  const f = await fixture(t, { runtimeOptions: { providerCall: async () => { modelCalls++; throw new Error('must not call'); } } });
  const before = (await f.request('/api/export')).data; delete before.exportedAt;
  const initial = await f.request('/api/device-drafts'); assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.deepEqual(initial.data, { storageId: f.storageId, snapshot: { version: 1, revision: '0', drafts: [] } });
  const supplied = draft(), first = await f.request('/api/device-drafts', { method: 'POST', data: { storageId: f.storageId, expectedRevision: '0', drafts: [supplied] } });
  assert.equal(first.status, 200); assert.match(first.data.snapshot.revision, UUID); assert.deepEqual(first.data.snapshot.drafts, [supplied]);
  assert.deepEqual((await f.request('/api/device-drafts')).data, first.data);
  const conflict = await f.request('/api/device-drafts', { method: 'POST', data: { storageId: f.storageId, expectedRevision: '0', drafts: [] } });
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error.code, 'DRAFT_CONFLICT'); assert.ok(!JSON.stringify(conflict.data).includes('PRIVATE'));
  const empty = await f.request('/api/device-drafts', { method: 'POST', data: { storageId: f.storageId, expectedRevision: first.data.snapshot.revision, drafts: [] } });
  assert.equal(empty.status, 200); assert.notEqual(empty.data.snapshot.revision, '0'); assert.notEqual(empty.data.snapshot.revision, first.data.snapshot.revision);
  const after = (await f.request('/api/export')).data; delete after.exportedAt; assert.deepEqual(after, before);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'workspace')), []); assert.equal(modelCalls, 0);
  const db = await fs.readFile(path.join(f.dataDir, 'openaster.sqlite-wal')); assert.equal(db.includes(Buffer.from(supplied.text)), false);
});

test('strict JSON fields, UTF-8, individual and total limits reject before any repository write', async t => {
  const f = await fixture(t), base = { storageId: f.storageId, expectedRevision: '0', drafts: [draft()] };
  const invalid = [
    { ...base, path: 'outside' }, { ...base, expectedRevision: 0 }, { ...base, expectedRevision: randomUUID().toUpperCase() },
    { ...base, storageId: undefined }, { ...base, drafts: [{ ...draft(), content: 'extra' }] },
    { ...base, drafts: [draft({ files: [{ path: '../outside', sha256: 'a'.repeat(64), bytes: 1 }] })] },
    { ...base, drafts: [draft({ text: '\ud800' })] }, { ...base, drafts: [draft({ text: 'bad\0text' })] },
  ];
  for (const data of invalid) assert.equal((await f.request('/api/device-drafts', { method: 'POST', data })).status, 400);
  for (const drafts of [Array.from({ length: 21 }, (_, i) => draft({ slot: 'draft-' + i })), [draft({ text: 'x'.repeat(16001) })], [draft({ files: [{ path: 'a', sha256: 'b'.repeat(64), bytes: 262145 }] })], Array.from({ length: 20 }, (_, i) => draft({ slot: 'large-' + i, text: '\u0001'.repeat(5000) }))]) {
    const response = await f.request('/api/device-drafts', { method: 'POST', data: { ...base, drafts } }); assert.equal(response.status, 413);
  }
  const utf8 = await f.request('/api/device-drafts', { method: 'POST', raw: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) }); assert.equal(utf8.status, 400);
  const oversized = await f.request('/api/device-drafts', { method: 'POST', raw: '{"padding":"' + 'x'.repeat(526000) + '"}' }); assert.equal(oversized.status, 413);
  assert.equal(f.repository.calls.length, 0);
});

test('concurrent HTTP saves with the same expected revision cannot silently overwrite each other', async t => {
  const f = await fixture(t), gate = f.hold('cas');
  const saves = ['first', 'second'].map(text => f.request('/api/device-drafts', { method: 'POST', data: { storageId: f.storageId, expectedRevision: '0', drafts: [draft({ text })] } }));
  await bounded(gate.entered); gate.release();
  const results = await Promise.all(saves); assert.deepEqual(results.map(value => value.status).sort(), [200, 409]);
  const winner = results.find(value => value.status === 200);
  assert.deepEqual((await f.request('/api/device-drafts')).data, winner.data);
});

test('repository and malformed snapshot failures are fixed public 503 errors without sensitive data', async t => {
  const f = await fixture(t), marker = 'D:\\PRIVATE\\secret-key-crypto-plaintext';
  for (const code of ['DRAFT_DECRYPT_FAILED', 'DRAFT_CORRUPT', 'DRAFT_IO', 'DRAFT_COMMIT_UNCERTAIN', 'DRAFT_UNSAFE_PATH', 'EPERM']) {
    f.repository.setHook(async () => { throw Object.assign(new Error(marker), { code, status: 403, path: marker }); });
    const response = await f.request('/api/device-drafts'); assert.equal(response.status, 503); assert.equal(response.data.error.code, 'DRAFT_STORAGE_UNAVAILABLE'); assert.ok(!JSON.stringify(response.data).includes('PRIVATE'));
  }
  f.repository.setHook(async () => {}); f.repository.entries.set(f.storageId, { version: 1, revision: '0', drafts: [], key: marker });
  const malformed = await f.request('/api/device-drafts'); assert.equal(malformed.status, 503); assert.ok(!JSON.stringify(malformed.data).includes(marker));
});

test('draft mutation shares the existing authenticated rate limit', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 180; i++) assert.equal((await f.request('/api/device-drafts', { method: 'POST', data: {} })).status, 400);
  const limited = await f.request('/api/device-drafts', { method: 'POST', data: {} }); assert.equal(limited.status, 429); assert.equal(limited.data.error.code, 'RATE_LIMIT');
  assert.equal(f.repository.calls.length, 0);
});

test('disconnected draft writes retain busy state and data lock until the real operation drains before repository close', async t => {
  const f = await fixture(t), gate = f.hold('cas');
  const client = http.request(f.app.url + '/api/device-drafts', { method: 'POST', headers: { ...f.headers, 'content-type': 'application/json', Connection: 'close' } });
  client.on('error', () => {}); const disconnected = new Promise(resolve => client.once('close', resolve));
  client.end(JSON.stringify({ storageId: f.storageId, expectedRevision: '0', drafts: [draft()] }));
  await bounded(gate.entered); client.destroy(); await bounded(disconnected);
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  let finished = false; const closing = f.app.close().then(() => { finished = true; });
  await tick(); await tick(); assert.equal(finished, false); assert.deepEqual(f.repository.events, ['cas-start']);
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  gate.release(); await bounded(closing);
  assert.deepEqual(f.repository.events, ['cas-start', 'cas-end', 'drain', 'close']);
  const release = await acquireDataLock(f.dataDir); await release();
});

test('a draft body completed after shutdown begins never starts a repository write', async t => {
  const f = await fixture(t), body = JSON.stringify({ storageId: f.storageId, expectedRevision: '0', drafts: [draft()] });
  const admitted = deferred(); f.app.server.once('request', () => admitted.resolve());
  const client = http.request(f.app.url + '/api/device-drafts', { method: 'POST', headers: { ...f.headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), Connection: 'close' } });
  const response = new Promise((resolve, reject) => { client.once('error', reject); client.once('response', res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) })); }); });
  client.write(body.slice(0, 15)); await bounded(admitted.promise);
  const closing = f.app.close(); client.end(body.slice(15));
  const result = await bounded(response); assert.equal(result.status, 503); assert.equal(result.data.error.code, 'SHUTTING_DOWN');
  await bounded(closing); assert.equal(f.repository.calls.length, 0);
});

test('repository shutdown failures remain sanitized and still release the transport and database lock', async t => {
  const root = await directory(t), dataDir = path.join(root, 'data'), calls = [];
  const repository = memoryRepository();
  repository.repo.drain = async () => { calls.push('drain'); throw Object.assign(new Error('PRIVATE_DRAIN_PATH'), { code: 'DRAFT_IO' }); };
  repository.repo.close = async () => { calls.push('close'); throw Object.assign(new Error('PRIVATE_CRYPTO_KEY'), { code: 'DRAFT_DECRYPT_FAILED' }); };
  const app = await startServer({ dataDir, deviceDraftStore: repository.repo });
  const closing = app.close();
  await assert.rejects(closing, error => error.code === 'DRAFT_STORAGE_UNAVAILABLE' && error.status === 503 && !error.message.includes('PRIVATE'));
  assert.deepEqual(calls, ['drain', 'close']); assert.equal(app.server.listening, false);
  const release = await acquireDataLock(dataDir); await release();
});

test('invalid persistent identity fails before draft access and releases the startup data lock', async t => {
  const root = await directory(t), dataDir = path.join(root, 'data');
  const store = new Store(dataDir); store.db.prepare('UPDATE usage_meta SET identity=? WHERE id=1').run('invalid-private-path'); store.close();
  const repository = memoryRepository();
  await assert.rejects(startServer({ dataDir, deviceDraftStore: repository.repo }), { code: 'INVALID_STORAGE_IDENTITY' });
  const release = await acquireDataLock(dataDir); await release(); assert.equal(repository.calls.length, 0);
  const repaired = new Store(dataDir); repaired.db.prepare('UPDATE usage_meta SET identity=? WHERE id=1').run(randomUUID()); repaired.close();
  const app = await startServer({ dataDir }); await app.close();
});
