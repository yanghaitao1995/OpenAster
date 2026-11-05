import {readUtf8Body} from './helpers/http-body.mjs';
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../server/index.mjs';

// Test-controlled real HTTP/SSE, bound only to a random loopback port.
// Both model and application use disposable local data, never an external API.
async function usageProvider() {
  const pending=[],waiting=[],responses=new Set();
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
    const raw=await readUtf8Body(req);
    const input=JSON.parse(raw);let content='';
    responses.add(res);res.once('close',()=>responses.delete(res));
    if(input.stream){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.flushHeaders();}
    const frame=value=>res.write(`data: ${JSON.stringify(value)}\n\n`);
    const request={input,
      emit(text){content+=text;if(input.stream)frame({choices:[{index:0,delta:{content:text},finish_reason:null}]});},
      finish({text='',usage,tool=false}={}){
        if(text)this.emit(text);
        const calls=tool?[{id:randomUUID(),type:'function',function:{name:'list_workspace',arguments:'{}'}}]:undefined;
        if(input.stream){
          if(calls)frame({choices:[{index:0,delta:{tool_calls:calls.map((call,index)=>({index,...call}))},finish_reason:null}]});
          frame({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]});
          if(usage!==undefined)frame({choices:[],usage});
          res.end('data: [DONE]\n\n');
        }else{
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({choices:[{message:{role:'assistant',content,...(calls?{tool_calls:calls}:{})},finish_reason:tool?'tool_calls':'stop'}],...(usage===undefined?{}:{usage})}));
        }
      }
    };
    if(waiting.length)waiting.shift()(request);else pending.push(request);
  });
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  return {url:`http://127.0.0.1:${server.address().port}/v1`,next:()=>pending.length?Promise.resolve(pending.shift()):new Promise(done=>waiting.push(done)),
    async close(){for(const response of responses)response.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));}
  };
}
const test=base.extend({local:async({},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});
  const dataDir=await mkdtemp(resolve('test-results','usage-ui-'));
  const provider=await usageProvider();let app=await startServer({dataDir});
  try{await use({get app(){return app;},provider,dataDir,async restart(){await app.close();app=await startServer({dataDir});}});}
  finally{await app.close();await provider.close();}
}});
async function connect(page,local){
  await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');
  if(await page.locator('.mobile-menu').isVisible())await page.locator('.mobile-menu').click();
  await page.locator('.nav-item[data-action=settings]').click();await page.locator('[data-action=add-provider]').click();
  await page.locator('#field-name').fill('本机用量测试');await page.locator('#field-baseUrl').fill(local.provider.url);await page.locator('#field-model').fill('usage-fixture');
  const saved=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/providers'&&response.request().method()==='POST');
  await page.locator('#dialog-submit').click();const {provider}=await(await saved).json();await expect(page.locator('#app-dialog')).not.toBeVisible();
  await page.keyboard.press('Control+k');await page.locator('#model-select').selectOption(provider.id);return provider;
}
async function send(page,text){await page.locator('#prompt-input').fill(text);await page.locator('#send-button').click();}
const field=(page,key)=>page.locator(`#usage-summary [data-usage-field="${key}"]`);
async function finished(page){await ensureDetails(page);await expect(page.locator('.run-status')).toHaveText('已完成');}
function seed(local,providerId,overrides={}){
  const now=new Date().toISOString(),id=randomUUID();
  const session={id,title:'未执行的任务',providerId,createdAt:now,updatedAt:now,messages:[],approvals:[],run:null,...overrides};
  const db=new DatabaseSync(resolve(local.dataDir,'openaster.sqlite'));
  try{db.prepare('INSERT INTO sessions(id,updated_at,value) VALUES(?,?,?)').run(id,now,JSON.stringify(session));}finally{db.close();}
  return session;
}

test('usage: real multi-round reports aggregate once, remain stable during streaming and survive restart',async({page,local})=>{
  await connect(page,local);await send(page,'检查多轮模型用量');
  const first=await local.provider.next();expect(first.input.stream).toBe(true);
  first.finish({text:'先读取工作区。',tool:true,usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:40},completion_tokens_details:{reasoning_tokens:5}}});
  const second=await local.provider.next();expect(second.input.messages.some(message=>message.role==='tool')).toBe(true);
  second.emit('第二轮正在输出。');await expect(page.locator('.stream-content')).toContainText('第二轮正在输出');
  await ensureDetails(page);await expect(page.locator('.usage-coverage')).toHaveText('2 轮中 1 轮返回完整用量');
  await expect(field(page,'inputTokens')).toHaveText('已知输入100 token');
  await page.evaluate(()=>{globalThis.__usageFirst=document.querySelector('#usage-summary').firstChild;});
  second.emit('仍未完成的后续片段。');await expect(page.locator('.stream-content')).toContainText('仍未完成的后续片段');
  expect(await page.evaluate(()=>globalThis.__usageFirst===document.querySelector('#usage-summary').firstChild)).toBe(true);
  second.finish({usage:{prompt_tokens:30,completion_tokens:4,total_tokens:34,prompt_tokens_details:{cached_tokens:0},completion_tokens_details:{reasoning_tokens:1}}});
  await finished(page);await expect(page.locator('.usage-coverage')).toHaveText('2 轮中 2 轮返回完整用量');
  await expect(field(page,'inputTokens')).toHaveText('输入130 token');await expect(field(page,'outputTokens')).toHaveText('输出24 token');
  await expect(field(page,'totalTokens')).toHaveText('合计154 token');await expect(field(page,'cachedInputTokens')).toHaveText('缓存读取40 token');
  await expect(field(page,'reasoningOutputTokens')).toHaveText('推理输出6 token');
  await expect(page.locator('.usage-subset-note')).toContainText('不重复计入合计');
  const final=await page.locator('#usage-summary').textContent();
  await page.reload();await expect(page.locator('#usage-summary')).toHaveText(final);
  await local.restart();await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await page.locator('.session-link').filter({hasText:'检查多轮模型用量'}).click();await ensureDetails(page);await expect(page.locator('#usage-summary')).toHaveText(final);
});

test('usage: unknown, reported zero and partial reports remain distinct',async({page,local})=>{
  const provider=await connect(page,local);
  await send(page,'模型未提供任何用量');(await local.provider.next()).finish({text:'没有用量字段的回答。'});await finished(page);
  await expect(page.locator('.usage-coverage')).toHaveText('1 轮中 0 轮返回完整用量');await expect(page.locator('.usage-empty')).toHaveText('模型未提供用量。');
  await expect(page.locator('.usage-row')).toHaveCount(0);
  await page.keyboard.press('Control+k');await page.locator('#model-select').selectOption(provider.id);await send(page,'模型明确回报零');
  (await local.provider.next()).finish({text:'明确回报零。',usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}});await finished(page);
  await expect(page.locator('.usage-coverage')).toHaveText('1 轮中 1 轮返回完整用量');
  for(const key of ['inputTokens','outputTokens','totalTokens'])await expect(field(page,key).locator('strong')).toHaveText('0 token');
  await page.keyboard.press('Control+k');await page.locator('#model-select').selectOption(provider.id);await send(page,'模型仅回报部分字段');
  (await local.provider.next()).finish({text:'部分数据。',usage:{prompt_tokens:11,completion_tokens_details:{reasoning_tokens:0}}});await finished(page);
  await expect(page.locator('.usage-coverage')).toHaveText('1 轮中 0 轮返回完整用量');
  await expect(field(page,'inputTokens')).toHaveText('已知输入11 token');await expect(field(page,'outputTokens')).toHaveText('已知输出未提供');
  await expect(field(page,'totalTokens')).toHaveText('已知合计未提供');await expect(field(page,'reasoningOutputTokens')).toHaveText('推理输出0 token');
  await expect(page.locator('.usage-scope-note')).toContainText('缺失数据不按 0 计算');
});

test('usage: no run, legacy model steps and local demonstration do not invent token counts',async({page,local})=>{
  const provider=await connect(page,local);
  seed(local,provider.id);
  seed(local,provider.id,{title:'旧版无用量记录',run:{id:randomUUID(),status:'completed',steps:[{id:randomUUID(),type:'model',title:'模型调用',status:'completed'},{id:randomUUID(),type:'tool',title:'工具调用',status:'completed',usage:{inputTokens:999,outputTokens:999,totalTokens:1998}}],output:null,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),error:null}});
  await page.reload();await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await page.locator('.session-link').filter({hasText:'未执行的任务'}).click();await ensureDetails(page);await expect(page.locator('#usage-summary')).toHaveText('尚未运行。');
  await page.locator('.session-link').filter({hasText:'旧版无用量记录'}).click();
  await expect(page.locator('.usage-coverage')).toHaveText('1 轮中 0 轮返回完整用量');await expect(page.locator('.usage-empty')).toHaveText('模型未提供用量。');
  await expect(page.locator('#usage-summary')).not.toContainText('999');
  await page.keyboard.press('Control+k');await page.locator('#model-select').selectOption('demo');await send(page,'读取工作区清单');await finished(page);
  await expect(page.locator('#usage-summary')).toHaveText('本地演示，未调用模型。');await expect(page.locator('.usage-row')).toHaveCount(0);
});

test('usage: compact partial reporting is accessible on mobile and in dark theme',async({page,local},testInfo)=>{
  await page.setViewportSize({width:390,height:844});await connect(page,local);await send(page,'手机任务详情用量');
  (await local.provider.next()).finish({text:'移动端部分用量。',usage:{prompt_tokens:800,prompt_tokens_details:{cached_tokens:500}}});
  await expect(page.locator('.task-status-badge.completed').first()).toHaveText('已完成');
  await ensureDetails(page);await expect(field(page,'totalTokens')).toHaveText('已知合计未提供');
  for(let theme=0;theme<2;theme++){
    const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    await testInfo.attach(`mobile-partial-usage-${theme?'dark':'light'}`,{body:JSON.stringify({violations:audit.violations,incomplete:audit.incomplete}),contentType:'application/json'});
    expect(audit.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)}))).toEqual([]);
    if(!theme){await page.locator('.mobile-menu').click();await page.locator('[data-action=theme]').click();await page.keyboard.press('Escape');}
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

async function ensureDetails(page){
  await expect(page.locator('#context-toggle')).toBeVisible();
  if(await page.locator('#context-toggle').getAttribute('aria-expanded')==='false')await page.locator('#context-toggle').click();
  await expect(page.locator('#context-panel')).toBeVisible();
}
