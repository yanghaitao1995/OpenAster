// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createWebTools } from '../core/web-tools.mjs';
import { isPublicWebAddress, validateWebUrl, WEB_LIMITS } from '../core/web-fetch.mjs';

const article='<html><head><title>Public fixture</title></head><body><main><h1>Public article</h1><p>A sufficiently long public article body for this isolated network contract.</p></main></body></html>';
function mock(pages=[{}],resolver=async()=>[{address:'93.184.216.34',family:4}]){
  const calls=[],pins=[],requests=[];let resolutions=0;
  const lookup=async(...args)=>{resolutions++;return resolver(...args);};
  const transport=(options,callback)=>{
    const page=pages[calls.length]??pages.at(-1);calls.push(options);
    const req=new EventEmitter();requests.push(req);req.destroyed=false;
    req.setTimeout=(ms,fn)=>{req.timeoutMs=ms;if(fn)req.idle=fn;return req;};
    req.destroy=()=>{req.destroyed=true;req.response?.destroy();return req;};
    req.end=()=>queueMicrotask(async()=>{
      try{
        const address=await new Promise((resolve,reject)=>options.lookup(options.hostname,{},(error,address,family)=>error?reject(error):resolve({address,family})));
        const again=await new Promise((resolve,reject)=>options.lookup(options.hostname,{all:true},(error,addresses)=>error?reject(error):resolve(addresses)));
        pins.push({address,again});
        if(req.destroyed)return;
        const socket=new EventEmitter();socket.remoteAddress=page.remoteAddress??address.address;req.emit('socket',socket);socket.emit('secureConnect');
        if(req.destroyed)return;
        if(page.idle){req.idle();return;}
        if(page.hold)return;
        const response=Readable.from(page.chunks??[Buffer.from(page.body??article)]);req.response=response;
        response.statusCode=page.status??200;response.headers={'content-type':'text/html; charset=utf-8',...page.headers};response.complete=page.complete??true;
        callback(response);
      }catch(error){req.emit('error',error);}
    });return req;
  };
  return {tools:createWebTools({lookup,transport,clock:()=>new Date('2026-01-01T00:00:00.000Z')}),calls,pins,requests,resolutions:()=>resolutions};
}

test('IP policy rejects private, metadata, documentation, transition and mapped addresses',()=>{
  for(const address of ['0.0.0.0','10.0.0.1','100.100.100.200','127.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','192.0.0.192','192.0.2.1','192.31.196.1','192.52.193.1','192.175.48.1','192.88.99.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','168.63.129.16','::','::1','::ffff:8.8.8.8','::ffff:808:808','64:ff9b::808:808','fc00::1','fe80::1','ff02::1','2001::1','2001:db8::1','2002:0808:0808::1','3fff::1','not-an-ip'])assert.equal(isPublicWebAddress(address),false,address);
  for(const address of ['8.8.8.8','93.184.216.34','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(isPublicWebAddress(address),true,address);
});

test('URL policy rejects credential/sensitive/alternate network forms before any request',async()=>{
  const f=mock();
  for(const url of ['http://example.com/','https://example.com:8443/','https://user:password@example.com/','https://localhost/','https://example.local/','https://127.1/','https://0x7f000001/','https://2130706433/','https://[::ffff:127.0.0.1]/','https://example.com/?api_key=x','https://example.com/?%2561pi_key=x','https://example.com/?X-Amz-Signature=x','https://example.com/?access_token=x','https://example.com/a\\b','https://example.com/#token'])await assert.rejects(f.tools.read({url}),error=>['WEB_INVALID_URL','WEB_ADDRESS_BLOCKED','WEB_SENSITIVE_URL'].includes(error.code),url);
  assert.equal(f.calls.length,0);assert.equal(f.resolutions(),0);
  assert.equal(validateWebUrl('https://example.com:443/article?q=public').href,'https://example.com/article?q=public');
});

test('mixed public/private DNS answers are rejected without choosing only the public one',async()=>{
  for(const addresses of [[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}],[{address:'2606:4700::1111',family:6},{address:'fd00::1',family:6}],[{address:'8.8.8.8',family:6}],[]]){
    const f=mock([{}],async()=>addresses);await assert.rejects(f.tools.read({url:'https://example.com/'}),{code:'WEB_ADDRESS_BLOCKED'});assert.equal(f.calls.length,0);
  }
});

test('verified DNS is pinned for socket lookup and TLS still verifies the original hostname',async()=>{
  let dns=0;const f=mock([{}],async()=>[{address:++dns===1?'93.184.216.34':'127.0.0.1',family:4}]);
  const result=await f.tools.read({url:'https://example.com/article'});
  assert.equal(f.resolutions(),1);assert.equal(f.pins[0].address.address,'93.184.216.34');assert.equal(f.pins[0].again[0].address,'93.184.216.34');
  const options=f.calls[0];assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,'example.com');assert.equal(options.port,443);
  assert.ok(options.checkServerIdentity('93.184.216.34',{subjectaltname:'DNS:attacker.example'}) instanceof Error);
  assert.equal(options.headers['Accept-Encoding'],'identity');assert.ok(Object.keys(options.headers).every(key=>!['authorization','cookie','referer'].includes(key.toLowerCase())));
  assert.equal(result.untrusted_data,true);assert.equal(result.fetchedAt,'2026-01-01T00:00:00.000Z');
});

test('a socket that does not match the pinned address is rejected',async()=>{
  const f=mock([{remoteAddress:'127.0.0.1'}]);await assert.rejects(f.tools.read({url:'https://example.com/'}),{code:'WEB_ADDRESS_BLOCKED'});assert.equal(f.requests[0].destroyed,true);
});

test('each redirect resolves and validates again, including same-host rebinding',async()=>{
  let dns=0;const f=mock([{status:302,headers:{location:'/next'}}],async()=>[{address:++dns===1?'93.184.216.34':'127.0.0.1',family:4}]);
  await assert.rejects(f.tools.read({url:'https://example.com/'}),{code:'WEB_ADDRESS_BLOCKED'});assert.equal(f.calls.length,1);assert.equal(f.resolutions(),2);
  for(const location of ['https://127.0.0.1/','http://example.com/','https://example.com/?token=secret']){
    const g=mock([{status:302,headers:{location}}]);await assert.rejects(g.tools.read({url:'https://example.com/'}));assert.equal(g.calls.length,1);
  }
});

test('public redirect succeeds without carrying cookies and loops are bounded',async()=>{
  const f=mock([{status:302,headers:{location:'https://another.example.org/page','set-cookie':'private=value'}},{}]);
  const result=await f.tools.read({url:'https://example.com/'});assert.equal(result.url,'https://another.example.org/page');assert.equal(f.calls.length,2);assert.equal(f.calls[1].headers.cookie,undefined);
  const loop=mock([{status:302,headers:{location:'/again'}}]);await assert.rejects(loop.tools.read({url:'https://example.com/'}),{code:'WEB_REDIRECT_LIMIT'});assert.equal(loop.calls.length,2);
});

test('abort interrupts pending DNS without ever opening a transport',async()=>{
  const controller=new AbortController(),f=mock([{}],()=>new Promise(()=>{}));
  const operation=f.tools.read({url:'https://example.com/'},{signal:controller.signal});controller.abort();
  await assert.rejects(operation,{code:'WEB_CANCELLED'});assert.equal(f.calls.length,0);
});

test('abort and inactivity destroy an active owned request',async()=>{
  const controller=new AbortController(),f=mock([{hold:true}]);
  const operation=f.tools.read({url:'https://example.com/'},{signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(operation,{code:'WEB_CANCELLED'});assert.equal(f.requests[0].destroyed,true);
  const idle=mock([{idle:true}]);await assert.rejects(idle.tools.read({url:'https://example.com/'}),{code:'WEB_TIMEOUT'});assert.equal(idle.requests[0].destroyed,true);
});

test('body bytes, advertised lengths, compressed bodies and content types are bounded or rejected',async()=>{
  for(const [page,code] of [
    [{chunks:[Buffer.alloc(WEB_LIMITS.responseBytes),Buffer.from('x')]},'WEB_RESPONSE_LIMIT'],
    [{headers:{'content-length':String(WEB_LIMITS.responseBytes+1)}},'WEB_RESPONSE_LIMIT'],
    [{headers:{'content-encoding':'gzip'},body:'compressed bomb is never inflated'},'WEB_ENCODING_UNSUPPORTED'],
    [{headers:{'content-type':'application/pdf'}},'WEB_CONTENT_TYPE'],
    [{complete:false},'WEB_INCOMPLETE'],
    [{status:206},'WEB_INCOMPLETE'],
    [{headers:{'content-length':'999'}},'WEB_INCOMPLETE'],
    [{headers:{'content-type':'text/plain; charset=ascii'},chunks:[Buffer.from([0x80])]},'WEB_INVALID_TEXT'],
    [{chunks:[Buffer.from([0xc3,0x28])]},'WEB_INVALID_TEXT'],
    [{headers:{'content-type':'text/html; charset=made-up'}},'WEB_CHARSET_UNSUPPORTED']]){
    const f=mock([page]);await assert.rejects(f.tools.read({url:'https://example.com/'}),{code});
  }
});

test('access denials, throttling and human verification fail explicitly without retries',async()=>{
  for(const [page,code] of [[{status:403},'WEB_ACCESS_DENIED'],[{status:429},'WEB_RATE_LIMIT'],[{body:'<form id="captcha-form"><p>Please verify you are human.</p></form>'},'WEB_CHALLENGE']]){
    const f=mock([page]);await assert.rejects(f.tools.read({url:'https://example.com/'}),{code});assert.equal(f.calls.length,1);
  }
});

test('HTML extraction excludes active and hidden subtrees, preserves text and bounds safe links',async()=>{
  const links=Array.from({length:25},(_,i)=>`<a href="/page-${i}">Page ${i}</a>`).join('');
  const f=mock([{body:`<!doctype html><html><head><title>Example &amp; title</title><script>globalThis.pwned=true</script><style>hidden style</style></head><body><nav>navigation secret</nav><form>form secret</form><main><h1>Visible heading</h1><p>Useful &lt;literal&gt; public text and &#x1f600; emoji.</p><div hidden>hidden secret</div><a href="javascript:alert(1)">bad</a><a href="https://example.com/?token=x">credential URL</a>${links}</main></body></html>`}]);
  const result=await f.tools.read({url:'https://example.com/'});
  assert.equal(result.title,'Example & title');assert.match(result.content,/Useful <literal> public text/u);assert.doesNotMatch(result.content,/globalThis|hidden style|navigation secret|form secret|hidden secret/u);
  assert.equal(globalThis.pwned,undefined);assert.equal(result.links.length,20);assert.equal(result.truncated,true);assert.ok(result.links.every(link=>link.url.startsWith('https://example.com/page-')));
});

test('plain text and HTML output truncation are explicit and never split surrogate pairs',async()=>{
  const f=mock([{headers:{'content-type':'text/markdown; charset=utf-8'},body:'a'.repeat(499)+'😀tail'}]);
  const result=await f.tools.read({url:'https://example.com/' ,maxChars:500});assert.equal(result.truncated,true);assert.equal(result.content.length,499);assert.equal(result.content.isWellFormed(),true);
  const empty=mock([{body:'<html><script>only javascript</script></html>'}]);await assert.rejects(empty.tools.read({url:'https://example.com/'}),{code:'WEB_CONTENT_UNAVAILABLE'});
  const nested=mock([{body:'<div>'.repeat(257)+'text'+'</div>'.repeat(257)}]);await assert.rejects(nested.tools.read({url:'https://example.com/'}),{code:'WEB_PARSE_LIMIT'});
});

const searchHtml=()=>`<html><title>Search fixture</title><body>
<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.com/one')}&amp;rut=ignored">First &amp; title</a></h2><a class="result__snippet">Public first result snippet.</a></div>
<div><a class="result__a" href="https://example.org/two">Second result</a><div class="result__snippet">Second snippet.</div></div>
<div><a class="result__a" href="https://127.0.0.1/private">Private result</a><div class="result__snippet">Ignored.</div></div>
</body></html>`;
test('search sends one official HTML request, unwraps result links, and never crawls results',async()=>{
  const f=mock([{body:searchHtml()}]);const result=await f.tools.search({query:'public fixture',maxResults:1});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].hostname,'html.duckduckgo.com');assert.equal(f.calls[0].path,'/html/?q=public+fixture');
  assert.deepEqual(result.results,[{title:'First & title',url:'https://example.com/one',snippet:'Public first result snippet.'}]);assert.equal(result.truncated,true);assert.equal(result.untrusted_data,true);
});

test('a rejected search result cannot overwrite the previous public result snippet',async()=>{
  const f=mock([{body:searchHtml()}]);const result=await f.tools.search({query:'public fixture'});
  assert.deepEqual(result.results.map(value=>value.snippet),['Public first result snippet.','Second snippet.']);
});

test('numeric HTML entities cannot inject terminal control characters into extracted content',async()=>{
  const f=mock([{body:'<p>Public text before &#x1b;[31m malicious color control and after &#0; end.</p>'}]);
  const result=await f.tools.read({url:'https://example.com/'});assert.doesNotMatch(result.content,/[\x00-\x08\x0b\x0e-\x1f\x7f]/u);
});

test('search distinguishes no matches from a changed parser, refuses challenge/redirect and validates arguments',async()=>{
  const empty=mock([{body:'<html><p>No results found for this public search.</p></html>'}]);assert.deepEqual((await empty.tools.search({query:'fixture'})).results,[]);
  for(const [page,code]of [[{body:article},'WEB_SEARCH_UNAVAILABLE'],[{status:202,body:article},'WEB_CHALLENGE'],[{status:302,headers:{location:'https://duckduckgo.com/'}},'WEB_REDIRECT_LIMIT']]){
    const f=mock([page]);await assert.rejects(f.tools.search({query:'fixture'}),{code});assert.equal(f.calls.length,1);
  }
  const f=mock();for(const input of [{query:'x',maxResults:11},{query:'x',url:'https://example.com/'},{query:'\0'},{query:'x'.repeat(501)}])await assert.rejects(f.tools.search(input),{code:'WEB_INVALID_ARGUMENTS'});
  assert.equal(f.calls.length,0);
});
