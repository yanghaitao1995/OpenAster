import { test as base, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';

// Two real, disposable local workspaces. Restarting B on A's port exercises
// browser-origin reuse without touching the user's service or model endpoints.
const test=base.extend({local:async({},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});const root=await mkdtemp(resolve('test-results','workspace-context-'));
  const first={dataDir:join(root,'a'),workspaceId:randomUUID(),workspaceName:'研究资料'};
  const second={dataDir:join(root,'b'),workspaceId:randomUUID(),workspaceName:'独立项目'};
  for(const [options,name,content]of [[first,'old.txt','原工作区独有内容'],[second,'new.txt','新工作区独有内容']]){
    await mkdir(join(options.dataDir,'workspace'),{recursive:true});await writeFile(join(options.dataDir,'workspace',name),content);
  }
  let app=await startServer(first);
  try{await use({get app(){return app;},first,second,async switchWorkspace(){const port=app.server.address().port;await app.close();app=await startServer({...second,port});return app;}});}
  finally{await app.close();}
}});
// API-delay routing tests need deterministic page.route interception; Service Worker
// behavior is verified separately rather than mixed into these request gates.
test.use({ serviceWorkers: 'block' });
async function ready(page,local){await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');}
async function send(page,text){await page.locator('#prompt-input').fill(text);await page.locator('#send-button').click();}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

test('workspace identity: trusted metadata labels the existing layout and untrusted names remain text',async({page,local})=>{
  local.first.workspaceName='<img src=x>';
  await ready(page,local);const path=join(local.first.dataDir,'workspace');
  for(const id of ['workspace-label','sidebar-workspace-label']){await expect(page.locator('#'+id)).toHaveText('<img src=x>');await expect(page.locator('#'+id)).toHaveAttribute('title','<img src=x>\n'+path);}
  await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#file-list')).toContainText('old.txt');
  await expect(page.locator('#workspace-name')).toHaveText('<img src=x>');await page.locator('[data-action=refresh-files]').click();await expect(page.locator('#workspace-name')).toHaveText('<img src=x>');
  await expect(page.locator('#workspace-label img,#workspace-name img,#sidebar-workspace-label img')).toHaveCount(0);
  await page.keyboard.press('Control+k');await send(page,'读取工作区');await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
  await page.locator('#context-toggle').click();await expect(page.locator('#context-details')).toContainText('<img src=x>');await expect(page.locator('#context-details .context-data-row').first()).toHaveAttribute('title',path);
  await page.locator('#prompt-input').fill('同一目录改名时保留草稿');local.first.workspaceName='研究资料新名称';
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.locator('#workspace-label')).toHaveText('研究资料新名称');await expect(page.locator('#prompt-input')).toHaveValue('同一目录改名时保留草稿');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('workspace identity: same-origin replacement clears old selections, drafts and dialogs and rejects late previews',async({page,local})=>{
  await ready(page,local);await send(page,'读取工作区');await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
  await page.locator('#context-toggle').click();await page.locator('#context-files [data-path="old.txt"]').click();await expect(page.locator('#context-preview')).toContainText('原工作区独有内容');
  await page.locator('#prompt-input').fill('只属于原工作区的未发送草稿');await page.locator('#pin-current').click();
  const captured=deferred(),release=deferred();
  await page.route('**/api/workspace/file?path=old.txt',async route=>{const response=await route.fetch();captured.resolve();await release.promise;await route.fulfill({response});});
  await page.locator('#context-files [data-path="old.txt"]').click();await captured.promise;
  await page.locator('[data-action=rename]').click();await expect(page.locator('#app-dialog')).toBeVisible();
  await local.switchWorkspace();await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await expect(page.locator('#workspace-label')).toHaveText('独立项目');await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await expect(page.locator('#home-view')).toBeVisible();await expect(page.locator('#app-dialog')).not.toBeVisible();await expect(page.locator('#prompt-input')).toHaveValue('');await expect(page.locator('#send-button')).toBeDisabled();
  await expect(page.locator('#session-list .session-row')).toHaveCount(0);await expect(page.locator('#messages')).toBeEmpty();await expect(page.locator('#context-preview')).toBeEmpty();
  expect(await page.evaluate(()=>sessionStorage.getItem('openaster.current-session'))).toBeNull();expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('openaster.pins')))).toEqual([]);
  const delivered=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/workspace/file');release.resolve();await(await delivered).finished();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect(page.locator('#context-preview')).toBeEmpty();await expect(page.locator('#file-preview')).not.toContainText('原工作区独有内容');
  await page.locator('.nav-item[data-action=workspace]').click();await expect(page.locator('#file-list')).toContainText('new.txt');await expect(page.locator('#file-list')).not.toContainText('old.txt');
  await page.keyboard.press('Control+p');await expect(page.locator('.command-palette')).toContainText('new.txt');await expect(page.locator('.command-palette')).not.toContainText('old.txt');
  await page.keyboard.press('Escape');await page.reload();await expect(page.locator('#home-view')).toBeVisible();await expect(page.locator('#workspace-label')).toHaveText('独立项目');
});

test('workspace connection: pairing clears context before bootstrap and old task creation cannot send into the next connection',async({page,local})=>{
  await ready(page,local);await page.locator('.nav-item[data-action=skills]').click();await page.locator('[data-action=use-skill]').first().click();
  const created=deferred(),releaseCreate=deferred(),bootstrapped=deferred(),releaseBootstrap=deferred();const messages=[];
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/sessions\/[^/]+\/messages$/.test(new URL(request.url()).pathname))messages.push(request.postDataJSON());});
  await page.route('**/api/sessions',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();created.resolve();await releaseCreate.promise;await route.fulfill({response});});
  await send(page,'不得迁移到另一工作区的任务内容');await created.promise;
  await page.locator('.nav-item[data-action=settings]').click();await page.locator('#settings-view [data-action=gateway]').click();await page.locator('#field-url').fill('');
  await page.route('**/api/bootstrap',async route=>{const response=await route.fetch();bootstrapped.resolve();await releaseBootstrap.promise;await route.fulfill({response});});
  await page.locator('#dialog-submit').click();await bootstrapped.promise;
  await expect(page.locator('#prompt-input')).toHaveValue('');await expect(page.locator('#composer-context')).not.toBeVisible();await expect(page.locator('#send-button')).toBeDisabled();await expect(page.locator('#model-select')).toHaveValue('');await expect(page.locator('#model-select option')).toHaveText(['请先连接模型']);
  const received=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/sessions');releaseCreate.resolve();await(await received).finished();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));expect(messages).toEqual([]);await expect(page.locator('#messages')).toBeEmpty();
  // Empty gateway URL reconnects to the same origin and database identity: saved
  // new-task text is restored only after bootstrap, without replaying the stale send.
  releaseBootstrap.resolve();await expect(page.locator('#app-dialog')).not.toBeVisible();await expect(page.locator('#top-status')).toHaveText('本地已连接');await expect(page.locator('#home-view')).toBeVisible();await expect(page.locator('#prompt-input')).toHaveValue('不得迁移到另一工作区的任务内容');expect(messages).toEqual([]);
  await expect(page.locator('#workspace-label')).toHaveText('研究资料');await expect(page.locator('#model-select')).toHaveValue('demo');
});
