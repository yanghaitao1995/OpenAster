import { test as base, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const index=url=>url.pathname==='/api/workspace'&&!url.searchParams.get('path');
const task=id=>url=>url.pathname===`/api/sessions/${id}`;
const test=base.extend({local:async({page},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});const root=await mkdtemp(resolve('test-results','workspace-index-'));
  let dataDir=join(root,'original');const workspace=join(dataDir,'workspace');await mkdir(join(workspace,'nested'),{recursive:true});await writeFile(join(workspace,'nested','original.txt'),'原始文件');
  const workspaceId=randomUUID(),gates=[];const store=new Store(dataDir),sessions=[];
  for(const title of ['任务甲','任务乙']){const session=store.createSession({title,providerId:'demo'});session.messages=[{id:randomUUID(),role:'user',content:title+'的已保存问题',createdAt:new Date().toISOString()},{id:randomUUID(),role:'assistant',content:title+'的完整保存答复',createdAt:new Date().toISOString()}];store.putSession(session);sessions.push(session);}
  store.audit({action:'workspace.import',detail:{path:'nested/original.txt'},sessionId:sessions[0].id});store.close();
  let app=await startServer({dataDir,workspaceId,workspaceName:'索引生命周期测试'});
  try{await use({get app(){return app;},get dataDir(){return dataDir;},workspace,workspaceId,sessions,gates,
    // This fixture retires only its own browser transport; app.close still awaits
    // real scan drainage and data-lock release before the replacement starts.
    async switchWorkspace(){const port=app.server.address().port;const closed=app.close();app.server.closeAllConnections();await closed;dataDir=join(root,'replacement');await mkdir(join(dataDir,'workspace'),{recursive:true});await writeFile(join(dataDir,'workspace','replacement.txt'),'新工作区文件');app=await startServer({dataDir,port,workspaceId:randomUUID(),workspaceName:'替换后的工作区'});}
  });}finally{for(const gate of gates)gate.resolve();await page.unrouteAll({behavior:'wait'});await page.context().close();await app.close();}
}});
test.use({serviceWorkers:'block'});
async function frame(page){await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}
async function quietEvents(page,local){const release=deferred();local.gates.push(release);await page.route('**/api/events',async route=>{await release.promise;await route.abort('aborted').catch(()=>{});});}
async function heldResponse(page,local,match){
  const captured=deferred(),release=deferred(),finished=deferred();let capturedOnce=false;local.gates.push(release);
  const handler=async route=>{if(capturedOnce)return route.continue();capturedOnce=true;try{const response=await route.fetch();captured.resolve(response);await release.promise;await route.fulfill({response}).catch(()=>{});}finally{finished.resolve();}};
  await page.route(match,handler);
  return{captured,release,async finish(){release.resolve();await finished.promise;await page.unroute(match,handler);await frame(page);}};
}
async function ready(page,local){await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');}
async function select(page,session){await page.locator(`.session-link[data-id="${session.id}"]`).click();}
async function details(page){if(await page.locator('#context-toggle').getAttribute('aria-expanded')!=='true')await page.locator('#context-toggle').click();await expect(page.locator('#context-panel')).toBeVisible();}
async function importFile(page,path,content){return page.evaluate(async({path,content})=>{const bootstrap=await(await fetch('/api/bootstrap')).json();const response=await fetch('/api/workspace/files',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':bootstrap.csrfToken},body:JSON.stringify({path,content})});if(!response.ok)throw new Error(await response.text());return response.status;},{path,content});}
async function sync(page){const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await(await response).finished();await frame(page);}

test('workspace index: restoring the full conversation does not wait for index or audit',async({page,local})=>{
  await quietEvents(page,local);const files=await heldResponse(page,local,index),audit=await heldResponse(page,local,url=>url.pathname==='/api/audit');
  let scans=0,audits=0;page.on('request',request=>{const url=new URL(request.url());if(index(url))scans++;if(url.pathname==='/api/audit')audits++;});
  await page.addInitScript(id=>sessionStorage.setItem('openaster.current-session',id),local.sessions[0].id);
  await ready(page,local);
  await expect(page.locator('#messages')).toContainText('任务甲的完整保存答复');await expect(page.locator('#chat-view')).toBeVisible();
  await page.locator('#prompt-input').fill('读取历史后即可继续');await expect(page.locator('#send-button')).toBeEnabled();await expect(page.locator('#file-count')).toHaveText('—');expect(scans).toBe(0);expect(audits).toBe(0);
  await details(page);await Promise.all([files.captured.promise,audit.captured.promise]);await expect(page.locator('#send-button')).toBeEnabled();await expect(page.locator('#file-count')).toHaveText('—');expect(scans).toBe(1);expect(audits).toBe(1);
  await files.finish();await audit.finish();await expect(page.locator('#file-count')).toHaveText('1');await expect(page.locator('#prompt-input')).toHaveValue('读取历史后即可继续');
});

test('workspace index: delayed bootstrap never steals newer navigation or an edited draft',async({page,local})=>{
  await quietEvents(page,local);await page.addInitScript(id=>sessionStorage.setItem('openaster.current-session',id),local.sessions[0].id);
  let reads=0;page.on('request',request=>{const url=new URL(request.url());if(index(url)||url.pathname==='/api/audit')reads++;});
  for(const destination of ['settings','draft']){
    const held=await heldResponse(page,local,url=>url.pathname==='/api/bootstrap');await page.goto(local.app.url);await held.captured.promise;
    await page.locator('#prompt-input').fill('连接期间正在编辑的草稿');
    if(destination==='settings')await page.locator('.nav-item[data-action=settings]').click();
    await held.finish();await expect(page.locator('#top-status')).toHaveText('本地已连接');
    await expect(page.locator(destination==='settings'?'#settings-view':'#home-view')).toBeVisible();await expect(page.locator('#chat-view')).not.toBeVisible();await expect(page.locator('#prompt-input')).toHaveValue('连接期间正在编辑的草稿');
    expect(await page.evaluate(()=>sessionStorage.getItem('openaster.current-session'))).toBeNull();
    expect(reads).toBe(0);await expect(page.locator('#file-count')).toHaveText('—');
  }
});

test('workspace index: rapid task switches join an in-flight scan and full-history loading blocks every send path',async({page,local})=>{
  await quietEvents(page,local);let scans=0,posts=0;page.on('request',request=>{if(index(new URL(request.url())))scans++;if(request.method()==='POST'&&/\/messages$/.test(new URL(request.url()).pathname))posts++;});
  const files=await heldResponse(page,local,index);await ready(page,local);await select(page,local.sessions[0]);await expect(page.locator('#messages')).toContainText('任务甲的完整保存答复');expect(scans).toBe(0);await details(page);await files.captured.promise;
  const old=await heldResponse(page,local,task(local.sessions[0].id)),selected=await heldResponse(page,local,task(local.sessions[1].id));
  await select(page,local.sessions[0]);await old.captured.promise;await select(page,local.sessions[1]);await selected.captured.promise;
  await expect(page.locator('#messages')).toContainText('正在读取任务');await expect(page.locator('#messages')).not.toContainText('告诉智能体你的目标');
  await page.locator('#prompt-input').fill('完整读取后再发送');await expect(page.locator('#send-button')).toBeDisabled();await page.locator('#prompt-input').press('Enter');await page.locator('#composer').evaluate(form=>form.requestSubmit());await frame(page);expect(posts).toBe(0);await expect(page.locator('#prompt-input')).toHaveValue('完整读取后再发送');
  await selected.finish();await expect(page.locator('#messages')).toContainText('任务乙的完整保存答复');await expect(page.locator('#send-button')).toBeEnabled();expect(scans).toBe(1);
  await files.finish();await expect(page.locator('#file-count')).toHaveText('1');const afterCurrent=scans;
  await old.finish();await expect(page.locator('#messages')).toContainText('任务乙的完整保存答复');await expect(page.locator('#messages')).not.toContainText('任务甲的完整保存答复');expect(scans).toBe(afterCurrent);
  // A later navigation with details still open rechecks the demanded index.
  const refreshed=page.waitForResponse(response=>index(new URL(response.url())));await select(page,local.sessions[0]);await refreshed;expect(scans).toBe(afterCurrent+1);
  // The text entered above belongs to task B, not the subsequently selected A.
  await expect(page.locator('#prompt-input')).toHaveValue('');expect(posts).toBe(0);await expect(page.locator('#messages')).toContainText('任务甲的完整保存答复');
  await page.locator('#prompt-input').fill('甲的独立发送内容');const submitted=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/sessions/${local.sessions[0].id}/messages`);
  await page.locator('#send-button').click();expect((await submitted).request().postDataJSON().content).toBe('甲的独立发送内容');await expect.poll(()=>posts).toBe(1);await expect.poll(async()=>{const response=await page.request.get(local.app.url+'/api/sessions/'+local.sessions[0].id);return(await response.json()).session.run?.status;}).toBe('completed');await sync(page);await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
  await select(page,local.sessions[1]);await expect(page.locator('#messages')).toContainText('任务乙的完整保存答复');await expect(page.locator('#prompt-input')).toHaveValue('完整读取后再发送');expect(posts).toBe(1);
});

test('workspace index: real SSE invalidation drains one follow-up and never publishes the known-old result',async({page,local})=>{
  const initialState=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');await ready(page,local);await initialState;await expect(page.locator('#file-count')).toHaveText('—');await select(page,local.sessions[0]);await details(page);await expect(page.locator('#file-count')).toHaveText('1');
  // The held response sees an intermediate external edit. Publishing it after
  // the import event would be observably stale (2 rather than the baseline 1).
  await writeFile(join(local.workspace,'intermediate.txt'),'等待期间的中间版本');
  const first=await heldResponse(page,local,index);await sync(page);await first.captured.promise;
  let scans=0;page.on('request',request=>{if(index(new URL(request.url())))scans++;});
  const notified=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');await importFile(page,'fresh.txt','扫描期间真实导入');await notified;
  // Reopening the explicit consumer during the same flight coalesces into one
  // dirty drain, without treating a hidden flight as a reason to scan again.
  for(let i=0;i<2;i++){await page.locator('#context-toggle').click();await details(page);}expect(scans).toBe(0);
  const next=await heldResponse(page,local,index);await first.finish();await next.captured.promise;
  await expect(page.locator('#file-count')).toHaveText('1');expect(scans).toBe(1);
  await next.finish();await expect(page.locator('#file-count')).toHaveText('3');expect(scans).toBe(1);
  await page.keyboard.press('Control+p');await page.getByRole('combobox',{name:'搜索命令'}).fill('fresh.txt');await expect(page.locator('.command-palette [role=option]')).toHaveCount(1);await page.keyboard.press('Escape');
});

test('workspace index: legacy root browsing shares the broker while scoped navigation stays isolated',async({page,local})=>{
  await quietEvents(page,local);for(const name of ['bootstrap','state'])await page.route('**/api/'+name,async route=>{const response=await route.fetch(),data=await response.json();delete data.capabilities.workspaceDirectory;await route.fulfill({response,json:data});});
  let scans=0;page.on('request',request=>{if(index(new URL(request.url())))scans++;});const held=await heldResponse(page,local,index);await ready(page,local);expect(scans).toBe(0);await page.keyboard.press('Control+p');await held.captured.promise;await page.keyboard.press('Escape');
  await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#workspace-listing-note')).toContainText('递归浏览');expect(scans).toBe(1);
  await held.finish();await expect(page.locator('#file-list [data-path="nested/original.txt"]')).toBeVisible();await expect(page.locator('#file-count')).toHaveText('1');expect(scans).toBe(1);
  const rootRead=await heldResponse(page,local,index);await page.locator('[data-action=refresh-files]').click();await rootRead.captured.promise;
  await page.locator('#file-list [data-path=nested]').click();await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/nested');await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');await rootRead.finish();
  await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/nested');await expect(page.locator('#file-list [data-path=nested]')).toHaveCount(0);await expect(page.locator('#file-list [data-path="nested/original.txt"]')).toBeVisible();
  const scoped=url=>url.pathname==='/api/workspace'&&url.searchParams.get('path')==='nested';
  const first=await heldResponse(page,local,scoped);await page.locator('[data-action=refresh-files]').click();await first.captured.promise;
  let scopedReads=0;page.on('request',request=>{if(scoped(new URL(request.url())))scopedReads++;});
  await writeFile(join(local.workspace,'nested','added-while-reading.txt'),'真实修改，不能沿用旧扫描');
  await page.locator('[data-action=refresh-files]').click();await page.locator('[data-action=refresh-files]').click();expect(scopedReads).toBe(0);
  const final=await heldResponse(page,local,scoped);await first.finish();await final.captured.promise;expect(scopedReads).toBe(1);
  await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','true');await expect(page.locator('#file-list [data-path="nested/added-while-reading.txt"]')).toHaveCount(0);
  await final.finish();await expect(page.locator('#file-list [data-path="nested/added-while-reading.txt"]')).toBeVisible();await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');expect(scopedReads).toBe(1);
});

test('workspace index: reconnect, capability withdrawal and workspace replacement abort old reads without clearing the next broker',async({page,local})=>{
  await quietEvents(page,local);await ready(page,local);await select(page,local.sessions[0]);await details(page);await expect(page.locator('#file-count')).toHaveText('1');
  let held=await heldResponse(page,local,index);await sync(page);await held.captured.promise;
  await page.route('**/api/bootstrap',route=>route.fulfill({status:503,json:{error:{message:'本机重连暂不可用'}}}));
  const aborted=page.waitForEvent('requestfailed',request=>index(new URL(request.url())));await page.evaluate(()=>window.dispatchEvent(new Event('online')));await aborted;await expect(page.locator('#connection-message')).toContainText('本机重连暂不可用');await held.finish();await page.unroute('**/api/bootstrap');
  const recovered=page.waitForResponse(response=>index(new URL(response.url())));await page.evaluate(()=>window.dispatchEvent(new Event('online')));await(await recovered).finished();await frame(page);await expect(page.locator('#top-status')).toHaveText('本地已连接');await expect(page.locator('#file-count')).toHaveText('1');
  held=await heldResponse(page,local,index);await sync(page);await held.captured.promise;
  await page.route('**/api/state',async route=>{const response=await route.fetch(),data=await response.json();delete data.capabilities.workspaceDirectory;await route.fulfill({response,json:data});});
  const capabilityAbort=page.waitForEvent('requestfailed',request=>index(new URL(request.url()))),capabilityRead=page.waitForResponse(response=>index(new URL(response.url())));await sync(page);await capabilityAbort;await(await capabilityRead).finished();await frame(page);await held.finish();await expect(page.locator('#file-count')).toHaveText('1');await page.unroute('**/api/state');
  held=await heldResponse(page,local,index);await sync(page);await held.captured.promise;
  const replacedAbort=page.waitForEvent('requestfailed',request=>index(new URL(request.url())));await local.switchWorkspace();await page.evaluate(()=>window.dispatchEvent(new Event('online')));await replacedAbort;await expect(page.locator('#workspace-label')).toHaveText('替换后的工作区');await expect(page.locator('#file-count')).toHaveText('—');await held.finish();
  await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#file-list [data-path="replacement.txt"]')).toBeVisible();await expect(page.locator('#file-list')).not.toContainText('original.txt');
  held=await heldResponse(page,local,index);await page.keyboard.press('Control+p');await held.captured.promise;const hiddenAbort=page.waitForEvent('requestfailed',request=>index(new URL(request.url())));await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await hiddenAbort;await held.finish();
});

test('workspace index: an obsolete audit response cannot erase a newer real import record',async({page,local})=>{
  await quietEvents(page,local);await ready(page,local);await page.locator('.nav-item[data-action=security]').click();await expect(page.locator('#audit-list')).toContainText('nested/original.txt');const initialCount=Number.parseInt(await page.locator('#audit-count').textContent(),10);
  const held=await heldResponse(page,local,url=>url.pathname==='/api/audit');await page.locator('[data-action=refresh-audit]').click();await held.captured.promise;
  await importFile(page,'audit-new.txt','用于活动记录的新文件');const aborted=page.waitForEvent('requestfailed',request=>new URL(request.url()).pathname==='/api/audit');await page.locator('[data-action=refresh-audit]').click();await aborted;
  await expect(page.locator('#audit-list')).toContainText('audit-new.txt');const count=await page.locator('#audit-count').textContent();expect(Number.parseInt(count,10)).toBe(initialCount+1);await held.finish();await expect(page.locator('#audit-list')).toContainText('audit-new.txt');await expect(page.locator('#audit-count')).toHaveText(count);
});

test('workspace index: attaching after leaving an unfinished history refresh reloads the task and preserves its draft',async({page,local})=>{
  let scans=0,audits=0;page.on('request',request=>{const url=new URL(request.url());if(index(url))scans++;if(url.pathname==='/api/audit')audits++;});
  await quietEvents(page,local);await ready(page,local);await select(page,local.sessions[0]);await expect(page.locator('#messages')).toContainText('任务甲的完整保存答复');
  await page.locator('#prompt-input').fill('保留草稿与这份文件资料');
  const obsolete=await heldResponse(page,local,task(local.sessions[0].id));await sync(page);await obsolete.captured.promise;
  await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#file-list [data-path=nested]')).toBeVisible();await obsolete.finish();
  await page.locator('#file-list [data-path=nested]').click();await expect(page.locator('#file-list [data-path="nested/original.txt"]')).toBeVisible();await page.locator('#file-list [data-path="nested/original.txt"]').click();await expect(page.locator('#selected-file-content')).toHaveText('原始文件');
  const resumed=await heldResponse(page,local,task(local.sessions[0].id));await page.locator('#file-preview [data-action=attach-context-file]').click();await resumed.captured.promise;
  await expect(page.locator('#chat-view')).toBeVisible();await expect(page.locator('#draft-file-list')).toContainText('nested/original.txt');await expect(page.locator('#prompt-input')).toHaveValue('保留草稿与这份文件资料');await expect(page.locator('#send-button')).toBeDisabled();
  await resumed.finish();await expect(page.locator('#messages')).toContainText('任务甲的完整保存答复');await expect(page.locator('#send-button')).toBeEnabled();await expect(page.locator('#prompt-input')).toBeFocused();
  const submitted=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/sessions/${local.sessions[0].id}/messages`);await page.locator('#send-button').click();const response=await submitted;expect(response.status()).toBe(202);const sent=response.request().postDataJSON();expect(sent.content).toBe('保留草稿与这份文件资料');expect(sent.files).toHaveLength(1);expect(sent.files[0].path).toBe('nested/original.txt');
  await expect.poll(async()=>{const current=await page.request.get(local.app.url+'/api/sessions/'+local.sessions[0].id);return(await current.json()).session.run?.status;}).toBe('completed');await sync(page);await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');await expect(page.locator('#draft-file-list')).toBeEmpty();expect(scans).toBe(0);expect(audits).toBe(0);
});

test('workspace index: a real SSE event invalidates a held legacy scope without parallel scans or stale publication',async({page,local})=>{
  for(const name of ['bootstrap','state'])await page.route('**/api/'+name,async route=>{const response=await route.fetch(),data=await response.json();delete data.capabilities.workspaceDirectory;await route.fulfill({response,json:data});});
  let roots=0;page.on('request',request=>{if(index(new URL(request.url())))roots++;});const initialState=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');await ready(page,local);await initialState;await expect(page.locator('#file-count')).toHaveText('—');expect(roots).toBe(0);
  await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#file-list [data-path="nested/original.txt"]')).toBeVisible();await expect(page.locator('#file-count')).toHaveText('1');const loadedRoots=roots;await page.locator('#file-list [data-path=nested]').click();await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/nested');await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');
  const scoped=url=>url.pathname==='/api/workspace'&&url.searchParams.get('path')==='nested';
  const first=await heldResponse(page,local,scoped);await page.locator('[data-action=refresh-files]').click();await first.captured.promise;
  let reads=0;page.on('request',request=>{if(scoped(new URL(request.url())))reads++;});
  const notified=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');await importFile(page,'nested/from-event.txt','真实导入发出的 SSE 必须使范围过期');await(await notified).finished();await frame(page);expect(reads).toBe(0);
  const latest=await heldResponse(page,local,scoped);await first.finish();await latest.captured.promise;expect(reads).toBe(1);await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','true');await expect(page.locator('#file-list [data-path="nested/from-event.txt"]')).toHaveCount(0);
  await latest.finish();await expect(page.locator('#file-list [data-path="nested/from-event.txt"]')).toBeVisible();await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');expect(reads).toBe(1);expect(roots).toBe(loadedRoots);await expect(page.locator('#file-count')).toHaveText('1');
  await page.locator('[data-action=browse-root]').click();await expect(page.locator('#file-count')).toHaveText('2');expect(roots).toBe(loadedRoots+1);
});
