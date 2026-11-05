// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.mjs';
import { acquireDataLock } from '../server/lock.mjs';
import { Store } from '../server/store.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms = 5000) {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Fixture timed out')), ms); })]); }
  finally { clearTimeout(timeout); }
}
async function until(operation, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await operation(); if (predicate(value)) return value; await delay(10); }
  throw new Error('Fixture state did not settle');
}
function reply(response, content = 'OK') {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
}

async function fixture(t, options = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-diagnostics-http-'));
  const identity = await fs.lstat(root, { bigint: true });
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace');
  const calls = [], controls = { handler: (_request, response) => reply(response) };
  const upstream = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const call = { payload: JSON.parse(Buffer.concat(chunks)), closed: deferred(), response };
      response.once('close', call.closed.resolve); calls.push(call);
      await controls.handler(request, response, call);
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  await bounded(new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)));
  let service;
  t.after(async () => {
    await service?.close(); upstream.closeAllConnections();
    await bounded(new Promise(resolve => upstream.close(resolve)));
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    await fs.rm(root, { recursive: true });
  });
  const token = 'isolated-diagnostics-gateway-'.repeat(3);
  service = await startServer({ host: '127.0.0.1', port: 0, dataDir, workspace, ...options,
    ...(options.gateway ? { gatewayOrigin: 'https://diagnostics.example.test', token, allowedOrigins: ['capacitor://localhost'] } : {}) });
  const remote = options.gateway ? { Authorization: `Bearer ${token}`, Origin: 'capacitor://localhost' } : {};
  const boot = await fetch(service.url + '/api/bootstrap', { headers: remote, signal: AbortSignal.timeout(5000) });
  const bootstrap = await boot.json(), cookie = boot.headers.get('set-cookie')?.split(';')[0];
  const headers = { ...remote, ...(cookie ? { cookie } : {}), 'X-CSRF-Token': bootstrap.csrfToken };
  async function request(endpoint, { method = 'GET', data, raw, auth = true, extraHeaders = {} } = {}) {
    const response = await fetch(service.url + endpoint, { method, headers: { ...(auth ? headers : {}), ...(data !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: raw ?? (data === undefined ? undefined : JSON.stringify(data)), signal: AbortSignal.timeout(10000) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  async function provider(fields = {}) {
    const result = await request('/api/providers', { method: 'POST', data: { name: 'isolated fixture', type: 'openai', model: 'fixture-model', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'not-a-real-provider-secret', ...fields } });
    assert.equal(result.status, 201); return result.data.provider;
  }
  function rawCheck(id, mode = 'diagnostics') {
    const done = deferred();
    const req = http.request(service.url + `/api/providers/${id}/${mode}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Connection: 'close' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => done.resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.once('error', cause => done.resolve({ error: cause.code })); req.end('{}');
    return { req, done: done.promise };
  }
  return { root, dataDir, workspace, service, request, provider, bootstrap, calls, controls, rawCheck };
}

test('invalid diagnostic configuration has no filesystem or lock side effects and the same directory remains usable', async () => {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-diagnostics-options-'));
  const identity = await fs.lstat(root, { bigint: true }), dataDir = path.join(root, 'not-created-yet');
  let service;
  try {
    await assert.rejects(startServer({ dataDir, workspace: path.join(dataDir, 'workspace'), providerDiagnosticsOptions: { timeoutMs: 0 } }), TypeError);
    await assert.rejects(fs.lstat(dataDir), { code: 'ENOENT' });
    service = await startServer({ dataDir, workspace: path.join(dataDir, 'workspace') });
    await service.close();
    const release = await acquireDataLock(dataDir); await release();
  } finally {
    await service?.close(); const current = await fs.lstat(root, { bigint: true });
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    await fs.rm(root, { recursive: true });
  }
});

test('diagnostics advertises capability and requires authentication, CSRF, origin and strict bounded empty JSON', async t => {
  const f = await fixture(t), endpoint = '/api/providers/demo/diagnostics';
  assert.equal(f.bootstrap.capabilities.providerDiagnostics, 1);
  assert.equal((await f.request('/api/state')).data.capabilities.providerDiagnostics, 1);
  for (const options of [{ auth: false }, { extraHeaders: { 'X-CSRF-Token': 'wrong' } }, { extraHeaders: { Origin: 'https://attacker.invalid' } }]) {
    const value = await f.request(endpoint, { method: 'POST', data: {}, ...options });
    assert.equal(value.status, options.auth === false ? 401 : 403);
  }
  for (const data of [{ prompt: 'private' }, { checks: ['text'] }, { signal: {} }, { timeoutMs: 1 }, { providerId: 'demo' }]) {
    const result = await f.request(endpoint, { method: 'POST', data }); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_PROVIDER_DIAGNOSTICS');
  }
  for (const raw of ['null', '[]', '{', Buffer.from([123, 34, 255, 34, 58, 48, 125])]) {
    assert.equal((await f.request(endpoint, { method: 'POST', raw })).data.error.code, 'INVALID_JSON');
  }
  assert.equal((await f.request(endpoint + '?check=text', { method: 'POST', data: {} })).data.error.code, 'INVALID_PROVIDER_DIAGNOSTICS');
  assert.equal((await f.request(endpoint, { method: 'POST', data: { x: 'x'.repeat(8192) } })).status, 413);
  assert.equal((await f.request(endpoint, { method: 'POST', data: {}, extraHeaders: { 'Content-Type': 'text/plain' } })).status, 415);
  const result = await f.request(endpoint, { method: 'POST', data: {} });
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(result.data.version, 1); assert.equal(result.data.requestsStarted, 0);
  assert.equal(f.calls.length, 0);
});

test('gateway diagnostics retains bearer and CSRF and disabled connections cannot send requests', async t => {
  const f = await fixture(t, { gateway: true }), provider = await f.provider();
  const endpoint = `/api/providers/${provider.id}/diagnostics`;
  assert.equal((await f.request(endpoint, { method: 'POST', data: {}, extraHeaders: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await f.request(endpoint, { method: 'POST', data: {}, extraHeaders: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request(`/api/providers/${provider.id}`, { method: 'PATCH', data: { enabled: false } })).status, 200);
  for (const mode of ['diagnostics', 'test']) {
    const result = await f.request(`/api/providers/${provider.id}/${mode}`, { method: 'POST', data: {} });
    assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PROVIDER_DISABLED');
  }
  assert.equal(f.calls.length, 0);
});

for (const mode of ['test', 'diagnostics']) test(`${mode} pins all configuration and credentials for its complete network lifetime`, async t => {
  const f = await fixture(t), provider = await f.provider({ toolMode: 'none', streaming: false });
  const seen = deferred(); f.controls.handler = (_request, _response, call) => { seen.resolve(call); };
  const check = f.rawCheck(provider.id, mode), call = await bounded(seen.promise);
  await assert.rejects(f.service.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  for (const data of [{ model: 'new-model' }, { apiKey: 'new-local-secret' }, { clearKey: true }, { enabled: false }]) {
    const result = await f.request(`/api/providers/${provider.id}`, { method: 'PATCH', data });
    assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PROVIDER_BUSY');
  }
  assert.equal((await f.request(`/api/providers/${provider.id}`, { method: 'DELETE' })).data.error.code, 'PROVIDER_BUSY');
  for (const other of ['test', 'diagnostics']) {
    const busy = await f.request(`/api/providers/demo/${other}`, { method: 'POST', data: {} });
    assert.equal(busy.status, 429); assert.equal(busy.data.error.code, 'PROVIDER_DIAGNOSTICS_BUSY');
  }
  f.controls.handler = (_request, response) => reply(response); reply(call.response);
  assert.equal((await bounded(check.done)).status, 200);
  assert.equal((await f.request(`/api/providers/${provider.id}`, { method: 'PATCH', data: { model: 'new-model' } })).status, 200);
});

test('diagnostic credential acquisition is pinned; disconnect and shutdown wait for its real settlement', async t => {
  const values = new Map(), entered = deferred(), gate = deferred(); let delayed = false;
  const secretStore = { get: async id => { if (delayed && id !== 'demo') { entered.resolve(); await gate.promise; } return values.get(id); }, set: (id, value) => values.set(id, value), delete: id => values.delete(id) };
  const f = await fixture(t, { secretStore }), provider = await f.provider();
  delayed = true; const check = f.rawCheck(provider.id); await bounded(entered.promise);
  assert.equal((await f.request(`/api/providers/${provider.id}`, { method: 'PATCH', data: { clearKey: true } })).data.error.code, 'PROVIDER_BUSY');
  check.req.destroy(); await bounded(check.done);
  assert.equal((await f.request('/api/providers/demo/test', { method: 'POST', data: {} })).data.error.code, 'PROVIDER_DIAGNOSTICS_BUSY');
  let stopped = false; const closing = f.service.close().then(() => { stopped = true; });
  await delay(30); assert.equal(stopped, false); await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  gate.resolve(); await bounded(closing); assert.equal(f.calls.length, 0);
  const release = await acquireDataLock(f.dataDir); await release();
});

for (const mode of ['test', 'diagnostics']) test(`disconnect cancels ${mode} upstream and permits a subsequent check after settlement`, async t => {
  const f = await fixture(t), provider = await f.provider();
  const seen = deferred(); f.controls.handler = (_request, _response, call) => { seen.resolve(call); };
  const check = f.rawCheck(provider.id, mode), call = await bounded(seen.promise);
  check.req.destroy(); await bounded(check.done); await bounded(call.closed.promise);
  await until(() => f.request('/api/providers/demo/test', { method: 'POST', data: {} }), result => result.status === 200);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.request(`/api/providers/${provider.id}`, { method: 'DELETE' })).status, 200);
});

test('server close cancels a connected diagnostic before releasing the data-directory lock', async t => {
  const f = await fixture(t), provider = await f.provider(), seen = deferred();
  f.controls.handler = (_request, _response, call) => { seen.resolve(call); };
  const check = f.rawCheck(provider.id), call = await bounded(seen.promise);
  await bounded(f.service.close()); await bounded(call.closed.promise);
  const result = await bounded(check.done); assert.equal(result.status, 503); assert.equal(result.data.error.code, 'SHUTTING_DOWN');
  const release = await acquireDataLock(f.dataDir); await release(); assert.equal(f.calls.length, 1);
});

for (const mode of ['test', 'diagnostics']) test(`${mode} deadline aborts upstream and returns a safe timeout without background requests`, async t => {
  const f = await fixture(t, { providerDiagnosticsOptions: { timeoutMs: 200, testTimeoutMs: 200 } }), provider = await f.provider(), seen = deferred();
  f.controls.handler = (_request, _response, call) => { seen.resolve(call); };
  const check = f.rawCheck(provider.id, mode), call = await bounded(seen.promise);
  const result = await bounded(check.done); assert.equal(result.status, 504);
  assert.equal(result.data.error.code, mode === 'test' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_DIAGNOSTICS_TIMEOUT');
  await bounded(call.closed.promise); assert.equal(f.calls.length, 1);
  assert.equal((await f.request('/api/providers/demo/test', { method: 'POST', data: {} })).status, 200);
});

test('synthetic four-request diagnostics do not send workspace or conversation data and do not persist results, usage or approvals', async t => {
  const f = await fixture(t), provider = await f.provider();
  f.controls.handler = (_request, response, { payload }) => {
    const result = payload.messages.find(message => message.role === 'tool');
    if (result) { reply(response, JSON.parse(result.content).result.receipt); return; }
    if (payload.tools?.length) {
      const definition = payload.tools[0].function;
      assert.equal(definition.name, 'openaster_diagnostic_echo');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'synthetic_call', type: 'function', function: { name: definition.name, arguments: JSON.stringify({ nonce: definition.parameters.properties.nonce.enum[0] }) } }] }, finish_reason: 'tool_calls' }] }));
    } else reply(response);
  };
  const marker = 'private-workspace-and-conversation-marker';
  const userMarker = 'private-historical-user-message-marker', assistantMarker = 'private-historical-assistant-message-marker';
  const snapshot = '\ufeffprivate-historical-file-snapshot-marker\r\n';
  const markers = [marker, userMarker, assistantMarker, snapshot.trim()];
  await fs.writeFile(path.join(f.workspace, 'private.txt'), marker);
  const created = await f.request('/api/sessions', { method: 'POST', data: { providerId: provider.id, title: marker } });
  const stored = new Store(f.dataDir);
  try {
    const session = stored.getSession(created.data.session.id), createdAt = new Date().toISOString();
    session.messages = [
      { id: 'historic-user', role: 'user', content: userMarker, createdAt, contextFiles: [{ path: 'history-only.txt', sha256: createHash('sha256').update(snapshot).digest('hex'), content: snapshot }] },
      { id: 'historic-assistant', role: 'assistant', content: assistantMarker, createdAt },
    ];
    session.updatedAt = createdAt; stored.putSession(session);
  } finally { stored.close(); }
  const before = (await f.request('/api/export')).data, usageBefore = (await f.request('/api/usage')).data;
  const historical = before.sessions.find(session => session.id === created.data.session.id);
  assert.equal(historical.messages[0].content, userMarker); assert.equal(historical.messages[1].content, assistantMarker);
  assert.equal(historical.messages[0].contextFiles[0].content, snapshot);
  const response = await f.request(`/api/providers/${provider.id}/diagnostics`, { method: 'POST', data: {} });
  assert.equal(response.status, 200); assert.equal(response.data.version, 1);
  assert.equal(response.data.requestsStarted, 4);
  assert.equal(response.data.checks.text.status, 'passed');
  assert.equal(response.data.checks.stream.code, 'STREAM_JSON_FALLBACK');
  assert.equal(response.data.checks.tools.status, 'passed');
  assert.equal(f.calls.length, response.data.requestsStarted);
  const report = JSON.stringify(response.data);
  assert.ok(!report.includes('not-a-real-provider-secret')); for (const value of markers) assert.ok(!report.includes(value));
  for (const { payload } of f.calls) {
    for (const value of markers) assert.ok(!JSON.stringify(payload).includes(value));
    assert.ok(!payload.tools || payload.tools.every(tool => tool.function.name === 'openaster_diagnostic_echo'));
  }
  const after = (await f.request('/api/export')).data;
  const { exportedAt: _beforeTime, ...beforeData } = before, { exportedAt: _afterTime, ...afterData } = after;
  assert.deepEqual(afterData, beforeData);
  assert.deepEqual((await f.request('/api/usage')).data, usageBefore);
  assert.equal(await fs.readFile(path.join(f.workspace, 'private.txt'), 'utf8'), marker);
  assert.deepEqual(await fs.readdir(f.workspace), ['private.txt']);
});

test('provider error bodies and credentials do not appear in diagnostic reports or persisted audit entries', async t => {
  const f = await fixture(t), provider = await f.provider();
  const marker = 'upstream-private-response-not-for-client';
  f.controls.handler = (_request, response) => { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: marker } })); };
  const before = (await f.request('/api/audit')).data;
  const result = await f.request(`/api/providers/${provider.id}/diagnostics`, { method: 'POST', data: {} });
  assert.equal(result.status, 200); assert.equal(result.data.requestsStarted, 1);
  assert.equal(result.data.checks.text.code, 'PROVIDER_AUTH_FAILED');
  assert.equal(result.data.checks.stream.status, 'skipped'); assert.equal(result.data.checks.tools.status, 'skipped');
  assert.ok(!JSON.stringify(result.data).includes(marker)); assert.ok(!JSON.stringify(result.data).includes('not-a-real-provider-secret'));
  assert.deepEqual((await f.request('/api/audit')).data, before);
});

test('a credential update already in progress excludes diagnostics without occupying their global slot', async t => {
  const values = new Map(), entered = deferred(), gate = deferred(); let delayed = false;
  const secretStore = { get: id => values.get(id), set: async (id, value) => { if (delayed) { entered.resolve(); await gate.promise; } values.set(id, value); }, delete: id => values.delete(id) };
  const f = await fixture(t, { secretStore }), provider = await f.provider(); delayed = true;
  const update = f.request(`/api/providers/${provider.id}`, { method: 'PATCH', data: { apiKey: 'replacement-local-key' } });
  try {
    await bounded(entered.promise);
    for (const mode of ['diagnostics', 'test']) assert.equal((await f.request(`/api/providers/${provider.id}/${mode}`, { method: 'POST', data: {} })).data.error.code, 'PROVIDER_BUSY');
    assert.equal((await f.request('/api/providers/demo/diagnostics', { method: 'POST', data: {} })).status, 200);
    assert.equal(f.calls.length, 0);
  } finally { gate.resolve(); }
  assert.equal((await update).status, 200);
});
