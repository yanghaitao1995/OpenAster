import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { CoreError } from '../core/errors.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) { for (let n=0;n<500;n++) { if (await predicate()) return; await delay(10); } throw new Error('Stream test timed out'); }
const reply = content => ({ content, toolCalls: [] });

async function fixture(t, { providerCall, save, audit, streaming=true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'openaster-stream-'));
  const sessions = new Map([['s1', { id:'s1', title:'新任务', messages:[], approvals:[] }]]);
  const events = [];
  const runtime = createRuntime({
    workspace: createWorkspace(directory),
    providers: async () => ({ id:'p1', type:'openai', model:'fixture', streaming, baseUrl:'https://example.test/v1' }),
    getSession: async id => structuredClone(sessions.get(id)),
    saveSession: async session => { await save?.(session); sessions.set(session.id, structuredClone(session)); },
    emit: event => events.push(event), providerCall, audit,
    limits: { streamCheckpointMs:20, providerRetryBaseMs:1, providerRetryMaxMs:1 }
  });
  t.after(async () => { await runtime.shutdown(); assert.equal(path.dirname(directory), tmpdir()); await rm(directory,{recursive:true,force:true}); });
  return { runtime, sessions, events, done:()=>until(()=>!runtime.isActive('s1')) };
}

test('stream checkpoints expose partial text before completion and coalesce token writes', async t => {
  const finish=gate(); t.after(()=>finish.resolve());
  const f=await fixture(t,{providerCall:async(_p,{onText,signal})=>{
    await onText('中文🙂');
    for(let n=0;n<100;n++)await onText('片');
    await Promise.race([finish.promise,new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))]);
    return reply('中文🙂'+'片'.repeat(100));
  }});
  await f.runtime.start('s1',{content:'开始'});
  await until(()=>f.sessions.get('s1').run?.output?.content.endsWith('片'.repeat(100)));
  assert.equal(f.sessions.get('s1').run.status,'running');
  assert.equal(f.sessions.get('s1').messages.length,1);
  const events=f.events.filter(event=>event.type==='stream');
  assert.ok(events.length>=1&&events.length<=2,'coalesces 101 deltas instead of writing each token');
  assert.deepEqual(Object.keys(events[0]).sort(),['runId','sessionId','stepId','type']);
  finish.resolve();await f.done();
  assert.equal(f.sessions.get('s1').run.output,null);
  assert.equal(f.sessions.get('s1').messages.filter(message=>message.role==='assistant').length,1);
});

test('cancellation retains an explicitly interrupted draft and refuses late callbacks', async t => {
  let late;
  const f=await fixture(t,{providerCall:async(_p,{onText,signal})=>{
    late=onText;await onText('尚未完成的回答');
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    throw new CoreError('CANCELLED','cancelled',409);
  }});
  await f.runtime.start('s1',{content:'开始'});await until(()=>f.sessions.get('s1').run?.output);
  f.runtime.cancel('s1');await f.done();
  const saved=f.sessions.get('s1');
  assert.equal(saved.run.status,'cancelled');assert.equal(saved.run.output.status,'interrupted');
  assert.equal(saved.run.output.content,'尚未完成的回答');assert.equal(saved.messages.length,1);
  await assert.rejects(late('不能追加'),{code:'CANCELLED'});
  const count=f.events.length;await delay(50);assert.equal(f.events.length,count);
});

test('checkpoint failure aborts model work and cannot be reported as human cancellation', async t => {
  let aborted=false;
  const f=await fixture(t,{save:async session=>{if(session.run?.output?.status==='streaming')throw new Error('disk fixture failure');},providerCall:async(_p,{onText,signal})=>{
    await onText('部分输出');await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
    return {content:'不应执行',toolCalls:[{id:'write1',name:'write_file',args:{path:'forbidden.txt',content:'never'}}]};
  }});
  await f.runtime.start('s1',{content:'开始'});await f.done();
  assert.equal(aborted,true);assert.equal(f.sessions.get('s1').run.status,'failed');
  assert.equal(f.sessions.get('s1').run.output.status,'interrupted');
  assert.equal(f.sessions.get('s1').approvals.length,0);assert.equal(f.sessions.get('s1').messages.length,1);
});

test('terminal persistence waits for an in-flight checkpoint and snapshots stay immutable', async t => {
  const entered=gate(),release=gate(),finish=gate();t.after(()=>{release.resolve();finish.resolve();});
  let first=true,live=0,peak=0,checkpoint;
  const f=await fixture(t,{save:async session=>{
    live++;peak=Math.max(peak,live);
    try{if(first&&session.run?.output){first=false;checkpoint=session;entered.resolve();await release.promise;}}finally{live--;}
  },providerCall:async(_p,{onText})=>{await onText('前段');await entered.promise;await onText('后段');finish.resolve();return reply('前段后段');}});
  await f.runtime.start('s1',{content:'开始'});await finish.promise;
  assert.equal(checkpoint.run.output.content,'前段');assert.equal(f.runtime.isActive('s1'),true);
  release.resolve();await f.done();
  assert.equal(peak,1);assert.equal(f.sessions.get('s1').run.status,'completed');
  assert.equal(f.sessions.get('s1').messages.at(-1).content,'前段后段');assert.equal(f.sessions.get('s1').run.output,null);
});

test('failed partial output never enters subsequent model history or claims tool approval', async t => {
  let calls=0,history;
  const f=await fixture(t,{providerCall:async(_p,{onText,messages})=>{
    if(++calls===1){await onText('UNFINISHED_TOOL_PROPOSAL');throw new CoreError('MODEL_RESPONSE_INCOMPLETE','响应中断',502);}
    history=structuredClone(messages);return reply('新的完整回复');
  }});
  await f.runtime.start('s1',{content:'第一次'});await f.done();
  assert.equal(calls,2);assert.equal(f.sessions.get('s1').approvals.length,0);
  assert.equal(f.sessions.get('s1').run.steps[0].connection.retryCount,1);
  assert.ok(!JSON.stringify(history).includes('UNFINISHED_TOOL_PROPOSAL'));
  assert.equal(f.sessions.get('s1').run.output,null);assert.equal(f.sessions.get('s1').messages.at(-1).content,'新的完整回复');
});

test('stream content is bounded and compatibility mode retains a callback for complete or explicitly interrupted JSON', async t => {
  const f=await fixture(t,{providerCall:async(_p,{onText})=>{await onText('x'.repeat(256*1024+1));return reply('unreachable');}});
  await f.runtime.start('s1',{content:'开始'});await f.done();
  assert.equal(f.sessions.get('s1').run.status,'failed');assert.equal(f.sessions.get('s1').messages.length,1);
  const disabled=await fixture(t,{streaming:false,providerCall:async(provider,{onText})=>{assert.equal(provider.streaming,false);assert.equal(typeof onText,'function');await onText('完整响应');return reply('完整响应');}});
  await disabled.runtime.start('s1',{content:'开始'});await disabled.done();
  assert.equal(disabled.sessions.get('s1').messages.at(-1).content,'完整响应');
});

test('failure or cancellation during the completion audit cannot commit an assistant response', async t => {
  for(const cancel of [false,true]) {
    const entered=gate(),release=gate();t.after(()=>release.resolve());
    const f=await fixture(t,{providerCall:async(_p,{onText})=>{await onText('等待完成提交');return reply('等待完成提交');},audit:async entry=>{
      if(entry.action==='run.completed'){entered.resolve();await release.promise;if(!cancel)throw new Error('completion audit failed');}
    }});
    await f.runtime.start('s1',{content:'开始'});await entered.promise;
    if(cancel)f.runtime.cancel('s1');release.resolve();await f.done();
    const session=f.sessions.get('s1');
    assert.equal(session.run.status,cancel?'cancelled':'failed');assert.equal(session.run.output.status,'interrupted');
    assert.equal(session.messages.length,1);
  }
});
