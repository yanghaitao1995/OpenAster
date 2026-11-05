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
import { createWorkspace } from '../core/workspace.mjs';

const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
async function within(promise, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected local HTTP/filesystem event did not arrive')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function write(root, relative, content = 'needle') {
  const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content);
}
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), base = await fs.mkdtemp(path.join(parent, 'openaster-index-http-'));
  const workspace = path.join(base, 'project'), dataDir = path.join(base, 'data');
  for (const [relative, content] of Object.entries({ '.gitignore': '*.log\n', 'README.md': 'root needle', 'hidden.log': 'ignored needle', '.env': 'fixture-private', 'other/one.txt': 'other needle', 'src/a.txt': 'source needle', 'src/b.txt': 'source needle', 'src/c.txt': 'source needle', 'src/d.txt': 'source needle', 'src/e.txt': 'source needle', 'src/nested/deep.txt': 'deep needle' })) await write(workspace, relative, content);
  const workspaceOptions = { createRoot: false, projectScan: true, denySensitivePaths: true };
  const app = await startServer({ port: 0, dataDir, workspace, workspaceOptions });
  const bootstrapResponse = await fetch(app.url + '/api/bootstrap'), bootstrap = await bootstrapResponse.json();
  const headers = { cookie: bootstrapResponse.headers.get('set-cookie').split(';')[0], 'x-csrf-token': bootstrap.csrfToken };
  const originals = new Map(), gates = [], clients = new Set(), calls = [];
  let active = 0;
  function hold(method, relative, count = 1, fault = null) {
    const added = Array.from({ length: count }, () => ({ method, target: key(path.join(workspace, relative)), started: deferred(), release: deferred(), finished: deferred(), taken: false, fault }));
    gates.push(...added);
    if (!originals.has(method)) {
      const original = fs[method]; originals.set(method, original);
      fs[method] = async function (target, ...args) {
        const relevant = typeof target === 'string' && !(method === 'lstat' && args[0]?.bigint);
        if (relevant) calls.push({ method, path: path.relative(workspace, target).split(path.sep).join('/') });
        const gate = relevant ? gates.find(value => value.method === method && !value.taken && value.target === key(target)) : null;
        if (!gate) return original.call(this, target, ...args);
        gate.taken = true; active++; gate.started.resolve();
        try { await gate.release.promise; if (gate.fault) throw gate.fault; return await original.call(this, target, ...args); }
        finally { active--; gate.finished.resolve(); }
      };
      syncBuiltinESMExports();
    }
    return added;
  }
  async function request(endpoint, { auth = true, method = 'GET', extraHeaders = {}, data } = {}) {
    const response = await fetch(app.url + endpoint, { method, headers: { ...(auth ? headers : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) });
    return { status: response.status, data: await response.json(), cacheControl: response.headers.get('cache-control') };
  }
  function raw(endpoint = '/api/workspace') {
    const id = randomUUID(), serverClosed = deferred(), clientClosed = deferred(), outcome = deferred(); let responses = 0;
    const observe = (incoming, outgoing) => { if (incoming.headers['x-test-id'] === id) { app.server.removeListener('request', observe); outgoing.once('close', serverClosed.resolve); } };
    app.server.on('request', observe); t.after(() => app.server.removeListener('request', observe));
    const client = http.request(app.url + endpoint, { headers: { ...headers, 'x-test-id': id, Connection: 'close' } });
    clients.add(client); client.once('close', () => { clients.delete(client); clientClosed.resolve(); });
    client.on('error', error => outcome.resolve({ error: error.code }));
    client.once('response', response => {
      responses++; const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', error => outcome.resolve({ error: error.code }));
      response.once('end', () => { try { outcome.resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { outcome.resolve({ malformed: error.message }); } });
    });
    client.end();
    return { result: outcome.promise, get responseCount() { return responses; }, async disconnect() { client.destroy(); await within(Promise.all([serverClosed.promise, clientClosed.promise])); } };
  }
  t.after(async () => {
    for (const gate of gates) gate.release.resolve(); for (const client of clients) client.destroy();
    try { await app.close(); } finally { for (const [method, original] of originals) fs[method] = original; syncBuiltinESMExports(); }
    assert.equal(path.dirname(await fs.realpath(base)), parent); assert.match(path.basename(base), /^openaster-index-http-[A-Za-z0-9]+$/u);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { base, workspace, dataDir, workspaceOptions, app, bootstrap, request, raw, hold, calls, get active() { return active; } };
}

test('bounded index keeps authenticated recursive responses, strict options and ordinary query error codes', async t => {
  const f = await fixture(t), expected = createWorkspace(f.workspace, f.workspaceOptions);
  assert.equal((await f.request('/api/workspace', { auth: false })).status, 401);
  assert.equal((await f.request('/api/workspace', { extraHeaders: { Origin: 'https://untrusted.invalid' } })).status, 403);
  for (const options of [{}, { path: 'src' }, { includeGenerated: true, includeIgnored: true }]) {
    const response = await f.request('/api/workspace?' + new URLSearchParams(Object.entries(options).map(([name, value]) => [name, String(value)])));
    assert.equal(response.status, 200); assert.equal(response.cacheControl, 'no-store'); assert.deepEqual(response.data, await expected.list(options));
    assert.equal(Object.hasOwn(response.data, 'listing'), false);
  }
  assert.ok((await f.request('/api/workspace')).data.files.some(file => file.path === 'src/nested/deep.txt'));
  for (const query of ['?path=src&path=other', '?recursive=false', '?includeIgnored=1', '?includeGenerated=True', '?path=%FF']) {
    const response = await f.request('/api/workspace' + query); assert.equal(response.status, 400); assert.equal(response.data.error.code, 'INVALID_WORKSPACE_QUERY');
  }
  for (const [scope, status, code] of [['../outside', 400, 'INVALID_PATH'], ['README.md', 400, 'NOT_DIRECTORY'], ['missing', 404, 'FILE_NOT_FOUND'], ['.env', 403, 'SENSITIVE_PATH']]) {
    const response = await f.request('/api/workspace?' + new URLSearchParams({ path: scope })); assert.equal(response.status, status); assert.equal(response.data.error.code, code);
  }
});

test('two index slots remain occupied after client disconnect while directory and search slots remain independent', async t => {
  const f = await fixture(t), gates = f.hold('opendir', 'src', 2), first = f.raw(), second = f.raw();
  await within(Promise.all(gates.map(gate => gate.started.promise))); assert.equal(f.active, 2);
  let busy = await f.request('/api/workspace'); assert.equal(busy.status, 429); assert.equal(busy.data.error.code, 'WORKSPACE_INDEX_BUSY');
  const invalid = await f.request('/api/workspace?unexpected=true'); assert.equal(invalid.status, 400); assert.equal(invalid.data.error.code, 'INVALID_WORKSPACE_QUERY');
  assert.equal((await f.request('/api/workspace', { auth: false })).status, 401);
  assert.equal((await f.request('/api/workspace/directory')).status, 200);
  assert.equal((await f.request('/api/workspace/search', { method: 'POST', data: { query: 'needle', path: 'other' } })).status, 200);
  await first.disconnect();
  busy = await f.request('/api/workspace'); assert.equal(busy.status, 429); assert.equal(busy.data.error.code, 'WORKSPACE_INDEX_BUSY');
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  for (const gate of gates) gate.release.resolve();
  assert.equal((await within(second.result)).status, 200);
  assert.equal((await f.request('/api/workspace')).status, 200); assert.equal(first.responseCount, 0); assert.equal(f.active, 0);
});

test('four directory slots keep their original error contract without consuming either index slot', async t => {
  const f = await fixture(t), gates = f.hold('opendir', '', 4), directories = Array.from({ length: 4 }, () => f.raw('/api/workspace/directory'));
  await within(Promise.all(gates.map(gate => gate.started.promise)));
  const response = await f.request('/api/workspace/directory'); assert.equal(response.status, 429); assert.equal(response.data.error.code, 'WORKSPACE_DIRECTORY_BUSY');
  const indexes = await Promise.all([f.request('/api/workspace?path=src'), f.request('/api/workspace?path=other')]);
  for (const index of indexes) assert.equal(index.status, 200);
  for (const gate of gates) gate.release.resolve();
  for (const directory of directories) assert.equal((await within(directory.result)).status, 200);
});

test('disconnected recursive index stops before opening deeper descendants and shutdown retains its data lock', async t => {
  const f = await fixture(t), [gate] = f.hold('opendir', 'src'), first = f.raw();
  await within(gate.started.promise); await first.disconnect();
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  let closed = false; const shutdown = f.app.close().then(() => { closed = true; });
  await turn(); await turn(); assert.equal(closed, false);
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  gate.release.resolve(); await within(shutdown);
  assert.equal(f.active, 0); assert.equal(first.responseCount, 0);
  assert.equal(f.calls.some(call => call.method === 'opendir' && call.path === 'src/nested'), false);
  const settledCalls = f.calls.length; await turn(); assert.equal(f.calls.length, settledCalls);
  const release = await acquireDataLock(f.dataDir); await release();
});

test('index cancellation and forced close drain every started metadata worker before releasing ownership', async t => {
  const f = await fixture(t), gates = ['a', 'b', 'c', 'd'].map(name => f.hold('lstat', `src/${name}.txt`)[0]), first = f.raw('/api/workspace?path=src');
  await within(Promise.all(gates.map(gate => gate.started.promise))); assert.equal(f.active, 4); await first.disconnect();
  let closed = false; const shutdown = f.app.close().then(() => { closed = true; });
  assert.equal(f.app.close(), f.app.close(), 'All later close callers receive the same shutdown promise');
  for (const gate of gates.slice(1)) gate.release.resolve();
  await within(Promise.all(gates.slice(1).map(gate => gate.finished.promise))); await turn();
  assert.equal(f.active, 1); assert.equal(closed, false);
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  assert.equal(f.calls.some(call => call.method === 'lstat' && call.path === 'src/e.txt'), false);
  gates[0].release.resolve(); await within(shutdown); assert.equal(f.active, 0); assert.equal(first.responseCount, 0);
  assert.equal(f.calls.some(call => call.method === 'lstat' && call.path === 'src/e.txt'), false);
  const release = await acquireDataLock(f.dataDir); await release();
});

test('connected index shutdown reports 503 after drain and rejects newly arriving requests', async t => {
  const f = await fixture(t), [gate] = f.hold('opendir', 'src'), first = f.raw();
  await within(gate.started.promise);
  let closed = false; const shutdown = f.app.close().then(() => { closed = true; });
  await turn(); assert.equal(closed, false);
  const denied = await f.request('/api/workspace'); assert.equal(denied.status, 503); assert.equal(denied.data.error.code, 'SHUTTING_DOWN');
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  gate.release.resolve();
  const response = await within(first.result); assert.equal(response.status, 503); assert.equal(response.data.error.code, 'SHUTTING_DOWN'); assert.equal(Object.hasOwn(response.data, 'files'), false);
  await within(shutdown);
});

test('the index 30-second cooperative deadline keeps its request alive until I/O drains and then reports 504', async t => {
  const f = await fixture(t), [gate] = f.hold('opendir', 'src'), originalTimeout = globalThis.setTimeout;
  let expire, timers = 0, first;
  globalThis.setTimeout = function (callback, milliseconds, ...args) {
    if (milliseconds === 30000) { timers++; expire = () => callback(...args); return originalTimeout(() => {}, 60000); }
    return originalTimeout(callback, milliseconds, ...args);
  };
  try { first = f.raw(); await within(gate.started.promise); }
  finally { globalThis.setTimeout = originalTimeout; }
  assert.equal(timers, 1); assert.equal(typeof expire, 'function'); expire();
  let settled = false; first.result.then(() => { settled = true; }); await turn(); assert.equal(settled, false);
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  gate.release.resolve();
  const response = await within(first.result); assert.equal(response.status, 504); assert.equal(response.data.error.code, 'WORKSPACE_INDEX_TIMEOUT'); assert.equal(Object.hasOwn(response.data, 'files'), false);
  assert.equal(f.calls.some(call => call.method === 'opendir' && call.path === 'src/nested'), false);
  assert.equal((await f.request('/api/workspace')).status, 200);
});

test('native and policy failures release index slots without suppressing errors or retrying automatically', async t => {
  const f = await fixture(t), failure = Object.assign(new Error('private fixture detail'), { code: 'EIO' });
  const [gate] = f.hold('opendir', 'src', 1, failure), first = f.raw();
  await within(gate.started.promise); gate.release.resolve();
  const failed = await within(first.result); assert.equal(failed.status, 500); assert.equal(failed.data.error.code, 'INTERNAL_ERROR'); assert.equal(JSON.stringify(failed).includes('private fixture detail'), false);
  assert.equal(f.calls.filter(call => call.method === 'opendir' && call.path === 'src').length, 1);
  assert.equal((await f.request('/api/workspace')).status, 200);
  await fs.writeFile(path.join(f.workspace, '.gitignore'), '\0');
  for (let attempt = 0; attempt < 3; attempt++) {
    const invalid = await f.request('/api/workspace'); assert.equal(invalid.status, 400); assert.equal(invalid.data.error.code, 'GITIGNORE_INVALID');
  }
  await fs.writeFile(path.join(f.workspace, '.gitignore'), '*.log\n'); assert.equal((await f.request('/api/workspace')).status, 200);
});

test('index policy changes and root replacement remain fatal while preserving the replacement files', async t => {
  const f = await fixture(t), [gate] = f.hold('opendir', 'src'), first = f.raw();
  await within(gate.started.promise); await fs.writeFile(path.join(f.workspace, '.gitignore'), '# changed\n'); gate.release.resolve();
  const changed = await within(first.result); assert.equal(changed.status, 409); assert.equal(changed.data.error.code, 'GITIGNORE_CHANGED');
  await fs.rename(f.workspace, path.join(f.base, 'moved-project')); await write(f.workspace, 'replacement.txt', 'unchanged replacement');
  for (let attempt = 0; attempt < 3; attempt++) {
    const rejected = await f.request('/api/workspace'); assert.equal(rejected.status, 409); assert.equal(rejected.data.error.code, 'WORKSPACE_CHANGED');
  }
  assert.equal(await fs.readFile(path.join(f.workspace, 'replacement.txt'), 'utf8'), 'unchanged replacement');
});
