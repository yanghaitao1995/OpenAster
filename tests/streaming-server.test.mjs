import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,predicate) { for(let n=0;n<250;n++){const result=await fn();if(predicate(result))return result;await wait(20);}throw new Error('Server stream test timed out'); }

test('authenticated SSE announces durable drafts without broadcasting text; reload and cancellation preserve state',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'openaster-stream-http-'));
  const app=await startServer({dataDir:directory,runtimeOptions:{limits:{streamCheckpointMs:20},providerCall:async(_p,{onText,signal})=>{
    await onText('只在当前任务中读取的中文片段');
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    signal.throwIfAborted();
  }}});
  const controllers=[];
  t.after(async()=>{for(const controller of controllers)controller.abort();await app.close();assert.equal(path.dirname(directory),tmpdir());await rm(directory,{recursive:true,force:true});});
  const bootstrap=await fetch(`${app.url}/api/bootstrap`);const cookie=bootstrap.headers.get('set-cookie').split(';')[0];const {csrfToken}=await bootstrap.json();
  async function request(url,{method='GET',body,auth=true}={}){const response=await fetch(app.url+url,{method,headers:{...(auth?{cookie,'X-CSRF-Token':csrfToken}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:response.status,...await response.json()};}
  const provider=await request('/api/providers',{method:'POST',body:{name:'本机流式验证',type:'openai',model:'fixture',baseUrl:'https://example.test/v1',streaming:true}});
  assert.equal(provider.status,201);
  const first=(await request('/api/sessions',{method:'POST',body:{providerId:provider.provider.id}})).session;
  const second=(await request('/api/sessions',{method:'POST',body:{providerId:provider.provider.id}})).session;
  assert.equal((await request('/api/events',{auth:false})).status,401);
  const controller=new AbortController();controllers.push(controller);
  const events=await fetch(app.url+'/api/events',{headers:{cookie},signal:controller.signal});
  let wire='';const reader=events.body.getReader();const decoder=new TextDecoder();
  const consume=(async()=>{try{for(;;){const{done,value}=await reader.read();if(done)break;wire+=decoder.decode(value,{stream:true});}}catch(error){if(!controller.signal.aborted)throw error;}finally{reader.releaseLock();}})();
  await request(`/api/sessions/${first.id}/messages`,{method:'POST',body:{content:'开始'}});
  const draft=await until(()=>request(`/api/sessions/${first.id}`),result=>result.session?.run?.output?.content);
  await until(()=>wire,value=>value.includes('event: stream'));
  assert.equal(draft.session.run.status,'running');assert.equal(draft.session.messages.length,1);
  const frame=wire.split('\n\n').find(frame=>frame.startsWith('event: stream'));
  const payload=JSON.parse(frame.split('\ndata: ')[1]);
  assert.deepEqual(Object.keys(payload).sort(),['runId','sessionId','stepId']);assert.equal(payload.sessionId,first.id);
  assert.ok(!wire.includes('只在当前任务'));
  const state=await request('/api/state');assert.ok(!JSON.stringify(state.sessions).includes('只在当前任务'));
  assert.equal((await request(`/api/sessions/${second.id}`)).session.run,null);
  assert.equal((await request(`/api/sessions/${first.id}`,{auth:false})).status,401);
  controller.abort();await consume;
  assert.equal((await request(`/api/sessions/${first.id}`)).session.run.output.content,'只在当前任务中读取的中文片段');
  await request(`/api/sessions/${first.id}/cancel`,{method:'POST',body:{}});
  const stopped=await until(()=>request(`/api/sessions/${first.id}`),result=>result.session.run.status==='cancelled');
  assert.equal(stopped.session.run.output.status,'interrupted');assert.equal(stopped.session.messages.length,1);
  const fresh=await fetch(`${app.url}/api/bootstrap`);const freshCookie=fresh.headers.get('set-cookie').split(';')[0];
  const reloaded=await(await fetch(`${app.url}/api/sessions/${first.id}`,{headers:{cookie:freshCookie}})).json();
  assert.deepEqual(reloaded.session.run.output,stopped.session.run.output);
});

test('restart recovery labels a saved in-flight draft as interrupted without adding assistant history',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'openaster-stream-recovery-'));
  t.after(async()=>{assert.equal(path.dirname(directory),tmpdir());await rm(directory,{recursive:true,force:true});});
  const store=new Store(directory);let id;
  try{const session=store.createSession();id=session.id;session.messages=[{role:'user',content:'任务'}];session.run={id:'old-run',status:'running',steps:[],output:{stepId:'old-step',content:'崩溃前已保存的片段',status:'streaming'}};store.putSession(session);}finally{store.close();}
  const recovered=new Store(directory);
  try{const session=recovered.getSession(id);assert.equal(session.run.status,'cancelled');assert.equal(session.run.output.status,'interrupted');assert.equal(session.run.output.content,'崩溃前已保存的片段');assert.equal(session.messages.length,1);assert.ok(!JSON.stringify(recovered.listSessionSummaries()).includes('崩溃前已保存'));}finally{recovered.close();}
});
