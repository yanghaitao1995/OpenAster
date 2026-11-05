// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { CoreError } from '../core/errors.mjs';

async function directory(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-run-http-'));
  const owner = randomUUID(); await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  t.after(async () => {
    const canonical = await fs.realpath(root);
    assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-run-http-[a-zA-Z0-9]+$/);
    assert.equal(await fs.readFile(path.join(canonical, '.owner'), 'utf8'), owner);
    await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}
async function client(app) {
  const boot = await fetch(app.url + '/api/bootstrap');
  const cookie = boot.headers.get('set-cookie').split(';')[0], { csrfToken } = await boot.json();
  return async (route, { method = 'GET', body, auth = true, headers = {} } = {}) => {
    const response = await fetch(app.url + route, { method, signal: AbortSignal.timeout(10_000),
      headers: { ...(auth ? { cookie, 'X-CSRF-Token': csrfToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, ...await response.json() };
  };
}
async function until(fn, predicate) {
  const end = performance.now() + 10_000;
  while (performance.now() < end) { const value = await fn(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Run history HTTP condition timed out');
}

test('history HTTP pages use bounded summaries, authenticate, and scope every cursor/detail to its task', async t => {
  const root = await directory(t), store = new Store(root);
  const a = store.createSession(), b = store.createSession(), empty = store.createSession();
  const full = 'PRIVATE_STEP_DETAIL_'.repeat(12000);
  try {
    for (let n = 0; n < 17; n++) {
      const id = `run-${String(n).padStart(2, '0')}`, time = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
      a.run = { id, status: 'completed', startedAt: time, finishedAt: time,
        steps: [{ id: 'step', type: 'model', title: '模型回答', status: 'completed', detail: full, createdAt: time, usage: null }], output: null, error: null };
      a.approvals = [{ id: 'approval-' + n, runId: id, sessionId: a.id, tool: 'write_file', args: { path: 'safe.txt', content: 'RAW_APPROVAL_CONTENT' },
        preview: { before: 'FULL_BEFORE', after: 'RAW_APPROVAL_CONTENT', originalHash: 'a'.repeat(64), newHash: 'b'.repeat(64) }, status: 'denied', createdAt: time, resolvedAt: time }];
      store.putSession(a);
    }
    b.run = { id: 'run-16', status: 'failed', error: { code: 'TEST', message: 'OTHER_TASK_DETAIL' } }; store.putSession(b);
  } finally { store.close(); }
  const app = await startServer({ dataDir: root }), request = await client(app);
  const base = `/api/sessions/${a.id}/runs`;
  try {
    assert.equal((await request(base, { auth: false })).status, 401);
    assert.equal((await request(base + '/run-16', { auth: false })).status, 401);
    assert.equal((await request(base, { headers: { Origin: 'https://invalid.example' } })).status, 403);
    const fullRead = Store.prototype.getSession, detailRead = Store.prototype.getRunHistory;
    let first;
    try {
      Store.prototype.getSession = () => { throw new Error('History reads must not deserialize full chat sessions'); };
      Store.prototype.getRunHistory = () => { throw new Error('Lists must not deserialize individual history details'); };
      first = await request(base + '?limit=3'); assert.equal(first.status, 200);
      assert.deepEqual(first.runs.map(run => run.id), ['run-16', 'run-15', 'run-14']);
      assert.equal(first.sessionId, a.id); assert.ok(first.nextCursor);
      assert.ok(Buffer.byteLength(JSON.stringify(first)) < 2000);
      assert.ok(!JSON.stringify(first).includes('PRIVATE_STEP_DETAIL'));
      assert.ok(!JSON.stringify(first).includes('RAW_APPROVAL_CONTENT'));
      assert.deepEqual(first.runs.map(run => [run.stepCount, run.approvalCount]), [[1, 1], [1, 1], [1, 1]]);
      assert.equal((await request(`/api/sessions/${empty.id}/runs`)).runs.length, 0);
      assert.equal((await request('/api/sessions/absent/runs')).status, 404);
      Store.prototype.getRunHistory = detailRead;
      const detail = await request(base + '/run-16'); assert.equal(detail.status, 200);
      assert.equal(detail.record.run.steps[0].detail, full);
      assert.equal(detail.record.approvals[0].path, 'safe.txt');
      for (const hidden of ['RAW_APPROVAL_CONTENT', 'FULL_BEFORE', '"args"', '"preview"']) assert.ok(!JSON.stringify(detail.record).includes(hidden));
    } finally { Store.prototype.getSession = fullRead; Store.prototype.getRunHistory = detailRead; }
    const seen = [...first.runs.map(run => run.id)]; let cursor = first.nextCursor;
    while (cursor) { const page = await request(base + '?' + new URLSearchParams({ limit: '3', cursor })); assert.equal(page.status, 200); seen.push(...page.runs.map(run => run.id)); cursor = page.nextCursor; }
    assert.equal(seen.length, 17); assert.equal(new Set(seen).size, 17);
    assert.equal((await request(`/api/sessions/${b.id}/runs?cursor=${encodeURIComponent(first.nextCursor)}`)).status, 400);
    assert.equal((await request(`/api/sessions/${b.id}/runs/run-16`)).record.run.error.message, 'OTHER_TASK_DETAIL');
    assert.equal((await request(`/api/sessions/${b.id}/runs/run-15`)).status, 404);
    assert.equal((await request(base + '/missing')).status, 404);
    const state = await request('/api/state'); assert.ok(!JSON.stringify(state).includes('PRIVATE_STEP_DETAIL'));
    const exported = await request('/api/export'); assert.equal(exported.status, 200);
    assert.equal(exported.runHistory.length, 18); assert.equal(exported.sessions.length, 3);
    assert.equal(exported.runHistory.filter(record => record.sessionId === a.id).length, 17);
    assert.equal((await request(`/api/sessions/${a.id}`, { method: 'DELETE', body: {} })).status, 200);
    assert.equal((await request(base)).status, 404); assert.equal((await request(base + '/run-16')).status, 404);
    assert.equal((await request(`/api/sessions/${b.id}/runs/run-16`)).status, 200);
  } finally { await app.close(); }
});

test('history query/path validation rejects ambiguous, malformed, and stale pagination inputs', async t => {
  const root = await directory(t), seed = new Store(root), session = seed.createSession();
  session.run = { id: 'saved', status: 'completed' }; seed.putSession(session); seed.close();
  const app = await startServer({ dataDir: root }), request = await client(app), base = `/api/sessions/${session.id}/runs`;
  try {
    for (const query of ['limit=0', 'limit=51', 'limit=-1', 'limit=1.5', 'limit=01', 'limit=1e1', 'limit=', 'limit=1&limit=2', 'cursor=a&cursor=b', 'extra=x', 'limit=%FF', '%E0%A4=1']) {
      const value = await request(base + '?' + query); assert.equal(value.status, 400, query); assert.equal(value.error.code, 'INVALID_HISTORY_QUERY', query);
    }
    for (const cursor of ['', 'a', 'x'.repeat(1025), Buffer.from(JSON.stringify({ sessionId: session.id, startedAt: '', id: 'absent' })).toString('base64url')]) {
      const value = await request(base + '?cursor=' + encodeURIComponent(cursor)); assert.equal(value.status, 400); assert.equal(value.error.code, 'INVALID_CURSOR');
    }
    assert.equal((await request(base + '/saved?limit=1')).status, 400);
    for (const id of ['%FF', '%00', 'bad%2Frun', 'bad%5Crun', 'x'.repeat(201)]) assert.equal((await request(base + '/' + id)).status, 400, id);
    assert.equal((await request(base + '/saved', { method: 'POST', body: { decision: 'approve' } })).status, 404);
    assert.equal((await request(base + '/saved', { method: 'DELETE', body: {} })).status, 404);
  } finally { await app.close(); }
});

test('real API runs preserve completed/failed/cancelled history and original model identity through updates, deletion and restart', async t => {
  const root = await directory(t); let call = 0, capturedMessages;
  let app = await startServer({ dataDir: root, runtimeOptions: { limits: { streamCheckpointMs: 10 }, providerCall: async (_provider, { onText, signal, messages }) => {
    call++;
    if (call === 1) return { content: '首次已完成', toolCalls: [], usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null } };
    if (call === 2) { await onText('FAILED_PARTIAL_ONLY'); throw Object.assign(new CoreError('PROVIDER_HTTP_ERROR', '本机模拟永久请求错误', 400), { providerStatus: 400 }); }
    capturedMessages = structuredClone(messages); await onText('CANCELLED_PARTIAL_ONLY');
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted();
  } } });
  let request = await client(app);
  try {
    const provider = (await request('/api/providers', { method: 'POST', body: { name: '最初连接', type: 'openai', model: 'original-model', baseUrl: 'https://example.test/v1', apiKey: 'LOCAL_SECRET_NOT_HISTORY' } })).provider;
    const session = (await request('/api/sessions', { method: 'POST', body: { providerId: provider.id } })).session;
    const base = `/api/sessions/${session.id}`, runs = base + '/runs';
    const prompt = '🙂'.repeat(121) + ' 不截断代理项';
    const first = await request(base + '/messages', { method: 'POST', body: { content: prompt } }); assert.equal(first.status, 202);
    await until(() => request(base), value => value.session?.run?.finishedAt);
    const firstRecord = (await request(runs + '/' + first.runId)).record;
    assert.equal(firstRecord.run.status, 'completed'); assert.equal(firstRecord.run.requestPreview, '🙂'.repeat(120));
    assert.equal(firstRecord.run.requestMessageId, (await request(base)).session.messages[0].id);
    assert.deepEqual(firstRecord.run.connection, { providerId: provider.id, name: '最初连接', type: 'openai', model: 'original-model', toolMode: 'workspace' });
    assert.equal(firstRecord.run.steps[0].usage.totalTokens, 18);
    for (const secret of ['LOCAL_SECRET_NOT_HISTORY', 'example.test', 'apiKey', 'baseUrl']) assert.ok(!JSON.stringify(firstRecord).includes(secret));
    assert.equal((await request(`/api/providers/${provider.id}`, { method: 'PATCH', body: { name: '修改后的连接', model: 'changed-model', toolMode: 'none' } })).status, 200);
    const second = await request(base + '/messages', { method: 'POST', body: { content: '第二次' } }); assert.equal(second.status, 202);
    await until(() => request(base), value => value.session?.run?.id === second.runId && value.session.run.finishedAt);
    const secondRecord = (await request(runs + '/' + second.runId)).record;
    assert.equal(call, 2, 'a permanent HTTP 400 must not retry the second request');
    assert.equal(secondRecord.run.steps[0].connection.attempt, 1);
    assert.equal(secondRecord.run.status, 'failed'); assert.equal(secondRecord.run.output.status, 'interrupted');
    assert.equal(secondRecord.run.output.content, 'FAILED_PARTIAL_ONLY'); assert.equal(secondRecord.run.connection.model, 'changed-model');
    assert.equal(secondRecord.run.connection.toolMode, 'none'); assert.equal(secondRecord.run.steps[0].usage, null);
    assert.deepEqual((await request(runs + '/' + first.runId)).record, firstRecord);
    const third = await request(base + '/messages', { method: 'POST', body: { content: '第三次' } }); assert.equal(third.status, 202);
    await until(() => request(base + '/output'), value => value.run?.output?.content === 'CANCELLED_PARTIAL_ONLY');
    assert.equal((await request(runs)).runs.length, 2, 'active stream has no historical record');
    assert.equal((await request(runs + '/' + third.runId)).status, 404);
    await request(base + '/cancel', { method: 'POST', body: {} });
    await until(() => request(base), value => value.session?.run?.id === third.runId && value.session.run.finishedAt);
    const thirdRecord = (await request(runs + '/' + third.runId)).record;
    assert.equal(thirdRecord.run.status, 'cancelled'); assert.equal(thirdRecord.run.output.content, 'CANCELLED_PARTIAL_ONLY');
    assert.ok(!JSON.stringify(capturedMessages).includes('FAILED_PARTIAL_ONLY')); assert.ok(!JSON.stringify(capturedMessages).includes('runHistory'));
    assert.equal((await request(`/api/providers/${provider.id}`, { method: 'DELETE', body: {} })).status, 200);
    assert.equal((await request(base)).session.providerId, 'demo');
    assert.deepEqual((await request(runs + '/' + first.runId)).record, firstRecord);
    assert.deepEqual((await request(runs + '/' + third.runId)).record, thirdRecord);
    await app.close(); app = await startServer({ dataDir: root }); request = await client(app);
    assert.equal((await request(runs)).runs.length, 3);
    assert.deepEqual((await request(runs + '/' + first.runId)).record, firstRecord);
    assert.deepEqual((await request(runs + '/' + second.runId)).record, secondRecord);
    assert.deepEqual((await request(runs + '/' + third.runId)).record, thirdRecord);
  } finally { await app.close(); }
});

test('history distinguishes an explicit file denial from a cancelled approval and neither can be replayed', async t => {
  const root = await directory(t);
  const app = await startServer({ dataDir: root, runtimeOptions: { providerCall: async (_provider, { messages }) => {
    if (messages.at(-1).role === 'tool' || messages.at(-1).content === '只回复') return { content: '已结束', toolCalls: [] };
    return { content: '', toolCalls: [{ id: randomUUID(), name: 'write_file', args: { path: 'never-written.txt', content: 'PRIVATE_PROPOSED_TEXT' } }] };
  } } }), request = await client(app);
  try {
    const provider = (await request('/api/providers', { method: 'POST', body: { name: '本地模拟', type: 'openai', model: 'fixture', baseUrl: 'https://example.test/v1' } })).provider;
    const session = (await request('/api/sessions', { method: 'POST', body: { providerId: provider.id } })).session, base = `/api/sessions/${session.id}`;
    const records = [], approvals = [];
    for (const cancel of [false, true]) {
      const started = await request(base + '/messages', { method: 'POST', body: { content: '提议文件' } }); assert.equal(started.status, 202);
      const pending = await until(() => request(base), value => value.session?.run?.status === 'awaiting_approval');
      const approval = pending.session.approvals.find(value => value.status === 'pending'); approvals.push(approval.id);
      assert.equal((await request(base + '/runs/' + started.runId)).status, 404);
      if (cancel) await request(base + '/cancel', { method: 'POST', body: {} });
      else await request('/api/approvals/' + approval.id, { method: 'POST', body: { decision: 'deny' } });
      await until(() => request(base), value => value.session?.run?.finishedAt);
      const record = (await request(base + '/runs/' + started.runId)).record; records.push(record);
      assert.equal(record.run.status, cancel ? 'cancelled' : 'completed');
      assert.equal(record.approvals[0].status, cancel ? 'revoked' : 'denied');
      assert.equal(record.approvals[0].appliedAt, null);
      assert.ok(!JSON.stringify(record).includes('PRIVATE_PROPOSED_TEXT'));
      await assert.rejects(fs.access(path.join(root, 'workspace', 'never-written.txt')), { code: 'ENOENT' });
      assert.equal((await request('/api/approvals/' + approval.id, { method: 'POST', body: { decision: 'approve' } })).status, 409);
    }
    await request(base + '/messages', { method: 'POST', body: { content: '只回复' } });
    const final = await until(() => request(base), value => value.session?.run?.finishedAt);
    assert.equal(final.session.approvals.find(value => value.id === approvals[1]).revoked, true);
    for (const record of records) assert.deepEqual((await request(base + '/runs/' + record.run.id)).record, record);
  } finally { await app.close(); }
});

test('invalid Unicode HTTP input cannot poison terminal history or prevent a later restart', async t => {
  const root = await directory(t); let app = await startServer({ dataDir: root }), request = await client(app);
  try {
    const session = (await request('/api/sessions', { method: 'POST', body: {} })).session, base = `/api/sessions/${session.id}`;
    for (const value of ['\ud800', '\udfff', 'text\0end']) {
      assert.equal((await request(base + '/messages', { method: 'POST', body: { content: value } })).status, 400);
      assert.equal((await request('/api/sessions', { method: 'POST', body: { title: value } })).status, 400);
      assert.equal((await request(base, { method: 'PATCH', body: { title: value } })).status, 400);
      for (const field of ['name', 'model']) {
        const config = { name: 'valid', model: 'valid', type: 'openai', baseUrl: 'https://example.test/v1', [field]: value };
        assert.equal((await request('/api/providers', { method: 'POST', body: config })).status, 400);
      }
    }
    assert.equal((await request(base)).session.run, null);
    assert.equal((await request(base)).session.messages.length, 0);
    assert.equal((await request(base + '/runs')).runs.length, 0);
    assert.equal((await request('/api/state')).providers.length, 1);
    await app.close(); app = await startServer({ dataDir: root }); request = await client(app);
    const valid = await request(base + '/messages', { method: 'POST', body: { content: '正常中文🙂' } }); assert.equal(valid.status, 202);
    await until(() => request(base), value => value.session?.run?.finishedAt);
    assert.equal((await request(base + '/runs')).runs[0].status, 'completed');
  } finally { await app.close(); }
});
