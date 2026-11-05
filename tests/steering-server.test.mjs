// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-steering-http-'));
  const identity = await fs.lstat(root, { bigint: true }), owner = randomUUID(), entered = deferred(), release = deferred(); let calls = 0;
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  const service = await startServer({ dataDir: path.join(root, 'data'), port: 0, runtimeOptions: { providerCall: async (_provider, request) => {
    calls++; if (calls === 1) { entered.resolve(); await Promise.race([release.promise, new Promise((_, reject) => {
      if (request.signal.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      request.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
    })]); }
    return { content: 'Local test completed', toolCalls: [] };
  } } });
  t.after(async () => {
    release.resolve(); await service.close(); const actual = await fs.lstat(root, { bigint: true });
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), parent); assert.equal(actual.ino, identity.ino); assert.equal(actual.dev, identity.dev);
    assert.equal(actual.isSymbolicLink(), false); assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const first = await fetch(service.url + '/api/bootstrap'), bootstrap = await first.json();
  const headers = { cookie: first.headers.get('set-cookie').split(';')[0], 'x-csrf-token': bootstrap.csrfToken, 'content-type': 'application/json' };
  const request = async (route, body, extra = {}) => {
    const response = await fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const provider = await request('/api/providers', { name: 'Isolated mock', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-not-a-real-key', streaming: false });
  assert.equal(provider.status, 201);
  const session = (await request('/api/sessions', { providerId: provider.data.provider.id })).data.session;
  const route = `/api/sessions/${session.id}`, started = await request(route + '/messages', { content: 'Initial mocked request' }); assert.equal(started.status, 202);
  await entered.promise;
  return { bootstrap, service, route, request, release, calls: () => calls, started: started.data.session,
    input: content => ({ mode: 'queue', requestId: randomUUID(), expectedRunId: started.data.session.run.id, content }),
    async finished() { const end = Date.now() + 10000; while (Date.now() < end) { const current = (await request(route)).data.session; if (current.queuedInputs?.length && current.queuedInputs.every(input => input.status !== 'pending') && ['completed', 'cancelled', 'failed'].includes(current.run.status)) return current; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Isolated steering task did not finish'); },
  };
}

test('HTTP queue preserves auth and pinned context, deduplicates requests and batches durable input into one next run', async t => {
  const f = await fixture(t), input = f.input('  First addition\n');
  assert.equal(f.bootstrap.capabilities.taskInput, 1);
  assert.equal((await f.request(f.route + '/messages', input, { 'x-csrf-token': 'invalid' })).status, 403);
  assert.equal((await f.request(f.route + '/messages', { ...input, providerId: 'demo' })).status, 400);
  assert.equal((await f.request(f.route + '/messages', { ...input, expectedRunId: randomUUID() })).status, 409);
  const accepted = await f.request(f.route + '/messages', input); assert.equal(accepted.status, 202);
  assert.equal(accepted.data.session.queuedInputs[0].content, input.content); assert.equal(accepted.data.input.status, 'pending');
  assert.equal((await f.request(f.route + '/messages', input)).data.duplicate, true);
  assert.equal((await f.request(f.route + '/messages', { ...input, content: 'different' })).status, 409);
  const second = f.input('Second addition'); assert.equal((await f.request(f.route + '/messages', second)).status, 202);
  f.release.resolve(); const done = await f.finished();
  assert.equal(done.run.status, 'completed'); assert.equal(f.calls(), 2);
  assert.deepEqual(done.queuedInputs.map(value => value.status), ['consumed', 'consumed']);
  assert.equal(done.messages.filter(message => message.id === input.requestId).length, 1);
  assert.equal(done.messages.find(message => message.id === input.requestId).content, input.content);
  assert.equal(done.messages.find(message => message.id === second.requestId).content, second.content);
  const duplicateAfterCompletion = await f.request(f.route + '/messages', input);
  assert.equal(duplicateAfterCompletion.status, 202); assert.equal(duplicateAfterCompletion.data.duplicate, true); assert.equal(f.calls(), 2);
});

test('HTTP interrupt keeps accepted input and starts a new run after aborting the blocked mock request', async t => {
  const f = await fixture(t), input = { ...f.input('Replacement direction'), mode: 'interrupt' };
  assert.equal((await f.request(f.route + '/messages', input)).status, 202);
  const done = await f.finished(); assert.notEqual(done.run.id, f.started.run.id); assert.equal(done.run.status, 'completed');
  assert.equal(done.queuedInputs[0].status, 'consumed'); assert.equal(f.calls(), 2);
  const history = await f.request(f.route + '/runs'); assert.equal(history.status, 200);
  assert.equal(history.data.runs.some(run => run.id === f.started.run.id && run.status === 'cancelled'), true);
});
