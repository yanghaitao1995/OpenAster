// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const time = '2026-10-28T00:00:00.000Z';
const provider = id => ({ id, name: id, type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true, toolMode: 'none' });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-branch-http-'));
  const store = new Store(root); for (const id of ['source-provider', 'selected', 'unrelated']) store.putProvider(provider(id));
  const source = store.createSession({ title: '原任务', providerId: 'source-provider' });
  source.messages = [{ id: 'source-user', role: 'user', content: '原问题', createdAt: time }, { id: 'source-answer', role: 'assistant', content: '原答案', createdAt: time }]; store.putSession(source); store.close();
  let calls = 0; const app = await startServer({ dataDir: root, port: 0, runtimeOptions: { providerCall: async () => { calls++; return { content: '新答案', toolCalls: [] }; }, ...options } });
  t.after(async () => { await app.close(); const canonical = await fs.realpath(root); assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-branch-http-[a-zA-Z0-9]+$/u); await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const response = await fetch(app.url + '/api/bootstrap'), cookie = response.headers.get('set-cookie').split(';')[0], boot = await response.json();
  assert.equal(boot.capabilities.conversationBranch, 1);
  async function request(route, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(app.url + route, { method, signal: AbortSignal.timeout(10000), headers: { ...(auth ? { cookie, 'X-CSRF-Token': boot.csrfToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(res.headers.get('cache-control'), 'no-store'); return { status: res.status, ...await res.json() };
  }
  const base = `/api/sessions/${source.id}`;
  const preview = () => request(base + '/branch-preview?messageId=source-user');
  const input = async () => ({ messageId: 'source-user', expectedPrefixHash: (await preview()).source.prefixHash, mode: 'prefix', content: '编辑问题', providerId: 'selected', skillId: 'general' });
  return { root, app, source, base, request, preview, input, calls: () => calls };
}
async function terminal(f, id) { const deadline = performance.now() + 5000; while (performance.now() < deadline) { const { session } = await f.request(`/api/sessions/${id}`); if (session?.run?.finishedAt) return session; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Branch HTTP fixture timed out'); }

test('branch routes enforce authentication, origin, exact query/body shape and user-message ownership', async t => {
  const f = await fixture(t), valid = await f.input();
  assert.equal((await f.request(f.base + '/branch-preview?messageId=source-user', { auth: false })).status, 401);
  assert.equal((await f.request(f.base + '/branches', { method: 'POST', body: valid, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.request(f.base + '/branches', { method: 'POST', body: valid, headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  for (const query of ['', '?messageId=source-user&messageId=source-user', '?messageId=source-user&extra=1', '?messageId=%FF', '?messageId=', '?messageId=source-user+']) assert.equal((await f.request(f.base + '/branch-preview' + query)).error.code, 'INVALID_BRANCH_QUERY');
  assert.equal((await f.request(f.base + '/branch-preview?messageId=source-answer')).error.code, 'BRANCH_MESSAGE_NOT_FOUND');
  for (const extra of [{ files: [] }, { history: [] }, { mode: 'auto' }, { expectedPrefixHash: null }, { providerId: null }, { skillId: null }, { content: '\ud800' }]) assert.equal((await f.request(f.base + '/branches', { method: 'POST', body: { ...valid, ...extra } })).error.code, 'INVALID_BRANCH_REQUEST');
  assert.equal((await f.request(f.base + '/branches?extra=1', { method: 'POST', body: valid })).error.code, 'INVALID_BRANCH_QUERY');
  assert.equal((await f.request('/api/state')).sessions.length, 1); assert.equal(f.calls(), 0);
});

test('title changes invalidate preview and disabled/missing connections never create empty branches', async t => {
  const f = await fixture(t), input = await f.input();
  await f.request(f.base, { method: 'PATCH', body: { title: '已修改标题' } });
  assert.equal((await f.request(f.base + '/branches', { method: 'POST', body: input })).error.code, 'BRANCH_SOURCE_CHANGED');
  const refreshed = await f.input();
  await f.request('/api/providers/selected', { method: 'PATCH', body: { enabled: false } });
  assert.equal((await f.request(f.base + '/branches', { method: 'POST', body: refreshed })).error.code, 'PROVIDER_DISABLED');
  assert.equal((await f.request(f.base + '/branches', { method: 'POST', body: { ...refreshed, providerId: 'absent' } })).error.code, 'PROVIDER_NOT_FOUND');
  assert.equal((await f.request('/api/state')).sessions.length, 1); assert.equal(f.calls(), 0);
});

test('branch preflight locks its source and both related connections while unrelated work remains available', async t => {
  const entered = gate(), release = gate(); let hold = true;
  const f = await fixture(t, { providers: async id => { if (hold) { entered.resolve(); await release.promise; } return provider(id); } });
  const before = (await f.request(f.base)).session, input = await f.input();
  const pending = f.request(f.base + '/branches', { method: 'POST', body: input }); await entered.promise;
  try {
    for (const action of [{ method: 'PATCH', body: { title: 'must not change' } }, { method: 'DELETE' }]) assert.equal((await f.request(f.base, action)).error.code, 'BRANCH_SOURCE_BUSY');
    assert.equal((await f.request(f.base + '/messages', { method: 'POST', body: { content: 'must not append' } })).error.code, 'BRANCH_SOURCE_BUSY');
    assert.equal((await f.preview()).error.code, 'BRANCH_SOURCE_BUSY');
    for (const id of ['selected', 'source-provider']) for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request(`/api/providers/${id}`, { method, ...(method === 'PATCH' ? { body: { name: 'must not change' } } : {}) })).status, 409);
    assert.equal((await f.request('/api/providers/unrelated', { method: 'PATCH', body: { name: 'permitted' } })).status, 200);
    await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  } finally { hold = false; release.resolve(); }
  const created = await pending; assert.equal(created.status, 201); await terminal(f, created.session.id);
  assert.deepEqual((await f.request(f.base)).session, before);
  assert.equal((await f.request(f.base, { method: 'PATCH', body: { title: 'allowed after release' } })).status, 200);
});

test('preflight failure releases source/provider locks and an active source cannot be previewed or branched', async t => {
  const entered = gate(), release = gate(); let shouldFail = true;
  const f = await fixture(t, { providers: async id => { entered.resolve(); await release.promise; if (shouldFail) throw new Error('fixture failure'); return provider(id); } });
  const input = await f.input(), pending = f.request(f.base + '/branches', { method: 'POST', body: input }); await entered.promise; release.resolve();
  assert.equal((await pending).status, 500); assert.equal((await f.request('/api/state')).sessions.length, 1);
  assert.equal((await f.request('/api/providers/selected', { method: 'PATCH', body: { name: 'allowed' } })).status, 200); assert.equal((await f.preview()).status, 200);
  shouldFail = false;
  // Gate the provider of a second isolated server while runtime.start has reserved
  // the source but has not persisted a running status yet.
  const gateIn = gate(), gateOut = gate(); const g = await fixture(t, { providers: async id => { gateIn.resolve(); await gateOut.promise; return provider(id); } });
  const gInput = await g.input(), starting = g.request(g.base + '/messages', { method: 'POST', body: { content: '开始新运行' } }); await gateIn.promise;
  try { assert.equal((await g.preview()).error.code, 'RUN_ACTIVE'); assert.equal((await g.request(g.base + '/branches', { method: 'POST', body: gInput })).error.code, 'RUN_ACTIVE'); }
  finally { gateOut.resolve(); }
  assert.equal((await starting).status, 202);
});
