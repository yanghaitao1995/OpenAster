import { test as base, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const rootIndex=url=>url.pathname==='/api/workspace'&&!url.searchParams.get('path');
const audit=url=>url.pathname==='/api/audit';
const task=id=>url=>url.pathname===`/api/sessions/${id}`;
const test=base.extend({local:async({page},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});const root=await mkdtemp(resolve('test-results','lazy-workspace-'));
  const dataDir=join(root,'data'),workspace=join(dataDir,'workspace'),gates=[];
  await mkdir(join(workspace,'nested'),{recursive:true});await writeFile(join(workspace,'nested','original.txt'),'这是一份明确选择的文件资料。');
  const store=new Store(dataDir),sessions=[];
  for(const title of ['已保存任务甲','已保存任务乙']){const session=store.createSession({title,providerId:'demo'});session.messages=[{id:randomUUID(),role:'user',content:title+'的原问题',createdAt:new Date().toISOString()},{id:randomUUID(),role:'assistant',content:title+'的完整保存答复',createdAt:new Date().toISOString()}];store.putSession(session);sessions.push(session);}
  store.audit({action:'workspace.import',detail:{path:'nested/original.txt'}});
  store.audit({action:'workspace.written',detail:{path:'nested/original.txt'},sessionId:sessions[0].id});store.close();
  const app=await startServer({dataDir,workspaceId:randomUUID(),workspaceName:'按需读取测试'});
  try{await use({app,workspace,sessions,gates});}
  finally{for(const gate of gates)gate.resolve();await page.unrouteAll({behavior:'wait'});await page.context().close();await app.close();}
}});
test.use({serviceWorkers:'block'});
const frame=page=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
function watch(page){const counts={index:0,audit:0,directory:0,messages:0};page.on('request',request=>{const url=new URL(request.url());if(rootIndex(url))counts.index++;if(audit(url))counts.audit++;if(url.pathname==='/api/workspace/directory')counts.directory++;if(request.method()==='POST'&&/\/messages$/.test(url.pathname))counts.messages++;});return counts;}
async function quietEvents(page,local){const release=deferred();local.gates.push(release);await page.route('**/api/events',async route=>{await release.promise;await route.abort('aborted').catch(()=>{});});}
async function hold(page,local,match){
  const captured=deferred(),release=deferred(),finished=deferred();let once=false;local.gates.push(release);
  const handler=async route=>{if(once)return route.continue();once=true;try{const response=await route.fetch();captured.resolve(response);await release.promise;await route.fulfill({response}).catch(()=>{});}finally{finished.resolve();}};
  await page.route(match,handler);return{captured,async finish(){release.resolve();await finished.promise;await page.unroute(match,handler);await frame(page);}};
}
async function ready(page,local,{events=false}={}){const state=events?page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state'):null;await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');if(state)await(await state).finished();await frame(page);}
async function select(page,session){await page.locator(`.session-link[data-id="${session.id}"]`).click();await expect(page.locator('#messages')).toContainText(session.title+'的完整保存答复');await expect(page.locator('#context-toggle')).toHaveAttribute('aria-expanded','false');}
async function openDetails(page){await page.locator('#context-toggle').click();await expect(page.locator('#context-toggle')).toHaveAttribute('aria-expanded','true');}
async function importFile(page,path,content){return page.evaluate(async({path,content})=>{const bootstrap=await(await fetch('/api/bootstrap')).json();const response=await fetch('/api/workspace/files',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':bootstrap.csrfToken},body:JSON.stringify({path,content})});if(!response.ok)throw new Error('Fixture import failed: '+response.status);return response.status;},{path,content});}
async function importAndObserve(page,local,path){const state=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');const session=page.waitForResponse(response=>task(local.sessions[0].id)(new URL(response.url())));await importFile(page,path,'真实导入 '+path);await(await state).finished();await(await session).finished();await frame(page);}

test('lazy workspace: home and collapsed conversations remain independent of root scans and audit, including initial SSE',async({page,local})=>{
  const counts=watch(page);await ready(page,local,{events:true});await expect(page.locator('#file-count')).toHaveText('—');
  expect(counts.index).toBe(0);expect(counts.audit).toBe(0);await expect(page.locator('#artifact-list')).not.toContainText('正在读取');await expect(page.locator('#context-files')).not.toContainText('正在读取');
  await select(page,local.sessions[0]);await page.locator('#prompt-input').fill('切换页面仍保留的草稿');await expect(page.locator('#send-button')).toBeEnabled();
  for(const action of ['skills','settings']){await page.locator(`.nav-item[data-action=${action}]`).click();await expect(page.locator('#'+action+'-view')).toBeVisible();}
  await select(page,local.sessions[1]);await expect(page.locator('#prompt-input')).toHaveValue('');await expect(page.locator('#send-button')).toBeDisabled();await page.locator('#prompt-input').fill('任务乙自己的草稿');
  const state=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state'),session=page.waitForResponse(response=>task(local.sessions[1].id)(new URL(response.url())));await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await(await state).finished();await(await session).finished();await frame(page);
  expect(counts.index).toBe(0);expect(counts.audit).toBe(0);await expect(page.locator('#file-count')).toHaveText('—');await expect(page.locator('#send-button')).toBeEnabled();
  await expect(page.locator('#prompt-input')).toHaveValue('任务乙自己的草稿');await select(page,local.sessions[0]);await expect(page.locator('#prompt-input')).toHaveValue('切换页面仍保留的草稿');expect(counts.index).toBe(0);expect(counts.audit).toBe(0);expect(counts.messages).toBe(0);
});

test('lazy workspace: an explicitly saved open detail panel loads auxiliary data without delaying restored full history',async({page,local})=>{
  await quietEvents(page,local);const files=await hold(page,local,rootIndex),activity=await hold(page,local,audit);
  await page.addInitScript(id=>{sessionStorage.setItem('openaster.current-session',id);localStorage.setItem('openaster.context','open');},local.sessions[0].id);
  await ready(page,local);await Promise.all([files.captured.promise,activity.captured.promise]);
  await expect(page.locator('#messages')).toContainText('已保存任务甲的完整保存答复');await expect(page.locator('#context-panel')).toBeVisible();await page.locator('#prompt-input').fill('完整对话已读取，可以继续');await expect(page.locator('#send-button')).toBeEnabled();await expect(page.locator('#file-count')).toHaveText('—');
  await files.finish();await activity.finish();await expect(page.locator('#context-files')).toContainText('nested/original.txt');await expect(page.locator('#artifact-list')).toContainText('nested/original.txt');await expect(page.locator('#file-count')).toHaveText('1');await expect(page.locator('#prompt-input')).toHaveValue('完整对话已读取，可以继续');
});

test('lazy workspace: modern directory browsing and an explicit attachment work without global index or audit',async({page,local})=>{
  const counts=watch(page);await ready(page,local,{events:true});await select(page,local.sessions[0]);await page.locator('#prompt-input').fill('请只分析这份明确选择的文件资料');
  await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#file-list [data-path=nested]')).toBeVisible();expect(counts.directory).toBeGreaterThan(0);expect(counts.index).toBe(0);expect(counts.audit).toBe(0);
  await page.locator('#file-list [data-path=nested]').click();await page.locator('#file-list [data-path="nested/original.txt"]').click();await expect(page.locator('#selected-file-content')).toHaveText('这是一份明确选择的文件资料。');
  await page.locator('#file-preview [data-action=attach-context-file]').click();await expect(page.locator('#chat-view')).toBeVisible();await expect(page.locator('#context-toggle')).toHaveAttribute('aria-expanded','false');await expect(page.locator('#draft-file-list')).toContainText('nested/original.txt');await expect(page.locator('#send-button')).toBeEnabled();
  const sent=page.waitForResponse(response=>response.request().method()==='POST'&&/\/messages$/.test(new URL(response.url()).pathname));await page.locator('#send-button').click();const response=await sent;expect(response.status()).toBe(202);expect(response.request().postDataJSON().files).toHaveLength(1);
  await expect.poll(async()=>{const response=await page.request.get(local.app.url+'/api/sessions/'+local.sessions[0].id);return(await response.json()).session.run?.status;}).toBe('completed');await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');await frame(page);
  expect(counts.messages).toBe(1);expect(counts.index).toBe(0);expect(counts.audit).toBe(0);await expect(page.locator('#file-count')).toHaveText('—');
});

test('lazy workspace: collapsing during a dirty read prevents hidden follow-ups and reopening reads actual new files',async({page,local})=>{
  const counts=watch(page);await ready(page,local,{events:true});await select(page,local.sessions[0]);await openDetails(page);await expect(page.locator('#file-count')).toHaveText('1');await expect(page.locator('#artifact-list')).toContainText('nested/original.txt');
  await page.locator('#context-toggle').click();await writeFile(join(local.workspace,'old-snapshot-only.txt'),'旧读取时可见，不能作为最新结果发布');
  const files=await hold(page,local,rootIndex),activity=await hold(page,local,audit);await openDetails(page);await Promise.all([files.captured.promise,activity.captured.promise]);const started={index:counts.index,audit:counts.audit};
  await page.locator('#context-toggle').click();await importAndObserve(page,local,'fresh-after-collapse.txt');expect(counts.index).toBe(started.index);expect(counts.audit).toBe(started.audit);
  await files.finish();await activity.finish();expect(counts.index).toBe(started.index);expect(counts.audit).toBe(started.audit);await expect(page.locator('#file-count')).not.toHaveText('2');
  await openDetails(page);await expect(page.locator('#context-files')).toContainText('fresh-after-collapse.txt');await expect(page.locator('#file-count')).toHaveText('3');await expect(page.locator('#audit-list')).toContainText('fresh-after-collapse.txt');expect(counts.index).toBe(started.index+1);expect(counts.audit).toBe(started.audit+1);
});

test('lazy workspace: visible root and audit reads coalesce SSE changes and do not publish a known obsolete snapshot',async({page,local})=>{
  const counts=watch(page);await ready(page,local,{events:true});await select(page,local.sessions[0]);await openDetails(page);await expect(page.locator('#file-count')).toHaveText('1');await expect(page.locator('#artifact-list')).toContainText('nested/original.txt');
  await page.locator('#context-toggle').click();await writeFile(join(local.workspace,'obsolete-snapshot.txt'),'只出现在待失效读取中');const files=await hold(page,local,rootIndex),activity=await hold(page,local,audit);await openDetails(page);await Promise.all([files.captured.promise,activity.captured.promise]);const started={index:counts.index,audit:counts.audit};
  await importAndObserve(page,local,'first-new.txt');await importAndObserve(page,local,'second-new.txt');expect(counts.index).toBe(started.index);expect(counts.audit).toBe(started.audit);
  const latestFiles=await hold(page,local,rootIndex),latestActivity=await hold(page,local,audit);await files.finish();await activity.finish();await Promise.all([latestFiles.captured.promise,latestActivity.captured.promise]);
  expect(counts.index).toBe(started.index+1);expect(counts.audit).toBe(started.audit+1);await expect(page.locator('#file-count')).not.toHaveText('2');await expect(page.locator('#context-files')).not.toContainText('obsolete-snapshot.txt');
  await latestFiles.finish();await latestActivity.finish();await expect(page.locator('#file-count')).toHaveText('4');await expect(page.locator('#context-files')).toContainText('first-new.txt');await expect(page.locator('#context-files')).toContainText('second-new.txt');await expect(page.locator('#audit-list')).toContainText('second-new.txt');
});

test('lazy workspace: the command palette opens immediately and keeps query, selection and IME through asynchronous discovery',async({page,local})=>{
  await quietEvents(page,local);await writeFile(join(local.workspace,'已保存任务乙-资料.txt'),'供命令面板异步定位的真实文件');const counts=watch(page);await ready(page,local);await page.locator('#prompt-input').fill('命令面板不会清空草稿');
  const files=await hold(page,local,rootIndex),activity=await hold(page,local,audit);await page.keyboard.press('Control+p');const input=page.getByRole('combobox',{name:'搜索命令'});await expect(input).toBeFocused();await Promise.all([files.captured.promise,activity.captured.promise]);await input.fill('已保存任务乙');await expect(page.locator('.command-palette [role=option]')).toHaveCount(1);const selected=await page.locator('.command-palette [aria-selected=true] .command-palette__label').textContent();
  await input.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));await files.finish();await activity.finish();await expect(page.locator('.command-palette [role=option]')).toHaveCount(1);await expect(input).toHaveValue('已保存任务乙');await expect(input).toBeFocused();
  await input.evaluate(node=>node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));await expect(page.locator('.command-palette [role=option]')).toHaveCount(2);await expect(page.locator('.command-palette [aria-selected=true] .command-palette__label')).toHaveText(selected);await expect(input).toBeFocused();await expect(input).toHaveValue('已保存任务乙');await page.keyboard.press('Escape');
  const lateFiles=await hold(page,local,rootIndex),lateActivity=await hold(page,local,audit);await page.keyboard.press('Control+p');await Promise.all([lateFiles.captured.promise,lateActivity.captured.promise]);await page.keyboard.press('Escape');const afterClose={index:counts.index,audit:counts.audit};await lateFiles.finish();await lateActivity.finish();await expect(page.locator('.command-palette')).not.toBeVisible();expect(counts.index).toBe(afterClose.index);expect(counts.audit).toBe(afterClose.audit);await expect(page.locator('#prompt-input')).toHaveValue('命令面板不会清空草稿');
});

test('lazy workspace: index and audit errors expose independent explicit retries instead of indefinite loading',async({page,local})=>{
  await quietEvents(page,local);const counts=watch(page);let failFiles=true,failAudit=true;
  await page.route(rootIndex,async route=>{if(failFiles){failFiles=false;await route.fulfill({status:503,json:{error:{message:'本机文件扫描暂不可用'}}});}else await route.continue();});
  await page.route(audit,async route=>{if(failAudit){failAudit=false;await route.fulfill({status:503,json:{error:{message:'本机活动读取暂不可用'}}});}else await route.continue();});
  await ready(page,local);expect(counts.index).toBe(0);expect(counts.audit).toBe(0);await select(page,local.sessions[0]);await openDetails(page);
  const filesRetry=page.locator('[data-action=refresh-context-files]'),auditRetry=page.locator('[data-action=refresh-context-audit]');await expect(filesRetry).toBeVisible();await expect(auditRetry).toBeVisible();await expect(page.locator('#context-files')).not.toContainText('正在读取');await expect(page.locator('#artifact-list')).not.toContainText('正在读取');expect(counts.index).toBe(1);expect(counts.audit).toBe(1);
  await filesRetry.click();await expect(page.locator('#context-files')).toContainText('nested/original.txt');await expect(auditRetry).toBeVisible();expect(counts.index).toBe(2);expect(counts.audit).toBe(1);
  await auditRetry.click();await expect(page.locator('#artifact-list')).toContainText('nested/original.txt');await expect(page.locator('#file-count')).toHaveText('1');expect(counts.index).toBe(2);expect(counts.audit).toBe(2);
});

test('lazy workspace: an empty palette explains pending and failed file discovery, and an explicit reopening retries',async({page,local},testInfo)=>{
  await quietEvents(page,local);const counts=watch(page),captured=deferred(),release=deferred();local.gates.push(release);let first=true;
  await page.route(rootIndex,async route=>{if(!first)return route.continue();first=false;await route.fetch();captured.resolve();await release.promise;await route.fulfill({status:503,json:{error:{message:'专项模拟的文件扫描失败'}}}).catch(()=>{});});
  const activity=await hold(page,local,audit);await ready(page,local);await page.keyboard.press('Control+p');await Promise.all([captured.promise,activity.captured.promise]);
  const input=page.getByRole('combobox',{name:'搜索命令'}),list=page.locator('.command-palette [role=listbox]'),status=page.locator('.command-palette [role=status]'),empty=page.locator('.command-palette__empty');
  await input.fill('missing-从未存在的资料');await expect(input).toBeFocused();await expect(input).toHaveAttribute('aria-expanded','false');await expect(list).toHaveAttribute('aria-busy','true');await expect(list).not.toBeVisible();await expect(empty).toContainText('文件仍在读取');await expect(status).toContainText('正在读取文件');await expect(empty).not.toContainText('没有找到匹配的命令');
  await page.screenshot({path:testInfo.outputPath('lazy-workspace-palette-loading.png')});
  release.resolve();await activity.finish();await expect(list).toHaveAttribute('aria-busy','false');await expect(status).toContainText('部分文件来源读取失败');await expect(empty).toContainText('部分文件来源暂不可用');await expect(input).toHaveValue('missing-从未存在的资料');await expect(input).toBeFocused();expect(counts.index).toBe(1);expect(counts.audit).toBe(1);
  await page.screenshot({path:testInfo.outputPath('lazy-workspace-palette-partial-failure.png')});
  await page.keyboard.press('Escape');await page.keyboard.press('Control+p');await input.fill('nested/original.txt');await expect(page.locator('.command-palette [role=option]')).toHaveCount(1);await expect(list).toHaveAttribute('aria-busy','false');await expect(status).not.toContainText('读取失败');await expect(input).toBeFocused();expect(counts.index).toBe(2);expect(counts.audit).toBe(2);await page.keyboard.press('Escape');
});
