// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { startServer } from '../server/index.mjs';
import { acquireDataLock } from '../server/lock.mjs';

function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
async function within(promise, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP lifecycle event did not arrive')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), base = await fs.mkdtemp(path.join(parent, 'openaster-directory-http-'));
  const workspace = path.join(base, 'project'), dataDir = path.join(base, 'data');
  await fs.mkdir(path.join(workspace, 'src/child'), { recursive: true }); await fs.mkdir(path.join(workspace, '.git'));
  for (const [relative, content] of Object.entries({ '.gitignore': '*.log\n', 'README.md': 'needle', 'hidden.log': 'needle', 'src/a.txt': 'needle', 'src/child/b.txt': 'needle', '.git/config': 'fixture-private', '.env': 'fixture-private' })) await fs.writeFile(path.join(workspace, relative), content);
  const app = await startServer({ port: 0, dataDir, workspace, workspaceOptions: { createRoot: false, projectScan: true, denySensitivePaths: true } });
  const bootResponse = await fetch(app.url + '/api/bootstrap'), bootstrap = await bootResponse.json();
  const headers = { cookie: bootResponse.headers.get('set-cookie').split(';')[0], 'x-csrf-token': bootstrap.csrfToken };
  const original = fs.opendir, gates = [], clients = new Set();
  let installed = false;
  function hold(count = 1) {
    const added = Array.from({ length: count }, () => ({ entered: deferred(), release: deferred(), taken: false })); gates.push(...added);
    if (!installed) {
      fs.opendir = async function (target, ...args) {
        if (path.resolve(target) === path.resolve(workspace)) {
          const gate = gates.find(item => !item.taken);
          if (gate) { gate.taken = true; gate.entered.resolve(); await gate.release.promise; }
        }
        return original.call(this, target, ...args);
      };
      syncBuiltinESMExports(); installed = true;
    }
    return added;
  }
  async function request(endpoint, { auth = true, method = 'GET', extraHeaders = {} } = {}) {
    const response = await fetch(app.url + endpoint, { method, headers: { ...(auth ? headers : {}), ...extraHeaders }, signal: AbortSignal.timeout(15000) });
    return { status: response.status, data: await response.json(), cacheControl: response.headers.get('cache-control') };
  }
  function rawDirectory() {
    const id = randomUUID(), serverClosed = deferred(), clientClosed = deferred(), result = deferred();
    const observe = (incoming, response) => { if (incoming.headers['x-test-id'] === id) { app.server.removeListener('request', observe); response.once('close', serverClosed.resolve); } };
    app.server.on('request', observe); t.after(() => app.server.removeListener('request', observe));
    const client = http.request(app.url + '/api/workspace/directory', { headers: { ...headers, 'x-test-id': id, Connection: 'close' } });
    clients.add(client); client.once('close', () => { clients.delete(client); clientClosed.resolve(); });
    client.on('error', error => result.resolve({ error: error.code }));
    client.once('response', response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', error => result.resolve({ error: error.code }));
      response.once('end', () => result.resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    client.end();
    return { result: result.promise, async disconnect() { client.destroy(); await within(Promise.all([serverClosed.promise, clientClosed.promise])); } };
  }
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    for (const client of clients) client.destroy();
    await app.close();
    if (installed) { fs.opendir = original; syncBuiltinESMExports(); }
    assert.equal(path.dirname(await fs.realpath(base)), parent); assert.match(path.basename(base), /^openaster-directory-http-[A-Za-z0-9]+$/u);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { app, workspace, dataDir, bootstrap, hold, request, rawDirectory };
}

test('authenticated HTTP children listing advertises capability and preserves recursive index and search', async t => {
  const f = await fixture(t);
  assert.equal(f.bootstrap.capabilities.workspaceDirectory, 1);
  assert.equal((await f.request('/api/state')).data.capabilities.workspaceDirectory, 1);
  assert.equal((await f.request('/api/workspace/directory', { auth: false })).status, 401);
  assert.equal((await f.request('/api/workspace/directory', { extraHeaders: { Origin: 'https://hostile.invalid' } })).status, 403);
  const root = await f.request('/api/workspace/directory');
  assert.equal(root.status, 200); assert.equal(root.cacheControl, 'no-store'); assert.equal(root.data.version, 1); assert.equal(root.data.listing, 'children');
  assert.deepEqual(root.data.files.map(file => file.path), ['.gitignore', 'README.md', 'src']);
  const children = await f.request('/api/workspace/directory?path=src');
  assert.deepEqual(children.data.files.map(file => file.path), ['src/a.txt', 'src/child']); assert.equal(children.data.scope, 'src');
  const recursive = await f.request('/api/workspace');
  assert.ok(recursive.data.files.some(file => file.path === 'src/child/b.txt')); assert.equal(Object.hasOwn(recursive.data, 'listing'), false);
  assert.equal((await f.request('/api/workspace/directory?includeIgnored=true')).data.files.some(file => file.path === 'hidden.log'), true);
  assert.equal((await f.request('/api/workspace/directory?includeIgnored=true&includeGenerated=true')).data.files.some(file => file.path === '.env'), false);
});

test('directory HTTP queries use the existing strict parser and core path boundary', async t => {
  const f = await fixture(t);
  for (const query of ['?unknown=true', '?path=src&path=src', '?includeGenerated=1', '?includeIgnored=True', '?includeIgnored=true&includeIgnored=false', '?path=%FF', '?path=%ZZ', '?recursive=true']) {
    const response = await f.request('/api/workspace/directory' + query); assert.equal(response.status, 400, query); assert.equal(response.data.error.code, 'INVALID_WORKSPACE_QUERY', query);
  }
  for (const [scope, code, status] of [['../outside', 'INVALID_PATH', 400], ['.git', 'SENSITIVE_PATH', 403], ['README.md', 'NOT_DIRECTORY', 400], ['missing', 'FILE_NOT_FOUND', 404]]) {
    const response = await f.request('/api/workspace/directory?' + new URLSearchParams({ path: scope }));
    assert.equal(response.status, status); assert.equal(response.data.error.code, code);
  }
  await fs.writeFile(path.join(f.workspace, ' leading.txt'), 'exact');
  const root = await f.request('/api/workspace/directory'); assert.ok(root.data.files.some(file => file.path === ' leading.txt'));
});

test('four active directory requests retain their slots after disconnect until filesystem work actually drains', async t => {
  const f = await fixture(t), gates = f.hold(4), requests = Array.from({ length: 4 }, () => f.rawDirectory());
  await within(Promise.all(gates.map(gate => gate.entered.promise)));
  let response = await f.request('/api/workspace/directory');
  assert.equal(response.status, 429); assert.equal(response.data.error.code, 'WORKSPACE_DIRECTORY_BUSY');
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  await requests[0].disconnect();
  response = await f.request('/api/workspace/directory'); assert.equal(response.status, 429);
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  for (const gate of gates) gate.release.resolve();
  for (const request of requests.slice(1)) assert.equal((await within(request.result)).status, 200);
  response = await f.request('/api/workspace/directory'); assert.equal(response.status, 200);
});

test('forced close waits for disconnected directory I/O before releasing the real data lock', async t => {
  const f = await fixture(t), [gate] = f.hold(), request = f.rawDirectory();
  await within(gate.entered.promise); await request.disconnect();
  let closed = false; const shutdown = f.app.close().then(() => { closed = true; });
  await tick(); await tick(); assert.equal(closed, false);
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  gate.release.resolve(); await within(shutdown); assert.equal(closed, true);
  const release = await acquireDataLock(f.dataDir); await release();
});

test('connected directory shutdown cancels the result and reports shutdown after the held I/O settles', async t => {
  const f = await fixture(t), [gate] = f.hold(), request = f.rawDirectory();
  await within(gate.entered.promise);
  let closed = false; const shutdown = f.app.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); gate.release.resolve();
  const result = await within(request.result); assert.equal(result.status, 503); assert.equal(result.data.error.code, 'SHUTTING_DOWN');
  assert.equal(Object.hasOwn(result.data, 'files'), false); await within(shutdown);
});

test('the fixed 30-second directory deadline aborts but retains its slot and lock until I/O drains', async t => {
  const f = await fixture(t), [gate] = f.hold(), originalTimeout = globalThis.setTimeout;
  let expire, timerCount = 0;
  globalThis.setTimeout = function (callback, milliseconds, ...args) {
    if (milliseconds === 30000) { timerCount++; expire = () => callback(...args); return originalTimeout(() => {}, 60000); }
    return originalTimeout(callback, milliseconds, ...args);
  };
  let request;
  try { request = f.rawDirectory(); await within(gate.entered.promise); }
  finally { globalThis.setTimeout = originalTimeout; }
  assert.equal(timerCount, 1); assert.equal(typeof expire, 'function'); expire();
  let settled = false; request.result.then(() => { settled = true; });
  await tick(); assert.equal(settled, false); await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  gate.release.resolve();
  const result = await within(request.result); assert.equal(result.status, 504); assert.equal(result.data.error.code, 'WORKSPACE_DIRECTORY_TIMEOUT');
  assert.equal(Object.hasOwn(result.data, 'files'), false);
  assert.equal((await f.request('/api/workspace/directory')).status, 200);
});
