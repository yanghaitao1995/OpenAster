// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { acquireDataLock } from '../server/lock.mjs';
import http from 'node:http';

const time = '2026-10-29T00:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const connection = id => ({ id, name: id, type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true, toolMode: 'workspace' });
const reply = content => ({ content, toolCalls: [], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });

async function fixture(t, { seed, providerCall, secretStore, timeoutMs } = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-summary-http-'));
  const store = new Store(root); store.putProvider(connection('selected')); store.putProvider(connection('unrelated'));
  const source = store.createSession({ title: '需要交接的工作', providerId: 'demo' });
  source.messages = [{ id: 'user-source', role: 'user', content: '保留全部原始目标', createdAt: time,
    contextFiles: [{ path: 'old.txt', content: '历史附件原文', sha256: hash('历史附件原文') }] },
  { id: 'assistant-source', role: 'assistant', content: '待核实的历史答复', createdAt: time }];
  seed?.(source); store.putSession(source); store.close();
  let app, cookie, csrf; const calls = [];
  async function start() {
    app = await startServer({ dataDir: root, port: 0, ...(secretStore ? { secretStore } : {}), summaryDraftOptions: {
      ...(timeoutMs ? { timeoutMs } : {}), providerCall: async (provider, options) => {
        calls.push(structuredClone({ provider, messages: options.messages, tools: options.tools, system: options.system }));
        return providerCall ? providerCall(provider, options, calls.length) : reply('目标：保留已确认约束。下一步：核实历史答复。');
      },
    } });
    const response = await fetch(app.url + '/api/bootstrap'); cookie = response.headers.get('set-cookie').split(';')[0];
    const boot = await response.json(); csrf = boot.csrfToken; assert.equal(boot.capabilities.handoffDraft, 1);
  }
  t.after(async () => { if (app) await app.close(); const canonical = await fs.realpath(root); assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-summary-http-[a-zA-Z0-9]+$/u); await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await start();
  async function request(route, { method = 'GET', body, raw, auth = true, headers = {} } = {}) {
    const response = await fetch(app.url + route, { method, signal: AbortSignal.timeout(10000),
      headers: { ...(auth ? { cookie, 'X-CSRF-Token': csrf } : {}), ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, ...await response.json() };
  }
  const base = `/api/sessions/${source.id}`;
  async function preview() { const handoff = await request(base + '/handoff-preview'); return request(base + '/summary-preview', { method: 'POST', body: { providerId: 'selected', expectedSourceHash: handoff.source.hash } }); }
  async function input() { const plan = await preview(); assert.equal(plan.status, 200); return { requestId: randomUUID(), providerId: 'selected', expectedSourceHash: plan.source.hash, expectedPlanHash: plan.planHash }; }
  return { root, source, base, calls, request, preview, input, get app() { return app; }, get headers() { return { cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }; }, async restart() { await app.close(); await start(); } };
}
const submit = (f, body) => f.request(f.base + '/summary-drafts', { method: 'POST', body });
async function terminal(f, id) {
  const end = performance.now() + 5000;
  while (performance.now() < end) { const result = await f.request(f.base + '/summary-drafts/' + id); assert.equal(result.status, 200); if (result.draft.status !== 'running') return result.draft; await delay(5); }
  throw new Error('Summary fixture did not settle');
}

test('summary preview has no model calls and routes enforce authentication, strict bodies and provenance', async t => {
  const f = await fixture(t), plan = await f.preview(), input = await f.input();
  assert.equal(plan.source.messageCount, 2); assert.equal(plan.files.count, 1); assert.equal(plan.partCount, 1); assert.equal(plan.maxRequests, 1);
  for (const content of ['保留全部原始目标', '历史附件原文', '待核实的历史答复']) assert.ok(!JSON.stringify(plan).includes(content));
  assert.equal((await f.request(f.base + '/summary-drafts/latest')).draft, null); assert.equal(f.calls.length, 0);
  assert.equal((await f.request(f.base + '/summary-drafts/latest', { auth: false })).status, 401);
  assert.equal((await f.request(f.base + '/summary-drafts', { method: 'POST', body: input, headers: { 'X-CSRF-Token': 'bad' } })).status, 403);
  assert.equal((await f.request(f.base + '/summary-drafts', { method: 'POST', body: input, headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  for (const extra of [{ requestId: 'latest' }, { files: [] }, { prompt: 'override' }, { expectedPlanHash: '' }, { providerId: null }, { expectedSourceHash: 'g'.repeat(64) }]) assert.equal((await submit(f, { ...input, ...extra })).status, 400);
  assert.equal((await f.request(f.base + '/summary-drafts', { method: 'POST', raw: Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]) })).error.code, 'INVALID_JSON');
  assert.equal((await f.request(f.base + '/summary-drafts', { method: 'POST', raw: ' '.repeat(8193) })).status, 413);
  assert.equal((await f.request(f.base + '/summary-drafts/latest?unexpected=1')).error.code, 'INVALID_SUMMARY_QUERY');
  assert.equal((await submit(f, { ...input, expectedPlanHash: 'a'.repeat(64) })).error.code, 'SUMMARY_PLAN_CHANGED');
  await f.request(f.base, { method: 'PATCH', body: { title: '源已变化' } });
  assert.equal((await submit(f, input)).error.code, 'HANDOFF_SOURCE_CHANGED'); assert.equal(f.calls.length, 0);
  assert.equal((await f.request(f.base + '/summary-drafts/latest')).draft, null);
});

test('generated draft preserves the entire source, performs no tools and accounts for known usage without creating a continuation', async t => {
  const f = await fixture(t), before = (await f.request(f.base)).session, input = await f.input();
  await fs.writeFile(path.join(f.root, 'workspace', 'old.txt'), '当前磁盘正文不能自动读取');
  const started = await submit(f, input); assert.equal(started.status, 201); const draft = await terminal(f, input.requestId);
  assert.equal(draft.status, 'completed'); assert.equal(draft.steps.length, 1); assert.equal(draft.steps[0].usage.totalTokens, 5); assert.equal(draft.summaryHash, hash(draft.summary));
  assert.deepEqual((await f.request(f.base)).session, before); assert.equal((await f.request('/api/state')).sessions.length, 1);
  assert.equal(await fs.readFile(path.join(f.root, 'workspace', 'old.txt'), 'utf8'), '当前磁盘正文不能自动读取');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].provider.toolMode, 'none'); assert.deepEqual(f.calls[0].tools, []);
  const wire = JSON.stringify(f.calls); for (const content of ['保留全部原始目标', '历史附件原文', '待核实的历史答复']) assert.ok(wire.includes(content));
  assert.ok(!wire.includes('当前磁盘正文不能自动读取'));
  const exported = await f.request('/api/export'); assert.deepEqual(exported.summaryJobs, [draft]); assert.deepEqual(exported.runHistory, []);
  const usage = await f.request('/api/usage'); assert.equal(usage.summary.tokens.totalTokens.knownSum, '5');
  assert.equal((await f.request(f.base + '/summary-drafts/latest')).draft.id, input.requestId);
});

test('same summary ID recovers the saved operation across response loss, restart and provider deletion without model replay', async t => {
  const release = gate(), entered = gate();
  const f = await fixture(t, { providerCall: async () => { entered.resolve(); await release.promise; return reply('完整摘要'); } });
  const input = await f.input();
  try {
    assert.equal((await submit(f, input)).status, 201); await entered.promise;
    const replay = await submit(f, input); assert.equal(replay.status, 200); assert.equal(replay.draft.status, 'running'); assert.equal(f.calls.length, 1);
    assert.equal((await submit(f, { ...input, expectedPlanHash: 'a'.repeat(64) })).error.code, 'SUMMARY_JOB_ID_CONFLICT');
    assert.equal((await f.request(f.base + '/handoff-preview')).status, 200);
  } finally { release.resolve(); }
  const finished = await terminal(f, input.requestId); assert.equal(finished.status, 'completed');
  assert.equal((await f.request('/api/providers/selected', { method: 'DELETE' })).status, 200);
  await f.restart(); const replay = await submit(f, input); assert.equal(replay.status, 200); assert.deepEqual(replay.draft, finished); assert.equal(f.calls.length, 1);
  assert.equal((await f.request(f.base, { method: 'DELETE' })).status, 200);
  assert.equal((await f.request(f.base + '/summary-drafts/' + input.requestId)).status, 404);
  assert.equal((await submit(f, input)).error.code, 'SESSION_NOT_FOUND'); assert.equal(f.calls.length, 1);
});

test('persisted receipt and source/provider ownership precede credential reads and cancellation waits for real settlement', async t => {
  const entered = gate(), release = gate(); let holding = false;
  const f = await fixture(t, { secretStore: { get: async id => { if (holding && id === 'selected') { entered.resolve(); await release.promise; } return undefined; }, set() {}, delete() {} } });
  const input = await f.input(); holding = true;
  try {
    const start = await submit(f, input); assert.equal(start.status, 201); await entered.promise;
    assert.equal((await f.request(f.base + '/summary-drafts/' + input.requestId)).draft.status, 'running'); assert.equal(f.calls.length, 0);
    for (const operation of [{ method: 'PATCH', body: { title: 'blocked' } }, { method: 'DELETE' }]) assert.equal((await f.request(f.base, operation)).error.code, 'SUMMARY_SOURCE_BUSY');
    assert.equal((await f.request(f.base + '/messages', { method: 'POST', body: { content: 'blocked' } })).error.code, 'SUMMARY_SOURCE_BUSY');
    for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request('/api/providers/selected', { method, ...(method === 'PATCH' ? { body: { name: 'blocked' } } : {}) })).error.code, 'PROVIDER_BUSY');
    assert.equal((await f.request(f.base + '/summary-drafts/' + input.requestId + '/cancel', { method: 'POST', body: {} })).cancelRequested, true);
    await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
    const stop = f.app.close(); let stopped = false; stop.then(() => { stopped = true; }); await delay(10); assert.equal(stopped, false);
    await assert.rejects(acquireDataLock(f.root), { code: 'DATA_LOCKED' });
    holding = false; release.resolve(); await stop;
  } finally { holding = false; release.resolve(); }
  await f.restart(); const draft = (await f.request(f.base + '/summary-drafts/' + input.requestId)).draft;
  assert.equal(draft.status, 'cancelled'); assert.equal(draft.steps.length, 0); assert.equal(f.calls.length, 0);
  assert.equal((await submit(f, input)).status, 200); assert.equal(f.calls.length, 0);
});

test('cancellation preserves late returned usage, never applies partial output and never releases a still-running request slot', async t => {
  const entered = gate(), release = gate();
  const f = await fixture(t, { providerCall: async () => { entered.resolve(); await release.promise; return reply('取消后迟到的正文'); } });
  const input = await f.input();
  try {
    assert.equal((await submit(f, input)).status, 201); await entered.promise;
    const cancelled = await f.request(f.base + '/summary-drafts/' + input.requestId + '/cancel', { method: 'POST', body: {} }); assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.draft.status, 'running'); assert.equal((await f.request(f.base, { method: 'DELETE' })).error.code, 'SUMMARY_SOURCE_BUSY');
    assert.equal((await submit(f, input)).status, 200); assert.equal(f.calls.length, 1);
  } finally { release.resolve(); }
  const draft = await terminal(f, input.requestId); assert.equal(draft.status, 'cancelled'); assert.equal(draft.summary, null); assert.equal(draft.steps[0].usage.totalTokens, 5);
  assert.equal(draft.steps[0].output, null); assert.equal((await f.request('/api/usage')).summary.tokens.totalTokens.knownSum, '5');
  assert.equal((await f.request(f.base, { method: 'PATCH', body: { title: '锁已释放' } })).status, 200);
});

test('model tools or malformed summaries fail with usage retained and no filesystem or continuation side effects', async t => {
  const f = await fixture(t, { providerCall: async () => ({ ...reply('不应接受'), toolCalls: [{ id: 'write', name: 'write_file', args: { path: 'secret.txt', content: 'bad' } }] }) });
  const input = await f.input(); assert.equal((await submit(f, input)).status, 201); const draft = await terminal(f, input.requestId);
  assert.equal(draft.status, 'failed'); assert.equal(draft.error.code, 'SUMMARY_TOOLS_DISABLED'); assert.equal(draft.summary, null); assert.equal(draft.steps[0].usage.totalTokens, 5);
  await assert.rejects(fs.stat(path.join(f.root, 'workspace', 'secret.txt')), { code: 'ENOENT' });
  assert.equal((await f.request('/api/state')).sessions.length, 1); assert.equal((await submit(f, input)).status, 200); assert.equal(f.calls.length, 1);
});

test('complete large source is planned in multiple requests and provider changes invalidate an unconfirmed plan', async t => {
  const f = await fixture(t, { seed: source => { source.messages = Array.from({ length: 12 }, (_, i) => ({ id: 'long-' + i, role: i % 2 ? 'assistant' : 'user', content: '完整保留' + 'x'.repeat(200000), createdAt: time })); } });
  const before = (await f.request(f.base)).session, input = await f.input(), preview = await f.preview();
  assert.ok(preview.sourceBytes > 2 * 1024 * 1024); assert.equal(preview.maxRequests, preview.partCount + 1);
  await f.request('/api/providers/selected', { method: 'PATCH', body: { maxTokens: 2048 } });
  assert.equal((await submit(f, input)).error.code, 'SUMMARY_PLAN_CHANGED'); assert.equal(f.calls.length, 0);
  const fresh = await f.input(); assert.equal((await submit(f, fresh)).status, 201); const draft = await terminal(f, fresh.requestId);
  assert.equal(draft.status, 'completed'); assert.equal(f.calls.length, preview.maxRequests);
  assert.deepEqual((await f.request(f.base)).session, before); assert.equal(draft.steps.length, preview.maxRequests);
  assert.equal(draft.steps.at(-1).stage, 'final'); assert.equal((await f.request('/api/state')).sessions.length, 1);
});

test('credential failures leave a queryable receipt and never disclose raw errors or retry a model request', async t => {
  let failing = false;
  const f = await fixture(t, { secretStore: { get() { if (failing) throw new Error('private-key-fixture-do-not-expose'); }, set() {}, delete() {} } });
  const input = await f.input(); failing = true;
  assert.equal((await submit(f, input)).status, 201); const draft = await terminal(f, input.requestId);
  assert.equal(draft.status, 'failed'); assert.equal(draft.steps.length, 0); assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(draft).includes('private-key-fixture')); assert.equal((await submit(f, input)).status, 200); assert.equal(f.calls.length, 0);
});

test('cancelling a retained job in another source cannot cancel an active same-ID job', async t => {
  let holding = false; const entered = gate(), release = gate();
  const f = await fixture(t, { providerCall: async () => { if (holding) { entered.resolve(); await release.promise; } return reply('完整草稿'); } });
  const other = (await f.request('/api/sessions', { method: 'POST', body: { title: '另一个来源' } })).session;
  const otherBase = `/api/sessions/${other.id}`;
  await f.request(otherBase + '/messages', { method: 'POST', body: { content: '只作对话演示' } });
  for (let i = 0; i < 100; i++) { if ((await f.request(otherBase)).session.run?.finishedAt) break; await delay(5); }
  const sourceHash = (await f.request(otherBase + '/handoff-preview')).source.hash;
  const plan = await f.request(otherBase + '/summary-preview', { method: 'POST', body: { providerId: 'selected', expectedSourceHash: sourceHash } });
  const input = await f.input(); const otherInput = { ...input, expectedSourceHash: sourceHash, expectedPlanHash: plan.planHash };
  assert.equal((await f.request(otherBase + '/summary-drafts', { method: 'POST', body: otherInput })).status, 201);
  for (let i = 0; i < 100; i++) { if ((await f.request(otherBase + '/summary-drafts/' + input.requestId)).draft.status !== 'running') break; await delay(5); }
  holding = true;
  try {
    assert.equal((await submit(f, input)).status, 201); await entered.promise;
    const cancelled = await f.request(otherBase + '/summary-drafts/' + input.requestId + '/cancel', { method: 'POST', body: {} });
    assert.equal(cancelled.cancelRequested, false); assert.equal(cancelled.draft.status, 'completed');
    assert.equal((await f.request(f.base + '/summary-drafts/' + input.requestId)).draft.status, 'running');
  } finally { holding = false; release.resolve(); }
  assert.equal((await terminal(f, input.requestId)).status, 'completed'); assert.equal(f.calls.length, 2);
});

test('a create request finishing its body after shutdown cannot persist an undispatched running receipt', async t => {
  const f = await fixture(t), input = await f.input(), accepted = gate(), raw = JSON.stringify(input);
  f.app.server.once('request', accepted.resolve);
  const request = http.request(f.app.url + f.base + '/summary-drafts', { method: 'POST', headers: { ...f.headers, 'Content-Length': Buffer.byteLength(raw) } });
  const response = new Promise((resolve, reject) => { request.on('error', reject); request.on('response', result => { const chunks = []; result.on('data', chunk => chunks.push(chunk)); result.on('end', () => resolve({ status: result.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) })); }); });
  request.write(raw.slice(0, 5)); await accepted.promise;
  const closing = f.app.close(); request.end(raw.slice(5));
  const result = await response; assert.equal(result.status, 503); assert.equal(result.error.code, 'SHUTTING_DOWN'); await closing;
  await f.restart(); assert.equal((await f.request(f.base + '/summary-drafts/latest')).draft, null); assert.equal(f.calls.length, 0);
});
