import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { readUtf8Body } from './helpers/http-body.mjs';

// Owned loopback model and isolated task storage. The only executed command is
// the platform's fixed current-directory query; no account or project is used.
const test = base.extend({ local: async ({}, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results', 'command-policy-ui-')), dataDir = join(root, 'data');
  await mkdir(join(dataDir, 'workspace', 'owned-space'), { recursive: true });
  const calls = [], provider = createServer(async (request, response) => {
    const body = JSON.parse(await readUtf8Body(request)); calls.push(body);
    const complete = body.messages.some(message => message.role === 'tool');
    const message = complete ? { role: 'assistant', content: '已读取当前工作目录。' } : { role: 'assistant', content: null,
      tool_calls: [{ id: 'owned-directory-query', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: process.platform === 'win32' ? 'Get-Location' : 'pwd', cwd: 'owned-space', timeoutMs: 15000 }) } }] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message, finish_reason: complete ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
  });
  await new Promise(done => provider.listen(0, '127.0.0.1', done));
  let app;
  try {
    const store = new Store(dataDir), providerId = randomUUID(); let first, second;
    try {
      store.putProvider({ id: providerId, name: '本机权限交互验证', type: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'owned-policy-fixture', enabled: true, streaming: false, toolMode: 'workspace', maxTokens: 512, tokenParameter: 'max_completion_tokens' });
      first = store.createSession({ title: '任务甲的命令权限', providerId }); second = store.createSession({ title: '任务乙的命令权限', providerId });
    } finally { store.close(); }
    app = await startServer({ dataDir }); await use({ app, first, second, providerId, calls });
  } finally { try { await app?.close(); } finally { provider.closeAllConnections(); await new Promise(done => provider.close(done)); } }
} });
test.use({ serviceWorkers: 'block' });

async function ready(page, local) {
  const state = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/state');
  await page.goto(local.app.url); await (await state).finished();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
}
async function select(page, session) {
  if (await page.locator('.mobile-menu').isVisible() && !await page.locator(`.session-link[data-id="${session.id}"]`).isVisible()) await page.locator('.mobile-menu').click();
  await page.locator(`.session-link[data-id="${session.id}"]`).click();
  await expect(page.locator('#chat-title')).toHaveText(session.title);
  await expect(page.locator('#messages .empty-state')).toHaveAttribute('data-history-state', 'true');
  if (await page.locator('#context-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#context-toggle').click();
  await expect(page.locator('#run-panel .command-policy-current')).toHaveText('智能审批');
  await expect(page.locator('#run-panel').getByRole('button', { name: '更改命令策略…', exact: true })).toBeEnabled();
}
async function edit(page, mode) {
  await page.locator('#run-panel').getByRole('button', { name: '更改命令策略…', exact: true }).click();
  await page.locator(`#app-dialog input[type="radio"][value="${mode}"]`).check();
}
async function audit(page, info) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await info.attach('command-policy-axe', { body: Buffer.from(JSON.stringify(result)), contentType: 'application/json' }); expect(result.violations).toEqual([]);
}

test('Command policy UI: explicit task grant requires risk confirmation, stays scoped across a delayed read, and can be revoked', async ({ page, local }, info) => {
  const mutations = []; page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/command-policy')) mutations.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  await ready(page, local); await select(page, local.first); expect(mutations).toEqual([]);
  await edit(page, 'trusted'); await expect(page.locator('#app-dialog')).toContainText('工作目录不是操作系统沙箱');
  await page.locator('#dialog-submit').click(); await expect(page.locator('#app-dialog')).toBeVisible(); expect(mutations).toEqual([]);
  await page.locator('.command-policy-risk input').check(); await audit(page, info);
  await page.screenshot({ path: info.outputPath('v42-command-policy-confirmation-desktop.png'), animations: 'disabled' });
  await page.locator('#dialog-submit').click(); await expect(page.locator('#app-dialog')).not.toBeVisible();
  await expect(page.locator('#run-panel .command-policy-current')).toHaveText('本轮授权');
  expect(mutations).toEqual([{ path: `/api/sessions/${local.first.id}/command-policy`, body: { mode: 'trusted', confirmRisk: true } }]);
  let release; const barrier = new Promise(done => { release = done; }); let sawHeld; const held = new Promise(done => { sawHeld = done; });
  const endpoint = `**/api/sessions/${local.first.id}/command-policy`;
  await page.route(endpoint, async route => { if (route.request().method() !== 'GET') return route.continue(); const response = await route.fetch(); sawHeld(); await barrier; await route.fulfill({ response }).catch(() => {}); });
  try {
    await page.locator('.nav-item[data-action="settings"]').click(); await held;
    await page.locator(`.session-link[data-id="${local.second.id}"]`).click(); await expect(page.locator('#chat-title')).toHaveText(local.second.title);
    if (await page.locator('#context-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#context-toggle').click();
    await expect(page.locator('#run-panel .command-policy-current')).toHaveText('智能审批'); release();
    await expect(page.locator('#run-panel').getByRole('button', { name: '撤销本轮授权' })).toBeHidden(); expect(mutations).toHaveLength(1);
  } finally { release(); await page.unroute(endpoint); }
  await page.locator(`.session-link[data-id="${local.first.id}"]`).click(); await expect(page.locator('#run-panel .command-policy-current')).toHaveText('本轮授权');
  await page.locator('#run-panel').getByRole('button', { name: '撤销本轮授权' }).click(); await expect(page.locator('#run-panel .command-policy-current')).toHaveText('智能审批');
  expect(mutations.at(-1)).toEqual({ path: `/api/sessions/${local.first.id}/command-policy`, body: { mode: 'smart' } }); expect(local.calls).toHaveLength(0);
});

test('Command policy UI: an eligible pending command grants only after explicit approval and resets when its run finishes', async ({ page, local }, info) => {
  const decisions = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/approvals/')) decisions.push(request.postDataJSON()); });
  await ready(page, local); await select(page, local.first); await edit(page, 'ask'); await expect(page.locator('.command-policy-risk')).toBeHidden(); await page.locator('#dialog-submit').click();
  await expect(page.locator('#run-panel .command-policy-current')).toHaveText('每次询问'); await expect(page.locator('#app-dialog')).not.toBeVisible();
  await page.locator('#prompt-input').fill('只读取当前工作目录。'); await page.locator('#send-button').click();
  const approval = page.locator('#approval-list .command-approval'); await expect(approval).toHaveCount(1);
  await approval.getByRole('button', { name: '批准并授权本轮…', exact: true }).click();
  await page.locator('#dialog-submit').click(); expect(decisions).toEqual([]); expect(local.calls).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('.command-policy-risk input').check(); await audit(page, info);
  await page.screenshot({ path: info.outputPath('v42-command-approval-mobile.png'), animations: 'disabled' });
  await page.locator('#dialog-submit').click(); await expect(page.locator('#chat-meta')).toContainText('已完成', { timeout: 20000 });
  expect(decisions).toEqual([{ decision: 'approve', scope: 'session', confirmRisk: true }]); expect(local.calls).toHaveLength(2);
  await expect(page.locator('#approval-list')).toBeHidden(); await expect(page.locator('.conversation-scroll .approval-history')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 960 }); if (await page.locator('#context-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#context-toggle').click();
  await expect(page.locator('#run-panel .command-policy-current')).toHaveText('智能审批'); await expect(page.locator('#run-panel>.approval-history')).toHaveCount(1);
  const stored = await (await page.request.get(new URL(`/api/sessions/${local.first.id}`, local.app.url).href)).json();
  expect(stored.session.approvals).toHaveLength(1); expect(stored.session.approvals[0]).toMatchObject({ status: 'approved', tool: 'run_command' }); expect(stored.session.approvals[0].startedAt).toBeTruthy();
});

test('Command policy UI: an uncertain committed grant is never replayed or displayed as a confirmed old policy', async ({ page, local }) => {
  await ready(page, local); await select(page, local.first);
  const endpoint = `**/api/sessions/${local.first.id}/command-policy`; let puts = 0, blocked = false;
  await page.route(endpoint, async route => {
    if (route.request().method() === 'PUT') { puts++; const response = await route.fetch(); expect(response.ok()).toBe(true); blocked = true; return route.abort('failed'); }
    if (blocked) return route.abort('failed'); return route.continue();
  });
  try {
    await edit(page, 'trusted'); await page.locator('.command-policy-risk input').check(); await page.locator('#dialog-submit').click();
    await expect(page.locator('#dialog-error')).toBeVisible(); expect(puts).toBe(1);
    await page.locator('#app-dialog [data-action="close-dialog"]').first().click();
    await expect(page.locator('#run-panel .command-policy-current')).toHaveText('策略尚未确认');
    await expect(page.locator('#run-panel').getByRole('button', { name: '更改命令策略…', exact: true })).toBeDisabled();
    const retry = page.locator('#run-panel').getByRole('button', { name: '重新读取策略' }); await expect(retry).toBeEnabled();
    blocked = false; await retry.click(); await expect(page.locator('#run-panel .command-policy-current')).toHaveText('本轮授权'); expect(puts).toBe(1);
  } finally { await page.unroute(endpoint); }
  await page.locator('#run-panel').getByRole('button', { name: '撤销本轮授权' }).click(); await expect(page.locator('#run-panel .command-policy-current')).toHaveText('智能审批'); expect(local.calls).toHaveLength(0);
});
