// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { validateProvider } from '../core/providers.mjs';

const provider = { name: '模型能力测试', type: 'openai', model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1' };
const legacy = { ...provider, id: 'legacy-provider', enabled: true };
const hash = value => createHash('sha256').update(value).digest('hex');
async function temporary(t) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-tool-mode-'));
  t.after(async () => {
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function serverFixture(t, providers = []) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-tool-mode-http-'));
  const dataDir = path.join(root, 'data');
  let app, cookie, csrfToken;
  t.after(async () => {
    await app?.close();
    assert.equal(await fs.realpath(root), root);
    assert.equal(path.dirname(root), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(dataDir);
  const store = new Store(dataDir);
  try { for (const value of providers) store.putProvider(value); } finally { store.close(); }
  async function request(url, { method = 'GET', data } = {}) {
    const response = await fetch(app.url + url, {
      method, signal: AbortSignal.timeout(5000),
      headers: { ...(cookie ? { cookie } : {}), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  }
  async function restart() {
    await app?.close();
    app = await startServer({ dataDir });
    const response = await fetch(`${app.url}/api/bootstrap`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrfToken = (await response.json()).csrfToken;
  }
  await restart();
  return { request, restart };
}
async function until(read, match) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (match(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for task state');
}

test('HTTP defaults legacy and new connections to workspace while preserving none through edits and SQLite restart', async t => {
  const f = await serverFixture(t, [legacy]);
  for (const type of ['openai', 'responses', 'anthropic', 'ollama']) {
    const result = await f.request('/api/providers', { method: 'POST', data: { ...provider, type } });
    assert.equal(result.status, 201);
    assert.equal(result.data.provider.toolMode, 'workspace');
  }
  const migrated = await f.request(`/api/providers/${legacy.id}`, { method: 'PATCH', data: { name: '旧连接编辑' } });
  assert.equal(migrated.status, 200); assert.equal(migrated.data.provider.toolMode, 'workspace');
  const created = await f.request('/api/providers', { method: 'POST', data: { ...provider, toolMode: 'none' } });
  assert.equal(created.status, 201); assert.equal(created.data.provider.toolMode, 'none');
  const url = `/api/providers/${created.data.provider.id}`;
  for (const data of [{ name: '仅改名称' }, { model: 'other-model' }, { streaming: false }, { enabled: false }, { maxTokens: 2048 }]) {
    const edited = await f.request(url, { method: 'PATCH', data });
    assert.equal(edited.status, 200); assert.equal(edited.data.provider.toolMode, 'none');
  }
  await f.restart();
  const restored = (await f.request('/api/state')).data.providers.find(item => item.id === created.data.provider.id);
  assert.equal(restored.toolMode, 'none'); assert.equal(restored.enabled, false); assert.equal(restored.model, 'other-model');
  const edited = await f.request(url, { method: 'PATCH', data: { name: '重启后仅改名称' } });
  assert.equal(edited.status, 200); assert.equal(edited.data.provider.toolMode, 'none'); assert.equal(edited.data.provider.enabled, false);
  const explicit = await f.request(url, { method: 'PATCH', data: { toolMode: 'workspace' } });
  assert.equal(explicit.status, 200); assert.equal(explicit.data.provider.toolMode, 'workspace'); assert.equal(explicit.data.provider.enabled, false);
});

test('HTTP rejects malformed tool modes without creating or modifying providers', async t => {
  const f = await serverFixture(t);
  const created = await f.request('/api/providers', { method: 'POST', data: { ...provider, toolMode: 'none' } });
  assert.equal(created.status, 201);
  const initial = (await f.request('/api/state')).data.providers;
  for (const toolMode of [null, true, false, 0, '', 'NONE', 'auto', {}, ['none']]) {
    const posted = await f.request('/api/providers', { method: 'POST', data: { ...provider, toolMode } });
    assert.equal(posted.status, 400); assert.equal(posted.data.error.code, 'INVALID_PROVIDER');
    const patched = await f.request(`/api/providers/${created.data.provider.id}`, { method: 'PATCH', data: { toolMode, name: '不应保存' } });
    assert.equal(patched.status, 400); assert.equal(patched.data.error.code, 'INVALID_PROVIDER');
    assert.deepEqual((await f.request('/api/state')).data.providers, initial);
  }
  assert.equal((await f.request('/api/providers/demo', { method: 'PATCH', data: { toolMode: 'none' } })).status, 400);
  assert.equal((await f.request('/api/providers', { method: 'POST', data: { ...provider, type: 'demo', toolMode: 'none' } })).status, 400);
});

test('real HTTP tasks honor persisted toolMode and refuse capability changes until the active task finishes', async t => {
  const payloads = [];
  let heldResponse;
  const answer = res => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '确定性本机响应。' }, finish_reason: 'stop' }] }));
  };
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks)));
    if (payloads.length === 2) heldResponse = res; else answer(res);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const f = await serverFixture(t);
  const created = await f.request('/api/providers', { method: 'POST', data: { ...provider, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, toolMode: 'none', streaming: false } });
  assert.equal(created.status, 201);
  const providerUrl = `/api/providers/${created.data.provider.id}`;
  const task = await f.request('/api/sessions', { method: 'POST', data: { providerId: created.data.provider.id } });
  assert.equal(task.status, 201);
  const taskUrl = `/api/sessions/${task.data.session.id}`;
  const start = async () => assert.equal((await f.request(`${taskUrl}/messages`, { method: 'POST', data: { content: '请回复一行。' } })).status, 202);
  const finished = () => until(() => f.request(taskUrl), result => result.data.session.run?.status === 'completed');
  await start(); await finished();
  assert.equal(payloads.length, 1); assert.equal(Object.hasOwn(payloads[0], 'tools'), false);
  await start(); await until(async () => heldResponse, Boolean);
  const refused = await f.request(providerUrl, { method: 'PATCH', data: { toolMode: 'workspace' } });
  assert.equal(refused.status, 409); assert.equal(refused.data.error.code, 'PROVIDER_IN_USE');
  assert.equal((await f.request('/api/state')).data.providers.find(item => item.id === created.data.provider.id).toolMode, 'none');
  answer(heldResponse); await finished();
  assert.equal(Object.hasOwn(payloads[1], 'tools'), false);
  assert.equal((await f.request(providerUrl, { method: 'PATCH', data: { toolMode: 'workspace' } })).status, 200);
  await start(); const result = await finished();
  assert.equal(payloads.length, 3); assert.ok(payloads[2].tools.some(tool => tool.function.name === 'write_file'));
  assert.ok(result.data.session.run.steps.every(step => step.type === 'model'));
});

async function backupFixture(t) {
  const root = await temporary(t);
  const dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(dataDir, 'workspace'), { recursive: true });
  const store = new Store(dataDir);
  try {
    store.putProvider(legacy);
    store.putProvider({ ...legacy, id: 'text-provider', toolMode: 'none' });
    store.putProvider({ ...legacy, id: 'workspace-provider', toolMode: 'workspace' });
  } finally { store.close(); }
  return { root, dataDir, output: path.join(root, 'backup.json') };
}

test('offline backups preserve explicit capability modes and legacy absence while restored external providers stay disabled', async t => {
  const f = await backupFixture(t);
  await createBackup(f);
  const value = JSON.parse(await fs.readFile(f.output, 'utf8'));
  assert.equal(value.payload.providers.find(item => item.id === 'text-provider').toolMode, 'none');
  assert.equal(Object.hasOwn(value.payload.providers.find(item => item.id === legacy.id), 'toolMode'), false);
  const dataDir = path.join(f.root, 'restored');
  await restoreBackup({ input: f.output, dataDir });
  const restored = new Store(dataDir);
  try {
    for (const [id, toolMode] of [['text-provider', 'none'], ['workspace-provider', 'workspace'], [legacy.id, undefined]]) {
      const saved = restored.getProvider(id);
      assert.equal(saved.toolMode, toolMode); assert.equal(saved.enabled, false);
      assert.equal(validateProvider({ ...saved, enabled: true }).toolMode, toolMode ?? 'workspace');
    }
    assert.equal(restored.getProvider('demo').enabled, true);
  } finally { restored.close(); }
  const output = path.join(f.root, 'second-backup.json');
  await createBackup({ dataDir, output });
  const second = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(second.payload.providers.find(item => item.id === 'text-provider').toolMode, 'none');
});

test('recomputed backup checksums cannot authorize malformed modes, demo none, or unrelated fields', async t => {
  const f = await backupFixture(t); await createBackup(f);
  const original = JSON.parse(await fs.readFile(f.output, 'utf8'));
  const mutations = [
    ...[null, true, false, 0, '', 'NONE', 'auto', {}, ['none']].map(toolMode => p => { p.find(item => item.id === 'text-provider').toolMode = toolMode; }),
    p => { p.find(item => item.id === 'demo').toolMode = 'none'; },
    p => { p.find(item => item.id === 'text-provider').arbitraryExecution = true; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = structuredClone(original); mutate(value.payload.providers);
    value.sha256 = hash(JSON.stringify(value.payload));
    await fs.writeFile(f.output, JSON.stringify(value));
    const dataDir = path.join(f.root, `invalid-restored-${index}`);
    await assert.rejects(restoreBackup({ input: f.output, dataDir }), { code: 'INVALID_BACKUP' });
    await assert.rejects(fs.lstat(dataDir), { code: 'ENOENT' });
  }
});

test('backup creation fails closed for corrupt stored capability modes and leaves no output', async t => {
  const f = await backupFixture(t);
  for (const toolMode of [null, 'unsupported']) {
    const store = new Store(f.dataDir);
    try { store.putProvider({ ...legacy, id: 'text-provider', toolMode }); } finally { store.close(); }
    await assert.rejects(createBackup(f), { code: 'INVALID_BACKUP' });
    await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  }
});
