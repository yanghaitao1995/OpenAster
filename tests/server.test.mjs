import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { startServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';

async function fixture(t, options={}) {
  const dir=await mkdtemp(join(tmpdir(),'openaster-server-'));
  const app=await startServer({dataDir:dir,...options});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  let cookie,csrfToken;
  async function request(path,{method='GET',data,headers={},auth=true}={}) {
    const response=await fetch(`${app.url}${path}`,{method,headers:{...(auth&&cookie?{cookie}:{}),...(auth&&csrfToken?{'X-CSRF-Token':csrfToken}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:data!==undefined?JSON.stringify(data):undefined});
    const result=await response.json();return {status:response.status,data:result,headers:response.headers};
  }
  const bootstrap=await request('/api/bootstrap');cookie=bootstrap.headers.get('set-cookie')?.split(';')[0];csrfToken=bootstrap.data.csrfToken;
  return {app,dir,request,bootstrap,cookie,csrfToken};
}
async function until(fn,predicate,timeout=5000) {const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await fn();if(predicate(value))return value;await new Promise(r=>setTimeout(r,20));}throw new Error('Timed out waiting for state');}

test('bootstrap authenticates with strict HttpOnly cookie and APIs do not expose secrets',async t=> {
  const f=await fixture(t);assert.equal(f.bootstrap.status,200);assert.match(f.bootstrap.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.equal(f.bootstrap.data.security.keyStorage,'memory-only');assert.equal(f.bootstrap.data.providers[0].type,'demo');
  assert.equal((await f.request('/api/state',{auth:false})).status,401);
  assert.equal((await f.request('/api/sessions',{method:'POST',data:{},auth:false})).status,401);
  assert.equal((await f.request('/api/sessions',{method:'POST',data:{},headers:{'X-CSRF-Token':'wrong'}})).status,403);
  assert.equal((await f.request('/api/sessions',{method:'POST',data:{},headers:{Origin:'https://attacker.invalid'}})).status,403);
  assert.equal((await f.request('/api/bootstrap',{headers:{'Sec-Fetch-Site':'cross-site'},auth:false})).status,403);
  const hostileHostStatus=await new Promise((resolve,reject)=>{http.get(`${f.app.url}/api/bootstrap`,{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(hostileHostStatus,403);
  assert.equal((await f.request('/api/state')).headers.get('cache-control'),'no-store');
});

test('session CRUD, input validation and durable persistence',async t=> {
  const f=await fixture(t);const created=await f.request('/api/sessions',{method:'POST',data:{title:'测试工作'}});assert.equal(created.status,201);const id=created.data.session.id;
  assert.equal((await f.request(`/api/sessions/${id}`,{method:'PATCH',data:{title:'已修改'}})).data.session.title,'已修改');
  assert.equal((await f.request('/api/sessions',{method:'POST',data:{title:' '}})).status,400);
  assert.equal((await f.request('/api/sessions',{method:'POST',data:{providerId:'missing'}})).status,400);
  assert.equal((await f.request(`/api/sessions/${id}/messages`,{method:'POST',data:{content:'x'.repeat(32001)}})).status,400);
  assert.equal((await f.request(`/api/sessions/${id}/messages`,{method:'POST',data:{content:'hello',skillId:'missing'}})).status,400);
  const db=new Store(f.dir);assert.equal(db.getSession(id).title,'已修改');db.close();
  assert.equal((await f.request(`/api/sessions/${id}`,{method:'DELETE'})).status,200);assert.equal((await f.request(`/api/sessions/${id}`)).status,404);
});

test('workspace imports are bounded create-only text and reject path attacks',async t=> {
  const f=await fixture(t);
  const imported=await f.request('/api/workspace/files',{method:'POST',data:{path:'notes/中文.md',content:'# 原创笔记\n测试'}});assert.equal(imported.status,201);
  assert.equal((await f.request('/api/workspace/file?path=notes%2F%E4%B8%AD%E6%96%87.md')).data.content,'# 原创笔记\n测试');
  assert.equal((await f.request('/api/workspace/files',{method:'POST',data:{path:'notes/中文.md',content:'replace'}})).status,409);
  for(const path of ['../credentials.json','C:/secret.txt','/etc/passwd','test:stream','a/../../secret','CON.txt','a\\b']) {
    const result=await f.request('/api/workspace/files',{method:'POST',data:{path,content:'blocked'}});assert.ok(result.status>=400&&result.status<500,`${path}: ${result.status}`);
  }
  assert.equal((await f.request('/api/workspace/files',{method:'POST',data:{path:'large.txt',content:'x'.repeat(256*1024+1)}})).status,413);
  assert.ok((await f.request('/api/workspace')).data.files.some(x=>x.path==='notes/中文.md'));
  assert.ok((await f.request('/api/audit')).data.entries.some(x=>x.action==='workspace.import'));
});

test('provider credentials are never persisted or exported; invalid URL protocols denied',async t=> {
  const f=await fixture(t);const secret='integration-secret-do-not-persist';
  const created=await f.request('/api/providers',{method:'POST',data:{name:'本机兼容接口',type:'openai',model:'test-model',baseUrl:'http://127.0.0.1:12345/v1',apiKey:secret}});assert.equal(created.status,201);assert.equal(created.data.provider.hasKey,true);
  const exported=JSON.stringify((await f.request('/api/export')).data);assert.ok(!exported.includes(secret));assert.ok(!JSON.stringify((await f.request('/api/state')).data).includes(secret));
  const bytes=await readFile(join(f.dir,'openaster.sqlite-wal'));assert.ok(!bytes.includes(Buffer.from(secret)));
  for(const baseUrl of ['http://remote.invalid/v1','file:///tmp','https://user:password@example.com/v1','https://example.com/v1?secret=foo']) assert.equal((await f.request('/api/providers',{method:'POST',data:{name:'无效',type:'openai',model:'x',baseUrl}})).status,400);
  assert.equal((await f.request('/api/providers/demo',{method:'DELETE'})).status,400);
  assert.equal((await f.request(`/api/providers/${created.data.provider.id}`,{method:'DELETE'})).status,200);
});

test('provider edits retain identity and require explicit credential rebinding for new endpoints',async t=> {
  const f=await fixture(t);
  const p=(await f.request('/api/providers',{method:'POST',data:{name:'原始连接',type:'openai',model:'old',baseUrl:'https://api.example.test/v1',apiKey:'private-original-key'}})).data.provider;
  const edited=await f.request(`/api/providers/${p.id}`,{method:'PATCH',data:{name:'更新连接',model:'new',apiKey:''}});
  assert.equal(edited.status,200);assert.equal(edited.data.provider.id,p.id);assert.equal(edited.data.provider.hasKey,true);assert.equal(edited.data.provider.model,'new');
  const refused=await f.request(`/api/providers/${p.id}`,{method:'PATCH',data:{baseUrl:'https://other.example.test/v1'}});assert.equal(refused.status,400);assert.equal(refused.data.error.code,'CREDENTIAL_REBIND');
  const changed=await f.request(`/api/providers/${p.id}`,{method:'PATCH',data:{baseUrl:'https://other.example.test/v1',clearKey:true}});assert.equal(changed.status,200);assert.equal(changed.data.provider.hasKey,false);
  assert.equal((await f.request('/api/providers/demo',{method:'PATCH',data:{model:'invalid'}})).status,400);
  assert.ok(!JSON.stringify((await f.request('/api/export')).data).includes('private-original-key'));
});

test('actual HTTP provider request, tool approval, completion and replay rejection',async t=> {
  let calls=0;let keySeen=false;
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const payload=JSON.parse(Buffer.concat(chunks));calls++;keySeen=req.headers.authorization==='Bearer test-key';
    assert.equal(req.url,'/v1/chat/completions');assert.equal(payload.model,'fixture-model');
    const message=calls===1?{role:'assistant',content:'准备创建计划。',tool_calls:[{id:'call_write_1',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'plan.md',content:'# 已审批计划\n原创内容'})}}]}:{role:'assistant',content:'文件已保存。'};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?.length?'tool_calls':'stop'}]}));
  });await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>upstream.close(r)));
  const f=await fixture(t);
  const provider=(await f.request('/api/providers',{method:'POST',data:{name:'测试接口',type:'openai',model:'fixture-model',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:'test-key'}})).data.provider;
  const session=(await f.request('/api/sessions',{method:'POST',data:{providerId:provider.id}})).data.session;
  const started=await f.request(`/api/sessions/${session.id}/messages`,{method:'POST',data:{content:'请创建 plan.md'}});assert.equal(started.status,202);
  const waiting=await until(()=>f.request(`/api/sessions/${session.id}`),r=>r.data.session.run?.status==='awaiting_approval');
  const approval=waiting.data.session.approvals.find(a=>a.status==='pending');assert.ok(approval);assert.equal((await f.request('/api/workspace/file?path=plan.md')).status,404);
  assert.equal((await f.request(`/api/sessions/${session.id}`,{method:'DELETE'})).status,409);
  assert.equal((await f.request(`/api/providers/${provider.id}`,{method:'DELETE'})).status,409);
  assert.equal((await f.request(`/api/approvals/${approval.id}`,{method:'POST',data:{decision:'approve'}})).status,200);
  const done=await until(()=>f.request(`/api/sessions/${session.id}`),r=>r.data.session.run?.status==='completed');assert.ok(done.data.session.messages.some(m=>m.content==='文件已保存。'));assert.equal(calls,2);assert.equal(keySeen,true);
  assert.equal((await f.request('/api/workspace/file?path=plan.md')).data.content,'# 已审批计划\n原创内容');
  assert.ok((await f.request(`/api/approvals/${approval.id}`,{method:'POST',data:{decision:'approve'}})).status>=400);
});

test('gateway requires bearer and explicit allowed origin, including bootstrap',async t=> {
  const dir=await mkdtemp(join(tmpdir(),'openaster-gateway-'));const token='a'.repeat(48);const app=await startServer({dataDir:dir,gatewayOrigin:'https://agent.example.test',token,allowedOrigins:['capacitor://localhost','https://localhost']});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  assert.equal((await fetch(`${app.url}/api/bootstrap`)).status,401);
  const bootstrap=await fetch(`${app.url}/api/bootstrap`,{headers:{Authorization:`Bearer ${token}`,Origin:'capacitor://localhost'}});assert.equal(bootstrap.status,200);assert.equal(bootstrap.headers.get('access-control-allow-origin'),'capacitor://localhost');assert.equal(bootstrap.headers.get('set-cookie'),null);
  const {csrfToken}=await bootstrap.json();
  assert.equal((await fetch(`${app.url}/api/sessions`,{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:'https://localhost','X-CSRF-Token':csrfToken,'Content-Type':'application/json'},body:'{}'})).status,201);
  assert.equal((await fetch(`${app.url}/api/state`,{headers:{Authorization:`Bearer ${token}`,Origin:'https://evil.test'}})).status,403);
  assert.equal((await fetch(`${app.url}/api/state`,{headers:{Authorization:'Bearer wrong'}})).status,401);
  const preflight=await fetch(`${app.url}/api/sessions`,{method:'OPTIONS',headers:{Origin:'https://localhost'}});assert.equal(preflight.status,204);assert.ok(!preflight.headers.get('access-control-allow-origin').includes('*'));
});

test('server refuses unsafe bind, data-overlapping workspace and weak remote credentials',async()=> {
  await assert.rejects(startServer({host:'0.0.0.0'}),{code:'LOOPBACK_ONLY'});
  await assert.rejects(startServer({dataDir:tmpdir(),workspace:tmpdir()}),{code:'UNSAFE_WORKSPACE'});
  await assert.rejects(startServer({gatewayOrigin:'http://unsafe.test',token:'a'.repeat(40)}),{code:'INVALID_GATEWAY'});
  await assert.rejects(startServer({gatewayOrigin:'https://safe.test',token:'short'}),{code:'INVALID_TOKEN'});
});

test('restart invalidates incomplete tasks and approval state without executing writes',async t=> {
  const dir=await mkdtemp(join(tmpdir(),'openaster-recovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));let store=new Store(dir);const session=store.createSession();session.run={id:'old-run',status:'awaiting_approval'};session.approvals=[{id:'old-approval',status:'pending'}];store.putSession(session);store.close();
  store=new Store(dir);assert.equal(store.getSession(session.id).run.status,'cancelled');assert.equal(store.getSession(session.id).approvals[0].status,'denied');store.close();
});

test('one data directory admits only one server and releases its lock on shutdown',async t=> {
  const dir=await mkdtemp(join(tmpdir(),'openaster-lock-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const first=await startServer({dataDir:dir});
  await assert.rejects(startServer({dataDir:dir}),{code:'DATA_LOCKED'});
  await first.close();const second=await startServer({dataDir:dir});await second.close();
});

test('workspace cannot point into source assets or credential storage',async t=> {
  const dir=await mkdtemp(join(tmpdir(),'openaster-boundary-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await assert.rejects(startServer({dataDir:dir,workspace:join(process.cwd(),'public')}),{code:'UNSAFE_WORKSPACE'});
  await assert.rejects(startServer({dataDir:dir,workspace:join(dir,'secrets')}),{code:'UNSAFE_WORKSPACE'});
});

test('credential updates exclude overlapping starts, edits and deletion',async t=> {
  const values=new Map();let hold=false;let entered;let release;
  const enteredPromise=new Promise(resolve=>{entered=resolve;});
  const holdPromise=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{secretStore:{get:id=>values.get(id),async set(id,value){if(hold){entered();await holdPromise;}values.set(id,value);},delete:id=>values.delete(id)}});
  t.after(()=>release());
  const provider=(await f.request('/api/providers',{method:'POST',data:{name:'待更新',type:'openai',model:'x',baseUrl:'https://old.example.test/v1',apiKey:'old-secret'}})).data.provider;
  const session=(await f.request('/api/sessions',{method:'POST',data:{providerId:provider.id}})).data.session;
  hold=true;
  const pending=f.request(`/api/providers/${provider.id}`,{method:'PATCH',data:{baseUrl:'https://new.example.test/v1',apiKey:'new-secret'}});
  await enteredPromise;
  for(const [path,method,data]of [[`/api/providers/${provider.id}`,'PATCH',{name:'overlap'}],[`/api/providers/${provider.id}`,'DELETE',undefined],[`/api/sessions/${session.id}/messages`,'POST',{content:'should not run'}]]) {
    const result=await f.request(path,{method,data});assert.equal(result.status,409);assert.equal(result.data.error.code,'PROVIDER_BUSY');
  }
  release();assert.equal((await pending).status,200);
  assert.equal((await f.request(`/api/sessions/${session.id}`)).data.session.messages.length,0);
  assert.equal((await f.request('/api/state')).data.providers.find(p=>p.id===provider.id).baseUrl,'https://new.example.test/v1');
});

test('slow task edits cannot replace state created while their body is still arriving',async t=> {
  const f=await fixture(t);const session=(await f.request('/api/sessions',{method:'POST',data:{}})).data.session;
  let patch;
  const result=new Promise((resolve,reject)=>{
    patch=http.request(`${f.app.url}/api/sessions/${session.id}`,{method:'PATCH',headers:{Cookie:f.cookie,'X-CSRF-Token':f.csrfToken,'Content-Type':'application/json'}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(chunks))}));});
    patch.on('error',reject);patch.write('{"title":');
  });
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal((await f.request(`/api/sessions/${session.id}/messages`,{method:'POST',data:{content:'生成工作区报告'}})).status,202);
  await until(()=>f.request(`/api/sessions/${session.id}`),r=>r.data.session.run?.status==='awaiting_approval');
  patch.end('"迟到的修改"}');
  const response=await result;assert.equal(response.status,409);
  const after=(await f.request(`/api/sessions/${session.id}`)).data.session;assert.equal(after.run.status,'awaiting_approval');assert.equal(after.messages[0].content,'生成工作区报告');
});

test('database and SQLite sidecar hardlinks are rejected before opening external files',async t=> {
  const dir=await mkdtemp(join(tmpdir(),'openaster-db-links-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const original=join(dir,'outside.txt');await writeFile(original,'untouched');
  for(const suffix of ['', '-wal', '-shm', '-journal']) {
    const target=join(dir,`openaster.sqlite${suffix}`);await link(original,target);
    assert.throws(()=>new Store(dir),{code:'UNSAFE_DATA_DIR'});await rm(target);assert.equal(await readFile(original,'utf8'),'untouched');
  }
});

test('session listings omit large histories and run details; bulk export has a byte budget',async t=> {
  const f=await fixture(t);const store=new Store(f.dir);
  const session=store.createSession();session.messages=[{role:'user',content:'文本'.repeat(500)}];session.run={id:'run',status:'completed',steps:[{detail:'large-private-tool-detail'}]};store.putSession(session);
  try {
    assert.throws(()=>store.listSessions({maxBytes:100}),{code:'EXPORT_LIMIT'});
    assert.equal(store.getSession(session.id).messages[0].content,session.messages[0].content);
  }finally{store.close();}
  const summary=(await f.request('/api/state')).data.sessions.find(item=>item.id===session.id);
  assert.equal(summary.messageCount,1);assert.deepEqual(summary.messages,[]);assert.equal(summary.run.status,'completed');assert.equal(summary.run.steps,undefined);
});

test('disabled model connections remain editable and cannot run until explicitly enabled',async t=> {
  let calls=0;
  const f=await fixture(t,{runtimeOptions:{providerCall:async()=>{calls++;return {content:'启用后完成',toolCalls:[]};}}});
  const created=await f.request('/api/providers',{method:'POST',data:{name:'可恢复的模型',type:'openai',model:'fixture',baseUrl:'https://example.test/v1'}});
  const id=created.data.provider.id;
  const task=(await f.request('/api/sessions',{method:'POST',data:{providerId:id}})).data.session;
  for(const enabled of ['false',null,0])assert.equal((await f.request(`/api/providers/${id}`,{method:'PATCH',data:{enabled}})).status,400);
  assert.equal((await f.request(`/api/providers/${id}`,{method:'PATCH',data:{enabled:false}})).data.provider.enabled,false);
  const edited=await f.request(`/api/providers/${id}`,{method:'PATCH',data:{name:'已核对地址'}});
  assert.equal(edited.data.provider.name,'已核对地址');assert.equal(edited.data.provider.enabled,false);
  assert.equal((await f.request(`/api/providers/${id}/test`,{method:'POST',data:{}})).status,409);
  assert.equal((await f.request(`/api/sessions/${task.id}/messages`,{method:'POST',data:{content:'尚不允许'}})).status,409);
  const unchanged=(await f.request(`/api/sessions/${task.id}`)).data.session;
  assert.equal(unchanged.providerId,id);assert.equal(unchanged.messages.length,0);assert.equal(unchanged.run,null);assert.equal(calls,0);
  assert.equal((await f.request(`/api/providers/${id}`,{method:'PATCH',data:{enabled:true}})).data.provider.enabled,true);
  assert.equal((await f.request(`/api/sessions/${task.id}/messages`,{method:'POST',data:{content:'现在开始'}})).status,202);
  const complete=await until(()=>f.request(`/api/sessions/${task.id}`),result=>result.data.session.run?.status==='completed');
  assert.equal(complete.data.session.providerId,id);assert.equal(calls,1);
  assert.equal((await f.request('/api/providers/demo',{method:'PATCH',data:{enabled:false}})).status,400);
});
