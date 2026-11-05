// SPDX-License-Identifier: Apache-2.0
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, realpath, lstat, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const clone = value => JSON.parse(JSON.stringify(value));

// Real workbench UI, SQLite and HTTP; only the deterministic demo is used.
// Storage is the browser's real IndexedDB, not an intercepted drafts API.
const test = base.extend({
  local: async ({}, use, info) => {
    const parent = await realpath(await mkdir(resolve('test-results'), { recursive: true }).then(() => resolve('test-results')));
    const directory = await mkdtemp(join(parent, 'device-drafts-ui-'));
    const canonical = await realpath(directory), identity = await lstat(directory, { bigint: true }), owner = randomUUID();
    await writeFile(join(directory, '.test-owner'), owner, { flag: 'wx' });
    const dataDirectories = { first: join(directory, 'first'), second: join(directory, 'second') };
    const sessions = [], providerId = 'draft-model-' + randomUUID();
    const store = new Store(dataDirectories.first);
    store.putProvider({ ...store.getProvider('demo'), id: providerId, name: '可删除的本地演示连接' });
    for (const title of ['草稿任务甲', '草稿任务乙']) {
      const session = store.createSession({ title, providerId: 'demo' });
      session.messages = [
        { id: randomUUID(), role: 'user', content: title + '的已保存问题', createdAt: new Date().toISOString() },
        { id: randomUUID(), role: 'assistant', content: title + '的已保存完整答复', createdAt: new Date().toISOString() },
      ];
      store.putSession(session); sessions.push(clone(session));
    }
    store.close();
    let app, storageId;
    const requests = [], gates = [];
    async function start(which, port = 0) {
      const inspected = new Store(dataDirectories[which]); storageId = inspected.getStorageIdentity(); inspected.close();
      app = await startServer({ dataDir: dataDirectories[which], host: '127.0.0.1', port });
      app.server.on('request', request => requests.push({ method: request.method, path: new URL(request.url, app.url).pathname }));
    }
    await start('first');
    const local = {
      get app() { return app; }, get storageId() { return storageId; }, sessions, providerId, requests, gates,
      async restart(which, { sameOrigin = true } = {}) {
        const port = sameOrigin ? Number(new URL(app.url).port) : 0;
        await app.close(); await start(which, port);
      },
    };
    try { await use(local); }
    finally {
      for (const gate of gates) gate.resolve();
      await app.close();
      // Preserve failed-test evidence. A successful cleanup can remove only
      // this exact owned leaf, after its identity and marker are revalidated.
      if (info.status === info.expectedStatus) {
        const scoped = relative(parent, canonical), current = await lstat(canonical, { bigint: true });
        if (!scoped || scoped.startsWith('..') || isAbsolute(scoped) || await realpath(canonical) !== canonical
          || current.isSymbolicLink() || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino
          || await readFile(join(canonical, '.test-owner'), 'utf8') !== owner) throw new Error('Owned draft fixture identity changed; retained');
        await rm(canonical, { recursive: true });
      } else await info.attach('retained-device-draft-fixture', { body: JSON.stringify({ directory: canonical, owner, dev: String(identity.dev), ino: String(identity.ino), syntheticDataOnly: true }), contentType: 'application/json' });
    }
  },
  page: async ({ browser, local }, use) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    try { await use(page); }
    finally {
      for (const gate of local.gates) gate.resolve();
      try { for (const current of context.pages()) await current.unrouteAll({ behavior: 'wait' }); }
      finally { await context.close(); }
    }
  },
});

const messagePosts = local => local.requests.filter(request => request.method === 'POST' && /^\/api\/sessions\/[^/]+\/messages$/u.test(request.path));
const sessionCreates = local => local.requests.filter(request => request.method === 'POST' && request.path === '/api/sessions');
async function connected(page) {
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await expect(page.locator('#composer-draft-label')).toHaveText(/^(本机草稿|草稿已保存|发送结果待核对)$/u);
}
async function ready(page, local) { await page.goto(local.app.url); await connected(page); }
async function selectTask(page, session) {
  if (await page.locator('.mobile-menu').isVisible() && !await page.locator('#sidebar').getAttribute('class').then(value => value?.includes('open')))
    await page.locator('.mobile-menu').click();
  await page.locator(`.session-link[data-id="${session.id}"]`).click();
  await expect(page.locator('#chat-title')).toHaveText(session.title);
  await expect(page.locator('#messages')).toContainText(session.messages[1].content);
  await expect(page.locator('#send-hint')).not.toHaveText('读取中…');
}
async function newTask(page) {
  await page.locator('#prompt-input').press('Control+k');
  await expect(page.locator('#home-view')).toBeVisible();
}
async function snapshot(page, storageId) {
  return page.evaluate(async storageId => {
    const module = await import('/composer-drafts.mjs');
    const repository = module.createBrowserDraftRepository();
    try { return await repository.read(module.draftScopeKey({ origin: location.origin, storageId })); }
    finally { repository.close(); }
  }, storageId);
}
async function saved(page, local, slot, text) {
  await expect.poll(async () => (await snapshot(page, local.storageId)).drafts.find(draft => draft.slot === slot)?.text).toBe(text);
  await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
}
async function dismissNotifications(page) {
  const controls = page.locator('#toast-region').getByRole('button', { name: '关闭提示', exact: true });
  while (await controls.count()) await controls.first().click();
}
async function manager(page) {
  await page.locator('#composer-draft-status').click();
  await expect(page.locator('#dialog-title')).toHaveText('本机草稿');
}
async function session(page, local, id) {
  const response = await page.request.get(`${local.app.url}/api/sessions/${id}`); expect(response.status()).toBe(200);
  return (await response.json()).session;
}
async function expectCompleted(page, local, id, text) {
  await expect.poll(async () => (await session(page, local, id)).run?.status).toBe('completed');
  expect((await session(page, local, id)).messages.filter(message => message.role === 'user' && message.content === text)).toHaveLength(1);
}

test('device drafts: task A, task B and a new task keep independent exact drafts across reload', async ({ page, local }) => {
  await ready(page, local);
  const texts = { new: '新任务仍未发送\n第二行 🙂', first: '甲任务的独立草稿', second: '乙任务的独立草稿' };
  await page.locator('#prompt-input').fill(texts.new); await saved(page, local, 'new', texts.new);
  await selectTask(page, local.sessions[0]); await expect(page.locator('#prompt-input')).toHaveValue('');
  await page.locator('#prompt-input').fill(texts.first); await saved(page, local, local.sessions[0].id, texts.first);
  await selectTask(page, local.sessions[1]); await expect(page.locator('#prompt-input')).toHaveValue('');
  await page.locator('#prompt-input').fill(texts.second); await saved(page, local, local.sessions[1].id, texts.second);
  await page.reload(); await connected(page);
  await expect(page.locator('#chat-title')).toHaveText(local.sessions[1].title); await expect(page.locator('#prompt-input')).toHaveValue(texts.second);
  await newTask(page); await expect(page.locator('#prompt-input')).toHaveValue(texts.new);
  await selectTask(page, local.sessions[0]); await expect(page.locator('#prompt-input')).toHaveValue(texts.first);
  expect((await snapshot(page, local.storageId)).drafts).toHaveLength(3);
  expect(messagePosts(local)).toHaveLength(0); expect(sessionCreates(local)).toHaveLength(0);
  for (const original of local.sessions) expect((await session(page, local, original.id)).messages).toEqual(original.messages);
});

test('device drafts: two pages retain conflicting text until the user explicitly selects the saved version', async ({ page, local }) => {
  await ready(page, local);
  const other = await page.context().newPage(); await ready(other, local);
  const remote = '第一个窗口已保存的版本', own = '第二个窗口尚未协调的版本';
  // Both editors have read the initial revision. IDB writes do not emit a
  // server state event; the second page remains based on that earlier revision.
  await page.locator('#prompt-input').fill(remote); await saved(page, local, 'new', remote);
  await other.locator('#prompt-input').fill(own);
  await expect(other.locator('#composer-draft-label')).toHaveText('草稿有冲突');
  await manager(other);
  await expect(other.getByRole('textbox', { name: '本页版本的完整内容', exact: true })).toHaveValue(own);
  await expect(other.getByRole('textbox', { name: '已保存版本的完整内容', exact: true })).toHaveValue(remote);
  expect((await snapshot(other, local.storageId)).drafts[0].text).toBe(remote);
  await other.getByRole('button', { name: '使用已保存版本', exact: true }).click();
  await expect(other.locator('.device-draft-conflict')).toHaveCount(0);
  await other.locator('#dialog-submit').click(); await expect(other.locator('#prompt-input')).toHaveValue(remote);
  await other.reload(); await connected(other); await expect(other.locator('#prompt-input')).toHaveValue(remote);
  expect(messagePosts(local)).toHaveLength(0);
});

test('device drafts: an IndexedDB write failure blocks sending before any task or message POST', async ({ page, local }) => {
  await ready(page, local);
  await page.evaluate(() => {
    globalThis.originalDraftPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'scopes') throw new DOMException('owned draft quota fixture', 'QuotaExceededError');
      return originalDraftPut.apply(this, args);
    };
  });
  const text = '写入失败时这段文字不能发送';
  try {
    await page.locator('#prompt-input').fill(text);
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿未保存');
    await page.locator('#send-button').click();
    await expect(page.locator('#toast-region')).toContainText('草稿尚未保存，本次未发送');
    await expect(page.locator('#prompt-input')).toHaveValue(text);
    expect(sessionCreates(local)).toHaveLength(0); expect(messagePosts(local)).toHaveLength(0);
    expect((await snapshot(page, local.storageId)).drafts).toEqual([]);
  } finally { await page.evaluate(() => { IDBObjectStore.prototype.put = originalDraftPut; delete globalThis.originalDraftPut; }); }
});

test('device drafts: losing an accepted message response preserves the uncertain draft and blocks replay after reload', async ({ page, local }) => {
  await ready(page, local); await selectTask(page, local.sessions[0]);
  const text = '本地演示已经受理但回复在传输中丢失', delivered = deferred();
  await page.route(url => url.pathname === `/api/sessions/${local.sessions[0].id}/messages`, async route => {
    const response = await route.fetch(); expect(response.status()).toBe(202); await response.body();
    await route.abort('failed'); delivered.resolve();
  });
  await page.locator('#prompt-input').fill(text); await saved(page, local, local.sessions[0].id, text);
  await page.locator('#send-button').click(); await delivered.promise;
  await expect(page.locator('#composer-draft-label')).toHaveText('发送结果待核对');
  await expectCompleted(page, local, local.sessions[0].id, text);
  expect(messagePosts(local)).toHaveLength(1);
  expect((await snapshot(page, local.storageId)).drafts.find(draft => draft.slot === local.sessions[0].id)?.uncertain).toBe(true);
  await page.unrouteAll({ behavior: 'wait' }); await page.reload(); await connected(page);
  await expect(page.locator('#prompt-input')).toHaveValue(text);
  await expect(page.locator('#composer-draft-label')).toHaveText('发送结果待核对');
  await page.locator('#send-button').click();
  await expect(page.locator('#toast-region')).toContainText('上一次发送的结果尚未确认');
  expect(messagePosts(local)).toHaveLength(1);
  await dismissNotifications(page);
  await manager(page); await expect(page.locator('.device-draft-manager')).toContainText('核对对应任务记录');
});

test('device drafts: a deleted draft provider stays unavailable instead of falling back to another connection', async ({ page, local }) => {
  await ready(page, local);
  const text = '此草稿只选择了后来被删除的模型';
  await page.locator('#model-select').selectOption(local.providerId);
  await page.locator('#prompt-input').fill(text); await saved(page, local, 'new', text);
  const bootstrap = await (await page.request.get(local.app.url + '/api/bootstrap')).json();
  const deleted = await page.request.delete(`${local.app.url}/api/providers/${local.providerId}`, { headers: { 'X-CSRF-Token': bootstrap.csrfToken } });
  expect(deleted.status()).toBe(200);
  await page.reload(); await connected(page); await expect(page.locator('#prompt-input')).toHaveValue(text);
  await expect(page.locator('#model-select')).toHaveValue(local.providerId);
  await expect(page.locator(`#model-select option[value="${local.providerId}"]`)).toHaveText('原模型不可用，请重新选择');
  await expect(page.locator(`#model-select option[value="${local.providerId}"]`)).toHaveJSProperty('disabled', true);
  // Explicit submission also exercises the independent send-handler guard,
  // even if the normal button is disabled for an unavailable connection.
  await page.locator('#composer').evaluate(form => form.requestSubmit());
  await expect(page.locator('#toast-region')).toContainText('请选择可用的模型和技能后再发送');
  expect(messagePosts(local)).toHaveLength(0); expect(sessionCreates(local)).toHaveLength(0);
  expect((await snapshot(page, local.storageId)).drafts.find(draft => draft.slot === 'new')?.providerId).toBe(local.providerId);
});

test('device drafts: newer typing and a task switch survive a delayed real new-task response', async ({ page, local }) => {
  await ready(page, local);
  const initial = '明确发送的新任务文字', later = '请求期间继续输入，仍未发送的下一段';
  const entered = deferred(), release = deferred(); local.gates.push(release); let createdId;
  await page.route(url => url.pathname === '/api/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(201);
    createdId = (await response.json()).session.id; entered.resolve(); await release.promise; await route.fulfill({ response });
  });
  await page.locator('#prompt-input').fill(initial); await saved(page, local, 'new', initial);
  await page.locator('#send-button').click(); await entered.promise;
  await page.locator('#prompt-input').fill(later);
  await selectTask(page, local.sessions[0]); await expect(page.locator('#prompt-input')).toHaveValue('');
  release.resolve(); await expectCompleted(page, local, createdId, initial);
  await expect(page.locator('#chat-title')).toHaveText(local.sessions[0].title);
  expect((await session(page, local, local.sessions[0].id)).messages).toEqual(local.sessions[0].messages);
  await newTask(page); await expect(page.locator('#prompt-input')).toHaveValue(later); await saved(page, local, 'new', later);
  await page.unrouteAll({ behavior: 'wait' }); await page.reload(); await connected(page); await expect(page.locator('#prompt-input')).toHaveValue(later);
  expect(messagePosts(local)).toHaveLength(1); expect(sessionCreates(local)).toHaveLength(1);
  expect((await snapshot(page, local.storageId)).drafts.find(draft => draft.slot === 'new')?.uncertain).toBe(false);
});

for (const theme of ['light', 'dark']) test(`device drafts: mobile ${theme} draft manager is readable and accessible`, async ({ page, local }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(value => localStorage.setItem('openaster.theme', value), theme);
  await ready(page, local);
  const text = '手机上的本机草稿\n这段文字尚未发送。\n保留换行与中文🙂。';
  await page.locator('#prompt-input').fill(text); await saved(page, local, 'new', text); await manager(page);
  await expect(page.getByRole('textbox', { name: '新任务的完整内容', exact: true })).toHaveValue(text);
  await expect(page.locator('.device-draft-manager')).toContainText('不会自动发送');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await page.locator('body').evaluate(body => body.classList.contains('dark'))).toBe(theme === 'dark');
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  await info.attach(`device-drafts-mobile-${theme}`, { body: JSON.stringify({ violations: audit.violations, incomplete: audit.incomplete }), contentType: 'application/json' });
  const screenshot = info.outputPath(`device-drafts-mobile-${theme}.png`); await page.screenshot({ path: screenshot, animations: 'disabled' });
  await info.attach(`device-drafts-mobile-${theme}-screenshot`, { path: screenshot, contentType: 'image/png' });
  expect(audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
  expect(messagePosts(local)).toHaveLength(0);
});

test('device drafts: real database identity replacement and a different origin never import another scope draft', async ({ page, local }) => {
  await ready(page, local);
  const firstOrigin = local.app.url, firstId = local.storageId, first = '原数据库独立保存的本机文字', second = '新数据库的另一份本机文字';
  await page.locator('#prompt-input').fill(first); await saved(page, local, 'new', first);
  await local.restart('second'); expect(local.app.url).toBe(firstOrigin); expect(local.storageId).not.toBe(firstId);
  const secondId = local.storageId;
  await page.reload(); await connected(page); await expect(page.locator('#prompt-input')).toHaveValue('');
  expect((await snapshot(page, local.storageId)).drafts).toEqual([]);
  await page.locator('#prompt-input').fill(second); await saved(page, local, 'new', second);
  await local.restart('first'); expect(local.storageId).toBe(firstId);
  await page.reload(); await connected(page); await expect(page.locator('#prompt-input')).toHaveValue(first);
  await local.restart('second', { sameOrigin: false }); expect(local.app.url).not.toBe(firstOrigin); expect(local.storageId).toBe(secondId);
  await ready(page, local); await expect(page.locator('#prompt-input')).toHaveValue('');
  expect((await snapshot(page, local.storageId)).drafts).toEqual([]);
  expect(messagePosts(local)).toHaveLength(0);
});
