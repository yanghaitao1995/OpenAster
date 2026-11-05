import {readUtf8Body} from './helpers/http-body.mjs';
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';

// Only loopback HTTP is used. The model fixture emits real tool calls through
// the provider parser, runtime, immutable approval and workspace write path.
async function editProvider() {
  let plan;const requests=[],readResults=[],editResults=[],pageReads=[],seenPages=new Set(),sockets=new Set();
  const maxToolCalls=32,maxPageCalls=8;
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
    try{
      const body=await readUtf8Body(req);const input=JSON.parse(body);requests.push(input);
      const lastUser=input.messages.findLastIndex(item=>item.role==='user'),turn=input.messages.slice(lastUser+1);const tools=turn.filter(item=>item.role==='tool');
      const calls=new Map(turn.flatMap(item=>item.tool_calls||[]).map(call=>[call.id,call.function]));
      let call,content='';
      if(!tools.length)call={name:'read_file',arguments:JSON.stringify({path:plan.path})};
      else if(calls.get(tools.at(-1).tool_call_id)?.name==='edit_file'){const data=JSON.parse(tools.at(-1).content);editResults.push(data);content=data.error?'修改未应用：'+data.error.code:'修改已批准并写入。';}
      else {
        let data=JSON.parse(tools[0].content);if(data.error)throw Error(data.error.message);
        if(data.tool_result_view){
          const view=data.tool_result_view,chunks=[];let offset=0;
          if(view.mode==='excerpt'){if(view.offset!==0||Buffer.byteLength(view.content)!==view.endOffset)throw Error('Invalid initial excerpt');chunks.push(Buffer.from(view.content));offset=view.endOffset;}
          const pages=tools.filter(item=>calls.get(item.tool_call_id)?.name==='read_tool_result');
          if(pages.length>maxPageCalls)throw Error('Fixture page budget exceeded');
          for(const message of pages){const decoded=JSON.parse(message.content);if(decoded.error)throw Error(decoded.error.message);const page=decoded.result;
            if(!page||page.artifactId!==view.artifactId||page.sha256!==view.sha256||page.sourceBytes!==view.sourceBytes||page.offset!==offset||!Number.isSafeInteger(page.endOffset)||page.endOffset<=offset||page.endOffset>view.sourceBytes||Buffer.byteLength(page.content)!==page.endOffset-offset||(page.nextOffset===null?page.endOffset!==view.sourceBytes:page.nextOffset!==page.endOffset))throw Error('Mismatched original result page');
            chunks.push(Buffer.from(page.content));offset=page.endOffset;if(!seenPages.has(message.tool_call_id)){seenPages.add(message.tool_call_id);pageReads.push(page);}
          }
          if(offset<view.sourceBytes){if(pages.length>=maxPageCalls)throw Error('Fixture page budget exceeded');call={name:'read_tool_result',arguments:JSON.stringify({artifactId:view.artifactId,offset,maxBytes:8192})};}
          else {const original=Buffer.concat(chunks);if(original.length!==view.sourceBytes||createHash('sha256').update(original).digest('hex')!==view.sha256)throw Error('Original result hash mismatch');data=JSON.parse(original.toString('utf8'));}
        }
        if(!call){readResults.push(data);if(data.error)throw Error(data.error.message);call={name:'edit_file',arguments:JSON.stringify({path:plan.path,oldText:plan.oldText,newText:plan.newText,expectedHash:data.result.sha256})};}
      }
      if(call&&tools.length>=maxToolCalls)throw Error('Fixture tool budget exceeded');
      const message={role:'assistant',content};if(call)message.tool_calls=[{id:randomUUID(),type:'function',function:call}];
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message,finish_reason:call?'tool_calls':'stop'}]}));
    }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}
  });server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  return {url:`http://127.0.0.1:${server.address().port}/v1`,requests,readResults,editResults,pageReads,setPlan(value){plan=value;},async close(){for(const socket of sockets)socket.destroy();await new Promise(done=>server.close(done));}};
}
const test=base.extend({local:async({},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});const dataDir=await mkdtemp(resolve('test-results','file-edit-ui-'));const model=await editProvider();const app=await startServer({dataDir});
  try{await use({app,model,dataDir,async plan(before,oldText,newText,path='review.txt'){await writeFile(join(dataDir,'workspace',path),before);model.setPlan({path,oldText,newText});return {path,before,after:before.replace(oldText,()=>newText)};},async read(path='review.txt'){return readFile(join(dataDir,'workspace',path),'utf8');},async overwrite(content){await writeFile(join(dataDir,'workspace','review.txt'),content);}});}finally{await app.close();await model.close();}
}});
async function connect(page,local){
  await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');if(await page.locator('.mobile-menu').isVisible())await page.locator('.mobile-menu').click();await page.locator('.nav-item[data-action=settings]').click();await page.locator('[data-action=add-provider]').click();
  await page.locator('#field-name').fill('本机文件修改测试');await page.locator('#field-baseUrl').fill(local.model.url);await page.locator('#field-model').fill('literal-edit-fixture');await page.locator('#field-streaming').selectOption('false');
  const saved=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/providers');await page.locator('#dialog-submit').click();const{provider}=await(await saved).json();await expect(page.locator('#app-dialog')).not.toBeVisible();await page.keyboard.press('Control+k');await page.locator('#model-select').selectOption(provider.id);
}
async function send(page,text='审核一次精确文件修改'){await page.locator('#prompt-input').fill(text);await page.locator('#send-button').click();await expect(page.locator('.approval-card')).toBeVisible();}
async function done(page){await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');}
async function audit(page,testInfo,state){const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();await testInfo.attach(state,{body:JSON.stringify({violations:result.violations,incomplete:result.incomplete}),contentType:'application/json'});expect(result.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)}))).toEqual([]);}

test('file edit: exact BOM and newline changes are inert, preserve review state and only write the approved complete content',async({page,local},testInfo)=>{
  const source='\uFEFF标题\r\n旧行\r\n尾行\r\n',oldText='\uFEFF标题\r\n旧行',replacement='标题\n<img src=x onerror="globalThis.__editXss=1">\n新行';const plan=await local.plan(source,oldText,replacement);
  await connect(page,local);await send(page);await expect(page.locator('.approval-card h3')).toHaveText('文件修改需批准');expect(await local.read()).toBe(source);
  expect(local.model.readResults[0].result.sha256).toBe(createHash('sha256').update(source).digest('hex'));expect(local.model.readResults[0].result.content).toBe(source);
  await expect(page.locator('.diff-formats')).toContainText('有 UTF-8 BOM');await expect(page.locator('.diff-formats')).toContainText('无 BOM');await expect(page.locator('.diff-formats')).toContainText('CRLF');await expect(page.locator('.diff-formats')).toContainText('LF');await expect(page.locator('.diff-row.remove')).not.toHaveCount(0);await expect(page.locator('.diff-row.add')).not.toHaveCount(0);await expect(page.locator('.diff-table')).toContainText('<img src=x');expect(await page.locator('.approval-card img').count()).toBe(0);expect(await page.evaluate(()=>globalThis.__editXss)).toBeUndefined();
  await page.locator('.approval-complete>summary').click();await page.locator('.approval-original>summary').click();expect(await page.locator('.approval-complete pre').textContent()).toBe(plan.after);expect(await page.locator('.approval-original pre').textContent()).toBe(source);
  await page.locator('.approval-original>summary').focus();await page.evaluate(()=>{globalThis.__reviewNode=document.querySelector('.approval-card');globalThis.__reviewFocus=document.activeElement;});
  const refreshed=page.waitForResponse(response=>/\/api\/sessions\/[^/]+$/.test(new URL(response.url()).pathname));await page.evaluate(()=>window.dispatchEvent(new Event('online')));await (await refreshed).finished();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));await expect.poll(()=>page.evaluate(()=>globalThis.__reviewNode===document.querySelector('.approval-card')&&globalThis.__reviewFocus===document.activeElement)).toBe(true);await expect(page.locator('.approval-original')).toHaveAttribute('open','');await expect(page.locator('.approval-complete')).toHaveAttribute('open','');
  await page.locator('.approval-original>summary').click();await page.locator('.approval-complete>summary').click();await page.locator('.approval-card').screenshot({path:testInfo.outputPath('file-edit-desktop.png')});
  await page.locator('[data-action=approve]').click();await done(page);expect(await local.read()).toBe(plan.after);expect(local.model.editResults.at(-1).result.sha256).toBe(createHash('sha256').update(plan.after).digest('hex'));
  await page.reload();await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');if(await page.locator('#context-toggle').getAttribute('aria-expanded')!=='true')await page.locator('#context-toggle').click();await page.locator('.approval-history>summary').click();await expect(page.locator('.approval-record')).toContainText('已批准');await expect(page.locator('[data-action=approve]')).toHaveCount(0);
});

test('file edit: denial and cancellation both retain the original bytes',async({page,local})=>{
  const source='original\n';await local.plan(source,'original','changed');await connect(page,local);await send(page,'拒绝这个修改');await page.locator('[data-action=deny]').click();await done(page);expect(await local.read()).toBe(source);expect(local.model.editResults.at(-1).error.code).toBe('APPROVAL_DENIED');
  await send(page,'这次取消修改');await page.locator('#cancel-button').click();await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已停止');expect(await local.read()).toBe(source);await expect(page.locator('.approval-card')).toHaveCount(0);
});

test('file edit: an external change after preview is never overwritten by a late approval',async({page,local})=>{
  await local.plan('original\n','original','proposed');await connect(page,local);await send(page);await local.overwrite('external edit\n');await page.locator('[data-action=approve]').click();await done(page);expect(await local.read()).toBe('external edit\n');expect(local.model.editResults.at(-1).error.code).toBe('WRITE_CONFLICT');await expect(page.locator('#messages')).toContainText('WRITE_CONFLICT');await page.locator('#context-toggle').click();await expect(page.locator('#artifact-list .artifact-file')).toHaveCount(0);
});

test('file edit: over-budget differences use explicit fallback while complete before/after remain reviewable',async({page,local})=>{
  const source=Array.from({length:800},(_,i)=>'before '+i+'\n').join(''),after=Array.from({length:800},(_,i)=>'after '+i+'\n').join('');await local.plan(source,source,after);await connect(page,local);await send(page);await expect(page.locator('.diff-fallback')).toContainText('超过行匹配预算');await expect(page.locator('.diff-fallback')).toContainText('不代表没有改动');await expect(page.locator('.diff-row')).toHaveCount(0);
  expect(local.model.pageReads).toHaveLength(0);expect(local.model.readResults[0].result.content).toBe(source);expect(local.model.readResults[0].result.sha256).toBe(createHash('sha256').update(source).digest('hex'));expect(local.model.requests.every(request=>request.messages.filter(message=>message.role==='tool').length<=32)).toBe(true);
  await page.locator('.approval-original>summary').click();await page.locator('.approval-complete>summary').click();expect(await page.locator('.approval-original pre').textContent()).toBe(source);expect(await page.locator('.approval-complete pre').textContent()).toBe(after);await expect(page.locator('[data-action=approve]')).toBeEnabled();await page.locator('#cancel-button').click();expect(await local.read()).toBe(source);
});

test('file edit: mobile review is accessible in light and dark themes with complete original text',async({browser,local},testInfo)=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();try{
    await local.plan('\uFEFFfirst\r\nold\r\nlast','old','new');await connect(page,local);await send(page);await page.locator('.approval-original>summary').click();await page.locator('.approval-complete>summary').click();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await audit(page,testInfo,'file-edit-mobile-light');
    await page.locator('.mobile-menu').click();await page.locator('[data-action=theme]').click();await page.keyboard.press('Escape');await expect(page.locator('body')).toHaveClass('dark');await audit(page,testInfo,'file-edit-mobile-dark');await page.locator('.approval-original>summary').click();await page.locator('.approval-complete>summary').click();await page.locator('.approval-card').screenshot({path:testInfo.outputPath('file-edit-mobile-dark.png')});await page.locator('[data-action=deny]').click();await done(page);
  }finally{await context.close();}
});
