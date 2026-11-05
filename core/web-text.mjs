// SPDX-License-Identifier: Apache-2.0
import { CoreError } from './errors.mjs';
import { validateWebUrl, WEB_LIMITS } from './web-fetch.mjs';

const fail=(code,message)=>{throw new CoreError(code,message,422);};
const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',copy:'©',reg:'®',trade:'™',bull:'•',middot:'·',lsquo:'‘',rsquo:'’',ldquo:'“',rdquo:'”'};
const entities=value=>value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/giu,(whole,key)=>{
  if(key[0]!=='#')return named[key.toLowerCase()]??whole;
  const code=key[1]?.toLowerCase()==='x'?parseInt(key.slice(2),16):parseInt(key.slice(1),10);
  return (code>=0x20||[9,10,13].includes(code))&&code!==0x7f&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'�';
});
const tidy=value=>value.replace(/[\t\r\f ]+/gu,' ').replace(/ *\n */gu,'\n').replace(/\n{3,}/gu,'\n\n').trim();
const prefix=(value,length)=>{let end=Math.min(length,value.length);if(end<value.length&&/[\uD800-\uDBFF]/u.test(value[end-1])&&/[\uDC00-\uDFFF]/u.test(value[end]))end--;return value.slice(0,end);};
const rawTags=new Set(['script','style','textarea','xmp','iframe','noembed','noframes','plaintext']);
const excluded=new Set(['head','nav','form','aside','footer','header','script','style','textarea','noscript','template','svg','math','iframe','object','canvas','button','select']);
const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const blockTags=new Set(['p','div','article','main','section','li','ul','ol','pre','blockquote','h1','h2','h3','h4','h5','h6','table','tr','td','th','br','hr']);

export function decodeWebText({bytes,contentType,mediaType}){
  let charset=contentType.match(/(?:^|;)\s*charset\s*=\s*["']?([^;\s"']+)/iu)?.[1];
  if(!charset&&mediaType==='text/html')charset=bytes.subarray(0,4096).toString('latin1').match(/<meta\s[^>]{0,1000}\bcharset\s*=\s*["']?([a-z0-9_-]+)/iu)?.[1];
  charset=(charset??'utf-8').toLowerCase();
  if(!['utf-8','utf8','us-ascii','ascii','gb18030','gbk','gb2312','big5','shift_jis','windows-1252','iso-8859-1'].includes(charset))fail('WEB_CHARSET_UNSUPPORTED','网页文本编码不受支持；没有猜测或替换乱码。');
  if(['ascii','us-ascii'].includes(charset)&&bytes.some(byte=>byte>127))fail('WEB_INVALID_TEXT','网页字节不符合其声明的 ASCII 编码。');
  let text;try{text=new TextDecoder(charset,{fatal:true}).decode(bytes);}catch{fail('WEB_INVALID_TEXT','网页包含无法可靠解码的文本；没有用乱码替代正文。');}
  if(/[\x00-\x08\x0b\x0e-\x1f\x7f]/u.test(text))fail('WEB_INVALID_TEXT','网页文本包含不支持的控制字符。');
  return text;
}
function parseTag(source){
  let index=0;while(/\s/u.test(source[index]??''))index++;
  const closing=source[index]==='/';if(closing)index++;
  const start=index;while(index<source.length&&/[a-z0-9:-]/iu.test(source[index]))index++;
  const name=source.slice(start,index).toLowerCase();if(!/^[a-z][a-z0-9:-]{0,63}$/u.test(name))return null;
  const attrs=Object.create(null);let count=0;
  while(!closing&&index<source.length){
    while(index<source.length&&(/[\s/]/u.test(source[index])))index++;
    const begin=index;while(index<source.length&&!/[\s=/>]/u.test(source[index]))index++;
    if(index===begin)break;
    const key=source.slice(begin,index).toLowerCase();while(index<source.length&&/\s/u.test(source[index]))index++;
    let value='';
    if(source[index]==='='){
      index++;while(index<source.length&&/\s/u.test(source[index]))index++;
      const quote=source[index]==='"'||source[index]==="'"?source[index++]:null,from=index;
      while(index<source.length&&(quote?source[index]!==quote:!/[\s>]/u.test(source[index])))index++;
      value=entities(source.slice(from,index));if(quote&&source[index]===quote)index++;
    }
    if(++count>256)fail('WEB_PARSE_LIMIT','网页标签属性过多，已停止提取。');
    if(['href','class','id','hidden','aria-hidden','style','src','action'].includes(key)&&!Object.hasOwn(attrs,key))attrs[key]=value;
  }
  return{name,closing,attrs,selfClosing:/\/\s*$/u.test(source)};
}
/** Bounded text scanner only: no DOM, JavaScript, stylesheet, iframe or resource execution. */
export function extractWebHtml(html,baseUrl){
  const lower=html.toLowerCase(),stack=[],text=[],titles=[],links=[],searchResults=[];
  let index=0,tokens=0,linkOverflow=false,searchOverflow=false,challenge=false,latestSearchResult=null;
  const safeLink=href=>{try{const candidate=new URL(href,baseUrl);candidate.hash='';return validateWebUrl(candidate.href).href;}catch{return null;}};
  function close(frame){
    if(frame.title)titles.push(tidy(frame.parts.join('')));
    if(frame.anchor&&!frame.suppressed){
      const title=prefix(tidy(frame.parts.join('')),200),url=safeLink(frame.href);
      if(url&&title){if(links.length<WEB_LIMITS.links)links.push({title,url});else linkOverflow=true;}
      if(frame.result){
        latestSearchResult=null;
        if(title&&url){if(searchResults.length<50){latestSearchResult={title,url,snippet:''};searchResults.push(latestSearchResult);}else searchOverflow=true;}
      }
    }
    if(frame.snippet&&!frame.suppressed&&latestSearchResult)latestSearchResult.snippet=prefix(tidy(frame.parts.join('')),500);
  }
  function emit(value){
    const decoded=entities(value).replace(/\s+/gu,' ');
    for(const frame of stack)if((frame.title||!stack.at(-1)?.suppressed&&(frame.anchor||frame.snippet))&&frame.captured<2048){const part=prefix(decoded,2048-frame.captured);frame.parts.push(part);frame.captured+=part.length;}
    if(!stack.at(-1)?.suppressed&&!stack.some(frame=>frame.title))text.push(decoded);
  }
  while(index<html.length){
    if(++tokens>100000)fail('WEB_PARSE_LIMIT','网页结构过于复杂，已停止提取。');
    const open=html.indexOf('<',index);
    if(open<0){emit(html.slice(index));break;}
    emit(html.slice(index,open));
    if(html.startsWith('<!--',open)){const end=html.indexOf('-->',open+4);index=end<0?html.length:end+3;continue;}
    let end=open+1,quote=null;
    for(;end<html.length;end++){
      const char=html[end];if(quote){if(char===quote)quote=null;}else if(char==='"'||char==="'")quote=char;else if(char==='>')break;
      if(end-open>16384)fail('WEB_PARSE_LIMIT','网页单个标签过长，已停止提取。');
    }
    if(end>=html.length){break;}
    index=end+1;const tag=parseTag(html.slice(open+1,end));if(!tag)continue;
    const {name,attrs}=tag;
    if(tag.closing){
      const match=stack.findLastIndex(frame=>frame.name===name);
      if(match>=0)while(stack.length>match)close(stack.pop());
      if(blockTags.has(name)&&!stack.at(-1)?.suppressed)text.push('\n');continue;
    }
    if(Object.values(attrs).some(value=>/(?:anomaly\.js|challenge-platform|cf-chl-|g-recaptcha|h-captcha|captcha-form)/iu.test(value)))challenge=true;
    if(rawTags.has(name)){
      const needle='</'+name;let position=index;
      for(;;){position=lower.indexOf(needle,position);if(position<0){index=html.length;break;}if(/[\s/>]/u.test(html[position+needle.length]??'')){index=position;break;}position+=needle.length;}
      continue;
    }
    const classes=(attrs.class??'').split(/\s+/u);
    const suppressed=Boolean(stack.at(-1)?.suppressed||excluded.has(name)||Object.hasOwn(attrs,'hidden')||attrs['aria-hidden']==='true'||/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/iu.test(attrs.style??''));
    if(blockTags.has(name)&&!suppressed)text.push('\n');
    const frame={name,suppressed,title:name==='title',anchor:name==='a',href:attrs.href??'',result:classes.includes('result__a'),snippet:classes.includes('result__snippet'),parts:[],captured:0};
    if(tag.selfClosing||voidTags.has(name)){close(frame);continue;}
    if(stack.length>=256)fail('WEB_PARSE_LIMIT','网页嵌套过深，已停止提取。');stack.push(frame);
  }
  while(stack.length)close(stack.pop());
  const content=tidy(text.join(''));
  if(/(?:please verify (?:that )?you are (?:a )?human|verify you are human|unusual traffic|automated requests.{0,200}blocked|请完成.{0,12}验证码)/iu.test(content))challenge=true;
  return{title:prefix(titles.find(Boolean)??'',200),content,links,searchResults,linkOverflow,searchOverflow,challenge};
}
export function clippedText(value,maxChars){return{content:prefix(value,maxChars),truncated:value.length>maxChars};}
