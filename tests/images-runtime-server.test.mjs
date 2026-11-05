// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { prepareImages } from '../core/image-attachments.mjs';

const fixtures = JSON.parse(await fs.readFile(new URL('./fixtures/image-attachments.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function fixture(t, { limits, providerCall } = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-images-http-'));
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace'), skillsDirectory = path.join(root, 'skills');
  await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(skillsDirectory);
  const store = new Store(dataDir);
  store.putProvider({ id: 'vision-fixture', type: 'openai', name: 'Local image fixture', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', toolMode: 'none', streaming: false, enabled: true }); store.close();
  const calls = []; let app, cookie, csrfToken;
  async function start() {
    app = await startServer({ dataDir, workspace, skillsDirectory, port: 0, runtimeOptions: {
      ...(limits ? { limits } : {}), providerCall: async (provider, request) => {
        calls.push(structuredClone({ providerId: provider.id, system: request.system, tools: request.tools, messages: request.messages }));
        return providerCall ? providerCall(provider, request) : { content: '图片测试完成。', toolCalls: [] };
      },
    } });
    const response = await fetch(app.url + '/api/bootstrap'); cookie = response.headers.get('set-cookie').split(';')[0]; const boot = await response.json(); csrfToken = boot.csrfToken; assert.equal(boot.capabilities.images, 1);
  }
  async function close() { const current = app; app = undefined; await current?.close(); }
  async function request(route, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const response = await fetch(app.url + route, { method, signal: AbortSignal.timeout(10_000), headers: { ...(auth ? { cookie, 'X-CSRF-Token': csrfToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.headers.get('cache-control'), 'no-store'); return { status: response.status, ...await response.json() };
  }
  async function session(providerId = 'vision-fixture') { const value = await request('/api/sessions', { method: 'POST', body: { providerId } }); assert.equal(value.status, 201); return value.session; }
  async function send(id, content, images, extra = {}) { return request(`/api/sessions/${id}/messages`, { method: 'POST', body: { content, ...(images === undefined ? {} : { images }), ...extra } }); }
  async function terminal(id, runId) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) { const value = (await request(`/api/sessions/${id}`)).session; if (value.run?.id === runId && value.run.finishedAt) return value; await pause(); }
    throw new Error('Image runtime fixture did not complete');
  }
  await start();
  t.after(async () => { await close(); const canonical = await fs.realpath(root); assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-images-http-[A-Za-z0-9]+$/u); await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, dataDir, workspace, calls, request, session, send, terminal, close, restart: async () => { await close(); await start(); } };
}

test('image-only and mixed messages preserve canonical images through HTTP, runtime, export and restart', async t => {
  const f = await fixture(t), session = await f.session(), canonical = prepareImages([fixtures.png_rgb, fixtures.jpeg_baseline]);
  const started = await f.send(session.id, '', [fixtures.png_rgb, fixtures.jpeg_baseline]); assert.equal(started.status, 202);
  const completed = await f.terminal(session.id, started.runId); assert.equal(completed.run.status, 'completed'); assert.equal(completed.title, '图片任务'); assert.equal(completed.messages[0].content, ''); assert.deepEqual(completed.messages[0].images, canonical);
  assert.deepEqual(f.calls[0].tools, []); assert.deepEqual(f.calls[0].messages[0].images, canonical);
  assert.doesNotMatch(f.calls[0].system, /iVBOR|\/9j\//u);
  const state = await f.request('/api/state'); assert.ok(!JSON.stringify(state).includes(canonical[0].data));
  const exported = await f.request('/api/export'); assert.deepEqual(exported.sessions.find(item => item.id === session.id).messages[0].images, canonical);
  await f.restart(); assert.deepEqual((await f.request(`/api/sessions/${session.id}`)).session.messages[0].images, canonical);
  const second = await f.send(session.id, '解释第二张图。', [fixtures.webp_lossless]); assert.equal(second.status, 202); const done = await f.terminal(session.id, second.runId); assert.equal(done.run.status, 'completed');
  assert.deepEqual(done.messages[2].images, prepareImages([fixtures.webp_lossless])); assert.deepEqual(f.calls[1].messages[0].images, canonical);
});

test('invalid images, forged canonical fields and unauthenticated input do not persist messages or call models', async t => {
  const f = await fixture(t), session = await f.session(), base = `/api/sessions/${session.id}`;
  assert.equal((await f.request(base + '/messages', { method: 'POST', auth: false, body: { content: '', images: [fixtures.png_rgb] } })).status, 401);
  assert.equal((await f.request(base + '/messages', { method: 'POST', headers: { 'X-CSRF-Token': 'wrong' }, body: { content: '', images: [fixtures.png_rgb] } })).status, 403);
  for (const images of [null, {}, [prepareImages([fixtures.png_rgb])[0]], [{ ...fixtures.png_rgb, data: 'PHN2Zz48L3N2Zz4=' }], [{ ...fixtures.png_rgb, url: 'https://fixture.invalid/file.png' }]]) assert.equal((await f.send(session.id, '无效图片', images)).status, 400);
  assert.equal((await f.send(session.id, '', [])).status, 400);
  assert.equal((await f.send(session.id, '过多图片', Array(5).fill(fixtures.png_rgb))).status, 413);
  assert.deepEqual((await f.request(base)).session, session); assert.equal(f.calls.length, 0); assert.equal((await f.request(base + '/runs')).runs.length, 0);
});

test('demo reports unsupported image input before creating a turn and request budgets never silently omit images', async t => {
  const f = await fixture(t), demo = await f.session('demo'); const unsupported = await f.send(demo.id, '', [fixtures.png_rgb]);
  assert.equal(unsupported.status, 400); assert.equal(unsupported.error.code, 'IMAGES_UNSUPPORTED'); assert.deepEqual((await f.request(`/api/sessions/${demo.id}`)).session.messages, []); assert.equal(f.calls.length, 0);
  const bounded = await fixture(t, { limits: { maxRequestBytes: 2200 } }), task = await bounded.session();
  const limited = await bounded.send(task.id, '图片内容必须全部保留。', [fixtures.png_palette, fixtures.jpeg_baseline, fixtures.webp_alpha]);
  assert.equal(limited.status, 413); assert.equal(limited.error.code, 'CONTEXT_TOO_LARGE'); assert.equal(bounded.calls.length, 0); assert.deepEqual((await bounded.request(`/api/sessions/${task.id}`)).session.messages, []);
});

test('branch copies server-owned image snapshots and preview never exposes encoded bytes', async t => {
  const f = await fixture(t), source = await f.session();
  const first = await f.send(source.id, '原图', [fixtures.png_rgb]); const before = await f.terminal(source.id, first.runId); const selected = before.messages[0];
  const base = `/api/sessions/${source.id}`, preview = await f.request(base + '/branch-preview?messageId=' + selected.id);
  assert.equal(preview.status, 200); assert.equal(preview.images[0].sha256, selected.images[0].sha256); assert.equal(preview.images[0].data, undefined); assert.ok(!JSON.stringify(preview).includes(selected.images[0].data));
  const input = { messageId: selected.id, expectedPrefixHash: preview.source.prefixHash, mode: 'message', content: '从另一个角度解释此图。', providerId: 'vision-fixture' };
  const forged = await f.request(base + '/branches', { method: 'POST', body: { ...input, images: [fixtures.webp_alpha] } }); assert.equal(forged.status, 400);
  const created = await f.request(base + '/branches', { method: 'POST', body: input }); assert.equal(created.status, 201);
  const done = await f.terminal(created.session.id, created.session.run.id); assert.equal(done.run.status, 'completed'); assert.deepEqual(done.messages[0].images, selected.images);
  assert.deepEqual(f.calls[1].messages[0].images, selected.images); assert.deepEqual((await f.request(base)).session, before);
});

test('an image-only source can be regenerated as an image-only branch without inventing text', async t => {
  const f = await fixture(t), source = await f.session(); const first = await f.send(source.id, '', [fixtures.png_rgba]); const before = await f.terminal(source.id, first.runId);
  const base = `/api/sessions/${source.id}`, selected = before.messages[0], preview = await f.request(base + '/branch-preview?messageId=' + selected.id);
  const created = await f.request(base + '/branches', { method: 'POST', body: { messageId: selected.id, expectedPrefixHash: preview.source.prefixHash, mode: 'message', content: '', providerId: 'vision-fixture' } });
  assert.equal(created.status, 201); const done = await f.terminal(created.session.id, created.session.run.id); assert.equal(done.messages[0].content, ''); assert.deepEqual(done.messages[0].images, selected.images);
});

test('manual handoff summarizes explicitly while automatic image summaries are rejected without a model call', async t => {
  const f = await fixture(t), source = await f.session(); const first = await f.send(source.id, '分析图片', [fixtures.webp_lossy]); const before = await f.terminal(source.id, first.runId);
  const base = `/api/sessions/${source.id}`, preview = await f.request(base + '/handoff-preview'); assert.equal(preview.status, 200); assert.ok(!JSON.stringify(preview).includes(before.messages[0].images[0].data));
  const automatic = await f.request(base + '/summary-preview', { method: 'POST', body: { expectedSourceHash: preview.source.hash, providerId: 'vision-fixture' } });
  assert.equal(automatic.status, 409); assert.equal(automatic.error.code, 'IMAGE_SUMMARY_UNAVAILABLE'); assert.equal(f.calls.length, 1);
  const created = await f.request(base + '/continuations', { method: 'POST', body: { requestId: randomUUID(), expectedSourceHash: preview.source.hash, summary: '用户审阅的文字摘要：这是一个测试色块。', content: '继续说明摘要。', providerId: 'vision-fixture' } });
  assert.equal(created.status, 201); const done = await f.terminal(created.session.id, created.session.run.id); assert.equal(done.messages[0].images, undefined); assert.ok(!JSON.stringify(f.calls[1]).includes(before.messages[0].images[0].data)); assert.deepEqual((await f.request(base)).session, before);
});

test('store rejects tampered image identity and assistant images before changing durable records', async t => {
  const f = await fixture(t), source = await f.session(); const started = await f.send(source.id, '持久化图片', [fixtures.png_rgb]); const original = await f.terminal(source.id, started.runId); await f.close();
  const store = new Store(f.dataDir);
  try {
    for (const mutate of [session => { session.messages[0].images[0].sha256 = '0'.repeat(64); }, session => { session.messages[0].images[0].width = 999; }, session => { session.messages[1].images = session.messages[0].images; }]) {
      const changed = structuredClone(original); mutate(changed); assert.throws(() => store.putSession(changed), { code: 'INVALID_IMAGES' }); assert.deepEqual(store.getSession(source.id), original);
    }
  } finally { store.close(); }
});

test('offline backup v8 roundtrips image messages and rejects tampered image content before restore creation', async t => {
  const f = await fixture(t), source = await f.session(); const started = await f.send(source.id, '', [fixtures.png_rgb, fixtures.jpeg_progressive, fixtures.webp_lossless]); const original = await f.terminal(source.id, started.runId); await f.close();
  const output = path.join(f.root, 'backup.json'), restored = path.join(f.root, 'restored');
  await createBackup({ dataDir: f.dataDir, workspace: f.workspace, output }); const archive = JSON.parse(await fs.readFile(output, 'utf8')); assert.equal(archive.version, 8);
  assert.deepEqual(archive.payload.sessions.find(session => session.id === source.id).messages[0].images, original.messages[0].images);
  await restoreBackup({ input: output, dataDir: restored }); const restoredStore = new Store(restored);
  try { assert.deepEqual(restoredStore.getSession(source.id).messages[0].images, original.messages[0].images); } finally { restoredStore.close(); }
  const corrupt = structuredClone(archive); corrupt.payload.sessions[0].messages[0].images[0].data = fixtures.webp_lossy.data; corrupt.sha256 = digest(JSON.stringify(corrupt.payload)); const bad = path.join(f.root, 'corrupt-backup.json'); await fs.writeFile(bad, JSON.stringify(corrupt));
  const rejectedTarget = path.join(f.root, 'rejected'); await assert.rejects(restoreBackup({ input: bad, dataDir: rejectedTarget }), { code: 'INVALID_BACKUP' }); await assert.rejects(fs.stat(rejectedTarget), { code: 'ENOENT' });
});
