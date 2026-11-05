// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { CoreError } from '../core/errors.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await delay(10); }
  throw new Error('Capability test timed out');
}
const usage = {inputTokens:10,outputTokens:2,totalTokens:12,cachedInputTokens:null,cacheWriteInputTokens:null,reasoningOutputTokens:null};
const answer = (content, toolCalls = []) => ({ content, toolCalls, usage });
const tool = (name, args) => ({ id:'unexpected-tool', name, args });
async function fixture(t, options) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent,'openaster-capability-'));
  const workspacePath = path.join(root,'workspace');
  await fs.mkdir(workspacePath);
  await fs.writeFile(path.join(workspacePath,'source.txt'),'PRIVATE_WORKSPACE_TEXT');
  const store = new Store(root);
  store.putProvider({id:'model',type:'openai',name:'Fixture',model:'fixture',baseUrl:'https://fixture.invalid/v1',enabled:true,...options.provider});
  const session = store.createSession({providerId:'model'});
  const workspace = createWorkspace(workspacePath);
  const touches = [];
  const tracked = Object.fromEntries(Object.entries(workspace).map(([key, value]) => [key, typeof value === 'function' ? (...args) => { touches.push(key); return value(...args); } : value]));
  const runtime = createRuntime({workspace:tracked,providers:async id=>store.getProvider(id),getSession:async id=>store.getSession(id),saveSession:async (value,metadata)=>store.putSession(value,metadata),audit:entry=>store.audit(entry),providerCall:options.providerCall,limits:{maxRunMs:5000,streamCheckpointMs:5}});
  t.after(async()=>{
    await runtime.shutdown();store.close();
    const resolved=await fs.realpath(root);
    assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^openaster-capability-[A-Za-z0-9]+$/);
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  return {runtime,store,touches,workspacePath,get:()=>store.getSession(session.id),start:(content,extra={})=>runtime.start(session.id,{content,...extra}),done:()=>until(()=>!runtime.isActive(session.id)),pending:()=>until(()=>store.getSession(session.id).approvals.some(a=>a.status==='pending'))};
}

test('conversation-only supports streaming, subsequent turns and usage without touching workspace',async t=>{
  const requests=[];
  const f=await fixture(t,{provider:{toolMode:'none'},providerCall:async(_provider,request)=>{
    requests.push(structuredClone({tools:request.tools,system:request.system,messages:request.messages}));
    await request.onText('基于对话回答');return answer('基于对话回答');
  }});
  await f.start('解释递归');await f.done();await f.start('再给一个例子');await f.done();
  assert.equal(requests.length,2);assert.deepEqual(requests[0].tools,[]);assert.deepEqual(requests[1].tools,[]);
  assert.match(requests[0].system,/conversation only/);assert.doesNotMatch(JSON.stringify(requests),/PRIVATE_WORKSPACE_TEXT/);
  assert.deepEqual(requests[1].messages.map(x=>x.role),['user','assistant','user']);
  assert.equal(f.get().run.status,'completed');assert.equal(f.get().messages.length,4);
  assert.deepEqual(f.get().run.steps[0].usage,usage);assert.deepEqual(f.touches,[]);
});

for (const [name,args] of [['list_workspace',{}],['read_file',{path:'source.txt'}],['search_files',{query:'PRIVATE'}],['write_file',{path:'source.txt',content:'REPLACED'}],['edit_file',{path:'source.txt',oldText:'PRIVATE',newText:'REPLACED',expectedHash:'0'.repeat(64)}],['run_command',{command:'echo forbidden'}]]) {
  test(`conversation-only refuses unsolicited ${name} before tool execution or approval`,async t=>{
    let requests=0;
    const f=await fixture(t,{provider:{toolMode:'none',streaming:false},providerCall:async(provider,request)=>{
      requests++;assert.deepEqual(request.tools,[]);assert.equal(provider.streaming,false);assert.equal(typeof request.onText,'function');
      // Even an injected adapter cannot widen the already captured run scope.
      provider.toolMode='workspace';return answer('',[tool(name,args)]);
    }});
    await f.start('请检查文件',{skillPrompt:'Use workspace tools to complete this task.'});await f.done();
    assert.equal(requests,1);assert.equal(f.get().run.status,'failed');assert.equal(f.get().run.error.code,'TOOLS_DISABLED');
    assert.deepEqual(f.touches,[]);assert.equal(f.get().approvals.length,0);assert.equal(f.get().run.steps.length,1);
    assert.equal(f.get().run.steps[0].status,'failed');assert.deepEqual(f.get().run.steps[0].usage,usage);
    assert.equal(f.get().messages.length,1);assert.equal(await fs.readFile(path.join(f.workspacePath,'source.txt'),'utf8'),'PRIVATE_WORKSPACE_TEXT');
  });
}

test('legacy workspace mode still exposes tools and requires exact write approval',async t=>{
  let requests=0;
  const f=await fixture(t,{provider:{},providerCall:async(_provider,request)=>{
    requests++;assert.deepEqual(request.tools.map(tool => tool.name).sort(),['edit_file','list_workspace','load_skill','read_file','read_skill_resource','read_tool_result','run_command','search_files','write_file']);
    return requests===1?answer('',[tool('write_file',{path:'result.txt',content:'APPROVED'})]):answer('文件已保存');
  }});
  await f.start('创建结果');await f.pending();
  assert.equal(f.get().run.status,'awaiting_approval');assert.equal(f.get().approvals[0].preview.after,'APPROVED');
  await assert.rejects(fs.stat(path.join(f.workspacePath,'result.txt')),{code:'ENOENT'});
  await f.runtime.decide(f.get().approvals[0].id,'approve');await f.done();
  assert.equal(f.get().run.status,'completed');assert.equal(await fs.readFile(path.join(f.workspacePath,'result.txt'),'utf8'),'APPROVED');
});

test('conversation-only cancellation retains partial text and never accesses workspace',async t=>{
  let started=false;
  const f=await fixture(t,{provider:{toolMode:'none'},providerCall:async(_provider,{onText,signal})=>{
    await onText('尚未完成');started=true;
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    throw new CoreError('CANCELLED','已取消',409);
  }});
  await f.start('开始回答');await until(()=>started);f.runtime.cancel(f.get().id);await f.done();
  assert.equal(f.get().run.status,'cancelled');assert.equal(f.get().run.output.content,'尚未完成');
  assert.equal(f.get().run.output.status,'interrupted');assert.equal(f.get().messages.length,1);assert.deepEqual(f.touches,[]);
});
