import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { skillRegistry as defaultSkillRegistry, createSkillRegistry } from './skills.mjs';
import { createComputerWorkspace } from '../core/computer-workspace.mjs';
import { acquireDataLock } from './lock.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { testProvider, validateProvider } from '../core/providers.mjs';
import { diagnoseProvider } from '../core/provider-diagnostics.mjs';
import { paginateToolArtifact, TOOL_ARTIFACT_LIMITS } from '../core/tool-artifacts.mjs';
import { previewConversationBranch, prepareConversationBranch, validateBranchRequest } from '../core/conversation-branch.mjs';
import { previewConversationHandoff, prepareConversationHandoff, validateHandoffRequest, validateContextHandoff, handoffRequestHash } from '../core/conversation-handoff.mjs';
import { createWorkspaceSearch } from './workspace-search.mjs';
import { createManualFileEditor, FILE_EDIT_BODY_BYTES } from './manual-file-edit.mjs';
import { createProviderDiagnostics, validateProviderDiagnosticsRequest } from './provider-diagnostics.mjs';
import { createSummaryDraftRunner } from './summary-drafts.mjs';
import { planSummaryDraft, validateSummaryPreviewRequest, validateSummaryRequest, summaryRequestHash, createSummaryDraft, generateSummaryDraft, interruptSummaryDraft } from '../core/summary-draft.mjs';
import { CoreError, publicError } from '../core/errors.mjs';
import { DRAFT_LIMITS, validateDraftList, validateDraftSnapshot } from '../public/composer-drafts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.1.0';
const ACTIVE = new Set(['running', 'awaiting_approval']);
const MAX_BODY = 1024 * 1024;
const COOKIE = 'openaster_session';
const STORAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.woff2':'font/woff2' };

function error(status, code, message) { return Object.assign(new Error(message), {status, code}); }
function equal(a, b) { return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function textField(value, name, max, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0') || !value.isWellFormed()) throw error(400,'INVALID_INPUT',`${name}须为有效文本，不能为空，且最多 ${max} 个字符。`);
  return value.trim();
}
async function body(req, { maxBytes = MAX_BODY, strictUTF8 = false } = {}) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw error(415,'CONTENT_TYPE','请使用 application/json。');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw error(415,'CONTENT_ENCODING','不支持压缩请求。');
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw error(413,'BODY_TOO_LARGE',maxBytes===MAX_BODY?'请求内容超过 1 MiB 限制。':`请求内容超过 ${maxBytes / 1024} KiB 限制。`);
    chunks.push(chunk);
  }
  try { const bytes=Buffer.concat(chunks);const value=JSON.parse(strictUTF8?new TextDecoder('utf-8',{fatal:true}).decode(bytes):bytes.toString('utf8')); if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw error(400,'INVALID_JSON','请求必须是有效的 JSON 对象。'); }
}
function json(res,status,value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); }
function draftError(cause) {
  const messages = {
    DRAFT_CONFLICT: [409, '草稿已在其他窗口更新，请重新读取后再保存。'],
    DRAFT_LIMIT: [413, '草稿数量或内容超过本机保存上限。'],
    INVALID_DRAFT: [400, '草稿内容格式无效。'],
    INVALID_DRAFT_SNAPSHOT: [400, '草稿快照格式无效。'],
    INVALID_DRAFT_SCOPE: [400, '草稿数据身份无效。'],
    INVALID_DRAFT_REVISION: [400, '草稿版本无效。'],
  };
  const code=typeof cause?.code==='string'&&Object.hasOwn(messages,cause.code)?cause.code:'DRAFT_STORAGE_UNAVAILABLE';
  const [status,message]=messages[code]??[503,'本机草稿暂时无法读取或保存；请保留编辑内容，勿自动覆盖。'];
  return error(status,code,message);
}
function workspaceQuery(url) {
  const invalid=()=>error(400,'INVALID_WORKSPACE_QUERY','目录浏览仅接受 path、includeGenerated 和 includeIgnored；开关必须为 true 或 false，参数不能重复。');
  // URLSearchParams replaces malformed UTF-8; reject it before paths are decoded.
  try { for(const part of url.search.slice(1).split('&'))decodeURIComponent(part.replace(/\+/g,' ')); } catch { throw invalid(); }
  const seen=new Set();
  for(const [name] of url.searchParams) {
    if(!['path','includeGenerated','includeIgnored'].includes(name)||seen.has(name))throw invalid();
    seen.add(name);
  }
  const generated=url.searchParams.get('includeGenerated'),ignored=url.searchParams.get('includeIgnored');
  for(const value of [generated,ignored])if(value!==null&&!['true','false'].includes(value))throw invalid();
  return {path:url.searchParams.get('path')??'',includeGenerated:generated==='true',includeIgnored:ignored==='true'};
}
function historyQuery(url, detail=false) {
  const invalid=()=>error(400,'INVALID_HISTORY_QUERY','执行记录仅接受 limit 和 cursor；limit 须为 1 到 50 的整数，参数不能重复。');
  try { for(const part of url.search.slice(1).split('&'))decodeURIComponent(part.replace(/\+/g,' ')); } catch { throw invalid(); }
  const seen=new Set();
  for(const [name] of url.searchParams) {
    if(detail||!['limit','cursor'].includes(name)||seen.has(name))throw invalid();
    seen.add(name);
  }
  const limit=url.searchParams.get('limit'),cursor=url.searchParams.get('cursor');
  if(limit!==null&&(!/^[1-9]\d?$/u.test(limit)||Number(limit)>50))throw invalid();
  if(cursor!==null&&(!cursor||cursor.length>1024))throw error(400,'INVALID_CURSOR','执行记录分页位置无效，请刷新记录。');
  return {limit:limit===null?10:Number(limit),cursor};
}
function usageQuery(url) {
  const invalid=()=>error(400,'INVALID_USAGE_QUERY','用量概览仅接受 limit 和 cursor；limit 须为 1 到 50 的整数，参数不能重复。');
  try { for(const part of url.search.slice(1).split('&'))decodeURIComponent(part.replace(/\+/g,' ')); } catch { throw invalid(); }
  const seen=new Set();
  for(const [name] of url.searchParams) { if(!['limit','cursor'].includes(name)||seen.has(name))throw invalid(); seen.add(name); }
  const limit=url.searchParams.get('limit'),cursor=url.searchParams.get('cursor');
  if(limit!==null&&(!/^[1-9]\d?$/u.test(limit)||Number(limit)>50))throw invalid();
  if(cursor!==null&&(!cursor||cursor.length>1024))throw error(400,'INVALID_USAGE_CURSOR','用量分页位置无效，请重新加载概览。');
  return {limit:limit===null?20:Number(limit),cursor};
}
function historyId(encoded) {
  let value;
  try { value=decodeURIComponent(encoded); } catch { throw error(400,'INVALID_PATH','无效地址。'); }
  if(!value||value.length>200||/[\/\\\x00-\x1f\x7f]/u.test(value))throw error(400,'INVALID_PATH','无效地址。');
  return value;
}
function branchQuery(url, preview) {
  const invalid=()=>error(400,'INVALID_BRANCH_QUERY','分支预览仅接受一个 messageId；创建分支不接受查询参数。');
  try { for(const part of url.search.slice(1).split('&'))decodeURIComponent(part.replace(/\+/g,' ')); } catch { throw invalid(); }
  const pairs=[...url.searchParams];
  if(!preview) {if(pairs.length)throw invalid();return;}
  if(pairs.length!==1||pairs[0][0]!=='messageId'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(pairs[0][1]))throw invalid();
  return pairs[0][1];
}
function artifactQuery(url) {
  const invalid=()=>error(400,'INVALID_ARTIFACT_QUERY','工具结果仅接受 offset 和 maxBytes；参数须为整数且不能重复。');
  try { for(const part of url.search.slice(1).split('&'))decodeURIComponent(part.replace(/\+/g,' ')); } catch { throw invalid(); }
  const seen=new Set();
  for(const [name,value] of url.searchParams) {
    if(!['offset','maxBytes'].includes(name)||seen.has(name)||!/^(?:0|[1-9]\d{0,9})$/u.test(value))throw invalid();
    seen.add(name);
  }
  const offset=Number(url.searchParams.get('offset')??0),maxBytes=Number(url.searchParams.get('maxBytes')??TOOL_ARTIFACT_LIMITS.pageBytes);
  if(offset>TOOL_ARTIFACT_LIMITS.maxBytes||maxBytes<4||maxBytes>TOOL_ARTIFACT_LIMITS.maxPageBytes)throw invalid();
  return {offset,maxBytes};
}
function cookieValue(req) { return (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1); }
function normalizeOrigin(input, label) {
  try { const u=new URL(input); if (u.protocol!=='https:' || u.username || u.password || u.pathname!=='/' || u.search || u.hash) throw new Error(); return u.origin; }
  catch { throw error(400,'INVALID_GATEWAY',`${label}必须是没有路径的 HTTPS 地址。`); }
}

export async function startServer(options={}) {
  const port=options.port ?? 0;
  const host=options.host ?? '127.0.0.1';
  if (!['127.0.0.1','::1','localhost'].includes(host)) throw error(400,'LOOPBACK_ONLY','服务仅允许监听回环地址。远程使用请配置 HTTPS 反向代理。');
  const providerDiagnostics=createProviderDiagnostics(options.providerDiagnosticsOptions);
  const summaryDrafts=createSummaryDraftRunner(options.summaryDraftOptions);
  if(options.summaryDraftOptions?.providerCall!==undefined&&typeof options.summaryDraftOptions.providerCall!=='function')throw new TypeError('Invalid summary provider call');
  const dataDir=resolve(options.dataDir ?? process.env.OPENASTER_DATA_DIR ?? join(ROOT,'.openaster'));
  const workspacePath=resolve(options.workspace ?? process.env.OPENASTER_WORKSPACE ?? join(dataDir,'workspace'));
  // Workspace may be under dataDir, but cannot contain credentials/database/application files.
  const within=(parent,child)=>child===parent || child.startsWith(parent + (process.platform==='win32'?'\\':'/'));
  const canonical=p=>process.platform==='win32'?p.toLowerCase():p;
  const reserved=['server','core','public','desktop','mobile','scripts','tests','docs'].map(name=>canonical(join(ROOT,name)));
  if(canonical(dataDir)===canonical(ROOT)||reserved.some(folder=>within(folder,canonical(dataDir))||within(canonical(dataDir),folder)))throw error(400,'UNSAFE_DATA_DIR','应用数据必须存放在独立目录。');
  const lexicalDedicated=canonical(join(dataDir,'workspace'));
  if((within(canonical(ROOT),canonical(workspacePath))||within(canonical(dataDir),canonical(workspacePath)))&&!within(lexicalDedicated,canonical(workspacePath)))throw error(400,'UNSAFE_WORKSPACE','工作区不能指向源码或凭据存储。');
  if (within(canonical(workspacePath),canonical(dataDir)) || within(canonical(workspacePath),canonical(join(ROOT,'server'))) || within(canonical(workspacePath),canonical(join(ROOT,'core')))) throw error(400,'UNSAFE_WORKSPACE','请选择独立工作区，不能包含应用源码或应用数据目录。');
  const gatewayOrigin=options.gatewayOrigin ? normalizeOrigin(options.gatewayOrigin,'网关地址') : null;
  const deviceDraftStore=options.deviceDraftStore;
  if(deviceDraftStore!==undefined) {
    if(!deviceDraftStore||typeof deviceDraftStore!=='object'||['read','compareAndSwap','drain','close'].some(name=>typeof deviceDraftStore[name]!=='function'))throw error(400,'INVALID_DEVICE_DRAFT_STORE','本机草稿存储配置无效。');
    if(gatewayOrigin)throw error(400,'DEVICE_DRAFTS_LOCAL_ONLY','本机未发送草稿不能通过远程网关保存。');
  }
  const gatewayToken=options.token;
  if (gatewayOrigin && (typeof gatewayToken!=='string' || gatewayToken.length<32 || gatewayToken.length>512 || /[\s\x00-\x1f]/.test(gatewayToken))) throw error(400,'INVALID_TOKEN','远程网关需要至少 32 字符的独立访问令牌。');
  const mobileOrigins = new Set(options.allowedOrigins ?? []);
  for (const origin of mobileOrigins) if (!['capacitor://localhost','https://localhost','http://localhost'].includes(origin)) normalizeOrigin(origin,'客户端来源');
  await mkdir(dataDir,{recursive:true,mode:0o700});
  if(options.workspaceOptions?.createRoot!==false)await mkdir(workspacePath,{recursive:true,mode:0o700});
  if((await lstat(dataDir)).isSymbolicLink())throw error(400,'UNSAFE_DATA_DIR','数据目录不能是符号链接。');
  const realWorkspace=canonical(await realpath(workspacePath));
  const realData=canonical(await realpath(dataDir));const realRoot=canonical(await realpath(ROOT));const dedicated=canonical(join(realData,'workspace'));
  if(within(realWorkspace,realData)||within(realWorkspace,realRoot)||((within(realData,realWorkspace)||within(realRoot,realWorkspace))&&!within(dedicated,realWorkspace)))throw error(400,'UNSAFE_WORKSPACE','请选择独立工作区，不能访问应用数据或源码。');
  const releaseLock=await acquireDataLock(dataDir);
  let store;
  try{store=new Store(dataDir);store.getStorageIdentity();}catch(e){store?.close();await releaseLock();throw e;}
  let workspace;
  const skillsDirectory=resolve(options.skillsDirectory??join(ROOT,'skills'));
  const skillRegistry=options.skillsDirectory?createSkillRegistry(skillsDirectory):defaultSkillRegistry;
  // Startup validates the root boundary without requiring a successful discovery
  // scan. An unreadable ignore policy must remain visible and recoverable in the
  // file panel, where the user can explicitly include ignored entries.
  try{workspace=createWorkspace(workspacePath,options.workspaceOptions);await workspace.getIdentity();await skillRegistry.catalog();}catch(e){store.close();await releaseLock();throw e;}
  const workspaceSearch=createWorkspaceSearch(workspace);
  const directoryReads=new Set();
  const indexReads=new Set();
  const draftOperations=new Set();
  const secrets=new Map();
  const secretStore=options.secretStore ?? {get:id=>secrets.get(id),set:(id,value)=>secrets.set(id,value),delete:id=>secrets.delete(id)};
  const clients=new Set(); const logins=new Map(); const rateBuckets=new Map(); const providerMutations=new Set(); const providerReads=new Map(); const branchSources=new Set(); const summarySources=new Set();
  const assertProviderAvailable=id=>{if(providerMutations.has(id))throw error(409,'PROVIDER_BUSY','模型连接正在更新，请稍后重试。');};
  const csrfRemote=randomBytes(32).toString('hex');
  let origin; let closing=false; let closePromise; let pendingRequests=0;
  const unrequestedSockets=new Set();let transportClosing=false;
  const send=(event,data)=> {
    const payload=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) { if (client.writableLength>256*1024 || client.destroyed) { client.destroy(); clients.delete(client); } else client.write(payload); }
  };
  const audit=entry=>{ store.audit(entry); };
  const manualFileEditor=createManualFileEditor({workspace,storageId:()=>store.getStorageIdentity(),audit,onSaved:()=>send('state',{})});
  const withProviderRead=async (id,operation)=> {
    providerReads.set(id,(providerReads.get(id)||0)+1);
    try{return await operation();}
    finally{const remaining=providerReads.get(id)-1;if(remaining)providerReads.set(id,remaining);else providerReads.delete(id);}
  };
  const readSecret=id=>withProviderRead(id,()=>secretStore.get(id));
  const providerWithSecret=async id=> {
    assertProviderAvailable(id);
    const p=store.getProvider(id); if (!p) throw error(404,'PROVIDER_NOT_FOUND','模型连接不存在。');
    if(p.enabled===false)throw error(409,'PROVIDER_DISABLED','该模型连接已停用，请核对配置后在设置中启用。');
    return {...p,apiKey:p.envKey?process.env[p.envKey]:await readSecret(id)};
  };
  const publicProviders=async()=>Promise.all(store.listProviders().map(async p=>{let hasKey=false;try{hasKey=Boolean(p.envKey?process.env[p.envKey]:await readSecret(p.id));}catch{} return {...p,hasKey};}));
  let fileAccess='workspace'; // Explicit grant lasts only for this service session.
  let workspaceActionPending=false;
  const agentWorkspace=createComputerWorkspace({workspace,getFileAccess:()=>fileAccess,protectedRoots:[dataDir,ROOT]});
  const runtime=createRuntime({workspace:agentWorkspace,skillRegistry,providers:providerWithSecret,getSession:async id=>store.getSession(id),saveSession:async(session,metadata)=>store.putSession(session,metadata),reserveArtifact:request=>store.reserveArtifact(request),releaseArtifact:token=>store.releaseArtifact(token),emit:({sessionId,type,runId,stepId})=>type==='stream'?send('stream',{sessionId,runId,stepId}):send('update',{sessionId}),audit,createId:randomUUID,...options.runtimeOptions});
  const state=async()=>({version:VERSION,capabilities:{contextFiles:1,toolArtifacts:1,usageOverview:1,conversationBranch:1,conversationHandoff:1,handoffDraft:1,workspaceSearch:1,workspaceIgnore:1,workspaceDirectory:1,workspaceEdit:1,providerDiagnostics:1,permissions:1,progressiveSkills:1,images:1,...(options.workspaceActions&&!gatewayOrigin?{workspaceActions:1}:{}),...(deviceDraftStore?{deviceDrafts:1}:{})},workspace:{id:options.workspaceId??null,storageId:store.getStorageIdentity(),name:options.workspaceName??'我的工作区',path:workspacePath,skillsPath:skillsDirectory,projectMode:options.workspaceOptions?.projectScan===true,sensitiveFilesExcluded:options.workspaceOptions?.denySensitivePaths===true},providers:await publicProviders(),sessions:store.listSessionSummaries(),skills:await skillRegistry.catalog(),security:{localOnly:!gatewayOrigin,approvalsRequired:true,shellEnabled:true,fileAccess,fileAccessLifetime:'service-session',computerAccessAvailable:!gatewayOrigin,keyStorage:options.secretStore?'os-encrypted':'memory-only',gatewayEnabled:Boolean(gatewayOrigin),telemetry:false}});
  async function draftOperation(operation) {
    if(closing)throw error(503,'SHUTTING_DOWN','服务正在停止，未开始保存草稿。');
    const work=Promise.resolve().then(operation);draftOperations.add(work);
    try {
      const snapshot=await work;
      try{return validateDraftSnapshot(snapshot);}catch{throw error(503,'DRAFT_STORAGE_UNAVAILABLE','本机草稿暂时无法读取或保存；请保留编辑内容，勿自动覆盖。');}
    } catch(cause) {throw draftError(cause);}
    finally {draftOperations.delete(work);}
  }
  function draftStorageId(value) {
    if(typeof value!=='string'||!STORAGE_ID.test(value))throw error(400,'INVALID_DRAFT_SCOPE','请提供有效的当前工作区数据身份。');
    const current=store.getStorageIdentity();
    if(value!==current)throw error(409,'DRAFT_CONTEXT_CHANGED','工作区数据身份已改变，未读取或保存草稿，请重新加载。');
    return current;
  }
  const requireSession=id=>{const s=store.getSession(id);if(!s) throw error(404,'SESSION_NOT_FOUND','任务不存在。');return s;};
  const assertIdle=(s,{allowSummary=false}={})=>{if(!allowSummary&&summarySources.has(s.id))throw error(409,'SUMMARY_SOURCE_BUSY','正在根据此任务生成摘要，请停止或等待完成。');if(branchSources.has(s.id))throw error(409,'BRANCH_SOURCE_BUSY','正在从此任务创建关联任务，请稍后重试。');if(runtime.isActive(s.id)||ACTIVE.has(s.run?.status)) throw error(409,'RUN_ACTIVE','请先停止正在运行的任务。');};
  function startSummary(plan,request) {
    if(closing)throw error(503,'SHUTTING_DOWN','服务正在停止，未开始摘要生成。');
    if(summaryDrafts.active)throw error(429,'SUMMARY_DRAFT_BUSY','另一次摘要生成尚未结束，请停止或等待完成。');
    // This durable receipt precedes credential access and every model request.
    // No await separates the availability check, receipt, and owned operation.
    const initial=store.putSummaryDraft(createSummaryDraft(plan,request),{createOnly:true});
    const sessionId=initial.sessionId;summarySources.add(sessionId);
    summaryDrafts.start(initial.id,signal=>withProviderRead(request.providerId,async()=>{
      let current=initial;
      const checkpoint=async value=>{current=store.putSummaryDraft(value);try{send('summary',{sessionId,id:initial.id});}catch{/* Durable state remains readable. */}};
      try {
        const provider=await providerWithSecret(request.providerId);
        signal.throwIfAborted();
        await generateSummaryDraft(plan,provider,{draft:initial,signal,checkpoint,...(options.summaryDraftOptions?.providerCall?{providerCall:options.summaryDraftOptions.providerCall}:{})});
      } catch(cause) {
        if(current.status!=='running')return;
        const reason=signal.aborted?signal.reason:cause;
        const failure=reason instanceof CoreError?publicError(reason):{code:signal.aborted?'CANCELLED':'SUMMARY_DRAFT_FAILED',message:signal.aborted?'摘要生成已取消；已发出的请求仍可能计费。':'摘要生成未完成，请检查模型连接或本地数据保存状态。'};
        const stopped=interruptSummaryDraft(current,failure);
        if(!signal.aborted)stopped.status='failed';
        await checkpoint(stopped);
      } finally {summarySources.delete(sessionId);try{send('state',{});}catch{/* Best-effort notification. */}}
    }));
    return initial;
  }
  const getAuth=req=> {
    const authorization=req.headers.authorization;
    if (gatewayOrigin && authorization?.startsWith('Bearer ') && equal(authorization.slice(7),gatewayToken)) return {csrfToken:csrfRemote,remote:true};
    if (gatewayOrigin) return null;
    const id=cookieValue(req); const session=logins.get(id);
    if (!session || session.expires<Date.now()) {if(id) logins.delete(id);return null;}
    return session;
  };
  const server=http.createServer(async(req,res)=> {
    unrequestedSockets.delete(req.socket);
    // Count handlers, not open SSE connections. A directory switch must not race
    // a request waiting for its body or an asynchronous credential operation.
    pendingRequests++;
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy','same-origin');
    const connectSources=["'self'",...(gatewayOrigin?[gatewayOrigin]:[])].join(' ');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src ${connectSources}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'; manifest-src 'self'`);
    try {
      if(closing) throw error(503,'SHUTTING_DOWN','服务正在停止。');
      const allowedHosts=new Set([new URL(origin).host,`localhost:${server.address().port}`,`127.0.0.1:${server.address().port}`,`[::1]:${server.address().port}`,...(gatewayOrigin?[new URL(gatewayOrigin).host]:[])]);
      if(!allowedHosts.has(req.headers.host?.toLowerCase())) throw error(403,'INVALID_HOST','请求主机不受信任。');
      const requestOrigin=req.headers.origin;
      const localOrigins=new Set([origin,`http://localhost:${server.address().port}`,`http://127.0.0.1:${server.address().port}`,`http://[::1]:${server.address().port}`]);
      const originAllowed=!requestOrigin || localOrigins.has(requestOrigin) || (gatewayOrigin && (requestOrigin===gatewayOrigin || mobileOrigins.has(requestOrigin)));
      if(!originAllowed || (!gatewayOrigin && ['cross-site'].includes(req.headers['sec-fetch-site']))) throw error(403,'INVALID_ORIGIN','请求来源不受信任。');
      if(gatewayOrigin && requestOrigin && (mobileOrigins.has(requestOrigin) || requestOrigin===gatewayOrigin)) {res.setHeader('Access-Control-Allow-Origin',requestOrigin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-CSRF-Token');res.setHeader('Access-Control-Allow-Methods','GET, POST, PATCH, DELETE, OPTIONS');}
      if(req.method==='OPTIONS') {res.writeHead(204);return res.end();}
      const url=new URL(req.url,origin); const path=url.pathname; const method=req.method;
      if(path==='/api/health' && method==='GET') return json(res,200,{ok:true,version:VERSION});
      if(path==='/api/bootstrap' && method==='GET') {
        let auth=getAuth(req);
        if(!auth) {
          if(gatewayOrigin) throw error(401,'UNAUTHORIZED','请输入网关访问令牌。');
          for(const [id,entry] of logins) if(entry.expires<Date.now()) logins.delete(id);
          if(logins.size>=128) throw error(429,'SESSION_RATE_LIMIT','客户端连接过多，请稍后重试。');
          const token=randomBytes(32).toString('hex');auth={csrfToken:randomBytes(32).toString('hex'),expires:Date.now()+12*60*60*1000};logins.set(token,auth);
          res.setHeader('Set-Cookie',`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
        }
        return json(res,200,{...await state(),csrfToken:auth.csrfToken});
      }
      if(path.startsWith('/api/')) {
        const auth=getAuth(req);if(!auth) throw error(401,'UNAUTHORIZED','连接已失效，请刷新页面或重新连接网关。');
        if(!['GET','HEAD'].includes(method)) {
          if(!equal(req.headers['x-csrf-token'],auth.csrfToken)) throw error(403,'CSRF','安全令牌已失效，请刷新页面。');
          const key=auth.csrfToken;let rate=rateBuckets.get(key);if(!rate || rate.until<Date.now()) {rate={count:0,until:Date.now()+60000};rateBuckets.set(key,rate);} if(++rate.count>180) throw error(429,'RATE_LIMIT','操作过于频繁，请稍后重试。');
        }
        if(path==='/api/state' && method==='GET') return json(res,200,await state());
        const skillView=path.match(/^\/api\/skills\/([a-z0-9_-]+)$/u);
        if(skillView&&method==='GET')return json(res,200,{skill:await skillRegistry.load(skillView[1])});
        if(path==='/api/permissions'&&['GET','PUT'].includes(method)) {
          if(method==='GET')return json(res,200,{fileAccess,lifetime:'service-session',computerAccessAvailable:!gatewayOrigin,shellApproval:'every-command'});
          if(gatewayOrigin)throw error(403,'LOCAL_PERMISSION_REQUIRED','电脑文件访问权限只能在本机工作台设置。');
          const value=await body(req);
          if(Object.keys(value).some(key=>!['fileAccess','confirmComputerAccess'].includes(key))||!['workspace','computer'].includes(value.fileAccess))throw error(400,'INVALID_PERMISSION','请选择工作区文件或电脑文件访问。');
          if(value.fileAccess==='computer'&&value.confirmComputerAccess!==true)throw error(400,'PERMISSION_CONFIRMATION_REQUIRED','请明确确认电脑文件可能被读取并发送给所选模型。');
          if(runtime.hasActiveRuns()||store.listSessionSummaries().some(session=>ACTIVE.has(session.run?.status)))throw error(409,'PERMISSION_BUSY','请先停止正在运行或等待批准的任务，再修改访问权限。');
          audit({action:'permissions.changed',detail:{from:fileAccess,to:value.fileAccess,lifetime:'service-session'}});
          fileAccess=value.fileAccess;send('state',{});
          return json(res,200,{fileAccess,lifetime:'service-session',computerAccessAvailable:true,shellApproval:'every-command'});
        }
        if(['/api/workspace/open','/api/workspace/create'].includes(path)&&method==='POST') {
          if(gatewayOrigin||!options.workspaceActions)throw error(409,'DESKTOP_REQUIRED','请在桌面应用中打开或新建项目；命令行可通过 OPENASTER_WORKSPACE 指定目录。');
          const value=await body(req);if(Object.keys(value).length)throw error(400,'INVALID_WORKSPACE_ACTION','项目操作不接受远程路径参数，请使用本机目录选择器。');
          const action=path.endsWith('/create')?'create':'open';
          if(typeof options.workspaceActions[action]!=='function')throw error(409,'DESKTOP_REQUIRED','本机项目选择器尚不可用。');
          if(workspaceActionPending)throw error(409,'WORKSPACE_BUSY','项目操作已经打开，请完成或取消当前选择。');
          workspaceActionPending=true;
          // A native workspace switch closes this server. Schedule only after the
          // HTTP response finishes so the current request cannot block its idle gate.
          res.once('finish',()=>setImmediate(()=>Promise.resolve().then(()=>options.workspaceActions[action]()).catch(()=>{}).finally(()=>{workspaceActionPending=false;})));
          return json(res,202,{ok:true,action});
        }
        if(path==='/api/device-drafts'&&deviceDraftStore&&['GET','POST'].includes(method)) {
          if(url.search)throw error(400,'INVALID_DRAFT_QUERY','本机草稿端点不接受查询参数。');
          if(method==='GET') {
            const storageId=draftStorageId(req.headers['x-openaster-storage-id']);
            const snapshot=await draftOperation(()=>deviceDraftStore.read(storageId));
            return json(res,200,{storageId,snapshot});
          }
          const value=await body(req,{maxBytes:DRAFT_LIMITS.snapshotBytes+1024,strictUTF8:true});
          if(Object.keys(value).length!==3||!['storageId','expectedRevision','drafts'].every(key=>Object.hasOwn(value,key)))throw error(400,'INVALID_DRAFT_REQUEST','草稿保存仅接受 storageId、expectedRevision 和 drafts。');
          const storageId=draftStorageId(value.storageId);
          if(value.expectedRevision!=='0'&&(typeof value.expectedRevision!=='string'||!STORAGE_ID.test(value.expectedRevision)))throw error(400,'INVALID_DRAFT_REVISION','草稿版本无效。');
          let drafts;try{drafts=validateDraftList(value.drafts);}catch(cause){throw draftError(cause);}
          const snapshot=await draftOperation(()=>deviceDraftStore.compareAndSwap(storageId,value.expectedRevision,drafts));
          return json(res,200,{storageId,snapshot});
        }
        if(path==='/api/usage' && method==='GET') return json(res,200,store.getUsageOverview(usageQuery(url)));
        if(path==='/api/events' && method==='GET') {
          if(clients.size>=64) throw error(429,'TOO_MANY_STREAMS','实时连接过多。');
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('event: state\ndata: {}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;
        }
        if(path==='/api/providers' && method==='POST') {
          const value=await body(req);if(store.listProviders().length>=40) throw error(409,'PROVIDER_LIMIT','最多配置 40 个模型连接。');
          const p={id:randomUUID(),name:textField(value.name,'名称',80),type:textField(value.type,'接口类型',30),baseUrl:textField(value.baseUrl,'API 地址',2048),model:textField(value.model,'模型 ID',200),enabled:true};
          if(!['openai','responses','anthropic','ollama'].includes(p.type)) throw error(400,'PROVIDER_TYPE','请选择受支持的接口协议。');
          if(value.envKey!==undefined) {if(typeof value.envKey!=='string' || !/^OPENASTER_KEY_[A-Z0-9_]{1,80}$/.test(value.envKey)) throw error(400,'ENV_KEY','环境变量必须以 OPENASTER_KEY_ 开头。');p.envKey=value.envKey;}
          if(value.tokenParameter!==undefined)p.tokenParameter=value.tokenParameter;
          if(value.maxTokens!==undefined)p.maxTokens=value.maxTokens;
          if(value.streaming!==undefined)p.streaming=value.streaming;
          p.toolMode=value.toolMode===undefined?'workspace':value.toolMode;
          Object.assign(p,validateProvider(p));
          if(value.apiKey!==undefined && value.apiKey!=='') {if(typeof value.apiKey!=='string'||value.apiKey.length>4096||/[\r\n\x00]/.test(value.apiKey)) throw error(400,'API_KEY','API Key 格式不正确。');try{await secretStore.set(p.id,value.apiKey);}catch{throw error(503,'KEY_STORAGE','系统密钥存储不可用，未保存连接。请检查系统密钥环。');}}
          store.putProvider(p);audit({action:'provider.created',detail:`${p.name} (${p.type})`});send('state',{});return json(res,201,{provider:(await publicProviders()).find(x=>x.id===p.id)});
        }
        const providerMatch=path.match(/^\/api\/providers\/([^/]+)(\/test|\/diagnostics)?$/);
        if(providerMatch) {
          const [,id,test]=providerMatch;const p=store.getProvider(id);if(!p) throw error(404,'PROVIDER_NOT_FOUND','模型连接不存在。');
          assertProviderAvailable(id);
          const changing=!test&&['PATCH','DELETE'].includes(method);
          if(changing&&providerReads.has(id))throw error(409,'PROVIDER_BUSY','模型连接正在检查或准备任务，请稍后重试。');
          if(changing)providerMutations.add(id);
          try {
          if(!test && method==='PATCH') {
            if(id==='demo')throw error(400,'BUILTIN_PROVIDER','内置演示不能修改。');
            if(store.listSessionSummaries().some(s=>s.providerId===id&&(branchSources.has(s.id)||runtime.isActive(s.id)||ACTIVE.has(s.run?.status))))throw error(409,'PROVIDER_IN_USE','请先停止使用该模型的任务。');
            const value=await body(req);const next={...p};
            for(const [key,label,limit]of [['name','名称',80],['type','接口类型',30],['baseUrl','API 地址',2048],['model','模型 ID',200]])if(value[key]!==undefined)next[key]=textField(value[key],label,limit);
            if(!['openai','responses','anthropic','ollama'].includes(next.type))throw error(400,'PROVIDER_TYPE','请选择受支持的接口协议。');
            if(value.tokenParameter!==undefined)next.tokenParameter=value.tokenParameter;
            if(value.maxTokens!==undefined)next.maxTokens=value.maxTokens;
            if(value.streaming!==undefined)next.streaming=value.streaming;
            if(value.toolMode!==undefined)next.toolMode=value.toolMode;
            if(value.enabled!==undefined) {
              if(typeof value.enabled!=='boolean')throw error(400,'INVALID_INPUT','启用状态须为布尔值。');
              next.enabled=value.enabled;
            }
            if(value.clearKey!==undefined&&typeof value.clearKey!=='boolean')throw error(400,'API_KEY','清除密钥选项必须为布尔值。');
            if(value.clearKey && value.apiKey)throw error(400,'API_KEY','不能同时清除和设置密钥。');
            // Validate configuration while allowing a disabled connection to be edited.
            const enabled=next.enabled!==false;
            Object.assign(next,validateProvider({...next,enabled:true}),{enabled});
            const endpointChanged=next.baseUrl!==p.baseUrl||next.type!==p.type;
            // Never forward an existing provider's credential to a newly selected endpoint.
            if(endpointChanged&&!value.apiKey&&!value.clearKey)throw error(400,'CREDENTIAL_REBIND','修改服务地址或协议时，请重新输入密钥，或明确选择清除密钥。');
            if(value.apiKey!==undefined&&value.apiKey!=='') {
              if(typeof value.apiKey!=='string'||value.apiKey.length>4096||/[\r\n\x00]/.test(value.apiKey))throw error(400,'API_KEY','API Key 格式不正确。');
              try{await secretStore.set(id,value.apiKey);}catch{throw error(503,'KEY_STORAGE','系统密钥存储不可用，未更新连接。');}
              delete next.envKey;
            }else if(value.clearKey){await secretStore.delete(id);delete next.envKey;}
            store.putProvider(next);audit({action:'provider.updated',detail:`${next.name} (${next.type})`});send('state',{});
            return json(res,200,{provider:(await publicProviders()).find(item=>item.id===id)});
          }
          if(test && method==='POST') {
            const diagnostic=test==='/diagnostics';
            if(diagnostic&&url.search)throw error(400,'INVALID_PROVIDER_DIAGNOSTICS','兼容性诊断不接受查询参数。');
            const value=await body(req,diagnostic?{maxBytes:8192,strictUTF8:true}:{});
            if(diagnostic)validateProviderDiagnosticsRequest(value);
            const controller=new AbortController();const cancel=()=>controller.abort();
            req.once('aborted',cancel);res.once('close',cancel);
            if(req.aborted||res.destroyed)cancel();
            try {
              const result=await providerDiagnostics.run(signal=>withProviderRead(id,async()=>{
                const provider=await providerWithSecret(id);
                signal.throwIfAborted();
                return diagnostic?diagnoseProvider(provider,{signal}):testProvider(provider,{signal});
              }),{kind:diagnostic?'diagnostics':'test',signal:controller.signal});
              if(!res.destroyed)return json(res,200,result ?? {ok:true,message:'连接成功。'});
              return;
            } finally {req.removeListener('aborted',cancel);res.removeListener('close',cancel);}
          }
          if(!test && method==='DELETE') {if(id==='demo') throw error(400,'BUILTIN_PROVIDER','内置演示不能删除。');if(store.listSessionSummaries().some(s=>s.providerId===id&&(branchSources.has(s.id)||runtime.isActive(s.id)||ACTIVE.has(s.run?.status))))throw error(409,'PROVIDER_IN_USE','该模型正在执行任务。');await secretStore.delete(id);store.deleteProvider(id);store.reassignProvider(id,'demo');audit({action:'provider.deleted',detail:p.name});send('state',{});return json(res,200,{ok:true});}
          }finally{if(changing)providerMutations.delete(id);}
        }
        if(path==='/api/sessions' && method==='POST') {const value=await body(req);const providerId=value.providerId??'demo';assertProviderAvailable(providerId);if(!store.getProvider(providerId))throw error(400,'PROVIDER_NOT_FOUND','模型连接不存在。');const session=store.createSession({title:textField(value.title,'任务标题',160,{optional:true}),providerId});send('state',{});return json(res,201,{session});}
        const summaryMatch=path.match(/^\/api\/sessions\/([^/]+)\/(summary-preview|summary-drafts)(?:\/([^/]+)(\/cancel)?)?$/);
        if(summaryMatch) {
          if(url.search)throw error(400,'INVALID_SUMMARY_QUERY','摘要生成接口不接受查询参数。');
          const [,encodedSession,kind,encodedDraft,cancel]=summaryMatch;
          const sessionId=historyId(encodedSession),draftId=encodedDraft===undefined?null:historyId(encodedDraft);
          if(kind==='summary-preview'&&!draftId&&method==='POST') {
            const request=validateSummaryPreviewRequest(await body(req,{maxBytes:8192,strictUTF8:true}));
            const source=requireSession(sessionId);assertIdle(source);assertProviderAvailable(request.providerId);
            const provider=store.getProvider(request.providerId);if(!provider)throw error(404,'PROVIDER_NOT_FOUND','模型连接不存在。');
            const plan=planSummaryDraft(source,provider);
            if(plan.preview.source.hash!==request.expectedSourceHash)throw error(409,'HANDOFF_SOURCE_CHANGED','原任务消息已改变，请重新核对来源。');
            return json(res,200,plan.preview);
          }
          if(kind==='summary-drafts'&&!draftId&&method==='POST') {
            const request=validateSummaryRequest(await body(req,{maxBytes:8192,strictUTF8:true}));
            const existing=store.getSummaryDraft(sessionId,request.requestId);
            if(existing) {
              if(existing.requestHash!==summaryRequestHash(request))throw error(409,'SUMMARY_JOB_ID_CONFLICT','此摘要生成标识已用于其他内容，请查询原生成记录。');
              return json(res,200,{draft:existing});
            }
            const source=requireSession(sessionId);assertIdle(source);assertProviderAvailable(request.providerId);
            const provider=store.getProvider(request.providerId);if(!provider)throw error(404,'PROVIDER_NOT_FOUND','模型连接不存在。');
            const plan=planSummaryDraft(source,provider);
            const draft=startSummary(plan,request);
            return json(res,201,{draft});
          }
          if(kind==='summary-drafts'&&draftId&&method==='GET'&&!cancel) {
            requireSession(sessionId);
            const draft=draftId==='latest'?store.listSummaryDrafts(sessionId,{limit:1}).drafts[0]??null:store.getSummaryDraft(sessionId,draftId);
            if(draftId!=='latest'&&!draft)throw error(404,'SUMMARY_JOB_NOT_FOUND','摘要生成记录不存在；没有自动重新请求模型。');
            return json(res,200,{draft});
          }
          if(kind==='summary-drafts'&&draftId&&draftId!=='latest'&&cancel&&method==='POST') {
            const request=await body(req,{maxBytes:8192,strictUTF8:true});
            if(Object.keys(request).length)throw error(400,'INVALID_SUMMARY_REQUEST','停止摘要生成仅接受空 JSON 对象。');
            requireSession(sessionId);const draft=store.getSummaryDraft(sessionId,draftId);
            if(!draft)throw error(404,'SUMMARY_JOB_NOT_FOUND','摘要生成记录不存在；没有自动重新请求模型。');
            const cancelRequested=summarySources.has(sessionId)&&summaryDrafts.cancel(draftId);
            return json(res,200,{draft:store.getSummaryDraft(sessionId,draftId),cancelRequested});
          }
          throw error(404,'NOT_FOUND','没有此摘要生成接口。');
        }
        const handoffMatch=path.match(/^\/api\/sessions\/([^/]+)\/(handoff-preview|continuations)$/);
        if(handoffMatch&&((handoffMatch[2]==='handoff-preview'&&method==='GET')||(handoffMatch[2]==='continuations'&&method==='POST'))) {
          if(url.search)throw error(400,'INVALID_HANDOFF_QUERY','续接接口不接受查询参数。');
          const id=historyId(handoffMatch[1]);
          if(handoffMatch[2]==='handoff-preview') {
            const source=requireSession(id);assertIdle(source,{allowSummary:true});const value=previewConversationHandoff(source);
            if(value.sourceProviderId&&!store.getProvider(value.sourceProviderId))value.sourceProviderId=null;
            return json(res,200,value);
          }
          const request=validateHandoffRequest(await body(req,{maxBytes:256*1024,strictUTF8:true}));
          // The caller retains this ID for an uncertain response. A committed
          // first save is the durable receipt: replays never start another run,
          // even after the source or its connection has subsequently changed.
          const existing=store.getSession(request.requestId);
          if(existing) {
            let receipt;try{receipt=validateContextHandoff(existing.messages?.[0]?.contextHandoff);}catch{}
            if(existing.branch||receipt?.continuationId!==existing.id||receipt?.sourceSessionId!==id||receipt?.requestHash!==handoffRequestHash(request))throw error(409,'HANDOFF_ID_CONFLICT','此续接标识已用于其他内容，请核对任务列表。');
            return json(res,200,{session:existing});
          }
          const source=requireSession(id);assertIdle(source);
          assertProviderAvailable(request.providerId);assertProviderAvailable(source.providerId);
          if(!store.getProvider(request.providerId))throw error(400,'PROVIDER_NOT_FOUND','请先配置模型连接。');
          const skill=(await skillRegistry.catalog()).find(value=>value.id===(request.skillId??'general'))??((request.skillId??'general')==='general'?{id:undefined}:null);if(!skill)throw error(400,'SKILL_NOT_FOUND','技能不存在。');
          branchSources.add(id);
          try {
            const prepared=prepareConversationHandoff(source,request);
            await withProviderRead(source.providerId,()=>withProviderRead(request.providerId,()=>runtime.startContinuation(prepared.session,{content:prepared.content,contextHandoff:prepared.contextHandoff,providerId:request.providerId,selectedSkillId:skill.id})));
            send('state',{});return json(res,201,{session:store.getSession(prepared.session.id)});
          } finally {branchSources.delete(id);}
        }
        const branchMatch=path.match(/^\/api\/sessions\/([^/]+)\/(branch-preview|branches)$/);
        if(branchMatch&&((branchMatch[2]==='branch-preview'&&method==='GET')||(branchMatch[2]==='branches'&&method==='POST'))) {
          const id=historyId(branchMatch[1]),preview=branchMatch[2]==='branch-preview',messageId=branchQuery(url,preview);
          if(preview) {
            const source=requireSession(id);assertIdle(source);const value=previewConversationBranch(source,messageId);
            if(value.sourceProviderId&&!store.getProvider(value.sourceProviderId))value.sourceProviderId=null;
            return json(res,200,value);
          }
          const request=validateBranchRequest(await body(req)),source=requireSession(id);assertIdle(source);
          assertProviderAvailable(request.providerId);
          assertProviderAvailable(source.providerId);
          if(!store.getProvider(request.providerId))throw error(400,'PROVIDER_NOT_FOUND','请先配置模型连接。');
          const skill=(await skillRegistry.catalog()).find(value=>value.id===(request.skillId??'general'))??((request.skillId??'general')==='general'?{id:undefined}:null);if(!skill)throw error(400,'SKILL_NOT_FOUND','技能不存在。');
          branchSources.add(id);
          try {
            const prepared=prepareConversationBranch(source,request);
            await withProviderRead(source.providerId,()=>withProviderRead(request.providerId,()=>runtime.startBranch(prepared.session,{content:prepared.content,contextFiles:prepared.contextFiles,images:prepared.images,contextHandoff:prepared.contextHandoff,providerId:request.providerId,selectedSkillId:skill.id})));
            send('state',{});return json(res,201,{session:store.getSession(prepared.session.id)});
          } finally {branchSources.delete(id);}
        }
        const artifactMatch=path.match(/^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
        if(artifactMatch&&method==='GET') {
          const [sessionId,runId,artifactId]=artifactMatch.slice(1).map(historyId);
          const query=artifactQuery(url);
          if(!store.hasSession(sessionId))throw error(404,'SESSION_NOT_FOUND','任务不存在。');
          const record=store.getToolArtifact(sessionId,runId,artifactId);
          if(!record)throw error(404,'TOOL_ARTIFACT_NOT_FOUND','这条工具原结果不存在，或旧版本没有保存原文。');
          const page=paginateToolArtifact(record,query);
          const {content,...artifact}=record;
          return json(res,200,{artifact,page});
        }
        const historyMatch=path.match(/^\/api\/sessions\/([^/]+)\/runs(?:\/([^/]+))?$/);
        if(historyMatch&&method==='GET') {
          const sessionId=historyId(historyMatch[1]),runId=historyMatch[2]===undefined?null:historyId(historyMatch[2]);
          const query=historyQuery(url,runId!==null);
          if(!store.hasSession(sessionId))throw error(404,'SESSION_NOT_FOUND','任务不存在。');
          if(runId===null)return json(res,200,{sessionId,...store.listRunHistory(sessionId,query)});
          const record=store.getRunHistory(sessionId,runId);
          if(!record)throw error(404,'RUN_NOT_FOUND','执行记录不存在。');
          return json(res,200,{record});
        }
        const outputMatch=path.match(/^\/api\/sessions\/([^/]+)\/output$/);
        if(outputMatch&&method==='GET') {
          const output=store.getSessionOutput(outputMatch[1]);
          if(!output)throw error(404,'SESSION_NOT_FOUND','任务不存在。');
          return json(res,200,output);
        }
        const sessionMatch=path.match(/^\/api\/sessions\/([^/]+)(\/(messages|cancel))?$/);
        if(sessionMatch) {
          const [,id,,action]=sessionMatch;const session=requireSession(id);
          if(!action&&method==='GET')return json(res,200,{session});
          if(!action&&method==='PATCH') {const value=await body(req);const current=requireSession(id);assertIdle(current);if(value.title!==undefined)current.title=textField(value.title,'任务标题',160);if(value.providerId!==undefined){assertProviderAvailable(value.providerId);if(!store.getProvider(value.providerId))throw error(400,'PROVIDER_NOT_FOUND','模型连接不存在。');current.providerId=value.providerId;}current.updatedAt=new Date().toISOString();store.putSession(current);send('state',{});return json(res,200,{session:current});}
          if(!action&&method==='DELETE') {assertIdle(session);store.deleteSession(id,{audit:{action:'session.deleted',detail:session.title,sessionId:id}});send('state',{});return json(res,200,{ok:true});}
          if(action==='messages'&&method==='POST') {
            const value=await body(req,{maxBytes:2*1024*1024});const current=requireSession(id);const content=value.images?.length&&typeof value.content==='string'&&!value.content.trim()?value.content:textField(value.content,'消息',16000);const providerId=value.providerId??current.providerId;
             assertIdle(current);
            assertProviderAvailable(providerId);
            if(!store.getProvider(providerId))throw error(400,'PROVIDER_NOT_FOUND','请先配置模型连接。');
            const skill=(await skillRegistry.catalog()).find(x=>x.id===(value.skillId??'general'))??((value.skillId??'general')==='general'?{id:undefined}:null);if(!skill)throw error(400,'SKILL_NOT_FOUND','技能不存在。');
            if(current.messages.length>=200)throw error(409,'MESSAGE_LIMIT','此任务已达到 200 条消息，可从任务详情整理后续接，或新建任务。');
            // Pin the selected connection through file preflight. Before start()
            // persists it, the session may still refer to a different provider.
            const started=await withProviderRead(providerId,()=>runtime.start(id,{content,providerId,selectedSkillId:skill.id,files:value.files,images:value.images}));send('state',{});return json(res,202,{session:store.getSession(id),...started});
          }
          if(action==='cancel'&&method==='POST') {await body(req);await runtime.cancel(id);return json(res,200,{ok:true});}
        }
        const approvalMatch=path.match(/^\/api\/approvals\/([^/]+)$/);
        if(approvalMatch&&method==='POST') {const value=await body(req);if(!['approve','deny'].includes(value.decision))throw error(400,'INVALID_DECISION','请选择批准或拒绝。');await runtime.decide(approvalMatch[1],value.decision);return json(res,200,{ok:true});}
        if(path==='/api/workspace'&&method==='GET') {
          const options=workspaceQuery(url);
          if(indexReads.size>=2)throw error(429,'WORKSPACE_INDEX_BUSY','另一些文件索引仍在读取或结束，请稍后重试。');
          const controller=new AbortController(),cancel=()=>controller.abort();let timedOut=false;
          req.once('aborted',cancel);res.once('close',cancel);
          if(req.aborted||res.destroyed)cancel();
          const timer=setTimeout(()=>{timedOut=true;controller.abort();},30000);timer.unref();
          const read={controller,promise:workspace.list({...options,signal:controller.signal})};indexReads.add(read);
          try {const result=await read.promise;if(!res.destroyed)return json(res,200,result);return;}
          catch(e) {if(closing)throw error(503,'SHUTTING_DOWN','服务正在停止，文件索引读取已取消。');if(timedOut)throw error(504,'WORKSPACE_INDEX_TIMEOUT','文件索引读取超过 30 秒，请缩小范围后重试。');throw e;}
          finally {clearTimeout(timer);indexReads.delete(read);req.removeListener('aborted',cancel);res.removeListener('close',cancel);}
        }
        if(path==='/api/workspace/directory'&&method==='GET') {
          const options=workspaceQuery(url);
          if(directoryReads.size>=4)throw error(429,'WORKSPACE_DIRECTORY_BUSY','同时读取的目录过多，请等待或取消先前请求。');
          const controller=new AbortController(),cancel=()=>controller.abort();let timedOut=false;
          req.once('aborted',cancel);res.once('close',cancel);
          if(req.aborted||res.destroyed)cancel();
          const timer=setTimeout(()=>{timedOut=true;controller.abort();},30000);timer.unref();
          const read={controller,promise:workspace.directory({...options,signal:controller.signal})};directoryReads.add(read);
          try {const result=await read.promise;if(!res.destroyed)return json(res,200,result);return;}
          catch(e) {if(closing)throw error(503,'SHUTTING_DOWN','服务正在停止，目录读取已取消。');if(timedOut)throw error(504,'WORKSPACE_DIRECTORY_TIMEOUT','目录读取超过 30 秒，请缩小范围后重试。');throw e;}
          finally {clearTimeout(timer);directoryReads.delete(read);req.removeListener('aborted',cancel);res.removeListener('close',cancel);}
        }
        if(path==='/api/workspace/search'&&method==='POST') {
          if(url.search)throw error(400,'INVALID_WORKSPACE_SEARCH','内容搜索参数须放在 JSON 请求正文中。');
          const value=await body(req,{maxBytes:8192,strictUTF8:true});
          const controller=new AbortController();const cancel=()=>controller.abort();
          req.once('aborted',cancel);res.once('close',cancel);
          if(req.aborted||res.destroyed)cancel();
          try {const result=await workspaceSearch.run(value,{signal:controller.signal});if(!res.destroyed)return json(res,200,result);return;}
          finally {req.removeListener('aborted',cancel);res.removeListener('close',cancel);}
        }
        if(path==='/api/workspace/file'&&method==='GET')return json(res,200,await workspace.read(url.searchParams.get('path')));
        if(path==='/api/workspace/file'&&method==='PATCH') {
          if(url.search)throw error(400,'INVALID_FILE_EDIT','保存文件不接受地址查询参数。');
          const value=await body(req,{maxBytes:FILE_EDIT_BODY_BYTES,strictUTF8:true});
          const controller=new AbortController(),cancel=()=>controller.abort();
          req.once('aborted',cancel);res.once('close',cancel);
          if(req.aborted||res.destroyed)cancel();
          try {const result=await manualFileEditor.run(value,{signal:controller.signal});if(!res.destroyed)return json(res,200,result);return;}
          finally {req.removeListener('aborted',cancel);res.removeListener('close',cancel);}
        }
        if(path==='/api/workspace/files'&&method==='POST') {const value=await body(req);textField(value.path,'文件路径',500);if(typeof value.content!=='string'||Buffer.byteLength(value.content)>256*1024)throw error(413,'FILE_TOO_LARGE','文本文件不能超过 256 KiB。');await workspace.importText({path:value.path,content:value.content});audit({action:'workspace.import',detail:value.path});send('state',{});return json(res,201,{ok:true});}
        if(path==='/api/audit'&&method==='GET')return json(res,200,{entries:store.listAudit()});
        if(path==='/api/export'&&method==='GET') {const records=store.exportSessionsWithHistory();res.setHeader('Content-Disposition','attachment; filename="openaster-export.json"');return json(res,200,{format:'openaster-export',version:VERSION,exportedAt:new Date().toISOString(),providers:await publicProviders(),...records,audit:store.listAudit()});}
        throw error(404,'NOT_FOUND','接口不存在。');
      }
      if(!['GET','HEAD'].includes(method))throw error(405,'METHOD_NOT_ALLOWED','请求方法不受支持。');
      let decoded;try{decoded=decodeURIComponent(path);}catch{throw error(400,'INVALID_PATH','无效地址。');}
      if(decoded.includes('..')||decoded.includes('\\')||decoded.includes('\0'))throw error(400,'INVALID_PATH','无效地址。');
      const file=join(ROOT,'public',decoded==='/'?'index.html':decoded);
      if(!MIME[extname(file)])throw error(404,'NOT_FOUND','文件不存在。');
      let content;try{content=await readFile(file);}catch{throw error(404,'NOT_FOUND','文件不存在。');}
      res.writeHead(200,{'Content-Type':MIME[extname(file)],'Cache-Control':extname(file)==='.html'||file.endsWith('sw.js')?'no-cache':'public, max-age=300'});res.end(method==='HEAD'?undefined:content);
    } catch(e) {
      if(res.destroyed)return;
      if(res.headersSent) {res.end();return;}
      const status=Number.isInteger(e.status)&&e.status>=400&&e.status<600?e.status:500;
      json(res,status,{error:{code:status===500?'INTERNAL_ERROR':(e.code||'REQUEST_FAILED'),message:status===500?'操作失败，请重试；若持续出现，请检查本地服务日志。':e.message}});
    } finally { pendingRequests--; }
  });
  server.on('connection',socket=>{
    // HTTP keep-alive and active responses belong to Node's normal shutdown.
    // A TCP preconnection has no request handler for that shutdown to observe.
    if(transportClosing){socket.destroy();return;}
    unrequestedSockets.add(socket);socket.once('close',()=>unrequestedSockets.delete(socket));
  });
  server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxHeadersCount=60;
  try {await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,host,accept);});}catch(e){store.close();await releaseLock();throw e;}
  const address=server.address();origin=`http://${address.family==='IPv6'?'[::1]':'127.0.0.1'}:${address.port}`;
  const heartbeat=setInterval(()=>{for(const client of clients)client.write(': keepalive\n\n');for(const [key,bucket]of rateBuckets)if(bucket.until<Date.now())rateBuckets.delete(key);},20000);heartbeat.unref();
  audit({action:'server.started',detail:gatewayOrigin?'HTTPS gateway mode':'Loopback local mode'});
  return {url:origin,server,close({ifIdle=false}={}){
    if(closePromise)return closePromise;
    if(ifIdle&&(pendingRequests>0||summaryDrafts.active||store.listSessionSummaries().some(s=>runtime.isActive(s.id)||ACTIVE.has(s.run?.status)))) {
      return Promise.reject(error(409,'WORKSPACE_BUSY','任务或文件操作尚未结束，请先停止任务，稍后再切换工作区。'));
    }
    // This synchronous boundary prevents a new request from entering after the
    // idle check. All callers await the same shutdown, including before-quit.
    closing=true;
    const searchStopped=workspaceSearch.close();
    const diagnosticsStopped=providerDiagnostics.close();
    const summaryDraftsStopped=summaryDrafts.close();
    const fileEditsStopped=manualFileEditor.close();
    // Disconnected sockets may still have a metadata batch in flight. Drain the
    // actual directory work before releasing the database/workspace lock.
    const directoriesStopped=Promise.allSettled([...directoryReads].map(read=>{read.controller.abort();return read.promise;}));
    const indexesStopped=Promise.allSettled([...indexReads].map(read=>{read.controller.abort();return read.promise;}));
    closePromise=(async()=>{
      clearInterval(heartbeat);
      await runtime.shutdown();
      await searchStopped;
      await diagnosticsStopped;
      await summaryDraftsStopped;
      await fileEditsStopped;
      await directoriesStopped;
      await indexesStopped;
      // A disconnected HTTP client does not cancel an admitted disk operation.
      // Keep the data lock until every draft operation and repository drain end.
      await Promise.allSettled([...draftOperations]);
      let draftCloseFailure;
      if(deviceDraftStore) {
        try{await deviceDraftStore.drain();}catch(cause){draftCloseFailure=draftError(cause);}
        try{await deviceDraftStore.close();}catch(cause){draftCloseFailure??=draftError(cause);}
      }
      for(const client of clients)client.end();clients.clear();
      await new Promise(resolve=>{
        transportClosing=true;server.close(resolve);
        for(const socket of unrequestedSockets)socket.destroy();
        server.closeIdleConnections();
      });
      try{store.close();}finally{secrets.clear();logins.clear();await releaseLock();}
      if(draftCloseFailure)throw draftCloseFailure;
    })();
    return closePromise;
  }};
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const app=await startServer({port:Number(process.env.PORT??4317),gatewayOrigin:process.env.OPENASTER_GATEWAY_ORIGIN,token:process.env.OPENASTER_GATEWAY_TOKEN,allowedOrigins:process.env.OPENASTER_ALLOWED_ORIGINS?.split(',').map(x=>x.trim()).filter(Boolean)});
  console.log(`OpenAster ${VERSION} — ${app.url}`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{app.close().then(()=>process.exit(0));});
}
