import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const payload='<img src=x onerror="globalThis.__historyXss=1">';
function seed(dataDir,{fresh=false}={}) {
  const store=new Store(dataDir);try{
    const a=store.createSession({title:fresh?'新工作区的任务':'历史任务 A'}),b=store.createSession({title:'历史任务 B'});
    for(let n=0;n<(fresh?1:12);n++){
      const id='run-'+n,time=new Date(Date.UTC(2026,0,1,0,0,n)).toISOString(),legacy=n===0;
      a.run={id,status:n===11?'cancelled':legacy?'failed':'completed',startedAt:legacy?null:time,finishedAt:legacy?null:time,
        ...(legacy?{}:{connection:{providerId:'removed-provider',name:'旧连接 '+payload,type:'openai',model:'historic-model',toolMode:'workspace'},requestPreview:fresh?'新工作区记录':'A 请求 '+n,requestMessageId:'message-'+n,
          steps:[{id:'step-'+n,type:'model',title:'模型调用',status:n===11?'running':'completed',detail:'历史详情 '+n+' '+payload,createdAt:time,usage:n===11?{inputTokens:0,outputTokens:null,totalTokens:null,cachedInputTokens:null,cacheWriteInputTokens:null,reasoningOutputTokens:null}:null}],
          output:n===11?{stepId:'step-'+n,content:'保留的未完成片段 '+payload,status:'interrupted'}:null,error:n===11?{code:'CANCELLED',message:'当时已取消'}:null})};
      a.approvals=legacy?[]:[{id:'approval-'+n,runId:id,sessionId:a.id,tool:'edit_file',args:{path:'notes.txt',content:'private complete proposal'},preview:{before:'old text',after:'private complete proposal',originalHash:'a'.repeat(64),newHash:'b'.repeat(64)},status:n===11?'denied':'approved',createdAt:time,resolvedAt:time,...(n===11?{revoked:true}:{appliedAt:time})}];
      a.updatedAt=time;store.putSession(a);
    }
    const now='2026-01-02T00:00:00.000Z';b.run={id:'run-11',status:'failed',startedAt:now,finishedAt:now,requestPreview:'B 独立记录',steps:[{type:'tool',title:'B 独立步骤',status:'failed',detail:'只有 B 的内容'}],error:'B 的执行错误'};b.updatedAt=now;store.putSession(b);
    return {aId:a.id,bId:b.id};
  }finally{store.close();}
}
const test=base.extend({local:async({},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});const directory=await mkdtemp(resolve('test-results','run-history-ui-'));const dataDir=join(directory,'a'),ids=seed(dataDir);let app=await startServer({dataDir,workspaceId:randomUUID(),workspaceName:'执行记录测试'});
  try{await use({get app(){return app;},...ids,async switchWorkspace(){const port=app.server.address().port;await app.close();const next=join(directory,'b'),freshIds=seed(next,{fresh:true});app=await startServer({port,dataDir:next,workspaceId:randomUUID(),workspaceName:'新的执行记录工作区'});return freshIds;}});}finally{await app.close();}
}});
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
async function ready(page,local){await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');}
async function task(page,id){if(await page.locator('.mobile-menu').isVisible())await page.locator('.mobile-menu').click();await page.locator('.session-link[data-id="'+id+'"]').click();await expect(page.locator('#chat-title')).not.toHaveText('正在加载…');if(await page.locator('#context-toggle').getAttribute('aria-expanded')==='false')await page.locator('#context-toggle').click();}
async function openHistory(page){await page.locator('#run-history>summary').click();await expect(page.locator('#run-history-list')).toHaveAttribute('aria-busy','false');}
async function settled(page,response){await response.finished();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}
const entries=page=>page.locator('#run-history-list>.run-history-entry');
const entry=(page,id)=>page.locator('#run-history-list>.run-history-entry[data-run-id="'+id+'"]');
async function newRun(page,text){await page.locator('#prompt-input').fill(text);const sent=page.waitForResponse(response=>response.request().method()==='POST'&&/\/messages$/.test(new URL(response.url()).pathname));await page.locator('#send-button').click();await sent;await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');}
async function audit(page,testInfo,name){const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();await testInfo.attach(name,{body:JSON.stringify({violations:result.violations,incomplete:result.incomplete}),contentType:'application/json'});expect(result.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)}))).toEqual([]);}

test('run history: lazy pagination, immutable readonly details, exact usage and focus survive current-run updates',async({page,local})=>{
  const requests=[];page.on('request',request=>{if(/\/runs(?:\/|\?)/.test(new URL(request.url()).pathname+new URL(request.url()).search))requests.push(request.url());});await ready(page,local);await task(page,local.aId);expect(requests).toEqual([]);await expect(page.locator('#run-history')).not.toHaveAttribute('open','');
  await openHistory(page);await expect(entries(page)).toHaveCount(10);expect(requests).toHaveLength(1);await expect(page.locator('#run-history-count')).toHaveText('已加载 10 次');await entry(page,'run-11').locator(':scope>summary').click();await expect(entry(page,'run-11').locator('.history-record')).toBeVisible();
  const first=entry(page,'run-11');await expect(first).toContainText('当时未完成');await expect(first).toContainText('未完成输出');await expect(first).toContainText('已撤销');await expect(first.locator('[data-usage-field=inputTokens] strong')).toHaveText('0 token');await expect(first.locator('[data-usage-field=outputTokens] strong')).toHaveText('未提供');await expect(first).toContainText('历史详情 11 '+payload);await expect(first.locator('img,script')).toHaveCount(0);expect(await page.evaluate(()=>globalThis.__historyXss)).toBeUndefined();await expect(page.locator('#run-history [data-action=approve],#run-history [data-action=deny]')).toHaveCount(0);
  await first.locator(':scope>summary').focus();await page.evaluate(()=>{globalThis.__historyNode=document.querySelector('.run-history-entry');globalThis.__historyFocus=document.activeElement;});const refresh=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/sessions/'+local.aId);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await settled(page,await refresh);expect(await page.evaluate(()=>globalThis.__historyNode===document.querySelector('.run-history-entry')&&globalThis.__historyFocus===document.activeElement)).toBe(true);await expect(first).toHaveAttribute('open','');
  await page.locator('#run-history-more').click();await expect(entries(page)).toHaveCount(12);await expect(page.locator('#run-history-more')).not.toBeVisible();await entry(page,'run-0').locator(':scope>summary').click();await expect(entry(page,'run-0')).toContainText('历史连接未知');await expect(entry(page,'run-0')).toContainText('未提供模型用量');
  await newRun(page,'新的一次真实本地演示');await expect(page.locator('#run-history-new')).toBeVisible();await expect(entries(page)).toHaveCount(12);await expect(first).toHaveAttribute('open','');await expect(page.locator('#run-history-list')).not.toContainText('新的一次真实本地演示');
  await page.locator('[data-action=refresh-run-history]').click();await expect(entries(page)).toHaveCount(10);await expect(entries(page).first()).toContainText('新的一次真实本地演示');await expect(page.locator('#run-history-new')).not.toBeVisible();await entries(page).first().locator(':scope>summary').click();await expect(entries(page).first()).toContainText('本地演示，未调用模型');
  await page.reload();await expect(page.locator('#chat-title')).toHaveText('历史任务 A');await expect(page.locator('#run-history')).not.toHaveAttribute('open','');await openHistory(page);await expect(entries(page).first()).toContainText('新的一次真实本地演示');
});

test('run history: late page responses cannot replace a newer explicit refresh',async({page,local})=>{
  await ready(page,local);await task(page,local.aId);await openHistory(page);await expect(entries(page)).toHaveCount(10);const captured=deferred(),release=deferred();let first=true;
  await page.route('**/api/sessions/'+local.aId+'/runs?limit=10',async route=>{if(!first)return route.continue();first=false;const response=await route.fetch();captured.resolve();await release.promise;await route.fulfill({response});});
  await page.locator('[data-action=refresh-run-history]').click();await captured.promise;await newRun(page,'刷新竞态之后的新记录');await page.locator('[data-action=refresh-run-history]').click();await expect(entries(page).first()).toContainText('刷新竞态之后的新记录');
  const late=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/sessions/'+local.aId+'/runs');release.resolve();await settled(page,await late);await expect(entries(page).first()).toContainText('刷新竞态之后的新记录');await expect(page.locator('#run-history-new')).not.toBeVisible();
});

test('run history: delayed details and lists never cross task or same-origin workspace replacement',async({page,local})=>{
  await ready(page,local);await task(page,local.aId);await openHistory(page);await expect(entries(page)).toHaveCount(10);const detailCaptured=deferred(),releaseDetail=deferred();
  await page.route('**/api/sessions/'+local.aId+'/runs/run-11',async route=>{const response=await route.fetch();detailCaptured.resolve();await releaseDetail.promise;await route.fulfill({response});});await entry(page,'run-11').locator(':scope>summary').click();await detailCaptured.promise;await task(page,local.bId);await openHistory(page);await expect(entries(page)).toHaveCount(1);await entry(page,'run-11').locator(':scope>summary').click();await expect(entry(page,'run-11')).toContainText('只有 B 的内容');
  const detailResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/sessions/'+local.aId+'/runs/run-11');releaseDetail.resolve();await settled(page,await detailResponse);await expect(page.locator('#run-history')).not.toContainText('历史详情 11');await expect(page.locator('#run-history')).toContainText('只有 B 的内容');
  const pageCaptured=deferred(),releasePage=deferred();await page.route('**/api/sessions/'+local.bId+'/runs?limit=10',async route=>{const response=await route.fetch();pageCaptured.resolve();await releasePage.promise;await route.fulfill({response});});await page.locator('[data-action=refresh-run-history]').click();await pageCaptured.promise;const fresh=await local.switchWorkspace();await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('#workspace-label')).toHaveText('新的执行记录工作区');
  const pageResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/sessions/'+local.bId+'/runs');releasePage.resolve();await settled(page,await pageResponse);await task(page,fresh.aId);await openHistory(page);await expect(entries(page)).toHaveCount(1);await expect(page.locator('#run-history')).not.toContainText('B 独立记录');await expect(page.locator('#run-history')).not.toContainText('旧连接');
});

test('run history: mobile readonly records remain accessible in light and dark themes',async({browser,local},testInfo)=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();try{
    await ready(page,local);await task(page,local.aId);await openHistory(page);await expect(entries(page)).toHaveCount(10);await entry(page,'run-11').locator(':scope>summary').click();await expect(entry(page,'run-11').locator('.history-record')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await audit(page,testInfo,'history-mobile-light');await entry(page,'run-11').locator(':scope>summary').scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('history-mobile-light.png')});
    await page.locator('.mobile-menu').click();await page.locator('[data-action=theme]').click();await page.keyboard.press('Escape');await expect(page.locator('body')).toHaveClass('dark');await audit(page,testInfo,'history-mobile-dark');await entry(page,'run-11').locator(':scope>summary').scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('history-mobile-dark.png')});
  }finally{await context.close();}
});
