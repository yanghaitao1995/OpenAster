// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { startServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';
import { acquireDataLock } from '../server/lock.mjs';
import { FILE_EDIT_BODY_BYTES } from '../server/manual-file-edit.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function within(promise, ms = 15000) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local HTTP/filesystem event did not settle')), ms); })]); } finally { clearTimeout(timer); }
}
async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'openaster-manual-http-')), workspace = path.join(base, 'workspace'), dataDir = path.join(base, 'data');
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'file.txt'), 'before'); await fs.writeFile(path.join(workspace, ' file.txt'), 'space before'); await fs.writeFile(path.join(workspace, '.env'), 'fixture-private');
  const app = await startServer({ dataDir, workspace, workspaceOptions: { createRoot: false, denySensitivePaths: true }, ...options });
  const bootstrapResponse = await fetch(app.url + '/api/bootstrap'), bootstrap = await bootstrapResponse.json();
  const headers = { cookie: bootstrapResponse.headers.get('set-cookie').split(';')[0], 'x-csrf-token': bootstrap.csrfToken, 'content-type': 'application/json' };
  const gates = [], restorers = [], clients = new Set();
  function gate() { const item = deferred(); gates.push(item); return item; }
  function patch(object, key, replacement) { const original = object[key]; object[key] = replacement(original); syncBuiltinESMExports(); const restore = () => { object[key] = original; syncBuiltinESMExports(); }; restorers.push(restore); return restore; }
  async function request(endpoint = '/api/workspace/file', { method = 'PATCH', data, rawBody, auth = true, extraHeaders = {} } = {}) {
    const response = await fetch(app.url + endpoint, { method, headers: { ...(auth ? headers : { 'content-type': 'application/json' }), ...extraHeaders }, body: rawBody ?? (data === undefined ? undefined : JSON.stringify(data)), signal: AbortSignal.timeout(15000) });
    return { status: response.status, data: await response.json(), cacheControl: response.headers.get('cache-control') };
  }
  function input(content = 'after', relative = 'file.txt', expectedHash = hash('before')) { return { storageId: bootstrap.workspace.storageId, path: relative, expectedHash, content }; }
  function raw(data = input(), { partial = false, extraHeaders = {} } = {}) {
    const id = randomUUID(), accepted = gate(), serverClosed = gate(), clientClosed = gate(), result = gate();
    const observe = (req, res) => { if (req.headers['x-test-id'] === id) { app.server.removeListener('request', observe); accepted.resolve(); res.once('close', serverClosed.resolve); } };
    app.server.on('request', observe);
    const client = http.request(app.url + '/api/workspace/file', { method: 'PATCH', headers: { ...headers, 'x-test-id': id, Connection: 'close', ...extraHeaders } });
    clients.add(client); client.once('close', () => { clients.delete(client); clientClosed.resolve(); });
    client.on('error', error => result.resolve({ error: error.code }));
    client.once('response', response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', error => result.resolve({ error: error.code }));
      response.once('end', () => result.resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    const body = JSON.stringify(data); if (partial) client.write(body.slice(0, 12)); else client.end(body);
    return { accepted: accepted.promise, result: result.promise, finish: () => client.end(body.slice(12)), async disconnect() { client.destroy(); await within(Promise.all([serverClosed.promise, clientClosed.promise])); } };
  }
  t.after(async () => {
    for (const g of gates) g.resolve(); for (const client of clients) client.destroy();
    await app.close(); for (const restore of restorers.reverse()) restore();
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { app, workspace, dataDir, bootstrap, headers, request, input, raw, gate, patch };
}

test('authenticated manual save preserves exact content/path, creates only manual audits and survives restart', async t => {
  const f = await fixture(t), content = '\uFEFF edited 中文\r\nline\rtrailing  😀';
  assert.equal(f.bootstrap.capabilities.workspaceEdit, 1);
  assert.equal((await f.request('/api/state', { method: 'GET' })).data.capabilities.workspaceEdit, 1);
  const response = await f.request(undefined, { data: f.input(content, ' file.txt', hash('space before')) });
  assert.equal(response.status, 200); assert.equal(response.cacheControl, 'no-store');
  assert.deepEqual(response.data, { version: 1, storageId: f.bootstrap.workspace.storageId, path: ' file.txt', bytes: Buffer.byteLength(content), sha256: hash(content), changed: true });
  assert.deepEqual(await fs.readFile(path.join(f.workspace, ' file.txt')), Buffer.from(content));
  assert.equal(await fs.readFile(path.join(f.workspace, 'file.txt'), 'utf8'), 'before');
  const audit = await f.request('/api/audit', { method: 'GET' });
  const actions = audit.data.entries.filter(x => x.action.startsWith('workspace.manual'));
  assert.deepEqual(actions.map(x => x.action).sort(), ['workspace.manual-save.requested', 'workspace.manual-saved']);
  for (const entry of actions) { assert.equal(entry.sessionId, null); assert.ok(!entry.detail.includes(content)); assert.ok(!entry.detail.includes(f.workspace)); assert.equal(JSON.parse(entry.detail).path, ' file.txt'); }
  const state = await f.request('/api/state', { method: 'GET' }); assert.deepEqual(state.data.sessions, []);
  assert.equal(audit.data.entries.some(x => x.action.startsWith('approval.')), false);
  await f.app.close();
  const reopened = await startServer({ dataDir: f.dataDir, workspace: f.workspace, workspaceOptions: { createRoot: false, denySensitivePaths: true } });
  try {
    const response = await fetch(reopened.url + '/api/bootstrap'), cookie = response.headers.get('set-cookie').split(';')[0];
    const preview = await fetch(reopened.url + '/api/workspace/file?' + new URLSearchParams({ path: ' file.txt' }), { headers: { cookie } });
    assert.deepEqual(await preview.json(), { path: ' file.txt', content, sha256: hash(content) });
  } finally { await reopened.close(); }
});

test('manual endpoint enforces cookie, CSRF, Origin, Host, exact keys, no query and current storage identity', async t => {
  const f = await fixture(t), input = f.input();
  assert.equal((await f.request(undefined, { data: input, auth: false })).status, 401);
  assert.equal((await f.request(undefined, { data: input, extraHeaders: { 'x-csrf-token': 'bad' } })).data.error.code, 'CSRF');
  assert.equal((await f.request(undefined, { data: input, extraHeaders: { Origin: 'https://hostile.invalid' } })).data.error.code, 'INVALID_ORIGIN');
  const badHost = await within(f.raw(input, { extraHeaders: { Host: 'hostile.invalid' } }).result);
  assert.equal(badHost.status, 403); assert.equal(badHost.data.error.code, 'INVALID_HOST');
  for (const data of [{ ...input, force: true }, { ...input, files: [] }]) assert.equal((await f.request(undefined, { data })).data.error.code, 'INVALID_FILE_EDIT');
  for (const storageId of [undefined, null, 'bad', randomUUID()]) {
    const result = await f.request(undefined, { data: { ...input, storageId } });
    assert.equal(result.status, 409); assert.equal(result.data.error.code, 'FILE_EDIT_WORKSPACE_CHANGED'); assert.ok(!JSON.stringify(result.data).includes(input.storageId));
  }
  assert.equal((await f.request('/api/workspace/file?path=file.txt', { data: input })).data.error.code, 'INVALID_FILE_EDIT');
  assert.equal(await fs.readFile(path.join(f.workspace, 'file.txt'), 'utf8'), 'before');
});

test('raw UTF-8, escaped surrogate, binary targets and byte budgets are enforced without truncation', async t => {
  const f = await fixture(t);
  const invalidUTF8 = Buffer.concat([Buffer.from('{"storageId":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  assert.equal((await f.request(undefined, { rawBody: invalidUTF8 })).data.error.code, 'INVALID_JSON');
  assert.equal((await f.request(undefined, { data: f.input('\ud800') })).data.error.code, 'INVALID_CONTENT');
  assert.equal((await f.request(undefined, { data: f.input('a\0b') })).data.error.code, 'INVALID_CONTENT');
  assert.equal((await f.request(undefined, { data: f.input('a'.repeat(262145)) })).data.error.code, 'FILE_TOO_LARGE');
  const content = '\u0001'.repeat(262144), data = f.input(content);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024); assert.ok(Buffer.byteLength(JSON.stringify(data)) < FILE_EDIT_BODY_BYTES);
  const saved = await f.request(undefined, { data }); assert.equal(saved.status, 200); assert.equal(saved.data.bytes, 262144);
  assert.deepEqual(await fs.readFile(path.join(f.workspace, 'file.txt')), Buffer.from(content));
  const huge = Buffer.from(JSON.stringify(f.input('x')) + ' '.repeat(FILE_EDIT_BODY_BYTES));
  assert.equal((await f.request(undefined, { rawBody: huge })).data.error.code, 'BODY_TOO_LARGE');
});

test('two clients cannot save one stale version and no-op retains inode/mtime without duplicate audit', async t => {
  const f = await fixture(t), input = f.input(), file = path.join(f.workspace, 'file.txt');
  const responses = await Promise.all([f.request(undefined, { data: input }), f.request(undefined, { data: { ...input, content: 'client two' } })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]); assert.equal(responses.find(r => r.status === 409).data.error.code, 'WRITE_CONFLICT');
  const current = await fs.readFile(file, 'utf8'), before = await fs.stat(file, { bigint: true });
  const noop = await f.request(undefined, { data: f.input(current, 'file.txt', hash(current)) });
  assert.equal(noop.status, 200); assert.equal(noop.data.changed, false);
  const after = await fs.stat(file, { bigint: true }); assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  const audit = await f.request('/api/audit', { method: 'GET' }); assert.equal(audit.data.entries.filter(x => x.action === 'workspace.manual-saved').length, 1);
  await fs.unlink(file);
  assert.equal((await f.request(undefined, { data: f.input('next', 'file.txt', hash(current)) })).data.error.code, 'FILE_NOT_FOUND');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('manual endpoint cannot escape sensitive paths, hardlinks or a replaced root', async t => {
  const f = await fixture(t), input = f.input();
  assert.equal((await f.request(undefined, { data: { ...input, path: '../file.txt' } })).data.error.code, 'INVALID_PATH');
  assert.equal((await f.request(undefined, { data: { ...input, path: '.env', expectedHash: hash('fixture-private') } })).status, 403);
  await fs.link(path.join(f.workspace, 'file.txt'), path.join(f.workspace, 'alias'));
  assert.equal((await f.request(undefined, { data: input })).data.error.code, 'UNSAFE_PATH');
  await fs.unlink(path.join(f.workspace, 'alias'));
  await fs.rename(f.workspace, path.join(path.dirname(f.workspace), 'moved'));
  await fs.mkdir(f.workspace); await fs.writeFile(path.join(f.workspace, 'file.txt'), 'before');
  assert.equal((await f.request(undefined, { data: input })).data.error.code, 'WORKSPACE_CHANGED');
  assert.equal(await fs.readFile(path.join(f.workspace, 'file.txt'), 'utf8'), 'before');
});

test('two save slots survive client disconnect until the real read drains, without consuming directory slots', async t => {
  const f = await fixture(t), entered = [f.gate(), f.gate()], release = f.gate(); let starts = 0;
  f.patch(fs, 'open', original => async function (target, ...args) {
    if (path.resolve(target) === path.join(f.workspace, 'file.txt') && starts < 2) { entered[starts++].resolve(); await release.promise; }
    return original.call(this, target, ...args);
  });
  const first = f.raw(), second = f.raw(); await within(Promise.all(entered.map(x => x.promise)));
  const denied = await f.request(undefined, { data: f.input() }); assert.equal(denied.status, 429); assert.equal(denied.data.error.code, 'FILE_EDIT_BUSY');
  assert.equal((await f.request('/api/workspace/directory', { method: 'GET' })).status, 200);
  await first.disconnect();
  assert.equal((await f.request(undefined, { data: f.input() })).data.error.code, 'FILE_EDIT_BUSY');
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  release.resolve(); assert.equal((await within(second.result)).status, 200);
  const audit = await f.request('/api/audit', { method: 'GET' }); assert.equal(audit.data.entries.filter(x => x.action === 'workspace.manual-saved').length, 1);
});

test('disconnect before mutation and shutdown retain the data lock until staging I/O is drained', async t => {
  const f = await fixture(t), file = path.join(f.workspace, 'file.txt'), entered = f.gate(), release = f.gate();
  const handle = await fs.open(file, 'r'), proto = Object.getPrototypeOf(handle); await handle.close();
  f.patch(proto, 'sync', original => async function (...args) { entered.resolve(); await release.promise; return original.apply(this, args); });
  const request = f.raw(); await within(entered.promise); await request.disconnect();
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  let closed = false; const closing = f.app.close().then(() => { closed = true; }); await turn();
  assert.equal(closed, false); await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  release.resolve(); await within(closing);
  assert.equal(await fs.readFile(file, 'utf8'), 'before');
  assert.deepEqual((await fs.readdir(f.workspace)).sort(), [' file.txt', '.env', 'file.txt'].sort());
  const unlock = await acquireDataLock(f.dataDir); await unlock();
});

test('disconnect after native rename is issued preserves the committed file and its audit through shutdown', async t => {
  const f = await fixture(t), file = path.join(f.workspace, 'file.txt'), entered = f.gate(), release = f.gate();
  f.patch(fs, 'rename', original => async function (from, to) {
    const result = await original.call(this, from, to);
    if (path.resolve(to) === file) { entered.resolve(); await release.promise; }
    return result;
  });
  const request = f.raw(); await within(entered.promise); assert.equal(await fs.readFile(file, 'utf8'), 'after');
  await request.disconnect(); let closed = false; const closing = f.app.close().then(() => { closed = true; }); await turn();
  assert.equal(closed, false); await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  release.resolve(); await within(closing);
  const store = new Store(f.dataDir);
  try { assert.equal(store.listAudit().filter(x => x.action === 'workspace.manual-saved').length, 1); } finally { store.close(); }
  assert.equal(await fs.readFile(file, 'utf8'), 'after');
});

test('the 30-second cooperative deadline waits for filesystem completion before responding 504', async t => {
  const f = await fixture(t), entered = f.gate(), release = f.gate(); let intercepted = false, expire;
  f.patch(fs, 'open', original => async function (target, ...args) {
    if (!intercepted && path.resolve(target) === path.join(f.workspace, 'file.txt')) { intercepted = true; entered.resolve(); await release.promise; }
    return original.call(this, target, ...args);
  });
  f.patch(globalThis, 'setTimeout', original => function (callback, ms, ...args) {
    if (ms === 30000) { expire = () => callback(...args); return original(() => {}, 60000); }
    return original(callback, ms, ...args);
  });
  const request = f.raw(); let settled = false; request.result.then(() => { settled = true; });
  await within(entered.promise); assert.equal(typeof expire, 'function'); expire(); await turn(); assert.equal(settled, false);
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  release.resolve(); const response = await within(request.result); assert.equal(response.status, 504); assert.equal(response.data.error.code, 'FILE_EDIT_TIMEOUT');
  assert.equal(await fs.readFile(path.join(f.workspace, 'file.txt'), 'utf8'), 'before');
});

test('an admitted incomplete PATCH body cannot start a save after shutdown begins', async t => {
  const f = await fixture(t), request = f.raw(f.input(), { partial: true }); await within(request.accepted);
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  const closing = f.app.close(); request.finish();
  const response = await within(request.result); assert.equal(response.status, 503); assert.equal(response.data.error.code, 'SHUTTING_DOWN');
  await within(closing); assert.equal(await fs.readFile(path.join(f.workspace, 'file.txt'), 'utf8'), 'before');
});

test('HTTP distinguishes audit rejection before saving from already-written audit failure', async t => {
  const f = await fixture(t), file = path.join(f.workspace, 'file.txt'); let fail = 'workspace.manual-save.requested';
  f.patch(Store.prototype, 'audit', original => function (entry) {
    if (entry.action === fail) throw new Error('fixture private audit failure');
    return original.call(this, entry);
  });
  let response = await f.request(undefined, { data: f.input() });
  assert.equal(response.status, 503); assert.equal(response.data.error.code, 'AUDIT_UNAVAILABLE'); assert.equal(await fs.readFile(file, 'utf8'), 'before');
  fail = 'workspace.manual-saved'; response = await f.request(undefined, { data: f.input() });
  assert.equal(response.status, 503); assert.equal(response.data.error.code, 'POST_WRITE_AUDIT_FAILED'); assert.match(response.data.error.message, /文件已写入/);
  assert.ok(!response.data.error.message.includes('fixture')); assert.equal(await fs.readFile(file, 'utf8'), 'after');
});

test('a real pending model approval remains separate and cannot overwrite a later explicit manual save', async t => {
  let calls = 0, conflict;
  const f = await fixture(t, { runtimeOptions: { providerCall: async (_provider, request) => {
    if (++calls === 1) return { content: '', toolCalls: [{ id: 'manual-race-call', name: 'write_file', args: { path: 'file.txt', content: 'model content' } }] };
    conflict = JSON.parse(request.messages.at(-1).content);
    return { content: 'The file changed; no overwrite was applied.', toolCalls: [] };
  } } });
  const createdProvider = await f.request('/api/providers', { method: 'POST', data: { name: 'Local injected fixture', type: 'openai', model: 'fixture', baseUrl: 'http://127.0.0.1:9/v1', toolMode: 'workspace', streaming: false } });
  assert.equal(createdProvider.status, 201);
  const created = await f.request('/api/sessions', { method: 'POST', data: { providerId: createdProvider.data.provider.id } });
  assert.equal(created.status, 201); const id = created.data.session.id;
  assert.equal((await f.request('/api/sessions/' + id + '/messages', { method: 'POST', data: { content: 'Propose an edit.' } })).status, 202);
  async function waitFor(predicate) {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const response = await f.request('/api/sessions/' + id, { method: 'GET' });
      if (predicate(response.data.session)) return response.data.session;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected local model state did not arrive');
  }
  const pending = await waitFor(session => session.run.status === 'awaiting_approval'), approval = pending.approvals.find(item => item.status === 'pending');
  assert.ok(approval); assert.equal(await fs.readFile(path.join(f.workspace, 'file.txt'), 'utf8'), 'before');
  assert.equal((await f.request(undefined, { data: f.input('manual content') })).status, 200);
  assert.equal((await f.request('/api/approvals/' + approval.id, { method: 'POST', data: { decision: 'approve' } })).status, 200);
  const completed = await waitFor(session => session.run.status === 'completed');
  assert.equal(calls, 2); assert.equal(conflict.error.code, 'WRITE_CONFLICT'); assert.equal(completed.approvals[0].status, 'approved');
  assert.equal(completed.approvals[0].appliedAt, undefined); assert.equal(await fs.readFile(path.join(f.workspace, 'file.txt'), 'utf8'), 'manual content');
  const audit = await f.request('/api/audit', { method: 'GET' });
  assert.equal(audit.data.entries.filter(x => x.action === 'workspace.manual-saved').length, 1);
  assert.equal(audit.data.entries.filter(x => x.action === 'workspace.written').length, 0);
});
