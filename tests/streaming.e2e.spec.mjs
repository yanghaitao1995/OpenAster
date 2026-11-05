import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';
import { createSlowProvider } from './fixtures/slow-provider.mjs';

// Every test has independent random loopback ports and disposable local data.
// This suite does not use or occupy the shared 4318 browser-test server.
const test = base.extend({
  local: async ({}, use) => {
    await mkdir(resolve('test-results'), { recursive: true });
    const provider = await createSlowProvider();
    const dataDir = await mkdtemp(resolve('test-results', 'stream-ui-'));
    const app = await startServer({ dataDir });
    try { await use({ app, provider, dataDir }); } finally { await app.close(); await provider.close(); }
  }
});
async function connect(page, local) {
  await page.goto(local.app.url); await expect(page.locator('#top-status')).toHaveText('本地已连接');
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').click();
  await page.locator('.nav-item[data-action=settings]').click(); await page.locator('[data-action=add-provider]').click();
  await page.locator('#field-name').fill('本机流式测试'); await page.locator('#field-baseUrl').fill(local.provider.url); await page.locator('#field-model').fill('controlled-local-model');
  await expect(page.locator('#field-streaming')).toHaveValue('true');
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/providers' && response.request().method() === 'POST');
  await page.locator('#dialog-submit').click(); const { provider } = await (await saved).json();
  await expect(page.locator('#app-dialog')).not.toBeVisible();
  await page.keyboard.press('Control+k'); await page.locator('#model-select').selectOption(provider.id);
  return provider;
}
async function send(page, content) { await page.locator('#prompt-input').fill(content); await page.locator('#send-button').click(); }
async function accessiblePartial(page, testInfo, state) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
  await testInfo.attach(state,{body:JSON.stringify({violations:results.violations,incomplete:results.incomplete}),contentType:'application/json'});
  expect(results.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
}
async function edit(page) {
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').click();
  await page.locator('.nav-item[data-action=settings]').click(); await page.getByRole('button', { name: '编辑模型 本机流式测试' }).click();
}

test('stream: partial Chinese text, safe DOM, focus and reading position survive incremental refresh', async ({ page, local }, testInfo) => {
  await connect(page, local); await send(page, '```text\n保留这个代码按钮的焦点\n```');
  const request = await local.provider.nextRequest(); expect(request.input.stream).toBe(true);
  await request.emit('这是尚未完成的中文片段。\n正在整理参考内容，后续文字会在这里逐步显示。\n');
  await expect(page.locator('.pending-output')).toContainText('这是尚未完成的中文片段');
  await expect(page.locator('.output-status')).toHaveText('正在生成 · 未完成'); await expect(page.locator('.message.assistant')).toHaveCount(0);
  await accessiblePartial(page,testInfo,'desktop-partial-light'); await page.screenshot({ path: resolve('test-results','streaming-desktop.png'), animations: 'disabled' });
  await page.locator('[data-action=theme]').click(); await accessiblePartial(page,testInfo,'desktop-partial-dark'); await page.locator('[data-action=theme]').click();
  await page.evaluate(() => { globalThis.__originalUser = document.querySelector('.message.user'); globalThis.__originalCopy = globalThis.__originalUser.querySelector('.code-heading button'); globalThis.__originalCopy.focus({ preventScroll: true }); });
  const unrelated = []; page.on('request', req => { if (/\/api\/(state|audit|workspace\/files)$/.test(new URL(req.url()).pathname)) unrelated.push(req.url()); });
  await request.emit('<img src=x onerror="window.__streamXss=1">\n' + '继续输出一行参考内容。\n'.repeat(60)); await expect(page.locator('.stream-content')).toContainText('继续输出一行参考内容');
  await expect.poll(() => page.locator('.conversation-scroll').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(8);
  await page.locator('.conversation-scroll').evaluate(node => { node.scrollTop = 0; });
  await request.emit('\n最后一批仍未完成的内容。\n'.repeat(20)); await expect(page.locator('.stream-content')).toContainText('最后一批仍未完成的内容');
  expect(await page.locator('.conversation-scroll').evaluate(node => node.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.querySelector('.message.user') === globalThis.__originalUser && document.activeElement === globalThis.__originalCopy)).toBe(true);
  expect(unrelated).toEqual([]); expect(await page.evaluate(() => globalThis.__streamXss)).toBeUndefined();
  request.finish(); await ensureDetails(page);await expect(page.locator('.run-status')).toHaveText('已完成'); await expect(page.locator('.pending-output')).toHaveCount(0);
  await expect(page.locator('.message.assistant')).toHaveCount(1); await expect(page.locator('.message.assistant')).toContainText('这是尚未完成的中文片段');
  await expect(page.locator('.message.assistant img,.message.assistant script')).toHaveCount(0);
});

test('stream: mobile reload resumes saved output and cancel retains explicitly unfinished text', async ({ page, local }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await connect(page, local); await send(page, '保留取消前的部分输出');
  const request = await local.provider.nextRequest(); await request.emit('已经收到的中文内容，仍然没有完成。');
  await expect(page.locator('.stream-content')).toContainText('已经收到的中文内容');
  await page.reload(); await expect(page.locator('#chat-view')).toBeVisible(); await expect(page.locator('.stream-content')).toContainText('已经收到的中文内容');
  await request.emit('\n刷新后继续收到新片段。'); await expect(page.locator('.stream-content')).toContainText('刷新后继续收到新片段');
  await accessiblePartial(page,testInfo,'mobile-partial-light');
  const reconnected = page.waitForRequest(req => new URL(req.url()).pathname === '/api/events');
  local.app.server.closeAllConnections(); await request.emit('\n事件连接恢复后仍然可见的片段。');
  await reconnected; await expect(page.locator('.stream-content')).toContainText('事件连接恢复后仍然可见的片段');
  await page.locator('#cancel-button').click(); await expect(page.locator('.task-status-badge.cancelled').first()).toHaveText('已停止');
  await expect(page.locator('.output-status')).toHaveText('已中断 · 未完成'); await expect(page.locator('.message.assistant')).toHaveCount(0);
  await page.reload(); await expect(page.locator('.output-status')).toHaveText('已中断 · 未完成'); await expect(page.locator('.stream-content')).toContainText('刷新后继续收到新片段');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(request.closed).toBe(true);
});

test('stream: background task events do not change the selected task and reopening reads its latest snapshot', async ({ page, local }) => {
  await connect(page, local); await send(page, '第一项任务在后台逐步输出');
  const request = await local.provider.nextRequest(); await request.emit('仅属于第一项任务的片段'); await expect(page.locator('.stream-content')).toContainText('仅属于第一项任务');
  const backgroundId = await page.evaluate(() => sessionStorage.getItem('openaster.current-session'));
  await page.keyboard.press('Control+k'); await page.locator('#model-select').selectOption({ label: '本地演示' }); await send(page, '第二项任务读取文件清单'); await ensureDetails(page);await expect(page.locator('.run-status')).toHaveText('已完成');
  const selected = await page.locator('#messages').textContent();
  const fetched = []; page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/sessions/'+backgroundId)) fetched.push(req.url()); });
  await request.emit('，后台又增加了一段内容。');
  // Longer than two snapshot/refresh intervals: an unwanted refresh would occur.
  await page.waitForTimeout(700); expect(await page.locator('#messages').textContent()).toBe(selected); expect(fetched).toEqual([]);
  await page.locator('.session-link').filter({ hasText: '第一项任务在后台逐步输出' }).click(); await expect(page.locator('.stream-content')).toContainText('后台又增加了一段内容');
  request.finish(); await ensureDetails(page);await expect(page.locator('.run-status')).toHaveText('已完成'); await expect(page.locator('.message.assistant')).toHaveCount(1);
});

test('stream: provider response mode persists and compatibility mode waits for a complete response', async ({ page, local }) => {
  const provider = await connect(page, local); expect(provider.streaming).toBe(true); await edit(page);
  await page.locator('#field-streaming').selectOption('false'); await page.locator('#dialog-submit').click(); await expect(page.locator('#app-dialog')).not.toBeVisible();
  await page.reload(); await expect(page.locator('#top-status')).toHaveText('本地已连接'); await edit(page); await expect(page.locator('#field-streaming')).toHaveValue('false'); await page.locator('.dialog-heading [data-action=close-dialog]').click();
  await page.keyboard.press('Control+k'); await page.locator('#model-select').selectOption(provider.id); await send(page, '使用兼容模式获得完整回答');
  const request = await local.provider.nextRequest(); expect(request.input.stream).toBe(false); await request.emit('兼容模式的完整中文回答。');
  await expect(page.locator('.pending-output')).toHaveCount(0); await expect(page.locator('.message.assistant')).toHaveCount(0);
  request.finish(); await expect(page.locator('.message.assistant')).toContainText('兼容模式的完整中文回答'); await ensureDetails(page);await expect(page.locator('.run-status')).toHaveText('已完成');
  await edit(page); await page.locator('#field-streaming').selectOption('true');
  // Hold state reads, then let a newer refresh supersede the save's own read.
  // Reopening must use the acknowledged provider even while that newest read
  // remains pending. No wait or stale form can stand in for the saved result.
  const held = []; let holding = true;
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    if (holding) { const release = deferred(); held.push(release); await release.promise; }
    await route.fulfill({ response });
  });
  try {
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/providers/'+provider.id);
    await page.locator('#dialog-submit').click(); const acknowledged = await saved; await acknowledged.finished();
    expect((await acknowledged.json()).provider.streaming).toBe(true);
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await expect.poll(() => held.length).toBeGreaterThanOrEqual(1); const earlier = held.length;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => held.length).toBeGreaterThan(earlier);
    for (const pending of held.slice(0, earlier)) pending.resolve();
    await expect(page.locator('#app-dialog')).not.toBeVisible();
    await page.getByRole('button', { name: '编辑模型 本机流式测试' }).click(); await expect(page.locator('#field-streaming')).toHaveValue('true');
  } finally { holding = false; for (const pending of held) pending.resolve(); await page.unrouteAll({ behavior: 'wait' }); }
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function holdNextOutput(page) {
  const received = deferred(), release = deferred(); let request;
  const response = page.waitForResponse(item => item.request() === request);
  await page.route('**/api/sessions/*/output', async route => {
    if (request) return route.continue();
    request = route.request(); const original = await route.fetch();
    received.resolve(await original.json()); await release.promise;
    await route.fulfill({ response: original });
  });
  return {
    received: received.promise, release: release.resolve,
    async delivered() {
      await (await response).finished();
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    }
  };
}

test('stream: a one MiB conversation uses only narrow output snapshots between state changes', async ({ page, local }) => {
  const provider = await connect(page, local); const now = new Date().toISOString(), id = randomUUID();
  const messages = Array.from({ length: 18 }, (_, index) => ({ id: randomUUID(), role: index % 2 ? 'assistant' : 'user', content: '历史参考。'.repeat(4000), createdAt: now }));
  const session = { id, title: '约一 MiB 的既有会话', providerId: provider.id, createdAt: now, updatedAt: now, messages, approvals: [], run: null };
  const serialized = JSON.stringify(session); expect(Buffer.byteLength(serialized)).toBeGreaterThan(1024 * 1024);
  const db = new DatabaseSync(resolve(local.dataDir, 'openaster.sqlite'));
  try { db.prepare('INSERT INTO sessions(id,updated_at,value) VALUES(?,?,?)').run(id, now, serialized); } finally { db.close(); }
  // Finish the reload's initial SSE state refresh before choosing the task; a
  // later startup refresh would otherwise invalidate its loaded history at Send.
  const initialState = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/state');
  await page.reload(); await (await initialState).finished();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  const fullHistory = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/sessions/'+id);
  await page.locator('.session-link').filter({ hasText: session.title }).click(); await (await fullHistory).finished();
  await expect(page.locator('.message')).toHaveCount(18); await expect(page.locator('#send-hint')).toHaveText('Enter 发送');
  await send(page, '继续这个已有的长会话'); const request = await local.provider.nextRequest();
  expect(Buffer.byteLength(JSON.stringify(request.input.messages))).toBeGreaterThan(1024 * 1024);
  // Keep the provider silent until the persisted connecting attempt has reached
  // the UI through its startup full-history refresh. Only then advance the stream
  // and measure output-only reads; startup state changes are outside that window.
  await expect(page.locator('.execution-step-detail')).toContainText('连接次数：1');
  await expect(page.locator('.execution-step-state')).toHaveText('正在连接模型');
  await expect(page.locator('#send-hint')).toHaveText('Enter 发送');
  await request.emit('第一段内容。'); await expect(page.locator('.stream-content')).toContainText('第一段内容');
  const fullReads = [], drafts = [], bodies = [];
  page.on('request', req => { if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/sessions/'+id) fullReads.push(req.url()); });
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/sessions/'+id+'/output') bodies.push(response.json().then(value => drafts.push(value)));
  });
  for (let index = 1; index <= 5; index++) {
    await request.emit(`\n第 ${index} 次增量片段。`); await expect(page.locator('.stream-content')).toContainText(`第 ${index} 次增量片段`);
  }
  await Promise.all(bodies); expect(fullReads).toEqual([]); expect(drafts.length).toBeGreaterThanOrEqual(5);
  for (const snapshot of drafts) {
    expect(Object.keys(snapshot).sort()).toEqual(['run','sessionId','updatedAt']);
    expect(Object.keys(snapshot.run).sort()).toEqual(['id','output','status']);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(2000);
  }
  request.finish(); await ensureDetails(page);await expect(page.locator('.run-status')).toHaveText('已完成'); await expect(page.locator('.message.assistant')).toHaveCount(10);
  await expect(page.locator('.pending-output')).toHaveCount(0);
});

test('stream: a delayed draft cannot replace the final full-session answer', async ({ page, local }) => {
  await connect(page, local); await send(page, '测试终态优先于迟到的草稿'); const request = await local.provider.nextRequest();
  await request.emit('先到达的部分文字。'); await expect(page.locator('.stream-content')).toContainText('先到达');
  const held = await holdNextOutput(page);
  try {
    await request.emit('这段草稿响应会在任务完成之后到达。'); const stale = await held.received; expect(stale.run.status).toBe('running');
    request.finish(); await ensureDetails(page);await expect(page.locator('.run-status')).toHaveText('已完成'); await expect(page.locator('.pending-output')).toHaveCount(0);
    const completed = await page.locator('.message.assistant').textContent(); held.release(); await held.delivered();
    await ensureDetails(page);await expect(page.locator('.run-status')).toHaveText('已完成'); await expect(page.locator('.pending-output')).toHaveCount(0);
    expect(await page.locator('.message.assistant').textContent()).toBe(completed);
  } finally { held.release(); }
});

test('stream: leaving and reopening a task invalidates its delayed draft while newer snapshots continue', async ({ page, local }) => {
  await connect(page, local); await send(page, '导航切换之后恢复当前片段'); const request = await local.provider.nextRequest();
  await request.emit('已经显示的第一段。'); await expect(page.locator('.stream-content')).toContainText('已经显示的第一段');
  const held = await holdNextOutput(page);
  try {
    await request.emit('这是需要延迟的第二段。'); await held.received;
    await page.locator('.nav-item[data-action=workspace]').click(); await expect(page.locator('#workspace-view')).toBeVisible();
    await request.emit('离开页面后生成的最新第三段。');
    await page.keyboard.press('Control+k'); await page.locator('#prompt-input').fill('保留另一个任务的草稿');
    await page.locator('.session-link').filter({ hasText: '导航切换之后恢复当前片段' }).click();
    await expect(page.locator('.stream-content')).toContainText('最新第三段');
    // A late response from the prior visit must not block the current visit's
    // narrow reads, even before that previous request has been released.
    await request.emit('重新进入后继续生成的第四段。'); await expect(page.locator('.stream-content')).toContainText('第四段');
    held.release(); await held.delivered(); await expect(page.locator('.stream-content')).toContainText('第四段');
    await ensureDetails(page);await expect(page.locator('.run-status')).toHaveText('正在执行');
    request.finish(); await ensureDetails(page);await expect(page.locator('.run-status')).toHaveText('已完成'); await expect(page.locator('.message.assistant')).toHaveCount(1);
  } finally { held.release(); }
});

test('stream: a disabled selected connection stays unavailable without silent fallback and can be enabled without changing task associations', async ({ page, local }) => {
  const provider = await connect(page, local);
  const session = await page.evaluate(async providerId => {
    const { csrfToken } = await (await fetch('/api/bootstrap')).json();
    const response = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ providerId, title: '停用后仍保留模型关联' }) });
    return (await response.json()).session;
  }, provider.id);
  await edit(page); await expect(page.getByRole('checkbox', { name: '启用此连接' })).toBeChecked();
  await page.getByRole('checkbox', { name: '启用此连接' }).uncheck(); await page.locator('#dialog-submit').click(); await expect(page.locator('#app-dialog')).not.toBeVisible();
  const row = page.locator('.provider-row').filter({ hasText: '本机流式测试' }); await expect(row).toContainText('已停用'); await expect(row.locator('[data-action="test-provider"]')).toBeDisabled();
  await page.keyboard.press('Control+k');
  const selectedOption=page.locator(`#model-select option[value="${provider.id}"]`);
  await expect(selectedOption).toHaveCount(1); await expect(selectedOption).toHaveJSProperty("disabled", true); await expect(selectedOption).toHaveText('原模型不可用，请重新选择'); await expect(page.locator('#model-select')).toHaveValue(provider.id);
  const posts=[];page.on('request',request=>{if(request.method()==='POST'&&/^\/api\/sessions(?:\/[^/]+\/messages)?$/.test(new URL(request.url()).pathname))posts.push(request);});
  await page.locator('#prompt-input').fill('停用模型不得静默改用其他连接');await expect(page.locator('#send-button')).toBeDisabled();await page.locator('#prompt-input').press('Enter');await expect(page.locator('#toast-region')).toContainText('请选择可用的模型和技能后再发送');expect(posts).toHaveLength(0);expect(local.provider.requests).toHaveLength(0);
  await edit(page); await expect(page.getByRole('checkbox', { name: '启用此连接' })).not.toBeChecked(); await page.getByRole('checkbox', { name: '启用此连接' }).check();
  await page.locator('#dialog-submit').click(); await expect(page.locator('#app-dialog')).not.toBeVisible(); await expect(row).not.toContainText('已停用');
  await page.keyboard.press('Control+k'); await expect(selectedOption).toHaveCount(1);await expect(selectedOption).toHaveJSProperty("disabled", false);await expect(page.locator('#model-select')).toHaveValue(provider.id);await expect(page.locator('#send-button')).toBeEnabled();expect(posts).toHaveLength(0);expect(local.provider.requests).toHaveLength(0);
  const restored = await page.evaluate(async id => (await (await fetch('/api/sessions/'+id)).json()).session, session.id); expect(restored.providerId).toBe(provider.id);
  await page.locator('.session-link').filter({ hasText: session.title }).click(); await expect(page.locator('#model-select')).toHaveValue(provider.id);
});

async function ensureDetails(page){
  await expect(page.locator('#context-toggle')).toBeVisible();
  if(await page.locator('#context-toggle').getAttribute('aria-expanded')==='false')await page.locator('#context-toggle').click();
  await expect(page.locator('#context-panel')).toBeVisible();
}
