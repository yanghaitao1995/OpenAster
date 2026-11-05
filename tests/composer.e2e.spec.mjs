import { test as base, expect } from '@playwright/test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { createSlowProvider } from './fixtures/slow-provider.mjs';

// Real HTTP and a controlled loopback model, each on a random port. No shared
// browser-test service or native operating-system IME is used by this suite.
const test = base.extend({ local: async ({}, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const dataDir = await mkdtemp(resolve('test-results', 'composer-ui-'));
  const provider = await createSlowProvider(), providerId = randomUUID();
  const store = new Store(dataDir);
  store.putProvider({ id: providerId, type: 'openai', name: '输入交互测试', baseUrl: provider.url,
    model: 'local-composer-fixture', streaming: true, toolMode: 'none', enabled: true, maxTokens: 512 });
  store.close();
  const app = await startServer({ dataDir });
  try { await use({ app, provider, providerId }); }
  finally { await app.close(); await provider.close(); }
} });
// These timing tests gate requests with page.route. A service worker can own
// those requests before the route sees them, bypassing the fixture entirely.
test.use({ serviceWorkers: 'block' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function ready(page, local) {
  await page.goto(local.app.url);
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await page.locator('#model-select').selectOption(local.providerId);
}
async function settle(page) {
  await page.evaluate(async () => {
    await fetch('/api/health', { cache: 'no-store' });
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
}
async function finishRequest(request) { await request.emit('本机输入事件验证已完成。'); request.finish(); }
async function holdCreation(page) {
  const received = deferred(), release = deferred(); let request;
  await page.route('**/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    request = route.request(); const response = await route.fetch();
    received.resolve(); await release.promise; await route.fulfill({ response });
  });
  return { received: received.promise, release: release.resolve, async deliver() {
    const response = page.waitForResponse(item => item.request() === request);
    release.resolve(); await (await response).finished(); await settle(page);
  } };
}
function submissions(page) {
  const result = { creations: [], messages: [] };
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/sessions') result.creations.push(request);
    if (/^\/api\/sessions\/[^/]+\/messages$/.test(path)) result.messages.push(request.postDataJSON());
  });
  return result;
}

test('composer: first keyboard send retains input focus across the composer move and preserves the next draft', async ({ page, local }) => {
  await ready(page, local); const sent = submissions(page), held = await holdCreation(page);
  try {
    await page.locator('#prompt-input').fill('第一个任务'); await page.keyboard.press('Enter'); await held.received;
    await expect(page.locator('#prompt-input')).toBeFocused();
    // Draft edits while creation is pending must survive the first response.
    await page.keyboard.type('继续补充'); await held.deliver();
    await expect(page.locator('#chat-view')).toBeVisible(); await expect(page.locator('#prompt-input')).toBeFocused();
    await expect.poll(() => sent.messages.length).toBe(1);
    expect(sent.messages[0].content).toBe('第一个任务');
    await expect(page.locator('#prompt-input')).toHaveValue('第一个任务继续补充');
    await page.keyboard.press('Shift+Enter'); await page.keyboard.type('第二行');
    await expect(page.locator('#prompt-input')).toHaveValue('第一个任务继续补充\n第二行');
    expect(sent.creations).toHaveLength(1); expect(sent.messages).toHaveLength(1);
    await expect.poll(() => local.provider.requests.length).toBe(1);
    await finishRequest(local.provider.requests[0]);
  } finally { held.release(); }
});

test('composer: a first message failure preserves the keyboard focus and unsent text', async ({ page, local }) => {
  await ready(page, local);
  await page.route('**/api/sessions/*/messages', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'LOCAL_FIXTURE_FAILURE', message: '本机测试的预检失败' } }) }));
  await page.locator('#prompt-input').fill('失败后继续编辑'); await page.keyboard.press('Enter');
  await expect(page.locator('#toast-region')).toContainText('本机测试的预检失败');
  await expect(page.locator('#prompt-input')).toBeFocused(); await expect(page.locator('#prompt-input')).toHaveValue('失败后继续编辑');
  await page.keyboard.type('，补充说明'); await expect(page.locator('#prompt-input')).toHaveValue('失败后继续编辑，补充说明');
  expect(local.provider.requests).toHaveLength(0);
});

test('composer: late creation does not steal focus from another control or an open dialog', async ({ page, local }) => {
  await ready(page, local);
  for (const interaction of ['control', 'dialog']) {
    await page.keyboard.press('Control+k'); await page.locator('#model-select').selectOption(local.providerId);
    const held = await holdCreation(page);
    try {
      await page.locator('#prompt-input').fill(`延迟响应 ${interaction}`); await page.keyboard.press('Enter'); await held.received;
      if (interaction === 'control') await page.locator('[data-action=theme]').click();
      else await page.locator('[data-action=help]').click();
      await page.evaluate(() => { globalThis.__composerChosenFocus = document.activeElement; });
      await held.deliver();
      await expect.poll(() => page.evaluate(() => document.activeElement === globalThis.__composerChosenFocus)).toBe(true);
      if (interaction === 'dialog') { await expect(page.locator('#app-dialog')).toBeVisible(); await page.keyboard.press('Escape'); }
      await expect.poll(() => local.provider.requests.length).toBe(interaction === 'control' ? 1 : 2);
      await finishRequest(local.provider.requests.at(-1));
      await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
    } finally { held.release(); await page.unroute('**/api/sessions'); }
  }
});

test('composer: navigation during creation stays selected when the response arrives', async ({ page, local }) => {
  await ready(page, local); const held = await holdCreation(page);
  try {
    await page.locator('#prompt-input').fill('创建期间离开对话'); await page.keyboard.press('Enter'); await held.received;
    await page.locator('.nav-item[data-action=workspace]').click();
    await expect(page.locator('#workspace-view')).toBeVisible();
    await page.evaluate(() => { globalThis.__composerChosenFocus = document.activeElement; });
    await held.deliver(); await expect(page.locator('#workspace-view')).toBeVisible();
    expect(await page.evaluate(() => document.activeElement === globalThis.__composerChosenFocus)).toBe(true);
    await expect.poll(() => local.provider.requests.length).toBe(1); await finishRequest(local.provider.requests[0]);
  } finally { held.release(); }
});

test('composer: reconnecting the gateway invalidates late creation without submitting its old prompt', async ({ page, local }) => {
  await ready(page, local); const sent = submissions(page), held = await holdCreation(page);
  try {
    await page.locator('#prompt-input').fill('不得在重连后发送旧内容'); await page.keyboard.press('Enter'); await held.received;
    await page.locator('.nav-item[data-action=settings]').click();
    await page.locator('#settings-view [data-action=gateway]').click(); await page.locator('#field-url').fill('');
    await page.locator('#dialog-submit').click(); await expect(page.locator('#app-dialog')).not.toBeVisible();
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    // Reauthenticating to the same origin and storage identity restores only
    // the local draft; it must not resume the interrupted send chain.
    await expect(page.locator('#prompt-input')).toHaveValue('不得在重连后发送旧内容');
    await page.locator('[data-action=theme]').click();
    await held.deliver(); await expect(page.locator('#home-view')).toBeVisible();
    await expect(page.locator('#prompt-input')).toHaveValue('不得在重连后发送旧内容');
    await expect(page.locator('[data-action=theme]')).toBeFocused(); expect(sent.messages).toEqual([]);
    expect(local.provider.requests).toHaveLength(0);
  } finally { held.release(); }
});

test('composer: composition state protects Enter even when its key event lacks composition flags', async ({ page, local }) => {
  await ready(page, local); const sent = submissions(page);
  await page.locator('#prompt-input').fill('中文选词');
  await page.locator('#prompt-input').evaluate(node => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: false, bubbles: true, cancelable: true }));
  });
  await settle(page); expect(sent.creations).toEqual([]); expect(sent.messages).toEqual([]);
  await expect(page.locator('#prompt-input')).toHaveValue('中文选词');
});

test('composer: immediate composition-end Enter is ignored and a later intentional Enter sends once', async ({ page, local }) => {
  await ready(page, local); const sent = submissions(page);
  await page.locator('#prompt-input').fill('完成中文选词');
  await page.locator('#prompt-input').evaluate(node => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '词' }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: false, bubbles: true, cancelable: true }));
  });
  await settle(page); expect(sent.creations).toEqual([]); expect(sent.messages).toEqual([]);
  // A real elapsed boundary, not an operating-system IME claim.
  await page.waitForTimeout(80); await page.keyboard.press('Enter');
  await expect.poll(() => sent.messages.length).toBe(1);
  expect(sent.creations).toHaveLength(1); expect(sent.messages[0].content).toBe('完成中文选词');
  await expect.poll(() => local.provider.requests.length).toBe(1); await finishRequest(local.provider.requests[0]);
});

test('composer: repeated Enter cannot resubmit a later draft and Shift Enter remains a newline', async ({ page, local }) => {
  await ready(page, local); const sent = submissions(page);
  await page.locator('#prompt-input').fill('第一次明确发送'); await page.keyboard.press('Enter');
  await expect.poll(() => local.provider.requests.length).toBe(1); await finishRequest(local.provider.requests[0]);
  await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
  await page.locator('#prompt-input').fill('下一条尚未发送');
  await page.locator('#prompt-input').dispatchEvent('keydown', { key: 'Enter', keyCode: 13, repeat: true, bubbles: true, cancelable: true });
  await settle(page); expect(sent.messages).toHaveLength(1);
  await page.keyboard.press('Shift+Enter'); await page.keyboard.type('继续编辑');
  await expect(page.locator('#prompt-input')).toHaveValue('下一条尚未发送\n继续编辑'); expect(sent.messages).toHaveLength(1);
  await page.keyboard.press('Enter'); await expect.poll(() => sent.messages.length).toBe(2);
  expect(sent.messages[1].content).toBe('下一条尚未发送\n继续编辑');
  await expect.poll(() => local.provider.requests.length).toBe(2); await finishRequest(local.provider.requests[1]);
});
