// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.mjs';

async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-command-policy-http-'));
  const original = await fs.lstat(root, { bigint: true }), dataDir = path.join(root, 'data');
  let app, headers;
  async function open() {
    app = await startServer({ dataDir, port: 0 });
    const response = await fetch(app.url + '/api/bootstrap'), bootstrap = await response.json();
    headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': bootstrap.csrfToken, 'content-type': 'application/json' };
    return bootstrap;
  }
  const bootstrap = await open();
  t.after(async () => { await app.close(); const current = await fs.lstat(root, { bigint: true }); assert.equal(path.dirname(await fs.realpath(root)), parent); assert.equal(current.dev, original.dev); assert.equal(current.ino, original.ino); await fs.rm(root, { recursive: true }); });
  async function request(route, input, method = input === undefined ? 'GET' : 'POST', extra = {}) {
    const response = await fetch(app.url + route, { method, headers: { ...headers, ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, value: await response.json() };
  }
  const session = (await request('/api/sessions', {})).value.session;
  return { bootstrap, session, request, reopen: async () => { await app.close(); return open(); } };
}

test('policy HTTP route is explicit, authenticated, CSRF protected and strict about scope', async t => {
  const f = await fixture(t), route = `/api/sessions/${f.session.id}/command-policy`;
  assert.equal(f.bootstrap.capabilities.commandPolicy, 1);
  assert.equal((await f.request(route)).value.mode, 'smart');
  assert.equal((await f.request(route, { mode: 'trusted' }, 'PUT')).status, 400);
  assert.equal((await f.request(route, { mode: 'trusted', confirmRisk: true }, 'PUT', { 'x-csrf-token': 'invalid' })).status, 403);
  assert.equal((await f.request(route, { mode: 'trusted', confirmRisk: true }, 'PUT', { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.request(route, { mode: 'trusted', confirmRisk: true, paths: ['*'] }, 'PUT')).status, 400);
  assert.equal((await f.request(route + '?scope=all')).status, 400);
  assert.equal((await f.request(route)).value.mode, 'smart');
  const trusted = await f.request(route, { mode: 'trusted', confirmRisk: true }, 'PUT');
  assert.equal(trusted.status, 200); assert.equal(trusted.value.mode, 'trusted');
  assert.equal(trusted.value.lifetime, 'task-run'); assert.equal(trusted.value.sandbox, false); assert.equal(trusted.value.runId, null);
  assert.equal((await f.request(route, { mode: 'smart' }, 'PUT')).value.mode, 'smart');
});

test('task permission does not cross sessions or survive service restart or file-scope change', async t => {
  const f = await fixture(t), route = `/api/sessions/${f.session.id}/command-policy`;
  const other = (await f.request('/api/sessions', {})).value.session;
  await f.request(route, { mode: 'trusted', confirmRisk: true }, 'PUT');
  assert.equal((await f.request(`/api/sessions/${other.id}/command-policy`)).value.mode, 'smart');
  assert.equal((await f.request(`/api/sessions/${f.session.id}`)).value.session.commandPolicy, undefined);
  await f.reopen(); assert.equal((await f.request(route)).value.mode, 'smart');
  await f.request(route, { mode: 'trusted', confirmRisk: true }, 'PUT');
  const changed = await f.request('/api/permissions', { fileAccess: 'workspace' }, 'PUT');
  assert.equal(changed.status, 200); assert.equal((await f.request(route)).value.mode, 'smart');
});

test('approval scope cannot grant permissions without an existing eligible pending command', async t => {
  const f = await fixture(t), route = `/api/sessions/${f.session.id}/command-policy`;
  assert.equal((await f.request('/api/approvals/not-a-pending-command', { decision: 'approve', scope: 'session' })).status, 400);
  assert.equal((await f.request('/api/approvals/not-a-pending-command', { decision: 'approve', scope: 'session', confirmRisk: true })).status, 409);
  assert.equal((await f.request(route)).value.mode, 'smart');
  await f.request(`/api/sessions/${f.session.id}`, undefined, 'DELETE');
  assert.equal((await f.request(route)).status, 404);
});
