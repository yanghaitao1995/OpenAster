// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';

const hash = content => createHash('sha256').update(content).digest('hex');
async function directory(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-artifact-http-'));
  const owner = randomUUID(); await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  t.after(async () => {
    const canonical = await fs.realpath(root);
    assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-artifact-http-[a-zA-Z0-9]+$/u);
    assert.equal(await fs.readFile(path.join(canonical, '.owner'), 'utf8'), owner);
    await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}
async function client(app) {
  const boot = await fetch(app.url + '/api/bootstrap');
  const cookie = boot.headers.get('set-cookie').split(';')[0], bootstrap = await boot.json();
  assert.equal(bootstrap.capabilities.toolArtifacts, 1);
  return async (route, { method = 'GET', body, auth = true, headers = {} } = {}) => {
    const response = await fetch(app.url + route, { method, signal: AbortSignal.timeout(10_000),
      headers: { ...(auth ? { cookie, 'X-CSRF-Token': bootstrap.csrfToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, ...await response.json() };
  };
}
async function until(fn, predicate) {
  const end = performance.now() + 10_000;
  while (performance.now() < end) { const value = await fn(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Tool artifact HTTP condition timed out');
}
async function modelSession(request) {
  const provider = (await request('/api/providers', { method: 'POST', body: { name: '本地归档验证', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' } })).provider;
  return (await request('/api/sessions', { method: 'POST', body: { providerId: provider.id } })).session;
}
async function readAll(request, route, maxBytes = 4093) {
  const pages = []; let offset = 0, metadata;
  for (let count = 0; count < 1000; count++) {
    const response = await request(`${route}?offset=${offset}&maxBytes=${maxBytes}`);
    assert.equal(response.status, 200); const { artifact, page } = response;
    assert.equal(Object.hasOwn(artifact, 'content'), false);
    if (metadata) assert.deepEqual(artifact, metadata); else metadata = artifact;
    assert.equal(page.offset, offset); assert.equal(page.content.isWellFormed(), true);
    assert.equal(page.endOffset - offset, Buffer.byteLength(page.content));
    assert.ok(page.endOffset - offset <= maxBytes);
    assert.equal(page.complete, offset === 0 && page.endOffset === artifact.bytes);
    pages.push(page.content);
    if (page.nextOffset === null) {
      assert.equal(page.endOffset, artifact.bytes);
      const content = pages.join(''); assert.equal(Buffer.byteLength(content), artifact.bytes); assert.equal(hash(content), artifact.sha256);
      return { artifact, content };
    }
    assert.ok(page.nextOffset > offset); assert.equal(page.nextOffset, page.endOffset); offset = page.nextOffset;
  }
  throw new Error('Artifact pagination did not terminate');
}

test('actual tool results remain exact across active reads, later turns, restart, export and session deletion', async t => {
  const root = await directory(t); let calls = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  let app = await startServer({ dataDir: root, runtimeOptions: { providerCall: async () => {
    calls++;
    if (calls === 1) return { content: '', toolCalls: [{ id: 'read-original', name: 'read_file', args: { path: '资料.txt' } }] };
    if (calls === 2) await gate;
    return { content: '完成', toolCalls: [] };
  } } });
  let request = await client(app);
  try {
    const text = '\ufeff唯一原文🙂\r\n' + '长行“中文”🙂'.repeat(3000) + '\r\n<script>not executable</script>';
    assert.equal((await request('/api/workspace/files', { method: 'POST', body: { path: '资料.txt', content: text } })).status, 201);
    const session = await modelSession(request), base = `/api/sessions/${session.id}`;
    const started = await request(base + '/messages', { method: 'POST', body: { content: '读取资料' } }); assert.equal(started.status, 202);
    const active = (await until(() => request(base), value => value.session?.run?.steps.some(step => step.toolResultRef))).session;
    assert.equal(active.run.finishedAt, null);
    const ref = active.run.steps.find(step => step.toolResultRef).toolResultRef;
    const route = `${base}/runs/${started.runId}/artifacts/${ref.artifactId}`;
    const original = await readAll(request, route);
    assert.equal(original.artifact.runId, started.runId); assert.equal(original.artifact.sessionId, session.id);
    assert.equal(original.artifact.stepId, ref.artifactId); assert.equal(original.artifact.callId, 'read-original');
    assert.equal(original.artifact.name, 'read_file'); assert.equal(original.artifact.path, '资料.txt'); assert.equal(original.artifact.isError, false);
    assert.equal(original.artifact.bytes, ref.bytes); assert.equal(original.artifact.sha256, ref.sha256);
    assert.equal(JSON.parse(original.content).result.content, text);
    assert.ok(!JSON.stringify(active).includes('唯一原文'));
    assert.ok(!JSON.stringify(await request(base + '/output')).includes('唯一原文'));
    await fs.writeFile(path.join(root, 'workspace', '资料.txt'), 'DISK_CHANGED_AFTER_READ');
    assert.deepEqual(await readAll(request, route, 16384), original);
    finish();
    await until(() => request(base), value => value.session?.run?.finishedAt);
    const record = (await request(`${base}/runs/${started.runId}`)).record;
    assert.equal(record.run.status, 'completed');
    assert.equal(record.run.steps.filter(step => step.contextPlan).at(-1).contextPlan.toolResults[0].mode, 'full');
    const again = await request(base + '/messages', { method: 'POST', body: { content: '继续' } });
    assert.equal(again.status, 202);
    await until(() => request(base), value => value.session?.run?.id === again.runId && value.session.run.finishedAt);
    const exported = await request('/api/export');
    assert.deepEqual(exported.toolArtifacts.find(value => value.id === ref.artifactId), { ...original.artifact, content: original.content });
    assert.ok(!JSON.stringify((await request('/api/state')).sessions).includes('唯一原文'));
    await app.close(); app = await startServer({ dataDir: root }); request = await client(app);
    assert.deepEqual(await readAll(request, route), original);
    assert.deepEqual((await request(`${base}/runs/${started.runId}`)).record, record);
    assert.equal((await request(base, { method: 'DELETE', body: {} })).status, 200);
    assert.equal((await request(route)).status, 404);
    assert.ok(!(await request('/api/export')).toolArtifacts.some(value => value.sessionId === session.id));
    assert.equal(await fs.readFile(path.join(root, 'workspace', '资料.txt'), 'utf8'), 'DISK_CHANGED_AFTER_READ');
  } finally { finish(); await app.close(); }
});

test('artifact HTTP authentication, task/run scoping, strict byte ranges and read-only methods preserve stored data', async t => {
  const root = await directory(t); let calls = 0;
  const app = await startServer({ dataDir: root, runtimeOptions: { providerCall: async () => ++calls === 1
    ? { content: '', toolCalls: [{ id: 'read-unicode', name: 'read_file', args: { path: 'unicode.txt' } }] }
    : { content: 'done', toolCalls: [] } } }), request = await client(app);
  try {
    await request('/api/workspace/files', { method: 'POST', body: { path: 'unicode.txt', content: '\ufeff🙂中文\r\n' } });
    const session = await modelSession(request), other = (await request('/api/sessions', { method: 'POST', body: {} })).session;
    const base = `/api/sessions/${session.id}`, started = await request(base + '/messages', { method: 'POST', body: { content: '读取' } });
    const done = (await until(() => request(base), value => value.session?.run?.finishedAt)).session;
    const ref = done.run.steps.find(step => step.toolResultRef).toolResultRef;
    const route = `${base}/runs/${started.runId}/artifacts/${ref.artifactId}`;
    const original = await readAll(request, route), before = await request(base);
    assert.equal((await request(route, { auth: false })).status, 401);
    assert.equal((await request(route, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    for (const changed of [route.replace(session.id, other.id), route.replace(started.runId, 'other-run'), route.replace(ref.artifactId, 'other-artifact')]) {
      const denied = await request(changed); assert.equal(denied.status, 404); assert.ok(!JSON.stringify(denied).includes('中文'));
    }
    for (const query of ['offset=-1', 'offset=01', 'offset=1.5', 'offset=1e2', 'offset=', 'offset=0&offset=0', 'maxBytes=4&maxBytes=4', 'maxBytes=0', 'maxBytes=3', 'maxBytes=16385', 'offset=2097153', 'offset=99999999999', 'offset=%FF', 'maxBytes=%00', 'unknown=0']) {
      const invalid = await request(route + '?' + query); assert.equal(invalid.status, 400, query); assert.equal(invalid.error.code, 'INVALID_ARTIFACT_QUERY');
    }
    for (const id of ['%FF', '%00', 'bad%2Frun', 'bad%5Crun', 'x'.repeat(201)]) assert.equal((await request(route.replace(ref.artifactId, id))).status, 400, id);
    const insideEmoji = Buffer.from(original.content).indexOf(Buffer.from('🙂')) + 1;
    for (const offset of [insideEmoji, original.artifact.bytes + 1]) {
      const invalid = await request(route + '?offset=' + offset); assert.equal(invalid.status, 400); assert.equal(invalid.error.code, 'INVALID_ARTIFACT_RANGE');
    }
    const eof = await request(route + '?offset=' + original.artifact.bytes);
    assert.deepEqual(eof.page, { offset: original.artifact.bytes, endOffset: original.artifact.bytes, nextOffset: null, complete: false, content: '' });
    for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await request(route, { method, body: { content: 'FORGED', decision: 'approve' } })).status, 404);
    assert.deepEqual(await request(base), before); assert.equal(calls, 2);
    assert.deepEqual(await readAll(request, route, 4), original);
  } finally { await app.close(); }
});

test('tool failures are immutable error results and historical pages cannot execute them again', async t => {
  const root = await directory(t); let calls = 0;
  const app = await startServer({ dataDir: root, runtimeOptions: { providerCall: async () => ++calls === 1
    ? { content: '', toolCalls: [{ id: 'missing-read', name: 'read_file', args: { path: 'missing.txt' } }, { id: 'unknown-tool', name: 'not_a_tool', args: {} }] }
    : { content: '错误已收到', toolCalls: [] } } }), request = await client(app);
  try {
    const session = await modelSession(request), base = `/api/sessions/${session.id}`;
    const started = await request(base + '/messages', { method: 'POST', body: { content: '验证失败结果' } });
    const done = (await until(() => request(base), value => value.session?.run?.finishedAt)).session;
    assert.equal(done.run.status, 'completed');
    const steps = done.run.steps.filter(step => step.toolResultRef); assert.equal(steps.length, 2);
    for (const step of steps) {
      assert.equal(step.status, 'failed'); assert.equal(step.toolResultRef.isError, true);
      const route = `${base}/runs/${started.runId}/artifacts/${step.toolResultRef.artifactId}`;
      const result = await readAll(request, route);
      assert.equal(result.artifact.isError, true);
      const decoded = JSON.parse(result.content); assert.equal(decoded.untrusted_data, true); assert.equal(typeof decoded.error.code, 'string');
      assert.equal(Object.hasOwn(decoded, 'result'), false);
    }
    assert.equal(calls, 2); assert.equal((await request(base + '/runs')).runs.length, 1);
    await assert.rejects(fs.access(path.join(root, 'workspace', 'missing.txt')), { code: 'ENOENT' });
  } finally { await app.close(); }
});
