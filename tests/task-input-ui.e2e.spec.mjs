import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { createSlowProvider } from './fixtures/slow-provider.mjs';

const test = base.extend({ local: async ({}, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const dataDir = await mkdtemp(resolve('test-results', 'task-input-ui-')), provider = await createSlowProvider(), providerId = randomUUID(); let app;
  try {
    const store = new Store(dataDir); let first, second;
    try { store.putProvider({ id: providerId, name: '本机补充输入验证', type: 'openai', baseUrl: provider.url, model: 'local-input-fixture', enabled: true, streaming: true, toolMode: 'workspace', maxTokens: 128, tokenParameter: 'max_completion_tokens' }); first = store.createSession({ title: '运行中补充验证', providerId }); second = store.createSession({ title: '独立的另一个任务', providerId }); }
    finally { store.close(); }
    app = await startServer({ dataDir }); await use({ app, provider, providerId, first, second });
  } finally { try { await app?.close(); } finally { await provider.close(); } }
} });
test.use({ serviceWorkers: 'block' });
async function ready(page, local) {
  const initial = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/state');
  await page.goto(local.app.url); await (await initial).finished(); await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(page.locator('#top-status')).toHaveText('本地已连接'); await page.locator(`.session-link[data-id="${local.first.id}"]`).click();
  await expect(page.locator('#messages .empty-state')).toHaveAttribute('data-history-state', 'true');
  await page.locator('#prompt-input').fill('请开始整理。'); await page.locator('#send-button').click();
  const request = await local.provider.nextRequest(); await request.emit('正在整理第一部分。'); await expect(page.locator('.stream-content')).toContainText('正在整理第一部分');
  return request;
}
async function png(page) {
  return Buffer.from(await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; canvas.getContext('2d').fillRect(0, 0, 2, 2); return canvas.toDataURL('image/png').split(',')[1]; }), 'base64');
}
async function audit(page, info) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await info.attach('task-input-axe', { body: Buffer.from(JSON.stringify(result)), contentType: 'application/json' }); expect(result.violations).toEqual([]);
}
function steeringRequests(page) { const values = []; page.on('request', request => { if (request.method() === 'POST' && /\/api\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) { const body = request.postDataJSON(); if (body.mode) values.push(body); } }); return values; }

test('Task input UI: queued text and image stay durable through reload and enter the next model request exactly once', async ({ page, local }, info) => {
  const current = await ready(page, local), sent = steeringRequests(page), image = await png(page);
  await expect(page.locator('#prompt-input')).toBeEditable(); await expect(page.locator('#send-button')).toBeVisible(); await expect(page.locator('#cancel-button')).toBeVisible();
  await page.locator('#prompt-input').fill('请参考这张图，只保留关键结论。');
  await page.locator('#image-input-file').setInputFiles({ name: 'supplement.png', mimeType: 'image/png', buffer: image });
  await expect(page.locator('#image-input-list .message-image-card')).toHaveCount(1);
  await page.locator('#send-button').click(); await expect(page.locator('.queued-input')).toHaveCount(1);
  await expect(page.locator('.queued-input')).toContainText('已排队'); await expect(page.locator('.queued-input img')).toHaveCount(1);
  await expect(page.locator('#prompt-input')).toHaveValue(''); await expect(page.locator('#image-input-region')).not.toBeVisible();
  expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ mode: 'queue', content: '请参考这张图，只保留关键结论。', images: [{ name: 'supplement.png', mimeType: 'image/png', data: image.toString('base64') }] });
  expect(sent[0].requestId).toMatch(/^[a-f0-9-]{36}$/); expect(sent[0].expectedRunId).toBeTruthy(); expect(sent[0]).not.toHaveProperty('providerId'); expect(sent[0]).not.toHaveProperty('skillId');
  expect(local.provider.requests).toHaveLength(1); expect(current.closed).toBe(false); await audit(page, info);
  await page.screenshot({ path: info.outputPath('v42-queued-input-desktop.png'), animations: 'disabled' });
  await page.reload(); await expect(page.locator('.queued-input')).toContainText('请参考这张图'); await expect(page.locator('.queued-input img')).toHaveCount(1);
  current.finish(); const next = await local.provider.nextRequest(); const user = next.input.messages.findLast(message => message.role === 'user');
  expect(user.content).toEqual(expect.arrayContaining([{ type: 'text', text: '请参考这张图，只保留关键结论。' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + image.toString('base64') } }]));
  await next.emit('已结合图片，保留关键结论。'); next.finish(); await expect(page.locator('#chat-meta')).toContainText('已完成');
  await expect(page.locator('.queued-input')).toHaveCount(0); await expect(page.locator('.message.user')).toHaveCount(2); await expect(page.locator('.message.user img')).toHaveCount(1); expect(sent).toHaveLength(1); expect(local.provider.requests).toHaveLength(2);
});

test('Task input UI: interrupt stops the current response and leaves newly typed draft isolated from the accepted input', async ({ page, local }, info) => {
  const current = await ready(page, local), sent = steeringRequests(page);
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#prompt-input').fill('改为只回复简短结论。');
  await expect(page.locator('#interrupt-send-button')).toBeEnabled(); await audit(page, info);
  await page.screenshot({ path: info.outputPath('v42-interrupt-input-mobile.png'), animations: 'disabled' });
  await page.locator('#interrupt-send-button').click(); const next = await local.provider.nextRequest();
  await expect.poll(() => current.closed).toBe(true); expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ mode: 'interrupt', content: '改为只回复简短结论。' });
  expect(next.input.messages.filter(message => message.role === 'user' && message.content === '改为只回复简短结论。')).toHaveLength(1);
  await expect(page.locator('#prompt-input')).toHaveValue(''); await page.locator('#prompt-input').fill('尚未发送的新草稿');
  await next.emit('简短结论。'); next.finish(); await expect(page.locator('#chat-meta')).toContainText('已完成'); await expect(page.locator('#prompt-input')).toHaveValue('尚未发送的新草稿');
  expect(local.provider.requests).toHaveLength(2); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('Task input UI: rejected supplements retain text and images and cannot leak into another selected task', async ({ page, local }) => {
  const current = await ready(page, local), image = await png(page), sent = steeringRequests(page);
  await page.route('**/api/sessions/*/messages', async route => { if (route.request().postDataJSON()?.mode) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INPUT_TEST_REJECTED', message: '受控补充拒绝，未接收。' } }) }); return route.continue(); });
  await page.locator('#prompt-input').fill('本次补充未成功'); await page.locator('#image-input-file').setInputFiles({ name: 'retained.png', mimeType: 'image/png', buffer: image });
  await page.locator('#send-button').click(); await expect(page.locator('#toast-region')).toContainText('受控补充拒绝');
  await expect(page.locator('#prompt-input')).toHaveValue('本次补充未成功'); await expect(page.locator('#image-input-list .message-image-card')).toHaveCount(1); await expect(page.locator('.queued-input')).toHaveCount(0); expect(sent).toHaveLength(1);
  await page.locator(`.session-link[data-id="${local.second.id}"]`).click(); await expect(page.locator('#chat-title')).toHaveText(local.second.title); await expect(page.locator('#prompt-input')).toHaveValue(''); await expect(page.locator('#image-input-region')).not.toBeVisible(); await expect(page.locator('#interrupt-send-button')).toBeHidden();
  await page.locator(`.session-link[data-id="${local.first.id}"]`).click(); await expect(page.locator('#prompt-input')).toHaveValue('本次补充未成功'); await expect(page.locator('#image-input-list .message-image-card')).toHaveCount(1); expect(sent).toHaveLength(1); expect(local.provider.requests).toHaveLength(1);
  await page.locator('#cancel-button').click(); await expect.poll(() => current.closed).toBe(true); await expect(page.locator('#chat-meta')).toContainText('已停止');
});
