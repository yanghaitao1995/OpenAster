import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const test = base.extend({ local: async ({ page }, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results', 'manual-file-editor-'));
  let dataDir = join(root, 'a');
  await mkdir(join(dataDir, 'workspace'), { recursive: true });
  await writeFile(join(dataDir, 'workspace', 'notes.txt'), 'original\n');
  let app = await startServer({ dataDir, workspaceId: randomUUID(), workspaceName: '文件编辑测试' });
  const releases = [], requests = [];
  page.on('request', request => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/workspace/file') requests.push(request.postDataJSON());
  });
  try {
    await use({ get app() { return app; }, get workspace() { return join(dataDir, 'workspace'); }, requests, releases,
      async write(content) { await writeFile(join(dataDir, 'workspace', 'notes.txt'), content); },
      async read() { return readFile(join(dataDir, 'workspace', 'notes.txt'), 'utf8'); },
      async switchWorkspace() {
        const port = app.server.address().port;
        await app.close(); dataDir = join(root, 'b'); await mkdir(join(dataDir, 'workspace'), { recursive: true });
        await writeFile(join(dataDir, 'workspace', 'notes.txt'), 'second workspace\n');
        app = await startServer({ port, dataDir, workspaceId: randomUUID(), workspaceName: '另一工作空间' });
      },
    });
  } finally {
    for (const release of releases) release.resolve();
    await page.unrouteAll({ behavior: 'wait' }); await page.context().close(); await app.close();
  }
} });
test.use({ serviceWorkers: 'block' });
const action = (page, name) => page.locator(`#file-editor-dialog [data-file-editor-action="${name}"]`);
const dialog = page => page.locator('#file-editor-dialog');
const input = page => page.locator('#file-editor-input');
async function ready(page, local, { draft = '' } = {}) {
  await page.goto(local.app.url); await expect(page.locator('#top-status')).toHaveText('本地已连接');
  if (draft) await page.locator('#prompt-input').fill(draft);
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').click();
  await page.locator('.nav-item[data-action=workspace]').click();
  await page.locator('#file-list .file-row[data-path="notes.txt"]').click();
  await expect(page.locator('#selected-file-content')).toBeVisible();
}
async function edit(page) { await page.locator('#file-preview [data-action=edit-file]').click(); await expect(dialog(page)).toBeVisible(); }
async function review(page, text) { await input(page).fill(text); await action(page, 'review').click(); await expect(action(page, 'save')).toBeEnabled(); }
async function saved(page) { await action(page, 'save').click(); await expect(dialog(page)).not.toBeVisible(); }
async function audit(page, testInfo, label) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  await testInfo.attach(label, { body: JSON.stringify({ violations: result.violations, incomplete: result.incomplete }), contentType: 'application/json' });
  expect(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
}

test('manual file editing: review is explicit, keeps exact BOM/CRLF and renders markup as text', async ({ page, local }, testInfo) => {
  const original = '\uFEFF标题\r\n旧行\r\n尾行\r\n', body = '标题\n<img src=x onerror="globalThis.manualEditXss=1">\n尾行  \n';
  const expected = '\uFEFF标题\r\n<img src=x onerror="globalThis.manualEditXss=1">\r\n尾行  \r\n';
  await local.write(original); await ready(page, local, { draft: '这段任务输入必须保留。' }); await edit(page);
  await expect(input(page)).toHaveValue('标题\n旧行\n尾行\n'); await expect(action(page, 'review')).toBeDisabled();
  await input(page).fill(body); await input(page).press('Control+s'); await expect(action(page, 'save')).toBeEnabled();
  expect(await local.read()).toBe(original); expect(local.requests).toHaveLength(0);
  await expect(dialog(page).locator('.diff-formats')).toContainText('CRLF'); await expect(dialog(page).locator('.diff-formats')).toContainText('有 UTF-8 BOM');
  await expect(dialog(page).locator('.diff-table')).toContainText('<img src=x'); expect(await dialog(page).locator('img').count()).toBe(0);
  expect(await page.evaluate(() => globalThis.manualEditXss)).toBeUndefined();
  for (const detail of await dialog(page).locator('#file-editor-review details').all()) await detail.locator('summary').click();
  const complete = await dialog(page).locator('#file-editor-review pre').allTextContents();
  expect(complete).toContain(original); expect(complete).toContain(expected);
  await audit(page, testInfo, 'manual-editor-desktop-review'); await page.screenshot({ path: testInfo.outputPath('manual-file-editor-desktop.png'), fullPage: false });
  await saved(page); expect(await local.read()).toBe(expected); expect(local.requests).toHaveLength(1);
  expect(local.requests[0]).toMatchObject({ path: 'notes.txt', expectedHash: hash(original), content: expected });
  await expect(page.locator('#selected-file-content')).toHaveText(expected);
  await page.keyboard.press('Control+k'); await expect(page.locator('#prompt-input')).toHaveValue('这段任务输入必须保留。');
});

test('manual file editing: mixed newlines require a deliberate format choice and empty text can be saved', async ({ page, local }) => {
  await local.write('\uFEFFone\r\ntwo\nthree\r'); await ready(page, local); await edit(page);
  await input(page).fill('one\ntwo changed\nthree\n');
  await action(page, 'review').click(); await expect(page.locator('#file-editor-status')).toContainText('明确选择');
  expect(local.requests).toEqual([]); expect(await local.read()).toBe('\uFEFFone\r\ntwo\nthree\r');
  await page.locator('#file-editor-eol').selectOption('CRLF'); await action(page, 'review').click();
  await expect(page.locator('#file-editor-format')).toContainText('混合换行'); await expect(dialog(page).locator('.diff-formats')).toContainText('CRLF');
  await saved(page); expect(await local.read()).toBe('\uFEFFone\r\ntwo changed\r\nthree\r\n');
  await edit(page); await review(page, ''); await saved(page); expect(await local.read()).toBe('\uFEFF');
  await edit(page); await expect(input(page)).toHaveValue(''); await expect(action(page, 'review')).toBeDisabled(); await action(page, 'close').click();
  expect(local.requests).toHaveLength(2);
});

test('manual file editing: unsaved dismissal defaults to keeping the draft and restores focus after explicit discard', async ({ page, local }) => {
  await ready(page, local); await edit(page); await input(page).fill('unsaved local content'); await page.keyboard.press('Escape');
  await expect(action(page, 'keep-editing')).toBeFocused(); await action(page, 'keep-editing').click();
  await expect(input(page)).toHaveValue('unsaved local content'); await expect(input(page)).toBeFocused();
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  await action(page, 'close').click(); await action(page, 'discard').click(); await expect(dialog(page)).not.toBeVisible();
  await expect(page.locator('#file-preview [data-action=edit-file]')).toBeFocused(); expect(await local.read()).toBe('original\n'); expect(local.requests).toEqual([]);
});

test('manual file editing: external modifications require reading and reviewing the newer version before another save', async ({ page, local }) => {
  await ready(page, local); await edit(page); await review(page, 'my edit\n'); await local.write('external change\n');
  await action(page, 'save').click(); await expect(page.locator('#file-editor-status')).toContainText(/更改|冲突|变化/);
  expect(await local.read()).toBe('external change\n'); expect(local.requests).toHaveLength(1);
  await expect(input(page)).toHaveValue('my edit\n'); await action(page, 'verify').click();
  await expect(page.locator('#file-editor-latest')).toContainText('external change'); expect(local.requests).toHaveLength(1);
  await action(page, 'rebase').click(); await expect(action(page, 'save')).toBeEnabled();
  await expect(dialog(page).locator('.diff-table')).toContainText('external change'); await expect(dialog(page).locator('.diff-table')).toContainText('my edit');
  await saved(page); expect(await local.read()).toBe('my edit\n'); expect(local.requests).toHaveLength(2);
  expect(local.requests[1].expectedHash).toBe(hash('external change\n'));
});

test('manual file editing: an accepted save with a lost response is verified with a read and never replayed', async ({ page, local }) => {
  await ready(page, local); await edit(page); await review(page, 'saved before connection was lost\n');
  await page.route('**/api/workspace/file', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
  });
  await action(page, 'save').click(); await expect(action(page, 'verify')).toBeEnabled();
  expect(await local.read()).toBe('saved before connection was lost\n'); expect(local.requests).toHaveLength(1);
  await expect(input(page)).toHaveValue('saved before connection was lost\n');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); expect(local.requests).toHaveLength(1);
  await action(page, 'verify').click(); await expect(dialog(page)).not.toBeVisible();
  await expect(page.locator('#selected-file-content')).toHaveText('saved before connection was lost\n'); expect(local.requests).toHaveLength(1);
});

test('manual file editing: duplicate submission is disabled while the actual save response is pending', async ({ page, local }) => {
  await ready(page, local); await edit(page); await review(page, 'one save\n');
  const captured = deferred(), release = deferred(); local.releases.push(release);
  await page.route('**/api/workspace/file', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch(); captured.resolve(); await release.promise; await route.fulfill({ response }).catch(() => {});
  });
  await action(page, 'save').click(); await captured.promise; await expect(action(page, 'save')).toBeDisabled();
  await expect(input(page)).toHaveJSProperty('readOnly', true); await page.keyboard.press('Control+s'); expect(local.requests).toHaveLength(1);
  release.resolve(); await expect(dialog(page)).not.toBeVisible(); expect(await local.read()).toBe('one save\n');
});

test('manual file editing: switching the storage identity keeps the old text visible and cannot write into the new workspace', async ({ page, local }) => {
  await ready(page, local); await edit(page); await review(page, 'old workspace draft\n');
  await local.switchWorkspace(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#workspace-label')).toHaveText('另一工作空间'); await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await expect(dialog(page)).toBeVisible(); await expect(input(page)).toHaveValue('old workspace draft\n');
  await expect(action(page, 'save')).toBeDisabled(); await expect(action(page, 'verify')).toBeDisabled();
  expect(await local.read()).toBe('second workspace\n'); expect(local.requests).toEqual([]);
  await action(page, 'close').click(); await action(page, 'discard').click();
});

test('manual file editing: page suspension revokes the old confirmation and requires a read before review', async ({ page, local }) => {
  await ready(page, local); await edit(page); await review(page, 'retained after resume\n');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(action(page, 'save')).toBeDisabled(); await expect(input(page)).toHaveValue('retained after resume\n');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#top-status')).toHaveText('本地已连接'); await expect(action(page, 'save')).toBeDisabled();
  expect(local.requests).toEqual([]); await action(page, 'verify').click(); await action(page, 'rebase').click();
  await expect(action(page, 'save')).toBeEnabled(); await saved(page); expect(await local.read()).toBe('retained after resume\n');
});

test('manual file editing: deleted files are never recreated and oversize replacements cannot reach the write endpoint', async ({ page, local }) => {
  await ready(page, local); await edit(page); await input(page).fill('😀'.repeat(65537));
  if (await action(page, 'review').isEnabled()) await action(page, 'review').click();
  await expect(page.locator('#file-editor-status')).toContainText(/256|超过/); expect(local.requests).toEqual([]);
  await review(page, 'new content\n'); await unlink(join(local.workspace, 'notes.txt')); await action(page, 'save').click();
  await expect(page.locator('#file-editor-status')).toContainText(/不存在|找不到|文件/); await expect(input(page)).toHaveValue('new content\n');
  await expect(local.read()).rejects.toMatchObject({ code: 'ENOENT' }); expect(local.requests).toHaveLength(1);
});

test('manual file editing: mobile edit and review remain accessible in both themes without horizontal overflow', async ({ page, local }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await local.write('first\nsecond\n'); await ready(page, local); await edit(page);
  await input(page).fill('first\nchanged\n'); await audit(page, testInfo, 'manual-editor-mobile-light-edit');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await action(page, 'review').click(); await audit(page, testInfo, 'manual-editor-mobile-light-review');
  await page.screenshot({ path: testInfo.outputPath('manual-file-editor-mobile-light.png'), fullPage: false });
  await action(page, 'back').click(); await action(page, 'close').click(); await action(page, 'discard').click();
  await page.locator('.mobile-menu').click(); await page.locator('[data-action=theme]').click(); await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveClass(/dark/); await edit(page); await review(page, 'first\nchanged dark\n');
  await audit(page, testInfo, 'manual-editor-mobile-dark-review'); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('manual-file-editor-mobile-dark.png'), fullPage: false });
  for (let index = 0; index < 12; index++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#file-editor-dialog')))).toBe(true); }
  await saved(page); expect(await local.read()).toBe('first\nchanged dark\n');
});

test('manual file editing: verifying a lost response preserves edits made after the earlier save', async ({ page, local }) => {
  await ready(page, local); await edit(page); await review(page, 'first candidate\n');
  await page.route('**/api/workspace/file', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
  });
  await action(page, 'save').click(); await expect(action(page, 'verify')).toBeEnabled();
  await input(page).fill('newer unsaved edit\n'); await action(page, 'verify').click();
  await expect(dialog(page)).toBeVisible(); await expect(input(page)).toHaveValue('newer unsaved edit\n');
  await expect(page.locator('#file-editor-status')).toContainText('较新的编辑仍未保存');
  expect(local.requests).toHaveLength(1); expect(await local.read()).toBe('first candidate\n');
  await page.unroute('**/api/workspace/file'); await action(page, 'review').click(); await saved(page);
  expect(local.requests).toHaveLength(2); expect(local.requests[1].expectedHash).toBe(hash('first candidate\n')); expect(await local.read()).toBe('newer unsaved edit\n');
  await expect(page.locator('#selected-file-content')).toHaveText('newer unsaved edit\n');
});

test('manual file editing: an explicit newline choice survives conflict rebasing', async ({ page, local }) => {
  await local.write('one\r\ntwo\r\n'); await ready(page, local); await edit(page);
  await input(page).fill('my edit\n'); await page.locator('#file-editor-eol').selectOption('LF'); await action(page, 'review').click();
  await local.write('external\r\n'); await action(page, 'save').click(); await action(page, 'verify').click(); await action(page, 'rebase').click();
  await expect(action(page, 'save')).toBeEnabled(); await saved(page);
  expect(await local.read()).toBe('my edit\n'); expect(local.requests[1].content).toBe('my edit\n'); expect(local.requests[1].expectedHash).toBe(hash('external\r\n'));
});

test('manual file editing: a retained editor stays reachable during reconnect and navigation', async ({ page, local }, testInfo) => {
  await ready(page, local); await edit(page); await input(page).fill('retained file draft\n');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.locator('#top-status')).toHaveText('本地已连接'); await action(page, 'park').click();
  await expect(dialog(page)).not.toBeVisible(); await expect(page.locator('#file-editor-resume')).toBeVisible();
  await page.locator('.nav-item[data-action=settings]').click(); await expect(page.locator('#file-editor-resume')).toBeVisible();
  await audit(page, testInfo, 'manual-editor-parked'); await page.locator('#file-editor-resume').click();
  await expect(input(page)).toHaveValue('retained file draft\n'); await expect(action(page, 'save')).toBeDisabled();
  await action(page, 'verify').click(); await action(page, 'rebase').click(); await saved(page);
  expect(await local.read()).toBe('retained file draft\n'); await expect(page.locator('#settings-view')).toBeVisible();
  await expect(page.locator('#file-editor-resume')).not.toBeVisible(); expect(local.requests).toHaveLength(1);
});

test('manual file editing: a delayed success from the old workspace cannot dismiss the retained editor in a new one', async ({ page, local }) => {
  await ready(page, local); await edit(page); await review(page, 'written in original workspace\n');
  const firstWorkspace = local.workspace, captured = deferred(), release = deferred(); local.releases.push(release);
  await page.route('**/api/workspace/file', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200); captured.resolve();
    await release.promise; await route.fulfill({ response }).catch(() => {});
  });
  await action(page, 'save').click(); await captured.promise; await local.switchWorkspace();
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); await expect(page.locator('#workspace-label')).toHaveText('另一工作空间');
  release.resolve(); await expect(dialog(page)).toBeVisible(); await expect(input(page)).toHaveValue('written in original workspace\n');
  await expect(action(page, 'save')).toBeDisabled(); await expect(action(page, 'verify')).toBeDisabled();
  expect(await readFile(join(firstWorkspace, 'notes.txt'), 'utf8')).toBe('written in original workspace\n');
  expect(await local.read()).toBe('second workspace\n'); expect(local.requests).toHaveLength(1);
});

test('manual file editing: inconsistent read or save metadata cannot authorize or falsely confirm a write', async ({ page, local }) => {
  await page.route('**/api/workspace/file?*', async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, content: 'different displayed source\n' } });
  });
  await ready(page, local); await edit(page); await input(page).fill('new text\n'); await action(page, 'review').click();
  await expect(page.locator('#file-editor-status')).toContainText(/不一致|核对|无法/); expect(local.requests).toEqual([]); expect(await local.read()).toBe('original\n');
  await action(page, 'close').click(); await action(page, 'discard').click(); await page.unroute('**/api/workspace/file?*');
  await page.locator('#file-list .file-row[data-path="notes.txt"]').click(); await expect(page.locator('#selected-file-content')).toHaveText('original\n');
  await edit(page); await review(page, 'saved text\n');
  await page.route('**/api/workspace/file', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch(), body = await response.json(); await route.fulfill({ response, json: { ...body, changed: false } });
  });
  await action(page, 'save').click(); await expect(action(page, 'verify')).toBeEnabled();
  await expect(dialog(page)).toBeVisible(); await expect(input(page)).toHaveValue('saved text\n'); expect(local.requests).toHaveLength(1);
  await action(page, 'verify').click(); await expect(dialog(page)).not.toBeVisible(); expect(local.requests).toHaveLength(1); expect(await local.read()).toBe('saved text\n');
});

test('manual file editing: saving never silently refreshes a file version already attached to a task draft', async ({ page, local }) => {
  await ready(page, local); await page.locator('#file-preview [data-action=attach-context-file]').click();
  await page.locator('.nav-item[data-action=workspace]').click(); await page.locator('#file-list .file-row[data-path="notes.txt"]').click();
  await edit(page); await review(page, 'manually updated version\n'); await saved(page);
  await page.keyboard.press('Control+k'); await expect(page.locator('.draft-file-chip[data-path="notes.txt"]')).toHaveCount(1);
  await page.locator('#prompt-input').fill('请查看我原来选定的文件版本');
  const response = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/sessions\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
  await page.locator('#send-button').click(); const rejected = await response;
  expect(rejected.status()).toBe(409); expect((await rejected.json()).error.code).toBe('CONTEXT_FILE_CHANGED');
  expect(rejected.request().postDataJSON().files).toEqual([{ path: 'notes.txt', sha256: hash('original\n') }]);
  await expect(page.locator('#prompt-input')).toHaveValue('请查看我原来选定的文件版本');
  await expect(page.locator('#context-file-error')).toBeVisible(); expect(await local.read()).toBe('manually updated version\n');
});

base('manual file editing: renderer departure refuses pending input and an already-created task whose response is still in flight', async ({ browser }, testInfo) => {
  // Browser-level handshake contract only: an Electron user-agent enables the
  // production listener, and a memory repository supplies authenticated draft
  // CAS. This is not an Electron, OS encryption, or native quit verification.
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results', 'manual-editor-departure-')), snapshots = new Map();
  await mkdir(join(root, 'workspace')); await writeFile(join(root, 'workspace', 'notes.txt'), 'original\n');
  const repository = {
    async read(id) { return structuredClone(snapshots.get(id) ?? { version: 1, revision: '0', drafts: [] }); },
    async compareAndSwap(id, expected, drafts) {
      const current = snapshots.get(id) ?? { version: 1, revision: '0', drafts: [] };
      if (current.revision !== expected) throw Object.assign(new Error('Fixture conflict'), { code: 'DRAFT_CONFLICT' });
      const next = { version: 1, revision: randomUUID(), drafts: structuredClone(drafts) }; snapshots.set(id, next); return structuredClone(next);
    }, async drain() {}, async close() {},
  };
  const app = await startServer({ dataDir: root, deviceDraftStore: repository });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block', userAgent: 'OpenAster browser contract fixture Electron/45.0.0' });
  const page = await context.newPage(), release = deferred(), captured = deferred(), events = [];
  const check = async (event, token) => {
    const result = await page.evaluate(({ event, token }) => {
      const detail = { version: 1, token, result: null };
      document.dispatchEvent(new CustomEvent('openaster:native-leave-' + event, { detail, cancelable: true })); return detail.result;
    }, { event, token });
    events.push({ event, token, result }); return result;
  };
  try {
    await ready(page, { app }); await expect(page.locator('#composer-draft-label')).toHaveText('本机草稿');
    const first = randomUUID().replaceAll('-', ''), second = randomUUID().replaceAll('-', '');
    expect(await check('check', first)).toEqual({ allowed: true, reason: null, token: first });
    expect(await page.locator('body').evaluate(node => node.inert)).toBe(true);
    expect(await check('release', second)).toEqual({ allowed: false, reason: 'unknown', token: second });
    expect(await page.locator('body').evaluate(node => node.inert)).toBe(true);
    expect(await check('release', first)).toEqual({ allowed: true, reason: null, token: first });
    expect(await page.locator('body').evaluate(node => node.inert)).toBe(false);
    await edit(page); await input(page).fill('unsaved manual text');
    expect(await check('check', second)).toEqual({ allowed: false, reason: 'pending', token: second });
    expect(await page.locator('body').evaluate(node => node.inert)).toBe(false);
    await action(page, 'close').click(); await action(page, 'discard').click(); await page.keyboard.press('Control+k');
    await page.route('**/api/sessions', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(201); captured.resolve();
      await release.promise; await route.fulfill({ response }).catch(() => {});
    });
    await page.locator('#prompt-input').fill('你好'); await page.locator('#send-button').click(); await captured.promise;
    expect([...snapshots.values()].some(snapshot => snapshot.drafts.some(draft => draft.uncertain))).toBe(true);
    expect(await check('check', second)).toEqual({ allowed: false, reason: 'unknown', token: second });
    expect(await page.locator('body').evaluate(node => node.inert)).toBe(false);
    expect((await page.request.get(app.url + '/api/state')).status()).toBe(200);
    release.resolve(); await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
    await expect(page.locator('#composer-draft-label')).toHaveText('本机草稿');
    expect(await check('check', second)).toEqual({ allowed: true, reason: null, token: second });
    expect(await check('release', first)).toEqual({ allowed: false, reason: 'unknown', token: first });
    expect(await page.locator('body').evaluate(node => node.inert)).toBe(true);
    expect(await check('release', second)).toEqual({ allowed: true, reason: null, token: second });
    expect(await page.locator('body').evaluate(node => node.inert)).toBe(false);
    await testInfo.attach('renderer-departure-contract', { body: JSON.stringify({ nativeRuntime: false, encryption: false, events }), contentType: 'application/json' });
  } finally { release.resolve(); await page.unrouteAll({ behavior: 'wait' }); await context.close(); await app.close(); }
});
