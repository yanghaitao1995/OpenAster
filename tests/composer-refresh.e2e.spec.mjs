// SPDX-License-Identifier: Apache-2.0
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const notSent = '正在读取任务，本次尚未发送。草稿已保留，请读取完成后再次发送。';

// Every test owns its real HTTP server and persisted conversations. No model
// endpoint, shared test port, operating-system IME or production workspace is used.
const test = base.extend({ local: async ({ page }, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results', 'composer-refresh-'));
  const dataDir = join(root, 'data'), store = new Store(dataDir), sessions = [], gates = [];
  for (const title of ['刷新中的任务甲', '另一个任务乙']) {
    const session = store.createSession({ title, providerId: 'demo' });
    session.messages = [
      { id: randomUUID(), role: 'user', content: title + '的原始问题', createdAt: new Date().toISOString() },
      { id: randomUUID(), role: 'assistant', content: title + '的完整保存答复', createdAt: new Date().toISOString() },
    ];
    store.putSession(session); sessions.push(session);
  }
  store.close();
  const app = await startServer({ dataDir });
  try { await use({ app, sessions, gates }); }
  finally {
    // Resolve interception before closing its browser transport or HTTP service;
    // a real route.fetch failure must remain a test failure, not be swallowed.
    for (const gate of gates) gate.resolve();
    try { await page.unrouteAll({ behavior: 'wait' }); }
    finally { try { await page.context().close(); } finally { await app.close(); } }
  }
} });
// Route gates must see the browser's actual request, rather than a worker-owned
// request that bypasses Playwright interception.
test.use({ serviceWorkers: 'block' });

async function frame(page) {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}
async function ready(page, local) {
  await page.goto(local.app.url);
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').click();
  await page.locator(`.session-link[data-id="${local.sessions[0].id}"]`).click();
  await expect(page.locator('#messages')).toContainText(local.sessions[0].messages[1].content);
}
function submissions(page) {
  const sent = [];
  page.on('request', request => {
    const match = /^\/api\/sessions\/([^/]+)\/messages$/.exec(new URL(request.url()).pathname);
    if (match && request.method() === 'POST') sent.push({ sessionId: decodeURIComponent(match[1]), body: request.postDataJSON() });
  });
  return sent;
}
async function holdHistory(page, local, id) {
  const captured = deferred(), release = deferred(), pending = new Set(); let released = false;
  local.gates.push(release);
  const match = url => url.pathname === `/api/sessions/${id}`;
  const handler = async route => {
    if (released || route.request().method() !== 'GET') return route.continue();
    const work = (async () => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      captured.resolve(); await release.promise; await route.fulfill({ response });
    })();
    pending.add(work);
    try { await work; } finally { pending.delete(work); }
  };
  await page.route(match, handler);
  return { captured: captured.promise, async finish() {
    released = true; release.resolve();
    await Promise.all([...pending]); await page.unroute(match, handler); await frame(page);
  } };
}
async function triggerRefresh(page, held) {
  // Synthetic visibility initiates the production refresh path. All pointer and
  // keyboard inputs below use real browser input, not dispatched click events.
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await held.captured;
}
async function expectHistoryBlocked(page, draft) {
  const send = page.locator('#send-button');
  await expect(send).toHaveAttribute('aria-disabled', 'true');
  expect(await send.evaluate(node => node.disabled)).toBe(false);
  await expect(page.locator('#send-hint')).toHaveText('读取中…');
  await expect(send).toHaveAttribute('title', /读取/);
  const description = await send.evaluate(node => (node.getAttribute('aria-describedby') || '').split(/\s+/)
    .filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' '));
  expect(description).toContain('读取中');
  await expect(page.locator('#prompt-input')).toHaveValue(draft);
}
async function expectHistoryReady(page) {
  await expect(page.locator('#send-button')).not.toHaveAttribute('aria-disabled', 'true');
  expect(await page.locator('#send-button').evaluate(node => node.disabled)).toBe(false);
}
async function dismissNotifications(page) {
  const close = page.locator('#toast-region').getByRole('button', { name: '关闭提示', exact: true });
  while (await close.count()) await close.first().click();
}
async function expectOneCompletedMessage(page, local, sent, session, content) {
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].sessionId).toBe(session.id); expect(sent[0].body.content).toBe(content);
  await expect.poll(async () => {
    const response = await page.request.get(`${local.app.url}/api/sessions/${session.id}`);
    expect(response.ok()).toBe(true); return (await response.json()).session.run?.status;
  }).toBe('completed');
  const response = await page.request.get(`${local.app.url}/api/sessions/${session.id}`);
  const saved = (await response.json()).session;
  expect(saved.messages.filter(message => message.role === 'user' && message.content === content)).toHaveLength(1);
  expect(sent).toHaveLength(1);
}

test('composer refresh: a history refresh between mouse down and up explains the blocked send without replay', async ({ page, local }) => {
  await ready(page, local); const sent = submissions(page), draft = '刷新期间明确点击的下一条消息';
  await page.locator('#prompt-input').fill(draft); await expectHistoryReady(page);
  const held = await holdHistory(page, local, local.sessions[0].id);
  const send = page.locator('#send-button'), before = await send.boundingBox(); expect(before).not.toBeNull();
  await page.evaluate(() => {
    globalThis.composerRefreshEvents = [];
    for (const type of ['pointerdown', 'pointerup', 'click', 'submit']) document.addEventListener(type, event => {
      if ((type === 'submit' && event.target.id === 'composer') || event.target.closest?.('#send-button'))
        globalThis.composerRefreshEvents.push(type);
    }, true);
  });
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  try {
    await triggerRefresh(page, held); await expectHistoryBlocked(page, draft);
    expect(await send.boundingBox()).toEqual(before);
  } finally { await page.mouse.up(); }
  await expect(page.locator('#toast-region')).toContainText(notSent);
  expect(await page.evaluate(() => globalThis.composerRefreshEvents)).toEqual(['pointerdown', 'pointerup', 'click', 'submit']);
  expect(sent).toHaveLength(0); await expect(page.locator('#prompt-input')).toHaveValue(draft);
  await held.finish(); await expectHistoryReady(page); await frame(page);
  expect(sent).toHaveLength(0); await expect(page.locator('#prompt-input')).toHaveValue(draft);
  await dismissNotifications(page);
  await send.click(); await expectOneCompletedMessage(page, local, sent, local.sessions[0], draft);
});

test('composer refresh: Enter, Space and explicit form submission give feedback while the complete history is held', async ({ page, local }) => {
  await ready(page, local); const sent = submissions(page), draft = '所有发送入口都必须保留这份草稿';
  await page.locator('#prompt-input').fill(draft); await expectHistoryReady(page);
  const held = await holdHistory(page, local, local.sessions[0].id);
  await triggerRefresh(page, held); await expectHistoryBlocked(page, draft);
  const actions = [
    () => page.locator('#prompt-input').press('Enter'),
    async () => { await page.locator('#send-button').focus(); await page.keyboard.press('Space'); },
    async () => { await page.locator('#send-button').focus(); await page.keyboard.press('Enter'); },
    () => page.locator('#composer').evaluate(form => form.requestSubmit()),
  ];
  for (const action of actions) {
    // Dismissing the prior notification proves each independent activation
    // reaches the guarded send handler and supplies its own explanation.
    await dismissNotifications(page);
    await action(); await expect(page.locator('#toast-region')).toContainText(notSent);
    await frame(page); expect(sent).toHaveLength(0); await expectHistoryBlocked(page, draft);
  }
  await held.finish(); await expectHistoryReady(page); await frame(page);
  expect(sent).toHaveLength(0); await expect(page.locator('#prompt-input')).toHaveValue(draft);
});

test('composer refresh: leaving the held task never replays its blocked send into another conversation', async ({ page, local }) => {
  await ready(page, local); const sent = submissions(page), draft = '切换任务后仍等待我的明确发送';
  await page.locator('#prompt-input').fill(draft); await expectHistoryReady(page);
  const held = await holdHistory(page, local, local.sessions[0].id);
  await triggerRefresh(page, held); await expectHistoryBlocked(page, draft);
  await page.locator('#prompt-input').press('Enter'); await expect(page.locator('#toast-region')).toContainText(notSent);
  await page.locator(`.session-link[data-id="${local.sessions[1].id}"]`).click();
  await expect(page.locator('#messages')).toContainText(local.sessions[1].messages[1].content);
  // A task's unsent draft is isolated from the task being opened.
  await expect(page.locator('#prompt-input')).toHaveValue('');
  await expect(page.locator('#send-button')).toBeDisabled(); expect(sent).toHaveLength(0);
  await held.finish(); await frame(page);
  await expect(page.locator('#chat-title')).toHaveText(local.sessions[1].title);
  await expect(page.locator('#messages')).toContainText(local.sessions[1].messages[1].content);
  await expect(page.locator('#messages')).not.toContainText(local.sessions[0].messages[1].content);
  await expect(page.locator('#prompt-input')).toHaveValue(''); expect(sent).toHaveLength(0);
  await page.locator(`.session-link[data-id="${local.sessions[0].id}"]`).click();
  await expect(page.locator('#messages')).toContainText(local.sessions[0].messages[1].content);
  await expect(page.locator('#prompt-input')).toHaveValue(draft);
  await expectHistoryReady(page); expect(sent).toHaveLength(0);
  await dismissNotifications(page);
  await page.locator('#send-button').click(); await expectOneCompletedMessage(page, local, sent, local.sessions[0], draft);
  const response = await page.request.get(`${local.app.url}/api/sessions/${local.sessions[1].id}`);
  const unchanged = (await response.json()).session;
  expect(unchanged.messages).toEqual(local.sessions[1].messages);
  expect(unchanged.approvals).toEqual([]); expect(unchanged.run).toBeNull();
});

for (const state of [
  { name: 'desktop-light', viewport: { width: 1440, height: 960 }, theme: 'light' },
  { name: 'mobile-dark', viewport: { width: 390, height: 844 }, theme: 'dark' },
]) test(`composer refresh: held-history accessibility and explanatory state, ${state.name}`, async ({ page, local }, info) => {
  await page.setViewportSize(state.viewport);
  await page.addInitScript(theme => localStorage.setItem('openaster.theme', theme), state.theme);
  await ready(page, local); const sent = submissions(page), draft = '读取完成后，我会再次明确发送。';
  expect(await page.locator('body').evaluate(body => body.classList.contains('dark'))).toBe(state.theme === 'dark');
  await page.locator('#prompt-input').fill(draft); await expectHistoryReady(page);
  const held = await holdHistory(page, local, local.sessions[0].id);
  await triggerRefresh(page, held); await expectHistoryBlocked(page, draft);
  if (state.name === 'desktop-light') {
    // The guarded button stays in the real Tab order while exposing its
    // unavailable state. No synthetic click or focusability-only assertion.
    await page.locator('.skill-toggle').focus(); await page.keyboard.press('Tab');
    await expect(page.locator('#send-button')).toBeFocused();
  }
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  await info.attach(`composer-refresh-waiting-${state.name}`, {
    body: JSON.stringify({ violations: result.violations, incomplete: result.incomplete }), contentType: 'application/json',
  });
  const screenshot = info.outputPath(`composer-refresh-waiting-${state.name}.png`);
  await page.screenshot({ path: screenshot, animations: 'disabled' });
  await info.attach(`composer-refresh-waiting-${state.name}-screenshot`, { path: screenshot, contentType: 'image/png' });
  expect(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
  if (state.name === 'desktop-light') {
    await page.keyboard.press('Space'); await expect(page.locator('#toast-region')).toContainText(notSent);
  }
  expect(sent).toHaveLength(0); await expect(page.locator('#prompt-input')).toHaveValue(draft);
  await held.finish(); await expectHistoryReady(page); await frame(page);
  expect(sent).toHaveLength(0); await expect(page.locator('#prompt-input')).toHaveValue(draft);
});
