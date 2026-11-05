import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';

const test=base.extend({local:async({page},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});const root=await mkdtemp(resolve('test-results','workspace-browse-'));
  const dataDir=join(root,'a'),workspace=join(dataDir,'workspace');await mkdir(workspace,{recursive:true});
  const files={'readme.md':'全局项目说明','src/main.js':'export const source = true;','src/deep/note.txt':'子目录完整相对路径','docs/guide.md':'另一个目录',
    'node_modules/pkg/index.js':'依赖示例','dist/bundle.js':'构建示例','only-generated/node_modules/pkg/data.txt':'被默认省略的依赖内容','.env':'fake-sensitive-value','.git/config':'fake-git-config'};
  for(const [path,content]of Object.entries(files)){await mkdir(dirname(join(workspace,path)),{recursive:true});await writeFile(join(workspace,path),content);}
  const deepScope=['deep-root',...Array.from({length:15},(_,i)=>'d'+String(i+1).padStart(2,'0'))].join('/');
  await mkdir(join(workspace,deepScope),{recursive:true});await writeFile(join(workspace,deepScope,'beyond-depth.txt'),'not in the bounded listing');
  const workspaceOptions={createRoot:false,denySensitivePaths:true,projectScan:true};
  // A deterministic local runtime adapter creates a real, approved artifact.
  // Browser actions still use the real authenticated HTTP server and real files.
  const runtimeOptions={providerCall:async(_provider,{messages})=>messages.some(message=>message.role==='tool')?
    {content:'产物已经在批准后写入。',toolCalls:[]}:
    {content:'请审核这次文件写入。',toolCalls:[{id:randomUUID(),name:'write_file',args:{path:'dist/result.md',content:'# 已审核产物\n完整写入内容。'}}]}};
  let app=await startServer({dataDir,workspaceId:randomUUID(),workspaceName:'目录浏览测试',workspaceOptions,runtimeOptions});
  const gates=[];
  try{await use({get app(){return app;},workspace,gates,deepScope,async switchWorkspace(){const port=app.server.address().port;await app.close();const next=join(root,'b');await mkdir(join(next,'workspace'),{recursive:true});await writeFile(join(next,'workspace','fresh.md'),'新的独立工作区');app=await startServer({port,dataDir:next,workspaceId:randomUUID(),workspaceName:'另一个工作区',workspaceOptions,runtimeOptions});}});}
  finally{for(const gate of gates)gate.resolve();await page.unrouteAll({behavior:'wait'});await page.context().close();await app.close();}
}});
test.use({serviceWorkers:'block'});
const listRequest=(scope='',generated=false)=>url=>url.pathname==='/api/workspace/directory'&&(url.searchParams.get('path')||'')===scope&&(url.searchParams.get('includeGenerated')==='true')===generated;
const rootIndex=url=>url.pathname==='/api/workspace'&&!(url.searchParams.get('path')||'');
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
async function ready(page,local){await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#file-list .file-row[data-path="readme.md"]')).toBeVisible();}
async function enter(page,path){await page.locator('#file-list .file-row[data-path="'+path+'"]').click();await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/'+path);await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');}
async function root(page){await page.locator('#browse-root').click();await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/');await expect(page.locator('#file-list .file-row[data-path="readme.md"]')).toBeVisible();}
async function settleResponse(page,response){await response.finished();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}
async function enterDeep(page,scope){let current='';for(const part of scope.split('/')){current=current?current+'/'+part:part;await enter(page,current);}}
async function hold(page,local,matcher){const captured=deferred(),release=deferred(),delivered=deferred();local.gates.push(release);const handler=async route=>{try{const response=await route.fetch();captured.resolve(response);await release.promise;await route.fulfill({response}).catch(()=>{});}finally{delivered.resolve();}};await page.route(matcher,handler);return{captured,release,delivered,async finish(){release.resolve();await delivered.promise;await page.unroute(matcher,handler);await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}};}
async function sync(page){const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await settleResponse(page,await response);}

test('workspace browse: directories open with full workspace-relative paths and root/up preserve the global index',async({page,local},testInfo)=>{
  // Isolate navigation from the independent SSE-ready refresh in this one
  // request-count test. Other cases keep the real stream and its lifecycle.
  const eventsPaused=deferred();local.gates.push(eventsPaused);
  await page.route('**/api/events',async route=>{await eventsPaused.promise;await route.abort('aborted').catch(()=>{});});
  let recursiveRequests=0;page.on('request',request=>{if(rootIndex(new URL(request.url())))recursiveRequests++;});
  await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');await expect(page.locator('#file-count')).toHaveText('—');
  const beforeNavigation=recursiveRequests,globalCount=await page.locator('#file-count').textContent();expect(beforeNavigation).toBe(0);
  await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#file-list .file-row[data-path="readme.md"]')).toBeVisible();await expect(page.locator('#browse-root')).toBeDisabled();
  expect(recursiveRequests).toBe(beforeNavigation);await expect(page.locator('#workspace-listing-note')).toContainText('进入文件夹逐层浏览');await expect(page.locator('#file-list [data-path="src/main.js"],#file-list [data-path="docs/guide.md"]')).toHaveCount(0);
  await expect(page.locator('#file-list .file-row[data-path=src]')).toBeEnabled();await enter(page,'src');
  await expect(page.locator('#file-list .file-row[data-path="src/main.js"]>span:nth-child(2)')).toHaveText('main.js');await expect(page.locator('#file-list .file-row[data-path="src/main.js"]')).toHaveAttribute('title','src/main.js');await expect(page.locator('#file-list')).not.toContainText('readme.md');await expect(page.locator('#file-count')).toHaveText(globalCount);
  await page.locator('#file-list .file-row[data-path="src/main.js"]').click();await expect(page.locator('#selected-file-content')).toHaveText('export const source = true;');await expect(page.locator('.editor-status')).toContainText('src/main.js');
  await page.screenshot({path:testInfo.outputPath('workspace-project-desktop.png'),fullPage:true});
  await enter(page,'src/deep');await page.locator('#file-list .file-row[data-path="src/deep/note.txt"]').click();await expect(page.locator('#selected-file-content')).toHaveText('子目录完整相对路径');
  await page.locator('#browse-up').click();await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/src');await expect(page.locator('#file-list .file-row[data-path="src/main.js"]')).toBeVisible();
  await page.locator('#file-search').fill('main');await expect(page.locator('#file-list .file-row')).toHaveCount(1);await root(page);await expect(page.locator('#file-search')).toHaveValue('');
  expect(recursiveRequests).toBe(beforeNavigation);await page.keyboard.press('Control+p');await page.getByRole('combobox',{name:'搜索命令'}).fill('docs/guide.md');await expect(page.locator('.command-palette [role=option]')).toHaveCount(1);await expect(page.locator('#file-count')).toHaveText('4');await page.keyboard.press('Enter');await expect(page.locator('#selected-file-content')).toHaveText('另一个目录');expect(recursiveRequests).toBe(beforeNavigation+1);await expect(page.locator('#file-count')).toHaveText('4');
});

test('workspace browse: generated exclusions, partial budgets and mobile controls explain the current scope',async({page,browser,local},testInfo)=>{
  await ready(page,local);await expect(page.locator('#workspace-include-generated')).not.toBeChecked();await expect(page.locator('#file-list .file-row[data-path=node_modules]')).toHaveCount(0);await expect(page.locator('#file-list .file-row[data-path=".env"]')).toHaveCount(0);
  await expect(page.locator('#workspace-scan-summary')).not.toContainText('部分列表');await expect(page.locator('#workspace-scan-summary')).not.toContainText('目录深度上限');await expect(page.locator('#workspace-scan-summary')).toContainText('跳过');
  await enter(page,'only-generated');await expect(page.locator('#file-list')).toContainText('当前范围未列出文件');await expect(page.locator('#file-list')).not.toContainText('工作空间还是空的');
  await expect(page.locator('#workspace-scan-summary')).toHaveText('已排除 1 个依赖或构建目录入口（不计后代）');await expect(page.locator('#workspace-discovery-note')).toContainText('不改变文件访问权限');
  await page.locator('#workspace-include-generated').check();await expect(page.locator('#file-list .file-row[data-path="only-generated/node_modules"]')).toBeVisible();await expect(page.locator('#file-list .file-row[data-path="only-generated/node_modules/pkg/data.txt"]')).toHaveCount(0);await enter(page,'only-generated/node_modules');await enter(page,'only-generated/node_modules/pkg');await expect(page.locator('#file-list .file-row[data-path="only-generated/node_modules/pkg/data.txt"]')).toBeVisible();await expect(page.locator('#workspace-scan-summary')).not.toContainText('部分列表');
  await root(page);await expect(page.locator('#file-list .file-row[data-path=node_modules]')).toBeVisible();await expect(page.locator('#file-list .file-row[data-path=".env"],#file-list .file-row[data-path=".git"]')).toHaveCount(0);
  await enterDeep(page,local.deepScope);await expect(page.locator('#file-list')).toContainText('当前范围未列出文件');await expect(page.locator('#workspace-scan-summary')).toContainText('部分列表');await expect(page.locator('#workspace-scan-summary')).toContainText('目录深度上限');await expect(page.locator('#workspace-scan-summary')).toContainText('已读取 1 个目录项');
  const mobileContext=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});try{
    const mobile=await mobileContext.newPage();await mobile.goto(local.app.url);await expect(mobile.locator('#top-status')).toHaveText('本地已连接');await mobile.locator('.mobile-menu').click();await mobile.locator('.nav-item[data-action=workspace]').click();await expect(mobile.locator('#file-list .file-row[data-path="readme.md"]')).toBeVisible();await enterDeep(mobile,local.deepScope);
    await mobile.evaluate(()=>{window.scrollTo(0,0);document.querySelector('#workspace-view').scrollTop=0;});await mobile.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
    expect(await mobile.evaluate(()=>({width:document.documentElement.scrollWidth,y:window.scrollY}))).toEqual({width:390,y:0});await expect(mobile.locator('#workspace-scope')).toHaveAttribute('title','/'+local.deepScope);
    const listBounds=await mobile.locator('#file-list').boundingBox(),panelBounds=await mobile.locator('.file-panel').boundingBox(),footerBounds=await mobile.locator('.file-tree-footer').boundingBox(),headingBounds=await mobile.locator('#workspace-view h1').boundingBox(),topbarBounds=await mobile.locator('.topbar').boundingBox();expect(listBounds.height).toBeGreaterThan(100);expect(footerBounds.y+footerBounds.height).toBeLessThanOrEqual(panelBounds.y+panelBounds.height+1);expect(headingBounds.y).toBeGreaterThanOrEqual(topbarBounds.y+topbarBounds.height);
    const audit=await new AxeBuilder({page:mobile}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();await testInfo.attach('workspace-mobile-partial-scan',{body:JSON.stringify({violations:audit.violations,incomplete:audit.incomplete}),contentType:'application/json'});expect(audit.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)}))).toEqual([]);
    await mobile.screenshot({path:testInfo.outputPath('workspace-mobile-scope.png'),fullPage:true});
  }finally{await mobileContext.close();}
});

test('workspace browse: late scoped and root requests cannot replace a newer directory',async({page,local})=>{
  await ready(page,local);let held=await hold(page,local,listRequest('src'));
  const aborted=page.waitForEvent('requestfailed',request=>listRequest('src')(new URL(request.url())));
  await page.locator('#file-list .file-row[data-path=src]').click();await held.captured.promise;await root(page);await aborted;await held.finish();
  await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/');await expect(page.locator('#file-list .file-row[data-path="readme.md"]')).toBeVisible();
  held=await hold(page,local,rootIndex);await page.keyboard.press('Control+p');await held.captured.promise;await page.keyboard.press('Escape');
  await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');await expect(page.locator('#file-list .file-row[data-path="src/main.js"]')).toHaveCount(0);await held.finish();
  await expect(page.locator('#file-list .file-row[data-path="src/main.js"]')).toHaveCount(0);await expect(page.locator('#file-list .file-row[data-path="readme.md"]')).toBeVisible();await expect(page.locator('#file-count')).toHaveText('4');
  held=await hold(page,local,rootIndex);await page.keyboard.press('Control+p');await held.captured.promise;await page.keyboard.press('Escape');await enter(page,'docs');await held.finish();
  await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/docs');await expect(page.locator('#file-list .file-row[data-path="docs/guide.md"]')).toBeVisible();await expect(page.locator('#file-list .file-row[data-path="readme.md"]')).toHaveCount(0);
  held=await hold(page,local,listRequest('docs'));await page.locator('[data-action=refresh-files]').click();await held.captured.promise;
  const leaving=page.waitForEvent('requestfailed',request=>listRequest('docs')(new URL(request.url())));await page.locator('.nav-item[data-action=settings]').click();await leaving;await held.finish();await expect(page.locator('#settings-view')).toBeVisible();await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');
  await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#file-list .file-row[data-path="docs/guide.md"]')).toBeVisible();
  held=await hold(page,local,listRequest('docs'));await page.locator('[data-action=refresh-files]').click();await held.captured.promise;
  await page.route('**/api/bootstrap',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_RECONNECT',message:'本机重连测试暂不可用'}})}));
  const reconnectAbort=page.waitForEvent('requestfailed',request=>listRequest('docs')(new URL(request.url())));await page.evaluate(()=>window.dispatchEvent(new Event('online')));await reconnectAbort;await expect(page.locator('#connection-message')).toContainText('本机重连测试暂不可用');await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');await expect(page.locator('#workspace-file-total')).not.toHaveText('正在读取…');await held.finish();
  await page.unroute('**/api/bootstrap');await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('#top-status')).toHaveText('本地已连接');await expect(page.locator('#file-list .file-row[data-path="docs/guide.md"]')).toBeVisible();
});

test('workspace browse: approved generated artifacts remain available outside scope and workspace replacement resets browsing',async({page,local})=>{
  await ready(page,local);await page.locator('.nav-item[data-action=settings]').click();await page.locator('[data-action=add-provider]').click();await page.locator('#field-name').fill('本机审批测试');await page.locator('#field-baseUrl').fill('http://127.0.0.1:1/v1');await page.locator('#field-model').fill('local-runtime-fixture');
  const saved=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/providers');await page.locator('#dialog-submit').click();const{provider}=await(await saved).json();await expect(page.locator('#app-dialog')).not.toBeVisible();
  await page.keyboard.press('Control+k');await page.locator('#model-select').selectOption(provider.id);await page.locator('#prompt-input').fill('写入生成目录中的审核产物');await page.locator('#send-button').click();await expect(page.locator('.approval-card')).toContainText('dist/result.md');await page.locator('[data-action=approve]').click();await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
  await page.locator('.nav-item[data-action=workspace]').click();await enter(page,'src');await page.locator('.session-link').filter({hasText:'写入生成目录中的审核产物'}).click();await page.locator('#context-toggle').click();
  await expect(page.locator('#context-files')).toContainText('readme.md');const artifact=page.locator('#artifact-list .artifact-file[data-path="dist/result.md"]');await expect(artifact).toBeEnabled();await artifact.click();await expect(page.locator('#context-preview')).toContainText('# 已审核产物');
  await page.keyboard.press('Control+p');await page.getByRole('combobox',{name:'搜索命令'}).fill('dist/result.md');await expect(page.locator('.command-palette [role=option]')).toHaveCount(1);await expect(page.locator('.command-palette')).toContainText('文件写入记录');await page.keyboard.press('Enter');await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/src');await expect(page.locator('#selected-file-content')).toContainText('# 已审核产物');
  await page.locator('#workspace-include-generated').check();await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');
  const held=await hold(page,local,listRequest('src',true));await page.locator('[data-action=refresh-files]').click();await held.captured.promise;
  await local.switchWorkspace();await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('#workspace-label')).toHaveText('另一个工作区');await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await held.finish();
  await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/');await expect(page.locator('#workspace-include-generated')).not.toBeChecked();await expect(page.locator('#file-list')).toContainText('fresh.md');await expect(page.locator('#file-list')).not.toContainText('src/main.js');await expect(page.locator('#context-preview')).toBeEmpty();
});

test('workspace browse: directory schema failures never fall back to recursive results and a valid retry recovers',async({page,local})=>{
  let recursiveRequests=0;page.on('request',request=>{if(rootIndex(new URL(request.url())))recursiveRequests++;});await ready(page,local);await expect(page.locator('#file-count')).toHaveText('—');expect(recursiveRequests).toBe(0);
  // Keep a valid recursive snapshot present so a malformed directory response
  // cannot appear to recover by silently falling back to this other dataset.
  await page.keyboard.press('Control+p');await expect(page.locator('#file-count')).toHaveText('4');await page.keyboard.press('Escape');const indexedRequests=recursiveRequests;
  const mutations=[
    data=>{data.version=2;},data=>{data.listing='recursive';},data=>{data.scope='src';},
    data=>{data.files.push({path:'src/deep/note.txt',type:'file',size:1});},
    data=>{data.files.push({path:'../outside.txt',type:'file',size:1});},
    data=>{data.files.push({...data.files[0]});},data=>{data.scan.visitedEntries=-1;},
    data=>{data.scan.limits=['entries','entries'];data.truncated=true;},
    data=>{data.scan.limits=['search-files'];data.truncated=true;},
    data=>{data.truncated=true;},data=>{data.scan.projectMode=false;},
  ];
  let mutate;
  await page.route(listRequest(),async route=>{const response=await route.fetch(),data=await response.json();mutate?.(data);await route.fulfill({response,json:data});});
  for(const invalid of mutations){
    mutate=invalid;await page.locator('[data-action=refresh-files]').click();await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');await expect(page.locator('#file-list')).toContainText('当前目录返回格式或范围无效');await expect(page.locator('#file-list .file-row')).toHaveCount(0);await expect(page.locator('#file-count')).toHaveText('4');expect(recursiveRequests).toBe(indexedRequests);
    // Clear only user-visible notifications, never force click through an overlay.
    await page.locator('#toast-region [aria-label="关闭提示"]').evaluateAll(buttons=>buttons.forEach(button=>button.click()));
  }
  mutate=null;await page.locator('[data-action=refresh-files]').click();await expect(page.locator('#file-list .file-row[data-path="readme.md"]')).toBeVisible();await expect(page.locator('#file-list .file-row[data-path="src/main.js"]')).toHaveCount(0);
});

test('workspace browse: withdrawing directory capability rejects a late modern response and retains old recursive compatibility',async({page,local})=>{
  let capability=1;
  for(const name of ['bootstrap','state'])await page.route('**/api/'+name,async route=>{const response=await route.fetch(),data=await response.json();if(capability===undefined)delete data.capabilities.workspaceDirectory;else data.capabilities.workspaceDirectory=capability;await route.fulfill({response,json:data});});
  await ready(page,local);const held=await hold(page,local,listRequest('src'));await page.locator('#file-list .file-row[data-path=src]').click();await held.captured.promise;
  const aborted=page.waitForEvent('requestfailed',request=>listRequest('src')(new URL(request.url())));capability=undefined;await sync(page);await aborted;
  await expect(page.locator('#workspace-listing-note')).toContainText('递归浏览（兼容模式）');await expect(page.locator('#file-list .file-row[data-path="src/deep/note.txt"]')).toBeVisible();await held.finish();await expect(page.locator('#file-list .file-row[data-path="src/deep/note.txt"]')).toBeVisible();
  let modernRequests=0;page.on('request',request=>{if(new URL(request.url()).pathname==='/api/workspace/directory')modernRequests++;});
  capability=2;await sync(page);await page.locator('[data-action=refresh-files]').click();await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');expect(modernRequests).toBe(0);await expect(page.locator('#file-list .file-row[data-path="src/main.js"]>span:nth-child(2)')).toHaveText('src/main.js');
  capability=1;await sync(page);await expect(page.locator('#workspace-listing-note')).toContainText('逐层浏览');await expect(page.locator('#file-list .file-row[data-path="src/main.js"]')).toBeVisible();await expect(page.locator('#file-list .file-row[data-path="src/deep/note.txt"]')).toHaveCount(0);expect(modernRequests).toBeGreaterThan(0);
});

test('workspace browse: a bad descendant ignore file can fail the global index without clearing a usable parent directory',async({page,local})=>{
  await writeFile(join(local.workspace,'src','.gitignore'),Buffer.from('invalid\0rule'));
  let recursiveRequests=0;page.on('request',request=>{if(rootIndex(new URL(request.url())))recursiveRequests++;});await ready(page,local);expect(recursiveRequests).toBe(0);await expect(page.locator('#file-count')).toHaveText('—');
  const initial=page.waitForResponse(response=>rootIndex(new URL(response.url()))&&response.status()===400);await page.keyboard.press('Control+p');const invalid=await initial;expect((await invalid.json()).error.code).toBe('GITIGNORE_INVALID');await settleResponse(page,invalid);await page.keyboard.press('Escape');
  await expect(page.locator('#file-list .file-row[data-path="src"]')).toBeVisible();await expect(page.locator('#file-list')).not.toContainText('目录暂不可用');
  const held=await hold(page,local,rootIndex);await page.keyboard.press('Control+p');const failed=await held.captured.promise;expect(failed.status()).toBe(400);await page.keyboard.press('Escape');await expect(page.locator('#file-list')).toHaveAttribute('aria-busy','false');await held.finish();await expect(page.locator('#file-list .file-row[data-path="readme.md"]')).toBeVisible();
  await page.locator('#file-list .file-row[data-path="readme.md"]').click();await expect(page.locator('#selected-file-content')).toHaveText('全局项目说明');await page.locator('#file-list .file-row[data-path="src"]').click();await expect(page.locator('#file-list')).toContainText('目录暂不可用');
  await page.locator('#workspace-include-generated').check();await expect(page.locator('#file-list .file-row[data-path="src/main.js"]')).toBeVisible();await expect(page.locator('#workspace-scope')).toHaveText('当前范围：/src');
});
