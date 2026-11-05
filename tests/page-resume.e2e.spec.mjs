import { test as base, expect } from '@playwright/test';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server/index.mjs';

// Playwright disables BFCache by default. The first test requires a real cached
// document; the fault-injection tests below separately exercise late responses.
const test=base.extend({local:async({},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});
  const root=await mkdtemp(resolve('test-results','page-resume-'));
  const app=await startServer({dataDir:join(root,'local')});
  const requests=[];app.server.on('request',req=>requests.push({method:req.method,path:req.url}));
  const away=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Owned navigation fixture</title><p>Return to the workbench</p>');});
  await new Promise(done=>away.listen(0,'127.0.0.1',done));
  try{await use({app,root,requests,away:`http://127.0.0.1:${away.address().port}`});}
  finally{await new Promise(done=>away.close(done));await app.close();}
}});
test.use({launchOptions:{chromiumSandbox:true,ignoreDefaultArgs:['--disable-back-forward-cache']}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const hide=page=>page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
const show=page=>page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
async function ready(page,local){await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');}

test('page resume: actual BFCache return reconnects SSE, keeps the draft, and receives later task updates',async({page,local},testInfo)=>{
  await page.addInitScript(()=>{
    globalThis.documentIdentity=crypto.randomUUID();globalThis.pageLifecycle=[];
    for(const name of ['pagehide','pageshow'])window.addEventListener(name,event=>pageLifecycle.push({name,persisted:event.persisted,visibility:document.visibilityState}));
    document.addEventListener('visibilitychange',()=>pageLifecycle.push({name:'visibilitychange',visibility:document.visibilityState}));
  });
  await ready(page,local);await expect.poll(()=>local.requests.filter(r=>r.path==='/api/events').length).toBe(1);
  const identity=await page.evaluate(()=>documentIdentity);
  await page.locator('#prompt-input').fill('返回后仍需我确认发送的草稿');
  await page.goto(local.away);await page.goBack({waitUntil:'commit'});
  await expect.poll(()=>page.evaluate(()=>globalThis.documentIdentity)).toBe(identity);
  expect(await page.evaluate(()=>pageLifecycle.some(e=>e.name==='pageshow'&&e.persisted))).toBe(true);
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await expect(page.locator('#prompt-input')).toHaveValue('返回后仍需我确认发送的草稿');
  await expect.poll(()=>local.requests.filter(r=>r.path==='/api/events').length).toBe(2);
  const bootstrap=await(await page.request.get(local.app.url+'/api/bootstrap')).json();
  const created=await page.request.post(local.app.url+'/api/sessions',{headers:{'X-CSRF-Token':bootstrap.csrfToken},data:{title:'返回之后由另一个客户端创建的任务',providerId:'demo'}});
  expect(created.status()).toBe(201);
  await expect(page.getByRole('button',{name:'返回之后由另一个客户端创建的任务，准备开始',exact:true})).toHaveCount(1);
  expect(local.requests.filter(r=>r.method==='POST'&&/\/messages$/.test(r.path))).toEqual([]);
  await testInfo.attach('actual-bfcache-lifecycle',{body:JSON.stringify(await page.evaluate(()=>({id:documentIdentity,events:pageLifecycle})),null,2),contentType:'application/json'});
});

test('page resume: late bootstrap cannot reconnect a suspended page; returning starts one new connection',async({page,local})=>{
  const captured=deferred(),release=deferred();let bootstraps=0;
  await page.route('**/api/bootstrap',async route=>{bootstraps++;if(bootstraps!==1)return route.continue();const response=await route.fetch();captured.resolve();await release.promise;await route.fulfill({response});});
  try{
    await page.goto(local.app.url);await captured.promise;await page.locator('#prompt-input').fill('初次连接中的草稿');
    await hide(page);const delivered=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/bootstrap');release.resolve();await(await delivered).finished();
    await expect(page.locator('#top-status')).toHaveText('连接未就绪');await expect(page.locator('#send-button')).toBeDisabled();
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    expect(bootstraps).toBe(1);expect(local.requests.filter(r=>r.path==='/api/events')).toEqual([]);
    await show(page);await expect(page.locator('#top-status')).toHaveText('本地已连接');
    expect(bootstraps).toBe(2);await expect.poll(()=>local.requests.filter(r=>r.path==='/api/events').length).toBe(1);
    await expect(page.locator('#prompt-input')).toHaveValue('初次连接中的草稿');await expect(page.locator('#send-button')).toBeEnabled();
  }finally{release.resolve();}
});

test('page resume: a delayed task creation never automatically sends its draft after suspension',async({page,local})=>{
  await ready(page,local);const captured=deferred(),release=deferred();
  await page.route('**/api/sessions',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();captured.resolve();await release.promise;await route.fulfill({response});});
  try{
    await page.locator('#prompt-input').fill('这条草稿不能在返回页面后自动发送');await page.locator('#send-button').click();await captured.promise;
    await hide(page);const delivered=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/sessions');release.resolve();await(await delivered).finished();
    await show(page);await expect(page.locator('#top-status')).toHaveText('本地已连接');await expect(page.locator('#send-button')).toBeEnabled();
    await expect(page.locator('#prompt-input')).toHaveValue('这条草稿不能在返回页面后自动发送');
    expect(local.requests.filter(r=>r.method==='POST'&&/\/messages$/.test(r.path))).toEqual([]);
    const state=await(await page.request.get(local.app.url+'/api/state')).json();expect(state.sessions).toHaveLength(1);
    const saved=await(await page.request.get(local.app.url+'/api/sessions/'+state.sessions[0].id)).json();expect(saved.session.messages).toEqual([]);
  }finally{release.resolve();}
});

test('native first start: an unconfigured asset shell settles without local API requests and requires explicit HTTPS pairing',async({page,local})=>{
  // Exercise the actual UI at the Capacitor asset origin, with its HTML fallback.
  // HTTPS transport/native detection are fixtures, not Android or TLS validation.
  const assetOrigin='https://localhost',origin='https://gateway.invalid',token=randomBytes(32).toString('hex');
  const gateway=await startServer({dataDir:join(local.root,'first-native-gateway'),gatewayOrigin:origin,token,allowedOrigins:[assetOrigin]});
  const assetApi=[],gatewayRequests=[],pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(()=>{globalThis.Capacitor={isNativePlatform:()=>true};});
  await page.route(assetOrigin+'/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname.startsWith('/api/')){
      assetApi.push({method:request.method(),path:url.pathname});
      return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Local asset fallback</title>'});
    }
    const response=await page.request.get(local.app.url+url.pathname+url.search);
    const headers={...response.headers()};
    if(url.pathname==='/')headers['content-security-policy']=headers['content-security-policy'].replace("connect-src 'self'","connect-src 'self' "+origin);
    await route.fulfill({response,headers});
  });
  await page.route(origin+'/**',async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;
    gatewayRequests.push({method:request.method(),path:pathname,authorized:request.headers().authorization===`Bearer ${token}`});
    if(pathname==='/api/events')return route.fulfill({status:gatewayRequests.at(-1).authorized?200:401,headers:{'access-control-allow-origin':assetOrigin},contentType:'text/event-stream',body:': fixture stream\n\n'});
    const response=await page.request.fetch(gateway.url+pathname,{method:request.method(),headers:{...request.headers(),host:new URL(origin).host,origin:assetOrigin},data:request.postData()??undefined});
    await route.fulfill({response});
  });
  try{
    await page.goto(assetOrigin);
    await expect(page.locator('#connection-message')).toContainText('请先配置 HTTPS 网关');
    await expect(page.locator('#model-select')).toBeDisabled();
    await expect(page.locator('#model-select option:checked')).toHaveText('请先配置网关');
    await expect(page.locator('#send-button')).toBeDisabled();
    expect(assetApi).toEqual([]);expect(gatewayRequests).toEqual([]);
    await page.locator('#connection-banner [data-action=reconnect]').click();
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await hide(page);await show(page);
    await expect(page.locator('#connection-message')).toContainText('请先配置 HTTPS 网关');
    expect(assetApi).toEqual([]);expect(gatewayRequests).toEqual([]);
    await page.locator('#connection-banner [data-action=gateway]').click();
    await expect(page.locator('#field-url')).toHaveValue('');
    await page.locator('#dialog-submit').click();
    await expect(page.locator('#dialog-error')).toContainText('请输入你自己的 HTTPS 网关地址');
    await page.locator('#field-url').fill('http://127.0.0.1:19443');
    await page.locator('#dialog-submit').click();
    await expect(page.locator('#dialog-error')).toContainText('必须使用 HTTPS');
    expect(assetApi).toEqual([]);expect(gatewayRequests).toEqual([]);
    await page.locator('#field-url').fill(origin);
    await page.locator('#dialog-submit').click();
    await expect(page.locator('#dialog-error')).toContainText('请输入访问令牌');
    expect(gatewayRequests).toEqual([]);
    await page.locator('#field-token').fill(token);await page.locator('#dialog-submit').click();
    await expect(page.locator('#top-status')).toHaveText('网关已连接');
    await expect(page.locator('#model-select')).toHaveValue('demo');
    await expect(page.locator('#model-select')).toBeEnabled();
    await expect(page.locator('#app-dialog')).not.toBeVisible();
    await expect.poll(()=>gatewayRequests.some(request=>request.path==='/api/events'&&request.authorized)).toBe(true);
    expect(assetApi).toEqual([]);
    expect(gatewayRequests.every(request=>request.authorized&&request.method==='GET')).toBe(true);
    expect(pageErrors).toEqual([]);
  }finally{await page.unrouteAll({behavior:'wait'});await page.close();await gateway.close();}
});

for(const height of [568,360])test(`native gateway dialog: validation keeps heading and actions reachable at 360x${height}`,async({page,local},testInfo)=>{
  // Reduced CSS viewport models the measured WebView area/keyboard resize; it
  // does not assert Android IME behaviour or replace the native screenshot.
  await page.setViewportSize({width:360,height});
  await page.addInitScript(()=>{globalThis.Capacitor={isNativePlatform:()=>true};});
  await page.goto(local.app.url);
  await expect(page.locator('#connection-message')).toContainText('请先配置 HTTPS 网关');
  await page.locator('#connection-banner [data-action=gateway]').click();
  await expect(page.locator('#field-url')).toHaveValue('');
  await page.locator('#dialog-submit').click();
  await expect(page.locator('#dialog-error')).toContainText('请输入你自己的 HTTPS 网关地址');
  const geometry=()=>page.evaluate(()=>{
    const dialog=document.querySelector('#app-dialog').getBoundingClientRect();
    return ['#dialog-title','#dialog-error','.dialog-actions [data-action=close-dialog]','#dialog-submit'].map(selector=>{
      const node=document.querySelector(selector),r=node.getBoundingClientRect();
      return {selector,top:r.top,bottom:r.bottom,left:r.left,right:r.right,
        withinViewport:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth,
        withinDialog:r.top>=dialog.top&&r.bottom<=dialog.bottom,
        hit:node.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
    });
  });
  for(const item of await geometry()){expect(item.withinViewport,item.selector).toBe(true);expect(item.withinDialog,item.selector).toBe(true);expect(item.hit,item.selector).toBe(true);}
  const body=page.locator('#dialog-body');
  expect(await body.evaluate(node=>node.scrollHeight>node.clientHeight)).toBe(true);
  await page.locator('#field-token').scrollIntoViewIfNeeded();
  expect(await body.evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
  for(const item of await geometry()){expect(item.withinViewport,item.selector).toBe(true);expect(item.withinDialog,item.selector).toBe(true);expect(item.hit,item.selector).toBe(true);}
  await testInfo.attach(`native-gateway-dialog-360x${height}-geometry`,{body:JSON.stringify(await geometry(),null,2),contentType:'application/json'});
  await page.screenshot({path:testInfo.outputPath(`native-gateway-dialog-360x${height}.png`)});
  // Click again after the error has changed the layout, without force or scroll
  // injection; then exercise the real cancel action and reopening.
  await page.locator('#dialog-submit').click();
  await expect(page.locator('#dialog-error')).toBeVisible();
  await page.locator('.dialog-actions [data-action=close-dialog]').click();
  await expect(page.locator('#app-dialog')).not.toBeVisible();
  await page.locator('#connection-banner [data-action=gateway]').click();
  await expect(page.locator('#dialog-error')).toBeHidden();
  await expect(page.locator('#dialog-submit')).toBeInViewport({ratio:1});
  expect(local.requests.filter(request=>request.path.startsWith('/api/'))).toEqual([]);
});

test('native gateway keyboard: a focused field remains visible after viewport shrink without changing its value or selection',async({page,local},testInfo)=>{
  await page.setViewportSize({width:360,height:568});
  await page.addInitScript(()=>{globalThis.Capacitor={isNativePlatform:()=>true};});
  await page.goto(local.app.url);
  await expect(page.locator('#connection-message')).toContainText('请先配置 HTTPS 网关');
  await page.locator('#connection-banner [data-action=gateway]').click();
  await page.locator('#dialog-submit').click();
  await expect(page.locator('#dialog-error')).toBeVisible();
  const url=page.locator('#field-url'),token=page.locator('#field-token'),value='https://example.invalid';
  await url.click();await page.keyboard.insertText(value);
  await url.evaluate(node=>node.setSelectionRange(8,15));
  const observation=()=>page.evaluate(()=>{
    const body=document.querySelector('#dialog-body'),field=document.activeElement;
    const viewport=window.visualViewport,b=body.getBoundingClientRect(),r=field.getBoundingClientRect();
    const top=Math.max(b.top,viewport?.offsetTop??0),bottom=Math.min(b.bottom,(viewport?.offsetTop??0)+(viewport?.height??innerHeight));
    return {field:field.id,value:field.value,start:field.selectionStart,end:field.selectionEnd,
      top:r.top,bottom:r.bottom,visibleTop:top,visibleBottom:bottom,scrollTop:body.scrollTop,
      inside:r.top>=top-1&&r.bottom<=bottom+1,
      hit:field.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};
  });
  await page.setViewportSize({width:360,height:286});
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  await testInfo.attach('native-gateway-keyboard-shrink',{body:JSON.stringify(await observation(),null,2),contentType:'application/json'});
  await page.screenshot({path:testInfo.outputPath('native-gateway-keyboard-url.png')});
  await expect.poll(async()=>(await observation()).inside).toBe(true);
  expect(await observation()).toMatchObject({field:'field-url',value,start:8,end:15,hit:true});
  for(const selector of ['#dialog-title','#dialog-error','#dialog-submit','.dialog-actions [data-action=close-dialog]'])await expect(page.locator(selector)).toBeInViewport({ratio:1});
  // A longer validation error reduces the body without any viewport resize.
  // Submit from the input so focus remains there while the alert is replaced.
  await page.keyboard.press('Control+A');await page.keyboard.insertText('http://127.0.0.1:19443');await page.keyboard.press('Enter');
  await expect(page.locator('#dialog-error')).toContainText('网关必须使用 HTTPS');
  await expect(url).toBeFocused();
  await expect.poll(async()=>(await observation()).inside).toBe(true);
  await page.keyboard.press('Control+A');await page.keyboard.insertText(value);
  // Actual focus traversal, rather than locator.fill/scrollIntoView, must expose
  // the next input. Keep the password synthetic and local to this fixture.
  await page.keyboard.press('Tab');await expect(token).toBeFocused();
  await page.keyboard.insertText('fixture-token');
  await token.evaluate(node=>node.setSelectionRange(1,5));
  await expect.poll(async()=>(await observation()).inside).toBe(true);
  expect(await observation()).toMatchObject({field:'field-token',value:'fixture-token',start:1,end:5,hit:true});
  await expect(url).toHaveValue(value);
  await page.screenshot({path:testInfo.outputPath('native-gateway-keyboard-token.png')});
  // Users may scroll back to read the introduction while keeping input focus;
  // ordinary scroll events must not force the focused field back into view.
  await page.locator('#dialog-body').hover();await page.mouse.wheel(0,-1000);
  await expect.poll(()=>page.locator('#dialog-body').evaluate(node=>node.scrollTop)).toBe(0);
  await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  expect(await page.locator('#dialog-body').evaluate(node=>node.scrollTop)).toBe(0);
  await expect(token).toBeFocused();
  // Some WebViews report the IME change only through visualViewport. Exercise
  // that notification without a window resize or a test-side corrective scroll.
  await page.evaluate(()=>window.visualViewport.dispatchEvent(new Event('resize')));
  await expect.poll(async()=>(await observation()).inside).toBe(true);
  expect(await observation()).toMatchObject({field:'field-token',value:'fixture-token',start:1,end:5,hit:true});
  await page.setViewportSize({width:360,height:568});
  await expect(token).toBeFocused();await expect(token).toHaveValue('fixture-token');
  await page.locator('.dialog-actions [data-action=close-dialog]').click();
  await expect(page.locator('#app-dialog')).not.toBeVisible();
  expect(local.requests.filter(request=>request.path.startsWith('/api/'))).toEqual([]);
});

test('page resume: gateway credentials are cleared and require explicit reauthentication, without replay',async({page,local})=>{
  // This is a browser contract fixture with real server Bearer/CSRF checks.
  // Intercepted HTTPS transport and a native marker do NOT validate TLS or Android.
  const origin='https://gateway.invalid',token=randomBytes(32).toString('hex');
  const gateway=await startServer({dataDir:join(local.root,'gateway'),gatewayOrigin:origin,token,allowedOrigins:['https://localhost']});
  const requests=[];
  await page.addInitScript(origin=>{globalThis.Capacitor={isNativePlatform:()=>true};localStorage.setItem('openaster.gateway',origin);},origin);
  await page.route(origin+'/**',async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;
    requests.push({path:pathname,authorized:request.headers().authorization===`Bearer ${token}`});
    if(pathname==='/api/events')return route.fulfill({status:requests.at(-1).authorized?200:401,headers:{'access-control-allow-origin':request.headers().origin},contentType:'text/event-stream',body:': fixture stream\n\n'});
    const response=await page.request.fetch(gateway.url+pathname,{method:request.method(),headers:{...request.headers(),host:new URL(origin).host,origin:'https://localhost'},data:request.postData()??undefined});
    // The test page uses a loopback browser origin; reflect that fixture origin
    // only after the real server has checked the native Origin header above.
    await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':request.headers().origin}});
  });
  // The served source's CSP still blocks unrelated network destinations. Only
  // this fixture response permits the single intercepted gateway origin.
  await page.route(local.app.url+'/',async route=>{const response=await route.fetch();const headers={...response.headers()};headers['content-security-policy']=headers['content-security-policy'].replace("connect-src 'self'","connect-src 'self' "+origin);await route.fulfill({response,headers});});
  try{
    await page.goto(local.app.url);await expect(page.locator('#connection-banner')).toBeVisible();
    await page.locator('#connection-banner [data-action=gateway]').click();await page.locator('#field-token').fill(token);await page.locator('#dialog-submit').click();
    await expect(page.locator('#top-status')).toHaveText('网关已连接');await page.locator('#prompt-input').fill('不得在恢复后重放的草稿');
    await page.locator('.nav-item[data-action=settings]').click();await page.locator('#settings-view [data-action=gateway]').click();await expect(page.locator('#field-token')).toHaveValue(token);
    await hide(page);await expect(page.locator('#field-token')).toHaveValue('');await show(page);
    await expect(page.locator('#top-status')).toHaveText('连接未就绪');await expect(page.locator('#connection-message')).toContainText('重新输入令牌');
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await expect(page.locator('#prompt-input')).toHaveValue('不得在恢复后重放的草稿');await expect(page.locator('#send-button')).toBeDisabled();
    const after=requests.length;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.waitForTimeout(180);
    expect(requests).toHaveLength(after);expect(requests.some(r=>/\/messages$/.test(r.path))).toBe(false);
    const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(storage).not.toContain(token);
    await page.locator('#connection-banner [data-action=gateway]').click();await expect(page.locator('#field-token')).toHaveValue('');
    await page.locator('#field-token').fill(token);await page.locator('#dialog-submit').click();await expect(page.locator('#top-status')).toHaveText('网关已连接');
    expect(requests.some(r=>/\/messages$/.test(r.path))).toBe(false);
  }finally{await page.close();await gateway.close();}
});

for(const phase of ['loading','ready'])test(`page resume: ${phase} branch preview closes before its context expires and can be reopened`,async({page,local})=>{
  // Arrange a real completed demo run before opening the UI. This lifecycle
  // test must not race the run's final SSE refresh against opening the branch.
  const authentication=await(await page.request.get(local.app.url+'/api/bootstrap')).json();
  const created=await page.request.post(local.app.url+'/api/sessions',{headers:{'X-CSRF-Token':authentication.csrfToken},data:{providerId:'demo'}});
  const {session}=await created.json();
  expect((await page.request.post(local.app.url+'/api/sessions/'+session.id+'/messages',{headers:{'X-CSRF-Token':authentication.csrfToken},data:{content:'读取工作区',providerId:'demo'}})).status()).toBe(202);
  await expect.poll(async()=>{const result=await(await page.request.get(local.app.url+'/api/sessions/'+session.id)).json();return result.session.run?.status;}).toBe('completed');
  const initialState=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state'&&r.status()===200);
  await ready(page,local);await(await initialState).finished();
  await page.locator('#session-list [data-action=open-session][data-id="'+session.id+'"]').click();
  await expect(page.locator('#messages')).toContainText('这是本地确定性演示');
  await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
  await page.locator('#prompt-input').fill('保留任务输入框里的草稿');
  await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
  const captured=deferred(),release=deferred();let previews=0;
  await page.route('**/branch-preview?*',async route=>{previews++;if(phase!=='loading'||previews!==1)return route.continue();const response=await route.fetch();captured.resolve();await release.promise;await route.fulfill({response});});
  try{
    await page.locator('[data-action=branch-message]').first().click();
    await expect(page.locator('#app-dialog')).toBeVisible();
    if(phase==='loading')await captured.promise;else {await expect(page.locator('.branch-preview-status')).toContainText('预览已就绪');await expect(page.locator('#dialog-submit')).toBeEnabled();await page.locator('#field-branchContent').fill('弹窗内修改需要重新核对');}
    await hide(page);await expect(page.locator('#app-dialog')).not.toBeVisible();release.resolve();await show(page);
    await expect(page.locator('#top-status')).toHaveText('本地已连接');await expect(page.locator('#prompt-input')).toHaveValue('保留任务输入框里的草稿');
    await expect(page.locator('#app-dialog')).not.toBeVisible();await page.locator('[data-action=branch-message]').first().click();
    await expect(page.locator('.branch-preview-status')).toContainText('预览已就绪');await expect(page.locator('#dialog-submit')).toBeEnabled();
    await expect(page.locator('#field-branchContent')).toHaveValue('读取工作区');expect(previews).toBe(2);expect(local.requests.filter(r=>r.method==='POST'&&/\/branches$/.test(r.path))).toEqual([]);
  }finally{release.resolve();}
});

test('page resume: an accepted message with a delayed response is restored once and asks the user to check saved records',async({page,local})=>{
  await ready(page,local);const captured=deferred(),release=deferred();
  await page.route('**/messages',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();captured.resolve();await release.promise;await route.fulfill({response});});
  try{
    await page.locator('#prompt-input').fill('读取工作区');await page.locator('#send-button').click();await captured.promise;
    await hide(page);const delivered=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/messages'));release.resolve();await(await delivered).finished();await show(page);
    await expect(page.locator('#top-status')).toHaveText('本地已连接');await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
    await expect(page.locator('#toast-region')).toContainText('请核对任务记录');await expect(page.locator('#prompt-input')).toHaveValue('读取工作区');
    expect(local.requests.filter(r=>r.method==='POST'&&/\/messages$/.test(r.path))).toHaveLength(1);
    const state=await(await page.request.get(local.app.url+'/api/state')).json();expect(state.sessions).toHaveLength(1);
    const saved=await(await page.request.get(local.app.url+'/api/sessions/'+state.sessions[0].id)).json();expect(saved.session.messages.filter(m=>m.role==='user')).toHaveLength(1);
  }finally{release.resolve();}
});

async function restartableAuthenticatedGateway(root) {
  // A real loopback streaming proxy keeps the browser origin fixed while the
  // authenticated server is restarted. It changes fixture Host/Origin only;
  // this does not validate HTTPS certificates or an Android transport.
  const origin='https://restart-gateway.invalid';let token=randomBytes(32).toString('hex');
  const options={dataDir:join(root,'restart-gateway'),gatewayOrigin:origin,token};
  let app=await startServer(options),epoch=0,eventsUnavailable=false;
  const requests=[],pending=new Set(),gates=new Map(),allGates=new Set();
  const proxy=createServer((req,res)=>{
    const pathname=new URL(req.url,'http://fixture').pathname;
    const record={method:req.method,path:pathname,epoch,status:null};requests.push(record);
    if(pathname==='/api/events'&&eventsUnavailable){if(eventsUnavailable==='reset'){record.status='reset';res.destroy();}else{record.status=503;res.writeHead(503);res.end();}return;}
    const upstream=httpRequest(app.url+req.url,{method:req.method,headers:{...req.headers,host:new URL(origin).host,...(req.headers.origin?{origin}: {})}},response=>{
      record.status=response.statusCode;
      const gate=gates.get(pathname);
      if(gate){gates.delete(pathname);const parts=[];response.on('data',part=>parts.push(part));response.on('end',()=>{
        gate.captured.resolve();const job=gate.release.promise.then(()=>{if(!res.destroyed){res.writeHead(gate.status||response.statusCode,response.headers);res.end(gate.status?JSON.stringify({error:{code:'FIXTURE_READ_FAILED',message:'读取失败'}}):Buffer.concat(parts));}});
        pending.add(job);void job.finally(()=>pending.delete(job));
      });}else{res.writeHead(response.statusCode,response.headers);response.pipe(res);}
    });
    upstream.on('error',()=>{if(!res.destroyed){record.status=503;res.writeHead(503);res.end();}});
    res.on('close',()=>upstream.destroy());req.pipe(upstream);
  });
  await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
  const url='http://127.0.0.1:'+proxy.address().port;
  async function request(path,{method='GET',body}={}){
    const bootstrap=await(await fetch(app.url+'/api/bootstrap',{headers:{host:new URL(origin).host,authorization:'Bearer '+token}})).json();
    return fetch(app.url+path,{method,headers:{host:new URL(origin).host,authorization:'Bearer '+token,'content-type':'application/json','x-csrf-token':bootstrap.csrfToken},body:body===undefined?undefined:JSON.stringify(body)});
  }
  function hold(path,status){const gate={captured:deferred(),release:deferred(),status};gates.set(path,gate);allGates.add(gate);return gate;}
  return {url,get token(){return token;},requests,request,
    holdBootstrap(){return hold('/api/bootstrap');},holdState(status){return hold('/api/state',status);},holdSession(id,status){return hold('/api/sessions/'+id,status);},
    unavailableEvents(value){eventsUnavailable=value;},
    async restart({rotateToken=false}={}){const port=new URL(app.url).port;await app.close();if(rotateToken)token=randomBytes(32).toString('hex');app=await startServer({...options,token,port:Number(port)});epoch++;},
    async close(){for(const gate of allGates)gate.release.resolve();await Promise.allSettled([...pending]);await app.close();const closing=new Promise(done=>proxy.close(done));proxy.closeAllConnections();await closing;}
  };
}
async function pairRestartGateway(page,gateway,{events=true}={}){
  const initialState=events?page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state'&&r.status()===200):null;
  await page.goto(gateway.url);await expect(page.locator('#connection-banner')).toBeVisible();
  await page.locator('#connection-banner [data-action=gateway]').click();
  await page.locator('#field-token').fill(gateway.token);await page.locator('#dialog-submit').click();
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  if(initialState)await(await initialState).finished();
}

test('gateway restart: the retained page refreshes remote CSRF and sends its preserved task draft only once on request',async({browser,local},testInfo)=>{
  const gateway=await restartableAuthenticatedGateway(local.root),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  try{
    const created=await gateway.request('/api/sessions',{method:'POST',body:{title:'服务重启前的任务',providerId:'demo'}});expect(created.status).toBe(201);
    const {session}=await created.json();
    await pairRestartGateway(page,gateway);
    await page.locator('#session-list [data-action=open-session][data-id="'+session.id+'"]').click();
    await expect(page.locator('#chat-title')).toHaveText('服务重启前的任务');
    await page.locator('#prompt-input').fill('读取工作区，保留这次明确提交');
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    await expect.poll(()=>gateway.requests.filter(r=>r.path==='/api/events'&&r.status===200).length).toBe(1);
    await gateway.restart();
    await expect.poll(()=>gateway.requests.filter(r=>r.epoch===1&&r.path==='/api/events'&&r.status===200).length).toBe(1);
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    await expect(page.locator('#prompt-input')).toHaveValue('读取工作区，保留这次明确提交');
    await expect(page.locator('#model-select')).toHaveValue('demo');
    expect(gateway.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/messages'))).toEqual([]);
    const sent=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/messages'));
    await page.locator('#send-button').click();const response=await sent;
    await testInfo.attach('gateway-restart-request-observations',{body:JSON.stringify({requests:gateway.requests,explicitMessageStatus:response.status()},null,2),contentType:'application/json'});
    expect(response.status()).toBe(202);
    await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
    expect(gateway.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/messages'))).toHaveLength(1);
    const saved=await(await gateway.request('/api/sessions/'+session.id)).json();
    expect(saved.session.messages.filter(m=>m.role==='user').map(m=>m.content)).toEqual(['读取工作区，保留这次明确提交']);
  }finally{await context.close();await gateway.close();}
});

test('gateway restart: authentication gates writes and late state until the selected revoked approval is reread',async({browser,local},testInfo)=>{
  const gateway=await restartableAuthenticatedGateway(local.root),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  let oldState,authentication;
  try{
    await pairRestartGateway(page,gateway);
    await page.locator('#prompt-input').fill('生成工作区报告');await page.locator('#send-button').click();
    await expect(page.locator('.approval-card')).toBeVisible();
    await page.locator('#prompt-input').fill('重启期间保留的下一条草稿');
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    oldState=gateway.holdState();
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await oldState.captured.promise;
    authentication=gateway.holdBootstrap();await gateway.restart();await authentication.captured.promise;
    await expect(page.locator('#top-status')).toHaveText('连接未就绪');
    const oldDelivered=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state');
    oldState.release.resolve();await(await oldDelivered).finished();
    await expect(page.locator('#top-status')).toHaveText('连接未就绪');
    await expect(page.locator('#send-button')).toBeDisabled();
    const writes=gateway.requests.filter(r=>r.method!=='GET').length;
    // Graceful shutdown may already deliver the approval's cancellation over
    // the old SSE. Use a stable explicit write control while auth is held.
    await page.locator('#composer [data-action=import]').click();
    await page.locator('#field-path').fill('must-not-be-written.txt');
    await page.locator('#field-content').fill('认证尚未就绪，不得发送');
    await page.locator('#dialog-submit').click();
    await expect(page.locator('#dialog-error')).toContainText('本次操作尚未发送');
    await page.locator('#app-dialog .dialog-actions [data-action=close-dialog]').click();
    await page.locator('#prompt-input').press('Enter');
    await page.locator('#composer').evaluate(form=>form.requestSubmit());
    expect(gateway.requests.filter(r=>r.method!=='GET')).toHaveLength(writes);
    authentication.release.resolve();
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    await expect(page.locator('.approval-card')).toHaveCount(0);
    await expect(page.locator('#prompt-input')).toHaveValue('重启期间保留的下一条草稿');
    await expect(page.locator('#send-button')).toBeEnabled();
    const record=await(await gateway.request('/api/state')).json();
    const saved=await(await gateway.request('/api/sessions/'+record.sessions[0].id)).json();
    expect(saved.session.approvals.every(a=>a.status!=='pending')).toBe(true);
    expect(gateway.requests.filter(r=>r.method!=='GET')).toHaveLength(writes);
    await testInfo.attach('gateway-restart-auth-gate',{body:JSON.stringify({requests:gateway.requests,revokedApprovals:saved.session.approvals.map(a=>({status:a.status,revoked:a.revoked===true}))}),contentType:'application/json'});
  }finally{oldState?.release.resolve();authentication?.release.resolve();await context.close();await gateway.close();}
});

test('gateway restart: an old write 403 arriving after new authentication does not revoke it or replay the request',async({browser,local})=>{
  const gateway=await restartableAuthenticatedGateway(local.root),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  const captured=deferred(),release=deferred();let held=true;
  try{
    const {session}=await(await gateway.request('/api/sessions',{method:'POST',body:{title:'迟到写入',providerId:'demo'}})).json();
    await pairRestartGateway(page,gateway);
    await page.locator('#session-list [data-action=open-session][data-id="'+session.id+'"]').click();
    await expect(page.locator('#chat-title')).toHaveText('迟到写入');
    await page.route('**/api/sessions/*/messages',async route=>{if(held){held=false;captured.resolve();await release.promise;}await route.continue();});
    await page.locator('#prompt-input').fill('旧请求明确失败后由我再次发送');
    await expect(page.locator('#messages [data-history-state=true]')).toBeVisible();
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    await page.locator('#send-button').click();await captured.promise;
    await gateway.restart();
    await expect.poll(()=>gateway.requests.filter(r=>r.epoch===1&&r.path==='/api/events'&&r.status===200).length).toBe(1);
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    const rejected=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/messages'));
    release.resolve();expect((await rejected).status()).toBe(403);
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    await expect(page.locator('#prompt-input')).toHaveValue('旧请求明确失败后由我再次发送');
    expect(gateway.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/messages'))).toHaveLength(1);
    const accepted=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/messages'));
    await page.locator('#send-button').click();expect((await accepted).status()).toBe(202);
    await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
    const saved=await(await gateway.request('/api/sessions/'+session.id)).json();
    expect(saved.session.messages.filter(m=>m.role==='user')).toHaveLength(1);
  }finally{release.resolve();await context.close();await gateway.close();}
});

for(const eventFailure of [503,'reset'])test('gateway restart: HTTP remains usable when the event proxy returns '+eventFailure,async({browser,local})=>{
  const gateway=await restartableAuthenticatedGateway(local.root),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  try{
    gateway.unavailableEvents(eventFailure);await pairRestartGateway(page,gateway,{events:false});
    await expect.poll(()=>gateway.requests.filter(r=>r.path==='/api/events'&&r.status===eventFailure).length).toBeGreaterThan(1);
    await expect.poll(()=>gateway.requests.filter(r=>r.path==='/api/bootstrap'&&r.status===200).length).toBeGreaterThan(1);
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    await page.locator('#prompt-input').fill('通过已认证的 HTTP 明确发送');
    await expect(page.locator('#send-button')).toBeEnabled();
    const sent=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/messages'));
    await page.locator('#send-button').click();expect((await sent).status()).toBe(202);
    await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
    expect(gateway.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/messages'))).toHaveLength(1);
  }finally{await context.close();await gateway.close();}
});

test('gateway restart: a late authentication response cannot replace a newer explicit pairing',async({browser,local})=>{
  const gateway=await restartableAuthenticatedGateway(local.root),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();let old;
  try{
    await pairRestartGateway(page,gateway);
    await page.locator('#prompt-input').fill('同一工作台重新认证仍保留这份草稿');
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    old=gateway.holdBootstrap();await gateway.restart();await old.captured.promise;
    await gateway.restart({rotateToken:true});
    await page.locator('#connection-banner [data-action=gateway]').click();
    await page.locator('#field-token').fill(gateway.token);await page.locator('#dialog-submit').click();
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    old.release.resolve();
    await expect(page.locator('#prompt-input')).toHaveValue('同一工作台重新认证仍保留这份草稿');
    const sent=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/messages'));
    await page.locator('#send-button').click();expect((await sent).status()).toBe(202);
    await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
    expect(gateway.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/messages'))).toHaveLength(1);
  }finally{old?.release.resolve();await context.close();await gateway.close();}
});

test('gateway restart: rotated credentials and page suspension require explicit reauthentication without replay',async({browser,local})=>{
  const gateway=await restartableAuthenticatedGateway(local.root),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();let held;
  try{
    await pairRestartGateway(page,gateway);
    await page.locator('#prompt-input').fill('身份恢复后仍由用户决定发送');
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    await gateway.restart({rotateToken:true});
    await expect(page.locator('#connection-message')).toContainText('连接认证已失效');
    await expect(page.locator('#send-button')).toBeDisabled();
    expect(gateway.requests.filter(r=>r.method==='POST')).toEqual([]);
    await page.locator('#connection-banner [data-action=gateway]').click();
    await page.locator('#field-token').fill(gateway.token);await page.locator('#dialog-submit').click();
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    held=gateway.holdBootstrap();await gateway.restart();await held.captured.promise;
    await hide(page);held.release.resolve();await show(page);
    await expect(page.locator('#top-status')).toHaveText('连接未就绪');
    await expect(page.locator('#send-button')).toBeDisabled();
    expect(gateway.requests.filter(r=>r.method==='POST')).toEqual([]);
    await page.locator('#connection-banner [data-action=gateway]').click();
    await page.locator('#field-token').fill(gateway.token);await page.locator('#dialog-submit').click();
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    await expect(page.locator('#prompt-input')).toHaveValue('身份恢复后仍由用户决定发送');
    expect(gateway.requests.filter(r=>r.method==='POST')).toEqual([]);
  }finally{held?.release.resolve();await context.close();await gateway.close();}
});

test('gateway restart: a second restart during task restoration rejects once then renews without replay; an older failed state cannot disconnect it',async({browser,local})=>{
  const gateway=await restartableAuthenticatedGateway(local.root),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();let sessionGate,oldState;
  try{
    const {session}=await(await gateway.request('/api/sessions',{method:'POST',body:{title:'两次重启之间',providerId:'demo'}})).json();
    await pairRestartGateway(page,gateway);
    await page.locator('#session-list [data-action=open-session][data-id="'+session.id+'"]').click();
    await expect(page.locator('#chat-title')).toHaveText('两次重启之间');
    await page.locator('#prompt-input').fill('明确失败之后才再次发送');
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    oldState=gateway.holdState(500);
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await oldState.captured.promise;
    sessionGate=gateway.holdSession(session.id);
    await gateway.restart();await sessionGate.captured.promise;
    await gateway.restart();sessionGate.release.resolve();
    await expect.poll(()=>gateway.requests.filter(r=>r.epoch===2&&r.path==='/api/events'&&r.status===200).length).toBe(1);
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    const rejected=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/messages'));
    await page.locator('#send-button').click();expect((await rejected).status()).toBe(403);
    await expect.poll(()=>gateway.requests.filter(r=>r.epoch===2&&r.path==='/api/bootstrap'&&r.status===200).length).toBe(1);
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    const delivered=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state'&&r.status()===500);
    oldState.release.resolve();await(await delivered).finished();
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    expect(gateway.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/messages'))).toHaveLength(1);
    const accepted=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/messages'));
    await page.locator('#send-button').click();expect((await accepted).status()).toBe(202);
    await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
    const saved=await(await gateway.request('/api/sessions/'+session.id)).json();
    expect(saved.session.messages.filter(m=>m.role==='user')).toHaveLength(1);
  }finally{sessionGate?.release.resolve();oldState?.release.resolve();await context.close();await gateway.close();}
});

test('gateway restart: a late failed task refresh cannot disconnect the newly authenticated page',async({browser,local})=>{
  const gateway=await restartableAuthenticatedGateway(local.root),context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();let oldSession;
  try{
    const {session}=await(await gateway.request('/api/sessions',{method:'POST',body:{title:'任务详情读取竞态',providerId:'demo'}})).json();
    await pairRestartGateway(page,gateway);
    await page.locator('#session-list [data-action=open-session][data-id="'+session.id+'"]').click();
    await expect(page.locator('#chat-title')).toHaveText('任务详情读取竞态');
    await page.locator('#prompt-input').fill('保留我的输入');
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    oldSession=gateway.holdSession(session.id,500);
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await oldSession.captured.promise;
    await gateway.restart();
    await expect.poll(()=>gateway.requests.filter(r=>r.epoch===1&&r.path==='/api/events'&&r.status===200).length).toBe(1);
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    const delivered=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/sessions/'+session.id&&r.status()===500);
    oldSession.release.resolve();await(await delivered).finished();
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    await expect(page.locator('#send-button')).toBeEnabled();
    await expect(page.locator('#prompt-input')).toHaveValue('保留我的输入');
    expect(gateway.requests.filter(r=>r.method==='POST')).toEqual([]);
    const sent=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/messages'));
    await page.locator('#send-button').click();expect((await sent).status()).toBe(202);
  }finally{oldSession?.release.resolve();await context.close();await gateway.close();}
});
