
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createNativeLeaveGuard, createDeferredNativeQuit } from './native-leave.mjs';
import { createDesktopLifecycle } from './lifecycle.mjs';
const token='a'.repeat(32);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function renderer(handler) {
 const scripts=[];
 const window={isDestroyed:()=>false,webContents:{isDestroyed:()=>false,executeJavaScript(code){
  scripts.push(code);
  return Promise.resolve(vm.runInNewContext(code,{CustomEvent:class{constructor(type,options){this.type=type;Object.assign(this,options);}},document:{dispatchEvent:event=>handler(event)}}));
 }}};
 return {window,scripts,guard:createNativeLeaveGuard({getWindow:()=>window,timeoutMs:50,createToken:()=>token})};
}
function reply(event,allowed,reason=null){event.detail.result={allowed,reason,token:event.detail.token};}
test('resuming quit is deferred past the current Electron emission and deduplicates pending calls',()=>{
 const jobs=[],events=[];
 const resume=createDeferredNativeQuit(()=>events.push('quit'),callback=>jobs.push(callback));
 resume();resume();assert.deepEqual(events,[]);assert.equal(jobs.length,1);
 jobs.shift()();assert.deepEqual(events,['quit']);resume();assert.equal(jobs.length,1);
 jobs.shift()();assert.deepEqual(events,['quit','quit']);
});
test('native leave rejects dirty files, pending drafts and unknown renderer states without text transport', async()=>{
 for(const [reason,code] of [['pending','NATIVE_LEAVE_PENDING'],['drafts-pending','NATIVE_LEAVE_DRAFTS_PENDING'],['unknown','NATIVE_LEAVE_UNKNOWN']]){
  const f=renderer(event=>reply(event,event.type.endsWith('release'),event.type.endsWith('release')?null:reason));
  await assert.rejects(f.guard.acquire(),{code});
  assert.equal(f.scripts.length,2);
  for(const script of f.scripts)assert.ok(!/innerText|textContent|innerHTML|value|fetch|ipcRenderer/.test(script));
 }
});
test('native leave rejects absent, malformed, extra-field and foreign-token replies',async()=>{
 for(const value of [null,{allowed:true,reason:null,token:'b'.repeat(32)},{allowed:true,reason:'pending',token},{allowed:true,reason:null,token,content:'private'}]){
  const f=renderer(event=>{if(event.type.endsWith('release'))reply(event,true);else event.detail.result=value;});
  await assert.rejects(f.guard.acquire(),{code:'NATIVE_LEAVE_UNKNOWN'});
 }
});
test('a grant stays held until idempotent release and cannot release a later lease',async()=>{
 const f=renderer(event=>reply(event,true));
 const first=await f.guard.acquire();await assert.rejects(f.guard.acquire(),{code:'NATIVE_LEAVE_UNKNOWN'});
 const release=first.release();assert.equal(first.release(),release);assert.equal(await release,true);
 const second=await f.guard.acquire();const count=f.scripts.length;await first.release();assert.equal(f.scripts.length,count);
 await assert.rejects(f.guard.acquire(),{code:'NATIVE_LEAVE_UNKNOWN'});await second.release();
});
test('unresponsive check is bounded and queues an exact-token release',async()=>{
 const f=renderer(event=>reply(event,true));const original=f.window.webContents.executeJavaScript;let calls=0;
 f.window.webContents.executeJavaScript=code=>++calls===1?new Promise(()=>{}):original(code);
 await assert.rejects(f.guard.acquire(),{code:'NATIVE_LEAVE_UNKNOWN'});assert.equal(calls,2);
});
test('abort while renderer check is in flight releases its late lease and never grants',async()=>{
 const gate=deferred(),f=renderer(event=>reply(event,true)),original=f.window.webContents.executeJavaScript;let calls=0;
 f.window.webContents.executeJavaScript=code=>++calls===1?gate.promise.then(()=>original(code)):original(code);
 const controller=new AbortController(),pending=f.guard.acquire({signal:controller.signal});
 controller.abort();gate.resolve();await assert.rejects(pending,{code:'NATIVE_LEAVE_UNKNOWN'});assert.equal(calls,2);
});
test('missing/destroyed windows and pre-aborted requests fail closed',async()=>{
 for(const window of [null,{isDestroyed:()=>true}])await assert.rejects(createNativeLeaveGuard({getWindow:()=>window}).acquire(),{code:'NATIVE_LEAVE_UNKNOWN'});
 const f=renderer(()=>assert.fail());await assert.rejects(f.guard.acquire({signal:AbortSignal.abort()}),{code:'NATIVE_LEAVE_UNKNOWN'});assert.equal(f.scripts.length,0);
});
function life(overrides={}){
 const calls=[];const lifecycle=createDesktopLifecycle({closeService:async options=>calls.push(options?'idle-close':'close'),relaunch:()=>calls.push('relaunch'),quit:()=>calls.push('quit'),reportError:async error=>calls.push(error.code),...overrides});
 return{calls,lifecycle};
}
test('denied transition cannot stop service, change profile or schedule relaunch',async()=>{
 const f=life({prepareTransition:async()=>{throw Object.assign(new Error(),{code:'NATIVE_LEAVE_PENDING'});}});
 await f.lifecycle.run('switch',async context=>{await context.stopService();f.calls.push('activate');});
 assert.deepEqual(f.calls,['NATIVE_LEAVE_PENDING']);
});
test('busy shutdown releases the renderer lease, while a stopped service retains it',async()=>{
 let releases=0;const prepareTransition=async()=>({release:async()=>{releases++;}});
 const f=life({prepareTransition,closeService:async()=>{throw Object.assign(new Error(),{code:'WORKSPACE_BUSY'});}});
 await f.lifecycle.run('switch',context=>context.stopService());assert.equal(releases,1);assert.deepEqual(f.calls,['WORKSPACE_BUSY']);
 const g=life({prepareTransition});await g.lifecycle.run('switch',context=>context.stopService());assert.equal(releases,1);assert.deepEqual(g.calls,['idle-close','relaunch','quit']);
});
test('unconfirmed renderer release replaces busy retry with a fixed failure while the service remains open',async()=>{
 let closeCalls=0,reported;
 const f=life({prepareTransition:async()=>({release:async()=>false}),
  closeService:async()=>{closeCalls++;throw Object.assign(new Error('private storage location'),{code:'WORKSPACE_BUSY'});},
  reportError:async(error,options)=>{reported={error,options};}});
 assert.equal(await f.lifecycle.run('switch',async context=>{await context.stopService();assert.fail('must not change profile');}),false);
 assert.equal(closeCalls,1);assert.equal(reported.error.code,'NATIVE_LEAVE_RELEASE_FAILED');
 assert.equal(reported.options.restartRequired,false);assert.ok(!reported.error.message.includes('private storage location'));
 assert.deepEqual(f.calls,[]);
});
test('cancelled natural quit keeps service live and cannot revive an aborted picker',async()=>{
 const f=life(),gate=deferred(),entered=deferred();
 const operation=f.lifecycle.run('switch',async context=>{entered.resolve();await gate.promise;assert.equal(context.active,false);assert.equal(await context.stopService(),false);});
 await entered.promise;f.lifecycle.beginQuit();assert.equal(f.lifecycle.quitting,true);assert.deepEqual(f.calls,[]);
 assert.equal(f.lifecycle.cancelQuit(),true);assert.equal(f.lifecycle.quitting,false);gate.resolve();await operation;assert.deepEqual(f.calls,[]);
 await f.lifecycle.run('switch',()=>false);assert.deepEqual(f.calls,[]);
 await f.lifecycle.requestQuit();assert.deepEqual(f.calls,['close','quit']);assert.equal(f.lifecycle.cancelQuit(),false);
});
test('quit during a pending handshake releases it and waits for the actual operation',async()=>{
 const gate=deferred(),entered=deferred();let released=0;
 const f=life({prepareTransition:async()=>{entered.resolve();await gate.promise;return{release:async()=>{released++;}};}});
 const action=f.lifecycle.run('switch',async context=>{assert.equal(await context.stopService(),false);});
 await entered.promise;const quit=f.lifecycle.requestQuit();assert.deepEqual(f.calls,[]);gate.resolve();await Promise.all([action,quit]);
 assert.equal(released,1);assert.deepEqual(f.calls,['close','quit']);
});

function unknownCheck(kind, releaseAllowed) {
 const f=renderer(event=>reply(event,releaseAllowed,releaseAllowed?null:'unknown'));
 const original=f.window.webContents.executeJavaScript;let calls=0;
 f.window.webContents.executeJavaScript=code=>{
  if(++calls!==1)return original(code);
  if(kind==='reject')return Promise.reject(new Error('private renderer failure details'));
  if(kind==='timeout')return new Promise(()=>{});
  return Promise.resolve({allowed:true,reason:null,token,extra:'private renderer reply'});
 };
 return { ...f, get calls(){return calls;} };
}
test('explicit renderer denials keep their reason when release confirms no matching lease',async()=>{
 for(const [reason,code] of [['pending','NATIVE_LEAVE_PENDING'],['drafts-pending','NATIVE_LEAVE_DRAFTS_PENDING'],['unknown','NATIVE_LEAVE_UNKNOWN']]){
  const f=renderer(event=>reply(event,false,event.type.endsWith('release')?'unknown':reason));
  await assert.rejects(f.guard.acquire(),{code});
  assert.equal(f.scripts.length,2);
 }
});
test('unknown check outcomes require confirmed release before reporting a recoverable denial',async t=>{
 for(const kind of ['reject','timeout','invalid'])for(const releaseAllowed of [false,true]){
  await t.test(kind+' / release '+releaseAllowed,async()=>{
   const f=unknownCheck(kind,releaseAllowed);let observed;
   const g=life({prepareTransition:options=>f.guard.acquire(options),reportError:async(error,options)=>{observed={error,options};}});
   assert.equal(await g.lifecycle.run('switch',async context=>{await context.stopService();g.calls.push('activate');}),false);
   assert.deepEqual(g.calls,[],'failed acquisition must not stop service, activate a profile, relaunch or quit');
   assert.equal(f.calls,2);assert.equal(observed.options.restartRequired,false);
   assert.equal(observed.error.code,releaseAllowed?'NATIVE_LEAVE_UNKNOWN':'NATIVE_LEAVE_RELEASE_FAILED');
   if(!releaseAllowed){
    assert.equal(observed.error.cause?.code,'NATIVE_LEAVE_UNKNOWN');
    assert.equal(Object.getOwnPropertyDescriptor(observed.error,'cause').enumerable,false);
    assert.match(observed.error.message,/未确认.*解除离开锁定/);
   }
   assert.ok(!JSON.stringify(observed.error).includes('private'));
   assert.ok(!observed.error.message.includes('private'));
  });
 }
});
