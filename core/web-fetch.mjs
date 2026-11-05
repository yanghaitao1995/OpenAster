// SPDX-License-Identifier: Apache-2.0
import { lookup as systemLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import { CoreError } from './errors.mjs';

export const WEB_LIMITS = Object.freeze({ responseBytes: 1024 * 1024, resultBytes: 128 * 1024, redirects: 3, timeoutMs: 20000, idleMs: 10000, maxChars: 20000, links: 20 });
const error = (code, message, status = 400) => new CoreError(code, message, status);
const forbidden = () => error('WEB_ADDRESS_BLOCKED', '网页工具只能访问公网 HTTPS 地址；本机、私有网络及特殊用途地址不可访问。', 403);
export function isPublicWebAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a,b,c,d] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99 || b === 31 && c === 196 || b === 52 && c === 193 || b === 175 && c === 48)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113
      || a === 168 && b === 63 && c === 129 && d === 16) return false;
    return true;
  }
  if (family !== 6 || address.includes('.') || address.includes('%')) return false;
  const halves = address.toLowerCase().split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const [a,b] = parts.map(part => parseInt(part,16));
  // Accept global unicast only, excluding special-use/transition/documentation
  // ranges. This deliberately rejects mapped IPv4, NAT64, 6to4 and Teredo.
  return a >= 0x2000 && a <= 0x3ffd && a !== 0x2002 && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8));
}
const sensitiveQuery = /^(?:key|apikey|accesskey|secret|token|accesstoken|refreshtoken|idtoken|password|passwd|pwd|authorization|auth|credential|credentials|session|sessionid|signature|sig|code|jwt|samlresponse|xamzsignature|xamzcredential|xamzsecuritytoken|xgoogsignature|xgoogcredential)$/u;
export function validateWebUrl(input, base) {
  if (typeof input !== 'string' || !input || input.length > 2048 || !input.isWellFormed() || /[\x00-\x20\x7f\\]/u.test(input)) throw error('WEB_INVALID_URL', '请输入不含空白、控制字符或凭据的有效 HTTPS 网页地址。');
  let url; try { url = new URL(input, base); } catch { throw error('WEB_INVALID_URL', '网页地址无效。'); }
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.hash || url.href.length > 2048) throw error('WEB_INVALID_URL', '仅支持默认 443 端口的 HTTPS 网页；地址不可含登录凭据或片段。');
  const hostname = url.hostname.replace(/^\[|\]$/gu,'').toLowerCase();
  if (!hostname || hostname.endsWith('.') || !isIP(hostname) && (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|invalid|test)$/u.test(hostname))) throw forbidden();
  if (isIP(hostname) && !isPublicWebAddress(hostname)) throw forbidden();
  for (let key of url.searchParams.keys()) {
    for(let index=0;index<3&&key.includes('%');index++){try{key=decodeURIComponent(key);}catch{throw error('WEB_SENSITIVE_URL','网页查询字段含无法验证的多重编码。',403);}}
    if(key.includes('%')||sensitiveQuery.test(key.toLowerCase().replace(/[^a-z0-9]/gu,''))) throw error('WEB_SENSITIVE_URL', '网页地址包含可能携带凭据的查询字段；请提供公开且不含访问令牌的地址。', 403);
  }
  return url;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve,reject) => {
    const abort = () => { cleanup(); reject(signal.reason); }, cleanup = () => signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, cause => { cleanup(); reject(cause); });
  });
}
function header(response, name) {
  const value = response.headers?.[name];
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 8192) throw error('WEB_INVALID_RESPONSE','网页响应头格式无效。',502);
  return value;
}
function remoteMatches(actual, expected) {
  if (typeof actual !== 'string') return false;
  const canonical = value => value.toLowerCase().startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value.toLowerCase();
  if (canonical(actual) === canonical(expected)) return true;
  if (isIP(actual) === 6 && isIP(expected) === 6) { try{return new URL(`https://[${actual}]/`).hostname === new URL(`https://[${expected}]/`).hostname;}catch{return false;} }
  return false;
}

/** The injectable resolver/request function is an internal test seam, never an HTTP option. */
export function createWebFetcher({ lookup = systemLookup, transport = https.request } = {}) {
  if (typeof lookup !== 'function' || typeof transport !== 'function') throw new TypeError('Invalid web transport dependencies');
  async function request(url, signal) {
    const hostname = url.hostname.replace(/^\[|\]$/gu,'');
    let addresses;
    try { addresses = isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await abortable(lookup(hostname,{all:true,verbatim:true}),signal); }
    catch (cause) { if (signal.aborted) throw signal.reason; throw error('WEB_DNS_FAILED','无法解析网页的公网地址。',502); }
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(value => !value || !isPublicWebAddress(value.address) || value.family !== isIP(value.address))) throw forbidden();
    const pinned = addresses[0];
    return new Promise((resolve,reject) => {
      let req, response, settled=false;
      const cleanup=()=>signal.removeEventListener('abort',abort);
      const fail=cause=>{if(settled)return;settled=true;cleanup();response?.destroy();req?.destroy();reject(cause instanceof CoreError?cause:error('WEB_FETCH_FAILED','网页连接或 TLS 验证失败。',502));};
      const abort=()=>fail(signal.reason);
      const finish=value=>{if(settled)return;settled=true;cleanup();req?.setTimeout?.(0);resolve(value);};
      if(signal.aborted)return fail(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
      try {
        req=transport({protocol:'https:',hostname,port:443,path:url.pathname+url.search,method:'GET',agent:false,rejectUnauthorized:true,
          servername:isIP(hostname)?undefined:hostname,checkServerIdentity:(_name,cert)=>tls.checkServerIdentity(hostname,cert),maxHeaderSize:16384,
          headers:{'User-Agent':'OpenAster/0.2 (public-text-reader)','Accept':'text/html, text/plain, text/markdown;q=0.9','Accept-Encoding':'identity','Connection':'close'},
          lookup:(name,options,callback)=>{
            if(name!==hostname)return callback(forbidden());
            if(options?.all)return callback(null,[{...pinned}]);
            callback(null,pinned.address,pinned.family);
          }
        }, async incoming=>{
          response=incoming;
          try {
            if(settled){incoming.destroy();return;}
            const status=incoming.statusCode;
            if([301,302,303,307,308].includes(status)){const location=header(incoming,'location');incoming.destroy();if(!location)throw error('WEB_INVALID_RESPONSE','网页跳转缺少目标地址。',502);finish({location});return;}
            if(status===401||status===403)throw error('WEB_ACCESS_DENIED','网页拒绝公开访问；不会登录或绕过访问限制。',403);
            if(status===429)throw error('WEB_RATE_LIMIT','网站限制了访问频率；本次不会自动重试。',429);
            if(!Number.isInteger(status)||status<200||status>=300)throw error('WEB_HTTP_ERROR',`网页返回 HTTP ${Number.isInteger(status)?status:'错误'}；未读取正文。`,502);
            if(status===206||header(incoming,'content-range'))throw error('WEB_INCOMPLETE','网站只返回了部分正文；未将分段响应作为完整页面。',502);
            const encoding=header(incoming,'content-encoding').trim().toLowerCase();
            if(encoding&&encoding!=='identity')throw error('WEB_ENCODING_UNSUPPORTED','网站未提供未压缩文本响应；已拒绝自动解压。',415);
            const length=header(incoming,'content-length');
            if(length&&(!/^\d{1,10}$/u.test(length)||Number(length)>WEB_LIMITS.responseBytes))throw error('WEB_RESPONSE_LIMIT','网页响应超过 1 MiB 接收限制。',413);
            const contentType=header(incoming,'content-type'),mediaType=contentType.split(';',1)[0].trim().toLowerCase();
            if(!['text/html','text/plain','text/markdown','text/x-markdown'].includes(mediaType))throw error('WEB_CONTENT_TYPE','网页工具仅读取 HTML、纯文本或 Markdown。',415);
            const chunks=[];let bytes=0;
            for await(const chunk of incoming){
              if(signal.aborted)throw signal.reason;
              const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;
              if(bytes>WEB_LIMITS.responseBytes)throw error('WEB_RESPONSE_LIMIT','网页响应超过 1 MiB 接收限制。',413);
              chunks.push(buffer);
            }
            if(incoming.complete===false)throw error('WEB_INCOMPLETE','网页连接在正文完整接收前中断；未将截断内容作为成功结果。',502);
            if(length&&bytes!==Number(length))throw error('WEB_INCOMPLETE','网页实际字节数与声明长度不符；未将截断内容作为成功结果。',502);
            finish({bytes:Buffer.concat(chunks,bytes),contentType,mediaType,status});
          }catch(cause){fail(cause);}
        });
        req.on('error',fail);
        req.on('socket',socket=>socket.once('secureConnect',()=>{if(!remoteMatches(socket.remoteAddress,pinned.address))fail(forbidden());}));
        req.setTimeout(WEB_LIMITS.idleMs,()=>fail(error('WEB_TIMEOUT','网页连接空闲超时。',504)));
        req.end();
      }catch(cause){fail(cause);}
    });
  }
  return async function fetchPage(input,{signal,maxRedirects=WEB_LIMITS.redirects}={}){
    const controller=new AbortController(),cancel=()=>controller.abort(error('WEB_CANCELLED','网页读取已取消。',409));
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>controller.abort(error('WEB_TIMEOUT','网页读取超过 20 秒时限。',504)),WEB_LIMITS.timeoutMs);
    try{
      let url=validateWebUrl(input);const seen=new Set();
      for(let hop=0;;hop++){
        if(controller.signal.aborted)throw controller.signal.reason;
        if(seen.has(url.href))throw error('WEB_REDIRECT_LIMIT','网页重复跳转，已停止。',502);seen.add(url.href);
        const response=await request(url,controller.signal);
        if(!response.location)return{...response,url:url.href};
        if(hop>=maxRedirects)throw error('WEB_REDIRECT_LIMIT','网页跳转次数超过限制。',502);
        url=validateWebUrl(response.location,url);
      }
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  };
}
