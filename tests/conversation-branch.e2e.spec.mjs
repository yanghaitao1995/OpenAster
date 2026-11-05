import {readUtf8Body} from './helpers/http-body.mjs';
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const originalFile='这是发送当时的原文件。\n<img src=x onerror="globalThis.__branchXss=1">';
const digest=value=>createHash('sha256').update(value).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const test=base.extend({local:async({},use)=>{
  const requests=[],ids={old:randomUUID(),current:randomUUID(),tools:randomUUID()};
  const provider=createServer(async(req,res)=>{const raw=await readUtf8Body(req);const input=JSON.parse(raw);requests.push(input);
    const write=JSON.stringify(input.messages.filter(item=>item.role==='user').at(-1)).includes('请写入一份新的总结')&&!input.messages.some(item=>item.role==='tool');
    const message=write?{role:'assistant',content:null,tool_calls:[{id:'branch-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'branch-result.txt',content:'新分支的独立写入'})}}]}:{role:'assistant',content:'新分支已根据这次编辑完成。'};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message,finish_reason:write?'tool_calls':'stop'}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}}));
  });await new Promise(done=>provider.listen(0,'127.0.0.1',done));
  await mkdir(resolve('test-results'),{recursive:true});const root=await mkdtemp(resolve('test-results','conversation-branch-ui-'));let dataDir=join(root,'original');
  const sourceId=randomUUID(),otherId=randomUUID(),messageIds=Array.from({length:6},()=>randomUUID()),timestamp='2026-01-01T00:00:00.000Z';
  async function seed(fresh=false){await mkdir(join(dataDir,'workspace','notes'),{recursive:true});await writeFile(join(dataDir,'workspace','notes','source.txt'),'当前磁盘版本，不应替换原消息附件。');await writeFile(join(dataDir,'workspace','draft.txt'),'未发送草稿的文件');await writeFile(join(dataDir,'workspace','already-written.txt'),'此前已经写入，不能因分支而撤回。');
    const store=new Store(dataDir);for(const[id,name,model,toolMode]of[[ids.old,'原任务连接','previous-model','none'],[ids.current,'当前明确选择','current-model','none'],[ids.tools,'文件工具连接','tools-model','workspace']])store.putProvider({id,name,model,toolMode,type:'openai',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,streaming:false,enabled:true,maxTokens:512,tokenParameter:'max_completion_tokens'});
    if(!fresh){const messages=[{role:'user',content:'较早的需求'},{role:'assistant',content:'较早的答复'},{role:'user',content:'需要修改的旧问题 <script>globalThis.__branchXss=2</script>',contextFiles:[{path:'notes/source.txt',sha256:digest(originalFile),content:originalFile}]},{role:'assistant',content:'应排除的旧答复'},{role:'user',content:'应排除的后续问题'},{role:'assistant',content:'应排除的后续答复'}].map((message,index)=>({...message,id:messageIds[index],createdAt:timestamp}));
      store.putSession({id:sourceId,title:'原项目讨论 <img src=x>',providerId:ids.old,createdAt:timestamp,updatedAt:timestamp,messages,approvals:[],run:{id:randomUUID(),status:'completed',startedAt:timestamp,finishedAt:timestamp,steps:[{id:randomUUID(),type:'model',status:'completed',usage:null}],output:null}});
      store.putSession({id:otherId,title:'另一个已有任务',providerId:ids.current,createdAt:timestamp,updatedAt:timestamp,messages:[],approvals:[],run:null});
    }store.close();
  }await seed();let app=await startServer({dataDir,workspaceId:randomUUID(),workspaceName:'分支测试工作区'});
  const local={get app(){return app;},get dataDir(){return dataDir;},get workspacePath(){return join(dataDir,'workspace');},ids,sourceId,otherId,messageIds,requests,
    read(id=sourceId){const store=new Store(dataDir);try{return store.getSession(id);}finally{store.close();}},
    mutate(callback){const store=new Store(dataDir);try{return callback(store);}finally{store.close();}},
    async switchWorkspace(){const port=app.server.address().port;await app.close();dataDir=join(root,'replacement');await seed(true);app=await startServer({port,dataDir,workspaceId:randomUUID(),workspaceName:'新的分支工作区'});}
  };try{await use(local);}finally{await app.close();provider.closeAllConnections();await new Promise(done=>provider.close(done));}
}});
async function navigate(page,selector){if(await page.locator('.mobile-menu').isVisible())await page.locator('.mobile-menu').click();await page.locator(selector).click();}
async function ready(page,local){await page.goto(local.app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');await openTask(page,local.sourceId);await page.locator('#model-select').selectOption(local.ids.current);}
async function openTask(page,id){await navigate(page,`.session-link[data-id="${id}"]`);await expect(page.locator('#chat-view')).toBeVisible();}
const editButton=(page,local,index=2)=>page.locator(`[data-action=branch-message][data-message-id="${local.messageIds[index]}"]`);
async function editor(page,local,index=2){await editButton(page,local,index).click();await expect(page.locator('#dialog-submit')).toBeEnabled();await expect(page.locator('.branch-preview-status')).toContainText('预览已就绪');}
async function runBranch(page,text){await page.locator('#field-branchContent').fill(text);const result=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/branches'));await page.locator('#dialog-submit').click();return result;}
async function complete(page){await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');}
async function settle(page,response){await response.finished();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}
async function syncState(page){const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await settle(page,await response);}
async function capture(page,info,name){await page.locator('#toast-region button').evaluateAll(buttons=>buttons.forEach(button=>button.click()));await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));await page.screenshot({path:info.outputPath(name),animations:'disabled'});}
async function audit(page,info,name){const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();await info.attach(name,{body:JSON.stringify({violations:result.violations,incomplete:result.incomplete}),contentType:'application/json'});expect(result.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)}))).toEqual([]);}

test('conversation branch: edited prefix uses original snapshots and current model while preserving the composer draft',async({page,local},info)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await ready(page,local);const original=local.read();
  await navigate(page,'.nav-item[data-action=workspace]');await page.locator('#file-list .file-row[data-path="draft.txt"]').click();await page.locator('#file-preview [data-action=attach-context-file]').click();await openTask(page,local.sourceId);await page.locator('#model-select').selectOption(local.ids.current);await page.locator('#prompt-input').fill('保持这份未发送草稿');await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
  await editor(page,local);await expect(page.locator('#field-branchProvider')).toHaveValue(local.ids.current);await expect(page.locator('.branch-files')).toContainText('notes/source.txt');await expect(page.locator('.branch-files')).toContainText(digest(originalFile));await expect(page.locator('.branch-files input')).toHaveCount(0);await expect(page.locator('.branch-scope')).toContainText('2 条消息');const skill=page.locator('#field-branchSkill');await expect(skill).toBeDisabled();await expect(skill).toHaveAttribute('title','仅对话模式不加载技能');await page.locator('#field-branchProvider').selectOption(local.ids.tools);await expect(skill).toBeEnabled();await skill.selectOption('writing');await page.locator('#field-branchProvider').selectOption(local.ids.current);await expect(skill).toBeDisabled();await expect(skill).toHaveValue('writing');await expect(skill).toHaveAttribute('title','仅对话模式不加载技能');
  expect(local.requests).toHaveLength(0);await capture(page,info,'conversation-branch-desktop.png');
  const response=await runBranch(page,'重新解释这份文件 <img src=x onerror="globalThis.__branchXss=3">');expect(response.status()).toBe(201);const request=response.request().postDataJSON();expect(request).toMatchObject({messageId:local.messageIds[2],providerId:local.ids.current,mode:'prefix'});expect(request).not.toHaveProperty('skillId');expect(request).not.toHaveProperty('files');const {session}=await response.json();await complete(page);
  expect(local.read()).toEqual(original);expect(session.id).not.toBe(local.sourceId);expect(session.branch).toMatchObject({sourceSessionId:local.sourceId,sourceMessageId:local.messageIds[2],mode:'prefix',retainedMessages:2});
  await expect(page.locator('#prompt-input')).toHaveValue('');await expect(page.locator('.draft-file-chip')).toHaveCount(0);await expect(page.locator('#branch-origin')).toContainText('保留此前 2 条消息');
  expect(local.requests).toHaveLength(1);expect(local.requests[0].model).toBe('current-model');expect(local.requests[0]).not.toHaveProperty('tools');const wire=JSON.stringify(local.requests[0]);expect(wire).toContain('较早的需求');expect(wire).toContain('较早的答复');expect(JSON.parse(local.requests[0].messages.at(-1).content).attached_files).toEqual([{untrusted_data:true,path:'notes/source.txt',sha256:digest(originalFile),content:originalFile}]);expect(wire).not.toContain('当前磁盘版本');expect(wire).not.toContain('应排除');expect(wire).not.toContain('未发送草稿的文件');expect(wire).not.toContain('需要修改的旧问题');expect(wire).not.toContain('原创写作');const writingInstructions=(await readFile(resolve('skills/writing/SKILL.md'),'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();expect(writingInstructions).not.toBe('');expect(wire).not.toContain(writingInstructions);
  expect(await page.evaluate(()=>globalThis.__branchXss)).toBeUndefined();await expect(page.locator('#messages script,#messages img,#branch-origin img')).toHaveCount(0);await expect(page.locator('#composer-draft-label')).toHaveText('本机草稿');await page.reload();await expect(page.locator('#branch-origin')).toContainText('原项目讨论');await complete(page);expect(await readFile(join(local.workspacePath,'already-written.txt'),'utf8')).toContain('不能因分支而撤回');expect(errors).toEqual([]);
  await openTask(page,local.sourceId);await expect(page.locator('#prompt-input')).toHaveValue('保持这份未发送草稿');await expect(page.locator('.draft-file-chip')).toContainText('draft.txt');await expect(page.locator('#model-select')).toHaveValue(local.ids.current);expect(local.requests).toHaveLength(1);expect(local.read()).toEqual(original);
});

test('conversation branch: message-only excludes the prefix and workspace writes require a fresh approval',async({page,local},info)=>{
  local.mutate(store=>{const source=store.getSession(local.sourceId);source.title='原项目讨论：资料整理';store.putSession(source);});
  // Drain the initial SSE state refresh before selecting the source. Its history
  // refresh must not replace the edit button while the first click is dispatched.
  const initialState=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/api/state');
  await page.goto(local.app.url);await settle(page,await initialState);await expect(page.locator('#top-status')).toHaveText('本地已连接');
  const sourceHistory=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/api/sessions/'+local.sourceId);
  await openTask(page,local.sourceId);await settle(page,await sourceHistory);await expect(page.locator('#send-hint')).toHaveText('Enter 发送');await page.locator('#model-select').selectOption(local.ids.current);
  await editor(page,local);await page.locator('#field-branchMode').selectOption('message');await page.locator('#field-branchProvider').selectOption(local.ids.tools);const response=await runBranch(page,'请写入一份新的总结');expect(response.status()).toBe(201);const {session}=await response.json();await expect(page.locator('#approval-list .approval-card')).toHaveCount(1);await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('等待你的批准');
  expect(session.branch.retainedMessages).toBe(0);expect(JSON.stringify(local.requests[0])).not.toContain('较早的需求');expect(JSON.stringify(local.requests[0])).not.toContain('较早的答复');expect(local.requests[0].tools.length).toBeGreaterThan(0);await expect(page.locator('#branch-origin')).toContainText('仅此消息');await expect(page.locator('[data-action=branch-message]').first()).toBeDisabled();await expect(readFile(join(local.workspacePath,'branch-result.txt'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
  await page.locator('#approval-list [data-action=approve]').click();await complete(page);expect(await readFile(join(local.workspacePath,'branch-result.txt'),'utf8')).toBe('新分支的独立写入');expect(local.read().approvals).toEqual([]);expect(local.read(session.id).approvals).toHaveLength(1);await capture(page,info,'conversation-branch-task-desktop.png');
  local.mutate(store=>store.deleteSession(local.sourceId));await syncState(page);await expect(page.locator('#branch-origin')).toContainText('原项目讨论');await expect(page.locator('#branch-origin button')).toHaveCount(0);await page.reload();await expect(page.locator('#branch-origin')).toContainText('仅此消息');
});

test('conversation branch: changed sources require a fresh preview without discarding edited text and active sources stay unavailable',async({page,local})=>{
  await ready(page,local);const captured=deferred(),release=deferred();await page.route('**/branch-preview?*',async route=>{const response=await route.fetch();captured.resolve();await release.promise;await route.fulfill({response});});
  try{await editButton(page,local).click();await captured.promise;await page.locator('#field-branchContent').fill('首次预览返回之前输入的编辑');await expect(page.locator('#dialog-submit')).toBeDisabled();release.resolve();await expect(page.locator('#dialog-submit')).toBeEnabled();await expect(page.locator('#field-branchContent')).toHaveValue('首次预览返回之前输入的编辑');}finally{release.resolve();await page.unroute('**/branch-preview?*');}
  local.mutate(store=>{const source=store.getSession(local.sourceId);source.messages[0].content='此前需求已被修正';store.putSession(source);});
  const rejected=await runBranch(page,'保留我刚编辑的版本');expect(rejected.status()).toBe(409);expect((await rejected.json()).error.code).toBe('BRANCH_SOURCE_CHANGED');await expect(page.locator('#field-branchContent')).toHaveValue('保留我刚编辑的版本');await expect(page.locator('#dialog-submit')).toBeDisabled();expect(local.requests).toHaveLength(0);
  await page.getByRole('button',{name:'重新预览原消息',exact:true}).click();await expect(page.locator('#dialog-submit')).toBeEnabled();await expect(page.locator('#field-branchContent')).toHaveValue('保留我刚编辑的版本');
  // The source is already completed. Wait for this POST and the new task identity
  // before checking completion, so the old status cannot satisfy the assertion.
  const accepted=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/branches'));await page.locator('#dialog-submit').click();const createdResponse=await accepted;expect(createdResponse.status()).toBe(201);const {session:created}=await createdResponse.json();expect(created.id).not.toBe(local.sourceId);await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('openaster.current-session'))).toBe(created.id);await complete(page);expect(JSON.stringify(local.requests[0])).toContain('此前需求已被修正');
  await openTask(page,local.sourceId);local.mutate(store=>{const source=store.getSession(local.sourceId);source.run.status='awaiting_approval';store.putSession(source);});await syncState(page);await expect(editButton(page,local)).toBeDisabled();expect(await editButton(page,local).getAttribute('title')).toContain('任务结束后');
});

test('conversation branch: late preview or creation never changes later navigation, drafts, capabilities or workspace',async({page,local})=>{
  test.setTimeout(70000);await ready(page,local);let supported=true;await page.route('**/api/state',async route=>{const response=await route.fetch(),body=await response.json();if(!supported)delete body.capabilities.conversationBranch;await route.fulfill({response,json:body});});
  const previewCaptured=deferred(),previewRelease=deferred();await page.route('**/branch-preview?*',async route=>{const response=await route.fetch();previewCaptured.resolve();await previewRelease.promise;await route.fulfill({response});});
  try{await editButton(page,local).click();await previewCaptured.promise;await page.keyboard.press('Escape');await openTask(page,local.otherId);await page.locator('#prompt-input').fill('切换后输入');const result=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/branch-preview'));previewRelease.resolve();await settle(page,await result);await expect(page.locator('#app-dialog')).not.toBeVisible();await expect(page.locator('#chat-title')).toHaveText('另一个已有任务');await expect(page.locator('#prompt-input')).toHaveValue('切换后输入');}finally{previewRelease.resolve();await page.unroute('**/branch-preview?*');}
  await openTask(page,local.sourceId);await editor(page,local);supported=false;await syncState(page);await expect(page.locator('#dialog-submit')).toBeDisabled();await expect(page.locator('#dialog-body')).toContainText('不支持编辑分支');await page.locator('#dialog-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(local.requests).toHaveLength(0);supported=true;await syncState(page);await expect(page.locator('#dialog-submit')).toBeEnabled();
  const postCaptured=deferred(),postRelease=deferred();await page.route('**/branches',async route=>{const response=await route.fetch();postCaptured.resolve(await response.json());await postRelease.promise;await route.fulfill({response});});
  try{await page.locator('#field-branchContent').fill('稍后返回的分支');await page.locator('#dialog-submit').click();const created=await postCaptured.promise;await page.keyboard.press('Escape');await openTask(page,local.otherId);await page.locator('#prompt-input').fill('创建等待期间的新草稿');const result=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/branches'));postRelease.resolve();await settle(page,await result);await expect(page.locator('#chat-title')).toHaveText('另一个已有任务');await expect(page.locator('#prompt-input')).toHaveValue('创建等待期间的新草稿');await expect(page.locator(`.session-link[data-id="${created.session.id}"]`)).toBeVisible();}finally{postRelease.resolve();await page.unroute('**/branches');}
  // Capability and creation interception has finished. Drain it before the
  // intentional service gap so transport failures reach the app, not an obsolete
  // fixture route.fetch callback. The final delayed preview remains intercepted.
  await page.unrouteAll({behavior:'wait'});
  await openTask(page,local.sourceId);const workspaceCaptured=deferred(),workspaceRelease=deferred();await page.route('**/branch-preview?*',async route=>{const response=await route.fetch();workspaceCaptured.resolve();await workspaceRelease.promise;await route.fulfill({response});});
  try{await editButton(page,local).click();await workspaceCaptured.promise;await local.switchWorkspace();await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('#workspace-label')).toHaveText('新的分支工作区');const result=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/branch-preview'));workspaceRelease.resolve();await settle(page,await result);await expect(page.locator('#app-dialog')).not.toBeVisible();await expect(page.locator('#prompt-input')).toHaveValue('');await expect(page.locator('#messages')).toBeEmpty();expect(local.requests).toHaveLength(1);}finally{workspaceRelease.resolve();await page.unrouteAll({behavior:'wait'});}
});

test('conversation branch: an uncertain response cannot automatically repeat a successfully created model run',async({page,local})=>{
  await ready(page,local);await page.locator('#prompt-input').fill('不应被清空');await editor(page,local);let posts=0;await page.route('**/branches',async route=>{posts++;await route.fetch();await route.abort('failed');});
  await page.locator('#field-branchContent').fill('网络结果不确定的分支');await page.locator('#dialog-submit').click();await expect(page.locator('.branch-preview-status')).toContainText('无法确认是否已创建分支');await expect(page.locator('#dialog-submit')).toBeDisabled();await expect(page.getByRole('button',{name:'重新预览原消息',exact:true})).toBeDisabled();await page.locator('#dialog-form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await page.locator('#field-branchContent').press('Control+Enter');
  await page.getByRole('button',{name:'刷新任务列表',exact:true}).click();await expect(page.locator('.branch-preview-status')).toContainText('任务列表已刷新');await expect(page.locator('#dialog-submit')).toBeDisabled();await page.keyboard.press('Escape');await expect(page.locator('#prompt-input')).toHaveValue('不应被清空');expect(posts).toBe(1);expect(local.requests).toHaveLength(1);expect(local.mutate(store=>store.listSessionSummaries())).toHaveLength(3);
});

test('conversation branch: mobile light and dark edit confirmation stays keyboard accessible and renders source text inertly',async({page,local},info)=>{
  await page.setViewportSize({width:390,height:844});await ready(page,local);await editor(page,local);await expect(page.locator('#field-branchContent')).toBeFocused();await expect(page.locator('#dialog-body script,#dialog-body img')).toHaveCount(0);await page.locator('#field-branchMode').selectOption('message');await page.locator('#field-branchMode').focus();await syncState(page);await expect(page.locator('#field-branchMode')).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await audit(page,info,'conversation-branch-mobile-light');await capture(page,info,'conversation-branch-mobile-light.png');await page.keyboard.press('Escape');await expect(editButton(page,local)).toBeFocused();await page.locator('.mobile-menu').click();await page.locator('[data-action=theme]').click();await page.keyboard.press('Escape');await editor(page,local);await audit(page,info,'conversation-branch-mobile-dark');await capture(page,info,'conversation-branch-mobile-dark.png');expect(await page.evaluate(()=>globalThis.__branchXss)).toBeUndefined();expect(local.requests).toHaveLength(0);
});


test.describe('branch readiness: full-history refresh',()=>{
  // These cases gate actual HTTP responses; keep Service Worker routing out of
  // the request interception fixture without changing application behavior.
  test.use({serviceWorkers:'block'});

  async function holdHistory(page,sessionId){
    const pattern='**/api/sessions/'+sessionId,captured=deferred(),release=deferred();
    let claimed=false,pending=null;
    const handler=route=>{
      if(claimed)return route.continue();
      claimed=true;
      pending=(async()=>{
        const response=await route.fetch();
        expect(response.status()).toBe(200);
        captured.resolve();
        await release.promise;
        await route.fulfill({response});
      })();
      return pending;
    };
    await page.route(pattern,handler);
    return {captured:captured.promise,async finish(){
      release.resolve();
      if(pending)await pending;
      await page.unroute(pattern,handler);
      await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
    }};
  }
  async function refreshWhileHeld(page,held){
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await held.captured;
  }

  test('message actions pause during a real history read and an old response cannot replace later navigation',async({page,local})=>{
    await ready(page,local);
    await expect(editButton(page,local)).toBeEnabled();
    await page.locator('#prompt-input').fill('原任务的草稿保持不变');
    await expect(page.locator('#composer-draft-label')).toHaveText('草稿已保存');
    const original=local.read(),previews=[],posts=[];
    page.on('request',request=>{
      const path=new URL(request.url()).pathname;
      if(path.endsWith('/branch-preview'))previews.push(path);
      if(request.method()==='POST'&&path.endsWith('/branches'))posts.push(request.postDataJSON());
    });
    const held=await holdHistory(page,local.sourceId);
    try{
      await refreshWhileHeld(page,held);
      await expect(editButton(page,local)).toBeDisabled();
      await expect(editButton(page,local)).toHaveAttribute('title','任务历史尚未加载完成。');
      await editButton(page,local).evaluate(button=>button.click());
      expect(previews).toEqual([]);expect(posts).toEqual([]);
      await expect(page.locator('#app-dialog')).not.toBeVisible();
      await expect(page.locator('#prompt-input')).toHaveValue('原任务的草稿保持不变');
    }finally{await held.finish();}
    await expect(editButton(page,local)).toBeEnabled();
    await editor(page,local);
    await expect(page.locator('#app-dialog')).toBeVisible();
    expect(previews).toHaveLength(1);expect(local.requests).toHaveLength(0);
    await page.keyboard.press('Escape');

    const late=await holdHistory(page,local.sourceId);
    try{
      await refreshWhileHeld(page,late);
      await expect(editButton(page,local)).toBeDisabled();
      await openTask(page,local.otherId);
      await expect(page.locator('#messages [data-history-state="true"]')).toBeVisible();
      await page.locator('#prompt-input').fill('另一个任务的独立草稿');
      await late.finish();
      await expect(page.locator('#chat-title')).toHaveText('另一个已有任务');
      await expect(page.locator('#messages [data-history-state="true"]')).toBeVisible();
      await expect(editButton(page,local)).toHaveCount(0);
      await expect(page.locator('#prompt-input')).toHaveValue('另一个任务的独立草稿');
      await expect(page.locator('#app-dialog')).not.toBeVisible();
    }finally{await late.finish();}
    await openTask(page,local.sourceId);
    await expect(editButton(page,local)).toBeEnabled();
    await expect(page.locator('#prompt-input')).toHaveValue('原任务的草稿保持不变');
    await editor(page,local);
    await expect(page.locator('#app-dialog')).toBeVisible();
    const response=await runBranch(page,'历史就绪后明确创建一次分支');
    expect(response.status()).toBe(201);await complete(page);
    expect(posts).toHaveLength(1);expect(local.requests).toHaveLength(1);
    expect(local.read()).toEqual(original);
  });

  test('an open edited confirmation pauses submission without losing focus or selection until history is ready',async({page,local})=>{
    await ready(page,local);
    await expect(editButton(page,local)).toBeEnabled();
    await editor(page,local);
    await expect(page.locator('#app-dialog')).toBeVisible();
    const content=page.locator('#field-branchContent'),text='完整历史读取期间保留这份编辑';
    await content.fill(text);
    await page.locator('#field-branchMode').selectOption('message');
    await content.focus();
    await content.evaluate(input=>input.setSelectionRange(2,7));
    const posts=[];page.on('request',request=>{
      if(request.method()==='POST'&&new URL(request.url()).pathname.endsWith('/branches'))posts.push(request.postDataJSON());
    });
    const held=await holdHistory(page,local.sourceId);
    try{
      await refreshWhileHeld(page,held);
      await expect(page.locator('#dialog-submit')).toBeDisabled();
      await expect(page.locator('.branch-preview-status')).toContainText('预览已就绪');
      await expect(page.locator('#dialog-body')).toContainText('任务历史尚未加载完成');
      await expect(content).toBeFocused();await expect(content).toBeEnabled();await expect(content).toHaveValue(text);
      await expect(page.locator('#field-branchProvider')).toHaveValue(local.ids.current);
      expect(await content.evaluate(input=>[input.selectionStart,input.selectionEnd])).toEqual([2,7]);
      await expect(page.locator('#field-branchMode')).toHaveValue('message');
      await content.press('Control+Enter');
      await page.locator('#dialog-form').evaluate(form=>form.requestSubmit());
      expect(posts).toEqual([]);expect(local.requests).toHaveLength(0);
      await expect(content).toHaveValue(text);
    }finally{await held.finish();}
    await expect(page.locator('#dialog-submit')).toBeEnabled();
    await expect(content).toBeFocused();await expect(content).toBeEnabled();await expect(content).toHaveValue(text);
    await expect(page.locator('#field-branchProvider')).toHaveValue(local.ids.current);
    expect(await content.evaluate(input=>[input.selectionStart,input.selectionEnd])).toEqual([2,7]);
    await expect(page.locator('#field-branchMode')).toHaveValue('message');
    const response=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/branches'));
    await page.locator('#dialog-submit').click();expect((await response).status()).toBe(201);
    await complete(page);expect(posts).toHaveLength(1);expect(posts[0]).toMatchObject({mode:'message',content:text});
    expect(local.requests).toHaveLength(1);
  });
});
