import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startServer } from '../server/index.mjs';

// These tests execute the production page with the Android bridge shape that
// Capacitor JSExport injects. They do not prove Android system-bar pixels/Insets.
const test = base.extend({ local: async ({}, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results', 'theme-appearance-'));
  const app = await startServer({ dataDir: join(root, 'local') });
  const requests = [];
  app.server.on('request', req => requests.push({ method: req.method, path: req.url }));
  const away = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Owned navigation fixture</title><p>Return to the workbench</p>');
  });
  await new Promise(done => away.listen(0, '127.0.0.1', done));
  try { await use({ app, requests, away: `http://127.0.0.1:${away.address().port}` }); }
  finally { await new Promise(done => away.close(done)); await app.close(); }
} });
test.use({ serviceWorkers: 'block', launchOptions: { chromiumSandbox: true, ignoreDefaultArgs: ['--disable-back-forward-cache'] } });

async function bridge(page, { theme, platform = 'android', native = true, behavior = 'resolve' } = {}) {
  await page.addInitScript(({ theme, platform, native, behavior }) => {
    if (theme && localStorage.getItem('openaster.theme') === null) localStorage.setItem('openaster.theme', theme);
    const record = globalThis.appearanceFixture = { calls: [], registrations: [], active: 0, peak: 0, settled: 0, releases: [], lifecycle: [], identity: crypto.randomUUID() };
    for (const name of ['pagehide', 'pageshow']) window.addEventListener(name, event => record.lifecycle.push({ name, persisted: event.persisted }));
    const plugin = { setTheme(options) {
      record.calls.push(structuredClone(options));
      if (behavior === 'throw') throw new Error('fixture bridge unavailable');
      record.active++; record.peak = Math.max(record.peak, record.active);
      const promise = behavior === 'held' ? new Promise((done, fail) => record.releases.push(reject => reject ? fail(new Error('fixture rejection')) : done()))
        : behavior === 'reject' ? Promise.reject(new Error('fixture bridge unavailable')) : Promise.resolve();
      return promise.finally(() => { record.active--; record.settled++; });
    } };
    const capacitor = { isNativePlatform: () => native, getPlatform: () => platform,
      registerPlugin(name) { record.registrations.push(name); if (behavior === 'register-throw') throw new Error('fixture registration unavailable'); return plugin; },
    };
    if (behavior !== 'register-throw' && behavior !== 'missing' && behavior !== 'register-only') capacitor.Plugins = { OpenAsterAppearance: plugin };
    if (behavior === 'missing') delete capacitor.registerPlugin;
    globalThis.Capacitor = capacitor;
  }, { theme, platform, native, behavior });
}
const calls = page => page.evaluate(() => appearanceFixture.calls);
const settled = page => page.evaluate(() => appearanceFixture.settled);
async function themeIs(page, theme) {
  await expect(page.locator('body')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/);
  await expect(page.locator('meta[name=theme-color]')).toHaveAttribute('content', theme === 'dark' ? '#1c1c1e' : '#ffffff');
}
async function offline(page, local) {
  await page.goto(local.app.url);
  await expect(page.locator('#connection-message')).toContainText('请先配置 HTTPS 网关');
  await expect(page.locator('#model-select option:checked')).toHaveText('请先配置网关');
}
const toggle = page => page.getByRole('button', { name: '切换深色或浅色主题', exact: true }).click();
const apiRequests = local => local.requests.filter(item => item.path.startsWith('/api/'));

test('appearance: Android injected bridge mirrors saved theme and explicit toggles without a gateway', async ({ page, local }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await bridge(page, { theme: 'dark' }); await offline(page, local);
  await themeIs(page, 'dark'); await expect.poll(() => calls(page)).toEqual([{ theme: 'dark' }]);
  expect(await page.evaluate(() => appearanceFixture.registrations)).toEqual([]);
  await toggle(page); await themeIs(page, 'light');
  await expect.poll(() => calls(page)).toEqual([{ theme: 'dark' }, { theme: 'light' }]);
  expect(await page.evaluate(() => localStorage.getItem('openaster.theme'))).toBe('light');
  await page.reload(); await themeIs(page, 'light');
  await expect.poll(() => calls(page)).toEqual([{ theme: 'light' }]);
  expect(apiRequests(local)).toEqual([]); expect(errors).toEqual([]);
});

test('appearance: delayed native calls coalesce rapid choices, reject safely, and never block typing', async ({ page, local }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await bridge(page, { behavior: 'held' }); await offline(page, local);
  await expect.poll(() => calls(page)).toEqual([{ theme: 'light' }]);
  await toggle(page); await toggle(page); await toggle(page);
  await themeIs(page, 'dark'); await page.locator('#prompt-input').fill('未发送的输入保持原样');
  expect(await calls(page)).toEqual([{ theme: 'light' }]);
  await page.evaluate(() => appearanceFixture.releases.shift()(true));
  await expect.poll(() => calls(page)).toEqual([{ theme: 'light' }, { theme: 'dark' }]);
  await page.evaluate(() => appearanceFixture.releases.shift()(false));
  await expect.poll(() => settled(page)).toBe(2);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  expect(await page.evaluate(() => ({ peak: appearanceFixture.peak, active: appearanceFixture.active, calls: appearanceFixture.calls.length }))).toEqual({ peak: 1, active: 0, calls: 2 });
  await expect(page.locator('#prompt-input')).toHaveValue('未发送的输入保持原样');
  expect(await page.evaluate(() => localStorage.getItem('openaster.theme'))).toBe('dark');
  expect(apiRequests(local)).toEqual([]); expect(errors).toEqual([]);
});

test('appearance: visible and retained-page callbacks read the current theme without sending a draft', async ({ page, local }, info) => {
  await bridge(page); await offline(page, local); await toggle(page);
  await page.locator('#prompt-input').fill('返回后仍由我确认发送');
  await expect.poll(() => settled(page)).toBe(2);
  await page.evaluate(() => {
    let visibility = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => settled(page)).toBe(3);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => settled(page)).toBe(4);
  expect(await calls(page)).toEqual([{ theme: 'light' }, { theme: 'dark' }, { theme: 'dark' }, { theme: 'dark' }]);
  await themeIs(page, 'dark'); await expect(page.locator('#prompt-input')).toHaveValue('返回后仍由我确认发送');
  expect(apiRequests(local)).toEqual([]);
  await info.attach('appearance-synthetic-lifecycle', { body: JSON.stringify({ scope: 'Browser-dispatched visibility/page lifecycle; not Android foreground validation', calls: await calls(page) }), contentType: 'application/json' });
});

test('appearance: actual BFCache return keeps the document and reapplies its chosen theme', async ({ page, local }, info) => {
  await bridge(page, { theme: 'dark' }); await offline(page, local);
  await expect.poll(() => settled(page)).toBe(1);
  const identity = await page.evaluate(() => appearanceFixture.identity);
  await page.goto(local.away); await page.goBack({ waitUntil: 'commit' });
  await expect.poll(() => page.evaluate(() => globalThis.appearanceFixture?.identity)).toBe(identity);
  await expect.poll(() => page.evaluate(() => appearanceFixture.lifecycle.some(item => item.name === 'pageshow' && item.persisted))).toBe(true);
  await themeIs(page, 'dark'); await expect.poll(() => settled(page)).toBeGreaterThan(1);
  expect((await calls(page)).every(item => JSON.stringify(item) === JSON.stringify({ theme: 'dark' }))).toBe(true);
  expect(apiRequests(local)).toEqual([]);
  await info.attach('appearance-actual-bfcache', { body: JSON.stringify(await page.evaluate(() => ({ identity: appearanceFixture.identity, lifecycle: appearanceFixture.lifecycle, calls: appearanceFixture.calls }))), contentType: 'application/json' });
});

for (const behavior of ['missing', 'register-throw', 'throw', 'reject', 'register-only']) {
  test(`appearance: Android ${behavior} bridge preserves the usable web theme`, async ({ page, local }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await bridge(page, { theme: 'dark', behavior }); await offline(page, local);
    await themeIs(page, 'dark'); await toggle(page); await themeIs(page, 'light');
    await page.locator('#prompt-input').fill('桥接状态不影响输入');
    await expect(page.locator('#prompt-input')).toHaveValue('桥接状态不影响输入');
    await page.locator('[data-action=settings]').click();
    await expect(page.locator('#settings-view')).toBeVisible();
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect((await calls(page)).length).toBe(['missing', 'register-throw'].includes(behavior) ? 0 : 2);
    expect(await page.evaluate(() => appearanceFixture.registrations)).toEqual(['register-throw', 'register-only'].includes(behavior) ? ['OpenAsterAppearance'] : []);
    expect(apiRequests(local)).toEqual([]); expect(errors).toEqual([]);
  });
}

for (const environment of ['browser', 'electron', 'ios']) {
  test(`appearance: ${environment} never accesses the Android appearance plugin`, async ({ browser, local }) => {
    const context = await browser.newContext({ serviceWorkers: 'block', ...(environment === 'electron' ? { userAgent: 'Mozilla/5.0 OpenAster Electron/45.0.0' } : {}) });
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      // Even a stray Android bridge object in Electron must not be called.
      await bridge(page, { theme: 'dark', platform: environment === 'ios' ? 'ios' : 'android', native: environment !== 'browser' });
      await page.goto(local.app.url); await themeIs(page, 'dark'); await toggle(page); await themeIs(page, 'light');
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(await calls(page)).toEqual([]);
      expect(await page.evaluate(() => appearanceFixture.registrations)).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}
