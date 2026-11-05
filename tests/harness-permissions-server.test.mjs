// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.mjs';

async function fixture(t, options={}) {
  const root=await fs.mkdtemp(path.join(tmpdir(),'openaster-permissions-'));
  const outside=path.join(root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'note.txt'),'outside text');
  const app=await startServer({dataDir:path.join(root,'data'),...options});
  t.after(async()=>{await app.close();assert.equal(path.dirname(root),tmpdir());await fs.rm(root,{recursive:true,force:true});});
  const first=await fetch(app.url+'/api/bootstrap'),bootstrap=await first.json();
  const headers={cookie:first.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':bootstrap.csrfToken,'Content-Type':'application/json'};
  async function request(route,body,method=body===undefined?'GET':'POST',extra={}) {const response=await fetch(app.url+route,{method,headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};}
  return {root,outside,app,bootstrap,request};
}
async function until(action,check) {for(let i=0;i<150;i++){const value=await action();if(check(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Expected state did not arrive');}

test('file access grant requires authenticated explicit consent and records an audit event',async t=>{
  const f=await fixture(t);assert.equal(f.bootstrap.security.fileAccess,'workspace');
  assert.equal(f.bootstrap.security.fileAccessLifetime,'service-session');
  assert.equal((await f.request('/api/permissions',{fileAccess:'computer'},'PUT')).status,400);
  assert.equal((await f.request('/api/permissions',{fileAccess:'computer',confirmComputerAccess:true},'PUT',{'X-CSRF-Token':'wrong'})).status,403);
  const granted=await f.request('/api/permissions',{fileAccess:'computer',confirmComputerAccess:true},'PUT');
  assert.equal(granted.status,200);assert.equal(granted.data.fileAccess,'computer');
  assert.equal((await f.request('/api/state')).data.security.fileAccess,'computer');
  assert.equal((await f.request('/api/permissions',{fileAccess:'workspace'},'PUT')).status,200);
  assert.ok((await f.request('/api/audit')).data.entries.some(entry=>entry.action==='permissions.changed'));
});

test('global file tool writes use real human approval and remain available in durable history',async t=>{
  let round=0,external;
  const f=await fixture(t,{runtimeOptions:{providerCall:async(_provider,{messages})=>{
    round++;
    if(round===1)return {content:'先读取指定文件。',toolCalls:[{id:'read',name:'read_file',args:{path:external}}]};
    if(round===2){assert.match(messages.at(-1).content,/outside text/u);return {content:'准备写入。',toolCalls:[{id:'write',name:'write_file',args:{path:external,content:'approved outside'}}]};}
    return {content:'完成。',toolCalls:[]};
  }}});
  external=path.join(f.outside,'note.txt');
  await f.request('/api/permissions',{fileAccess:'computer',confirmComputerAccess:true},'PUT');
  const provider=(await f.request('/api/providers',{name:'Fixture',type:'openai',model:'fixture',baseUrl:'http://127.0.0.1:1/v1'})).data.provider;
  const session=(await f.request('/api/sessions',{providerId:provider.id})).data.session;
  const sent=await f.request(`/api/sessions/${session.id}/messages`,{content:'更新指定文本',providerId:provider.id});assert.equal(sent.status,202);
  const waiting=await until(()=>f.request(`/api/sessions/${session.id}`),value=>value.data.session.run?.status==='awaiting_approval');
  const approval=waiting.data.session.approvals.find(value=>value.status==='pending');assert.equal(approval.args.path,external);
  assert.equal(await fs.readFile(external,'utf8'),'outside text');
  assert.equal((await f.request('/api/permissions',{fileAccess:'workspace'},'PUT')).status,409);
  assert.equal((await f.request(`/api/approvals/${approval.id}`,{decision:'approve'})).status,200);
  const terminal=await until(()=>f.request(`/api/sessions/${session.id}`),value=>['completed','failed'].includes(value.data.session.run?.status));
  assert.equal(terminal.data.session.run.status,'completed',JSON.stringify(terminal.data.session.run.error));
  assert.equal(await fs.readFile(external,'utf8'),'approved outside');
  const history=await f.request(`/api/sessions/${session.id}/runs/${terminal.data.session.run.id}`);assert.equal(history.status,200);
  assert.equal(history.data.record.approvals[0].path,external);
});

test('visible desktop actions use empty bodies and execute after the HTTP response',async t=>{
  let opens=0,creates=0;
  const f=await fixture(t,{workspaceActions:{open:async()=>{opens++;},create:async()=>{creates++;}}});
  assert.equal(f.bootstrap.capabilities.workspaceActions,1);
  assert.equal((await f.request('/api/workspace/create',{path:'untrusted-client-path'})).status,400);
  assert.equal((await f.request('/api/workspace/open',{})).status,202);
  await until(async()=>opens,value=>value===1);
  assert.equal((await f.request('/api/workspace/create',{})).status,202);
  await until(async()=>creates,value=>value===1);
});

test('skill catalog contains no bodies and explicit preview reads only the selected guide',async t=>{
  const f=await fixture(t);
  assert.ok(f.bootstrap.skills.length>=6);
  assert.ok(f.bootstrap.skills.every(skill=>!Object.hasOwn(skill,'content')&&!Object.hasOwn(skill,'prompt')));
  assert.ok(f.bootstrap.workspace.skillsPath.endsWith('skills'));
  const preview=await f.request('/api/skills/code');assert.equal(preview.status,200);
  assert.equal(preview.data.skill.id,'code');assert.equal(preview.data.skill.untrusted,true);assert.match(preview.data.skill.content,/SKILL|代码|验证/u);
});
