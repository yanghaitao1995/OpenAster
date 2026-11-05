// SPDX-License-Identifier: Apache-2.0
import { test as base, expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

// Real persisted tasks and production HTTP/SSE on an owned random port. This
// verifies list behavior, not a time budget or a fabricated /api/state payload.
const test = base.extend({ local: async ({ browser }, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const directory = await mkdtemp(resolve('test-results', 'session-list-'));
  const dataDir = join(directory, 'data'), store = new Store(dataDir), sessions = [];
  try {
    for (let index = 0; index < 500; index++) {
      const title = `列表任务 ${String(index).padStart(4, '0')} · 保存的对话`;
      const session = store.createSession({ title, providerId: 'demo' });
      session.messages = [
        { id: randomUUID(), role: 'user', content: `${title}的原始问题`, createdAt: session.createdAt },
        { id: randomUUID(), role: 'assistant', content: `${title}的完整答复`, createdAt: session.createdAt },
      ];
      store.putSession(session); sessions.push(session);
    }
  } finally { store.close(); }
  let app = await startServer({ dataDir });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
    const page = await context.newPage(), messagePosts = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /^\/api\/sessions(?:\/[^/]+\/messages)?$/u.test(new URL(request.url()).pathname))
        messagePosts.push(request.url());
    });
    const initialState = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
    await page.goto(app.url);
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    await (await initialState).finished();
    await expect(page.locator('#session-list .session-row')).toHaveCount(sessions.length);
    await use({ page, get app() { return app; }, workspace: join(dataDir, 'workspace'), sessions, messagePosts, async replaceWorkspace(records) {
      const replacementDir = join(directory, 'replacement'), replacement = new Store(replacementDir);
      try { for (const session of records) replacement.putSession(session); }
      finally { replacement.close(); }
      const port = app.server.address().port;
      await app.close();
      app = await startServer({ dataDir: replacementDir, workspaceName: '列表替换工作区', port });
    } });
  } finally {
    try { await context?.close(); }
    finally { await app.close(); }
  }
} });

const row = (page, id) => page.locator(`#session-list .session-link[data-id="${id}"]`);
const pin = (page, id) => page.locator(`#session-list [data-action="pin-session"][data-id="${id}"]`);

async function select(page, session) {
  await row(page, session.id).click();
  await expect(page.locator('#chat-title')).toHaveText(session.title);
  await expect(page.locator('#messages')).toContainText(session.messages[1].content);
  await expect(row(page, session.id)).toHaveAttribute('aria-current', 'page');
}

async function search(page) {
  await page.getByRole('button', { name: '搜索任务', exact: true }).click();
  const field = page.getByRole('textbox', { name: '搜索任务标题', exact: true });
  await expect(field).toBeFocused();
  return field;
}

async function expectIds(page, sessions) {
  const expected = sessions.map(session => session.id).sort();
  await expect.poll(() => page.locator('#session-list .session-link').evaluateAll(nodes => nodes.map(node => node.dataset.id).sort())).toEqual(expected);
}

async function expectSelectedDraft(local, session, draft) {
  const { page } = local;
  await expect(page.locator('#chat-title')).toHaveText(session.title);
  await expect(page.locator('#messages')).toContainText(session.messages[1].content);
  await expect(page.locator('#prompt-input')).toHaveValue(draft);
  expect(await page.evaluate(() => sessionStorage.getItem('openaster.current-session'))).toBe(session.id);
  expect(local.messagePosts).toEqual([]);
}

test('session list: searching and clearing 500 real tasks preserves selection, draft and keyboard pin navigation', async ({ local }) => {
  const { page, sessions } = local, selected = sessions[249], draft = '只属于选中任务的未发送草稿🙂';
  await select(page, selected);
  await page.locator('#prompt-input').fill(draft);
  await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
  const field = await search(page);

  await field.fill('列表任务 02');
  await expectIds(page, sessions.filter(session => session.title.includes('列表任务 02')));
  await expect(field).toBeFocused();
  await expect(row(page, selected.id)).toHaveAttribute('aria-current', 'page');
  await expectSelectedDraft(local, selected, draft);

  await field.fill('确实没有匹配的任务标题');
  await expectIds(page, []);
  await expect(page.locator('#session-list')).toContainText('没有匹配的任务');
  await expect(field).toBeFocused();
  await expectSelectedDraft(local, selected, draft);

  await field.clear();
  await expectIds(page, sessions);
  await expect(page.locator('#session-list [aria-current="page"]')).toHaveCount(1);
  await expectSelectedDraft(local, selected, draft);

  // Reaching a task near the end of a large list must still preserve real
  // keyboard navigation and pin regrouping, not merely render correct text.
  const lastId = await page.locator('#session-list .session-link').last().getAttribute('data-id');
  const last = sessions.find(session => session.id === lastId);
  expect(last.id).not.toBe(selected.id);
  await row(page, last.id).scrollIntoViewIfNeeded();
  await row(page, last.id).focus();
  await page.keyboard.press('Tab');
  await expect(pin(page, last.id)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(pin(page, last.id)).toHaveAttribute('aria-pressed', 'true');
  await expect(pin(page, last.id)).toBeFocused();
  await expect(pin(page, last.id).locator('xpath=ancestor::details')).toHaveAttribute('data-group', 'pinned');
  await expectIds(page, sessions);
  await expectSelectedDraft(local, selected, draft);

  await row(page, last.id).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#chat-title')).toHaveText(last.title);
  await expect(page.locator('#chat-title')).toBeFocused();
  await expect(page.locator('#prompt-input')).toHaveValue('');
  await select(page, selected);
  await expectSelectedDraft(local, selected, draft);
});

test('session list: same-origin real workspace replacement cannot reuse cached old rows, pins or selected drafts', async ({ local }) => {
  const { page, sessions } = local, selected = sessions[249];
  await select(page, selected);
  await page.locator('#prompt-input').fill('仅属于原工作区的草稿');
  await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
  await pin(page, selected.id).click();
  await expect(pin(page, selected.id)).toHaveAttribute('aria-pressed', 'true');
  const field = await search(page);
  await field.fill('无匹配，原列表行均被排除');
  await expectIds(page, []);
  const before = await (await page.request.get(`${local.app.url}/api/bootstrap`)).json();
  const replacement = { ...selected, title: '新工作区的同 ID 任务', messages: selected.messages.map(message => ({ ...message, content: '只属于新工作区的保存消息' })) };
  await local.replaceWorkspace([replacement]);
  const after = await (await page.request.get(`${local.app.url}/api/bootstrap`)).json();
  expect(after.workspace.storageId).not.toBe(before.workspace.storageId);
  // Invoke the normal reconnect path against the new real database; neither
  // bootstrap/state nor the stored task is fabricated by a browser route.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#workspace-label')).toHaveText('列表替换工作区');
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await expect(page.locator('#home-view')).toBeVisible();
  await expect(field).toHaveValue('');
  await expectIds(page, [replacement]);
  await expect(row(page, replacement.id)).toHaveAttribute('title', replacement.title);
  await expect(row(page, replacement.id)).toHaveAttribute('aria-current', 'false');
  await expect(pin(page, replacement.id)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#session-list')).not.toContainText(selected.title);
  await expect(page.locator('#messages')).toBeEmpty();
  await expect(page.locator('#prompt-input')).toHaveValue('');
  await select(page, replacement);
  await expect(page.locator('#prompt-input')).toHaveValue('');
  expect(local.messagePosts).toEqual([]);
});

test('session list: real HTTP rename and deletion while filtered update hidden rows without resurrecting deleted tasks', async ({ local }) => {
  const { page, app, sessions } = local, selected = sessions[249], renamed = sessions[99], removed = sessions[399];
  const draft = '后台列表更新不能替换当前对话与草稿';
  await select(page, selected);
  await page.locator('#prompt-input').fill(draft);
  await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
  const field = await search(page);
  await field.fill(selected.title);
  await expectIds(page, [selected]);

  const bootstrap = await page.request.get(`${app.url}/api/bootstrap`);
  expect(bootstrap.status()).toBe(200);
  const { csrfToken } = await bootstrap.json(), headers = { 'X-CSRF-Token': csrfToken };
  const renamedTitle = '后台更新后的标题 · 保留相同任务身份';
  const reflected = page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== '/api/state' || response.status() !== 200) return false;
    const body = await response.json();
    return body.sessions.some(session => session.id === renamed.id && session.title === renamedTitle)
      && !body.sessions.some(session => session.id === removed.id);
  });
  const changed = await page.request.patch(`${app.url}/api/sessions/${renamed.id}`, { headers, data: { title: renamedTitle } });
  expect(changed.status()).toBe(200);
  const deleted = await page.request.delete(`${app.url}/api/sessions/${removed.id}`, { headers });
  expect(deleted.status()).toBe(200);
  await (await reflected).finished();
  await expect(field).toHaveValue(selected.title);
  await expect(field).toBeFocused();
  await expectIds(page, [selected]);
  await expectSelectedDraft(local, selected, draft);

  await field.clear();
  await expectIds(page, sessions.filter(session => session.id !== removed.id));
  await expect(row(page, renamed.id)).toHaveAttribute('title', renamedTitle);
  await expect(row(page, renamed.id)).toHaveAccessibleName(`${renamedTitle}，准备开始`);
  await expect(row(page, removed.id)).toHaveCount(0);
  await expect(page.locator('#session-list [aria-current="page"]')).toHaveCount(1);
  await expectSelectedDraft(local, selected, draft);

  // Repeatedly exclude/reintroduce the remaining tasks after the real mutation.
  await field.fill(renamedTitle);
  await expectIds(page, [renamed]);
  await field.fill(removed.title);
  await expectIds(page, []);
  await field.clear();
  await expectIds(page, sessions.filter(session => session.id !== removed.id));
  await expect(row(page, renamed.id)).toHaveAttribute('title', renamedTitle);
  await expect(row(page, removed.id)).toHaveCount(0);
  await expectSelectedDraft(local, selected, draft);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function browserFrame(page) {
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}
async function deleteTask(local, id) {
  const response = await local.page.request.get(`${local.app.url}/api/bootstrap`);
  expect(response.status()).toBe(200);
  const { csrfToken } = await response.json();
  const deleted = await local.page.request.delete(`${local.app.url}/api/sessions/${id}`, { headers: { 'X-CSRF-Token': csrfToken } });
  expect(deleted.status()).toBe(200);
}
async function savedDraft(page, app, slot) {
  const response = await page.request.get(`${app.url}/api/bootstrap`);
  expect(response.status()).toBe(200);
  const { workspace } = await response.json();
  return page.evaluate(async ({ slot, storageId }) => {
    const { createBrowserDraftRepository, draftScopeKey } = await import('/composer-drafts.mjs');
    const repository = createBrowserDraftRepository();
    try { return (await repository.read(draftScopeKey({ origin: location.origin, storageId }))).drafts.find(draft => draft.slot === slot) || null; }
    finally { repository.close(); }
  }, { slot, storageId: workspace.storageId });
}
const missingTaskResponse = (page, id) => page.waitForResponse(response =>
  response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/sessions/${id}` && response.status() === 404);

test('session deletion: deleting the selected task preserves connection, its draft and an independent file editor', async ({ local }) => {
  const { page, app, sessions } = local, selected = sessions[249], later = sessions[250];
  const draft = '任务被另一页删除时，这份未发送内容与附件仍属于原任务🙂';
  const selectedHistoryReads = [];
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === `/api/sessions/${selected.id}`) selectedHistoryReads.push(request.url());
  });
  await mkdir(local.workspace, { recursive: true });
  await writeFile(join(local.workspace, 'attached.txt'), 'the attached version\n');
  await writeFile(join(local.workspace, 'editable.txt'), 'the original editable version\n');
  await select(page, selected);
  await page.locator('#prompt-input').fill(draft);
  await page.locator('.nav-item[data-action=workspace]').click();
  await page.locator('#file-list .file-row[data-path="attached.txt"]').click();
  await page.locator('#file-preview [data-action=attach-context-file]').click();
  await expect(page.locator('#chat-view')).toBeVisible();
  await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
  const before = await savedDraft(page, app, selected.id);
  expect(before.text).toBe(draft); expect(before.files).toHaveLength(1);
  expect(before.files[0].path).toBe('attached.txt');

  const missing = missingTaskResponse(page, selected.id);
  await deleteTask(local, selected.id);
  await (await missing).finished(); await browserFrame(page);
  await expect(row(page, selected.id)).toHaveCount(0);
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await expect(page.locator('#connection-banner')).not.toBeVisible();
  await expect(page.locator('#chat-view')).toBeVisible();
  await expect(page.locator('#messages')).toContainText('任务已删除');
  await expect(page.locator('#prompt-input')).toHaveValue(draft);
  await expect(page.locator('#draft-file-list .draft-file-chip')).toHaveAttribute('data-path', 'attached.txt');
  expect(await page.evaluate(() => sessionStorage.getItem('openaster.current-session'))).toBe(selected.id);
  await expect(page.locator('#send-button')).toHaveAttribute('aria-disabled', 'true');
  await page.locator('#prompt-input').press('Enter'); await browserFrame(page);
  expect(local.messagePosts).toEqual([]);
  expect(await savedDraft(page, app, selected.id)).toEqual(before);
  await expect(page.locator('#messages [data-action=new]')).toHaveText('新建任务');

  // Reauthentication against the same real service must retain the confirmed
  // missing-task placeholder, rather than repeatedly fetching it and failing.
  const countBeforeReconnect = selectedHistoryReads.length;
  const reauthenticated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap' && response.status() === 200);
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state' && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await (await reauthenticated).finished(); await (await refreshed).finished(); await browserFrame(page);
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await expect(page.locator('#messages')).toContainText('任务已删除');
  await expect(page.locator('#prompt-input')).toHaveValue(draft);
  await expect(page.locator('#draft-file-list .draft-file-chip')).toHaveAttribute('data-path', 'attached.txt');
  expect(selectedHistoryReads).toHaveLength(countBeforeReconnect);
  expect(await savedDraft(page, app, selected.id)).toEqual(before);
  expect(local.messagePosts).toEqual([]);

  // A deletion is task-local even while another page removes the remembered
  // current task from behind an unrelated unsaved file-editor dialog.
  await select(page, later);
  await page.locator('.nav-item[data-action=workspace]').click();
  await page.locator('#file-list .file-row[data-path="editable.txt"]').click();
  await page.locator('#file-preview [data-action=edit-file]').click();
  await page.locator('#file-editor-input').fill('independent unsaved file buffer\n');
  const laterMissing = missingTaskResponse(page, later.id);
  await deleteTask(local, later.id);
  await (await laterMissing).finished(); await browserFrame(page);
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await expect(page.locator('#workspace-view')).toBeVisible();
  await expect(page.locator('#file-editor-dialog')).toBeVisible();
  await expect(page.locator('#file-editor-input')).toHaveValue('independent unsaved file buffer\n');
  await expect(page.locator('#file-editor-dialog [data-file-editor-action=review]')).toBeEnabled();
  await page.locator('#file-editor-dialog [data-file-editor-action=review]').click();
  await expect(page.locator('#file-editor-dialog [data-file-editor-action=save]')).toBeEnabled();
  expect(await readFile(join(local.workspace, 'editable.txt'), 'utf8')).toBe('the original editable version\n');
  expect(await savedDraft(page, app, selected.id)).toEqual(before);
  expect(local.messagePosts).toEqual([]);
});

test('session deletion: a delayed real missing-task response cannot disconnect a later selected task', async ({ local }) => {
  const { page, sessions } = local, removed = sessions[249], next = sessions[250];
  await select(page, removed);
  await page.locator('#prompt-input').fill('原任务的独立草稿');
  await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
  const before = await savedDraft(page, local.app, removed.id);
  const captured = deferred(), release = deferred(), pending = new Set(); let held = false;
  const match = url => url.pathname === `/api/sessions/${removed.id}`;
  const handler = async route => {
    if (route.request().method() !== 'GET' || held) return route.continue();
    const work = (async () => {
      const response = await route.fetch();
      // The server creates the genuine 404 after its real DELETE. Successful
      // earlier reads are never replaced by an invented missing-task payload.
      if (response.status() !== 404) { await route.fulfill({ response }); return; }
      expect((await response.json()).error.code).toBe('SESSION_NOT_FOUND');
      held = true; captured.resolve(); await release.promise; await route.fulfill({ response });
    })();
    pending.add(work); try { await work; } finally { pending.delete(work); }
  };
  await page.route(match, handler);
  try {
    await deleteTask(local, removed.id); await captured.promise;
    await select(page, next);
    const draft = '迟到的旧任务 404 不得影响这个任务';
    await page.locator('#prompt-input').fill(draft);
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    const missing = missingTaskResponse(page, removed.id);
    release.resolve(); await (await missing).finished(); await Promise.all([...pending]); await browserFrame(page);
    await expectSelectedDraft(local, next, draft);
    await expect(row(page, removed.id)).toHaveCount(0);
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    await expect(page.locator('#connection-banner')).not.toBeVisible();
    await expect(page.locator('#send-button')).toHaveAttribute('aria-disabled', 'false');
    expect(await savedDraft(page, local.app, removed.id)).toEqual(before);
    expect(local.messagePosts).toEqual([]);
  } finally {
    release.resolve(); await Promise.all([...pending]); await page.unroute(match, handler);
  }
});
