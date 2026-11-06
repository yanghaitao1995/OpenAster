import {readUtf8Body} from './helpers/http-body.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { diagnoseProvider } from '../core/provider-diagnostics.mjs';
import { callProvider, parseResponse, testProvider } from '../core/providers.mjs';
import { CoreError } from '../core/errors.mjs';
import { MAX_JSON_RESPONSE_BYTES } from '../core/model-limits.mjs';

const types=['openai','responses','anthropic','ollama'];
const provider=(type='openai',extra={})=>({id:'diagnostic-provider',name:'本机诊断',type,baseUrl:'https://fixture.invalid/v1',model:'diagnostic-model',streaming:true,toolMode:'workspace',maxTokens:1234,tokenParameter:'max_tokens',apiKey:'private-key-sentinel',envKey:'PRIVATE_ENV_SENTINEL',...extra});
const sse=data=>`data: ${typeof data==='string'?data:JSON.stringify(data)}\n\n`;
const chat=(content,finish_reason=null)=>({choices:[{index:0,delta:{content},finish_reason}]});
const textData=(type,content)=>type==='openai'?{choices:[{message:{role:'assistant',content},finish_reason:'stop'}]}
  :type==='responses'?{status:'completed',output:[{id:'message',type:'message',role:'assistant',content:[{type:'output_text',text:content}]}]}
  :type==='anthropic'?{content:[{type:'text',text:content}],stop_reason:'end_turn'}
  :{message:{role:'assistant',content},done:true,done_reason:'stop'};
function toolData(type,name,args,{multiple=false}={}) {
  if(type==='openai'||type==='ollama'){
    const call={id:'exact-call-1',type:'function',function:{name,arguments:type==='ollama'?args:JSON.stringify(args)}};
    const message={role:'assistant',content:'',reasoning_content:'private-reasoning-sentinel',tool_calls:[call,...(multiple?[{...call,id:'exact-call-2'}]:[])]};
    return type==='openai'?{choices:[{message,finish_reason:'tool_calls'}]}:{message,done:true,done_reason:'stop'};
  }
  if(type==='responses')return{status:'completed',output:[{id:'reasoning',type:'reasoning',summary:[],encrypted_content:'private-reasoning-sentinel'},
    {id:'function-1',type:'function_call',call_id:'exact-call-1',name,arguments:JSON.stringify(args),status:'completed'}]};
  return{content:[{type:'thinking',thinking:'private-reasoning-sentinel',signature:'preserved-signature'},
    {type:'tool_use',id:'exact-call-1',name,input:args}],stop_reason:'tool_use'};
}
function streamData(type,{terminalOnly=false,reasoningOnly=false,text:customText}={}) {
  const text=customText??(reasoningOnly?'':'流式正文');
  if(type==='openai')return{mime:'text/event-stream',body:terminalOnly?sse(chat(text,'stop'))+sse('[DONE]'):
    sse({choices:[{index:0,delta:{reasoning_content:'private-reasoning-sentinel',content:text},finish_reason:null}]})+sse(chat('','stop'))+sse('[DONE]')};
  if(type==='ollama')return{mime:'application/x-ndjson',body:(terminalOnly?'':JSON.stringify({message:{role:'assistant',content:text,thinking:'private-reasoning-sentinel'},done:false})+'\n')+
    JSON.stringify({message:{role:'assistant',content:terminalOnly?text:''},done:true,done_reason:'stop'})+'\n'};
  if(type==='responses'){
    const message={id:'message',type:'message',role:'assistant',content:[{type:'output_text',text}]};
    const end={type:'response.completed',response:{status:'completed',output:[message]}};
    return{mime:'text/event-stream',body:(terminalOnly?[end]:[
      {type:'response.output_item.added',output_index:0,item:{...message,content:[]}},
      {type:'response.content_part.added',output_index:0,content_index:0,item_id:'message',part:{type:'output_text',text:''}},
      {type:'response.reasoning_text.delta',output_index:0,delta:'private-reasoning-sentinel'},
      {type:'response.output_text.delta',output_index:0,content_index:0,item_id:'message',delta:text},
      {type:'response.content_part.done',output_index:0,content_index:0,item_id:'message',part:message.content[0]},
      {type:'response.output_item.done',output_index:0,item:message},end]).map(sse).join('')};
  }
  return{mime:'text/event-stream',body:[{type:'message_start',message:{id:'message',role:'assistant',content:[]}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:terminalOnly?text:''}},
    ...(!terminalOnly?[{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}]:[]),
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}].map(sse).join('')};
}
function toolResult(type,input){
  if(type==='responses')return input.input.find(item=>item.type==='function_call_output')?.output;
  if(type==='anthropic')return input.messages.flatMap(item=>Array.isArray(item.content)?item.content:[]).find(item=>item.type==='tool_result')?.content;
  return input.messages.find(item=>item.role==='tool')?.content;
}
function defaultReply(type,input){
  const result=toolResult(type,input);if(result)return{data:textData(type,JSON.parse(result).result.receipt)};
  if(input.tools?.length){const schema=input.tools[0].parameters??input.tools[0].input_schema??input.tools[0].function.parameters;
    return{data:toolData(type,'openaster_diagnostic_echo',{nonce:schema.properties.nonce.enum[0]})};}
  if(input.stream)return streamData(type);
  return{data:textData(type,'private-response-sentinel')};
}
async function local(t,type,override){
  const requests=[],replies=[];
  const server=createServer(async(req,res)=>{
    try{const raw=await readUtf8Body(req);const input=JSON.parse(raw);requests.push(input);
      const reply=await override?.(input,requests.length)??defaultReply(type,input);replies.push(reply);
      res.writeHead(reply.status??200,{'content-type':reply.mime??'application/json',...reply.headers});
      const bytes=Buffer.from(reply.body??JSON.stringify(reply.data));
      // Split one Unicode character across actual HTTP writes when present.
      const at=bytes.findIndex(value=>value>=0xe0);if(at>=0){res.write(bytes.subarray(0,at+1));await new Promise(done=>setImmediate(done));res.end(bytes.subarray(at+1));}else res.end(bytes);
    }catch(error){res.writeHead(500);res.end('fixture failure');}
  });await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
  return{config:provider(type,{baseUrl:`http://127.0.0.1:${server.address().port}${type==='ollama'?'':'/v1'}`}),requests,replies};
}

for(const type of types)test(`diagnostic ${type}: four real loopback requests verify text, stream and exact synthetic tool continuation`,async t=>{
  const f=await local(t,type),report=await diagnoseProvider(f.config);
  assert.deepEqual(Object.values(report.checks).map(item=>item.status),['passed','passed','passed']);
  assert.equal(report.requestsStarted,4);assert.deepEqual(Object.values(report.checks).map(item=>item.requestCount),[1,1,2]);
  assert.equal(report.version,1);assert.ok(Date.parse(report.finishedAt)>=Date.parse(report.startedAt));
  assert.deepEqual(Object.keys(report.connection),['id','name','type','baseUrl','model','streaming','toolMode','tokenParameter','maxTokens','contextWindowTokens','autoCompact','autoContinue','maxModelCalls','maxTools','maxRunMinutes','enabled']);
  for(const check of Object.values(report.checks))assert.deepEqual(Object.keys(check).sort(),['code','durationMs','message','requestCount','status']);
  const serialized=JSON.stringify(report);for(const secret of ['private-key-sentinel','PRIVATE_ENV_SENTINEL','private-response-sentinel','private-reasoning-sentinel','preserved-signature','apiKey','envKey','usage'])assert.ok(!serialized.includes(secret),secret);
  const [full,stream,first,second]=f.requests;assert.equal(full.stream,false);assert.equal(stream.stream,true);assert.equal(first.stream,false);assert.equal(second.stream,false);
  assert.ok(!full.tools&&!stream.tools);assert.equal(first.tools.length,1);assert.equal(second.tools.length,1);
  assert.equal(type==='ollama'?full.options.num_predict:type==='responses'?full.max_output_tokens:full.max_tokens,1234);
  const returned=JSON.parse(toolResult(type,second));assert.equal(returned.untrusted_data,true);assert.match(returned.result.receipt,/^[a-f0-9]{32}$/);assert.notEqual(returned.result.receipt,returned.result.nonce);
  assert.ok(!JSON.stringify(first).includes(returned.result.receipt));
  const original=f.replies[2].data;
  if(type==='responses'){assert.deepEqual(second.input.slice(1,-1),original.output);assert.equal(second.input.at(-1).call_id,'exact-call-1');}
  else if(type==='anthropic'){assert.deepEqual(second.messages[1].content,original.content);assert.equal(second.messages.at(-1).content[0].tool_use_id,'exact-call-1');}
  else{assert.deepEqual(second.messages.at(-2),type==='openai'?original.choices[0].message:original.message);assert.equal(second.messages.at(-1)[type==='ollama'?'tool_name':'tool_call_id'],type==='ollama'?'openaster_diagnostic_echo':'exact-call-1');}
});

test('diagnostic respects disabled capabilities, demo, disabled provider and safe default snapshot',async()=>{
  let count=0;const fetchImpl=async()=>{count++;return new Response(JSON.stringify(textData('openai','OK')));};
  const report=await diagnoseProvider(provider('openai',{streaming:false,toolMode:'none'}),{fetchImpl});
  assert.equal(count,1);assert.equal(report.checks.stream.code,'STREAM_DISABLED');assert.equal(report.checks.tools.code,'TOOLS_DISABLED');
  const demo=await diagnoseProvider({type:'demo'},{fetchImpl});assert.equal(demo.requestsStarted,0);assert.equal(count,1);assert.ok(Object.values(demo.checks).every(check=>check.status==='skipped'&&check.code==='DEMO_NO_NETWORK'));
  assert.equal(demo.connection.id,null);assert.equal(demo.connection.name,null);assert.equal(demo.connection.tokenParameter,null);assert.equal(demo.connection.maxTokens,null);
  assert.deepEqual(Object.fromEntries(['contextWindowTokens','autoCompact','autoContinue','maxModelCalls','maxTools','maxRunMinutes'].map(key=>[key,demo.connection[key]])),{contextWindowTokens:131072,autoCompact:true,autoContinue:true,maxModelCalls:64,maxTools:256,maxRunMinutes:60});
  await assert.rejects(diagnoseProvider(provider('openai',{enabled:false}),{fetchImpl}),{code:'PROVIDER_DISABLED'});assert.equal(count,1);
  for(const timeoutMs of [0,-1,1.5,30001,Infinity,'30'])await assert.rejects(diagnoseProvider(provider(),{fetchImpl,timeoutMs}),{code:'INVALID_DIAGNOSTIC_OPTIONS'});
});

for(const type of types)test(`diagnostic ${type}: JSON fallback is unverified despite a successful text callback`,async t=>{
  const f=await local(t,type,input=>input.stream?{data:textData(type,'JSON fallback')}:undefined);
  const report=await diagnoseProvider(f.config);assert.equal(report.requestsStarted,4);assert.equal(report.checks.stream.status,'unverified');assert.equal(report.checks.stream.code,'STREAM_JSON_FALLBACK');
});

for(const type of ['openai','responses','ollama'])test(`diagnostic ${type}: terminal-only text does not claim incremental streaming`,async t=>{
  const f=await local(t,type,input=>input.stream?streamData(type,{terminalOnly:true}):undefined);
  const report=await diagnoseProvider(f.config);assert.equal(report.checks.stream.code,'STREAM_NO_INCREMENTAL_TEXT');assert.equal(report.checks.stream.status,'unverified');assert.equal(report.checks.tools.status,'passed');
});

test('Anthropic nonempty text in a pre-terminal block-start counts as observed streaming',async t=>{
  const f=await local(t,'anthropic',input=>input.stream?streamData('anthropic',{terminalOnly:true}):undefined);
  assert.equal((await diagnoseProvider(f.config)).checks.stream.status,'passed');
});

test('missing tool call and missing receipt are inconclusive rather than unsupported',async t=>{
  const absent=await local(t,'openai',input=>input.tools?{data:textData('openai','No tool this time')}:undefined);
  const report=await diagnoseProvider(absent.config);assert.equal(report.requestsStarted,3);assert.equal(report.checks.tools.status,'unverified');assert.equal(report.checks.tools.code,'TOOL_NOT_CALLED');
  const mismatch=await local(t,'openai',input=>toolResult('openai',input)?{data:textData('openai','Incorrect receipt')}:undefined);
  const second=await diagnoseProvider(mismatch.config);assert.equal(second.requestsStarted,4);assert.equal(second.checks.tools.code,'TOOL_RESULT_NOT_CONFIRMED');assert.equal(second.checks.tools.status,'unverified');
});

test('unknown business tools, mismatched nonce, extra keys and multiple calls never get a tool result',async t=>{
  for(const mode of ['name','nonce','extra','multiple']){
    const f=await local(t,'openai',input=>{if(!input.tools)return;const nonce=input.tools[0].function.parameters.properties.nonce.enum[0];return{data:toolData('openai',mode==='name'?'write_file':'openaster_diagnostic_echo',
      mode==='nonce'?{nonce:'wrong'}:mode==='extra'?{nonce,path:'must-not-write.txt'}:{nonce},{multiple:mode==='multiple'})};});
    const report=await diagnoseProvider(f.config);assert.equal(report.requestsStarted,3);assert.equal(report.checks.tools.code,'TOOL_CALL_REJECTED');assert.equal(report.checks.tools.status,'failed');
    assert.ok(f.requests.every(input=>!toolResult('openai',input)));
  }
});

test('tool-only plain text responses cannot pass either old or new text tests',async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify(toolData('openai','write_file',{})));
  await assert.rejects(testProvider(provider(),{fetchImpl}),{code:'PROVIDER_TEXT_TEST_FAILED'});
  const report=await diagnoseProvider(provider('openai',{streaming:false}),{fetchImpl});assert.equal(report.checks.text.code,'TEXT_NOT_VERIFIED');assert.equal(report.checks.text.status,'unverified');assert.equal(report.checks.tools.code,'TOOL_CALL_REJECTED');
});

test('auth, rate limiting and unavailable connection skip follow-up probes and never expose upstream details',async()=>{
  for(const [status,code]of [[401,'PROVIDER_AUTH_FAILED'],[429,'PROVIDER_RATE_LIMIT'],[null,'PROVIDER_UNAVAILABLE']]){
    let calls=0;const report=await diagnoseProvider(provider(),{fetchImpl:async()=>{calls++;if(status===null)throw new Error('private-key-sentinel');return new Response('private-key-sentinel private-response-sentinel',{status});}});
    assert.equal(calls,1);assert.equal(report.requestsStarted,1);assert.equal(report.checks.text.code,code);assert.equal(report.checks.stream.code,'EARLIER_CONNECTION_FAILURE');assert.equal(report.checks.tools.code,'EARLIER_CONNECTION_FAILURE');assert.ok(!JSON.stringify(report).includes('private-'));
  }
});

test('bounded timeout, oversized body and invalid JSON produce fixed errors without retries',async()=>{
  for(const [fetchImpl,code]of [[async()=>new Promise(()=>{}),'PROVIDER_TIMEOUT'],[async()=>new Response('{}',{headers:{'content-length':String(MAX_JSON_RESPONSE_BYTES+1)}}),'PROVIDER_RESPONSE_TOO_LARGE'],[async()=>new Response('private-invalid-response'),'INVALID_PROVIDER_RESPONSE']]){
    const report=await diagnoseProvider(provider(),{fetchImpl,timeoutMs:10});assert.equal(report.requestsStarted,3);assert.ok(Object.values(report.checks).every(check=>check.status==='failed'&&check.code===code));assert.ok(!JSON.stringify(report).includes('private-'));
  }
});

test('context exhaustion retains a fixed diagnostic explanation without upstream error text',async()=>{
  const report=await diagnoseProvider(provider('anthropic',{streaming:false,toolMode:'none'}),{fetchImpl:async()=>Response.json({role:'assistant',stop_reason:'model_context_window_exceeded',content:[{type:'text',text:'private-response-sentinel'}]})});
  assert.equal(report.requestsStarted,1);assert.equal(report.checks.text.code,'MODEL_CONTEXT_LIMIT');assert.equal(report.checks.text.status,'failed');
  assert.match(report.checks.text.message,/上下文窗口/);assert.doesNotMatch(JSON.stringify(report),/private-response-sentinel/);
});

test('an interrupted SSE never passes even after visible text, and later independent tools can still verify',async t=>{
  const f=await local(t,'openai',input=>input.stream?{mime:'text/event-stream',body:sse(chat('first partial'))}:undefined);
  const report=await diagnoseProvider(f.config);assert.equal(report.checks.stream.status,'failed');assert.equal(report.checks.stream.code,'MODEL_RESPONSE_INCOMPLETE');assert.equal(report.checks.tools.status,'passed');
});

test('abort at each network request stops immediately and never starts a subsequent probe',async()=>{
  for(const abortAt of [1,2,3,4]){
    const controller=new AbortController();let calls=0;
    await assert.rejects(diagnoseProvider(provider(),{signal:controller.signal,fetchImpl:async(_url,options)=>{
      calls++;const input=JSON.parse(options.body),reply=defaultReply('openai',input);if(calls===abortAt)controller.abort();
      return new Response(reply.body??JSON.stringify(reply.data),{headers:{'content-type':reply.mime??'application/json'}});
    }}),{code:'CANCELLED'});assert.equal(calls,abortAt);
  }
  const controller=new AbortController();controller.abort();await assert.rejects(diagnoseProvider(provider(),{signal:controller.signal,fetchImpl:()=>{throw new Error('must not run');}}),{code:'CANCELLED'});
});

test('transport evidence is local-only metadata, and parseResponse retains its established shape',async()=>{
  const data={...textData('openai','OK'),transport:{format:'sse',incrementalText:true}};
  assert.deepEqual(Object.keys(parseResponse('openai',data)).sort(),['content','toolCalls','usage','wire']);
  const reply=await callProvider(provider(),{messages:[{role:'user',content:'x'}],onText(){},fetchImpl:async()=>new Response(JSON.stringify(data))});
  assert.deepEqual(reply.transport,{format:'json',incrementalText:false});
});

test('unexpected tool calls on a conversation-only connection are a fixed failure without execution',async()=>{
  const report=await diagnoseProvider(provider('openai',{toolMode:'none',streaming:false}),{fetchImpl:async(_url,options)=>{
    assert.ok(!JSON.parse(options.body).tools);return new Response(JSON.stringify(toolData('openai','write_file',{path:'never-executed'})));
  }});
  assert.equal(report.requestsStarted,1);assert.equal(report.checks.text.status,'failed');assert.equal(report.checks.text.code,'UNEXPECTED_TOOL_CALL');assert.equal(report.checks.tools.code,'TOOLS_DISABLED');
  assert.ok(!JSON.stringify(report).includes('never-executed'));
});

test('invalid visible text and arbitrary thrown errors cannot leak into the report',async()=>{
  for(const content of ['   ','\0private-response-sentinel','\ud800']){
    const fetchImpl=async()=>new Response(JSON.stringify(textData('openai',content)));
    const report=await diagnoseProvider(provider('openai',{streaming:false,toolMode:'none'}),{fetchImpl});
    assert.equal(report.checks.text.status,'unverified');assert.equal(report.checks.text.code,'TEXT_NOT_VERIFIED');assert.ok(!JSON.stringify(report).includes('private-response-sentinel'));
    await assert.rejects(testProvider(provider(),{fetchImpl}),{code:'PROVIDER_TEXT_TEST_FAILED'});
  }
  const report=await diagnoseProvider(provider(),{fetchImpl:async()=>{throw new CoreError('PROVIDER_TIMEOUT','private-key-sentinel private-response-sentinel');}});
  assert.ok(Object.values(report.checks).every(check=>check.code==='PROVIDER_TIMEOUT'));assert.ok(!JSON.stringify(report).includes('private-'));
});

test('reasoning and synthetic separators are never evidence of incremental visible text',async()=>{
  const fixtures=[
    ['openai',{mime:'text/event-stream',body:sse({choices:[{index:0,delta:{reasoning_content:'thought only'},finish_reason:null}]})+sse(chat('final text','stop'))+sse('[DONE]')}],
    ['responses',{mime:'text/event-stream',body:sse({type:'response.reasoning_text.delta',delta:'thought only'})+streamData('responses',{terminalOnly:true}).body}],
    ['ollama',{mime:'application/x-ndjson',body:JSON.stringify({message:{role:'assistant',content:'',thinking:'thought only'},done:false})+'\n'+streamData('ollama',{terminalOnly:true}).body}],
    ['anthropic',{mime:'text/event-stream',body:[
      {type:'message_start',message:{id:'message',role:'assistant',content:[]}},
      {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'thought only',signature:'signature'}},{type:'content_block_stop',index:0},
      {type:'content_block_start',index:1,content_block:{type:'text',text:''}},{type:'content_block_stop',index:1},
      {type:'content_block_start',index:2,content_block:{type:'text',text:''}},{type:'content_block_stop',index:2},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}].map(sse).join('')}],
  ];
  for(const[type,fixture]of fixtures){
    const reply=await callProvider(provider(type),{messages:[{role:'user',content:'x'}],onText(){},fetchImpl:async()=>new Response(fixture.body,{headers:{'content-type':fixture.mime}})});
    assert.equal(reply.transport.incrementalText,false,type);assert.equal(reply.transport.format,type==='ollama'?'ndjson':'sse');
  }
});

for(const type of types)test(`diagnostic ${type}: pre-terminal whitespace is preserved without claiming incremental body text`,async t=>{
  const whitespace='   \n\t';
  const fixture=type==='openai'?{mime:'text/event-stream',body:sse(chat(whitespace))+sse(chat('Only final text','stop'))+sse('[DONE]')}
    :type==='ollama'?{mime:'application/x-ndjson',body:JSON.stringify({message:{role:'assistant',content:whitespace},done:false})+'\n'+JSON.stringify({message:{role:'assistant',content:'Only final text'},done:true,done_reason:'stop'})+'\n'}
    :streamData(type,{text:whitespace});
  let emitted='';
  const reply=await callProvider(provider(type),{messages:[{role:'user',content:'x'}],onText:text=>{emitted+=text;},fetchImpl:async()=>new Response(fixture.body,{headers:{'content-type':fixture.mime}})});
  assert.equal(reply.transport.incrementalText,false);
  assert.equal(emitted,whitespace+(['openai','ollama'].includes(type)?'Only final text':''));
  assert.equal(reply.content,emitted);
  const f=await local(t,type,input=>input.stream?fixture:undefined);
  const report=await diagnoseProvider(f.config);
  assert.equal(report.checks.stream.status,'unverified');
  assert.equal(report.checks.stream.code,['openai','ollama'].includes(type)?'STREAM_NO_INCREMENTAL_TEXT':'TEXT_NOT_VERIFIED');
  assert.equal(report.checks.tools.status,'passed');
});
