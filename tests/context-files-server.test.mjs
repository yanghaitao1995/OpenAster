// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import { startServer } from '../server/index.mjs';
import { createWorkspace } from '../core/workspace.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
async function ownedDirectory(t) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-context-http-'));
  const owner = randomUUID(); await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  t.after(async () => {
    const canonical = await fs.realpath(root);
    assert.equal(path.dirname(canonical), parent);
    assert.match(path.basename(canonical), /^openaster-context-http-[a-zA-Z0-9]+$/);
    assert.equal(await fs.readFile(path.join(canonical, '.owner'), 'utf8'), owner);
    await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}
async function client(app) {
  const boot = await fetch(app.url + '/api/bootstrap');
  const cookie = boot.headers.get('set-cookie').split(';')[0], bootstrap = await boot.json();
  assert.deepEqual(bootstrap.capabilities, { contextFiles: 1, toolArtifacts: 1, usageOverview: 1, conversationBranch: 1, conversationHandoff: 1, handoffDraft: 1, workspaceSearch: 1, workspaceIgnore: 1, workspaceDirectory: 1, workspaceEdit: 1, providerDiagnostics: 1, permissions: 1, commandPolicy: 1, taskInput: 1, webTools: 1, webSearchConfiguration: 1, progressiveSkills: 1, images: 1 });
  const { csrfToken } = bootstrap;
  return async (route, { method = 'GET', body, auth = true, headers = {} } = {}) => {
    const response = await fetch(app.url + route, {
      method, signal: AbortSignal.timeout(10_000),
      headers: { ...(auth ? { cookie, 'X-CSRF-Token': csrfToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, ...await response.json() };
  };
}
async function terminal(request, base, runId) {
  const end = performance.now() + 10_000;
  while (performance.now() < end) {
    const value = await request(base);
    if (value.session?.run?.id === runId && value.session.run.finishedAt) return value.session;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Context HTTP run did not finish');
}
async function imported(request, name, content) {
  const result = await request('/api/workspace/files', { method: 'POST', body: { path: name, content } });
  assert.equal(result.status, 201);
  const preview = await request('/api/workspace/file?' + new URLSearchParams({ path: name }));
  assert.equal(preview.status, 200);
  return { path: preview.path, sha256: preview.sha256 };
}
function responseFor(type) {
  const message = { role: 'assistant', content: '已读取明确选择的资料。' };
  if (type === 'responses') return { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: message.content }] }] };
  if (type === 'anthropic') return { role: 'assistant', type: 'message', content: [{ type: 'text', text: message.content }], stop_reason: 'end_turn' };
  if (type === 'ollama') return { message, done: true, done_reason: 'stop' };
  return { choices: [{ message, finish_reason: 'stop' }] };
}

for (const type of ['openai', 'responses', 'anthropic', 'ollama']) {
  test(`selected files reach the actual ${type} HTTP request as exact historical user snapshots`, async t => {
    const root = await ownedDirectory(t), calls = [];
    const upstream = http.createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      calls.push(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(responseFor(type)));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    let app;
    try {
      app = await startServer({ dataDir: root }); let request = await client(app);
      const provider = (await request('/api/providers', { method: 'POST', body: {
        name: '附件协议验证', type, model: 'local-fixture', streaming: false, toolMode: 'none',
        baseUrl: `http://127.0.0.1:${upstream.address().port}${type === 'ollama' ? '' : '/v1'}`,
      } })).provider;
      const content = '\ufeff# 明确选择🙂\r\n<script>not executable</script>\r\n';
      const selection = await imported(request, 'src/资料.md', content);
      await imported(request, 'other/资料.md', 'NOT_SELECTED_PRIVATE_TEXT');
      const session = (await request('/api/sessions', { method: 'POST', body: { providerId: provider.id } })).session;
      const base = `/api/sessions/${session.id}`;
      const start = await request(base + '/messages', { method: 'POST', body: { content: '分析选中的这份文件', files: [selection] } });
      assert.equal(start.status, 202);
      const done = await terminal(request, base, start.runId); assert.equal(done.run.status, 'completed');
      assert.deepEqual(done.messages[0].contextFiles, [{ ...selection, content }]);
      assert.equal(done.messages[0].content, '分析选中的这份文件');
      assert.equal(calls.length, 1); assert.equal(calls[0].tools, undefined);
      const userMessage = (calls[0].messages ?? calls[0].input).find(message => message.role === 'user');
      const supplied = JSON.parse(userMessage.content);
      assert.equal(supplied.user_request, '分析选中的这份文件');
      assert.equal(supplied.attached_files.length, 1);
      assert.equal(supplied.attached_files[0].path, selection.path);
      assert.equal(supplied.attached_files[0].sha256, hash(content));
      assert.equal(supplied.attached_files[0].content, content);
      assert.ok(!JSON.stringify(calls[0]).includes('NOT_SELECTED_PRIVATE_TEXT'));
      const currentState = await request('/api/state'); assert.deepEqual(currentState.capabilities, { contextFiles: 1, toolArtifacts: 1, usageOverview: 1, conversationBranch: 1, conversationHandoff: 1, handoffDraft: 1, workspaceSearch: 1, workspaceIgnore: 1, workspaceDirectory: 1, workspaceEdit: 1, providerDiagnostics: 1, permissions: 1, commandPolicy: 1, taskInput: 1, webTools: 1, webSearchConfiguration: 1, progressiveSkills: 1, images: 1 });
      assert.ok(!JSON.stringify(currentState).includes('<script>not executable</script>'));
      assert.deepEqual((await request('/api/export')).sessions.find(item => item.id === session.id).messages[0].contextFiles, done.messages[0].contextFiles);
      await fs.writeFile(path.join(root, 'workspace', 'src', '资料.md'), 'NEW_DISK_TEXT_NOT_SELECTED');
      await app.close(); app = await startServer({ dataDir: root }); request = await client(app);
      assert.deepEqual((await request(base)).session.messages[0].contextFiles, done.messages[0].contextFiles);
      const next = await request(base + '/messages', { method: 'POST', body: { content: '继续讨论已发送的版本' } });
      assert.equal(next.status, 202); assert.equal((await terminal(request, base, next.runId)).run.status, 'completed');
      const second = JSON.stringify(calls[1]);
      assert.ok(second.includes('明确选择')); assert.ok(!second.includes('NEW_DISK_TEXT_NOT_SELECTED'));
      assert.equal(calls[1].tools, undefined);
    } finally { await app?.close(); await new Promise(resolve => upstream.close(resolve)); }
  });
}

test('context selection errors are rejected before persisting a new message or invoking the model', async t => {
  const root = await ownedDirectory(t); let calls = 0;
  const app = await startServer({ dataDir: root, runtimeOptions: { providerCall: async () => { calls++; return { content: 'ok', toolCalls: [] }; } } });
  try {
    const request = await client(app);
    const provider = (await request('/api/providers', { method: 'POST', body: { name: 'mock', type: 'openai', model: 'mock', baseUrl: 'https://example.test/v1' } })).provider;
    const session = (await request('/api/sessions', { method: 'POST', body: { providerId: provider.id } })).session, base = `/api/sessions/${session.id}`;
    const selected = await imported(request, 'notes.md', 'first version');
    const body = { content: '使用资料', files: [selected] };
    assert.equal((await request(base + '/messages', { method: 'POST', body, auth: false })).status, 401);
    assert.equal((await request(base + '/messages', { method: 'POST', body, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
    assert.equal((await request(base + '/messages', { method: 'POST', body, headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    for (const files of [null, {}, 'notes.md', [selected, selected], [{ ...selected, content: 'FORGED' }], [{ ...selected, sha256: 'bad' }], [{ path: '../outside.txt', sha256: selected.sha256 }]]) {
      const result = await request(base + '/messages', { method: 'POST', body: { content: '使用资料', files } });
      assert.equal(result.status, 400, JSON.stringify(files));
    }
    assert.equal((await request(base + '/messages', { method: 'POST', body: { content: '使用资料', files: Array.from({ length: 6 }, (_, n) => ({ path: `${n}.txt`, sha256: selected.sha256 })) } })).status, 413);
    await fs.writeFile(path.join(root, 'workspace', 'notes.md'), 'changed version');
    const changed = await request(base + '/messages', { method: 'POST', body });
    assert.equal(changed.status, 409); assert.equal(changed.error.code, 'CONTEXT_FILE_CHANGED');
    const missing = await request(base + '/messages', { method: 'POST', body: { content: '使用资料', files: [{ path: 'missing.txt', sha256: selected.sha256 }] } });
    assert.equal(missing.status, 409); assert.equal(missing.error.code, 'CONTEXT_FILE_CHANGED');
    const bigA = await imported(request, 'a.txt', 'a'.repeat(140 * 1024));
    const bigB = await imported(request, 'b.txt', 'b'.repeat(140 * 1024));
    const oversized = await request(base + '/messages', { method: 'POST', body: { content: '使用资料', files: [bigA, bigB] } });
    assert.equal(oversized.status, 413); assert.equal(oversized.error.code, 'CONTEXT_FILES_LIMIT');
    assert.deepEqual((await request(base)).session, { ...session, queuedInputs: [] }); assert.equal(calls, 0);
    assert.equal((await request(base + '/runs')).runs.length, 0);
    const valid = await request(base + '/messages', { method: 'POST', body: { content: '不附带文件', files: [] } });
    assert.equal(valid.status, 202); assert.equal((await terminal(request, base, valid.runId)).run.status, 'completed');
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('selected context uses the current workspace access checks and never reads a sensitive or linked file', async t => {
  const root = await ownedDirectory(t), workspace = path.join(root, 'project'); await fs.mkdir(workspace);
  const secret = 'PRIVATE_SENSITIVE_FILE'; await fs.writeFile(path.join(workspace, '.env'), secret);
  await fs.writeFile(path.join(root, 'outside.txt'), 'OUTSIDE_LINK_TARGET');
  await fs.link(path.join(root, 'outside.txt'), path.join(workspace, 'linked.txt'));
  let calls = 0;
  const app = await startServer({ dataDir: path.join(root, 'data'), workspace, workspaceOptions: { denySensitivePaths: true, projectScan: true },
    runtimeOptions: { providerCall: async () => { calls++; return { content: 'ok', toolCalls: [] }; } } });
  try {
    const request = await client(app);
    const session = (await request('/api/sessions', { method: 'POST', body: {} })).session, base = `/api/sessions/${session.id}`;
    for (const [name, text] of [['.env', secret], ['linked.txt', 'OUTSIDE_LINK_TARGET']]) {
      const denied = await request(base + '/messages', { method: 'POST', body: { content: '使用文件', files: [{ path: name, sha256: hash(text) }] } });
      assert.equal(denied.status, 403); assert.ok(!JSON.stringify(denied).includes(text));
    }
    assert.deepEqual((await request(base)).session, { ...session, queuedInputs: [] }); assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('file preflight pins the explicitly chosen provider and releases its read lock on both success and failure', async t => {
  const root = await ownedDirectory(t), workspacePath = path.join(root, 'workspace');
  const real = createWorkspace(workspacePath); await real.list();
  await fs.writeFile(path.join(workspacePath, 'notes.md'), 'pinned version');
  let entered, release, shouldBlock = false, calls = 0, usedProvider;
  const enteredGate = new Promise(resolve => { entered = resolve; });
  const readGate = new Promise(resolve => { release = resolve; });
  const app = await startServer({ dataDir: root, runtimeOptions: {
    workspace: { ...real, read: async (...args) => { if (shouldBlock) { entered(); await readGate; } return real.read(...args); } },
    providerCall: async provider => { calls++; usedProvider = provider; return { content: 'done', toolCalls: [] }; },
  } });
  try {
    const request = await client(app);
    const add = name => request('/api/providers', { method: 'POST', body: { name, type: 'openai', model: 'original', baseUrl: 'https://example.test/v1' } });
    const selectedProvider = (await add('chosen')).provider, otherProvider = (await add('other')).provider;
    const session = (await request('/api/sessions', { method: 'POST', body: {} })).session, base = `/api/sessions/${session.id}`;
    assert.equal(session.providerId, 'demo');
    shouldBlock = true;
    const starting = request(base + '/messages', { method: 'POST', body: { content: '使用文件', providerId: selectedProvider.id, files: [{ path: 'notes.md', sha256: hash('pinned version') }] } });
    await Promise.race([enteredGate, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Preflight did not enter read')), 5000); timer.unref(); })]);
    for (const [method, body] of [['PATCH', { model: 'changed' }], ['DELETE', {}]]) {
      const blocked = await request(`/api/providers/${selectedProvider.id}`, { method, body });
      assert.equal(blocked.status, 409); assert.equal(blocked.error.code, 'PROVIDER_BUSY');
    }
    assert.equal((await request(`/api/providers/${otherProvider.id}`, { method: 'PATCH', body: { model: 'allowed' } })).status, 200);
    assert.equal((await request(base, { method: 'DELETE', body: {} })).status, 409);
    assert.equal(calls, 0); assert.equal((await request(base)).session.providerId, 'demo');
    release(); const started = await starting; assert.equal(started.status, 202);
    const done = await terminal(request, base, started.runId);
    assert.equal(done.providerId, selectedProvider.id); assert.equal(usedProvider.id, selectedProvider.id); assert.equal(usedProvider.model, 'original'); assert.equal(calls, 1);
    assert.equal((await request(`/api/providers/${selectedProvider.id}`, { method: 'PATCH', body: { model: 'after-completion' } })).status, 200);
    const failed = await request(base + '/messages', { method: 'POST', body: { content: '过期文件', files: [{ path: 'notes.md', sha256: hash('old') }] } });
    assert.equal(failed.status, 409); assert.equal(failed.error.code, 'CONTEXT_FILE_CHANGED');
    assert.equal((await request(`/api/providers/${selectedProvider.id}`, { method: 'DELETE', body: {} })).status, 200);
    assert.equal((await request(base)).session.providerId, 'demo'); assert.equal(calls, 1);
  } finally { release(); await app.close(); }
});
