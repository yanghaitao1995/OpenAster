import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const apache = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
const mit = `MIT License

Copyright (c) Fixture contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const notice = 'NOTICE\n<img src="https://example.invalid/unrequested" onerror="globalThis.noticeExecuted=true">\n<script>globalThis.noticeExecuted=true</script>\n';
const componentName = `fixture.${'long-component-name'.repeat(12)}`;
const inventory = {
  schemaVersion: 1, platform: 'android', summary: '离线许可浏览器测试声明范围。',
  scope: { description: '来自本地依赖文件与固定快照。', limitations: ['部分来源只含许可声明。'] },
  coverageGaps: ['此处不宣称已经完成全部上游 NOTICE 核查。'],
  licenses: [
    { id: 'Apache-2.0', name: 'Apache License 2.0', text: apache, sources: [{ path: 'LICENSE', url: 'https://example.invalid/apache' }] },
    { id: 'MIT', name: 'MIT License', text: mit, sources: [{ path: 'fixture/LICENSE' }] },
  ],
  components: [
    { name: componentName, version: '1.2.3', licenseIds: ['Apache-2.0'], noticeStatus: '已收录原始通知文本。', notices: [{ name: 'NOTICE', text: notice }] },
    { name: '@fixture/core', version: '4.5.6', licenseIds: ['MIT'], noticeStatus: '本地文件未提供额外通知，不表示上游没有通知义务。', notices: [] },
  ],
};

// Serve the production UI and a packaged-asset fixture only. There is no
// gateway, provider, credential, Android emulator, or external service here.
const test = base.extend({ local: async ({}, use) => {
  const root = resolve('public');
  const local = { requests: [], status: 200, body: JSON.stringify(inventory) };
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  const server = createServer(async (req, res) => {
    local.requests.push({ method: req.method, path: req.url });
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/android-notices.json') {
        res.writeHead(local.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(local.body);
        return;
      }
      const file = resolve(root, pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1));
      if (!file.startsWith(`${root}${sep}`)) throw new Error('Outside fixture root');
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(bytes);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  local.url = `http://127.0.0.1:${server.address().port}`;
  try { await use(local); }
  finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
} });
test.use({ serviceWorkers: 'block', viewport: { width: 360, height: 740 } });

async function load(page, local, platform = 'android', native = true) {
  await page.addInitScript(({ platform, native }) => {
    globalThis.Capacitor = { isNativePlatform: () => native, getPlatform: () => platform };
  }, { platform, native });
  await page.goto(local.url);
  if (native) await expect(page.locator('#connection-message')).toContainText('请先配置 HTTPS 网关');
  await page.locator('[data-action="sidebar"]').click();
  await page.locator('.nav-item[data-action="settings"]').click();
  await expect(page.locator('#settings-view')).toBeVisible();
}
const assetRequests = local => local.requests.filter(item => item.path === '/android-notices.json');
const apiRequests = local => local.requests.filter(item => item.path.startsWith('/api/'));

test('Android notices: offline details retain full texts, stay narrow, execute no source HTML, and restore focus', async ({ page, local }) => {
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(local.url + '/')) external.push(request.url()); });
  await load(page, local);
  expect(assetRequests(local)).toEqual([]);
  const button = page.locator('#android-notices-button');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('#dialog-title')).toHaveText('Android 开源许可');
  await expect(page.locator('.android-notices-component')).toHaveCount(2);
  await page.getByText('来源范围与已知缺口', { exact: true }).click();
  await expect(page.locator('#dialog-body')).toContainText(inventory.coverageGaps[0]);
  for (const [id, text] of [['Apache-2.0', apache], ['MIT', mit]]) {
    const license = page.locator('.android-notices-license').filter({ has: page.locator('summary', { hasText: `${id} ·` }) });
    await license.locator(':scope > summary').click();
    const region = page.getByRole('region', { name: `${id} 完整许可文本`, exact: true });
    expect(await region.textContent()).toBe(text);
    if (id === 'Apache-2.0') expect(await region.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  }
  const component = page.locator('.android-notices-component').first();
  await expect(component.locator(':scope > summary')).toHaveText(`${componentName} · 1.2.3`);
  await component.locator(':scope > summary').click();
  await component.getByText('NOTICE', { exact: true }).click();
  expect(await component.getByRole('region').textContent()).toBe(notice);
  expect(await page.evaluate(() => globalThis.noticeExecuted)).toBeUndefined();
  await expect(page.locator('.android-notices a, .android-notices img, .android-notices script')).toHaveCount(0);
  expect(await page.locator('#app-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.locator('#dialog-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.locator('#dialog-submit').click();
  await expect(page.locator('#app-dialog')).not.toBeVisible();
  await expect(button).toBeFocused();
  await button.click();
  await expect(page.locator('.android-notices-component')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  expect(assetRequests(local)).toHaveLength(2);
  expect(apiRequests(local)).toEqual([]);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('Android notices: missing, malformed, and unsupported local assets report a readable failure', async ({ page, local }) => {
  await load(page, local);
  for (const [status, body] of [[404, 'missing'], [200, '{broken'], [200, JSON.stringify({ ...inventory, schemaVersion: 99 })]]) {
    local.status = status; local.body = body;
    await page.locator('#android-notices-button').click();
    await expect(page.locator('.android-notices [role="alert"]')).toContainText('无法读取随应用打包的开源许可文件');
    await expect(page.locator('.android-notices [role="alert"]')).toContainText('这不表示应用没有使用开源组件');
    await expect(page.locator('.android-notices-component')).toHaveCount(0);
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
    await expect(page.locator('#android-notices-button')).toBeFocused();
  }
  expect(apiRequests(local)).toEqual([]);
});

test('Android notices: the actual packaged inventory opens 48 components and complete texts in both mobile themes', async ({ page, local }, testInfo) => {
  // The expected text comes directly from the generated, reviewable asset;
  // neither the DOM nor the renderer supplies the expected legal content.
  local.body = await readFile(new URL('../mobile/notices/android-notices.json', import.meta.url), 'utf8');
  const packaged = JSON.parse(local.body);
  expect(packaged.components).toHaveLength(48);
  expect(packaged.licenses.map(license => license.id)).toEqual(['Apache-2.0', 'MIT']);
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(local.url + '/')) external.push(request.url()); });
  await load(page, local);
  const button = page.locator('#android-notices-button');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await page.locator('[data-action="sidebar"]').click();
      await page.getByRole('button', { name: '切换深色或浅色主题', exact: true }).click();
      await page.keyboard.press('Escape');
    }
    await expect(page.locator('body')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/);
    await button.click();
    await expect(page.locator('.android-notices-component')).toHaveCount(48);
    expect(await page.locator('.android-notices-component > summary').allTextContents())
      .toEqual(packaged.components.map(component => `${component.name} · ${component.version}`));
    await expect(page.locator('#dialog-body')).toContainText(packaged.summary);
    for (const license of packaged.licenses) {
      const summary = page.locator('.android-notices-license > summary').filter({ hasText: `${license.id} ·` });
      await summary.click();
      const region = page.getByRole('region', { name: `${license.id} 完整许可文本`, exact: true });
      await expect(region).toBeVisible();
      expect(await region.textContent()).toBe(license.text);
      expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      if (license.id === 'Apache-2.0') expect(await region.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      if (license.id === 'MIT') await summary.click();
    }
    const firstComponent = page.locator('.android-notices-component').first();
    await firstComponent.locator(':scope > summary').click();
    await expect(firstComponent).toContainText(packaged.components[0].noticeStatus);
    await page.locator('#dialog-body').evaluate(node => { node.scrollTop = 0; });
    expect(await page.locator('#dialog-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    const bounds = await page.locator('#app-dialog').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    expect(bounds.height).toBeLessThanOrEqual(740);
    const screenshot = testInfo.outputPath(`android-notices-360x740-${theme}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach(`Android notices · 360×740 · ${theme}`, { path: screenshot, contentType: 'image/png' });
    await page.locator('#dialog-submit').click();
    await expect(button).toBeFocused();
  }
  expect(apiRequests(local)).toEqual([]);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

for (const [platform, native] of [['web', false], ['ios', true]]) {
  test(`Android notices: ${platform} keeps the entry hidden and never reads the asset`, async ({ page, local }) => {
    await load(page, local, platform, native);
    await expect(page.locator('#android-notices-entry')).toBeHidden();
    expect(assetRequests(local)).toEqual([]);
  });
}
