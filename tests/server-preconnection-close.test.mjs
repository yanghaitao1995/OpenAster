// SPDX-License-Identifier: Apache-2.0
// Real loopback sockets and filesystem gates. No Electron/menu/relaunch claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { startServer } from '../server/index.mjs';
import { acquireDataLock } from '../server/lock.mjs';

const turn=()=>new Promise(done=>setImmediate(done));
const key=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
async function within(promise,ms=5000){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Expected owned socket or filesystem lifecycle event did not arrive')),ms);})]);}
  finally{clearTimeout(timer);}
}
async function fixture(t){
  const parent=await fs.realpath(tmpdir()),root=await fs.mkdtemp(path.join(parent,'openaster-preconnection-'));
  const owner=randomUUID(),identity=await fs.lstat(root,{bigint:true});await fs.writeFile(path.join(root,'.owner'),owner,{flag:'wx'});
  const dataDir=path.join(root,'data'),workspace=path.join(root,'workspace');await fs.mkdir(workspace);await fs.writeFile(path.join(workspace,'note.txt'),'actual file content');
  const clients=new Set(),agents=new Set(),gates=[],observers=[];let app,originalOpen;
  t.after(async()=>{
    for(const gate of gates)gate.release.resolve();for(const client of clients)client.destroy();for(const agent of agents)agent.destroy();
    try{await within(app?.close(),15000);}
    finally{if(originalOpen){fs.opendir=originalOpen;syncBuiltinESMExports();}for(const observer of observers)app?.server.removeListener('request',observer);}
    const current=await fs.lstat(root,{bigint:true});assert.equal(await fs.realpath(root),root);assert.equal(path.dirname(root),parent);
    assert.match(path.basename(root),/^openaster-preconnection-[A-Za-z0-9]+$/u);assert.equal(current.isSymbolicLink(),false);assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);assert.equal(await fs.readFile(path.join(root,'.owner'),'utf8'),owner);
    await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  app=await startServer({port:0,dataDir,workspace,workspaceOptions:{createRoot:false}});
  assert.equal(app.server.listenerCount('request'),1,'The server keeps exactly one request listener for smoke-readiness wrapping');
  const tracked=client=>{clients.add(client);client.on('error',()=>{});client.once('close',()=>clients.delete(client));return client;};
  let headers={};
  function request(endpoint,{method='GET',body,agent=false,partial=false}={}){
    const settled=deferred(),finished=deferred(),payload=body===undefined?undefined:JSON.stringify(body);
    const client=tracked(http.request(app.url+endpoint,{method,agent,headers:{...headers,Connection:agent?'keep-alive':'close',...(payload===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)})}}));
    client.once('error',error=>settled.resolve({transportError:error.code}));client.once('close',finished.resolve);
    client.once('response',response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.once('error',error=>settled.resolve({transportError:error.code}));response.once('end',()=>{
      try{settled.resolve({status:response.statusCode,headers:response.headers,data:JSON.parse(Buffer.concat(chunks).toString('utf8')),complete:response.complete});}
      catch{settled.resolve({malformed:true});}
    });});
    if(partial){assert.ok(payload.length>1);client.write(payload.slice(0,1));}
    else client.end(payload);
    return{client,result:settled.promise,closed:finished.promise,finishBody(){client.end(payload.slice(1));}};
  }
  const boot=await within(request('/api/bootstrap').result);assert.equal(boot.status,200);
  headers={cookie:boot.headers['set-cookie'][0].split(';')[0],'X-CSRF-Token':boot.data.csrfToken};
  await turn();
  async function bare(partialHeaders=false){
    const accepted=once(app.server,'connection'),client=tracked(net.createConnection({host:'127.0.0.1',port:new URL(app.url).port}));
    const closed=deferred();client.once('close',closed.resolve);client.resume();
    const [, [socket]]=await within(Promise.all([once(client,'connect'),accepted]));
    if(partialHeaders){
      const received=deferred(),payload=`GET /api/health HTTP/1.1\r\nHost: ${new URL(app.url).host}\r\n`;
      let bytes=0;const onData=chunk=>{bytes+=chunk.length;if(bytes>=Buffer.byteLength(payload)){socket.off('data',onData);received.resolve();}};
      socket.on('data',onData);client.write(payload);await within(received.promise);await turn();
    }
    return{client,socket,closed:closed.promise};
  }
  function nextRequest(endpoint){
    const entered=deferred(),observer=(req,res)=>{if(req.url===endpoint){app.server.off('request',observer);entered.resolve({req,res});}};
    observers.push(observer);app.server.on('request',observer);return entered.promise;
  }
  async function stream(){
    const ready=deferred(),ended=deferred();let text='',aborted=false;
    const client=tracked(http.get(app.url+'/api/events',{agent:false,headers}));
    client.once('error',()=>ready.resolve(null));
    client.once('response',response=>{
      response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;if(text.includes('\n\n'))ready.resolve(response);});
      response.once('aborted',()=>{aborted=true;});response.once('error',()=>ended.resolve(false));response.once('end',()=>ended.resolve(response.complete));
    });
    const response=await within(ready.promise);assert.equal(response?.statusCode,200);assert.match(text,/event: state/);await turn();
    return{client,response,ended:ended.promise,get aborted(){return aborted;}};
  }
  function holdDirectory(){
    assert.equal(originalOpen,undefined);originalOpen=fs.opendir;
    const gate={entered:deferred(),release:deferred(),finished:deferred(),active:0,taken:false};gates.push(gate);
    fs.opendir=async function(target,...args){
      if(typeof target!=='string'||key(target)!==key(workspace)||gate.taken)return originalOpen.call(this,target,...args);
      gate.taken=true;gate.active++;gate.entered.resolve();
      try{await gate.release.promise;return await originalOpen.call(this,target,...args);}
      finally{gate.active--;gate.finished.resolve();}
    };
    syncBuiltinESMExports();return gate;
  }
  function agent(){const value=new http.Agent({keepAlive:true,maxSockets:1});agents.add(value);return value;}
  return{app,dataDir,request,bare,nextRequest,stream,holdDirectory,agent};
}

for(const partialHeaders of [false,true])test(`idle server close releases an accepted ${partialHeaders?'partial HTTP header':'bare TCP preconnection'} without waiting for header timeout`,{timeout:15000},async t=>{
  const f=await fixture(t);let requests=0;const observed=()=>requests++;f.app.server.on('request',observed);t.after(()=>f.app.server.off('request',observed));
  const pending=await f.bare(partialHeaders);assert.equal(requests,0);assert.equal(pending.client.destroyed,false);
  await within(f.app.close({ifIdle:true}));await within(pending.closed);
  assert.equal(requests,0);assert.equal(f.app.server.listening,false);assert.equal(pending.client.destroyed,true);
  const release=await acquireDataLock(f.dataDir);await release();
});

test('idle close preserves complete keep-alive HTTP responses and ends an established SSE stream normally',{timeout:15000},async t=>{
  const f=await fixture(t),agent=f.agent(),stream=await f.stream();
  let free=once(agent,'free');const first=f.request('/api/health',{agent});const firstResult=await within(first.result);await within(free);
  free=once(agent,'free');const second=f.request('/api/health',{agent});const secondResult=await within(second.result);await within(free);
  assert.equal(first.client.socket,second.client.socket,'Completed HTTP requests reuse the same live connection');
  for(const result of [firstResult,secondResult]){assert.equal(result.status,200);assert.equal(result.complete,true);assert.equal(result.data.ok,true);}
  const pending=await f.bare();await within(f.app.close({ifIdle:true}));await within(pending.closed);
  assert.equal(await within(stream.ended),true);assert.equal(stream.aborted,false);
  assert.equal(f.app.server.listenerCount('request'),1);assert.equal(f.app.server.listening,false);
});

test('idle refusal during a real incomplete request body keeps all connections usable and accepts the remaining body',{timeout:15000},async t=>{
  const f=await fixture(t),pending=await f.bare(true),stream=await f.stream(),entered=f.nextRequest('/api/sessions');
  const writing=f.request('/api/sessions',{method:'POST',body:{title:'body gate task',providerId:'demo'},partial:true});await within(entered);
  await assert.rejects(f.app.close({ifIdle:true}),{code:'WORKSPACE_BUSY',status:409});
  assert.equal(f.app.server.listening,true);assert.equal(pending.client.destroyed,false);assert.equal(pending.socket.destroyed,false);assert.equal(stream.response.destroyed,false);assert.equal(writing.client.socket.destroyed,false);
  await assert.rejects(acquireDataLock(f.dataDir),{code:'DATA_LOCKED'});
  const health=await within(f.request('/api/health').result);assert.equal(health.status,200);assert.equal(health.complete,true);
  writing.finishBody();const result=await within(writing.result);assert.equal(result.status,201);assert.equal(result.complete,true);assert.equal(result.data.session.title,'body gate task');
  await within(f.app.close({ifIdle:true}));await within(pending.closed);assert.equal(await within(stream.ended),true);assert.equal(stream.aborted,false);
});

test('idle refusal during actual filesystem work does not close preconnections or corrupt the eventual HTTP result',{timeout:15000},async t=>{
  const f=await fixture(t),pending=await f.bare(),stream=await f.stream(),gate=f.holdDirectory(),reading=f.request('/api/workspace');
  await within(gate.entered.promise);assert.equal(gate.active,1);
  await assert.rejects(f.app.close({ifIdle:true}),{code:'WORKSPACE_BUSY',status:409});
  assert.equal(f.app.server.listening,true);assert.equal(pending.socket.destroyed,false);assert.equal(stream.response.destroyed,false);assert.equal(reading.client.socket.destroyed,false);
  await assert.rejects(acquireDataLock(f.dataDir),{code:'DATA_LOCKED'});assert.equal((await within(f.request('/api/health').result)).status,200);
  gate.release.resolve();const result=await within(reading.result);await within(gate.finished.promise);assert.equal(result.status,200);assert.equal(result.complete,true);assert.ok(result.data.files.some(file=>file.path==='note.txt'));
  await within(f.app.close({ifIdle:true}));await within(pending.closed);assert.equal(await within(stream.ended),true);assert.equal(stream.aborted,false);
});

test('forced close drains actual filesystem work before removing preconnections and releasing the data lock',{timeout:15000},async t=>{
  const f=await fixture(t),early=await f.bare(),gate=f.holdDirectory(),reading=f.request('/api/workspace');await within(gate.entered.promise);
  let completed=false;const closing=f.app.close().then(()=>{completed=true;});await turn();
  assert.equal(completed,false);assert.equal(gate.active,1);assert.equal(early.client.destroyed,false);assert.equal(early.socket.destroyed,false);assert.equal(f.app.server.listening,true);
  await assert.rejects(acquireDataLock(f.dataDir),{code:'DATA_LOCKED'});
  // Accepted during the work-drain phase: it must not be removed prematurely,
  // but it must be included once the later transport shutdown starts.
  const late=await f.bare(true);assert.equal(late.socket.destroyed,false);
  const rejected=await within(f.request('/api/health').result);assert.equal(rejected.status,503);assert.equal(rejected.complete,true);assert.equal(rejected.data.error.code,'SHUTTING_DOWN');
  assert.equal(completed,false);assert.equal(early.socket.destroyed,false);assert.equal(late.socket.destroyed,false);assert.equal(reading.client.socket.destroyed,false);
  gate.release.resolve();const result=await within(reading.result);assert.equal(result.status,503);assert.equal(result.complete,true);assert.equal(result.data.error.code,'SHUTTING_DOWN');
  await within(closing);await within(Promise.all([early.closed,late.closed,gate.finished.promise]));assert.equal(gate.active,0);assert.equal(f.app.server.listening,false);
  const release=await acquireDataLock(f.dataDir);await release();assert.equal(f.app.server.listenerCount('request'),1);
});
