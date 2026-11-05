// SPDX-License-Identifier: Apache-2.0
// Real loopback HTTP with the public gateway Host/Origin contract. This does not
// claim TLS certificate, reverse-proxy, Android, or browser recovery validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';

test('gateway restart preserves Bearer reads but rejects stale CSRF until a new authenticated bootstrap', { timeout: 30000 }, async t => {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-gateway-restart-'));
  const identity = await fs.lstat(root, { bigint: true }), owner = randomUUID();
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  const gatewayOrigin = 'https://agent.example.test', clientOrigin = 'https://localhost';
  const token = randomBytes(32).toString('hex'), dataDir = path.join(root, 'data');
  const clients = new Set();
  let app;
  t.after(async () => {
    for (const client of clients) client.destroy();
    await app?.close();
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^openaster-gateway-restart-[A-Za-z0-9]+$/u);
    assert.equal(current.isSymbolicLink(), false);
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const options = { dataDir, gatewayOrigin, token, allowedOrigins: [clientOrigin] };
  app = await startServer(options);
  const originalUrl = app.url, port = Number(new URL(originalUrl).port);
  function request(endpoint, { method = 'GET', data, csrf, bearer = token } = {}) {
    const payload = data === undefined ? undefined : JSON.stringify(data);
    const headers = {
      Host: new URL(gatewayOrigin).host, Origin: clientOrigin, Connection: 'close',
      ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
      ...(csrf === undefined ? {} : { 'X-CSRF-Token': csrf }),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
    };
    return new Promise((resolve, reject) => {
      const req = http.request(app.url + endpoint, { method, headers, agent: false });
      clients.add(req); req.once('close', () => clients.delete(req));
      req.setTimeout(5000, () => req.destroy(new Error('Owned HTTP request timed out')));
      req.once('error', reject);
      req.once('response', res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () => {
          try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
      });
      req.end(payload);
    });
  }
  function events() {
    return new Promise((resolve, reject) => {
      const req = http.get(app.url + '/api/events', { agent: false, headers: {
        Host: new URL(gatewayOrigin).host, Origin: clientOrigin, Authorization: `Bearer ${token}`,
      } });
      clients.add(req); req.once('close', () => clients.delete(req));
      req.once('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Owned SSE response timed out')));
      req.once('response', res => {
        let wire = '', ended = false;
        const done = new Promise(resolveEnd => res.once('end', () => { ended = true; resolveEnd(res.complete); }));
        res.setEncoding('utf8'); res.once('error', reject);
        res.on('data', chunk => {
          wire += chunk;
          if (!wire.includes('\n\n')) return;
          req.setTimeout(0);
          resolve({ status: res.statusCode, headers: res.headers, done, get wire() { return wire; }, get ended() { return ended; } });
        });
      });
    });
  }

  const first = await request('/api/bootstrap');
  assert.equal(first.status, 200);
  assert.equal(first.headers['access-control-allow-origin'], clientOrigin);
  assert.equal(first.headers['set-cookie'], undefined);
  const oldCsrf = first.data.csrfToken;
  assert.match(oldCsrf, /^[a-f0-9]{64}$/u);
  const created = await request('/api/sessions', { method: 'POST', csrf: oldCsrf, data: { title: '原有任务', providerId: 'demo' } });
  assert.equal(created.status, 201);
  const id = created.data.session.id;
  const firstStream = await events();
  assert.equal(firstStream.status, 200);
  assert.match(firstStream.headers['content-type'], /^text\/event-stream\b/u);
  assert.match(firstStream.wire, /event: state\ndata: \{\}/u);

  await app.close();
  assert.equal(await firstStream.done, true);
  assert.equal(firstStream.ended, true);
  app = await startServer({ ...options, port });
  assert.equal(app.url, originalUrl, 'The backend address and configured public origin remain stable');
  const reconnected = await events();
  assert.equal(reconnected.status, 200);
  assert.match(reconnected.headers['content-type'], /^text\/event-stream\b/u);
  assert.equal(reconnected.headers['access-control-allow-origin'], clientOrigin);
  const state = await request('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.data.workspace.storageId, first.data.workspace.storageId);
  assert.equal(Object.hasOwn(state.data, 'csrfToken'), false, 'A state read alone cannot renew the old write credential');
  assert.deepEqual(state.data.sessions.map(session => session.id), [id]);

  for (const [endpoint, method, data] of [
    ['/api/sessions', 'POST', { title: '不应创建' }],
    [`/api/sessions/${id}`, 'PATCH', { title: '不应修改' }],
    [`/api/sessions/${id}/messages`, 'POST', { content: '不应执行模型任务', providerId: 'demo' }],
    [`/api/sessions/${id}`, 'DELETE', {}],
  ]) {
    const rejected = await request(endpoint, { method, data, csrf: oldCsrf });
    assert.equal(rejected.status, 403); assert.equal(rejected.data.error.code, 'CSRF');
  }
  const untouched = await request(`/api/sessions/${id}`);
  assert.equal(untouched.status, 200);
  assert.deepEqual(untouched.data.session, { ...created.data.session, queuedInputs: [] }, 'Rejected writes do not alter the task, run, messages, or approvals');
  assert.deepEqual((await request('/api/state')).data.sessions.map(session => session.id), [id]);
  t.diagnostic('Restart reproduced: same Bearer and workspace, SSE/state 200, old-CSRF writes 403 with no task side effects.');

  assert.equal((await request('/api/bootstrap', { bearer: null })).status, 401);
  assert.equal((await request('/api/bootstrap', { bearer: 'wrong-fixture-token' })).status, 401);
  const renewed = await request('/api/bootstrap');
  assert.equal(renewed.status, 200);
  const newCsrf = renewed.data.csrfToken;
  assert.match(newCsrf, /^[a-f0-9]{64}$/u); assert.notEqual(newCsrf, oldCsrf);
  assert.equal(renewed.data.workspace.storageId, first.data.workspace.storageId);
  assert.equal((await request('/api/bootstrap')).data.csrfToken, newCsrf);
  assert.equal((await request('/api/sessions', { method: 'POST', csrf: oldCsrf, data: {} })).status, 403, 'Renewing one client never makes its old CSRF valid again');
  assert.equal((await request('/api/state')).data.sessions.length, 1, 'Bootstrap does not replay a rejected operation');
  const explicit = await request('/api/sessions', { method: 'POST', csrf: newCsrf, data: { title: '重新认证后明确创建', providerId: 'demo' } });
  assert.equal(explicit.status, 201);
  const finalState = await request('/api/state');
  assert.equal(finalState.status, 200);
  assert.deepEqual(new Set(finalState.data.sessions.map(session => session.id)), new Set([id, explicit.data.session.id]));
  assert.deepEqual((await request(`/api/sessions/${id}`)).data.session, { ...created.data.session, queuedInputs: [] });
  t.diagnostic('A new authenticated bootstrap renews CSRF; exactly one explicit later POST succeeds. TLS/mobile/browser recovery is outside this test.');
});
