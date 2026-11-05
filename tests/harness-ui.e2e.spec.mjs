import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { createSlowProvider } from './fixtures/slow-provider.mjs';

const test = base.extend({ local: async ({}, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const dataDir = await mkdtemp(resolve('test-results', 'harness-ui-'));
  const provider = await createSlowProvider(), providerId = randomUUID();
  let app;
  try {
    const store = new Store(dataDir);
    try { store.putProvider({ id: providerId, name: '受控连接 <script>', type: 'openai', baseUrl: provider.url, model: 'local-controlled-model', enabled: true, streaming: true, toolMode: 'workspace', maxTokens: 128, tokenParameter: 'max_completion_tokens' }); }
    finally { store.close(); }
    app = await startServer({ dataDir }); await use({ app, provider, providerId });
  } finally { try { await app?.close(); } finally { await provider.close(); } }
} });
test.use({ serviceWorkers: 'block' });
async function ready(page, local) {
  const initialState = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/state');
  await page.goto(local.app.url); await (await initialState).finished();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
}
async function accessible(page, info, name) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  await info.attach(name, { body: JSON.stringify({ violations: result.violations, incomplete: result.incomplete }), contentType: 'application/json' });
  expect(result.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }))).toEqual([]);
}

test('harness UI: model picker supports keyboard selection, dismiss, safe text and draft state', async ({ page, local }, info) => {
  await ready(page, local);
  await expect(page.locator('.sidebar-product-icon')).toHaveAttribute('src', './icon.svg');
  const trigger = page.locator('#model-picker-trigger'), popup = page.getByRole('listbox', { name: '可用模型' });
  await trigger.focus(); await page.keyboard.press('ArrowDown'); await expect(popup).toBeVisible();
  await page.keyboard.press('End'); await expect(popup.getByRole('option').last()).toBeFocused();
  await expect(popup).toContainText('local-controlled-model'); await expect(popup.locator('script')).toHaveCount(0);
  await accessible(page, info, 'model-picker-light');
  await page.screenshot({ path: info.outputPath('model-picker-light.png'), animations: 'disabled' });
  await page.keyboard.press('Enter'); await expect(popup).not.toBeVisible(); await expect(trigger).toBeFocused();
  await expect(page.locator('#model-select')).toHaveValue(local.providerId); await expect(trigger).toContainText('受控连接 <script>');
  await trigger.click(); await page.keyboard.press('Home'); await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused(); await expect(page.locator('#model-select')).toHaveValue(local.providerId);
  await trigger.click(); await page.keyboard.press('Tab'); await expect(popup).not.toBeVisible();
  await expect(page.locator('.skill-toggle')).toBeFocused();
  await page.locator('#model-select').selectOption({ label: '本地演示' }); await expect(trigger).toContainText('本地演示');
  expect(local.provider.requests).toHaveLength(0);
});

test('harness UI: actual model progress remains visible with details collapsed and circle stop cancels', async ({ page, local }, info) => {
  await ready(page, local); await page.locator('#model-select').selectOption(local.providerId);
  await page.locator('#prompt-input').fill('回复 OK'); await page.locator('#send-button').click();
  const request = await local.provider.nextRequest();
  await expect(page.locator('#context-panel')).not.toBeVisible();
  const flow = page.locator('#messages .execution-flow'); await expect(flow).toBeVisible();
  await expect(flow.locator('.execution-flow-title')).toHaveText('正在思考');
  await expect(flow).toContainText('模型处理 · 1'); await expect(flow).toContainText('local-controlled-model');
  await expect(page.locator('#model-picker-trigger')).toBeDisabled();
  const stop = page.locator('#cancel-button');
  expect(await stop.evaluate(button => { const style = getComputedStyle(button), square = getComputedStyle(button.firstElementChild); return { radius: style.borderRadius, width: style.width, height: style.height, square: square.backgroundColor !== 'rgba(0, 0, 0, 0)' }; })).toEqual({ radius: '50%', width: '32px', height: '32px', square: true });
  await flow.locator('.execution-step > details > summary').click(); const details = flow.locator('.execution-step > details'); await expect(details).toHaveAttribute('open', '');
  await request.emit('OK'); await expect(page.locator('.stream-content')).toHaveText('OK'); await expect(details).toHaveAttribute('open', '');
  await accessible(page, info, 'execution-stream-light'); await page.screenshot({ path: info.outputPath('execution-stream-light.png'), animations: 'disabled' });
  await stop.click(); await expect(flow).toHaveAttribute('data-status', 'cancelled');
  await expect(page.locator('.execution-flow-title')).toHaveText('已停止'); await expect(page.locator('#model-picker-trigger')).toBeEnabled();
  await expect.poll(() => request.closed).toBe(true);
});

test('harness UI: actual tool approval and completed steps fit mobile in dark appearance', async ({ page, local }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await ready(page, local);
  await page.locator('#prompt-input').fill('生成工作区报告'); await page.locator('#send-button').click();
  const flow = page.locator('.execution-flow');
  await expect(page.locator('.approval-card')).toBeVisible(); await expect(flow).toHaveAttribute('data-status', 'awaiting_approval');
  await expect(flow).toContainText('等待你的批准'); await expect(flow).toContainText('工具调用');
  await page.locator('[data-action=deny]').click(); await expect(flow).toHaveAttribute('data-status', 'completed');
  await flow.locator('.execution-tool-result:not([hidden])').first().click();
  const toolResult = page.locator('#run-panel .tool-artifact-view[open]'); await expect(toolResult).toHaveCount(1);
  await expect(toolResult.locator('.tool-artifact-content')).toBeVisible(); await expect(toolResult.locator('.artifact-page-status')).toContainText('UTF-8 字节范围');
  await page.locator('#context-panel [data-action=toggle-context]').click();
  await page.evaluate(() => document.body.classList.add('dark'));
  await page.locator('#model-picker-trigger').click(); await expect(page.locator('#model-picker-popup')).toBeVisible();
  const box = await page.locator('#model-picker-popup').boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await accessible(page, info, 'model-picker-mobile-dark');
  await page.screenshot({ path: info.outputPath('execution-mobile-dark.png'), animations: 'disabled' });
  await page.keyboard.press('Escape'); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('harness UI contract: retry phase shows actual supplied error and countdown without exposing hidden reasoning', async ({ page, local }) => {
  await ready(page, local);
  await page.evaluate(async () => {
    const { createExecutionFlow } = await import('/execution-flow.mjs');
    const flow = createExecutionFlow(), start = new Date(Date.now() - 2500).toISOString();
    const run = { id: 'controlled-retry', status: 'running', startedAt: start, steps: [{ id: 'controlled-step', type: 'model', title: '模型处理 · 1', status: 'running', phase: 'retrying', createdAt: start, detail: 'local-model', publicSummary: '先读取 **README**。<script>unsafe()</script>', publicSummaryTruncated: true, interruptedOutputs: [{ attempt: 1, content: '断线前的回答片段', publicReasoning: '断线前的公开解释', signature: 'private-signature-must-not-render' }], connection: { attempt: 2, retryCount: 1, nextRetryAt: new Date(Date.now() + 2500).toISOString(), lastError: { code: 'PROVIDER_TIMEOUT', message: '受控超时提示' } }, reasoning: 'private-test-field-must-not-render', encrypted_content: 'private-encrypted-must-not-render' }] };
    document.querySelector('.new-task-empty').replaceWith(flow.render(run, { key: 'controlled-retry', providerName: '本机测试' }));
    globalThis.__controlledExecution = { flow, run };
  });
  const flow = page.locator('.execution-flow'); await expect(flow).toContainText('受控超时提示'); await expect(flow).toContainText('第 2 次连接未成功');
  await expect(flow.locator('.execution-step-retry')).toContainText(/\d 秒后重连/);
  await expect(flow).not.toContainText('private-test-field'); await flow.locator('.execution-step > details > summary').click();
  await expect(flow.locator('.execution-step-detail')).toContainText('已重试 1 次');
  await expect(flow.locator('.execution-model-summary')).toContainText('模型输出 · 已截取');
  await flow.locator('.execution-model-summary > summary').click();
  await expect(flow.locator('.execution-model-summary strong')).toHaveText('README'); await expect(flow.locator('script')).toHaveCount(0);
  await flow.locator('.execution-model-interrupted > summary').click();
  await expect(flow.locator('.execution-model-interrupted')).toContainText('第 1 次连接 · 未完成输出');
  await expect(flow.locator('.execution-model-interrupted')).toContainText('断线前的公开解释');
  await expect(flow.locator('.execution-model-interrupted')).toContainText('断线前的回答片段');
  await expect(flow).not.toContainText('private-signature'); await expect(flow).not.toContainText('private-encrypted');
  await page.evaluate(() => {
    const { flow, run } = globalThis.__controlledExecution; run.status = 'completed'; run.steps[0].status = 'completed';
    run.steps[0].publicSummary = '已保存的公开正文。'.repeat(2400) + '全文末尾标记'; delete run.steps[0].publicSummaryTruncated;
    flow.render(run, { key: 'controlled-retry', providerName: '本机测试' }); delete globalThis.__controlledExecution;
  });
  await expect(flow.locator('.execution-model-summary')).toHaveAttribute('open', '');
  await expect(flow.locator('.execution-model-summary')).toContainText('全文末尾标记');
  await expect(flow.locator('.execution-model-summary > summary')).toHaveText('模型输出⌄');
});

test('harness UI: new task greeting stays quiet on desktop and mobile and leaves an existing conversation', async ({ page, local }, info) => {
  await ready(page, local); const greeting = page.locator('.new-task-greeting');
  await expect(greeting).toHaveText('想从哪里开始？'); await expect(greeting).toBeVisible();
  await expect(page.locator('.new-task-empty button')).toHaveCount(0);
  const greetingBox = await greeting.boundingBox(), homeBox = await page.locator('#home-view').boundingBox();
  expect(Math.abs(greetingBox.x + greetingBox.width / 2 - homeBox.x - homeBox.width / 2)).toBeLessThan(2);
  await accessible(page, info, 'new-task-desktop'); await page.screenshot({ path: info.outputPath('v41-new-task-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(greeting).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await accessible(page, info, 'new-task-mobile'); await page.screenshot({ path: info.outputPath('v41-new-task-mobile.png'), animations: 'disabled' });
  await page.locator('#model-select').selectOption(local.providerId); await page.locator('#prompt-input').fill('回复 OK'); await page.locator('#send-button').click();
  const request = await local.provider.nextRequest(); await request.emit('OK'); request.finish();
  await expect(page.locator('.message.assistant')).toContainText('OK'); await expect(greeting).not.toBeVisible();
  await page.locator('.mobile-menu').click(); await page.locator('.new-task').click();
  await expect(greeting).toBeVisible(); await expect(page.locator('#prompt-input')).toHaveValue('');
});

test('harness UI: streamed public explanations stay separate from answers and survive reload and history', async ({ page, local }, info) => {
  await ready(page, local); await page.locator('#model-select').selectOption(local.providerId);
  await page.locator('#prompt-input').fill('核对输入后回复 OK'); await page.locator('#send-button').click();
  const request = await local.provider.nextRequest();
  await request.emitReasoning('先核对 **输入**。');
  const reasoning = page.locator('#messages .execution-model-reasoning'); await expect(reasoning).toBeVisible();
  await expect(page.locator('.execution-flow-title')).toHaveText('正在思考'); await expect(page.locator('.pending-output')).toHaveCount(0);
  await reasoning.locator('summary').focus(); await page.keyboard.press('Enter'); await expect(reasoning).toHaveAttribute('open', '');
  await expect(reasoning.locator('strong')).toHaveText('输入');
  await request.emitReasoning('\n\n| 项目 | 结果 |\n| --- | --- |\n| 输入 | 已核对 |\n\n```js\nconst ready = true;\n```');
  await expect(reasoning.locator('table')).toContainText('已核对'); await expect(reasoning.locator('pre code')).toContainText('const ready = true;');
  await expect(reasoning).toHaveAttribute('open', ''); await expect(page.locator('body')).not.toContainText('fixture-signature-must-not-render'); await expect(page.locator('body')).not.toContainText('fixture-encrypted-must-not-render');
  await accessible(page, info, 'public-explanation'); await page.screenshot({ path: info.outputPath('v41-public-explanation-desktop.png'), animations: 'disabled' });
  await request.emit('OK'); request.finish(); await expect(page.locator('.message.assistant')).toHaveCount(1); await expect(page.locator('.message.assistant')).toContainText('OK');
  await expect(page.locator('.message.assistant')).not.toContainText('先核对');
  await page.reload(); await expect(page.locator('#messages .execution-model-reasoning')).toBeVisible();
  await page.locator('#messages .execution-model-reasoning > summary').click(); await expect(page.locator('#messages .execution-model-reasoning table')).toContainText('已核对');
  await page.locator('#context-toggle').click(); await page.locator('#run-history > summary').click();
  const record = page.locator('#run-history-list > .run-history-entry').first(); await expect(record).toBeVisible(); await record.locator(':scope > summary').click();
  const historical = record.locator('.execution-model-reasoning'); await expect(historical).toBeVisible(); await historical.locator('summary').click();
  await expect(historical.locator('table')).toContainText('已核对'); expect(local.provider.requests).toHaveLength(1);
});

test('harness UI: local computer access needs explicit confirmation and can return to workspace scope', async ({ page, local }, info) => {
  await ready(page, local); await page.locator('.nav-item[data-action=settings]').click();
  await expect(page.locator('#file-permissions-current')).toHaveText('仅工作区');
  const mutations = []; page.on('request', request => { if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/permissions') mutations.push(request.postDataJSON()); });
  await page.locator('#file-permissions-button').click(); await expect(page.locator('#dialog-body')).toContainText('发送给所选模型服务商');
  await expect(page.locator('#dialog-submit')).toHaveText('确认允许本机文件访问'); expect(mutations).toEqual([]);
  await page.locator('.dialog-heading [data-action=close-dialog]').click(); expect(mutations).toEqual([]);
  await page.locator('#file-permissions-button').click(); await page.locator('#dialog-submit').click();
  await expect(page.locator('#file-permissions-current')).toHaveText('本机文件访问已开启');
  expect(mutations).toEqual([{ fileAccess: 'computer', confirmComputerAccess: true }]);
  await accessible(page, info, 'computer-access-settings');
  await page.locator('#file-permissions-button').click(); await expect(page.locator('#file-permissions-current')).toHaveText('仅工作区');
  expect(mutations.at(-1)).toEqual({ fileAccess: 'workspace' }); expect(local.provider.requests).toHaveLength(0);
});

async function tinyPNG(page) {
  const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width=2; canvas.height=2; const context=canvas.getContext('2d'); context.fillStyle='#bc344b'; context.fillRect(0,0,2,2); return canvas.toDataURL('image/png').split(',')[1]; });
  return Buffer.from(data, 'base64');
}
test('harness images: upload stays local, a failed send retains it, image-only retry sends and persists it', async ({ page, local }, info) => {
  await ready(page, local); const buffer = await tinyPNG(page), posted=[];
  page.on('request', request => { if (request.method()==='POST'&&/\/api\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname)) posted.push(request.postDataJSON()); });
  await page.locator('#image-input-file').setInputFiles({ name:'tiny.png', mimeType:'image/png', buffer });
  await expect(page.locator('#image-input-list .message-image-card')).toHaveCount(1); await expect(page.locator('#image-input-list')).toContainText('2 × 2');
  await expect(page.locator('#image-input-status')).toContainText('本地演示不能识别图片'); await expect(page.locator('#send-button')).toBeDisabled(); expect(posted).toEqual([]); expect(local.provider.requests).toHaveLength(0);
  await page.locator('#model-select').selectOption(local.providerId); await expect(page.locator('#send-button')).toBeEnabled();
  let rejected=false;
  await page.route('**/api/sessions/*/messages', async route=>{ if(!rejected&&route.request().method()==='POST'){rejected=true;await route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:{code:'IMAGE_TEST_REJECTED',message:'受控图片拒绝'}})});}else await route.continue(); });
  await page.locator('#send-button').click(); await expect(page.locator('.toast-region')).toContainText('受控图片拒绝');
  await expect(page.locator('#image-input-list .message-image-card')).toHaveCount(1); await expect(page.locator('#send-button')).toBeEnabled();
  await page.locator('#image-input-list .image-thumbnail-button').click(); await expect(page.getByRole('dialog',{name:'图片预览'})).toBeVisible();
  await accessible(page,info,'image-preview-light'); await page.screenshot({path:info.outputPath('image-preview.png'),animations:'disabled'}); await page.getByRole('dialog',{name:'图片预览'}).getByRole('button',{name:'关闭'}).click();
  await page.locator('#send-button').click(); const request=await local.provider.nextRequest();
  const user=request.input.messages.findLast(message=>message.role==='user');expect(user.content).toEqual(expect.arrayContaining([expect.objectContaining({type:'image_url',image_url:expect.objectContaining({url:'data:image/png;base64,'+buffer.toString('base64')})})]));
  await request.emit('OK'); request.finish(); await expect(page.locator('.message.assistant')).toContainText('OK');
  await expect(page.locator('#image-input-region')).not.toBeVisible(); await expect(page.locator('.message.user .message-images img')).toHaveCount(1);
  expect(posted).toHaveLength(2); expect(posted[0].content).toBe(''); expect(posted[1].images).toEqual([{name:'tiny.png',mimeType:'image/png',data:buffer.toString('base64')}]);
  await page.reload(); await expect(page.locator('.message.user .message-images img')).toHaveCount(1);await expect(page.locator('.message.user>.markdown')).toHaveCount(0);
  await page.locator('.message.user [data-action=branch-message]').click();
  await expect(page.locator('.branch-scope')).toContainText('将保留这条消息的 1 张原始图片');
  await expect(page.locator('#field-branchContent')).toHaveValue('');await expect(page.locator('#field-branchContent')).not.toHaveAttribute('required','');
  await expect(page.locator('#dialog-submit')).toBeEnabled();
  await page.screenshot({path:info.outputPath('image-only-branch-desktop.png'),animations:'disabled'});
  const sourceId=await page.evaluate(()=>sessionStorage.getItem('openaster.current-session'));
  await page.locator('#dialog-submit').click();const branchedRequest=await local.provider.nextRequest();
  const branchUser=branchedRequest.input.messages.findLast(message=>message.role==='user');
  expect(branchUser.content).toEqual(expect.arrayContaining([expect.objectContaining({type:'image_url',image_url:expect.objectContaining({url:'data:image/png;base64,'+buffer.toString('base64')})})]));
  await branchedRequest.emit('图片分支 OK');branchedRequest.finish();
  await expect(page.locator('#app-dialog')).not.toBeVisible();await expect(page.locator('.message.assistant').last()).toContainText('图片分支 OK');
  expect(await page.evaluate(()=>sessionStorage.getItem('openaster.current-session'))).not.toBe(sourceId);
  await expect(page.locator('.message.user .message-images img')).toHaveCount(1);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:info.outputPath('image-only-branch-mobile.png'),animations:'disabled'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('harness images: pasted text is preserved, drafts stay with their task and drops do not silently omit bad files', async ({ page, local }, info) => {
  await page.setViewportSize({width:390,height:844});await ready(page,local); const png=await tinyPNG(page), data=png.toString('base64');
  await page.evaluate(data=>{const bytes=Uint8Array.from(atob(data),x=>x.charCodeAt(0)),clipboard=new DataTransfer();clipboard.items.add(new File([bytes],'pasted.png',{type:'image/png'}));clipboard.setData('text/plain','和图片一起粘贴的文字');document.querySelector('#prompt-input').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:clipboard}));},data);
  await expect(page.locator('#image-input-list .message-image-card')).toHaveCount(1);await expect(page.locator('#prompt-input')).toHaveValue('和图片一起粘贴的文字');
  expect(await page.evaluate(()=>{const data=new DataTransfer();data.setData('text/plain','普通文字');const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});document.querySelector('#prompt-input').dispatchEvent(event);return event.defaultPrevented;})).toBe(false);
  const session=await page.evaluate(async()=>{const {csrfToken}=await(await fetch('/api/bootstrap')).json();return(await(await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({title:'隔离图片草稿'})})).json()).session;});
  await page.locator('.mobile-menu').click();await expect(page.locator(`.session-link[data-id="${session.id}"]`)).toBeVisible();await page.locator(`.session-link[data-id="${session.id}"]`).click();await expect(page.locator('#image-input-region')).not.toBeVisible();
  await page.keyboard.press('Control+k');await expect(page.locator('#image-input-list .message-image-card')).toHaveCount(1);
  await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['<svg onload=alert(1)>'],'unsafe.svg',{type:'image/svg+xml'}));document.querySelector('#composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));});
  await expect(page.locator('#image-input-status')).toContainText('请选择有效的 PNG');await expect(page.locator('#image-input-list .message-image-card')).toHaveCount(1);
  await page.locator('#image-input-file').setInputFiles({name:'too-large.png',mimeType:'image/png',buffer:Buffer.alloc(768*1024+1)});await expect(page.locator('#image-input-status')).toContainText('本批图片未添加');await expect(page.locator('#image-input-list .message-image-card')).toHaveCount(1);
  await page.screenshot({path:info.outputPath('image-draft-mobile.png'),animations:'disabled'});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button',{name:'移除图片 pasted.png'}).click();await expect(page.locator('#image-input-region')).not.toBeVisible();expect(local.provider.requests).toHaveLength(0);
});

test('harness images: pixel bounds reject a compact oversized header before decode',async({page,local})=>{
  await ready(page,local);const buffer=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(buffer);buffer.writeUInt32BE(13,8);buffer.write('IHDR',12);buffer.writeUInt32BE(8193,16);buffer.writeUInt32BE(1,20);
  await page.locator('#image-input-file').setInputFiles({name:'oversized.png',mimeType:'image/png',buffer});await expect(page.locator('#image-input-status')).toContainText('单边最多 8192');await expect(page.locator('#image-input-list .message-image-card')).toHaveCount(0);expect(local.provider.requests).toHaveLength(0);
});

test('harness UI: chat-only mode explains ignored skill and omits it from the submitted task',async({page,local})=>{
  await ready(page,local);
  await page.evaluate(async providerId=>{const {csrfToken}=await(await fetch('/api/bootstrap')).json();const response=await fetch('/api/providers/'+providerId,{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({toolMode:'none'})});if(!response.ok)throw new Error('cannot configure owned chat-only provider');},local.providerId);
  await page.locator('.nav-item[data-action=skills]').click();await page.locator('[data-action=use-skill]').first().click();
  await page.locator('#model-select').selectOption(local.providerId);
  await expect(page.locator('.skill-toggle')).toBeDisabled();await expect(page.locator('#skill-label')).toHaveText('仅对话模式 · 本次不加载所选技能');
  const requestPromise=page.waitForRequest(request=>request.method()==='POST'&&/\/api\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname));
  await page.locator('#prompt-input').fill('回复 OK');await page.locator('#send-button').click();
  expect((await requestPromise).postDataJSON().skillId).toBeUndefined();const request=await local.provider.nextRequest();
  await request.emit('OK');request.finish();await expect(page.locator('.message.assistant')).toContainText('OK');
});
