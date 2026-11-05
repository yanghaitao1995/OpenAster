// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server/index.mjs';

const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(t, runtimeOptions = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-web-http-'));
  const identity = await fs.lstat(root, { bigint: true }); const services = [];
  t.after(async () => { for (const service of services) await service.close(); const current = await fs.lstat(root, { bigint: true });
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), parent); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.equal(current.isSymbolicLink(), false); await fs.rm(root, { recursive: true, maxRetries: 5 }); });
  async function start(name = 'data') {
    const service = await startServer({ dataDir: path.join(root, name), port: 0, runtimeOptions }); services.push(service);
    const first = await fetch(service.url + '/api/bootstrap'), bootstrap = await first.json();
    const headers = { cookie: first.headers.get('set-cookie').split(';')[0], 'x-csrf-token': bootstrap.csrfToken, 'content-type': 'application/json' };
    const request = async (route, body, extra = {}) => {
      const response = await fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() };
    };
    return { service, bootstrap, request };
  }
  return { start, ...await start() };
}
async function until(check) { const end = Date.now() + 8000; while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Web HTTP fixture timed out'); }

test('web consent requires authentication and CSRF, accepts only the explicit boolean and expires per service', async t => {
  const f = await fixture(t);
  assert.equal(f.bootstrap.capabilities.webTools, 1); assert.equal(f.bootstrap.security.webAccess, false); assert.equal(f.bootstrap.security.webSearchProvider, 'duckduckgo');
  assert.equal((await f.request('/api/security/web-access', { enabled: true }, { cookie: '' })).status, 401);
  assert.equal((await f.request('/api/security/web-access', { enabled: true }, { 'x-csrf-token': 'wrong' })).status, 403);
  for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }, { enabled: true, scope: 'forever' }]) assert.equal((await f.request('/api/security/web-access', body)).status, 400);
  assert.equal((await f.request('/api/security/web-access?enabled=true', { enabled: true })).status, 400);
  const enabled = await f.request('/api/security/web-access', { enabled: true }); assert.equal(enabled.status, 200); assert.equal(enabled.data.lifetime, 'service-session');
  const state = (await f.request('/api/state')).data; assert.equal(state.security.webAccess, true); assert.equal(state.security.fileAccess, 'workspace');
  const other = await f.start('other-project'); assert.equal(other.bootstrap.security.webAccess, false);
  assert.ok((await f.request('/api/audit')).data.entries.some(value => value.action === 'permissions.web.changed'));
  await f.service.close(); const reopened = await f.start(); assert.equal(reopened.bootstrap.security.webAccess, false);
});

test('authenticated revocation during a task cancels web transport and still returns the model explanation', async t => {
  const entered = gate(); let signal, calls = 0;
  const f = await fixture(t, { webTools: { read: async (_args, options) => { signal = options.signal; entered.release(); return new Promise(() => {}); } },
    providerCall: async (_provider, request) => {
      calls++; if (calls === 1) return { content: '', toolCalls: [{ id: 'page', name: 'read_webpage', args: { url: 'https://example.com/' } }] };
      assert.equal(request.tools.some(tool => tool.name === 'read_webpage'), false);
      assert.equal(JSON.parse(request.messages.find(message => message.role === 'tool').content).error.code, 'WEB_ACCESS_DISABLED');
      return { content: '联网已关闭，本轮解释仍然保留。', toolCalls: [] };
    } });
  const provider = (await f.request('/api/providers', { name: 'Mock web tool', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', streaming: false })).data.provider;
  const session = (await f.request('/api/sessions', { providerId: provider.id })).data.session;
  assert.equal((await f.request('/api/security/web-access', { enabled: true })).status, 200);
  assert.equal((await f.request(`/api/sessions/${session.id}/messages`, { content: 'Read public documentation.' })).status, 202);
  await entered.promise; assert.equal((await f.request('/api/security/web-access', { enabled: false })).status, 200);
  assert.equal(signal.aborted, true);
  const completed = await until(async () => { const value = (await f.request(`/api/sessions/${session.id}`)).data.session; return ['completed', 'failed', 'cancelled'].includes(value.run?.status) ? value : null; });
  assert.equal(completed.run.status, 'completed'); assert.equal(calls, 2); assert.match(completed.messages.at(-1).content, /解释仍然保留/u);
  assert.equal(completed.run.steps.find(step => step.toolResultRef).toolResultRef.isError, true);
});

test('paired remote clients can grant host web access only with valid bearer, origin and CSRF', async t => {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-web-gateway-'));
  const identity = await fs.lstat(root, { bigint: true }), token = randomBytes(32).toString('hex');
  const service = await startServer({ dataDir: path.join(root, 'data'), port: 0, gatewayOrigin: 'https://agent.example.test', token, allowedOrigins: ['https://localhost'] });
  t.after(async () => { await service.close(); const current = await fs.lstat(root, { bigint: true });
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), parent); assert.equal(current.ino, identity.ino); assert.equal(current.dev, identity.dev);
    assert.equal(current.isSymbolicLink(), false); await fs.rm(root, { recursive: true, maxRetries: 5 }); });
  const request = (route, { body, csrf, auth = true, origin = 'https://localhost' } = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(service.url + route, { method: body === undefined ? 'GET' : 'POST', agent: false, headers: {
      Host: 'agent.example.test', Origin: origin, ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }),
    } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject); res.once('end', () => {
      try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); }
    }); });
    req.setTimeout(5000, () => req.destroy(new Error('Owned gateway request timed out'))); req.once('error', reject); req.end(bytes);
  });
  const bootstrap = await request('/api/bootstrap'); assert.equal(bootstrap.status, 200); assert.equal(bootstrap.data.security.webAccess, false);
  const body = { enabled: true }, csrf = bootstrap.data.csrfToken;
  assert.equal((await request('/api/security/web-access', { body, csrf, auth: false })).status, 401);
  assert.equal((await request('/api/security/web-access', { body, csrf: 'invalid' })).status, 403);
  assert.equal((await request('/api/security/web-access', { body, csrf, origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/security/web-access', { body, csrf })).status, 200);
  const state = (await request('/api/state')).data; assert.equal(state.security.webAccess, true); assert.equal(state.security.fileAccess, 'workspace');
});
