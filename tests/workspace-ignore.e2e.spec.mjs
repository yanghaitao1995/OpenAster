import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';

const rootRules='*.tmp\n/root-only.txt\nsecret-dir/\n!secret-dir/keep.txt\nonly-ignored/*\n';
const files={
  '.gitignore':rootRules,'README.md':'项目说明与任务草稿保持独立。',
  'src/.gitignore':'!keep.tmp\nnested/\n','src/drop.tmp':'hidden-probe 被祖先规则忽略',
  'src/keep.tmp':'kept-probe <img src=x onerror="globalThis.__ignoreXss=1">',
  'src/nested/inside.txt':'nested-probe','src/root-only.txt':'anchor-probe',
  'root-only.txt':'root-probe','lower.tmp':'lower-probe','Upper.TMP':'case-probe',
  'secret-dir/keep.txt':'parent-probe','only-ignored/hidden.txt':'empty-probe',
  'node_modules/pkg/dep.txt':'generated-probe','.env':'credential-probe','.git/config':'internal-probe',
};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const test=base.extend({local:async({page},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});const root=await mkdtemp(resolve('test-results','workspace-ignore-'));
  const apps=new Set(),gates=[];let number=0,current;
  async function start({projectScan=true,invalid=false,fresh=false,port}={}){
    const dataDir=join(root,String(++number)),workspace=join(dataDir,'workspace');
    for(const[p,content]of Object.entries(fresh?{'fresh.txt':'新工作区内容'}:files)){await mkdir(dirname(join(workspace,p)),{recursive:true});await writeFile(join(workspace,p),content);}
    if(invalid){
      await writeFile(join(workspace,'.gitignore'),Buffer.from('invalid\0rule'));
      // A retained write record exposes an explicit path even when discovery fails.
      const store=new Store(dataDir),id=randomUUID(),now=new Date().toISOString();
      store.putSession({id,title:'已有文件记录',providerId:'demo',createdAt:now,updatedAt:now,messages:[],approvals:[],run:null});
      store.audit({action:'workspace.written',sessionId:id,detail:{path:'src/keep.tmp'}});store.close();
    }
    const app=await startServer({port,dataDir,workspaceId:randomUUID(),workspaceName:fresh?'新的规则工作区':'项目规则测试',workspaceOptions:{projectScan,denySensitivePaths:true,createRoot:false}});
    apps.add(app);current={app,workspace};return current;
  }
  try{await use({start,get current(){return current;},gates,async replace(){const port=current.app.server.address().port;await current.app.close();apps.delete(current.app);return start({port,fresh:true});}});}
  finally{for(const gate of gates)gate.resolve();await page.unrouteAll({behavior:'wait'});await page.context().close();for(const app of apps)await app.close();}
}});
test.use({serviceWorkers:'block'});
const listURL=(url,scope='',include=false)=>url.pathname==='/api/workspace/directory'&&(url.searchParams.get('path')||'')===scope&&(url.searchParams.get('includeGenerated')==='true')===include;
const rows=page=>page.locator('#workspace-search-results [data-action=search-result]');
async function navigation(page,selector){if(await page.locator('.mobile-menu').isVisible())await page.locator('.mobile-menu').click();await page.locator(selector).click();}
async function openWorkspace(page,app){await page.goto(app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');await navigation(page,'.nav-item[data-action=workspace]');}
async function ready(page,app){await openWorkspace(page,app);await expect(page.locator('#file-list [data-path="README.md"]')).toBeVisible();}
async function enter(page,path){await page.locator('#file-list [data-path="'+path+'"]').click();await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/'+path);await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');}
async function contentMode(page){await page.locator('[data-action=workspace-mode][data-mode=content]').click();await expect(page.locator('#workspace-search-query')).toBeFocused();}
async function query(page,value){await page.locator('#workspace-search-query').fill(value);const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/workspace/search');await page.locator('#workspace-search-query').press('Enter');const response=await pending;await expect(page.locator('#workspace-search-results')).toHaveAttribute('aria-busy','false');return response;}
async function settle(page,response){await response.finished();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}
async function sync(page){const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await settle(page,await pending);}
async function audit(page,info,name){const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();await info.attach(name,{body:JSON.stringify({violations:result.violations,incomplete:result.incomplete}),contentType:'application/json'});expect(result.violations.map(({id,nodes})=>({id,targets:nodes.map(n=>n.target)}))).toEqual([]);}
async function capture(page,info,name){await page.locator('#toast-region button').evaluateAll(buttons=>buttons.forEach(button=>button.click()));await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);return new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));});await page.screenshot({path:info.outputPath(name),fullPage:true});}
async function hold(page,local,matcher){const captured=deferred(),release=deferred(),delivered=deferred();local.gates.push(release);let claimed=false;const handler=async route=>{if(claimed)return route.continue();claimed=true;try{const response=await route.fetch();captured.resolve(response);await release.promise;await route.fulfill({response}).catch(()=>{});}finally{delivered.resolve();}};await page.route(matcher,handler);return{captured,release,delivered,async finish(){release.resolve();await delivered.promise;await page.unroute(matcher,handler);}};}

test('workspace ignore: inherited rules and nested exceptions agree in scoped browsing, search and explicit file attachments',async({page,local},info)=>{
  const {app}=await local.start();await page.goto(app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');await page.locator('#prompt-input').fill('保留当前任务草稿');await navigation(page,'.nav-item[data-action=workspace]');
  await expect(page.locator('#workspace-discovery-label')).toHaveText('包含被忽略的文件');await expect(page.locator('#workspace-include-generated')).not.toBeChecked();
  await expect(page.locator('#file-list [data-path="src"]')).toBeVisible();await expect(page.locator('#file-list [data-path="src/keep.tmp"],#file-list [data-path="secret-dir"],#file-list [data-path="root-only.txt"]')).toHaveCount(0);
  await expect(page.locator('#file-list [data-path="Upper.TMP"]')).toBeVisible();await expect(page.locator('#file-list [data-path="lower.tmp"]')).toHaveCount(0);await expect(page.locator('#workspace-scan-summary')).toContainText('按 .gitignore 忽略');
  await enter(page,'src');await expect(page.locator('#file-list [data-path="src/keep.tmp"],#file-list [data-path="src/root-only.txt"]')).toHaveCount(2);await expect(page.locator('#file-list [data-path="src/drop.tmp"],#file-list [data-path="src/nested"]')).toHaveCount(0);
  await contentMode(page);let response=await query(page,'hidden-probe');expect(response.status()).toBe(200);expect(response.request().postDataJSON()).toMatchObject({path:'src',includeGenerated:false,includeIgnored:false});await expect(rows(page)).toHaveCount(0);await expect(page.locator('#workspace-search-status')).toContainText('未覆盖全部文件');
  response=await query(page,'kept-probe');expect(response.status()).toBe(200);await expect(rows(page)).toHaveCount(1);await rows(page).click();await expect(page.locator('.search-preview-location')).toContainText('文件版本已核对');await expect(page.locator('#selected-file-content img')).toHaveCount(0);expect(await page.evaluate(()=>globalThis.__ignoreXss)).toBeUndefined();
  await audit(page,info,'workspace-ignore-desktop');await capture(page,info,'workspace-ignore-desktop.png');await page.locator('#file-preview [data-action=attach-context-file]').click();await expect(page.locator('#draft-file-list')).toContainText('src/keep.tmp');await expect(page.locator('#prompt-input')).toHaveValue('保留当前任务草稿');
});

test('workspace ignore: override includes ignored entries without widening access, and an ignored direct scope is not an empty workspace',async({page,local})=>{
  const {app}=await local.start();await ready(page,app);
  const listing=page.waitForResponse(response=>listURL(new URL(response.url()),'',true));await page.locator('#workspace-include-generated').check();const response=await listing;const data=await response.json();expect(new URL(response.url()).searchParams.get('includeIgnored')).toBe('true');expect(data.scan.ignore).toMatchObject({enabled:false,includeIgnored:true,ignoredFiles:0,ignoredDirectories:0});
  await expect(page.locator('#file-list [data-path="src"],#file-list [data-path="node_modules"]')).toHaveCount(2);await expect(page.locator('#file-list [data-path=".env"],#file-list [data-path=".git"]')).toHaveCount(0);await enter(page,'src');await expect(page.locator('#file-list [data-path="src/drop.tmp"]')).toBeVisible();await page.locator('#browse-root').click();await enter(page,'node_modules');await enter(page,'node_modules/pkg');await expect(page.locator('#file-list [data-path="node_modules/pkg/dep.txt"]')).toBeVisible();await page.locator('#browse-root').click();
  await enter(page,'secret-dir');await page.locator('#file-list [data-path="secret-dir/keep.txt"]').click();await expect(page.locator('#selected-file-content')).toContainText('parent-probe');
  const ignored=page.waitForResponse(response=>listURL(new URL(response.url()),'secret-dir',false));await page.locator('#workspace-include-generated').uncheck();const scope=await(await ignored).json();expect(scope.scan.ignore.scopeIgnored).toBe(true);expect(scope.truncated).toBe(false);await expect(page.locator('#file-list')).toContainText('当前目录已被忽略');await expect(page.locator('#file-list')).not.toContainText('空的');
  await contentMode(page);await query(page,'parent-probe');await expect(rows(page)).toHaveCount(0);await expect(page.locator('#workspace-search-status')).toContainText('当前范围被 .gitignore 忽略');await expect(page.locator('#workspace-search-status')).not.toContainText('部分搜索结果');
  await page.locator('#workspace-include-generated').check();await expect(rows(page)).toHaveCount(0);await query(page,'parent-probe');await expect(rows(page)).toHaveCount(1);await expect(page.locator('#workspace-discovery-note')).toBeVisible();await expect(page.locator('#workspace-discovery-note')).toContainText('不改变文件访问权限');
  await page.locator('[data-action=workspace-mode][data-mode=files]').click();await page.locator('#browse-root').click();await enter(page,'only-ignored');await page.locator('#workspace-include-generated').uncheck();await expect(page.locator('#file-list')).toContainText('当前范围未列出文件');await expect(page.locator('#file-list')).not.toContainText('工作空间还是空的');
});

test('workspace ignore: old gateways keep the original option and independent workspaces do not filter project ignore rules',async({page,local})=>{
  const {app}=await local.start();let capability;
  for(const path of ['bootstrap','state'])await page.route('**/api/'+path,async route=>{const response=await route.fetch(),data=await response.json();if(capability===undefined)delete data.capabilities.workspaceIgnore;else data.capabilities.workspaceIgnore=capability;delete data.capabilities.workspaceDirectory;delete data.workspace.projectMode;await route.fulfill({response,json:data});});
  const observed=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/workspace')observed.push({url:url.href,hasIgnored:url.searchParams.has('includeIgnored')});if(url.pathname==='/api/workspace/search')observed.push({body:request.postDataJSON(),hasIgnored:Object.hasOwn(request.postDataJSON(),'includeIgnored')});});
  await ready(page,app);await expect(page.locator('#workspace-discovery-label')).toHaveText('包含依赖与构建目录');await expect(page.locator('#workspace-ignore-details')).toBeHidden();await page.locator('#workspace-include-generated').check();await contentMode(page);await query(page,'generated-probe');await expect(rows(page)).toHaveCount(1);expect(observed.length).toBeGreaterThan(2);expect(observed.every(item=>!item.hasIgnored)).toBe(true);
  capability=2;await sync(page);await expect(page.locator('#workspace-discovery-label')).toHaveText('包含依赖与构建目录');await page.unrouteAll({behavior:'wait'});
  const standalone=await local.start({projectScan:false});await ready(page,standalone.app);await expect(page.locator('#workspace-generated-option')).toBeHidden();await expect(page.locator('#workspace-ignore-details')).toBeHidden();await enter(page,'src');await expect(page.locator('#file-list [data-path="src/drop.tmp"]')).toBeVisible();await page.locator('#browse-root').click();await enter(page,'secret-dir');await expect(page.locator('#file-list [data-path="secret-dir/keep.txt"]')).toBeVisible();await page.locator('#browse-root').click();await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/');await contentMode(page);const response=await query(page,'hidden-probe');expect((await response.json()).scan.ignore).toMatchObject({enabled:false,includeIgnored:false,files:0,rules:0,bytes:0,ignoredFiles:0,ignoredDirectories:0});await expect(rows(page)).toHaveCount(1);
});

test('workspace ignore: an invalid first rule read keeps the override usable and repairing the rules restores filtered browsing',async({page,local})=>{
  const {app,workspace}=await local.start({invalid:true});await openWorkspace(page,app);await expect(page.locator('#file-list')).toContainText('目录暂不可用');await expect(page.locator('#workspace-generated-option')).toBeVisible();await expect(page.locator('#workspace-include-generated')).toBeEnabled();await expect(page.locator('#file-list')).toContainText('包含被忽略的文件');
  const retried=page.waitForResponse(response=>listURL(new URL(response.url()))&&response.status()===400);await sync(page);await settle(page,await retried);await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await contentMode(page);const failed=await query(page,'hidden-probe');expect(failed.status()).toBeGreaterThanOrEqual(400);expect((await failed.json()).error.code).toBe('GITIGNORE_INVALID');await expect(rows(page)).toHaveCount(0);await expect(page.locator('#workspace-search-status')).toContainText('包含被忽略的文件');
  await page.locator('.session-link').filter({hasText:'已有文件记录'}).click();await page.locator('#context-toggle').click();await page.locator('#artifact-list [data-path="src/keep.tmp"]').click();await expect(page.locator('#context-preview')).toContainText('kept-probe');await page.locator('#context-preview [data-action=workspace-file]').click();await expect(page.locator('#selected-file-content')).toContainText('kept-probe');await expect(page.locator('#top-status')).toHaveText('本地已连接');
  let imports=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/workspace/files'&&request.method()==='POST')imports++;});await page.locator('#workspace-view [data-action=import]').click();await page.locator('#field-path').fill('imported.txt');await page.locator('#field-content').fill('已经成功保存，不应重复提交');const imported=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/workspace/files');await page.locator('#dialog-submit').click();expect((await imported).status()).toBe(201);await expect(page.locator('#app-dialog')).not.toBeVisible();expect(await readFile(join(workspace,'imported.txt'),'utf8')).toBe('已经成功保存，不应重复提交');expect(imports).toBe(1);
  await page.locator('#workspace-include-generated').check();await query(page,'hidden-probe');await expect(rows(page)).toHaveCount(1);await writeFile(join(workspace,'.gitignore'),rootRules);await page.locator('#workspace-include-generated').uncheck();await query(page,'hidden-probe');await expect(rows(page)).toHaveCount(0);await expect(page.locator('#workspace-search-status')).toContainText('按 .gitignore 忽略');await page.locator('[data-mode=files]').click();await expect(page.locator('#file-list [data-path="README.md"]')).toBeVisible();
});

test('workspace ignore: superseded scans, capability withdrawal and workspace replacement reject late policy-bound results',async({page,local})=>{
  const {app}=await local.start();await ready(page,app);
  let held=await hold(page,local,url=>listURL(url,'',true));await page.locator('#workspace-include-generated').check();await held.captured.promise;await page.locator('#workspace-include-generated').uncheck();await expect(page.locator('#file-list [data-path="README.md"]')).toBeVisible();await held.finish();await expect(page.locator('#file-list [data-path="root-only.txt"]')).toHaveCount(0);await expect(page.locator('#workspace-include-generated')).not.toBeChecked();
  let supported=true;for(const path of ['bootstrap','state'])await page.route('**/api/'+path,async route=>{const response=await route.fetch(),data=await response.json();if(!supported)delete data.capabilities.workspaceIgnore;await route.fulfill({response,json:data});});
  await page.locator('#workspace-include-generated').check();await expect(page.locator('#file-list [data-path="root-only.txt"]')).toBeVisible();await contentMode(page);held=await hold(page,local,url=>url.pathname==='/api/workspace/search');await page.locator('#workspace-search-query').fill('hidden-probe');await page.locator('#workspace-search-submit').click();await held.captured.promise;supported=false;await sync(page);await expect(page.locator('#workspace-discovery-label')).toHaveText('包含依赖与构建目录');await expect(page.locator('#workspace-include-generated')).not.toBeChecked();await held.finish();await expect(rows(page)).toHaveCount(0);
  supported=true;await sync(page);await expect(page.locator('#workspace-discovery-label')).toHaveText('包含被忽略的文件');await page.unrouteAll({behavior:'wait'});await page.locator('[data-mode=files]').click();held=await hold(page,local,url=>listURL(url,'',true));await page.locator('#workspace-include-generated').check();await held.captured.promise;await local.replace();await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('#workspace-label')).toHaveText('新的规则工作区');await held.finish();await navigation(page,'.nav-item[data-action=workspace]');await expect(page.locator('#file-list [data-path="fresh.txt"]')).toBeVisible();await expect(page.locator('#file-list [data-path="root-only.txt"]')).toHaveCount(0);await expect(page.locator('#workspace-include-generated')).not.toBeChecked();
});

test('workspace ignore: mobile light and dark controls explain case-sensitive workspace rules without overflow',async({page,local},info)=>{
  await page.setViewportSize({width:390,height:844});const {app}=await local.start();await ready(page,app);await page.locator('#workspace-ignore-details summary').click();await expect(page.locator('#workspace-ignore-details')).toContainText('工作区内的层级 .gitignore');await expect(page.locator('#workspace-ignore-details')).toContainText('区分大小写');await expect(page.locator('#workspace-ignore-details')).toContainText('不读取 Git 已跟踪状态');
  await page.locator('#workspace-include-generated').focus();await page.keyboard.press('Space');await expect(page.locator('#file-list [data-path="root-only.txt"]')).toBeVisible();await expect(page.locator('#workspace-include-generated')).toBeFocused();await page.keyboard.press('Space');await expect(page.locator('#file-list [data-path="root-only.txt"]')).toHaveCount(0);await expect(page.locator('#workspace-include-generated')).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await audit(page,info,'workspace-ignore-mobile-light');await capture(page,info,'workspace-ignore-mobile-light.png');await page.locator('.mobile-menu').click();await page.locator('[data-action=theme]').click();await page.keyboard.press('Escape');await audit(page,info,'workspace-ignore-mobile-dark');await capture(page,info,'workspace-ignore-mobile-dark.png');
  const last=page.locator('#file-list .file-row[data-action=open-file]').last();const lastPath=await last.getAttribute('data-path');await last.scrollIntoViewIfNeeded();await last.click();await expect(page.locator('#selected-file-content')).toBeVisible();await expect(page.locator('.editor-status')).toContainText(lastPath);
});
