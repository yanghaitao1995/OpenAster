// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { CoreError } from '../core/errors.mjs';

const connection = { providerId: 'fixture', name: '历史连接', type: 'openai', model: 'model-one', toolMode: 'none' };
const counters = { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 3, cacheWriteInputTokens: null, reasoningOutputTokens: 1 };
async function directory(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-usage-http-'));
  t.after(async () => { const canonical = await fs.realpath(root); assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-usage-http-[a-zA-Z0-9]+$/); await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return root;
}
async function client(app) {
  const boot = await fetch(app.url + '/api/bootstrap');
  const cookie = boot.headers.get('set-cookie').split(';')[0], state = await boot.json();
  return { state, request: async (route, { method = 'GET', body, auth = true, headers = {} } = {}) => {
    const response = await fetch(app.url + route, { method, signal: AbortSignal.timeout(10000),
      headers: { ...(auth ? { cookie, 'X-CSRF-Token': state.csrfToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, ...await response.json() };
  } };
}
async function until(action, predicate) {
  for (let n = 0; n < 500; n++) { const value = await action(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Usage HTTP fixture timed out');
}

test('authenticated overview uses compact projections, exact grouping and strictly bounded query pagination', async t => {
  const root = await directory(t), seed = new Store(root), session = seed.createSession();
  for (let n = 0; n < 23; n++) seed.putRunHistory({ sessionId: session.id, run: { id: 'r' + n, status: 'completed', connection: { ...connection, model: 'm' + n }, steps: [{ type: 'model', detail: 'NEVER_EXPOSE_DETAIL'.repeat(20000), usage: counters }] }, approvals: [] });
  seed.close(); const app = await startServer({ dataDir: root }), { state, request } = await client(app);
  try {
    assert.equal(state.capabilities.usageOverview, 1); assert.equal((await request('/api/state')).capabilities.usageOverview, 1);
    assert.equal((await request('/api/usage', { auth: false })).status, 401);
    assert.equal((await request('/api/usage', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await request('/api/usage', { method: 'POST', body: {} })).status, 404);
    const getSession = Store.prototype.getSession, getRun = Store.prototype.getRunHistory, list = Store.prototype.listSessions;
    let first;
    try {
      Store.prototype.getSession = Store.prototype.getRunHistory = Store.prototype.listSessions = () => { throw new Error('No body reads'); };
      first = await request('/api/usage'); assert.equal(first.status, 200); assert.equal(first.groups.length, 20);
    } finally { Store.prototype.getSession = getSession; Store.prototype.getRunHistory = getRun; Store.prototype.listSessions = list; }
    assert.equal(first.summary.runs.total, 23); assert.equal(first.summary.tokens.totalTokens.knownSum, '276'); assert.equal(first.summary.stepsWithCompleteUsage, 23);
    assert.ok(!JSON.stringify(first).includes('NEVER_EXPOSE_DETAIL'));
    const page = await request('/api/usage?' + new URLSearchParams({ cursor: first.nextCursor })); assert.equal(page.status, 200); assert.equal(page.groups.length, 3); assert.equal(page.nextCursor, null);
    assert.equal(new Set([...first.groups, ...page.groups].map(group => group.key)).size, 23);
    for (const query of ['limit=0', 'limit=51', 'limit=01', 'limit=1.1', 'limit=', 'limit=2&limit=2', 'cursor=a&cursor=b', 'extra=x', 'limit=%FF', '%E0%A4=1']) {
      const response = await request('/api/usage?' + query); assert.equal(response.status, 400, query); assert.equal(response.error.code, 'INVALID_USAGE_QUERY', query);
    }
    for (const cursor of ['', 'a', 'x'.repeat(1025)]) assert.equal((await request('/api/usage?cursor=' + cursor)).error.code, 'INVALID_USAGE_CURSOR');
    assert.equal((await request(`/api/sessions/${session.id}`, { method: 'DELETE', body: {} })).status, 200);
    assert.equal((await request('/api/usage?cursor=' + first.nextCursor)).error.code, 'USAGE_SNAPSHOT_CHANGED');
    assert.equal((await request('/api/usage')).summary.runs.total, 0);
  } finally { await app.close(); }
});

test('real runtime failed/cancelled/active steps remain in overview and identity survives restart and connection removal', async t => {
  const root = await directory(t); let calls = 0;
  let app = await startServer({ dataDir: root, runtimeOptions: { limits: { streamCheckpointMs: 10 }, providerCall: async (_provider, { onText, signal }) => {
    calls++;
    if (calls === 1) return { content: '完成', toolCalls: [], usage: counters };
    if (calls === 2) { await onText('PRIVATE_FAILED_PARTIAL'); throw Object.assign(new CoreError('PROVIDER_HTTP_ERROR', '本机模拟永久请求错误', 400), { providerStatus: 400 }); }
    await onText('PRIVATE_ACTIVE_PARTIAL');
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  } } });
  let { request } = await client(app);
  try {
    const provider = (await request('/api/providers', { method: 'POST', body: { name: '原连接', type: 'openai', model: 'model-one', toolMode: 'none', baseUrl: 'https://fixture.invalid/v1', apiKey: 'SECRET_NEVER_IN_OVERVIEW' } })).provider;
    const session = (await request('/api/sessions', { method: 'POST', body: { providerId: provider.id } })).session, base = `/api/sessions/${session.id}`;
    for (let n = 0; n < 2; n++) {
      await request(base + '/messages', { method: 'POST', body: { content: '开始' } });
      const finished = await until(() => request(base), value => value.session.run.finishedAt);
      if (n === 1) {
        assert.equal(calls, 2, 'a permanent HTTP 400 must not retry the second request');
        assert.equal(finished.session.run.steps[0].connection.attempt, 1);
        assert.equal(finished.session.run.status, 'failed');
      }
    }
    await request(base + '/messages', { method: 'POST', body: { content: '等待取消' } });
    await until(() => request(base + '/output'), value => value.run?.output?.content === 'PRIVATE_ACTIVE_PARTIAL');
    let snapshot = await request('/api/usage');
    assert.equal(snapshot.summary.runs.total, 3); assert.equal(snapshot.summary.runs.running, 1); assert.equal(snapshot.summary.runs.failed, 1); assert.equal(snapshot.summary.modelSteps, 3);
    assert.equal(snapshot.summary.stepsWithoutUsage, 2); assert.equal(snapshot.summary.tokens.totalTokens.knownSum, '12');
    for (const hidden of ['SECRET_NEVER_IN_OVERVIEW', 'fixture.invalid', 'PRIVATE_FAILED_PARTIAL', 'PRIVATE_ACTIVE_PARTIAL', 'apiKey', 'baseUrl']) assert.ok(!JSON.stringify(snapshot).includes(hidden));
    await request(base + '/cancel', { method: 'POST', body: {} }); await until(() => request(base), value => value.session.run.finishedAt);
    snapshot = await request('/api/usage'); assert.equal(snapshot.summary.runs.cancelled, 1); assert.equal(snapshot.summary.runs.total, 3);
    await request(`/api/providers/${provider.id}`, { method: 'DELETE', body: {} });
    assert.deepEqual((await request('/api/usage')).groups, snapshot.groups);
    await app.close(); app = await startServer({ dataDir: root }); ({ request } = await client(app));
    assert.deepEqual((await request('/api/usage')).summary, snapshot.summary);
    assert.equal((await request(base)).session.providerId, 'demo');
  } finally { await app.close(); }
});
