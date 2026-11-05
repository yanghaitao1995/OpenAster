// SPDX-License-Identifier: Apache-2.0
// DuckDuckGo documents its non-JavaScript HTML entry point at:
// https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript
// This is a public website adapter, not a guaranteed/stable search API.
import { CoreError } from './errors.mjs';
import { createWebFetcher, validateWebUrl, WEB_LIMITS } from './web-fetch.mjs';
import { decodeWebText, extractWebHtml, clippedText } from './web-text.mjs';

function shape(value,allowed,required){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new CoreError('WEB_INVALID_ARGUMENTS','网页工具参数无效。');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(value).some(key=>!allowed.includes(key)||!Object.hasOwn(descriptors[key],'value'))||required.some(key=>!Object.hasOwn(value,key)))throw new CoreError('WEB_INVALID_ARGUMENTS','网页工具参数无效。');
}
const bounded=(value,fallback,min,max)=>{if(value===undefined)return fallback;if(!Number.isSafeInteger(value)||value<min||value>max)throw new CoreError('WEB_INVALID_ARGUMENTS','网页提取数量超出允许范围。');return value;};
const challenge=()=>{throw new CoreError('WEB_CHALLENGE','网站要求验证码或人工验证；本次已停止，不会绕过。',403);};
function result(value){if(Buffer.byteLength(JSON.stringify(value))>WEB_LIMITS.resultBytes)throw new CoreError('WEB_RESULT_LIMIT','网页提取结果超过 128 KiB 限制，请缩小提取长度。',413);return value;}
function searchTarget(input){
  let url;try{url=new URL(input);}catch{return null;}
  if(['duckduckgo.com','html.duckduckgo.com'].includes(url.hostname)&&url.pathname==='/l/'){
    const target=url.searchParams.get('uddg');if(!target)return null;
    try{return validateWebUrl(target).href;}catch{return null;}
  }
  if(['duckduckgo.com','html.duckduckgo.com'].includes(url.hostname))return null;
  try{return validateWebUrl(url.href).href;}catch{return null;}
}
export function createWebTools({lookup,transport,clock=()=>new Date()}={}){
  const fetchPage=createWebFetcher({lookup,transport});
  const timestamp=()=>{const value=clock();return new Date(value).toISOString();};
  return Object.freeze({
    async read(input,{signal}={}){
      shape(input,['url','maxChars'],['url']);
      const url=validateWebUrl(input.url),maxChars=bounded(input.maxChars,12000,500,WEB_LIMITS.maxChars);
      const response=await fetchPage(url.href,{signal}),text=decodeWebText(response);
      const page=response.mediaType==='text/html'?extractWebHtml(text,response.url):{title:new URL(response.url).hostname,content:text.trim(),links:[],linkOverflow:false,challenge:false};
      if(page.challenge)challenge();
      if(page.content.trim().length<20)throw new CoreError('WEB_CONTENT_UNAVAILABLE','网页没有足够的公开正文；可能依赖 JavaScript、登录或访问限制。',422);
      const clipped=clippedText(page.content,maxChars);
      return result({title:page.title||new URL(response.url).hostname,url:response.url,content:clipped.content,links:page.links,
        truncated:clipped.truncated||page.linkOverflow,fetchedAt:timestamp(),untrusted_data:true});
    },
    async search(input,{signal}={}){
      shape(input,['query','maxResults'],['query']);
      if(typeof input.query!=='string'||!input.query.trim()||input.query.length>500||!input.query.isWellFormed()||/[\x00-\x1f\x7f]/u.test(input.query))throw new CoreError('WEB_INVALID_ARGUMENTS','搜索词须为 1 到 500 个字符的有效公开文本。');
      const query=input.query.trim(),maxResults=bounded(input.maxResults,5,1,10);
      const url=new URL('https://html.duckduckgo.com/html/');url.searchParams.set('q',query);
      // Exactly one search request. Never follow/solve a search challenge or
      // automatically visit returned sites; reading a result is a separate tool.
      const response=await fetchPage(url.href,{signal,maxRedirects:0});
      if(response.mediaType!=='text/html')throw new CoreError('WEB_SEARCH_UNAVAILABLE','搜索页面没有返回可解析的 HTML；本次未重试。',502);
      const page=extractWebHtml(decodeWebText(response),response.url);
      if(page.challenge||response.status===202)challenge();
      const seen=new Set(),results=[];let truncated=Boolean(page.searchOverflow);
      for(const item of page.searchResults){
        const target=searchTarget(item.url);if(!target||seen.has(target))continue;seen.add(target);
        if(results.length>=maxResults){truncated=true;break;}
        results.push({title:item.title,url:target,snippet:item.snippet});
      }
      if(!results.length&&!/(?:no results (?:found|for)|没有找到|未找到相关结果)/iu.test(page.content))throw new CoreError('WEB_SEARCH_UNAVAILABLE','搜索结果页面不可用或格式已变化；本次未自动重试。',502);
      return result({query,results,truncated,fetchedAt:timestamp(),untrusted_data:true});
    }
  });
}
