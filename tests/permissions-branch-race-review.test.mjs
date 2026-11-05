// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../server/index.mjs';
import { createSkillRegistry } from '../core/skills.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) { for (let index = 0; index < 300; index++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Review fixture did not reach expected state'); }

test('permission changes are refused while a new branch is active but not yet durable', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-permission-race-'));
  const entered = gate(), released = gate(), registry = createSkillRegistry(); let hold = false;
  const app = await startServer({ dataDir: path.join(root, 'data'), runtimeOptions: { skillRegistry: { ...registry, async catalog(options) { if (hold) { entered.resolve(); await released.promise; } return registry.catalog(options); } } } });
  t.after(async () => { released.resolve(); await app.close(); assert.equal(path.dirname(await fs.realpath(root)), parent); await fs.rm(root, { recursive: true, force: true }); });
  const initial = await fetch(app.url + '/api/bootstrap'), bootstrap = await initial.json();
  const headers = { cookie: initial.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': bootstrap.csrfToken, 'Content-Type': 'application/json' };
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const response = await fetch(app.url + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  const created = await request('/api/sessions', { providerId: 'demo' }); const id = created.data.session.id;
  assert.equal((await request(`/api/sessions/${id}/messages`, { content: 'Hello', providerId: 'demo' })).status, 202);
  const finished = await until(async () => { const value = await request(`/api/sessions/${id}`); return value.data.session.run?.status === 'completed' && value.data.session; });
  const messageId = finished.messages[0].id;
  const preview = await request(`/api/sessions/${id}/branch-preview?messageId=${messageId}`); assert.equal(preview.status, 200);
  hold = true;
  const pending = request(`/api/sessions/${id}/branches`, { messageId, expectedPrefixHash: preview.data.source.prefixHash, mode: 'message', content: 'New branch', providerId: 'demo' });
  await entered.promise;
  const permission = await request('/api/permissions', { fileAccess: 'computer', confirmComputerAccess: true }, 'PUT');
  released.resolve(); assert.equal((await pending).status, 201);
  assert.equal(permission.status, 409, 'The newly reserved branch is an active task even before its session is persisted');
  assert.equal(permission.data.error.code, 'PERMISSION_BUSY');
});
