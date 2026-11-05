import {readUtf8Body} from './helpers/http-body.mjs';
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const fields=['inputTokens','outputTokens','totalTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens'];
const usage=(values={})=>Object.fromEntries(fields.map(key=>[key,values[key]??null]));
const complete=(input=0,output=0)=>usage({inputTokens:input,outputTokens:output,totalTokens:input+output});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const xss='<img src=x onerror="globalThis.__overviewXss=1">';
const test=base.extend({local:async({},use)=>{
  const pending=[],waiters=[],responses=new Set();
  const model=createServer(async(req,res)=>{
    const raw=await readUtf8Body(req);
    const input=JSON.parse(raw);responses.add(res);res.on('close',()=>responses.delete(res));
    const request={input,finish(report){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'本机模型已完成。'},finish_reason:'stop'}],usage:report}));}};
    if(waiters.length)waiters.shift()(request);else pending.push(request);
  });
  await new Promise(done=>model.listen(0,'127.0.0.1',done));
  await mkdir(resolve('test-results'),{recursive:true});const directory=await mkdtemp(resolve('test-results','usage-overview-ui-'));
  const providerId=randomUUID(),connection={providerId,name:'原连接 '+xss,type:'openai',model:'original-model',toolMode:'none'};
  let dataDir=join(directory,'original');
  function mutate(fn){const store=new Store(dataDir);try{return fn(store);}finally{store.close();}}
  function initial(){mutate(store=>store.putProvider({id:providerId,name:connection.name,type:'openai',model:connection.model,toolMode:'none',enabled:true,streaming:false,baseUrl:`http://127.0.0.1:${model.address().port}/v1`,maxTokens:128,tokenParameter:'max_completion_tokens'}));}
  initial();let app=await startServer({dataDir,workspaceId:randomUUID(),workspaceName:'运行用量工作区'});
  try{await use({get app(){return app;},get dataDir(){return dataDir;},providerId,connection,mutate,
    next:()=>pending.length?Promise.resolve(pending.shift()):new Promise(done=>waiters.push(done)),
    async restart(){await app.close();app=await startServer({dataDir,workspaceName:'运行用量工作区'});},
    async switchWorkspace(){const port=app.server.address().port;await app.close();dataDir=join(directory,'replacement');initial();app=await startServer({port,dataDir,workspaceId:randomUUID(),workspaceName:'新的用量工作区'});}
  });}finally{for(const res of responses)res.destroy();await app.close();model.closeAllConnections();await new Promise(done=>model.close(done));}
}});
function addRun(store,{connection,steps=[{type:'model',usage:complete()}],status='completed',title='已保存运行',id=randomUUID()}={}){
  const session=store.createSession({title,providerId:connection?.providerId??'demo'}),now=new Date().toISOString();
  session.run={id,status,startedAt:now,...(['completed','failed','cancelled'].includes(status)?{finishedAt:now}:{}),...(connection?{connection}:{}),...(steps===undefined?{}:{steps})};
  session.updatedAt=now;store.putSession(session);return session;
}
function seedCoverage(local){return local.mutate(store=>{
  const zero=addRun(store,{connection:local.connection,steps:[{type:'model',usage:usage(Object.fromEntries(fields.map(key=>[key,0])))},{type:'tool',title:'工具步骤'},{title:'旧版类型未知的步骤'}]});
  addRun(store,{connection:local.connection,status:'failed',steps:[{type:'model',usage:usage({inputTokens:11,reasoningOutputTokens:0})}]});
  addRun(store,{status:'cancelled',steps:[{type:'model',usage:null}]});
  addRun(store,{connection:local.connection,status:'awaiting_approval',steps:[{type:'model',usage:usage({inputTokens:7})}]});
  addRun(store,{steps:null});
  addRun(store,{connection:{providerId:'demo',name:'本地演示',type:'demo',model:'deterministic',toolMode:'workspace'},steps:[{type:'tool',title:'本地分析'}]});
  const duplicate=addRun(store,{connection:local.connection,steps:[{type:'model',usage:complete(100,20)}]});
  // A retained history record outranks a stale current run with the same identity.
  duplicate.run.status='running';duplicate.run.steps=[{type:'model',usage:complete(999,999)}];store.putSession(duplicate);
  return zero.id;
});}
async function ready(page,local){await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');}
async function navigate(page,action){if(await page.locator('.mobile-menu').isVisible())await page.locator('.mobile-menu').click();await page.locator(`.nav-item[data-action=${action}]`).click();}
async function settings(page){await navigate(page,'settings');await expect(page.locator('#settings-view')).toBeVisible();}
async function openOverview(page){if(!await page.locator('#usage-overview').evaluate(node=>node.open))await page.locator('#usage-overview>summary').click();await expect(page.locator('#usage-overview-summary>.usage-overview-stats')).toBeVisible();}
const summary=page=>page.locator('#usage-overview-summary');
const token=(page,key)=>summary(page).locator(`[data-usage-overview-field=${key}]`);
const groups=page=>page.locator('#usage-overview-groups>.usage-overview-group');
async function settled(page,response){await response.finished();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}
async function syncState(page){const response=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/state');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await settled(page,await response);}
async function audit(page,testInfo,name){const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();await testInfo.attach(name,{body:JSON.stringify({violations:result.violations,incomplete:result.incomplete}),contentType:'application/json'});expect(result.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)}))).toEqual([]);}
async function captureOverview(page,testInfo,name){
  await page.evaluate(()=>{document.activeElement?.blur();document.getElementById('usage-overview').scrollIntoView({block:'start',behavior:'instant'});window.scrollBy({top:-66,behavior:'instant'});return new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));});
  await page.screenshot({path:testInfo.outputPath(name)});
}

test('usage overview: lazy real snapshot distinguishes unknown, zero, partial, active runs and history deduplication',async({page,local},testInfo)=>{
  seedCoverage(local);let requests=0;page.on('request',req=>{if(new URL(req.url()).pathname==='/api/usage')requests++;});
  await ready(page,local);await settings(page);expect(requests).toBe(0);await expect(page.locator('#usage-overview')).not.toHaveAttribute('open','');await openOverview(page);expect(requests).toBe(1);
  await expect(summary(page).locator('.usage-overview-count')).toHaveText('7 次运行 · 5 个模型步骤');
  await expect(summary(page).locator('.usage-overview-coverage')).toHaveText('5 个模型步骤中，2 个完整回报输入、输出和合计；2 个部分回报；1 个未提供用量。');
  await expect(summary(page)).toContainText('等待批准 1');await expect(summary(page)).not.toContainText('运行中 1');
  await expect(token(page,'inputTokens').locator('strong')).toHaveText('118 token');await expect(token(page,'outputTokens').locator('strong')).toHaveText('20 token');await expect(token(page,'totalTokens').locator('strong')).toHaveText('120 token');
  await expect(token(page,'cachedInputTokens').locator('strong')).toHaveText('0 token');await expect(token(page,'inputTokens')).toContainText('4 / 5 个模型步骤回报');
  await expect(summary(page)).toContainText('1 次运行缺少步骤记录');await expect(summary(page)).toContainText('1 个旧步骤类型未知');await expect(summary(page)).toContainText('2 次运行的历史连接未知');await expect(summary(page)).toContainText('1 次本地演示运行');
  const unknown=groups(page).filter({hasText:'历史连接未知'});await unknown.locator('summary').click();await expect(unknown.locator('[data-usage-overview-field=inputTokens] strong')).toHaveText('未提供');
  const historic=groups(page).filter({hasText:local.connection.name});await historic.locator('summary').click();await expect(historic).toContainText(local.connection.name);await expect(groups(page).locator('img,script')).toHaveCount(0);expect(await page.evaluate(()=>globalThis.__overviewXss)).toBeUndefined();
  await historic.locator('summary').focus();await page.evaluate(()=>{globalThis.__overviewFocus=document.activeElement;globalThis.__overviewGroup=document.activeElement.parentElement;});await syncState(page);
  expect(requests).toBe(1);expect(await page.evaluate(()=>globalThis.__overviewFocus===document.activeElement&&globalThis.__overviewGroup.open)).toBe(true);
  await captureOverview(page,testInfo,'usage-overview-desktop-light.png');await page.locator('[data-action=theme]').click();await page.locator('#toast-region [aria-label=关闭提示]').click();await captureOverview(page,testInfo,'usage-overview-desktop-dark.png');
  await page.reload();await expect(page.locator('#top-status')).toHaveText('本地已连接');await settings(page);expect(requests).toBe(1);await openOverview(page);await expect(token(page,'inputTokens').locator('strong')).toHaveText('118 token');
});

test('usage overview: real model run and historical connection survive rename/delete and restart; task deletion removes retained usage',async({page,local})=>{
  await ready(page,local);await page.locator('#model-select').selectOption(local.providerId);await page.locator('#prompt-input').fill('运行用量真实请求');await page.locator('#send-button').click();const request=await local.next();expect(request.input.messages.some(message=>message.content==='运行用量真实请求')).toBe(true);
  await settings(page);await openOverview(page);await expect(summary(page)).toContainText('运行中 1');await expect(token(page,'inputTokens').locator('strong')).toHaveText('未提供');
  request.finish({prompt_tokens:10,completion_tokens:2,total_tokens:12});await expect(page.locator('.task-state-mark.completed')).toHaveCount(1);await page.locator('#usage-overview-refresh').click();await expect(token(page,'inputTokens').locator('strong')).toHaveText('10 token');
  await page.locator(`[data-action=edit-provider][data-id="${local.providerId}"]`).click();await page.locator('#field-name').fill('已更名连接');await page.locator('#field-model').fill('second-model');await page.locator('#dialog-submit').click();await expect(page.locator('#app-dialog')).not.toBeVisible();
  await page.keyboard.press('Control+k');await page.locator('#model-select').selectOption(local.providerId);await page.locator('#prompt-input').fill('更名之后的新运行');await page.locator('#send-button').click();(await local.next()).finish({prompt_tokens:0,completion_tokens:0,total_tokens:0});await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
  await settings(page);await page.locator('#usage-overview-refresh').click();await expect(groups(page)).toHaveCount(2);await expect(page.locator('#usage-overview-groups')).toContainText(local.connection.name);await expect(page.locator('#usage-overview-groups')).toContainText('已更名连接');
  await page.locator(`[data-action=delete-provider][data-id="${local.providerId}"]`).click();await page.locator('#dialog-submit').click();await expect(page.locator('#app-dialog')).not.toBeVisible();await page.locator('#usage-overview-refresh').click();await expect(groups(page)).toHaveCount(2);await expect(page.locator('#usage-overview-groups')).toContainText('original-model');await expect(page.locator('#usage-overview-groups')).toContainText('second-model');
  await local.restart();await ready(page,local);await settings(page);await openOverview(page);await expect(groups(page)).toHaveCount(2);await expect(token(page,'totalTokens').locator('strong')).toHaveText('12 token');
  await page.locator('.session-link').filter({hasText:'运行用量真实请求'}).click();await page.locator('[data-action=delete-session]').click();await expect(page.locator('#dialog-body')).toContainText('执行记录');await expect(page.locator('#dialog-body')).toContainText('本地累计用量也会移除');await page.locator('#dialog-submit').click();await expect(page.locator('#app-dialog')).not.toBeVisible();
  await settings(page);await page.locator('#usage-overview-refresh').click();await expect(summary(page).locator('.usage-overview-count')).toHaveText('1 次运行 · 1 个模型步骤');await expect(token(page,'totalTokens').locator('strong')).toHaveText('0 token');await expect(groups(page)).toHaveCount(1);
});

test('usage overview: real cursor invalidation never mixes snapshots, failures retain a labelled older snapshot',async({page,local})=>{
  local.mutate(store=>{for(let i=0;i<22;i++)addRun(store,{connection:{...local.connection,name:'历史连接 '+i,model:'model-'+i},steps:[{type:'model',usage:complete(i,0)}]});});
  await ready(page,local);await settings(page);await openOverview(page);await expect(groups(page)).toHaveCount(20);await expect(summary(page)).toContainText('22 次运行');const old=await page.locator('#usage-overview-groups').textContent();
  local.mutate(store=>addRun(store,{connection:{...local.connection,name:'翻页期间新增连接'},steps:[{type:'model',usage:complete(1,0)}]}));
  const rejected=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/usage'&&res.status()===409);await page.locator('#usage-overview-more').click();await rejected;await expect(page.locator('#usage-overview-status')).toContainText('已停止分页');await expect(page.locator('#usage-overview-snapshot')).toContainText('旧快照');await expect(page.locator('#usage-overview-groups')).toHaveText(old);await expect(page.locator('#usage-overview-more')).toBeDisabled();
  await page.locator('#usage-overview-refresh').click();await expect(summary(page)).toContainText('23 次运行');await expect(page.locator('#usage-overview-snapshot')).not.toContainText('旧快照');await page.locator('#usage-overview-more').click();await expect(groups(page)).toHaveCount(23);await expect(page.locator('#usage-overview-more')).not.toBeVisible();await expect(groups(page).last().locator('summary')).toBeFocused();
  await page.route('**/api/usage?*',route=>route.fulfill({status:413,json:{error:{code:'USAGE_OVERVIEW_LIMIT',message:'测试读取预算拒绝'}}}));await page.locator('#usage-overview-refresh').click();await expect(page.locator('#usage-overview-status')).toContainText('本次未生成用量汇总');await expect(page.locator('#usage-overview-snapshot')).toContainText('旧快照');await expect(groups(page)).toHaveCount(23);await expect(summary(page)).toContainText('23 次运行');await expect(page.locator('#usage-overview-refresh')).toBeFocused();
  await page.unroute('**/api/usage?*');await page.locator('#usage-overview-refresh').click();await expect(page.locator('#usage-overview-status')).toHaveText('');await expect(page.locator('#usage-overview-snapshot')).not.toContainText('旧快照');
});

test('usage overview: late responses cannot cross navigation, capability withdrawal or workspace reconnection',async({browser,local})=>{
  const context=await browser.newContext();const page=await context.newPage();const releases=[];
  try{
    seedCoverage(local);await ready(page,local);await settings(page);await openOverview(page);
    let supported=true;await page.route(/\/api\/(bootstrap|state)$/,async route=>{const response=await route.fetch(),data=await response.json();if(!supported)delete data.capabilities.usageOverview;await route.fulfill({response,json:data});});
    let hold=null;await page.route('**/api/usage?*',async route=>{const response=await route.fetch();if(hold){const current=hold;hold=null;current.captured.resolve();await current.release.promise;}await route.fulfill({response});});
    const delay=()=>{const current={captured:deferred(),release:deferred()};releases.push(current.release);hold=current;return current;};
    const navigation=delay();await page.locator('#usage-overview-refresh').click();await navigation.captured.promise;await navigate(page,'workspace');await settings(page);
    local.mutate(store=>addRun(store,{connection:local.connection,steps:[{type:'model',usage:complete(3,0)}]}));await page.locator('#usage-overview-refresh').click();await expect(summary(page)).toContainText('8 次运行');const late=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/usage');navigation.release.resolve();await settled(page,await late);await expect(summary(page)).toContainText('8 次运行');
    const capability=delay();await page.locator('#usage-overview-refresh').click();await capability.captured.promise;supported=false;await syncState(page);await expect(page.locator('#usage-overview-refresh')).toBeDisabled();await expect(summary(page)).toBeEmpty();await expect(page.locator('#usage-overview-status')).toContainText('不支持运行用量');const capResponse=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/usage');capability.release.resolve();await settled(page,await capResponse);await expect(summary(page)).toBeEmpty();
    supported=true;await syncState(page);await expect(page.locator('#usage-overview-refresh')).toBeEnabled();await page.locator('#usage-overview-refresh').click();await expect(summary(page)).toContainText('8 次运行');
    const workspace=delay();await page.locator('#usage-overview-refresh').click();await workspace.captured.promise;await local.switchWorkspace();await page.locator('#settings-view [data-action=gateway]').click();await page.locator('#field-url').fill('');await page.locator('#dialog-submit').click();await expect(page.locator('#workspace-label')).toHaveText('新的用量工作区');await expect(page.locator('#app-dialog')).not.toBeVisible();const workspaceResponse=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/usage');workspace.release.resolve();await settled(page,await workspaceResponse);await settings(page);await openOverview(page);await expect(summary(page)).toContainText('尚无已保存的运行');await expect(groups(page)).toHaveCount(0);await expect(summary(page)).not.toContainText('8 次运行');
  }finally{for(const release of releases)release.resolve();await context.close();}
});

test('usage overview: empty and mobile partial snapshots remain accessible in both themes',async({browser,local},testInfo)=>{
  const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();try{
    await ready(page,local);await settings(page);await openOverview(page);await expect(summary(page)).toContainText('尚无已保存的运行');await expect(summary(page).locator('[data-usage-overview-field]')).toHaveCount(0);
    seedCoverage(local);await page.locator('#usage-overview-refresh').click();await expect(summary(page)).toContainText('7 次运行');await groups(page).filter({hasText:local.connection.name}).locator('summary').click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await audit(page,testInfo,'usage-overview-mobile-light');await captureOverview(page,testInfo,'usage-overview-mobile-light.png');
    await page.locator('.mobile-menu').click();await page.locator('[data-action=theme]').click();await page.keyboard.press('Escape');await expect(page.locator('body')).toHaveClass('dark');await page.locator('#toast-region [aria-label=关闭提示]').click();await audit(page,testInfo,'usage-overview-mobile-dark');await captureOverview(page,testInfo,'usage-overview-mobile-dark.png');
  }finally{await context.close();}
});

test('usage overview: aggregate decimal sums remain exact above the JavaScript safe integer range',async({page,local})=>{
  local.mutate(store=>{
    const session=store.createSession({title:'精确累计的历史运行'});
    store.transaction(()=>{for(let run=0;run<141;run++){
      const steps=Array.from({length:run<140?64:49},(_,step)=>({type:'model',usage:complete(run===140&&step===48?1:1_000_000_000_000,0)}));
      store.putRunHistory({sessionId:session.id,run:{id:randomUUID(),status:'completed',connection:local.connection,steps},approvals:[]});
    }});
  });
  await ready(page,local);await settings(page);await openOverview(page);await expect(summary(page)).toContainText('141 次运行 · 9009 个模型步骤');await expect(token(page,'inputTokens').locator('strong')).toHaveText('9,008,000,000,000,001 token');await expect(token(page,'totalTokens').locator('strong')).toHaveText('9,008,000,000,000,001 token');await expect(token(page,'outputTokens').locator('strong')).toHaveText('0 token');
});
