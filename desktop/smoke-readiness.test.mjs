// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createSmokeReadiness } from './smoke-readiness.mjs';
import { createSmokeController } from './smoke-diagnostics.mjs';

const origin = 'http://127.0.0.1:43111';
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}, handler = async () => {}) {
  const server = new EventEmitter(), failures = []; server.on('request', handler);
  const readiness = createSmokeReadiness({ server, origin, onFailure: error => failures.push(error.code), ...options });
  return { server, handler, readiness, failures, invoke: (...args) => server.listeners('request')[0].call(server, ...args) };
}
const request = (readiness, id, route = '/api/workspace', extra = {}) => {
  const responses = []; readiness.beforeRequest({ id, url: origin + route, method: 'GET', ...extra }, response => responses.push(response)); return responses;
};
const complete = (readiness, id, statusCode = 200) => readiness.completed({ id, statusCode });
const sse = (readiness, id, options = {}) => readiness.responseStarted({ id, statusCode: 200, responseHeaders: { 'Content-Type': ['text/event-stream; charset=utf-8'] }, ...options });
async function isPending(promise) { const flag = {}; return await Promise.race([promise.then(() => true, () => true), Promise.resolve(flag)]) === flag; }

test('observer preserves original this, arguments and exact Promise, then restores only its owned listener', async () => {
  const wait = gate(), calls = [];
  function handler(...args) { calls.push({ self: this, args }); return wait.promise; }
  const f = fixture({}, handler), req = {}, res = {}, pending = f.invoke(req, res);
  assert.equal(calls[0].self, f.server); assert.deepEqual(calls[0].args, [req, res]); assert.equal(pending, wait.promise);
  const sealing = f.readiness.seal(); assert.equal(await isPending(sealing), true);
  wait.resolve(); await pending; const proof = await sealing;
  assert.equal(proof.handlersStarted, 1); assert.equal(proof.handlersSettled, 1);
  f.readiness.dispose(); assert.deepEqual(f.server.rawListeners('request'), [handler]);
});

test('invalid or multiple original listeners are rejected without changing the server', () => {
  for (const count of [0, 2]) {
    const server = new EventEmitter(); for (let i = 0; i < count; i++) server.on('request', async () => {});
    const before = server.rawListeners('request'); assert.throws(() => createSmokeReadiness({ server, origin }), { code: 'SMOKE_READINESS_FAILED' }); assert.deepEqual(server.rawListeners('request'), before);
  }
  const server = new EventEmitter(); server.once('request', async () => {});
  const before = server.rawListeners('request'); assert.throws(() => createSmokeReadiness({ server, origin }), { code: 'SMOKE_READINESS_FAILED' }); assert.deepEqual(server.rawListeners('request'), before);
});

test('admission is registered before callback and seal waits for a previously admitted request not yet at the server', async () => {
  const work = gate(), f = fixture({}, async () => work.promise); let sealing;
  f.readiness.beforeRequest({ id: 1, url: origin + '/api/workspace', method: 'GET' }, response => { assert.equal(response.cancel, false); sealing = f.readiness.seal(); });
  assert.equal(await isPending(sealing), true);
  const pending = f.invoke({}, {}); complete(f.readiness, 1);
  assert.equal(await isPending(sealing), true); work.resolve(); await pending;
  const proof = await sealing; assert.equal(proof.admittedRequests, 1); assert.equal(proof.completedRequests, 1); assert.equal(proof.handlersSettled, 1);
  f.readiness.dispose();
});

test('seal synchronously holds new page and Service Worker callbacks and never forwards them to the server', async () => {
  const f = fixture(); const sealing = f.readiness.seal();
  const page = request(f.readiness, 1), worker = request(f.readiness, 2, '/app.js', { webContentsId: undefined });
  assert.deepEqual(page, []); assert.deepEqual(worker, []);
  const proof = await sealing; assert.equal(proof.admittedRequests, 0); assert.equal(proof.handlersStarted, 0); assert.equal(proof.pausedRequests, 2);
  f.readiness.beginClosing(); assert.deepEqual(page, [{ cancel: true }]); assert.deepEqual(worker, [{ cancel: true }]);
  f.readiness.beginClosing(); assert.equal(page.length, 1); f.readiness.dispose();
});

test('origin denial remains ahead of admission and never holds or admits a foreign request', async () => {
  const f = fixture(); const replies = [];
  f.readiness.beforeRequest({ id: 1, url: 'https://foreign.invalid/private?token=secret', method: 'GET' }, response => replies.push(response));
  assert.deepEqual(replies, [{ cancel: true }]); const proof = await f.readiness.seal();
  assert.equal(proof.admittedRequests, 0); assert.equal(JSON.stringify(proof).includes('secret'), false); f.readiness.dispose();
});

test('SSE successful initial response still awaits its actual handler and does not wait for stream EOF', async () => {
  const wait = gate(), f = fixture({}, async () => wait.promise);
  request(f.readiness, 1, '/api/events'); const pending = f.invoke({}, {}); const sealing = f.readiness.seal();
  sse(f.readiness, 1); assert.equal(await isPending(sealing), true);
  wait.resolve(); await pending; const proof = await sealing; assert.equal(proof.eventStreamsReady, 1); assert.equal(proof.completedRequests, 0);
  f.readiness.beginClosing(); f.readiness.errored({ id: 1, error: 'secret raw error' }); assert.deepEqual(f.failures, []); f.readiness.dispose();
});

for (const options of [{ statusCode: 401 }, { responseHeaders: { 'Content-Type': ['application/json'] } }, { responseHeaders: {} }]) test('SSE requires successful status and exact event-stream content type: ' + JSON.stringify(options), async () => {
  const f = fixture(); request(f.readiness, 1, '/api/events'); sse(f.readiness, 1, options);
  await assert.rejects(f.readiness.seal(), { code: 'SMOKE_READINESS_FAILED' }); f.readiness.dispose();
});

test('finite resources cannot settle on headers alone and HTTP errors fail the barrier', async () => {
  const f = fixture(); request(f.readiness, 1, '/app.js'); const sealing = f.readiness.seal();
  f.readiness.responseStarted({ id: 1, statusCode: 200 }); assert.equal(await isPending(sealing), true);
  complete(f.readiness, 1, 503); await assert.rejects(sealing, { code: 'SMOKE_READINESS_FAILED' }); f.readiness.dispose();
});

test('network abort is a failed verification and never permission to detach an active original handler', async () => {
  const wait = gate(), f = fixture({}, async () => wait.promise); request(f.readiness, 1); const pending = f.invoke({}, {});
  const sealing = f.readiness.seal(); f.readiness.errored({ id: 1, error: 'private path or token' });
  await assert.rejects(sealing, { code: 'SMOKE_READINESS_FAILED' }); assert.throws(() => f.readiness.dispose(), { code: 'SMOKE_READINESS_FAILED' });
  wait.resolve(); await pending; f.readiness.dispose(); assert.deepEqual(f.failures, ['SMOKE_READINESS_FAILED']);
});

test('rejected original handler remains rejected and latches a fixed failure even after a response completed', async () => {
  const wait = gate(), f = fixture({}, async () => { await wait.promise; throw Object.assign(new Error('secret'), { code: 'SECRET' }); });
  request(f.readiness, 1); const pending = f.invoke({}, {}); const rejection = assert.rejects(pending, /secret/);
  complete(f.readiness, 1); const sealing = f.readiness.seal(); wait.resolve(); await rejection;
  await assert.rejects(sealing, { code: 'SMOKE_READINESS_FAILED' }); assert.deepEqual(f.failures, ['SMOKE_READINESS_FAILED']); f.readiness.dispose();
});

test('timeout is bounded, performs no retry, and releases held callbacks only during explicit closing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ timeoutMs: 123 }); request(f.readiness, 1); const sealing = f.readiness.seal(), rejected = assert.rejects(sealing, { code: 'SMOKE_READINESS_TIMEOUT' });
  const held = request(f.readiness, 2); t.mock.timers.tick(123); await rejected;
  assert.deepEqual(held, []); f.readiness.beginClosing(); assert.deepEqual(held, [{ cancel: true }]); f.readiness.dispose();
});

test('late gate overflow reaches the smoke latch and prevents queued menu entry and successor preparation', async () => {
  let clicks = 0, prepares = 0, launches = 0; const records = [];
  const controller = createSmokeController({ phase: 2, record: value => records.push(value), close: async () => {}, output: () => {}, exit: () => {} });
  const f = fixture({ maxActive: 1, onFailure: error => controller.capture(error, { action: 'page-check', reason: 'page-check-failed' }) });
  await f.readiness.seal(); request(f.readiness, 1);
  const queued = controller.runMenu('switch-default', () => { clicks++; }); request(f.readiness, 2);
  assert.equal(await queued, false);
  await controller.relaunch({ select: async () => 'default', prepare: () => { prepares++; }, launch: () => { launches++; } });
  assert.equal(clicks + prepares + launches, 0); assert.equal(records[0].diagnostic.code, 'SMOKE_READINESS_LIMIT'); f.readiness.dispose();
});

test('unexpected SSE failure after seal still fails before explicit closing starts', async () => {
  const f = fixture(); request(f.readiness, 1, '/api/events'); sse(f.readiness, 1); await f.readiness.seal();
  f.readiness.errored({ id: 1 }); assert.deepEqual(f.failures, ['SMOKE_READINESS_FAILED']); f.readiness.dispose();
});

test('a completed historical response is not reclassified by a duplicate late network error', async () => {
  const f = fixture(); request(f.readiness, 1); complete(f.readiness, 1); f.readiness.errored({ id: 1 });
  await f.readiness.seal(); assert.deepEqual(f.failures, []); f.readiness.dispose();
});

test('callback exceptions and duplicate IDs fail safely without exposing arbitrary error properties', async () => {
  const f = fixture(); f.readiness.beforeRequest({ id: 1, url: origin + '/api/workspace', method: 'GET' }, () => { throw new Error('secret'); });
  await assert.rejects(f.readiness.seal(), { code: 'SMOKE_READINESS_FAILED' }); f.readiness.dispose();
  const second = fixture(); request(second.readiness, 1); assert.deepEqual(request(second.readiness, 1), [{ cancel: true }]);
  await assert.rejects(second.readiness.seal(), { code: 'SMOKE_READINESS_FAILED' }); second.readiness.dispose();
});

test('changed listener ownership is never overwritten during cleanup', async () => {
  const f = fixture(), foreign = () => {}; f.server.on('request', foreign);
  await assert.rejects(f.readiness.seal(), { code: 'SMOKE_READINESS_FAILED' });
  assert.throws(() => f.readiness.dispose(), { code: 'SMOKE_READINESS_FAILED' }); assert.ok(f.server.listeners('request').includes(foreign));
});

test('real loopback response completion cannot bypass a handler that still has async work', async t => {
  const entered = gate(), release = gate();
  const server = http.createServer(async (_req, res) => { res.end('ok'); entered.resolve(); await release.promise; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const readiness = createSmokeReadiness({ server, origin: url });
  t.after(async () => { release.resolve(); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); readiness.dispose(); });
  readiness.beforeRequest({ id: 1, url: url + '/api/workspace', method: 'GET' }, response => assert.equal(response.cancel, false));
  const response = await fetch(url + '/api/workspace'); assert.equal(await response.text(), 'ok'); await entered.promise;
  readiness.completed({ id: 1, statusCode: 200 }); const sealing = readiness.seal(); assert.equal(await isPending(sealing), true);
  release.resolve(); const proof = await sealing; assert.equal(proof.handlersStarted, 1); assert.equal(proof.handlersSettled, 1);
});
