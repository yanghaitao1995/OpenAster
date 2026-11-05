import {readUtf8Body} from './helpers/http-body.mjs';
import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';
import { createWorkspace } from '../core/workspace.mjs';

// Real local HTTP/SSE. A strict chat-only service rejects any tools field.
async function controlledProvider() {
  const requests=[],pending=[],waiting=[],responses=new Set();let rejectTools=true;
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
    const raw=await readUtf8Body(req);
    const input=JSON.parse(raw);let content='';const rejected=rejectTools&&Object.hasOwn(input,'tools');
    responses.add(res);res.once('close',()=>responses.delete(res));
    const frame=value=>res.write(`data: ${JSON.stringify(value)}\n\n`);
    const request={input,rejected,
      emit(text){content+=text;if(input.stream&&!rejected)frame({choices:[{index:0,delta:{content:text},finish_reason:null}]});},
      finish({text='',calls=[],usage}={}){
        if(rejected)return;
        if(text)this.emit(text);
        const toolCalls=calls.map(call=>({id:randomUUID(),type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}));
        if(input.stream){
          if(toolCalls.length)frame({choices:[{index:0,delta:{tool_calls:toolCalls.map((call,index)=>({index,...call}))},finish_reason:null}]});
          frame({choices:[{index:0,delta:{},finish_reason:toolCalls.length?'tool_calls':'stop'}]});
          if(usage)frame({choices:[],usage});
          res.end('data: [DONE]\n\n');
        }else{
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({choices:[{message:{role:'assistant',content,...(toolCalls.length?{tool_calls:toolCalls}:{})},finish_reason:toolCalls.length?'tool_calls':'stop'}],...(usage?{usage}:{})}));
        }
      }
    };
    if(rejected){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'This fixture does not accept tools'}}));}
    else if(input.stream){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.flushHeaders();}
    requests.push(request);if(waiting.length)waiting.shift()(request);else pending.push(request);
  });
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  return {requests,url:`http://127.0.0.1:${server.address().port}/v1`,allowTools(){rejectTools=false;},next:()=>pending.length?Promise.resolve(pending.shift()):new Promise(done=>waiting.push(done)),
    async close(){for(const response of responses)response.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));}};
}
const test=base.extend({local:async({},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});const dataDir=await mkdtemp(resolve('test-results','capabilities-ui-'));
  const workspacePath=join(dataDir,'workspace');await mkdir(workspacePath,{recursive:true});
  const workspace=await createWorkspace(workspacePath),activity=[];
  // Observe only runtime tool access; ordinary UI workspace listing is independent.
  const runtimeWorkspace={...workspace};
  for(const operation of ['list','read','search','prepareWrite','commitWrite'])runtimeWorkspace[operation]=async(...args)=>{activity.push(operation);return workspace[operation](...args);};
  const provider=await controlledProvider();const app=await startServer({dataDir,runtimeOptions:{workspace:runtimeWorkspace}});
  try{await use({app,provider,dataDir,workspacePath,activity});}finally{await app.close();await provider.close();}
}});
async function connect(page,local){
  await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await page.locator('.nav-item[data-action=settings]').click();await page.locator('[data-action=add-provider]').click();
  await expect(page.locator('#field-toolMode')).toHaveValue('workspace');
  await page.locator('#field-name').fill('仅对话兼容测试');await page.locator('#field-baseUrl').fill(local.provider.url);await page.locator('#field-model').fill('strict-chat-only');
  await page.locator('#field-toolMode').selectOption('none');
  await expect(page.locator('#dialog-body')).toContainText('已有对话内容仍会发送给模型');
  const saved=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/providers'&&response.request().method()==='POST');
  await page.locator('#dialog-submit').click();const {provider}=await(await saved).json();expect(provider.toolMode).toBe('none');
  await expect(page.locator('#app-dialog')).not.toBeVisible();await expect(page.locator('.provider-row').filter({hasText:'仅对话兼容测试'}).locator('.badge')).toContainText(['Chat Completions','仅对话']);
  await page.keyboard.press('Control+k');await page.locator('#model-select').selectOption(provider.id);
  await expect(page.locator('#model-select option:checked')).toContainText('仅对话');
  await expect(page.locator('#composer-disclaimer')).toContainText('输入与历史对话仍会发给模型');
  return provider;
}
async function send(page,text){await page.locator('#prompt-input').fill(text);await page.locator('#send-button').click();}
async function completed(page){await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');}
async function session(page){const id=await page.evaluate(()=>sessionStorage.getItem('openaster.current-session'));return page.evaluate(async value=>(await(await fetch('/api/sessions/'+value)).json()).session,id);}

test('capabilities: a strict chat-only endpoint supports streaming, usage and persistent multi-turn history',async({page,local})=>{
  const provider=await connect(page,local);await send(page,'第一轮仅对话输入');
  const first=await local.provider.next();expect(first.rejected).toBe(false);expect(first.input).not.toHaveProperty('tools');expect(first.input.stream).toBe(true);
  first.emit('仅对话也会逐步显示中文。');await expect(page.locator('.stream-content')).toContainText('逐步显示中文');
  first.finish({usage:{prompt_tokens:12,completion_tokens:6,total_tokens:18}});await completed(page);
  const originalId=(await session(page)).id;
  await page.locator('#context-toggle').click();await expect(page.locator('[data-usage-field=totalTokens]')).toHaveText('合计18 token');
  await send(page,'第二轮请结合刚才的回答');const second=await local.provider.next();expect(second.input).not.toHaveProperty('tools');
  expect(second.input.messages.some(message=>message.role==='user'&&message.content==='第一轮仅对话输入')).toBe(true);
  expect(second.input.messages.some(message=>message.role==='assistant'&&message.content.includes('逐步显示中文'))).toBe(true);
  second.finish({text:'保留了上一轮的对话内容。'});await completed(page);expect((await session(page)).id).toBe(originalId);
  expect(local.activity).toEqual([]);
  await page.reload();await expect(page.locator('#chat-title')).toHaveText('第一轮仅对话输入');await expect(page.locator('.message.assistant')).toHaveCount(2);
  await expect(page.locator('#composer-disclaimer')).toContainText('仅对话');
  await page.locator('.nav-item[data-action=settings]').click();await page.getByRole('button',{name:'编辑模型 仅对话兼容测试'}).click();
  await expect(page.locator('#field-toolMode')).toHaveValue('none');await page.locator('#field-model').fill('strict-chat-only-v2');
  const updated=page.waitForResponse(response=>response.request().method()==='PATCH'&&response.url().endsWith('/api/providers/'+provider.id));
  await page.locator('#dialog-submit').click();const saved=await(await updated).json();expect(saved.provider.id).toBe(provider.id);expect(saved.provider.toolMode).toBe('none');
  await expect(page.locator('#app-dialog')).not.toBeVisible();
  await page.getByRole('button',{name:'编辑模型 仅对话兼容测试'}).click();await expect(page.locator('#field-toolMode')).toHaveValue('none');
});

test('capabilities: unsolicited read and write tool calls are rejected before any workspace access or approval',async({page,local})=>{
  await writeFile(join(local.workspacePath,'private-note.txt'),'fake-local-secret-not-to-read');
  await connect(page,local);await send(page,'仅聊天，不授权任何文件工具');const request=await local.provider.next();expect(request.input).not.toHaveProperty('tools');
  request.finish({calls:[{name:'read_file',args:{path:'private-note.txt'}},{name:'write_file',args:{path:'blocked.md',content:'must never be written'}}]});
  await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('执行失败');await expect(page.locator('#run-error')).toBeVisible();
  await expect(page.locator('.approval-card')).toHaveCount(0);await expect(page.locator('.message.assistant')).toHaveCount(0);
  const current=await session(page);expect(current.approvals).toHaveLength(0);expect(current.run.steps.filter(step=>step.type==='tool')).toHaveLength(0);
  expect(local.activity).toEqual([]);expect(local.provider.requests).toHaveLength(1);
  expect(await readdir(local.workspacePath)).toEqual(['private-note.txt']);expect(await readFile(join(local.workspacePath,'private-note.txt'),'utf8')).toBe('fake-local-secret-not-to-read');
});

test('capabilities: workspace mode never silently downgrades and switching back preserves exact approval',async({page,local})=>{
  const provider=await connect(page,local);await send(page,'先建立仅对话任务');(await local.provider.next()).finish({text:'仅对话任务已建立。'});await completed(page);
  const originalId=(await session(page)).id;
  await page.locator('.nav-item[data-action=settings]').click();await page.getByRole('button',{name:'编辑模型 仅对话兼容测试'}).click();await page.locator('#field-toolMode').selectOption('workspace');
  const saved=page.waitForResponse(response=>response.request().method()==='PATCH'&&response.url().endsWith('/api/providers/'+provider.id));
  await page.locator('#dialog-submit').click();expect((await(await saved).json()).provider.toolMode).toBe('workspace');await expect(page.locator('#app-dialog')).not.toBeVisible();
  await expect(page.locator('.provider-row').filter({hasText:'仅对话兼容测试'}).locator('.badge')).toHaveText(['Chat Completions']);
  await page.locator('.session-link').filter({hasText:'先建立仅对话任务'}).click();await expect(page.locator('#composer-disclaimer')).toContainText('工具读取的文件');
  await send(page,'不支持工具时不得自动降级');const rejected=await local.provider.next();expect(rejected.rejected).toBe(true);expect(rejected.input.tools.length).toBeGreaterThan(0);
  await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('执行失败');expect(local.provider.requests).toHaveLength(2);
  local.provider.allowTools();await send(page,'创建经过明确审核的文件');const write=await local.provider.next();expect(write.input.tools.some(tool=>tool.function.name==='write_file')).toBe(true);
  write.finish({calls:[{name:'write_file',args:{path:'approved.md',content:'# 完整审核内容\n只有批准后写入。'}}]});
  await expect(page.locator('.approval-card')).toBeVisible();await expect(page.locator('.approval-preview').first()).toHaveText('# 完整审核内容\n只有批准后写入。');
  expect(await readdir(local.workspacePath)).toEqual([]);await page.locator('[data-action=approve]').click();
  const final=await local.provider.next();expect(final.input.messages.some(message=>message.role==='tool'&&message.content.includes('approved.md'))).toBe(true);
  final.finish({text:'文件已经在你批准后写入。'});await completed(page);expect((await session(page)).id).toBe(originalId);
  expect(await readFile(join(local.workspacePath,'approved.md'),'utf8')).toBe('# 完整审核内容\n只有批准后写入。');
  expect(local.activity).toContain('prepareWrite');expect(local.activity).toContain('commitWrite');
});
