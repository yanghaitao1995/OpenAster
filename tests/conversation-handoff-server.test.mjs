// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const time = '2026-10-29T00:00:00.000Z';
const provider = id => ({ id, name: id, type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true, toolMode: 'none' });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, { seed, runtimeOptions = {} } = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-handoff-http-'));
  const store = new Store(root); for (const id of ['source-provider', 'selected', 'unrelated']) store.putProvider(provider(id));
  const source = store.createSession({ title: '长任务', providerId: 'source-provider' });
  source.messages = [{ id: 'source-user', role: 'user', content: '原始私有请求，不得自动复制', createdAt: time,
    contextFiles: [{ path: 'old.txt', content: '旧附件私有正文', sha256: hash('旧附件私有正文') }] },
  { id: 'source-answer', role: 'assistant', content: '原始答复，不得自动复制', createdAt: time }];
  seed?.(source); store.putSession(source); store.close();
  const requests = []; let app, cookie, boot;
  async function start() {
    app = await startServer({ dataDir: root, port: 0, runtimeOptions: { providerCall: async (connection, { messages, tools, system }) => { requests.push(structuredClone({ providerId: connection.id, messages, tools, system })); return { content: '续接完成', toolCalls: [], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }; }, ...runtimeOptions } });
    const response = await fetch(app.url + '/api/bootstrap'); cookie = response.headers.get('set-cookie').split(';')[0]; boot = await response.json();
    assert.equal(boot.capabilities.conversationHandoff, 1);
  }
  await start();
  t.after(async () => { await app.close(); const canonical = await fs.realpath(root); assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-handoff-http-[a-zA-Z0-9]+$/u); await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  async function request(route, { method = 'GET', body, raw, auth = true, headers = {} } = {}) {
    const res = await fetch(app.url + route, { method, signal: AbortSignal.timeout(10000), headers: { ...(auth ? { cookie, 'X-CSRF-Token': boot.csrfToken } : {}), ...(body === undefined && raw === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    assert.equal(res.headers.get('cache-control'), 'no-store'); return { status: res.status, ...await res.json() };
  }
  const base = `/api/sessions/${source.id}`, preview = () => request(base + '/handoff-preview');
  const input = async () => ({ requestId: randomUUID(), expectedSourceHash: (await preview()).source.hash, summary: '目标与约束由用户审阅。已完成资料整理；下一步核对结论。', content: '请根据摘要继续核对。', providerId: 'selected', skillId: 'general' });
  return { root, get app() { return app; }, source, base, request, preview, input, requests, async restart() { await app.close(); await start(); } };
}
async function terminal(f, id) { const deadline = performance.now() + 5000; while (performance.now() < deadline) { const { session } = await f.request(`/api/sessions/${id}`); if (session?.run?.finishedAt) return session; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Handoff fixture timed out'); }
const submit = (f, body) => f.request(f.base + '/continuations', { method: 'POST', body });

test('handoff routes enforce auth, exact shape, UTF-8 and metadata-only preview', async t => {
  const f = await fixture(t), valid = await f.input(), preview = await f.preview();
  assert.deepEqual(preview.files, { count: 1, bytes: Buffer.byteLength('旧附件私有正文') });
  assert.equal(preview.source.messageCount, 2); assert.equal(preview.source.lastMessageId, 'source-answer');
  for (const secret of ['原始私有请求', '原始答复', '旧附件私有正文']) assert.ok(!JSON.stringify(preview).includes(secret));
  assert.equal((await f.request(f.base + '/handoff-preview', { auth: false })).status, 401);
  assert.equal((await f.request(f.base + '/continuations', { method: 'POST', body: valid, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.request(f.base + '/continuations', { method: 'POST', body: valid, headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  for (const query of ['?extra=1', '?a=%FF', '?a=1&a=2']) {
    assert.equal((await f.request(f.base + '/handoff-preview' + query)).error.code, 'INVALID_HANDOFF_QUERY');
    assert.equal((await f.request(f.base + '/continuations' + query, { method: 'POST', body: valid })).error.code, 'INVALID_HANDOFF_QUERY');
  }
  for (const extra of [{ files: [] }, { messages: [] }, { contextHandoff: {} }, { requestId: null }, { summary: '\ud800' }, { summary: ' ' }, { summary: 'a'.repeat(24001) }, { summary: '中'.repeat(24000) }, { content: '' }, { expectedSourceHash: null }, { skillId: null }]) assert.equal((await submit(f, { ...valid, ...extra })).status, 400);
  assert.equal((await f.request(f.base + '/continuations', { method: 'POST', raw: Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]) })).error.code, 'INVALID_JSON');
  assert.equal((await f.request(f.base + '/continuations', { method: 'POST', raw: ' '.repeat(256 * 1024 + 1) })).status, 413);
  assert.equal((await f.request('/api/state')).sessions.length, 1); assert.equal(f.requests.length, 0);
});

test('continuation sends only the reviewed snapshot and new request; source and files remain unchanged', async t => {
  const f = await fixture(t), before = (await f.request(f.base)).session, input = await f.input();
  await fs.writeFile(path.join(f.root, 'workspace', 'old.txt'), '当前文件私有正文');
  const created = await submit(f, input); assert.equal(created.status, 201); assert.equal(created.session.id, input.requestId);
  const task = await terminal(f, created.session.id); assert.equal(task.run.status, 'completed');
  assert.equal(task.messages.length, 2); assert.equal(task.messages[0].content, input.content); assert.deepEqual(task.approvals, []);
  assert.deepEqual((await f.request(f.base)).session, before); assert.equal(await fs.readFile(path.join(f.root, 'workspace', 'old.txt'), 'utf8'), '当前文件私有正文');
  const wire = JSON.stringify(f.requests); assert.ok(wire.includes(input.summary)); assert.ok(wire.includes(input.content));
  for (const secret of ['原始私有请求', '原始答复', '旧附件私有正文', '当前文件私有正文']) assert.ok(!wire.includes(secret));
  assert.equal(task.messages[0].contextHandoff.summaryHash, hash(input.summary));
  assert.equal(task.messages[0].contextHandoff.sourceMessageCount, 2);
  const exported = await f.request('/api/export'); assert.deepEqual(exported.sessions.find(s => s.id === task.id).messages[0].contextHandoff, task.messages[0].contextHandoff);
});

test('committed continuation replays once across restart, source deletion and connection changes', async t => {
  const f = await fixture(t), input = await f.input(), created = await submit(f, input); assert.equal(created.status, 201);
  const done = await terminal(f, created.session.id); assert.equal(f.requests.length, 1);
  assert.equal((await submit(f, { ...input, summary: '改动后的另一个摘要' })).error.code, 'HANDOFF_ID_CONFLICT');
  assert.equal((await f.request(f.base, { method: 'DELETE' })).status, 200);
  assert.equal((await f.request('/api/providers/selected', { method: 'DELETE' })).status, 200);
  await f.restart();
  const replay = await submit(f, input); assert.equal(replay.status, 200); assert.equal(replay.session.id, done.id); assert.equal(replay.session.run.id, done.run.id);
  assert.equal(f.requests.length, 1); assert.equal((await f.request('/api/state')).sessions.length, 1);
  const noSkill = { ...input }; delete noSkill.skillId; assert.equal((await submit(f, noSkill)).status, 200);
  assert.equal((await f.request(`/api/sessions/not-the-source/continuations`, { method: 'POST', body: input })).error.code, 'HANDOFF_ID_CONFLICT');
});

test('stale sources, disabled models, ID collisions and precise preflight errors leave no orphan task', async t => {
  const f = await fixture(t), old = await f.input();
  await f.request(f.base, { method: 'PATCH', body: { title: '改变后的标题' } });
  assert.equal((await submit(f, old)).error.code, 'HANDOFF_SOURCE_CHANGED');
  const input = await f.input();
  assert.equal((await submit(f, { ...input, requestId: f.source.id })).error.code, 'HANDOFF_ID_CONFLICT');
  await f.request('/api/providers/selected', { method: 'PATCH', body: { enabled: false } });
  assert.equal((await submit(f, input)).error.code, 'PROVIDER_DISABLED');
  assert.equal((await submit(f, { ...input, providerId: 'missing' })).error.code, 'PROVIDER_NOT_FOUND');
  assert.equal((await f.request('/api/state')).sessions.length, 1); assert.equal(f.requests.length, 0);
  const small = await fixture(t, { runtimeOptions: { limits: { maxRequestBytes: 100 } } });
  assert.equal((await submit(small, await small.input())).error.code, 'CONTEXT_TOO_LARGE');
  assert.equal((await small.request('/api/state')).sessions.length, 1); assert.equal(small.requests.length, 0);
});

test('full 201-message source can continue and its raw history is retained', async t => {
  const f = await fixture(t, { seed(source) { source.messages = Array.from({ length: 201 }, (_, i) => ({ id: `full-${i}`, role: i % 2 ? 'assistant' : 'user', content: `${i}:` + '旧'.repeat(3000), createdAt: time })); } });
  const before = (await f.request(f.base)).session;
  assert.equal((await f.request(f.base + '/messages', { method: 'POST', body: { content: '不能原样追加' } })).error.code, 'MESSAGE_LIMIT');
  const result = await submit(f, await f.input()); assert.equal(result.status, 201); const done = await terminal(f, result.session.id);
  assert.equal(done.messages.length, 2); assert.equal(done.messages[0].contextHandoff.sourceMessageCount, 201); assert.deepEqual((await f.request(f.base)).session, before);
  assert.ok(JSON.stringify(f.requests).length < 12000);
});

test('legacy saved history above the runtime 2 MiB limit remains eligible for manual handoff without clipping', async t => {
  const f = await fixture(t, { seed(source) { source.messages = Array.from({ length: 16 }, (_, i) => ({ id: `legacy-${i}`, role: i % 2 ? 'assistant' : 'user', content: `${i}:` + 'x'.repeat(200000), createdAt: time })); } });
  const before = (await f.request(f.base)).session; assert.ok(Buffer.byteLength(JSON.stringify(before.messages)) > 2 * 1024 * 1024);
  const preview = await f.preview(); assert.equal(preview.status, 200); assert.equal(preview.source.lastMessageId, 'legacy-15'); assert.equal(preview.source.messageCount, 16);
  const result = await submit(f, await f.input()); assert.equal(result.status, 201); const done = await terminal(f, result.session.id);
  assert.equal(done.messages[0].contextHandoff.sourceHash, preview.source.hash); assert.deepEqual((await f.request(f.base)).session, before); assert.ok(JSON.stringify(f.requests).length < 12000);
});

test('handoff preflight locks source, duplicate operation and related model mutations until the real operation settles', async t => {
  const entered = gate(), release = gate(); let holding = true;
  const f = await fixture(t, { runtimeOptions: { providers: async id => { if (holding) { entered.resolve(); await release.promise; } return provider(id); } } });
  const input = await f.input(), pending = submit(f, input); await entered.promise;
  try {
    assert.equal((await submit(f, input)).error.code, 'BRANCH_SOURCE_BUSY');
    assert.equal((await f.preview()).error.code, 'BRANCH_SOURCE_BUSY');
    for (const action of [{ method: 'PATCH', body: { title: '不能修改' } }, { method: 'DELETE' }]) assert.equal((await f.request(f.base, action)).error.code, 'BRANCH_SOURCE_BUSY');
    assert.equal((await f.request(f.base + '/messages', { method: 'POST', body: { content: '不能同时追加' } })).error.code, 'BRANCH_SOURCE_BUSY');
    for (const id of ['selected', 'source-provider']) for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request(`/api/providers/${id}`, { method, ...(method === 'PATCH' ? { body: { name: '不能修改' } } : {}) })).status, 409);
    assert.equal((await f.request('/api/providers/unrelated', { method: 'PATCH', body: { name: '可以修改' } })).status, 200);
    await assert.rejects(f.app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  } finally { holding = false; release.resolve(); }
  const created = await pending; assert.equal(created.status, 201); await terminal(f, created.session.id);
  assert.equal((await submit(f, input)).status, 200); assert.equal(f.requests.length, 1);
  assert.equal((await f.request(f.base, { method: 'PATCH', body: { title: '锁已释放' } })).status, 200);
});

test('failed preflight releases reservations and active source cannot be handed off', async t => {
  const f = await fixture(t, { runtimeOptions: { providers: async () => { throw new Error('fixture credential failure'); } } });
  assert.equal((await submit(f, await f.input())).status, 500); assert.equal((await f.request('/api/state')).sessions.length, 1);
  assert.equal((await f.preview()).status, 200); assert.equal((await f.request('/api/providers/selected', { method: 'PATCH', body: { name: '已解锁' } })).status, 200);
  const entered = gate(), release = gate();
  const g = await fixture(t, { runtimeOptions: { providers: async id => { entered.resolve(); await release.promise; return provider(id); } } });
  const input = await g.input(), pending = g.request(g.base + '/messages', { method: 'POST', body: { content: '正在启动' } }); await entered.promise;
  try { assert.equal((await g.preview()).error.code, 'RUN_ACTIVE'); assert.equal((await submit(g, input)).error.code, 'RUN_ACTIVE'); }
  finally { release.resolve(); }
  assert.equal((await pending).status, 202);
});
