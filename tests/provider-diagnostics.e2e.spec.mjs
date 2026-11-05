import {readUtf8Body} from './helpers/http-body.mjs';
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function mockProvider(){
  const requests=[],responses=new Set(),waiters=[];let behavior='complete';
  const server=createServer(async(req,res)=>{
    const raw=await readUtf8Body(req);const input=JSON.parse(raw);const request={input,closed:deferred()};requests.push(request);responses.add(res);res.once('close',()=>{responses.delete(res);request.closed.resolve();});while(waiters.length)waiters.shift()(request);
    if(behavior==='hold')return;
    if(behavior==='auth'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'do-not-display-provider-secret'}}));return;}
    let content='OpenAster diagnostic OK. <img src=x onerror="globalThis.diagnosticXss=1">',calls=[];
    const toolResult=input.messages.find(message=>message.role==='tool');
    if(toolResult)content=JSON.parse(toolResult.content).result.receipt;
    else if(input.tools?.length&&behavior!=='unverified'){const tool=input.tools[0].function;calls=[{id:'diagnostic-call',type:'function',function:{name:tool.name,arguments:JSON.stringify({nonce:tool.parameters.properties.nonce.enum[0]})}}];content='';}
    if(input.stream&&behavior!=='unverified'){
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write(`data: ${JSON.stringify({choices:[{index:0,delta:{content},finish_reason:null}]})}\n\n`);
      res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
    }else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{role:'assistant',content,...(calls.length?{tool_calls:calls}:{})},finish_reason:calls.length?'tool_calls':'stop'}]}));}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  return{requests,url:`http://127.0.0.1:${server.address().port}/v1`,setBehavior(value){behavior=value;},next(){return new Promise(done=>waiters.push(done));},async close(){for(const res of responses)res.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));}};
}
const test=base.extend({local:async({},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});const dataDir=await mkdtemp(resolve('test-results','provider-diagnostics-ui-'));const workspace=join(dataDir,'workspace');await mkdir(workspace);await writeFile(join(workspace,'private.txt'),'WORKSPACE-CONTENT-MUST-NOT-BE-SENT');
  const provider=await mockProvider(),store=new Store(dataDir),id=randomUUID();store.putProvider({id,name:'本机诊断连接',type:'openai',baseUrl:provider.url,model:'diagnostic-model',streaming:true,toolMode:'workspace',maxTokens:4096,tokenParameter:'max_completion_tokens',enabled:true});store.close();
  const app=await startServer({dataDir,workspaceId:randomUUID(),workspaceName:'诊断测试工作区'});
  const local={app,provider,id,workspace,lifecycle:[],onPageTeardown:null,onRoutesDrained:null,onBeforeServerClose:null};
  try{await use(local);}finally{try{await local.onBeforeServerClose?.();}finally{try{await app.close();}finally{await provider.close();}}}
},page:async({browser,local},use)=>{
  // The dependency on local keeps the app alive until every page route has settled.
  // These route-interception fixtures need ownership of every tested request;
  // service-worker behavior is covered separately, not by these transport gates.
  const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block'}),page=await context.newPage();
  try{await use(page);}finally{
    try{local.lifecycle.push('page-teardown-start');await local.onPageTeardown?.();await page.unrouteAll({behavior:'wait'});local.lifecycle.push('routes-drained');await local.onRoutesDrained?.();}
    finally{await context.close();local.lifecycle.push('context-closed');}
  }
}});
const row=page=>page.locator('.provider-row').filter({hasText:'本机诊断连接'});
const status=page=>page.locator('#provider-diagnostic-status');
const check=(page,name)=>page.locator(`#provider-diagnostic-checks [data-check="${name}"]`);
async function ready(page,local){await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');await page.locator('.nav-item[data-action=settings]').click();await expect(row(page)).toBeVisible();}
async function open(page){await row(page).locator('[data-action=test-provider]').click();await expect(page.locator('#app-dialog')).toBeVisible();await expect(status(page)).toHaveText('尚未发送请求。');}
async function run(page,local,legacy=false){const response=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/providers/${local.id}/${legacy?'test':'diagnostics'}`);await page.locator('#dialog-submit').click();const result=await response;await expect(page.locator('#provider-diagnostic-checks')).toHaveAttribute('aria-busy','false');return result;}
async function syncState(page){const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await(await response).finished();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}
async function updateConnection(page,local,fields){await page.evaluate(async({id,fields})=>{const state=await(await fetch('/api/bootstrap')).json();const response=await fetch('/api/providers/'+id,{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrfToken},body:JSON.stringify(fields)});if(!response.ok)throw Error(await response.text());},{id:local.id,fields});await syncState(page);}
async function capture(page,info,name){await page.screenshot({path:info.outputPath(name),animations:'disabled',fullPage:true});}
async function audit(page,info,name){const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();await info.attach(name,{body:JSON.stringify({violations:result.violations,incomplete:result.incomplete}),contentType:'application/json'});expect(result.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)}))).toEqual([]);}

test('provider diagnostics: explicit consent runs a real four-request loopback probe without workspace or task contents',async({page,local},info)=>{
  await ready(page,local);await expect(row(page).locator('[data-action=test-provider]')).toHaveText('兼容性诊断');await open(page);expect(local.provider.requests).toHaveLength(0);await expect(page.locator('#dialog-body')).toContainText('最多 4 次模型请求，可能计费');await expect(page.locator('#dialog-submit')).toBeFocused();
  await audit(page,info,'provider-diagnostics-desktop-ready');await capture(page,info,'provider-diagnostics-desktop-ready.png');const response=await run(page,local);expect(response.status()).toBe(200);const data=await response.json();expect(data.requestsStarted).toBe(4);for(const name of ['text','stream','tools'])await expect(check(page,name)).toHaveAttribute('data-status','passed');await expect(page.locator('#app-dialog')).toBeVisible();await expect(status(page)).toContainText('当时配置的一次结果');await expect(status(page)).toContainText('4 次模型请求');
  await expect(page.getByRole('button',{name:'关闭',exact:true})).toHaveCount(1);await expect(page.locator('.dialog-actions [data-action=close-dialog]')).toBeHidden();expect(local.provider.requests).toHaveLength(4);expect(JSON.stringify(local.provider.requests.map(item=>item.input))).not.toContain('WORKSPACE-CONTENT');expect(local.provider.requests[2].input.tools[0].function.name).toBe('openaster_diagnostic_echo');expect(local.provider.requests[3].input.messages.some(message=>message.role==='tool')).toBe(true);expect(await readFile(join(local.workspace,'private.txt'),'utf8')).toBe('WORKSPACE-CONTENT-MUST-NOT-BE-SENT');
  await expect(page.locator('#app-dialog img,#app-dialog script')).toHaveCount(0);expect(await page.evaluate(()=>globalThis.diagnosticXss)).toBeUndefined();await expect(page.locator('#app-dialog')).not.toContainText('onerror');await capture(page,info,'provider-diagnostics-desktop.png');
  await syncState(page);await page.keyboard.press('Escape');await expect(page.locator('#app-dialog')).not.toBeVisible();await expect(row(page).locator('[data-action=test-provider]')).toBeFocused();const state=await page.evaluate(async()=>(await(await fetch('/api/state')).json()));expect(state.sessions).toEqual([]);
});

test('provider diagnostics: JSON fallback and missing tool calls remain unverified, disabled probes skip, and authentication stops further requests',async({page,local})=>{
  await ready(page,local);local.provider.setBehavior('unverified');await open(page);await run(page,local);await expect(check(page,'text')).toHaveAttribute('data-status','passed');await expect(check(page,'stream')).toHaveAttribute('data-status','unverified');await expect(check(page,'tools')).toHaveAttribute('data-status','unverified');await expect(status(page)).toContainText('3 次模型请求');await page.locator('#dialog-submit').click();
  await updateConnection(page,local,{streaming:false,toolMode:'none'});await open(page);await expect(page.locator('#dialog-body')).toContainText('流式关闭，将跳过');const before=local.provider.requests.length;await run(page,local);expect(local.provider.requests.length-before).toBe(1);await expect(check(page,'stream')).toHaveAttribute('data-status','skipped');await expect(check(page,'tools')).toHaveAttribute('data-status','skipped');await page.locator('#dialog-submit').click();
  await updateConnection(page,local,{streaming:true,toolMode:'workspace'});local.provider.setBehavior('auth');await open(page);const prior=local.provider.requests.length;await run(page,local);expect(local.provider.requests.length-prior).toBe(1);await expect(check(page,'text')).toHaveAttribute('data-status','failed');await expect(check(page,'stream')).toHaveAttribute('data-status','skipped');await expect(check(page,'tools')).toHaveAttribute('data-status','skipped');await expect(page.locator('#app-dialog')).not.toContainText('do-not-display-provider-secret');
});

test('provider diagnostics: closing aborts the real upstream request and opening another dialog cannot receive its result',async({page,local})=>{
  await ready(page,local);local.provider.setBehavior('hold');await open(page);const next=local.provider.next();await page.locator('#dialog-submit').click();const request=await next;await expect(status(page)).toContainText('停止等待，已发请求仍可能计费');await page.keyboard.press('Escape');await request.closed.promise;await expect(page.locator('#app-dialog')).not.toBeVisible();await expect(row(page).locator('[data-action=test-provider]')).toBeFocused();expect(local.provider.requests).toHaveLength(1);
  await page.locator('[data-action=add-provider]').click();await expect(page.locator('#dialog-title')).toHaveText('连接一个模型');await expect(page.locator('.dialog-actions [data-action=close-dialog]')).toBeVisible();await expect(page.locator('#field-name')).toBeFocused();await syncState(page);await expect(page.locator('#dialog-title')).toHaveText('连接一个模型');await expect(page.locator('#provider-diagnostic-checks')).toHaveCount(0);await page.keyboard.press('Escape');
  await open(page);const nextHidden=local.provider.next();await page.locator('#dialog-submit').click();const hiddenRequest=await nextHidden;await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await hiddenRequest.closed.promise;await expect(page.locator('#app-dialog')).not.toBeVisible();await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  // Resuming performs a fresh authentication bootstrap before diagnostics can open.
  await expect(page.locator('#top-status')).toHaveText('本地已连接');await open(page);await expect(page.locator('#dialog-submit')).toBeEnabled();await expect(status(page)).toHaveText('尚未发送请求。');expect(local.provider.requests).toHaveLength(2);
});

test('provider diagnostics: older gateways use only the disclosed text endpoint and demo remains a no-network check',async({page,local})=>{
  for(const path of ['bootstrap','state'])await page.route('**/api/'+path,async route=>{const response=await route.fetch(),data=await response.json();delete data.capabilities.providerDiagnostics;await route.fulfill({response,json:data});});let diagnostics=0;page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/diagnostics'))diagnostics++;});await ready(page,local);await expect(row(page).locator('[data-action=test-provider]')).toHaveText('测试连接');await open(page);expect(local.provider.requests).toHaveLength(0);await expect(page.locator('#dialog-body')).toContainText('只发送短文本测试，可能计费');await run(page,local,true);expect(diagnostics).toBe(0);expect(local.provider.requests).toHaveLength(1);await expect(status(page)).toContainText('旧版工作台仅完成短文本测试');await expect(check(page,'stream')).toHaveAttribute('data-status','skipped');await page.locator('#dialog-submit').click();
  await page.locator('[data-action=test-provider][data-id=demo]').click();await expect(page.locator('#dialog-body')).toContainText('不发送网络模型请求');await page.locator('#dialog-submit').click();await expect(status(page)).toContainText('本地确定性演示可用');expect(local.provider.requests).toHaveLength(1);await expect(check(page,'text')).toHaveAttribute('data-status','skipped');
});

test('provider diagnostics: late completed responses cannot survive provider, capability, navigation or workspace changes',async({page,local})=>{
  test.setTimeout(90000);await ready(page,local);
  for(const reason of ['provider','capability','navigation','workspace']){
    const captured=deferred(),release=deferred(),delivered=deferred();await page.route('**/api/providers/'+local.id+'/diagnostics',async route=>{const response=await route.fetch();captured.resolve();await release.promise;await route.fulfill({response}).catch(()=>{});delivered.resolve();});
    try{await open(page);await page.locator('#dialog-submit').click();await captured.promise;
      if(reason==='navigation'){await page.evaluate(()=>document.querySelector('.brand[data-action=home]').click());await expect(page.locator('#home-view')).toBeVisible();await expect(page.locator('#app-dialog')).not.toBeVisible();}
      else{
        let replacementWorkspace;
        // Identity changes require a fresh authenticated bootstrap. Both reads
        // must describe the same replacement; keep the real response's CSRF.
        const routePattern=reason==='workspace'?/\/api\/(?:state|bootstrap)$/:'**/api/state';
        await page.route(routePattern,async route=>{
          const response=await route.fetch(),data=await response.json();
          if(reason==='provider')data.providers.find(item=>item.id===local.id).model='changed-model';
          else if(reason==='capability')delete data.capabilities.providerDiagnostics;
          else {replacementWorkspace??={...data.workspace,id:randomUUID(),path:data.workspace.path+'-replacement',name:'新的诊断工作区'};data.workspace={...replacementWorkspace};}
          await route.fulfill({response,json:data});
        });await syncState(page);if(reason==='workspace'){await expect(page.locator('#workspace-label')).toHaveText('新的诊断工作区');await expect(page.locator('#app-dialog')).not.toBeVisible();}else{await expect(status(page)).toContainText('已失效');await expect(page.locator('#provider-diagnostic-checks [data-check]')).toHaveCount(0);}}
      release.resolve();await delivered.promise;await expect(page.locator('#provider-diagnostic-checks [data-status=passed]')).toHaveCount(0);
    }finally{release.resolve();await delivered.promise;await page.unrouteAll({behavior:'wait'});}
    await page.reload();await expect(page.locator('#top-status')).toHaveText('本地已连接');await page.locator('.nav-item[data-action=settings]').click();
  }
});

test('provider diagnostics: mobile light and dark report controls and statuses remain accessible',async({page,local},info)=>{
  await page.setViewportSize({width:390,height:844});await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');await page.locator('.mobile-menu').click();await page.locator('.nav-item[data-action=settings]').click();local.provider.setBehavior('unverified');await updateConnection(page,local,{toolMode:'none'});await open(page);await run(page,local);await expect(check(page,'stream')).toHaveAttribute('data-status','unverified');await expect(check(page,'tools')).toHaveAttribute('data-status','skipped');expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await audit(page,info,'provider-diagnostics-mobile-light');await capture(page,info,'provider-diagnostics-mobile-light.png');await page.keyboard.press('Escape');await page.locator('.mobile-menu').click();await page.locator('[data-action=theme]').click();await page.keyboard.press('Escape');await open(page);await run(page,local);await audit(page,info,'provider-diagnostics-mobile-dark');await capture(page,info,'provider-diagnostics-mobile-dark.png');
});

test('provider diagnostics: fixture drains pending route fetches and closes its browser context before the app',async({page,local})=>{
  await ready(page,local);
  const entered=deferred(),release=deferred(),endpoint='/api/state?fixture=route-teardown';let completed=0,browserOutcome;
  await page.route(url=>url.pathname==='/api/state'&&url.search==='?fixture=route-teardown',async route=>{entered.resolve();await release.promise;const response=await route.fetch();expect(response.status()).toBe(200);await route.fulfill({response});completed++;});
  local.onPageTeardown=()=>{expect(local.app.server.listening).toBe(true);expect(completed).toBe(0);release.resolve();};
  local.onRoutesDrained=async()=>{expect(completed).toBe(1);expect(page.isClosed()).toBe(false);const outcome=await browserRequest;if(outcome.error)throw outcome.error;browserOutcome=outcome.value;expect(browserOutcome).toEqual({status:200,ok:true});};
  local.onBeforeServerClose=()=>{expect(local.lifecycle).toEqual(['page-teardown-start','routes-drained','context-closed']);expect(completed).toBe(1);expect(browserOutcome).toEqual({status:200,ok:true});expect(page.isClosed()).toBe(true);expect(local.app.server.listening).toBe(true);};
  // Start an explicit browser request without waiting for its response here.
  // Visibility and background refresh scheduling are not this fixture's subject.
  const browserRequest=page.evaluate(async url=>{const response=await fetch(url,{cache:'no-store'});await response.arrayBuffer();return{status:response.status,ok:response.ok};},endpoint).then(value=>({value}),error=>({error}));
  await Promise.race([entered.promise,browserRequest.then(outcome=>{if(outcome.error)throw outcome.error;throw new Error('The controlled browser request completed without entering its route gate.');})]);
  // Return with a handler deliberately paused before route.fetch. Fixture teardown must release and await it.
  expect(completed).toBe(0);
});
