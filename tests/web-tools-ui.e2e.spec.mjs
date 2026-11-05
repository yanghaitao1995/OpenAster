import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { createWebSearchRouter } from '../core/web-search-router.mjs';

const pageText = '<script>globalThis.webExecuted=true</script>\n' + '这是一段已归档的合成网页正文。'.repeat(700) + '\n末尾仍完整。';
const searchSummary = '模型根据来源整理的说明。<img src=x onerror="globalThis.webExecuted=true">\n这段摘要不是网页原文。';
const stamp = '2026-11-05T00:00:00.000Z';
function archive(session, runId, name, result) {
  const id = randomUUID(), content = JSON.stringify({ untrusted_data: true, result });
  const artifact = { id, stepId: id, sessionId: session.id, runId, callId: randomUUID(), name, path: null, isError: false, createdAt: stamp, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), content };
  return { artifact, step: { id, type: 'tool', title: name === 'search_web' ? '搜索网页' : '阅读网页', status: 'completed', detail: '已保存网页工具结果。', createdAt: stamp, finishedAt: stamp, toolResultRef: { artifactId: id, name, path: null, isError: false, bytes: artifact.bytes, sha256: artifact.sha256 } } };
}
async function modelFixture() {
  const requests = []; let release, notify;
  const first = new Promise(resolve => { notify = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    if (requests.length === 1) { notify(); await gate; }
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: requests.length === 1 ? { role: 'assistant', content: '', tool_calls: [{ id: 'web-call', type: 'function', function: { name: 'search_web', arguments: JSON.stringify({ query: '本地模拟关键词' }) } }] } : { role: 'assistant', content: '联网已关闭，未执行搜索。' }, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, first, release,
    async close() { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const test = base.extend({ local: async ({}, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const dataDir = await mkdtemp(resolve('test-results', 'web-tools-ui-')), model = await modelFixture(); let app, webCalls=0;
  try {
    const store = new Store(dataDir), providerId = randomUUID(); let recorded, fresh;
    try {
      store.putProvider({ id: providerId, name: '本地网页流程验证', type: 'openai', baseUrl: model.url, model: 'mock-web', enabled: true, streaming: false, toolMode: 'workspace', maxTokens: 128, tokenParameter: 'max_completion_tokens' });
      recorded = store.createSession({ title: '网页资料与来源', providerId: 'demo' }); fresh = store.createSession({ title: '运行中关闭联网', providerId });
      const runId = randomUUID(), search = archive(recorded, runId, 'search_web', { query: '项目资料 <img src=x>', results: [
        { title: '项目文档 <img src=x onerror="globalThis.webExecuted=true">', url: 'https://example.com/docs', snippet: '<script>globalThis.webExecuted=true</script>\n纯文本摘要。' },
        { title: '不安全地址', url: 'javascript:alert(1)', snippet: '不会创建可点击链接。' },
      ], provider: 'parallel', truncated: false, fetchedAt: stamp, untrusted_data: true });
      const read = archive(recorded, runId, 'read_webpage', { title: '项目说明', url: 'https://example.com/docs', content: pageText,
        links: [{ title: '相关资料', url: 'https://example.com/related' }, { title: '含凭据地址', url: 'https://private:secret@example.com/' }, { title: '脚本地址', url: 'javascript:alert(1)' }], truncated: true, fetchedAt: stamp, untrusted_data: true });
      const nativeSearch = archive(recorded, runId, 'search_web', { query: '项目资料', results: [{ title: '引用资料', url: 'https://example.com/reference', snippet: '' }], provider: 'bailian', summaryKind: 'model-generated', summary: searchSummary, truncated: false, fetchedAt: stamp, untrusted_data: true });
      recorded.messages = [{ id: randomUUID(), role: 'user', content: '查看这份资料的来源。', createdAt: stamp }, { id: randomUUID(), role: 'assistant', content: '资料已整理，可以展开执行过程核对实际来源。', createdAt: stamp }];
      recorded.run = { id: runId, status: 'completed', startedAt: stamp, finishedAt: stamp, steps: [search.step, read.step, nativeSearch.step], output: null };
      store.putSession(recorded, { artifacts: [search.artifact, read.artifact, nativeSearch.artifact] });
    } finally { store.close(); }
    const blocked=async()=>{webCalls++;throw new Error('UI fixture prohibits external requests');};
    const webTools=createWebSearchRouter({pages:{search:blocked,read:blocked},parallel:{search:blocked},bailian:{search:blocked}});
    app = await startServer({ dataDir, runtimeOptions:{webTools} }); await use({ app, model, recorded, fresh, get webCalls(){return webCalls;} });
  } finally { try { await app?.close(); } finally { await model.close(); } }
} });
test.use({ serviceWorkers: 'block' });
async function open(page, local, session) {
  const response = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/state');
  await page.goto(local.app.url); await (await response).finished();
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  if (session) { await page.locator(`.session-link[data-id="${session.id}"]`).click(); await expect(page.locator('#chat-title')).toHaveText(session.title); }
}
async function audit(page, info) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await info.attach('web-tools-axe', { body: Buffer.from(JSON.stringify(result)), contentType: 'application/json' }); expect(result.violations).toEqual([]);
}

test('Web UI: explicit service-session switch starts disabled and preserves confirmed state through reload', async ({ page, local }) => {
  const writes = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/security/web-access') writes.push(request.postDataJSON()); });
  await open(page, local); await expect(page.locator('#composer-web-access')).toHaveText('联网：关闭'); expect(writes).toEqual([]);
  await page.locator('#composer-web-access').click(); await expect(page.locator('#web-access-toggle')).not.toBeChecked();
  await expect(page.locator('#web-access-description')).toContainText('Parallel'); await expect(page.locator('#web-access-description')).toContainText('仅本次服务有效');
  await page.locator('#web-access-toggle').check(); await expect(page.locator('#web-access-state')).toHaveText('已开启'); expect(writes).toEqual([{ enabled: true }]);
  await page.reload(); await expect(page.locator('#composer-web-access')).toHaveText('联网：开启'); await page.locator('#composer-web-access').click();
  await page.locator('#web-access-toggle').uncheck(); await expect(page.locator('#web-access-state')).toHaveText('已关闭'); expect(writes).toEqual([{ enabled: true }, { enabled: false }]);
  await page.reload(); await expect(page.locator('#composer-web-access')).toHaveText('联网：关闭'); expect(local.model.requests).toHaveLength(0);expect(local.webCalls).toBe(0);
});

test('Web UI: search service saves explicitly without enabling access and survives a delayed response', async ({ page, local }, info) => {
  const writes = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/security/web-')) writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() }); });
  await open(page, local); await page.locator('#composer-web-access').click();
  await expect(page.locator('#web-search-provider')).toHaveValue('parallel'); await expect(page.locator('#web-search-save')).toBeDisabled();
  await page.locator('#web-search-provider').selectOption('bailian');
  await expect(page.locator('#web-search-description')).toContainText('需要支持 Responses'); await expect(page.locator('#web-search-description')).toContainText('另计费用');
  await expect(page.locator('#web-access-description')).toContainText('Parallel'); expect(writes).toEqual([]);
  let release, received; const held = new Promise(resolve => { release = resolve; }), accepted = new Promise(resolve => { received = resolve; });
  await page.route('**/api/security/web-search', async route => { const response = await route.fetch(); received(); await held; await route.fulfill({ response }); }, { times: 1 });
  try {
    await page.locator('#web-search-save').click(); await accepted;
    await expect(page.locator('#web-search-provider')).toHaveValue('bailian'); await expect(page.locator('#web-search-provider')).toBeDisabled(); await expect(page.locator('#web-search-save')).toBeDisabled();
    await expect(page.locator('#web-search-status')).toHaveText('正在保存…'); await expect(page.locator('#web-access-toggle')).not.toBeChecked();
  } finally { release(); }
  await expect(page.locator('#web-search-status')).toHaveText('当前：百炼原生'); await page.reload(); await page.locator('#composer-web-access').click();
  await expect(page.locator('#web-search-provider')).toHaveValue('bailian'); await expect(page.locator('#web-access-toggle')).not.toBeChecked();
  await page.locator('#web-search-provider').selectOption('duckduckgo'); await expect(page.locator('#web-search-description')).toContainText('验证码');
  await page.locator('#web-search-save').click(); await expect(page.locator('#web-search-status')).toHaveText('当前：DuckDuckGo');
  await page.locator('#web-search-provider').selectOption('parallel'); await page.locator('#web-search-save').click(); await expect(page.locator('#web-search-status')).toHaveText('当前：Parallel');
  expect(writes).toEqual(['bailian', 'duckduckgo', 'parallel'].map(provider => ({ path: '/api/security/web-search', body: { provider } })));
  await expect(page.locator('#composer-web-access')).toHaveText('联网：关闭'); expect(local.model.requests).toHaveLength(0); expect(local.webCalls).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('#web-search-save')).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await audit(page, info); await page.screenshot({ path: info.outputPath('web-search-settings-mobile.png'), animations: 'disabled' });
});

test('Web UI: unknown or unconfirmed search settings cannot be saved and do not replay a failed mutation', async ({ page, local }) => {
  const writes = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/security/web-search') writes.push(request.postDataJSON()); });
  await page.route('**/api/state', async route => { const response = await route.fetch(), data = await response.json(); data.security.webSearchProvider = 'future-provider'; await route.fulfill({ response, json: data }); });
  await open(page, local); await page.locator('#composer-web-access').click(); await expect(page.locator('#web-search-provider')).toHaveValue('');
  await expect(page.locator('#web-search-provider')).toBeDisabled(); await expect(page.locator('#web-search-save')).toBeDisabled(); await expect(page.locator('#web-search-status')).toHaveText('状态待确认'); expect(writes).toEqual([]);
  await page.unroute('**/api/state'); await page.reload(); await page.locator('#composer-web-access').click(); await expect(page.locator('#web-search-provider')).toHaveValue('parallel');
  await page.locator('#web-search-provider').selectOption('duckduckgo');
  await page.route('**/api/security/web-search', route => route.abort('connectionfailed')); await page.route('**/api/state', route => route.abort('connectionfailed'));
  await page.locator('#web-search-save').click(); await expect(page.locator('#web-search-status')).toHaveText('状态待确认'); await expect(page.locator('#web-search-save')).toBeDisabled(); await expect(page.locator('#web-search-provider')).toBeDisabled();
  expect(writes).toEqual([{ provider: 'duckduckgo' }]); await page.unroute('**/api/security/web-search'); await page.unroute('**/api/state');
  await page.reload(); await page.locator('#composer-web-access').click(); await expect(page.locator('#web-search-provider')).toHaveValue('parallel'); await expect(page.locator('#web-search-save')).toBeDisabled();
  expect(writes).toEqual([{ provider: 'duckduckgo' }]); expect(local.model.requests).toHaveLength(0); expect(local.webCalls).toBe(0);
});

test('Web UI: recorded sources and long plain webpage remain safe, complete and usable on a narrow screen', async ({ page, local }, info) => {
  const external = []; page.on('request', request => { if (!request.url().startsWith(local.app.url) && /^https?:/.test(request.url())) external.push(request.url()); });
  await open(page, local, local.recorded); await expect(page.locator('.execution-step')).toHaveCount(3);
  await page.locator('.execution-step').first().getByRole('button', { name: '查看完整工具结果' }).click();
  const search = page.locator('#run-panel .web-tool-result[aria-label="搜索网页的来源与内容"]').first(); await expect(search.locator('a')).toHaveCount(1); await expect(search).toContainText('搜索服务：Parallel');
  await expect(search.locator('a')).toHaveAttribute('href', 'https://example.com/docs'); await expect(search.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(search).toContainText('<script>globalThis.webExecuted=true</script>'); await expect(search.locator('img,script,iframe')).toHaveCount(0);
  await page.locator('.execution-step').nth(1).getByRole('button', { name: '查看完整工具结果' }).click();
  const read = page.locator('#run-panel .web-tool-result[aria-label="阅读网页的来源与内容"]'); await expect(read.locator('pre code')).toHaveText(pageText);
  await expect(read).toContainText('内容或链接已截取'); await read.locator('.web-page-links>summary').click(); await expect(read.locator('a')).toHaveCount(2);
  await expect(read.locator('a[href^="javascript:"],a[href*="private:secret"],img,script,iframe')).toHaveCount(0); expect(await page.evaluate(() => globalThis.webExecuted)).toBeUndefined();
  await page.locator('.execution-step').nth(2).getByRole('button', { name: '查看完整工具结果' }).click();
  const nativeSearch = page.locator('#run-panel .web-tool-result[aria-label="搜索网页的来源与内容"]').last();
  await expect(nativeSearch).toContainText('搜索服务：百炼原生'); await expect(nativeSearch).toContainText('模型生成的搜索摘要 · 非网页原文'); await expect(nativeSearch.locator('pre code')).toHaveText(searchSummary);
  await expect(nativeSearch.locator('.web-source-snippet')).toHaveCount(0); await expect(nativeSearch.locator('a')).toHaveAttribute('href', 'https://example.com/reference'); await expect(nativeSearch.locator('img,script,iframe')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('web-sources-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(read.locator('pre code')).toHaveText(pageText);
  await read.getByRole('button', { name: '自动换行', exact: true }).click(); await expect(read.locator('.code-block')).toHaveClass(/is-wrapped/);
  await expect(read.getByRole('button', { name: '复制文本', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390); expect(external).toEqual([]);expect(local.webCalls).toBe(0); await audit(page, info);
  await page.screenshot({ path: info.outputPath('web-sources-mobile.png'), animations: 'disabled' });
});

test('Web UI: disabling access while a model is working rejects its later search without an external request', async ({ page, local }) => {
  await open(page, local, local.fresh); await expect(page.locator('#messages .empty-state')).toHaveAttribute('data-history-state', 'true');
  await page.locator('#composer-web-access').click(); await page.locator('#web-access-toggle').check(); await expect(page.locator('#web-access-state')).toHaveText('已开启');
  await page.locator(`.session-link[data-id="${local.fresh.id}"]`).click(); await page.locator('#prompt-input').fill('搜索一份资料。'); await page.locator('#send-button').click(); await local.model.first;
  expect(local.model.requests[0].tools.some(tool => tool.function.name === 'search_web')).toBe(true);
  await page.locator('#composer-web-access').click(); await page.locator('#web-access-toggle').uncheck(); await expect(page.locator('#web-access-state')).toHaveText('已关闭');
  local.model.release(); await page.locator(`.session-link[data-id="${local.fresh.id}"]`).click(); await expect(page.locator('#chat-meta')).toContainText('已完成');
  expect(local.model.requests).toHaveLength(2); const tool = local.model.requests[1].messages.find(message => message.role === 'tool');
  expect(JSON.parse(tool.content).error.code).toBe('WEB_ACCESS_DISABLED'); await expect(page.locator('.message.assistant').last()).toContainText('联网已关闭，未执行搜索。');
  await expect(page.locator('#composer-web-access')).toHaveText('联网：关闭');expect(local.webCalls).toBe(0);
});
