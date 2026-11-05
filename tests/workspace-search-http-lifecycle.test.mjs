// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/index.mjs';
import { acquireDataLock } from '../server/lock.mjs';

function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
async function within(promise, milliseconds = 5000) {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Lifecycle event did not arrive')), milliseconds); })]); }
  finally { clearTimeout(timeout); }
}

async function fixture(t) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-search-lifecycle-'));
  const workspace = path.join(root, 'project'), dataDir = path.join(root, 'data');
  let app, restore;
  const gates = [], requests = new Set();
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    for (const request of requests) request.destroy();
    restore?.();
    await app?.close();
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.match(path.basename(root), /^openaster-search-lifecycle-[A-Za-z0-9]+$/u);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'safe.txt'), 'needle');
  app = await startServer({ dataDir, workspace, workspaceOptions: { createRoot: false } });
  const bootstrapResponse = await fetch(app.url + '/api/bootstrap');
  const bootstrap = await bootstrapResponse.json();
  const headers = {
    cookie: bootstrapResponse.headers.get('set-cookie').split(';')[0],
    'x-csrf-token': bootstrap.csrfToken, 'content-type': 'application/json',
  };
  const directory = await fs.opendir(workspace), prototype = Object.getPrototypeOf(directory);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, Symbol.asyncIterator);
  await directory.close();
  let nextGate;
  Object.defineProperty(prototype, Symbol.asyncIterator, { ...descriptor, value: async function* () {
    for await (const entry of descriptor.value.call(this)) {
      const current = nextGate;
      if (this.path === workspace && current && !current.entered) {
        current.entered = true; current.started.resolve(); await current.release.promise;
      }
      yield entry;
    }
  } });
  restore = () => Object.defineProperty(prototype, Symbol.asyncIterator, descriptor);
  function hold() {
    nextGate = { started: deferred(), release: deferred(), entered: false };
    gates.push(nextGate); return nextGate;
  }
  async function search() {
    const response = await fetch(app.url + '/api/workspace/search', {
      method: 'POST', headers, body: JSON.stringify({ query: 'needle' }), signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, data: await response.json() };
  }
  function rawSearch() {
    const id = randomUUID(), serverClosed = deferred(), clientClosed = deferred(), completed = deferred();
    let responseCount = 0;
    const observe = (incoming, response) => {
      if (incoming.headers['x-test-request'] !== id) return;
      app.server.removeListener('request', observe);
      response.once('close', serverClosed.resolve);
    };
    app.server.on('request', observe);
    t.after(() => app.server.removeListener('request', observe));
    const request = http.request(app.url + '/api/workspace/search', {
      method: 'POST', headers: { ...headers, 'x-test-request': id, Connection: 'close' },
    });
    requests.add(request);
    request.once('close', () => { requests.delete(request); clientClosed.resolve(); });
    request.on('error', error => completed.resolve({ error: error.code }));
    request.once('response', response => {
      responseCount++; const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', error => completed.resolve({ error: error.code }));
      response.once('end', () => completed.resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.end(JSON.stringify({ query: 'needle' }));
    return { request, completed: completed.promise, get responseCount() { return responseCount; }, async disconnect() {
      request.destroy(); await within(Promise.all([clientClosed.promise, serverClosed.promise]));
    } };
  }
  return { app, dataDir, hold, search, rawSearch };
}

test('HTTP disconnect retains the search slot and rejects idle switching until actual filesystem work settles', async t => {
  const f = await fixture(t), held = f.hold(), first = f.rawSearch();
  await within(held.started.promise);
  let concurrent = await f.search();
  assert.equal(concurrent.status, 429); assert.equal(concurrent.data.error.code, 'WORKSPACE_SEARCH_BUSY');
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY', status: 409 });
  await first.disconnect();
  concurrent = await f.search();
  assert.equal(concurrent.status, 429); assert.equal(concurrent.data.error.code, 'WORKSPACE_SEARCH_BUSY');
  await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY', status: 409 });
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  held.release.resolve();
  let subsequent;
  for (let attempt = 0; attempt < 40; attempt++) {
    subsequent = await f.search();
    if (subsequent.status !== 429) break;
    await delay(10);
  }
  assert.equal(subsequent.status, 200); assert.equal(subsequent.data.matches.length, 1);
  assert.equal(first.responseCount, 0, 'A disconnected client never receives a late successful search');
  await f.app.close({ ifIdle: true });
});

test('forced close waits for a disconnected search before releasing its real SQLite data lock', async t => {
  const f = await fixture(t), held = f.hold(), first = f.rawSearch();
  await within(held.started.promise); await first.disconnect();
  let closed = false;
  const shutdown = f.app.close().then(() => { closed = true; });
  await delay(100);
  assert.equal(closed, false, 'Closed sockets do not imply that their filesystem handlers have stopped');
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED', status: 409 });
  held.release.resolve(); await within(shutdown);
  assert.equal(closed, true);
  const release = await acquireDataLock(f.dataDir); await release();
  assert.equal(first.responseCount, 0);
});

test('forced close cancels a connected search and rejects its late result before completing shutdown', async t => {
  const f = await fixture(t), held = f.hold(), first = f.rawSearch();
  await within(held.started.promise);
  let closed = false;
  const shutdown = f.app.close().then(() => { closed = true; });
  await delay(50); assert.equal(closed, false);
  await assert.rejects(acquireDataLock(f.dataDir), { code: 'DATA_LOCKED' });
  held.release.resolve();
  const response = await within(first.completed);
  assert.equal(response.status, 503); assert.equal(response.data.error.code, 'SHUTTING_DOWN');
  assert.equal(Object.hasOwn(response.data, 'matches'), false);
  await within(shutdown);
  const release = await acquireDataLock(f.dataDir); await release();
});
