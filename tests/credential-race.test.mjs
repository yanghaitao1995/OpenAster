import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { startServer } from '../server/index.mjs';
import { createSecretStore } from '../desktop/secret-store.mjs';

test('a public credential read cannot re-encrypt an old key over an endpoint replacement', { timeout: 15000 }, async t => {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'openaster-credential-race-'));
  let armOldRead = false;
  let signalOldRead;
  let releaseOldRead;
  const oldReadEntered = new Promise(resolve => { signalOldRead = resolve; });
  const oldReadGate = new Promise(resolve => { releaseOldRead = resolve; });
  let app;
  let pendingState;
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ authorization: request.headers.authorization, path: request.url, payload: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }));
  });
  t.after(async () => {
    releaseOldRead();
    await pendingState?.catch(() => {});
    if (app) await app.close();
    if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
    const descendant = relative(temporaryRoot, resolve(directory));
    assert.ok(descendant && !isAbsolute(descendant) && !descendant.startsWith('..') && descendant.startsWith('openaster-credential-race-'), 'Cleanup remains within the dedicated temporary directory');
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

  // Exercise the real file-backed store and its shouldReEncrypt writeback.
  // Only the OS cryptography is simulated; these are deliberately dummy keys.
  const secretStore = createSecretStore({
    directory: join(directory, 'keys'), platform: 'win32',
    crypto: {
      async isAsyncEncryptionAvailable() { return true; },
      async encryptStringAsync(value) { return Buffer.from(value); },
      async decryptStringAsync(bytes) {
        const result = bytes.toString('utf8');
        if (armOldRead) {
          armOldRead = false;
          signalOldRead();
          await oldReadGate;
          return { result, shouldReEncrypt: true };
        }
        return { result, shouldReEncrypt: false };
      },
    },
  });
  app = await startServer({ dataDir: directory, secretStore });
  let cookie;
  let csrfToken;
  async function request(path, method = 'GET', data) {
    const response = await fetch(app.url + path, {
      method, signal: AbortSignal.timeout(5000),
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  const bootstrap = await request('/api/bootstrap');
  cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  csrfToken = bootstrap.data.csrfToken;
  const created = await request('/api/providers', 'POST', {
    name: 'Credential race regression', type: 'openai', model: 'fixture-model',
    baseUrl: 'https://old.example.invalid/v1', apiKey: 'dummy-OLD-key',
  });
  assert.equal(created.status, 201);
  const id = created.data.provider.id;

  // The public listing reads the old key before endpoint replacement begins.
  armOldRead = true;
  pendingState = request('/api/state');
  await oldReadEntered;
  const replacement = {
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'dummy-NEW-key',
  };
  const busy = await request(`/api/providers/${id}`, 'PATCH', replacement);
  assert.equal(busy.status, 409);
  assert.equal(busy.data.error.code, 'PROVIDER_BUSY');
  assert.deepEqual(received, []);

  releaseOldRead();
  const previousState = await pendingState;
  assert.equal(previousState.status, 200);
  const changed = await request(`/api/providers/${id}`, 'PATCH', replacement);
  assert.equal(changed.status, 200);
  assert.equal(changed.data.provider.id, id);
  assert.equal(changed.data.provider.baseUrl, replacement.baseUrl);
  assert.equal(changed.data.provider.hasKey, true);

  const checked = await request(`/api/providers/${id}/test`, 'POST', {});
  assert.equal(checked.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].path, '/v1/chat/completions');
  assert.equal(received[0].authorization, 'Bearer dummy-NEW-key');
  assert.equal(received[0].payload.model, 'fixture-model');
  assert.equal(await secretStore.get(id), 'dummy-NEW-key');
  const exported = await request('/api/export');
  assert.equal(exported.status, 200);
  assert.ok(!JSON.stringify(exported.data).includes('dummy-OLD-key'));
  assert.ok(!JSON.stringify(exported.data).includes('dummy-NEW-key'));
});
