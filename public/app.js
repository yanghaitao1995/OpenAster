import { renderMarkdown } from './markdown.js';
import { createCodeBlock } from './code-block.mjs';
import { buildTextDiff } from './text-diff.mjs';
import { normalizeGateway } from './gateway.mjs';
import { createCommandPalette } from './command-palette.js';
import { createComposerDraftUI, createDesktopDraftAdapter } from './composer-draft-ui.mjs';
import { createFileEditorUI } from './file-editor-ui.mjs';
import { createThemeAppearance } from './theme.mjs';
import { createAndroidNoticesUI } from './android-notices-ui.mjs';
import { createModelPicker } from './model-picker.mjs';
import { createExecutionFlow, createModelStepNotes, renderWebToolResult, webToolNames } from './execution-flow.mjs';
import { createImageInputUI, renderMessageImages } from './image-input.mjs';
import { createCommandPolicyUI } from './command-policy-ui.mjs';
import { createTaskInputUI, createQueuedInputView } from './task-input-ui.mjs';
import { createWorkspaceUI } from './workspace-ui.mjs';
const $ = id => document.getElementById(id);
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
const ICONS = {
  image:'M3 3h18v18H3zM3 16l6-6 5 5 3-3 4 4M15 7h.01',
  terminal:'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM7 8l3 3-3 3M13 15h4',
  pin:'M9 3h6l-1 6 4 4v2h-5v6l-2-2v-4H6v-2l4-4-1-6Z',panel:'M3 4h18v16H3zM15 4v16M18 8v4',sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1',plus:'M12 5v14M5 12h14',grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',folder:'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',sparkles:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4',search:'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM16 16l5 5',shield:'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3ZM8 12l3 3 5-6',sliders:'M4 7h6M14 7h6M4 17h10M18 17h2M10 4v6M14 14v6',moon:'M20 15a8 8 0 0 1-11-11A8.5 8.5 0 1 0 20 15Z',help:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9.3 8.3a3 3 0 0 1 5.5 1.5c0 2-2.8 2-2.8 4M12 17v.1',menu:'M4 6h16M4 12h16M4 18h16',pen:'m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 15l-1 6Z',code:'m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18',chart:'M4 3v18h17M8 16v-4M13 16V8M18 16V5','arrow-up-right':'M6 18 18 6M6 6h12v12','arrow-right':'M4 12h16m-6-6 6 6-6 6','arrow-up':'M12 20V4m-6 6 6-6 6 6','chevron-down':'m6 9 6 6 6-6',leaf:'M20 3c-8 0-15 1-15 9a7 7 0 0 0 12 5c3-3 3-9 3-14ZM4 21 15 10',download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',file:'M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 12h8M8 16h6',refresh:'M20 7V2m0 5h-5M4 17v5m0-5h5M20 7A9 9 0 0 0 4 5M4 17a9 9 0 0 0 16 2',link:'m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 0-6-6l-4 4',check:'m5 12 4 4L19 6',info:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 11v6M12 7v.1',x:'m6 6 12 12M18 6 6 18',square:'M6 6h12v12H6z',layers:'m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5',message:'M4 3h16v14H8l-5 4V4a1 1 0 0 1 1-1ZM7 7h10M7 11h7',clock:'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',activity:'M2 12h5l3-8 4 16 3-8h5'
};
function icon(name, className = '') { const span = el('span', className); span.dataset.icon = name; const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', ICONS[name] || ICONS.sparkles); svg.append(path); span.append(svg); return span; }
function hydrateIcons() { document.querySelectorAll('[data-icon]:empty').forEach(node => node.append(...icon(node.dataset.icon).childNodes)); }
function button(text, action, className = 'button secondary', data = {}) { const node = el('button', className, text); node.type = 'button'; node.dataset.action = action; Object.assign(node.dataset, data); return node; }
function scrollText(text, className, label) { const node=el('pre',className,text);node.tabIndex=0;node.setAttribute('role','region');node.setAttribute('aria-label',label);return node; }
function empty(title, description, symbol = 'file') { const node = el('div', 'empty-state'); node.append(icon(symbol, 'large-icon'), el('h3', '', title), el('p', '', description)); return node; }
function readStorage(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function saveStorage(key, value) { try { localStorage.setItem(key, value); } catch {} }
const native = Boolean(globalThis.Capacitor?.isNativePlatform?.()) || location.protocol === 'capacitor:';
const desktop = /\bElectron\//.test(navigator.userAgent);
let pageSuspended = false;
let authenticationReady = false, authenticationRevision = 0;
let interruptedSend = false;
const messageCache = new Map();
const completeSessionHistory = new WeakSet();
const unavailableSessions = new WeakSet();
const draftFileNodes = new Map();
const fileReferences = new WeakMap();
const fileEditReferences = new WeakMap();
let fileEditor = null;
let modelPicker = null, imageInput = null, commandPolicyUI = null, taskInputUI = null, queuedInputView = null;
let workspaceManagerUI = null;
let webAccessChange = null;
let webSearchChange = null, webSearchDraft = null;
const webSearchServices = Object.freeze({
  parallel: { name:'Parallel', description:'免密钥，有限流。选择仅在本次服务有效；保存不会启用联网或发起搜索。', destination:'搜索词发往 Parallel；网页内容交给当前模型。仅本次服务有效。' },
  bailian: { name:'百炼原生', description:'使用当前 Qwen 连接，需要支持 Responses；搜索与模型调用另计费用。选择仅在本次服务有效；保存不会发起请求。', destination:'搜索词交给当前百炼 Qwen 连接，搜索与模型调用另计费用；网页内容交给当前模型。仅本次服务有效。' },
  duckduckgo: { name:'DuckDuckGo', description:'实验性网页入口，可能遇到验证码。选择仅在本次服务有效；保存不会启用联网或发起搜索。', destination:'搜索词发往 DuckDuckGo，可能遇到验证码；网页内容交给当前模型。仅本次服务有效。' },
});
const webSearchService = value => typeof value==='string'&&Object.hasOwn(webSearchServices,value)?webSearchServices[value]:null;
const executionFlow = createExecutionFlow({ onOpenToolResult: (step, run) => {
  if (state.view !== 'chat' || state.selected?.run?.id !== run.id || !artifactRefValid(step.toolResultRef)) return;
  state.contextOpen = true; saveStorage('openaster.context', 'open'); syncContextPanel();
  const details = [...$('run-panel').querySelectorAll('.tool-artifact-view')].find(item => item.dataset.artifactId === step.toolResultRef.artifactId);
  if (details) { details.open = true; details.querySelector('summary')?.focus({ preventScroll: true }); details.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
} });
let nativeLeaveLock = null;
let nativeLastReleasedToken = null;
const approvalCache = new Map();
const approvalHistoryCache = new Map();
const toolArtifactViews = new Set();
let pinnedIds = []; try { const saved = JSON.parse(readStorage('openaster.pins') || '[]'); if(Array.isArray(saved)) pinnedIds = saved.filter(id=>typeof id==='string').slice(0,100); } catch {}
let messageSession = '';
let outputCache = null;
let providerDiagnosticsSupported = false;
let providerDiagnostics = null;
let handoffSupported = false;
let summaryDraftSupported = false;
let handoffEditor = null;
const handoffIntents = new Map();
const summaryDraftIntents = new Map();
let summaryDraftWorkspaceKey='';
const summaryIntentStorageKey='openaster.summary-intents';
function saveSummaryIntents(){
  try{const items=[...summaryDraftIntents].map(([sessionId,intent])=>({sessionId,requestId:intent.body.requestId}));if(items.length>1000||!state.workspaceKey)throw new Error('intent limit');if(items.length)sessionStorage.setItem(summaryIntentStorageKey,JSON.stringify({workspaceKey:state.workspaceKey,items}));else sessionStorage.removeItem(summaryIntentStorageKey);return true;}catch{return false;}
}
function restoreSummaryIntents(){
  if(summaryDraftWorkspaceKey===state.workspaceKey)return;summaryDraftWorkspaceKey=state.workspaceKey;summaryDraftIntents.clear();
  try{const raw=sessionStorage.getItem(summaryIntentStorageKey);if(!raw)return;if(raw.length>300000)throw new Error('intent limit');const value=JSON.parse(raw),id=/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;if(!value||Object.keys(value).sort().join(',')!=='items,workspaceKey'||value.workspaceKey!==state.workspaceKey||!Array.isArray(value.items)||value.items.length>1000)throw new Error('intent scope');const ids=new Set();for(const item of value.items){if(!item||Object.keys(item).sort().join(',')!=='requestId,sessionId'||typeof item.sessionId!=='string'||typeof item.requestId!=='string'||!id.test(item.sessionId)||!id.test(item.requestId)||item.requestId==='latest'||ids.has(item.sessionId))throw new Error('invalid intent');ids.add(item.sessionId);}for(const item of value.items)summaryDraftIntents.set(item.sessionId,{body:{requestId:item.requestId},persistent:true});}catch{summaryDraftIntents.clear();try{sessionStorage.removeItem(summaryIntentStorageKey);}catch{}}
}
function keepSummaryIntent(editor,intent){summaryDraftIntents.set(editor.sessionId,intent);intent.persistent=saveSummaryIntents();}
function forgetSummaryIntent(editor){summaryDraftIntents.delete(editor.sessionId);saveSummaryIntents();}
let restoreSessionId = ''; try { restoreSessionId = sessionStorage.getItem('openaster.current-session') || ''; } catch {}
let restoreWorkspaceKey = ''; try { restoreWorkspaceKey = sessionStorage.getItem('openaster.workspace-context') || ''; } catch {}
const mobileLayout = matchMedia('(max-width:760px)');
const state = { workspaceDirectorySupported: false, browseController: null, workspaceIgnoreSupported: false, workspaceProjectMode: null, discoveryRevision: 0, workspaceMode: 'files', workspaceSearchSupported: false, workspaceSearch: {request:0,controller:null,loading:false,result:null,error:'',notice:'',revision:0}, searchPreview: null, conversationBranchSupported: false, branchEditor: null, usageOverviewSupported: false, usageOverview: null, toolArtifactsSupported: false, contextFilesSupported: false, draftFiles: [], draftRevision: 0, composerView: 'home', contextFileRequest: 0, runHistory: null, providers: [], sessions: [], skills: [], selected: null, view: 'home', providerId: '', skillId: '', csrf: '', connected: false, sending: false, sendRequest: 0, switching: false, gateway: '', bearer: '', generation: 0, sessionRequest: 0, sessionRevision: 0, fullSessionRequest: null, stateRequest: 0, fileRequest: 0, navigation: 0, recentFilter: 'all', contextOpen: readStorage('openaster.context') === 'open', filesLoaded: false, filesError: '', files: [], filesScan: null, filesTruncated: false, filesRequest: 0, browseScope: '', browseFiles: [], browseScan: null, browseTruncated: false, browseIncludeGenerated: false, browseLoaded: false, browseLoading: false, browseError: '', browseRequest: 0, auditEntries: [], auditLoaded: false, workspaceKey: '', workspaceId: null, workspaceName: '我的工作区', workspacePath: '', workspaceNamed: false, currentFile: '', stream: null, streamTimer: null, refreshTimer: null, outputTimer: null, outputRequest: null, outputSequence: 0, outputPending: null, reconnectAttempt: 0, dialogSubmit: null };
state.workspaceEditSupported = false;
try { const saved = normalizeGateway(readStorage('openaster.gateway'), { native }); state.gateway = !desktop && (native || saved === location.origin) ? saved : ''; } catch {}
if (readStorage('openaster.theme') === 'dark') document.body.classList.add('dark');
const themeAppearance = createThemeAppearance();
const androidNotices = createAndroidNoticesUI({ openDialog });
function syncThemeAppearance() { themeAppearance.sync(document.body.classList.contains('dark') ? 'dark' : 'light'); }
syncThemeAppearance();
let composerDraftState = null;
const composerDrafts = createComposerDraftUI({
  desktop,
  read: () => ({ text: $('prompt-input').value, files: state.draftFiles, providerId: state.providerId, skillId: state.skillId }),
  write: draft => {
    $('prompt-input').value = draft.text; state.draftFiles = draft.files.map(file => ({ ...file }));
    state.providerId = draft.providerId || state.providerId; state.skillId = draft.skillId;
    ++state.draftRevision; clearContextFileError(); renderDraftFiles(); renderModels();
  },
  status: value => {
    composerDraftState = value;
    const label = $('composer-draft-label'), control = $('composer-draft-status');
    if (!label || !control) return;
    const problem = value.error || value.conflicts.length || value.unavailable;
    label.textContent = value.conflicts.length ? '草稿有冲突' : value.error ? '草稿未保存'
      : value.unavailable ? '草稿仅在本页' : !value.ready ? '读取草稿…'
      : value.draft?.uncertain ? '发送结果待核对' : value.pending || value.saving ? '正在保存…'
      : value.draft ? '草稿已保存' : '本机草稿';
    control.classList.toggle('draft-attention', Boolean(problem || value.draft?.uncertain));
    control.title = value.unavailable || (value.encrypted ? '此设备的草稿使用系统加密存储。点击管理草稿。' : '草稿保存在此浏览器；清除网站数据会删除草稿。点击管理。');
  },
  desktopRepository: (storageId, origin) => createDesktopDraftAdapter({ storageId, request: api,
    isCurrent: () => desktop && !state.gateway && origin === location.origin && state.storageId === storageId }),
});
fileEditor = createFileEditorUI({
  request: api,
  getContext: () => ({ generation: state.generation, navigation: state.navigation, fileRequest: state.fileRequest,
    workspaceKey: state.workspaceKey, storageId: state.storageId, connected: state.connected,
    switching: state.switching, suspended: pageSuspended, supported: state.workspaceEditSupported }),
  renderDiff: renderFileDiff,
  notify: (message, error = false) => toast(message, error),
  onSaved: async (data, context) => {
    if (context.workspaceKey !== state.workspaceKey || context.storageId !== state.storageId) return;
    invalidateFiles(); invalidateAudit();
    if (context.generation !== state.generation || context.navigation !== state.navigation || context.fileRequest !== state.fileRequest || state.view !== 'workspace' || state.currentFile !== data.path) return;
    const size = new TextEncoder().encode(data.content).length;
    for (const files of [state.files, state.browseFiles]) { const file = files.find(item => item.path === data.path); if (file) file.size = size; }
    const origin = document.activeElement;
    const restoreFocus = origin?.matches('#file-preview [data-action="edit-file"]');
    let focusMoved = false;
    const observeFocus = event => { if (event.target !== origin) focusMoved = true; };
    if (restoreFocus) document.addEventListener('focusin', observeFocus);
    let previewRequest;
    try { const preview = openFile(data.path); previewRequest = state.fileRequest; await preview; }
    finally { if (restoreFocus) document.removeEventListener('focusin', observeFocus); }
    if (restoreFocus && !focusMoved && !document.querySelector('dialog[open]') &&
        (document.activeElement === origin || (!origin.isConnected && document.activeElement === document.body)) &&
        context.workspaceKey === state.workspaceKey && context.storageId === state.storageId &&
        context.generation === state.generation && context.navigation === state.navigation &&
        previewRequest === state.fileRequest && state.view === 'workspace' && state.currentFile === data.path) {
      const next = $('file-preview').querySelector('[data-action="edit-file"]:not(:disabled)');
      if (next?.getClientRects().length && !next.closest('[inert]')) next.focus({ preventScroll: true });
    }
    void refreshVisibleReads({ browse: true });
  },
});
const statusText = {running:'正在执行',awaiting_approval:'等待你的批准',completed:'已完成',cancelled:'已停止',failed:'执行失败'};
// Native main-process departure handshake. Only a decision and an opaque token
// cross this DOM event boundary; no draft text or file content is exposed.
if (desktop) {
  const departureDetail = event => {
    try { const value = event.detail; return value && Object.keys(value).sort().join(',') === 'result,token,version' && value.version === 1 && typeof value.token === 'string' && /^[a-f0-9]{32}$/.test(value.token) && value.result === null ? value : null; } catch { return null; }
  };
  document.addEventListener('openaster:native-leave-check', event => {
    const detail = departureDetail(event); if (!detail) return;
    const decide = (allowed, reason) => { detail.result = { allowed, reason, token: detail.token }; };
    if (nativeLeaveLock) { decide(nativeLeaveLock.token === detail.token, nativeLeaveLock.token === detail.token ? null : 'unknown'); return; }
    if (document.readyState !== 'complete' || pageSuspended || !state.connected || state.switching || state.sending) { decide(false, 'unknown'); return; }
    if (fileEditor.hasUnconfirmedSave()) { decide(false, 'unknown'); return; }
    if (fileEditor.hasPending()) { decide(false, 'pending'); return; }
    if (composerDrafts.pending()) { decide(false, 'drafts-pending'); return; }
    nativeLeaveLock = { token: detail.token, inert: document.body.inert, focus: document.activeElement };
    nativeLastReleasedToken = null; document.body.inert = true; fileEditor.setLeaveLocked(true); syncFileEditControls(); decide(true, null);
  });
  document.addEventListener('openaster:native-leave-release', event => {
    const detail = departureDetail(event); if (!detail) return;
    if (!nativeLeaveLock || nativeLeaveLock.token !== detail.token) { const released = !nativeLeaveLock && nativeLastReleasedToken === detail.token; detail.result = { allowed: released, reason: released ? null : 'unknown', token: detail.token }; return; }
    const previous = nativeLeaveLock; nativeLeaveLock = null; nativeLastReleasedToken = detail.token;
    document.body.inert = previous.inert; fileEditor.setLeaveLocked(false); syncFileEditControls();
    if (!previous.inert && previous.focus?.isConnected && previous.focus.getClientRects().length && !previous.focus.closest('[inert]') && !previous.focus.disabled) previous.focus.focus({ preventScroll: true });
    detail.result = { allowed: true, reason: null, token: detail.token };
  });
  for (const eventName of ['click', 'keydown']) document.addEventListener(eventName, event => { if (nativeLeaveLock) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
}
function formatDate(value, full = false) { const date = new Date(value); if (!Number.isFinite(date.getTime())) return ''; return date.toLocaleString('zh-CN', full ? {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'} : {hour:'2-digit',minute:'2-digit'}); }
function stringify(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) || ''; }
function toast(message, failure = false) {
  const origin=document.activeElement,box=el('div',`toast${failure?' error':''}`),close=el('button');
  close.type='button';close.setAttribute('aria-label','关闭提示');close.append(icon('x'));
  let timer;const schedule=()=>{clearTimeout(timer);if(!box.contains(document.activeElement))timer=setTimeout(()=>{if(!box.contains(document.activeElement))box.remove();},failure?10000:5000);};
  close.addEventListener('click',()=>{const focused=box.contains(document.activeElement);clearTimeout(timer);box.remove();if(focused){const heading=document.querySelector('.view:not(.hidden) h1');if(heading)heading.tabIndex=-1;const target=[origin,...$('toast-region').querySelectorAll('button'),mobileLayout.matches&&$('sidebar').classList.contains('open')?$('sidebar').querySelector('.new-task'):null,$('prompt-input'),heading].find(node=>node?.isConnected&&!node.closest('[inert]')&&!node.disabled&&node.getClientRects().length&&(node.tabIndex>=0||node.hasAttribute('tabindex')||node.isContentEditable));target?.focus({preventScroll:true});}});
  box.addEventListener('focusin',()=>clearTimeout(timer));box.addEventListener('focusout',schedule);
  box.append(icon(failure?'info':'check'),el('span','',message),close);$('toast-region').append(box);schedule();
}
function connection(ok, message = '') { if(ok&&(state.switching||pageSuspended||!authenticationReady))return;state.connected = ok; updateOverview(); $('storage-caption').textContent = state.gateway ? '历史记录保存在你连接的工作台' : '历史记录保存在本地工作台'; $('connection-indicator').className = `connection-indicator ${ok ? 'connected' : 'disconnected'}`; $('top-status').textContent = ok ? (state.gateway ? '网关已连接' : '本地已连接') : '连接未就绪'; $('connection-text').textContent = ok ? (state.gateway ? '远程工作空间' : '本地服务运行中') : '请检查连接'; $('connection-banner').classList.toggle('hidden', ok); $('connection-message').textContent = message || '暂时无法连接工作台服务。移动端请先配置自己的 HTTPS 网关。'; updateComposer();syncBranchControls();renderWorkspaceSearch();syncFileEditControls();commandPolicyUI?.sync({refresh:true}); }
function invalidateAuthentication(message) {
  authenticationReady=false;state.csrf='';++authenticationRevision;++state.stateRequest;
  connection(false,message);
}
function validateAuthentication(data) {
  if(typeof data.csrfToken!=='string'||!data.csrfToken.length)throw new Error('服务未提供有效的认证信息，请重新连接工作台。');
}
function acceptAuthentication(data) {
  validateAuthentication(data);adopt(data);state.csrf=data.csrfToken;
  authenticationReady=true;++authenticationRevision;++state.stateRequest;state.switching=false;
}
let filesFlight=null,legacyBrowseFlight=null,auditFlight=null;
state.filesStale=true;state.auditStale=true;state.auditError='';
function cancelFilesRequest(){const flight=filesFlight;filesFlight=null;++state.filesRequest;state.filesStale=true;flight?.controller.abort();}
function invalidateFiles(){state.filesStale=true;if(filesFlight)filesFlight.dirty=true;}
function cancelAuditRequest(){const flight=auditFlight;auditFlight=null;state.auditStale=true;flight?.controller.abort();}
function invalidateAudit(){state.auditStale=true;if(auditFlight)auditFlight.dirty=true;}
function wantsRootFiles(){return (state.view==='chat'&&state.contextOpen)||commandPalette.isOpen()||(state.view==='workspace'&&!state.workspaceDirectorySupported&&!state.browseScope&&!state.browseIncludeGenerated);}
function wantsAudit(){return state.view==='security'||(state.view==='chat'&&state.contextOpen)||commandPalette.isOpen();}
// A newly visible consumer may join a current read. Only a mutation/event makes
// that read obsolete; passive counts never start a recursive workspace scan.
function refreshVisibleReads({fresh=false,browse=false}={}){
  if(!state.connected||state.switching)return Promise.resolve([]);
  const tasks=[];
  if(wantsRootFiles()){
    if(fresh)state.filesStale=true;
    if(state.filesStale||!state.filesLoaded)tasks.push(loadFiles());
  }
  if(wantsAudit()){
    if(fresh)state.auditStale=true;
    if(state.auditStale||!state.auditLoaded)tasks.push(loadAudit());
  }
  if(browse&&state.view==='workspace')tasks.push(loadBrowseFiles());
  return Promise.allSettled(tasks);
}
async function api(path, { method = 'GET', body, timeout = 20000, signal, headers: extraHeaders = {} } = {}) {
  if(pageSuspended)throw Object.assign(new Error('页面已暂停，返回后请确认连接。'),{staleContext:true});
  if(nativeLeaveLock&&method!=='GET')throw new Error('正在离开当前工作区，操作结束后才能继续。');
  if(state.switching&&method!=='GET')throw Object.assign(new Error('正在切换工作空间，请连接完成后再操作。'),{notSent:true});
  if(!authenticationReady&&method!=='GET')throw Object.assign(new Error('正在重新验证工作台连接，本次操作尚未发送。请连接就绪后再操作。'),{code:'AUTHENTICATION_PENDING',notSent:true});
  const generation=state.generation,authentication=authenticationRevision,csrf=state.csrf;const headers = {'Accept':'application/json', ...extraHeaders}; if (state.bearer) headers.Authorization = `Bearer ${state.bearer}`; if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = state.csrf; } const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  try { const response = await fetch(`${state.gateway}${path}`, {method,headers,body:body === undefined ? undefined : JSON.stringify(body),credentials:state.gateway ? 'omit' : 'same-origin',signal:controller.signal,cache:'no-store'}); let result; try { result = await response.json(); } catch(error) { if(controller.signal.aborted)throw error;throw new Error('服务返回了无法识别的数据，请检查网关地址。'); }
    if(generation!==state.generation)throw Object.assign(new Error('工作空间已切换，已忽略之前的操作结果。'),{staleContext:true});
    if (!response.ok) { const error = new Error(result.error?.message || `请求失败（${response.status}）`); error.status = response.status; error.code = result.error?.code; if(method!=='GET'&&error.status===403&&error.code==='CSRF'&&authentication===authenticationRevision&&csrf===state.csrf){invalidateAuthentication('安全令牌已更新，正在重新验证工作台。本次操作未执行，请连接就绪后自行重试。');stopStream();void connectStream(generation,{refreshAuthentication:true});} throw error; } return result;
  } catch(error) { if(generation!==state.generation)throw Object.assign(new Error('工作空间已切换，已忽略之前的操作结果。'),{staleContext:true});if(signal?.aborted)throw Object.assign(new Error('操作已取消。'),{cancelled:true});if (error.name === 'AbortError') throw new Error('请求超时，请检查服务或网络连接。'); if (error instanceof TypeError) throw new Error('无法连接服务，请检查网关、网络或服务是否启动。'); throw error; } finally { clearTimeout(timer);signal?.removeEventListener('abort',abort); }
}
function renderWorkspaceIdentity(){
  const name=state.workspaceName;const characters=Array.from(name);
  for(const id of ['workspace-label','sidebar-workspace-label','workspace-name']){const node=$(id);if(!node)continue;const limit=id==='sidebar-workspace-label'?12:id==='workspace-name'?16:24;node.textContent=characters.length>limit?characters.slice(0,limit-1).join('')+'…':name;node.title=state.workspacePath?`${name}\n${state.workspacePath}`:name;}
  if($('workspace-full-path'))$('workspace-full-path').textContent=state.workspacePath||'等待工作空间连接…';
  if($('copy-workspace-path'))$('copy-workspace-path').disabled=!state.workspacePath;
}
function resetWorkspaceContext({keepDialog=false,clearIdentity=false,cancelSummary=true}={}){
  state.webToolsSupported=false;state.webAccess=false;state.webAccessKnown=false;webAccessChange=null;
  state.webSearchConfigurationSupported=false;state.webSearchProvider=null;webSearchChange=null;webSearchDraft=null;
  fileEditor?.invalidate('工作区已切换。文件编辑内容仍保留，不能写入当前工作区；请返回原工作区核对，或明确放弃编辑。');state.workspaceEditSupported=false;
  composerDrafts.detach(); state.storageId = ''; 
  discardProviderDiagnostics();providerDiagnosticsSupported=false;
  discardHandoffEditor({cancelSummary});handoffSupported=false;summaryDraftSupported=false;handoffIntents.clear();summaryDraftIntents.clear();summaryDraftWorkspaceKey='';try{sessionStorage.removeItem(summaryIntentStorageKey);}catch{}
  authenticationReady=false;state.csrf='';++authenticationRevision;
  ++state.generation;++state.navigation;++state.sendRequest;++state.sessionRequest;++state.sessionRevision;++state.stateRequest;++state.fileRequest;stopStream();state.switching=true;
  cancelFilesRequest();cancelAuditRequest();cancelBrowseRequest();state.workspaceDirectorySupported=false;state.workspaceIgnoreSupported=false;state.workspaceProjectMode=null;++state.discoveryRevision;state.workspaceSearchSupported=false;state.workspaceMode='files';$('workspace-search-query').value='';$('workspace-search-case').checked=false;cancelWorkspaceSearch({clear:true});
  state.conversationBranchSupported=false;state.branchEditor=null;state.usageOverviewSupported=false;resetUsageOverview({close:true});state.toolArtifactsSupported=false;state.contextFilesSupported=false;state.selected=null;state.providerId='';state.skillId='';state.sending=false;state.providers=[];state.sessions=[];state.skills=[];state.files=[];state.filesLoaded=false;state.filesError='';state.filesScan=null;state.filesTruncated=false;++state.filesRequest;++state.browseRequest;state.browseScope='';state.browseFiles=[];state.browseScan=null;state.browseTruncated=false;state.browseIncludeGenerated=false;state.browseLoaded=false;state.browseLoading=false;state.browseError='';state.currentFile='';state.auditEntries=[];state.auditLoaded=false;state.auditError='';state.recentFilter='all';
  resetRunHistory(null);restoreSessionId='';pinnedIds=[];saveStorage('openaster.pins','[]');messageCache.clear();approvalCache.clear();approvalHistoryCache.clear();messageSession='';outputCache=null;
  if(clearIdentity){state.workspaceKey='';restoreWorkspaceKey='';state.workspaceId=null;state.workspaceName='正在连接…';state.workspacePath='';state.workspaceNamed=false;state.csrf='';}
  $('prompt-input').value='';clearDraftFiles();++state.contextFileRequest;$('search-input').value='';$('file-search').value='';
  for(const id of ['messages','approval-list','run-panel','usage-summary','context-details','artifact-list','context-files','context-preview','audit-list'])$(id).replaceChildren();
  $('approval-list')._signature=null;
  $('context-preview').classList.add('hidden');$('run-error').textContent='';$('run-error').classList.add('hidden');$('file-preview').replaceChildren(empty('选择文件','在左侧选择文本文件以查看内容。','file'));$('audit-count').textContent='0 条记录';$('artifact-count').textContent='0';
  commandPalette.close();if(!keepDialog){closeDialog();$('dialog-body').replaceChildren();}
  renderWorkspaceIdentity();renderFileList();renderSessions();renderProviders();renderSkills();renderModels();showView('home',{focus:false});connection(false,'正在连接工作空间，原工作区的未发送内容不会带入。');
}
function syncHarnessPermissions(data) {
  state.webToolsSupported=data.capabilities?.webTools===1;state.webAccess=data.security?.webAccess===true;state.webAccessKnown=typeof data.security?.webAccess==='boolean';
  state.webSearchConfigurationSupported=data.capabilities?.webSearchConfiguration===1;state.webSearchProvider=webSearchService(data.security?.webSearchProvider)?data.security.webSearchProvider:null;syncWebAccessControls();
  state.imagesSupported=data.capabilities?.images===1;
  state.skillsPath=typeof data.workspace?.skillsPath==='string'?data.workspace.skillsPath:'./skills';$('skills-path').textContent=state.skillsPath;
  imageInput?.bind(state.workspaceKey+':'+(state.composerView==='chat'&&state.selected?state.selected.id:'new'));
  state.permissionsSupported=data.capabilities?.permissions===1;
  state.commandPolicySupported=data.capabilities?.commandPolicy===1;
  state.taskInputSupported=data.capabilities?.taskInput===1;
  state.fileAccess=data.security?.fileAccess==='computer'?'computer':'workspace';
  state.computerAccessAvailable=data.security?.computerAccessAvailable===true;
  state.workspaceActionsSupported=data.capabilities?.workspaceActions===1;
  state.workspaceManagementSupported=data.capabilities?.workspaceManagement===1;
  $('file-permissions-section').classList.toggle('hidden',!state.permissionsSupported);
  const granted=state.fileAccess==='computer';
  const permissionNote=(granted?'本次会话已允许访问本机文件。':'文件工具限定在工作区。')+' 文件写入与编辑仍需逐次批准；命令按当前任务的策略审核。';
  $('context-permission-note').textContent=permissionNote;$('workspace-permission-note').textContent=permissionNote+' 已批准的命令使用本机用户权限。';$('security-permission-note').textContent=permissionNote;
  $('file-permissions-current').textContent=granted?'本机文件访问已开启':'仅工作区';
  $('file-permissions-description').textContent=granted?'智能体可使用绝对路径读取本机文件，也可提出工作区外文件的写入与编辑审批。读取的内容可能发送给当前模型服务。':state.computerAccessAvailable?'智能体文件工具目前限定在工作区。你可以为本次服务会话授予本机文件访问权限。':'此连接只允许访问工作区；本机文件权限需要在本地工作台中授予。';
  $('file-permissions-button').textContent=granted?'恢复仅工作区':'允许访问本机文件…';
  $('file-permissions-button').disabled=!granted&&!state.computerAccessAvailable;
  for(const id of ['open-workspace-project','create-workspace-project'])$(id).classList.toggle('hidden',!state.workspaceActionsSupported&&!state.workspaceManagementSupported);
  if($('workspace-host-note'))$('workspace-host-note').textContent=state.workspaceManagementSupported?'目录位于运行 OpenAster 服务的主机上。可在此打开、新建或切换项目；手机和远程客户端管理的是主机项目。':'当前位置是运行 OpenAster 服务的主机目录。桌面菜单可打开或新建项目。';
}
function syncWebAccessControls() {
  const supported=state.webToolsSupported===true,known=state.webAccessKnown===true;
  $('web-access-section').classList.toggle('hidden',!supported);
  const toggle=$('web-access-toggle');toggle.checked=webAccessChange?webAccessChange.enabled:known&&state.webAccess===true;toggle.disabled=!supported||!known||!state.connected||Boolean(webAccessChange);
  const status=$('composer-web-access');status.classList.toggle('hidden',!supported);status.textContent=!state.connected||!known?'联网：待确认':state.webAccess?'联网：开启':'联网：关闭';
  status.title=state.providers.find(item=>item.id===state.providerId)?.toolMode==='none'?'当前连接为仅对话模式，不使用网页工具。':'在设置中管理搜索网页与阅读网页。';
  $('web-access-state').textContent=webAccessChange?'正在保存…':!known?'状态待确认':state.webAccess?'已开启':'已关闭';
  const confirmed=webSearchService(state.webSearchProvider),draft=webSearchDraft??state.webSearchProvider,selected=webSearchService(draft);
  $('web-access-description').textContent=confirmed?.destination||'搜索服务状态待确认；网页内容交给当前模型。仅本次服务有效。';
  $('web-search-configuration').classList.toggle('hidden',!state.webSearchConfigurationSupported);
  $('web-search-provider').value=webSearchChange?.provider??(selected?draft:'');
  $('web-search-provider').disabled=!supported||!state.webSearchConfigurationSupported||!confirmed||!state.connected||Boolean(webSearchChange);
  $('web-search-save').disabled=$('web-search-provider').disabled||!selected||draft===state.webSearchProvider;
  $('web-search-description').textContent=selected?.description||'连接工作台并确认当前搜索服务后，才可修改设置。';
  $('web-search-status').textContent=webSearchChange?'正在保存…':!state.connected||!confirmed?'状态待确认':draft!==state.webSearchProvider?'尚未保存':`当前：${confirmed.name}`;
}
async function saveWebSearchProvider() {
  const provider=webSearchDraft;
  if(!state.webToolsSupported||!state.webSearchConfigurationSupported||!state.connected||!webSearchService(state.webSearchProvider)||!webSearchService(provider)||provider===state.webSearchProvider||webSearchChange)return;
  const token={generation:state.generation,provider};webSearchChange=token;syncWebAccessControls();
  try {
    const result=await api('/api/security/web-search',{method:'POST',body:{provider}});
    if(token.generation!==state.generation)return;
    if(result.provider!==provider||result.lifetime!=='service-session')throw new Error('搜索服务保存结果无法确认，请重新连接后核对。');
    state.webSearchProvider=provider;webSearchDraft=null;await refreshState();
  } catch(error) {
    if(token.generation===state.generation){state.webSearchProvider=null;try{await refreshState();}catch{}if(!error.staleContext)toast(error.message,true);}
  } finally { if(webSearchChange===token){webSearchChange=null;syncWebAccessControls();} }
}
async function changeWebAccess(enabled) {
  if(!state.webToolsSupported||!state.connected||webAccessChange)return;
  const token={generation:state.generation,enabled};webAccessChange=token;syncWebAccessControls();
  try { await api('/api/security/web-access',{method:'POST',body:{enabled}});if(token.generation===state.generation)await refreshState(); }
  catch(error) { if(token.generation===state.generation){state.webAccessKnown=false;try{await refreshState();}catch{}if(!error.staleContext)toast(error.message,true);} }
  finally { if(webAccessChange===token){webAccessChange=null;syncWebAccessControls();} }
}
async function changeFilePermissions() {
  if(!state.permissionsSupported)return;
  if(state.fileAccess==='computer'){await api('/api/permissions',{method:'PUT',body:{fileAccess:'workspace'}});await refreshState();toast('文件工具已恢复为仅工作区。');return;}
  if(!state.computerAccessAvailable)return;
  confirmDialog('允许智能体访问本机文件', '开启后，智能体可通过绝对路径读取当前系统账户可访问的本机文件；读取内容可能发送给所选模型服务商。文件写入与编辑仍需逐次批准，命令授权在当前任务的命令策略中单独设置。此文件授权仅对本次工作台服务有效，重启后自动恢复仅工作区。', '确认允许本机文件访问', async()=>{await api('/api/permissions',{method:'PUT',body:{fileAccess:'computer',confirmComputerAccess:true}});await refreshState();toast('本次服务会话已允许本机文件访问。');});
}
async function openWorkspaceProject(create=false) {
  if(state.workspaceManagementSupported)return workspaceManagerUI.open({create});
  if(!state.workspaceActionsSupported)return;
  if(fileEditor?.hasPending())throw new Error('请先保存或取消当前文件编辑，再打开其他项目。');
  await composerDrafts.flush();
  await api('/api/workspace/'+(create?'create':'open'),{method:'POST',body:{}});
}
function adopt(data) {
  let changed=false;const workspace=data.workspace;
  if(workspace&&typeof workspace.path==='string'){
    const key=JSON.stringify([state.gateway || location.origin, workspace.storageId ?? null, workspace.id??null,workspace.path]);const previous=state.workspaceKey||restoreWorkspaceKey;
    changed=Boolean(previous&&previous!==key);if(changed)resetWorkspaceContext({cancelSummary:false});
    state.workspaceKey=key;restoreWorkspaceKey=key;state.storageId=workspace.storageId || ''; state.workspaceId=workspace.id??null;state.workspacePath=workspace.path;state.workspaceName=typeof workspace.name==='string'&&workspace.name?workspace.name:'我的工作区';state.workspaceNamed=true;
    restoreSummaryIntents();
    try{sessionStorage.setItem('openaster.workspace-context',key);}catch{}
  }
  syncHarnessPermissions(data);
  const discoveryChanged=syncWorkspaceDiscovery(data);
  syncWorkspaceSearchCapability(data.capabilities?.workspaceSearch===1);
  providerDiagnosticsSupported=data.capabilities?.providerDiagnostics===1;
  handoffSupported=data.capabilities?.conversationHandoff===1;
  summaryDraftSupported=data.capabilities?.handoffDraft===1;
  state.conversationBranchSupported=data.capabilities?.conversationBranch===1;
  syncUsageOverviewCapability(data.capabilities?.usageOverview===1);
  state.contextFilesSupported=data.capabilities?.contextFiles===1;
  state.workspaceEditSupported=data.capabilities?.workspaceEdit===1;syncFileEditControls();
  state.toolArtifactsSupported=data.capabilities?.toolArtifacts===1;syncToolArtifactCapabilities();
  state.providers = data.providers || []; state.sessions = (data.sessions || []).sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))); state.skills = data.skills || []; if (!state.providerId) state.providerId = state.providers.find(item => item.enabled !== false)?.id || '';  if (data.csrfToken) state.csrf = data.csrfToken; if (data.version) $('version-label').textContent = `v${data.version}`;renderWorkspaceIdentity();renderSessions(); renderProviders(); renderSkills(); renderModels();syncContextFileCapabilities();syncBranchControls();if(discoveryChanged)renderFileList();commandPalette.refresh();composerDrafts.bind({origin:state.gateway || location.origin,storageId:state.storageId,deviceDrafts:data.capabilities?.deviceDrafts});return changed;
}
async function bootstrap() {
  if(pageSuspended)return;
  if(providerDiagnostics||handoffEditor)closeDialog({restoreFocus:false});
  let generation=++state.generation;const navigation=state.navigation,draftRevision=state.draftRevision;
  invalidateAuthentication('正在验证工作台连接…');
  fileEditor?.syncContext();
  cancelFilesRequest();cancelAuditRequest();cancelBrowseRequest();cancelWorkspaceSearch({clear:true});stopStream();
  if(native&&!state.gateway){
    state.switching=false;renderModels();
    connection(false,'请先配置 HTTPS 网关，连接你自己的工作台后再开始任务。');
    return;
  }
  try{
    const data=await api('/api/bootstrap');if(generation!==state.generation)return;
    acceptAuthentication(data);generation=state.generation;connection(true);state.reconnectAttempt=0;void connectStream(generation);
    // Shared workspace reads never gate the selected conversation.
    void refreshVisibleReads({browse:true});
    if(navigation!==state.navigation||draftRevision!==state.draftRevision){restoreSessionId='';return;}
    if(state.selected)await refreshSession(state.selected.id);
    else if(restoreSessionId){const id=restoreSessionId;restoreSessionId='';if(state.sessions.some(item=>item.id===id))await openSession(id);}
  }catch(error){if(generation===state.generation)connection(false,error.message);}
}
async function refreshState() {
  if(!authenticationReady)return;
  const request=++state.stateRequest,generation=state.generation,authentication=authenticationRevision;let data;
  try{data=await api('/api/state');}catch(error){if(request!==state.stateRequest||generation!==state.generation||authentication!==authenticationRevision||!authenticationReady)return;throw error;}
  if(request!==state.stateRequest||generation!==state.generation||authentication!==authenticationRevision||!authenticationReady)return;
  const discovery=state.discoveryRevision,changed=adopt(data);state.switching=false;connection(true);
  if(changed)void connectStream(state.generation,{refreshAuthentication:true});
  if(changed||discovery!==state.discoveryRevision)void refreshVisibleReads({browse:true});
  return {filesStarted:changed||discovery!==state.discoveryRevision};
}
function invalidateOutput({keepPending=false}={}) {
  clearTimeout(state.outputTimer);state.outputTimer=null;
  if(!keepPending)state.outputPending=null;
  state.outputRequest=null;++state.outputSequence;
}
function stopStream() { invalidateUsageOverviewRequest();invalidateRunHistoryRequests();invalidateToolArtifactRequests();state.stream?.abort();state.stream=null;clearTimeout(state.streamTimer);clearTimeout(state.refreshTimer);invalidateOutput();state.fullSessionRequest=null; }
function scheduleOutputRefresh(event) {
  if(state.view!=='chat'||event.sessionId!==state.selected?.id)return;
  state.outputPending=event;
  if(state.outputTimer||state.outputRequest!==null||state.fullSessionRequest!==null)return;
  const generation=state.generation,navigation=state.navigation;
  state.outputTimer=setTimeout(async()=>{
    state.outputTimer=null;const pending=state.outputPending;state.outputPending=null;
    if(generation!==state.generation||navigation!==state.navigation||state.view!=='chat'||pending?.sessionId!==state.selected?.id)return;
    const request=++state.outputSequence;state.outputRequest=request;
    try{await refreshOutput(pending,request);}
    catch{/* A later stream event or reconnect retries from the durable snapshot. */}
    finally{if(state.outputRequest===request){state.outputRequest=null;if(state.outputPending)scheduleOutputRefresh(state.outputPending);}}
  },180);
}
function selectedOutputStep(session) {
  return session.run?.output?.stepId || session.run?.steps?.findLast(step=>step.type==='model'&&step.status==='running')?.id;
}
async function refreshOutput(event,request) {
  const selected=state.selected,run=selected?.run;
  const generation=state.generation,navigation=state.navigation,fullRequest=state.sessionRequest,revision=state.sessionRevision;
  const step=selectedOutputStep(selected);
  const snapshot=await api('/api/sessions/'+encodeURIComponent(event.sessionId)+'/output');
  // Full-session reads and navigation outrank every in-flight draft response,
  // including requests that return after leaving and reopening the same task.
  if(request!==state.outputSequence||generation!==state.generation||navigation!==state.navigation||state.view!=='chat'||selected!==state.selected||run!==state.selected?.run||fullRequest!==state.sessionRequest||revision!==state.sessionRevision||state.fullSessionRequest!==null)return;
  if(snapshot.sessionId!==selected.id)return;
  const next=snapshot.run,output=next?.output;
  if(!run||!next||run.id!==next.id||run.status!==next.status||(event.runId&&event.runId!==next.id))return refreshSession(selected.id);
  if(next.status!=='running')return;
  // A new model step or a cleared draft may accompany real messages, tool
  // results, approvals or a terminal state. Only a full read can adopt those.
  if(!output||output.stepId!==event.stepId||(step&&output.stepId!==step)||typeof output.content!=='string'||(output.publicReasoning!==undefined&&typeof output.publicReasoning!=='string'))return refreshSession(selected.id);
  const previous=run.output;
  if(previous?.stepId===output.stepId){
    if(previous.content.startsWith(output.content)&&previous.content.length>output.content.length)return;
    if(!output.content.startsWith(previous.content))return refreshSession(selected.id);
    const priorReasoning=previous.publicReasoning||'',nextReasoning=output.publicReasoning||'';
    if(priorReasoning.startsWith(nextReasoning)&&priorReasoning.length>nextReasoning.length)return;
    if(!nextReasoning.startsWith(priorReasoning))return refreshSession(selected.id);
    const phase={streaming:0,processing:1,interrupted:2};
    if((phase[output.status]??-1)<(phase[previous.status]??-1))return;
  }
  if(!['streaming','processing','interrupted'].includes(output.status))return refreshSession(selected.id);
  const modelStep=run.steps?.find(item=>item.id===output.stepId&&item.type==='model');
  if(typeof output.publicReasoning==='string'&&modelStep)modelStep.publicReasoning=output.publicReasoning;
  run.output=output;selected.updatedAt=snapshot.updatedAt;
  renderChat({outputOnly:true});
}
function scheduleRefresh(sessionId) {
  invalidateFiles();invalidateAudit();if(legacyBrowseFlight)legacyBrowseFlight.dirty=true;
  const generation=state.generation,authentication=authenticationRevision;clearTimeout(state.refreshTimer);
  const current=()=>generation===state.generation&&authentication===authenticationRevision&&authenticationReady&&!state.switching;
  state.refreshTimer=setTimeout(async()=>{
    if(!current())return;
    try{
      const refreshed=await refreshState();if(!current())return;
      if(state.selected&&(!sessionId||state.selected.id===sessionId))await refreshSession(state.selected.id);
      if(current())void refreshVisibleReads({browse:!refreshed?.filesStarted});
    }catch(error){if(current()&&!error.staleContext)connection(false,error.message);}
  },90);
}
async function connectStream(generation,{refreshAuthentication=false}={}) {
  if(pageSuspended||generation!==state.generation)return;
  const controller=new AbortController(),gateway=state.gateway,bearer=state.bearer;
  state.stream=controller;
  const current=()=>!pageSuspended&&generation===state.generation&&state.stream===controller&&!controller.signal.aborted&&gateway===state.gateway&&bearer===state.bearer;
  let watchdog,retry=true,checkingAuthentication=false;
  const touch=()=>{clearTimeout(watchdog);watchdog=setTimeout(()=>controller.abort(),45000);};
  try {
    if(refreshAuthentication||!authenticationReady){
      // Reconnecting SSE does not refresh the server's per-start CSRF. Preserve
      // the page/draft generation and never replay a write to recover it.
      checkingAuthentication=true;invalidateAuthentication('连接已中断，正在重新验证工作台…');
      const data=await api('/api/bootstrap',{signal:controller.signal});
      if(!current())return;
      validateAuthentication(data);
      const changed=adopt(data);
      if(changed){
        // adopt reset the old workspace and aborted its callbacks.
        state.csrf=data.csrfToken;authenticationReady=true;++authenticationRevision;++state.stateRequest;
        state.switching=false;connection(true);void connectStream(state.generation);void refreshVisibleReads({browse:true});return;
      }
      // A restart may revoke the previous run/approval. Refresh its durable
      // record before reopening writes; navigation still outranks this read.
      if(state.selected)await refreshSession(state.selected.id);
      if(!current())return;
      state.csrf=data.csrfToken;authenticationReady=true;++authenticationRevision;++state.stateRequest;
      state.switching=false;connection(true);checkingAuthentication=false;
      invalidateFiles();invalidateAudit();void refreshVisibleReads({browse:true});
    }
    touch();
    const headers={Accept:'text/event-stream'};if(bearer)headers.Authorization='Bearer '+bearer;
    const response=await fetch(gateway+'/api/events',{headers,credentials:gateway?'omit':'same-origin',signal:controller.signal,cache:'no-store'});
    if(!current())return;
    if(response.status===401||response.status===403){retry=false;invalidateAuthentication('连接认证已失效，请配置网关并重新输入访问令牌。');return;}
    // An authenticated HTTP connection remains usable when a proxy cannot
    // provide SSE. Only the stream retries, with a new authentication check.
    if(!response.ok||!response.body)return;
    state.reconnectAttempt=0;connection(true);
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    while(!controller.signal.aborted){
      const {value,done}=await reader.read();
      if(done||!current())break;
      touch();buffer+=decoder.decode(value,{stream:true}).replace(/\r/g,'');
      if(buffer.length>1000000)throw new Error('事件过长');
      let index;
      while((index=buffer.indexOf('\n\n'))!==-1){
        const event=buffer.slice(0,index);buffer=buffer.slice(index+2);
        const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
        if(data){try{const payload=JSON.parse(data),type=event.split('\n').find(line=>line.startsWith('event:'))?.slice(6).trim();if(type==='stream')scheduleOutputRefresh(payload);else scheduleRefresh(payload.sessionId);}catch{}}
      }
    }
  }catch(error){
    if(generation===state.generation&&state.stream===controller&&!pageSuspended){
      if(error.status===401||error.status===403){retry=false;invalidateAuthentication('连接认证已失效，请配置网关并重新输入访问令牌。');}
      else if(checkingAuthentication)invalidateAuthentication(error.message||'连接已中断，正在重新验证工作台…');
    }
  }finally{
    clearTimeout(watchdog);
    if(generation===state.generation&&state.stream===controller&&!pageSuspended){
      state.stream=null;
      if(retry){const delay=Math.min(15000,1000*2**Math.min(state.reconnectAttempt++,4));state.streamTimer=setTimeout(()=>{void connectStream(generation,{refreshAuthentication:true});},delay);}
    }
  }
}
function showView(view, {focus = true} = {}) {
  if (view === 'home' || (view === 'chat' && state.selected)) composerDrafts.switchSlot(view === 'chat' ? state.selected.id : 'new', view === 'chat' ? state.selected.providerId || state.providerId : state.providerId);
  if(state.branchEditor||providerDiagnostics||handoffEditor)closeDialog({restoreFocus:false});
  if(state.view==='workspace'&&view!=='workspace'){cancelBrowseRequest();cancelWorkspaceSearch({clear:true,notice:'搜索已结束。需要时重新提交查询。'});}
  invalidateUsageOverviewRequest();++state.navigation;state.view=view;invalidateOutput();$("run-panel")._runCache=null;invalidateToolArtifactViews();resetRunHistory(view==='chat'?state.selected?.id:null);
  try{if(view==='chat'&&state.selected)sessionStorage.setItem('openaster.current-session',state.selected.id);else sessionStorage.removeItem('openaster.current-session');}catch{}
  document.querySelectorAll('.view').forEach(node => node.classList.toggle('hidden', node.id !== `${view}-view`));
  const labels = {home:'新任务',chat:'任务对话',workspace:'工作空间',skills:'技能库',settings:'设置',security:'安全与活动'};
  fileEditor?.syncContext();
  $('page-label').textContent = labels[view] || '工作台';
  document.querySelectorAll('.nav-item').forEach(node => { const active = node.dataset.action === view || (view === 'chat' && node.dataset.action === 'home'); node.classList.toggle('active', active); if(active) node.setAttribute('aria-current','page'); else node.removeAttribute('aria-current'); });
  const composerVisible = ['home','chat'].includes(view); $('composer').classList.toggle('hidden', !composerVisible);
  if (composerVisible) {state.composerView=view;imageInput?.bind(state.workspaceKey+':'+(view==='chat'?state.selected.id:'new'));$(`${view}-composer-slot`).append($('composer'));}
  closeSidebar(); updateComposer(); $('main').scrollTop=0; window.scrollTo({top:0,behavior:'instant'});
  commandPolicyUI?.sync({refresh:true});
  void refreshVisibleReads({fresh:true});
  if(focus&&view==='home')$('prompt-input').focus({preventScroll:true});
  else {const heading=$(`${view}-view`)?.querySelector('h1');if(heading&&focus){heading.tabIndex=-1;heading.focus({preventScroll:true});}}
}
function syncSidebarAccessibility() {
  if(!mobileLayout.matches){$('sidebar').classList.remove('open');$('sidebar-scrim').classList.add('hidden');}
  const open = $('sidebar').classList.contains('open');
  const returnToMenu=mobileLayout.matches&&!open&&$('sidebar').contains(document.activeElement)&&!document.querySelector('dialog[open]');
  $('sidebar').inert = mobileLayout.matches && !open;
  $('sidebar').setAttribute('aria-hidden',String(mobileLayout.matches && !open));
  document.querySelector('.main-shell').inert = mobileLayout.matches && open;
  document.querySelector('[data-action="sidebar"]').setAttribute('aria-expanded',String(open));
  if(returnToMenu)document.querySelector('[data-action="sidebar"]').focus({preventScroll:true});
}
function closeSidebar() {
  const wasOpen=$('sidebar').classList.contains('open');
  $('sidebar').classList.remove('open'); $('sidebar-scrim').classList.add('hidden'); syncSidebarAccessibility();
  if(wasOpen && mobileLayout.matches) document.querySelector('[data-action="sidebar"]').focus();
}
function renderSessions() {
  const query=$('search-input').value.trim().toLocaleLowerCase();const filtered=state.sessions.filter(item=>item.title.toLocaleLowerCase().includes(query));
  const list=$('session-list'),focused=list.contains(document.activeElement)?document.activeElement:null;
  const previous=new Map([...list.querySelectorAll('details')].map(node=>[node.dataset.group,node]));
  const rows=new Map([...list.querySelectorAll('.session-row')].map(node=>[node.querySelector('.session-link')?.dataset.id,node]));
  const pinned=new Set(pinnedIds);const active=item=>['running','awaiting_approval'].includes(item.run?.status);
  const groups=[['pinned','置顶任务',filtered.filter(item=>pinned.has(item.id))],['active','正在进行',filtered.filter(item=>!pinned.has(item.id)&&active(item))],['recent','最近任务',filtered.filter(item=>!pinned.has(item.id)&&!active(item))]];
  const keptGroups=new Set();let groupIndex=0;
  for(const [key,label,items]of groups){if(!items.length)continue;let group=previous.get(key);if(!group){group=el('details','session-group');group.dataset.group=key;group.open=true;const summary=el('summary');summary.append(icon('chevron-down'),el('span','',label),el('small'));group.append(summary);}group.querySelector('summary small').textContent=String(items.length);keptGroups.add(group);const keptRows=new Set();let rowIndex=1;
    for(const item of items){const selected=state.selected?.id===item.id&&state.view==='chat';let wrapper=rows.get(item.id);if(!wrapper){wrapper=el('div','session-row');wrapper.append(button('','open-session','session-link',{id:item.id}),button('','pin-session','session-pin icon-button',{id:item.id}));}wrapper.classList.toggle('selected',selected);const row=wrapper.querySelector('.session-link');row.title=item.title;row.setAttribute('aria-current',selected?'page':'false');
      const status=statusText[item.run?.status]||'准备开始',expanded=['running','awaiting_approval','failed'].includes(item.run?.status);row.classList.toggle('session-link-compact',!expanded);row.setAttribute('aria-label',`${item.title}，${status}`);
      const signature=JSON.stringify([item.title,item.run?.status]);if(row._signature!==signature){row._signature=signature;const mark=el('span',`task-state-mark ${item.run?.status||'idle'}`);mark.append(icon(item.run?.status==='awaiting_approval'?'shield':item.run?.status==='running'?'activity':item.run?.status==='completed'?'check':item.run?.status==='failed'?'info':'message'));const copy=el('span','session-copy');copy.append(el('strong','',item.title));if(expanded)copy.append(el('small','',status));row.replaceChildren(mark,copy);}
      const pin=wrapper.querySelector('.session-pin');pin.classList.toggle('is-pinned',pinned.has(item.id));pin.title=pinned.has(item.id)?'取消置顶（此设备）':'置顶到此设备';pin.setAttribute('aria-label',`${pinned.has(item.id)?'取消置顶':'置顶任务'} ${item.title}`);pin.setAttribute('aria-pressed',String(pinned.has(item.id)));if(!pin.firstChild)pin.append(icon('pin'));keptRows.add(wrapper);if(group.children[rowIndex]!==wrapper)group.insertBefore(wrapper,group.children[rowIndex]||null);rowIndex++;
    }for(const child of [...group.children])if(child.tagName!=='SUMMARY'&&!keptRows.has(child))child.remove();if(list.children[groupIndex]!==group)list.insertBefore(group,list.children[groupIndex]||null);groupIndex++;
  }
  for(const child of [...list.children])if(!keptGroups.has(child))child.remove();
  if(!filtered.length){const blank=el('div','sidebar-empty');blank.append(icon(query?'search':'message'),el('strong','',query?'没有匹配的任务':'暂无任务'),el('p','',query?'试试另一个关键词。':'新建任务后在此查看记录。'));list.append(blank);}
  if(focused&&document.activeElement!==focused){if(focused.isConnected&&focused.getClientRects().length)focused.focus({preventScroll:true});else if(document.activeElement===document.body)list.focus({preventScroll:true});}
  const recent=$('recent-list');if(!recent){updateOverview();return;}recent.replaceChildren();if($('recent-count'))$('recent-count').textContent=String(state.sessions.length);
  const items=state.sessions.filter(item=>state.recentFilter==='all'||(state.recentFilter==='active'?active(item):item.run?.status==='completed'));
  document.querySelectorAll('[data-action="filter-recent"]').forEach(node=>{const selected=node.dataset.filter===state.recentFilter;node.classList.toggle('selected',selected);node.setAttribute('aria-pressed',String(selected));});
  if(!items.length){const box=el('div','recent-empty');const text=el('div');text.append(el('strong','',state.sessions.length?'这个分组暂时没有任务':'暂无任务'),el('p','',state.sessions.length?'切换筛选，继续其他任务。':'在上方输入任务内容，或先连接模型。'));box.append(icon('message'),text);recent.append(box);}
  for(const item of items.slice(0,20)){const row=button('','open-session','recent-row',{id:item.id});const copy=el('span','recent-copy');const provider=state.providers.find(p=>p.id===item.providerId);copy.append(el('strong','',item.title),el('small','',provider?.name||'工作台任务'));const status=el('span',`task-status-badge ${item.run?.status||'idle'}`,statusText[item.run?.status]||'准备开始');row.append(icon('message','recent-icon'),copy,status,el('span','recent-time',formatDate(item.updatedAt,true)),icon('arrow-up-right'));recent.append(row);}
  updateOverview();
}
function renderModels() { const select = $('model-select'); const previous = state.providerId; select.replaceChildren(); for (const provider of state.providers.filter(item=>item.enabled!==false)) { const option = el('option','',provider.name+(provider.toolMode==='none'?' · 仅对话':'')); option.value = provider.id; select.append(option); } if (!select.options.length) { const option = el('option','',native&&!state.gateway?'请先配置网关':'请先连接模型'); option.value=''; select.append(option); } select.value = previous; if (previous && !select.value) { const missing = el('option','','原模型不可用，请重新选择'); missing.value=previous;missing.disabled=true;select.append(missing);select.value=previous; } else if (!previous) state.providerId = select.value = select.options[0]?.value || ''; updateComposer(); }
function updateComposer() { syncWebAccessControls(); const busy = state.view === 'chat' && ['running','awaiting_approval'].includes(state.selected?.run?.status); $('cancel-button').classList.toggle('hidden', !busy); $('send-button').classList.toggle('hidden', busy&&!state.taskInputSupported); const send=$('send-button'),missing=state.view==='chat'&&unavailableSessions.has(state.selected),historyPending=!missing&&!currentHistoryReady();
  const switchingInput=state.view==='chat'&&!busy&&state.selected?.queuedInputs?.some(item=>item.status==='pending');
  // Keep a history refresh from swallowing a pointer activation already in progress.
  // sendMessage still validates the complete current history on every activation.
  send.disabled = missing || state.sending || !state.connected || (busy&&!state.taskInputSupported) || !state.providers.some(item=>item.id===state.providerId&&item.enabled!==false) || Boolean(!busy&&state.providers.find(item=>item.id===state.providerId)?.toolMode!=='none'&&state.skillId&&!state.skills.some(item=>item.id===state.skillId)) || (!$('prompt-input').value.trim()&&!imageInput?.hasImages()) || Boolean(imageInput?.pending()) || (imageInput?.hasImages()&&(!state.imagesSupported||state.providers.find(item=>item.id===state.providerId)?.type==='demo')) || (!state.contextFilesSupported&&requiresContextFilesSupport()) || (!handoffSupported&&hasHandoffHistory());
  send.setAttribute('aria-disabled',String(send.disabled||historyPending));
  send.title=missing?'任务已删除，未发送内容仍保留':historyPending?'正在读取任务，完成后可发送':busy?'补充任务，在下一个安全节点处理':'发送任务';send.setAttribute('aria-label',busy&&state.taskInputSupported?'补充任务':'发送任务');
  if(switchingInput){send.disabled=true;send.setAttribute('aria-disabled','true');send.title='正在切换执行，草稿会保留。';}
  taskInputUI?.sync({busy:busy||switchingInput,supported:state.taskInputSupported===true,disabled:send.disabled||historyPending,awaitingApproval:state.selected?.run?.status==='awaiting_approval',switchingInput});
  $('send-hint').textContent=missing?'任务已删除':historyPending?'读取中…':switchingInput?'切换中…':busy&&state.taskInputSupported?'Enter 补充':'Enter 发送'; $('model-select').disabled = busy || switchingInput || state.sending || (native&&!state.gateway); modelPicker?.sync();imageInput?.sync({enabled:state.imagesSupported===true,busy:state.sending,providerType:state.providers.find(item=>item.id===state.providerId)?.type}); const provider = state.providers.find(item=>item.id===state.providerId);const skillToggle=document.querySelector('.skill-toggle');skillToggle.disabled=busy||switchingInput||provider?.toolMode==='none';skillToggle.title=busy?'运行中补充沿用当前技能':provider?.toolMode==='none'?'仅对话模式不加载技能':'选择技能';skillToggle.setAttribute('aria-label',skillToggle.title); $('composer-disclaimer').textContent = provider?.type === 'demo' ? '当前为本地演示，不调用真实模型。可在设置中连接模型。' : provider ? (provider.toolMode==='none'?'仅对话，不调用文件工具 · 输入与历史对话仍会发给模型，可能含先前文件内容':'对话与工具读取的文件会发送至所选模型服务商 · 请核实 AI 结果') : native&&!state.gateway ? '配置 HTTPS 网关后，可使用工作台中的模型。' : '先在设置中连接一个模型，或检查服务连接'; updateDraftFileNote(provider);$('context-history-compatibility').classList.toggle('hidden',state.contextFilesSupported||!hasContextFilesHistory());$('handoff-history-compatibility').classList.toggle('hidden',handoffSupported||!hasHandoffHistory()); const skill = state.skills.find(item=>item.id===state.skillId); $('composer-context').classList.toggle('hidden', !state.skillId); $('skill-label').textContent = provider?.toolMode==='none'&&state.skillId?'仅对话模式 · 本次不加载所选技能':skill ? `技能：${skill.name}` : state.skillId ? '原技能不可用，请移除后再发送' : '';  }
const contextFilesUnsupported='当前工作台版本不支持文件资料，请更新后重连';
function acceptCompleteSession(session,expectedId) {
  if(!session||typeof session.id!=='string'||(expectedId!==undefined&&session.id!==expectedId)||!Array.isArray(session.messages))throw new Error('任务历史未完整返回，请重新打开任务后再发送。');
  completeSessionHistory.add(session);return session;
}
function currentHistoryReady(){return state.view!=='chat'||Boolean(state.selected&&completeSessionHistory.has(state.selected));}
function hasContextFilesHistory(){return state.view==='chat'&&state.selected?.messages?.some(message=>message&&Object.hasOwn(message,'contextFiles'));}
function hasHandoffHistory(){return state.view==='chat'&&state.selected?.messages?.some(message=>message&&Object.hasOwn(message,'contextHandoff'));}
function requiresContextFilesSupport(){return state.draftFiles.length>0||hasContextFilesHistory();}
function contextFileCompatibilityNote() {const note=el('p','context-note file-context-compatibility',contextFilesUnsupported);note.classList.toggle('hidden',state.contextFilesSupported);return note;}
function syncContextFileCapabilities() {
  for(const node of document.querySelectorAll('[data-action=attach-context-file]')){const reference=fileReferences.get(node);node.disabled=!state.contextFilesSupported||!reference?.valid;node.title=!state.contextFilesSupported?contextFilesUnsupported:reference?.valid?'将此预览版本加入本次任务':'文件版本信息不可用，请刷新预览后重试。';}
  for(const note of document.querySelectorAll('.file-context-compatibility'))note.classList.toggle('hidden',state.contextFilesSupported);
  updateComposer();
}
function updateDraftFileNote(provider) {
  $('draft-file-note').textContent=provider?.type==='demo'?'文件快照随消息保存；当前为本地演示。更换模型后仍可作为对话资料发送。':'文件快照将随消息发送给所选模型，并作为后续对话资料保留。';
}
function renderDraftFiles() {
  const list=$('draft-file-list'),keys=new Set();
  for(const [index,file] of state.draftFiles.entries()){
    keys.add(file.path);let node=draftFileNodes.get(file.path);
    if(!node){node=el('div','draft-file-chip');node.dataset.path=file.path;const label=el('span','',file.path);label.title=file.path;const remove=button('','remove-context-file','icon-button',{path:file.path});remove.setAttribute('aria-label','移除文件 '+file.path);remove.append(icon('x'));node.append(icon('file'),label,remove);draftFileNodes.set(file.path,node);}
    node.title=file.path+' · '+formatBytes(file.bytes);if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);
  }
  while(list.children.length>state.draftFiles.length)list.lastElementChild.remove();
  for(const path of draftFileNodes.keys())if(!keys.has(path))draftFileNodes.delete(path);
  $('draft-files').classList.toggle('hidden',!state.draftFiles.length);
  $('draft-file-summary').textContent=state.draftFiles.length?state.draftFiles.length+' / 5 个文件 · '+formatBytes(state.draftFiles.reduce((total,file)=>total+file.bytes,0))+' / 256 KiB':'';
}
function clearContextFileError(){ $('context-file-error').classList.add('hidden');$('context-file-error').textContent=''; }
function clearDraftFiles(){state.draftFiles=[];++state.draftRevision;clearContextFileError();renderDraftFiles();}
function attachmentButton(data,source,request) {
  const node=button('加入本次任务','attach-context-file','text-button');
  fileReferences.set(node,{valid:typeof data.path==='string'&&typeof data.sha256==='string'&&/^[a-f0-9]{64}$/i.test(data.sha256),path:data.path,sha256:data.sha256,bytes:new TextEncoder().encode(data.content).length,generation:state.generation,workspaceKey:state.workspaceKey,source,request,sessionId:state.selected?.id});
  const valid=fileReferences.get(node).valid;node.disabled=!state.contextFilesSupported||!valid;node.title=!state.contextFilesSupported?contextFilesUnsupported:valid?'将此预览版本加入本次任务':'文件版本信息不可用，请刷新预览后重试。';
  return node;
}
function attachContextFile(node) {
  if(!state.contextFilesSupported)throw new Error(contextFilesUnsupported);
  const file=fileReferences.get(node),quick=file?.source==='context';
  if(!file||!node.isConnected||file.generation!==state.generation||file.workspaceKey!==state.workspaceKey||file.request!==(quick?state.contextFileRequest:state.fileRequest)||(quick&&(state.view!=='chat'||file.sessionId!==state.selected?.id))||(!quick&&state.view!=='workspace'))throw new Error('预览所属的任务或工作空间已变化，请重新打开文件后再加入。');
  const folded=file.path.normalize('NFC').toLowerCase();if(state.draftFiles.some(item=>item.path!==file.path&&item.path.normalize('NFC').toLowerCase()===folded))throw new Error('已选择一个仅大小写或 Unicode 形式不同的同名路径，请先移除原引用，避免混淆不同文件。');
  const existing=state.draftFiles.findIndex(item=>item.path===file.path);const next=state.draftFiles.filter(item=>item.path!==file.path);next.splice(existing<0?next.length:existing,0,{path:file.path,sha256:file.sha256,bytes:file.bytes});
  if(next.length>5)throw new Error('每次任务最多加入 5 个文件，请先移除不需要的文件。');
  if(next.reduce((total,item)=>total+item.bytes,0)>256*1024)throw new Error('所选文件合计超过 256 KiB，请减少文件后再发送。');
  state.draftFiles=next;++state.draftRevision;clearContextFileError();renderDraftFiles();composerDrafts.changed();
  if(state.view==='workspace'){const view=state.composerView==='chat'&&state.selected?'chat':'home';showView(view,{focus:false});if(view==='chat'){renderChat();if(!currentHistoryReady()){const generation=state.generation,navigation=state.navigation;void refreshSession(state.selected.id).catch(error=>{if(generation===state.generation&&navigation===state.navigation&&!error.staleContext)toast(error.message,true);});}}}
  updateComposer();$('prompt-input').focus();toast(existing<0?'文件已加入本次任务，填写文字任务后发送。':'已更新本次任务中的文件版本。');
}
function removeContextFile(node) {
  const index=state.draftFiles.findIndex(file=>file.path===node.dataset.path);if(index<0)return;
  state.draftFiles.splice(index,1);++state.draftRevision;clearContextFileError();renderDraftFiles();updateComposer();composerDrafts.changed();
  const next=$('draft-file-list').children[Math.min(index,state.draftFiles.length-1)]?.querySelector('button');(next||$('prompt-input')).focus();
}
function renderMessageFiles(files) {
  const group=el('div','message-context-files');group.append(el('p','context-note','已发送文件快照 · 随这条消息保存，后续对话可能继续使用；内容不是磁盘上的最新版本。'));
  for(const file of files){const detail=el('details','message-context-file');detail.append(el('summary','',file.path),el('p','context-file-hash','SHA-256 · '+file.sha256));detail.addEventListener('toggle',()=>{if(detail.open&&!detail.querySelector('pre'))detail.append(scrollText(file.content,'context-file-content','已发送文件快照：'+file.path));});group.append(detail);}return group;
}
function markSessionUnavailable(id) {
  const previous=state.selected;if(previous?.id!==id||unavailableSessions.has(previous))return;
  // A missing task is not a lost workspace. Keep the original composer slot,
  // navigation and any independent file editor; never migrate or send its draft.
  completeSessionHistory.delete(previous);
  state.selected={id,title:previous.title,providerId:previous.providerId,createdAt:previous.createdAt,messages:[],approvals:[],run:null};
  unavailableSessions.add(state.selected);++state.sessionRevision;++state.stateRequest;
  invalidateOutput();invalidateToolArtifactViews();resetRunHistory(null);
  state.sessions=state.sessions.filter(item=>item.id!==id);
  if(pinnedIds.includes(id)){pinnedIds=pinnedIds.filter(value=>value!==id);saveStorage('openaster.pins',JSON.stringify(pinnedIds));}
  messageSession='';messageCache.clear();approvalCache.clear();approvalHistoryCache.clear();outputCache=null;
  if(state.view==='chat')renderChat();else{updateComposer();syncBranchControls();}
  renderSessions();
}
async function refreshSession(id) {
  if(state.selected?.id===id&&unavailableSessions.has(state.selected))return;
  const request=++state.sessionRequest,generation=state.generation,navigation=state.navigation;
  ++state.sessionRevision;state.fullSessionRequest=request;invalidateOutput({keepPending:true});
  if(state.selected?.id===id){completeSessionHistory.delete(state.selected);updateComposer();syncBranchControls();}
  try{
    const {session}=await api('/api/sessions/'+encodeURIComponent(id));
    if(request!==state.sessionRequest||generation!==state.generation||navigation!==state.navigation||state.selected?.id!==id)return;
    ++state.sessionRevision;state.selected=acceptCompleteSession(session,id);if(state.view==='chat')renderChat();
  }catch(error){
    if(request!==state.sessionRequest||generation!==state.generation||navigation!==state.navigation||state.selected?.id!==id)return;
    if(error.status===404&&error.code==='SESSION_NOT_FOUND'){markSessionUnavailable(id);return;}
    throw error;
  }finally{
    if(state.fullSessionRequest===request){state.fullSessionRequest=null;if(state.outputPending)scheduleOutputRefresh(state.outputPending);}
  }
}
async function openSession(id) {
  const known=state.sessions.find(item=>item.id===id);state.selected=known||{id,title:'正在加载…'};completeSessionHistory.delete(state.selected);
  showView('chat');renderChat();renderModels();renderSessions();
  const generation=state.generation,navigation=state.navigation;await refreshSession(id);
  if(generation!==state.generation||navigation!==state.navigation||state.selected?.id!==id)return;
}
function renderChat({outputOnly=false}={}) {
  const session = state.selected; if (!session) return;
  const missing=unavailableSessions.has(session);
  $('chat-title').textContent = session.title; $('page-label').textContent = '任务对话';
  const renameControl=document.querySelector('[data-action="rename"]');renameControl.disabled=missing||['running','awaiting_approval'].includes(session.run?.status);renameControl.title=missing?'任务已删除':renameControl.disabled?'任务结束后可重命名':'重命名任务';
  for(const action of ['delete-session','export-session','pin-current'])for(const control of document.querySelectorAll(`[data-action="${action}"]`))control.disabled=missing;
  const messages = $('messages');const scroller=mobileLayout.matches?document.scrollingElement:document.querySelector('.conversation-scroll');const nearBottom=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<=8;const newSession=messageSession!==session.id;
  if(outputOnly){
    const previousHeight=scroller.scrollHeight;
    executionFlow.render(session.run,{key:session.id+':'+session.run?.id,providerName:state.providers.find(item=>item.id===session.providerId)?.name||''});
    const partial=renderOutput(session);
    if(partial){
      const old=messages.querySelector('.pending-output');if(old&&old!==partial.node)old.remove();
      messages.querySelector('.typing-indicator')?.remove();
      if(partial.node.parentNode!==messages)messages.append(partial.node);
    }
    if(nearBottom&&(partial?.changed||scroller.scrollHeight!==previousHeight)){if(mobileLayout.matches)window.scrollTo({top:scroller.scrollHeight,behavior:'instant'});else scroller.scrollTop=scroller.scrollHeight;}
    return;
  }

  if(messageSession !== session.id){messageSession=session.id;messageCache.clear();approvalCache.clear();approvalHistoryCache.clear();outputCache=null;messages.replaceChildren();$('approval-list')._signature=null;$('context-preview').classList.add('hidden');$('context-preview').replaceChildren();}
  const nodes=[];const keys=new Set();let changed=false;
  const flow=executionFlow.render(session.run,{key:session.id+':'+session.run?.id,providerName:state.providers.find(item=>item.id===session.providerId)?.name||''});
  const lastUserIndex=(session.messages||[]).findLastIndex(item=>item.role==='user');
  for(const [index,item] of (session.messages || []).entries()) {
    if(!['user','assistant','system'].includes(item.role)) continue;
    const key=item.id || `${item.role}:${index}`;keys.add(key);let cached=messageCache.get(key);
    const files=item.role==='user'&&Array.isArray(item.contextFiles)?item.contextFiles.filter(file=>typeof file?.path==='string'&&typeof file.sha256==='string'&&typeof file.content==='string'):[];const fileSignature=JSON.stringify([files,item.contextHandoff??null,item.images??null]);
    if(!cached || cached.content !== item.content || cached.role !== item.role || cached.createdAt !== item.createdAt || cached.fileSignature !== fileSignature) {
      const article=el('article',`message ${item.role}`);const heading=el('div','message-heading');
      heading.append(el('strong','',item.role==='user'?'你':item.role==='assistant'?'OpenAster':'工作台'),el('time','',formatDate(item.createdAt)));
      if(item.role==='user'&&typeof item.id==='string'&&item.id){article.dataset.messageId=item.id;const edit=button('','branch-message','icon-button message-branch-button',{messageId:item.id});edit.setAttribute('aria-label','编辑并新建分支');edit.append(icon('pen'));heading.append(edit);}
      article.append(heading);if(String(item.content||"").trim()||!item.images?.length)article.append(renderMarkdown(item.content));if(item.images?.length)article.append(renderMessageImages(item.images));if(files.length)article.append(renderMessageFiles(files));if(item.role==='user'&&item.contextHandoff)article.append(renderHandoffSnapshot(item.contextHandoff));cached={content:item.content,role:item.role,createdAt:item.createdAt,fileSignature,node:article};messageCache.set(key,cached);changed=true;
    }
    nodes.push(cached.node);if(flow&&index===lastUserIndex)nodes.push(flow);
  }
  for(const key of messageCache.keys()) if(!keys.has(key))messageCache.delete(key);
  if(!nodes.length){const ready=currentHistoryReady(),historyState=missing?'missing':String(ready),title=missing?'任务已删除':ready?'新任务':'正在读取任务';let placeholder=messages.querySelector('.empty-state');if(placeholder?.dataset.historyState!==historyState){placeholder=empty(title,missing?'未发送的文字和文件引用仍保留在下方。可以复制内容或从本机草稿查看，再新建任务继续。':ready?'告诉智能体你的目标，也可以先导入参考文本。':'完整对话读取后即可继续发送，输入框中的草稿会保留。',missing?'info':ready?'sparkles':'activity');placeholder.dataset.historyState=historyState;if(missing){placeholder.setAttribute('role','status');placeholder.append(button('新建任务','new'));}}nodes.push(placeholder);}
  const partial=renderOutput(session);if(partial){nodes.push(partial.node);changed=changed||partial.changed;}
  const queued=queuedInputView?.render(session);if(queued&&!queued.hidden)nodes.push(queued);
  if(session.run?.status==='running'&&!partial&&!flow){
    let typing=messages.querySelector('.typing-indicator');if(!typing){typing=el('div','typing-indicator');typing.append(el('span'),el('span'),el('span'),el('small','','智能体正在处理，请稍候…'));}
    nodes.push(typing);
  }
  nodes.forEach((node,index)=>{if(messages.children[index]!==node){messages.insertBefore(node,messages.children[index] || null);changed=true;}});
  while(messages.children.length>nodes.length){messages.lastElementChild.remove();changed=true;}
  if(!outputOnly){renderRun(session.run);renderApprovals(session.approvals || []);renderUsage(session);if(missing){if(state.runHistory?.sessionId)resetRunHistory(null);}else observeRunHistory(session);renderContext();renderBranchOrigin(session);syncBranchControls();syncContextPanel();
    $('run-error').classList.toggle('hidden',!session.run?.error);$('run-error').textContent=session.run?.error?stringify(session.run.error):'';updateComposer();}
  if(changed&&(nearBottom||newSession)){if(mobileLayout.matches)window.scrollTo({top:scroller.scrollHeight,behavior:'instant'});else scroller.scrollTop=scroller.scrollHeight;}
}
function renderOutput(session) {
  const output=session.run?.output;
  if(!output||typeof output.content!=='string'||!output.content){outputCache=null;return null;}
  const key=session.id+':'+session.run.id+':'+output.stepId;
  let changed=false;
  if(outputCache?.key!==key){
    const node=el('article','message pending-output');node.setAttribute('aria-live','off');node.dataset.stepId=output.stepId;
    const heading=el('div','message-heading');const status=el('span','output-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    heading.append(el('strong','','OpenAster'),status);const content=el('div','stream-content');node.append(heading,content);
    outputCache={key,node,status,content,text:'',phase:''};changed=true;
  }
  const phase=['streaming','processing','interrupted'].includes(output.status)?output.status:'interrupted';
  const retrying=phase==='interrupted'&&session.run?.status==='running'&&session.run.steps?.some(step=>step.phase==='retrying');
  const phaseLabel=retrying?'连接中断 · 等待重试':({streaming:'正在生成 · 未完成',processing:'正在处理 · 未完成',interrupted:'已中断 · 未完成'})[phase];
  if(outputCache.phase!==phase||outputCache.status.textContent!==phaseLabel){outputCache.phase=phase;outputCache.node.classList.toggle('interrupted',phase==='interrupted');outputCache.status.textContent=phaseLabel;changed=true;}
  if(outputCache.text!==output.content){
    if(outputCache.content.firstChild&&output.content.startsWith(outputCache.text))outputCache.content.firstChild.appendData(output.content.slice(outputCache.text.length));
    else outputCache.content.textContent=output.content;
    outputCache.text=output.content;changed=true;
  }
  return{node:outputCache.node,changed};
}
function renderRun(run) {
  const panel=$('run-panel'),key=JSON.stringify([state.navigation,state.selected?.id,run?.id]);let cache=panel._runCache;
  if(!cache||cache.key!==key){panel.replaceChildren();const title=el('div','run-panel-title');title.append(icon('activity'),el('span','','任务进度'));panel.append(title);cache={key,entries:new Map(),status:el('div','run-status'),list:el('ol','timeline'),note:el('p','run-panel-note')};panel._runCache=cache;panel.append(cache.status,cache.list,cache.note);if(commandPolicyUI)panel.append(commandPolicyUI.taskNode);}
  cache.status.className=`run-status ${run?.status||''}`;cache.status.textContent=run?(statusText[run.status]||run.status):'';cache.status.hidden=!run;
  cache.note.textContent=!run?'你的执行步骤与工具调用会在这里显示。':!run.steps?.length?'正在准备任务…':'';cache.note.hidden=Boolean(run?.steps?.length);
  const keys=new Set();for(const [index,step]of(run?.steps||[]).entries()){
    const stepKey=step.id||`legacy-${index}`;keys.add(stepKey);let entry=cache.entries.get(stepKey);
    if(!entry){entry={node:el('li'),disclosure:el('details','run-step'),summary:el('summary'),title:el('strong'),status:el('span','run-step-status'),detail:el('p'),extra:el('div','step-context-extra'),signature:null};entry.summary.append(icon(step.type==='tool'?'code':'activity'),entry.title,entry.status,icon('chevron-down','run-step-chevron'));entry.disclosure.append(entry.summary,entry.detail);entry.node.append(entry.disclosure,entry.extra);cache.entries.set(stepKey,entry);}
    entry.node.className=step.status||'';entry.node.dataset.stepId=stepKey;entry.title.textContent=step.title||step.type;entry.status.textContent=statusText[step.status]||step.status||'';entry.detail.textContent=stringify(step.detail)||'此步骤没有附加说明。';
    const referenced=new Set((Array.isArray(step.contextPlan?.toolResults)?step.contextPlan.toolResults:[]).map(item=>item?.artifactId));const signature=JSON.stringify([step.type,step.contextPlan,step.toolResultRef,(run.steps||[]).map(item=>item.toolResultRef).filter(ref=>ref&&referenced.has(ref.artifactId))]);
    if(entry.signature!==signature){const detailKey=node=>node.classList.contains('model-context-plan')?'plan':node.dataset.artifactId;const opened=new Set([...entry.extra.querySelectorAll('details[open]')].map(detailKey));const focused=document.activeElement?.tagName==='SUMMARY'&&entry.extra.contains(document.activeElement)?detailKey(document.activeElement.parentElement):null;entry.signature=signature;entry.extra.replaceChildren();appendStepContext(entry.extra,step,run,state.selected.id,false);for(const details of entry.extra.querySelectorAll('details')){details.open=opened.has(detailKey(details));if(focused&&detailKey(details)===focused)details.querySelector(':scope>summary')?.focus({preventScroll:true});}}
    if(cache.list.children[index]!==entry.node)cache.list.insertBefore(entry.node,cache.list.children[index]||null);
  }
  for(const [id,entry]of cache.entries)if(!keys.has(id)){entry.node.remove();cache.entries.delete(id);}syncToolArtifactCapabilities();commandPolicyUI?.sync({refresh:true});
}
const contextByteNumber=new Intl.NumberFormat('zh-CN');
const artifactUnsupported='当前工作台版本不支持读取工具原记录，请更新后重连。';
const byteCount=value=>Number.isSafeInteger(value)&&value>=0;
const artifactRefValid=ref=>ref&&typeof ref.artifactId==='string'&&typeof ref.name==='string'&&byteCount(ref.bytes)&&/^[a-f0-9]{64}$/.test(ref.sha256);
function invalidateToolArtifactViews(){for(const view of toolArtifactViews)++view.request;toolArtifactViews.clear();}
function invalidateToolArtifactRequests(){for(const view of toolArtifactViews){++view.request;if(view.loading){view.loading=false;view.status.textContent='连接已刷新，请重新读取这页原记录。';view.region.setAttribute('aria-busy','false');updateArtifactControls(view);}}}
function syncToolArtifactCapabilities(){
  for(const view of toolArtifactViews){if(!view.node.isConnected){++view.request;toolArtifactViews.delete(view);continue;}
    if(!state.toolArtifactsSupported){++view.request;view.loading=false;view.page=null;view.offsets=[];view.text.textContent='';view.text.hidden=true;view.webContent?.replaceChildren();view.status.textContent=artifactUnsupported;view.region.setAttribute('aria-busy','false');}
    else if(view.status.textContent===artifactUnsupported)view.status.textContent='展开后按页读取当时保存的工具返回原文。';
    updateArtifactControls(view);
  }
}
function updateArtifactControls(view){const unavailable=!state.toolArtifactsSupported||view.loading;view.read.disabled=unavailable;view.previous.disabled=unavailable||!view.offsets.length;view.next.disabled=unavailable||view.page?.nextOffset==null;view.read.textContent=view.page?'重新读取本页':'读取第一页';}
function artifactViewValid(view,generation,navigation,request){return toolArtifactViews.has(view)&&view.node.isConnected&&state.generation===generation&&state.navigation===navigation&&view.request===request&&state.view==='chat'&&state.selected?.id===view.sessionId&&(view.historical||state.selected?.run?.id===view.runId)&&state.toolArtifactsSupported;}
function validArtifactPage(artifact,page,view,offset) {
  return artifact?.id===view.ref.artifactId&&artifact.sessionId===view.sessionId&&artifact.runId===view.runId&&artifact.bytes===view.ref.bytes&&artifact.sha256===view.ref.sha256&&page?.offset===offset&&byteCount(page.endOffset)&&page.endOffset>=offset&&page.endOffset<=artifact.bytes&&typeof page.content==='string'&&new TextEncoder().encode(page.content).byteLength===page.endOffset-offset&&page.endOffset-offset<=16384&&(page.nextOffset===null?page.endOffset===artifact.bytes:page.nextOffset===page.endOffset&&page.endOffset>offset&&page.endOffset<artifact.bytes)&&page.complete===(offset===0&&page.endOffset===artifact.bytes);
}
function createToolArtifactView(ref,run,sessionId,historical=false){
  const node=el('details','tool-artifact-view');node.dataset.artifactId=ref.artifactId;
  node.append(el('summary','','查看当时工具结果 · '+(ref.path||webToolNames[ref.name]||ref.name)));
  const region=el('div','tool-artifact-region');region.setAttribute('aria-busy','false');
  region.append(el('p','context-note',`工具：${webToolNames[ref.name]||ref.name}${ref.isError?' · 返回错误':''} · 原记录 ${contextByteNumber.format(ref.bytes)} 字节`),el('p','context-note artifact-hash','SHA-256：'+ref.sha256),el('p','context-note',Object.hasOwn(webToolNames,ref.name)?'以下来自当时保存的网页工具记录；网页可能已变化，内容可能不完整。':'以下按页显示当时保存的完整工具返回 JSON 的片段；工具自身的扫描范围可能不完整。这不是当前磁盘文件。'));
  const status=el('p','context-note artifact-page-status',state.toolArtifactsSupported?'展开后按页读取当时保存的工具返回原文。':artifactUnsupported);status.setAttribute('role','status');
  const text=scrollText('','history-output tool-artifact-content','当时工具结果的原文片段');text.hidden=true;
  const controls=el('div','tool-artifact-controls'),read=button('读取第一页','','text-button'),previous=button('上一页','','text-button'),next=button('下一页','','text-button');controls.append(previous,next,read);
  const webContent=Object.hasOwn(webToolNames,ref.name)?el('div','web-tool-content'):null;
  if(webContent){const raw=el('details','web-tool-raw');raw.append(el('summary','','原始 JSON 记录'),status,text,controls);region.append(webContent,raw);}else region.append(status,text,controls);node.append(region);
  const view={node,region,status,text,read,previous,next,ref,webContent,runId:run.id,sessionId,historical,request:0,loading:false,page:null,offsets:[]};toolArtifactViews.add(view);
  node.addEventListener('toggle',()=>{if(node.open&&!view.page&&!view.loading&&state.toolArtifactsSupported)void loadToolArtifactPage(view,0);});
  read.addEventListener('click',()=>void loadToolArtifactPage(view,view.page?.offset||0));
  previous.addEventListener('click',()=>{if(view.offsets.length)void loadToolArtifactPage(view,view.offsets.at(-1),'previous');});
  next.addEventListener('click',()=>{if(view.page?.nextOffset!=null)void loadToolArtifactPage(view,view.page.nextOffset,'next');});updateArtifactControls(view);return node;
}
async function loadToolArtifactPage(view,offset,direction='reload'){
  if(view.loading||!state.toolArtifactsSupported)return;
  const generation=state.generation,navigation=state.navigation,request=++view.request;
  if(!artifactViewValid(view,generation,navigation,request))return;
  view.loading=true;view.status.textContent='正在读取当时工具结果…';view.region.setAttribute('aria-busy','true');updateArtifactControls(view);
  try{
    const {artifact,page}=await api(`/api/sessions/${encodeURIComponent(view.sessionId)}/runs/${encodeURIComponent(view.runId)}/artifacts/${encodeURIComponent(view.ref.artifactId)}?offset=${offset}&maxBytes=16384`);
    if(!artifactViewValid(view,generation,navigation,request))return;
    const valid=validArtifactPage(artifact,page,view,offset);
    if(!valid)throw new Error('原记录分页内容与所选工具结果不一致，已拒绝显示。');
    if(direction==='next')view.offsets.push(view.page.offset);else if(direction==='previous')view.offsets.pop();view.page=page;view.text.textContent=page.content;view.text.hidden=false;
    view.status.textContent=`UTF-8 字节范围 [${contextByteNumber.format(page.offset)}, ${contextByteNumber.format(page.endOffset)}) / ${contextByteNumber.format(artifact.bytes)}${page.complete?' · 全文已显示':page.nextOffset===null?' · 已到末页':' · 尚有后续原文'}`;
    if(view.webContent&&offset===0){
      view.webContent.replaceChildren(el('p','context-note','正在读取网页来源与内容…'));
      if(artifact.bytes>128*1024)throw new Error('网页记录超过展示上限，请按页查看原始 JSON。');
      let content=page.content,last=page,pages=1;
      while(last.nextOffset!==null){
        if(++pages>9)throw new Error('网页记录分页超过展示上限，请按页查看原始 JSON。');
        const nextOffset=last.nextOffset,result=await api(`/api/sessions/${encodeURIComponent(view.sessionId)}/runs/${encodeURIComponent(view.runId)}/artifacts/${encodeURIComponent(view.ref.artifactId)}?offset=${nextOffset}&maxBytes=16384`);
        if(!artifactViewValid(view,generation,navigation,request))return;
        if(!validArtifactPage(result.artifact,result.page,view,nextOffset))throw new Error('网页原记录分页不一致，已拒绝显示。');
        last=result.page;content+=last.content;
      }
      const bytes=new TextEncoder().encode(content),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
      if(!artifactViewValid(view,generation,navigation,request))return;
      if(bytes.byteLength!==artifact.bytes||hash!==artifact.sha256)throw new Error('网页原记录校验未通过，已拒绝显示。');
      const value=JSON.parse(content),rendered=renderWebToolResult(view.ref.name,value);
      if(rendered?.classList.contains('web-tool-result')){
        const result=value.result,provider=webSearchService(result.provider);
        if(provider)rendered.prepend(el('p','context-note web-search-source-provider','搜索服务：'+provider.name));
        if(view.ref.name==='search_web'&&result.summaryKind==='model-generated'&&typeof result.summary==='string'&&result.summary){
          const summary=el('section','web-search-summary');summary.setAttribute('aria-label','模型生成的搜索摘要');summary.append(el('p','context-note','模型生成的搜索摘要 · 非网页原文'),createCodeBlock('text',result.summary));rendered.append(summary);
        }
      }
      view.webContent.replaceChildren(rendered||el('p','context-note','此记录没有可识别的网页来源，请查看原始 JSON。'));
    }
  }catch(error){if(artifactViewValid(view,generation,navigation,request)&&!error.staleContext){view.status.textContent='读取失败：'+error.message;if(view.webContent)view.webContent.replaceChildren(el('p','context-note',view.status.textContent));}}
  finally{if(artifactViewValid(view,generation,navigation,request)){view.loading=false;view.region.setAttribute('aria-busy','false');updateArtifactControls(view);}}
}
function appendStepContext(container,step,run,sessionId,historical){
  if(step.type==='tool'&&artifactRefValid(step.toolResultRef))container.append(createToolArtifactView(step.toolResultRef,run,sessionId,historical));
  if(step.type!=='model')return;
  const details=el('details','model-context-plan');details.append(el('summary','','本轮请求上下文'));container.append(details);
  const plan=step.contextPlan;
  if(!plan||plan.version!==1||plan.policy!=='preserve-messages-reference-tools'||!byteCount(plan.requestBytes)||!byteCount(plan.requestByteLimit)||!byteCount(plan.preservedMessages)||!Array.isArray(plan.toolResults)){
    details.append(el('p','context-note','此记录未提供可识别的请求上下文计划。'));return;
  }
  const modes={full:'完整包含',excerpt:'节选包含',reference:'仅保留引用'};const counts=Object.keys(modes).map(mode=>`${modes[mode]} ${plan.toolResults.filter(item=>item.mode===mode).length} 项`);
  details.append(el('p','context-plan-summary',counts.join(' · ')),el('p','context-note',`保留 ${plan.preservedMessages} 条非工具消息；只调整工具结果的请求表示，不改写原消息或用户文件快照。`),el('p','context-note',`协议请求正文 ${contextByteNumber.format(plan.requestBytes)} / ${contextByteNumber.format(plan.requestByteLimit)} 字节（UTF-8，包含 JSON 转义）。这是应用请求容量，不是 token 用量；不代表服务商已成功接收。`));
  if(typeof plan.requestSha256==='string')details.append(el('p','context-note artifact-hash','请求 SHA-256：'+plan.requestSha256));
  if(!plan.toolResults.length)details.append(el('p','context-note','本轮请求没有工具结果。'));
  const refs=new Map((run.steps||[]).filter(item=>artifactRefValid(item.toolResultRef)).map(item=>[item.toolResultRef.artifactId,item.toolResultRef]));
  for(const item of plan.toolResults){const row=el('div','context-plan-tool');row.dataset.mode=item.mode;const ref=refs.get(item.artifactId);
    row.append(el('strong','',`${modes[item.mode]||'方式未识别'} · ${ref?.path||ref?.name||'工具原记录'}`),el('p','context-note',`原记录 ${byteCount(item.sourceBytes)?contextByteNumber.format(item.sourceBytes):'未知'} 字节 → 请求中的工具表示 ${byteCount(item.sentBytes)?contextByteNumber.format(item.sentBytes):'未知'} 字节；该表示大小不等于含转义的协议正文大小。`));
    if(item.mode==='reference')row.append(el('p','context-note','原正文未包含在本轮请求中，仅提供引用；原记录未因此删除。'));
    if(Array.isArray(item.ranges)&&item.ranges.length)row.append(el('p','context-note',`保留原文 UTF-8 字节范围（右端不含）：${item.ranges.map(range=>`[${range.start}, ${range.end})`).join('、')}`));
    if(ref)row.append(createToolArtifactView(ref,run,sessionId,historical));else row.append(el('p','context-note','此记录没有可读取的原工具结果引用。'));details.append(row);
  }
}
const usageFields = ['inputTokens','outputTokens','totalTokens','cachedInputTokens','cacheWriteInputTokens','reasoningOutputTokens'];
const validTokenCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
const tokenNumber = new Intl.NumberFormat('zh-CN');
function renderUsage(session) { renderUsagePanel($('usage-summary'),session.run,state.providers.find(item=>item.id===session.providerId)?.type,session.id); }
function renderUsagePanel(panel,run,providerType,scope,historical=false) {
  const models=(run?.steps||[]).filter(step=>step.type==='model');
  const reported=models.map(step=>Object.fromEntries(usageFields.map(key=>[key,validTokenCount(step.usage?.[key])?step.usage[key]:null])));
  const signature=JSON.stringify([scope,run?.id,run?.status,providerType,historical,reported]);
  if(panel._signature===signature)return;
  panel._signature=signature;panel.replaceChildren();
  if(!run){panel.append(el('p','context-empty','尚未运行。'));return;}
  if(!models.length){panel.append(el('p','context-empty',providerType==='demo'?'本地演示，未调用模型。':historical?'记录中没有模型步骤，未提供模型用量。':'尚未开始模型调用。'));return;}
  const complete=reported.filter(usage=>usageFields.slice(0,3).every(key=>usage[key]!==null)).length;
  panel.append(el('p','context-empty usage-coverage',`${models.length} 轮中 ${complete} 轮返回完整用量`));
  const hasAny=reported.some(usage=>usageFields.some(key=>usage[key]!==null));
  if(!hasAny){panel.append(el('p','context-note usage-empty',!historical&&run.status==='running'?'等待模型回报用量；尚无已知数值。':'模型未提供用量。'));return;}
  const allComplete=complete===models.length;
  const totals=Object.fromEntries(usageFields.map(key=>{
    const values=reported.map(usage=>usage[key]).filter(value=>value!==null);
    const sum=values.reduce((total,value)=>total+value,0);
    return[key,values.length?(Number.isSafeInteger(sum)?sum:'overflow'):null];
  }));
  function row(key,label) {
    const line=el('div','context-data-row usage-row');line.dataset.usageField=key;
    const value=totals[key];
    line.append(el('span','',label),el('strong','',value===null?'未提供':value==='overflow'?'超出显示范围':`${tokenNumber.format(value)} token`));
    panel.append(line);
  }
  for(const [key,label]of [['inputTokens','输入'],['outputTokens','输出'],['totalTokens','合计']])row(key,`${allComplete?'':'已知'}${label}`);
  const subfields=[['cachedInputTokens','缓存读取'],['cacheWriteInputTokens','缓存写入'],['reasoningOutputTokens','推理输出']].filter(([key])=>totals[key]!==null);
  for(const [key,label]of subfields)row(key,`${reported.every(usage=>usage[key]!==null)?'':'已知'}${label}`);
  if(subfields.length)panel.append(el('p','context-note usage-subset-note','缓存与推理为输入/输出的子量，不重复计入合计。'));
  panel.append(el('p','context-note usage-scope-note',`${allComplete?'':'仅汇总已回报数值；缺失数据不按 0 计算。'}用量由模型服务商回报，仅限本次运行，不代表费用或账单。`));
}
// Usage is an explicit, workspace-scoped snapshot. Stream/state updates never
// refresh or append its pages; an opaque cursor belongs to exactly one snapshot.
function resetUsageOverview({close=false}={}) {
  state.usageOverview={snapshot:null,groups:[],nextCursor:null,loading:false,error:'',stale:false,request:0};
  $('usage-overview-summary').replaceChildren();$('usage-overview-groups').replaceChildren();
  if(close)$('usage-overview').open=false;
  renderUsageOverviewStatus();
}
function syncUsageOverviewCapability(supported) {
  if(state.usageOverviewSupported===supported&&state.usageOverview)return;
  state.usageOverviewSupported=supported;resetUsageOverview();
}
function invalidateUsageOverviewRequest() {
  const overview=state.usageOverview;if(!overview)return;
  ++overview.request;
  if(overview.loading){overview.loading=false;overview.stale=Boolean(overview.snapshot);overview.error='读取已中断，请刷新用量。';renderUsageOverviewStatus();}
}
function renderUsageOverviewStatus() {
  const overview=state.usageOverview,supported=state.usageOverviewSupported;
  $('usage-overview-status').textContent=!supported?'当前工作台版本不支持运行用量，请更新后重连。':overview?.loading?'正在读取工作区用量快照…':overview?.error||(!overview?.snapshot?'展开后读取；也可手动刷新。':'');
  const refresh=$('usage-overview-refresh');refresh.disabled=!supported;refresh.textContent=overview?.loading?'重新读取':'刷新用量';
  const snapshot=overview?.snapshot;
  $('usage-overview-snapshot').textContent=snapshot?`${overview.stale?'旧快照 · ':''}快照时间：${new Date(snapshot.generatedAt).toLocaleString('zh-CN',{hour12:false})}`:'';
  const more=$('usage-overview-more');more.classList.toggle('hidden',!supported||!overview?.nextCursor);more.disabled=Boolean(overview?.loading||overview?.stale);more.textContent=overview?.loading?'正在读取…':'加载更多连接记录';
  $('usage-overview-content').setAttribute('aria-busy',String(Boolean(overview?.loading)));
}
function validUsageStats(stats) {
  const count=value=>Number.isSafeInteger(value)&&value>=0;
  if(!stats||!stats.runs||!['total','running','awaitingApproval','completed','failed','cancelled'].every(key=>count(stats.runs[key])))return false;
  if(!['modelSteps','stepsWithCompleteUsage','stepsWithAnyUsage','stepsWithoutUsage','unclassifiedSteps','runsWithoutStepData','unattributedRuns','demoRuns'].every(key=>count(stats[key])))return false;
  if(stats.stepsWithCompleteUsage>stats.stepsWithAnyUsage||stats.stepsWithAnyUsage+stats.stepsWithoutUsage!==stats.modelSteps)return false;
  return usageFields.every(key=>{
    const token=stats.tokens?.[key];
    return token&&count(token.reportedSteps)&&count(token.missingSteps)&&token.reportedSteps+token.missingSteps===stats.modelSteps&&(token.knownSum===null?token.reportedSteps===0:typeof token.knownSum==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(token.knownSum)&&token.reportedSteps>0);
  });
}
function validUsagePage(data) {
  return data?.version===1&&data.scope==='retained-workspace-runs'&&typeof data.snapshotId==='string'&&/^(0|[1-9][0-9]*)$/.test(data.snapshotId)&&data.snapshotId.length<=40&&typeof data.generatedAt==='string'&&Number.isFinite(new Date(data.generatedAt).getTime())&&validUsageStats(data.summary)&&Array.isArray(data.groups)&&data.groups.length<=20&&(data.nextCursor===null||typeof data.nextCursor==='string'&&data.nextCursor.length>0&&data.nextCursor.length<=8192)&&data.groups.every(group=>group&&(group.key==='unknown'||typeof group.key==='string'&&/^[a-f0-9]{64}$/.test(group.key))&&(group.connection===null||['providerId','name','type','model','toolMode'].every(key=>typeof group.connection?.[key]==='string'&&group.connection[key].length<=4096))&&validUsageStats(group.stats));
}
function usageOverviewStats(stats) {
  const panel=el('div','usage-overview-stats');
  panel.append(el('p','usage-overview-count',`${stats.runs.total} 次运行 · ${stats.modelSteps} 个模型步骤`));
  if(!stats.runs.total){panel.append(el('p','context-note','当前工作区尚无已保存的运行。'));return panel;}
  const phases=[['running','运行中'],['awaitingApproval','等待批准'],['completed','已完成'],['failed','失败'],['cancelled','已停止']];
  panel.append(el('p','context-note usage-overview-phases',phases.filter(([key])=>stats.runs[key]>0).map(([key,label])=>`${label} ${stats.runs[key]}`).join(' · ')));
  if(stats.modelSteps){
    panel.append(el('p','usage-overview-coverage',`${stats.modelSteps} 个模型步骤中，${stats.stepsWithCompleteUsage} 个完整回报输入、输出和合计；${stats.stepsWithAnyUsage-stats.stepsWithCompleteUsage} 个部分回报；${stats.stepsWithoutUsage} 个未提供用量。`));
    const grid=el('div','usage-overview-tokens');
    for(const [key,label]of [['inputTokens','输入'],['outputTokens','输出'],['totalTokens','合计'],['cachedInputTokens','缓存读取'],['cacheWriteInputTokens','缓存写入'],['reasoningOutputTokens','推理输出']]){
      const token=stats.tokens[key],row=el('div','usage-overview-token');row.dataset.usageOverviewField=key;
      const labelNode=el('span','',`${token.missingSteps?'已知':''}${label}`),value=el('strong','',token.knownSum===null?'未提供':token.knownSum.replace(/\B(?=(\d{3})+(?!\d))/g,',')+' token');
      row.append(labelNode,value,el('span','context-note',`${token.reportedSteps} / ${stats.modelSteps} 个模型步骤回报`));grid.append(row);
    }
    panel.append(grid,el('p','context-note','缓存与推理为输入或输出的子量，不重复加入合计。各字段覆盖范围可能不同。'));
  }else panel.append(el('p','context-note','尚无已识别的模型步骤，未提供模型用量。'));
  const limitations=[];
  if(stats.demoRuns)limitations.push(`${stats.demoRuns} 次本地演示运行`);
  if(stats.runsWithoutStepData)limitations.push(`${stats.runsWithoutStepData} 次运行缺少步骤记录`);
  if(stats.unclassifiedSteps)limitations.push(`${stats.unclassifiedSteps} 个旧步骤类型未知，未计入模型步骤`);
  if(stats.unattributedRuns)limitations.push(`${stats.unattributedRuns} 次运行的历史连接未知`);
  if(limitations.length)panel.append(el('p','context-note usage-overview-limitations',limitations.join('；')+'。'));
  return panel;
}
function usageOverviewGroup(group) {
  const node=el('details','usage-overview-group');node.dataset.usageGroup=group.key;
  const connection=group.connection,summary=el('summary');
  summary.append(el('span','usage-overview-group-name',connection?connection.name+' · '+connection.model:'历史连接未知'),el('span','context-note',`${group.stats.runs.total} 次运行 · ${group.stats.modelSteps} 个模型步骤`));node.append(summary);
  node.addEventListener('toggle',()=>{if(!node.open||node.dataset.loaded)return;node.dataset.loaded='true';
    if(connection)node.append(el('p','context-note usage-overview-connection',`${connection.type} · ${connection.toolMode==='none'?'仅对话':'工作区工具'} · 连接标识：${connection.providerId}`));
    node.append(usageOverviewStats(group.stats));
  });return node;
}
async function loadUsageOverview({more=false}={}) {
  if(state.view!=='settings'||!state.usageOverviewSupported)return;
  if(!state.usageOverview)resetUsageOverview();
  const overview=state.usageOverview;
  if(more&&(!overview.nextCursor||overview.loading||overview.stale))return;
  const request=++overview.request,generation=state.generation,navigation=state.navigation,workspace=state.workspaceKey,snapshot=overview.snapshot,moreFocusStart=more&&document.activeElement===$('usage-overview-more');
  const valid=()=>state.usageOverview===overview&&request===overview.request&&generation===state.generation&&navigation===state.navigation&&workspace===state.workspaceKey&&state.view==='settings'&&state.usageOverviewSupported;
  overview.loading=true;overview.error='';renderUsageOverviewStatus();
  try{
    const data=await api('/api/usage?limit=20'+(more?'&cursor='+encodeURIComponent(overview.nextCursor):''));if(!valid())return;
    if(!validUsagePage(data))throw new Error('服务返回了无法识别的用量快照，请更新工作台后重试。');
    if(more&&data.snapshotId!==snapshot?.snapshotId)throw Object.assign(new Error('用量记录已变化，请刷新后从头读取。'),{code:'USAGE_SNAPSHOT_CHANGED'});
    const keys=new Set(more?overview.groups.map(group=>group.key):[]);
    for(const group of data.groups){if(keys.has(group.key))throw new Error('连接记录重复，未合并此次结果，请刷新用量。');keys.add(group.key);}
    const list=$('usage-overview-groups'),moreFocused=moreFocusStart&&(document.activeElement===document.body||document.activeElement===$('usage-overview-more'));
    if(!more){
      const opened=new Set([...list.children].filter(node=>node.open).map(node=>node.dataset.usageGroup));
      const focused=list.contains(document.activeElement),focusKey=document.activeElement?.closest('.usage-overview-group')?.dataset.usageGroup;
      overview.snapshot={snapshotId:data.snapshotId,generatedAt:data.generatedAt,summary:data.summary};overview.groups=[];list.replaceChildren();
      $('usage-overview-summary').replaceChildren(usageOverviewStats(data.summary),el('h3','usage-overview-group-heading','按当时连接与模型分组'),el('p','context-note','使用运行时保存的连接信息；改名或删除当前连接不会改写这些记录。'));
      for(const group of data.groups){const node=usageOverviewGroup(group);node.open=opened.has(group.key);list.append(node);}
      if(focused)([...list.children].find(node=>node.dataset.usageGroup===focusKey)?.querySelector('summary')||$('usage-overview-refresh')).focus({preventScroll:true});
    }else for(const group of data.groups)list.append(usageOverviewGroup(group));
    overview.groups.push(...data.groups);overview.nextCursor=data.nextCursor;overview.stale=false;
    if(moreFocused&&!data.nextCursor)(list.lastElementChild?.querySelector('summary')||$('usage-overview-refresh')).focus({preventScroll:true});
  }catch(error){
    if(!valid()||error.staleContext)return;
    overview.stale=Boolean(overview.snapshot);
    overview.error=error.code==='USAGE_SNAPSHOT_CHANGED'?'用量记录已变化，已停止分页。请刷新用量，从头读取同一快照。':error.status===413?'记录规模超出统计范围，本次未生成用量汇总。'+(overview.snapshot?' 下方仍为旧快照。':''):'读取失败：'+error.message+(overview.snapshot?' 下方仍为旧快照。':'');
  }finally{if(valid()){overview.loading=false;renderUsageOverviewStatus();if(moreFocusStart&&document.activeElement===document.body)(overview.nextCursor&&!overview.stale?$('usage-overview-more'):$('usage-overview-refresh')).focus({preventScroll:true});}}
}
function resetRunHistory(sessionId) {
  state.runHistory={sessionId:sessionId||null,loaded:false,loading:false,error:'',items:[],nextCursor:null,listRequest:0,entries:new Map(),hasNew:false};
  $('run-history').open=false;$('run-history-list').replaceChildren();renderRunHistoryStatus();
}
function invalidateRunHistoryRequests() {
  const history=state.runHistory;if(!history)return;
  ++history.listRequest;history.loading=false;for(const entry of history.entries.values()){++entry.request;entry.loading=false;}
}
function validHistoryRequest(history,generation,navigation) {
  return state.runHistory===history&&state.generation===generation&&state.navigation===navigation&&state.view==='chat'&&state.selected?.id===history.sessionId;
}
function observeRunHistory(session) {
  const history=state.runHistory;if(!history||history.sessionId!==session.id)return;
  if(history.loaded&&['completed','cancelled','failed'].includes(session.run?.status)&&!history.items.some(item=>item.id===session.run.id))history.hasNew=true;
  renderRunHistoryStatus();
  if($('run-history').open&&!history.loaded&&!history.loading&&!history.error)void loadRunHistory();
  if($('run-history').open)for(const [id,entry]of history.entries)if(entry.node.open&&!entry.loaded&&!entry.loading&&!entry.error)void loadRunRecord(id);
}
function renderRunHistoryStatus() {
  const history=state.runHistory;
  $('run-history-count').textContent=history?.loaded?'已加载 '+history.items.length+' 次':'';
  $('run-history-status').textContent=history?.error?'读取失败：'+history.error:history?.loading?'正在读取执行记录…':history?.loaded&&!history.items.length?'尚无已结束的执行记录。':'';
  $('run-history-new').classList.toggle('hidden',!history?.hasNew);
  const more=$('run-history-more');more.classList.toggle('hidden',!history?.nextCursor);more.disabled=Boolean(history?.loading);more.textContent=history?.loading?'正在读取…':'加载更早记录';
  $('run-history-list').setAttribute('aria-busy',String(Boolean(history?.loading)));
}
function historyTime(value) {const date=new Date(value);return typeof value==='string'&&Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'时间未记录';}
function historyConnection(connection) {return connection?`${connection.name||'未命名连接'} · ${connection.model||connection.type||'型号未记录'}${connection.toolMode==='none'?' · 仅对话':''}`:'历史连接未知';}
function createRunHistoryEntry(item) {
  const node=el('details','run-history-entry');node.dataset.runId=item.id;
  const summary=el('summary');summary.append(el('span','history-run-status',statusText[item.status]||'历史状态未知'),el('time','',historyTime(item.startedAt)),el('span','history-request',item.requestPreview??'请求摘要未记录'));
  const meta=el('p','context-note',historyConnection(item.connection)+' · '+item.stepCount+' 个步骤 · '+item.approvalCount+' 条审批');
  const content=el('div','run-history-detail');node.append(summary,meta,content);
  const entry={node,content,summary:item,signature:JSON.stringify(item),request:0,loading:false,loaded:false,error:false};
  node.addEventListener('toggle',()=>{if(node.open&&!entry.loaded&&!entry.loading&&state.runHistory?.entries.get(item.id)===entry)void loadRunRecord(item.id);});
  return entry;
}
async function loadRunHistory({more=false}={}) {
  const history=state.runHistory;if(!history?.sessionId||state.view!=='chat'||state.selected?.id!==history.sessionId)return;
  if(more&&(!history.nextCursor||history.loading))return;
  const cursor=more?history.nextCursor:null,generation=state.generation,navigation=state.navigation,request=++history.listRequest,previousCount=history.items.length;
  const moreFocused=document.activeElement===$('run-history-more');history.loading=true;history.error='';renderRunHistoryStatus();
  try{
    const query=new URLSearchParams({limit:'10'});if(cursor)query.set('cursor',cursor);
    const result=await api(`/api/sessions/${encodeURIComponent(history.sessionId)}/runs?${query}`);
    if(!validHistoryRequest(history,generation,navigation)||request!==history.listRequest)return;
    if(result.sessionId!==history.sessionId||!Array.isArray(result.runs))throw new Error('执行记录响应与当前任务不一致。');
    const unique=new Map((more?history.items:[]).map(item=>[item.id,item]));for(const item of result.runs)if(typeof item.id==='string')unique.set(item.id,item);
    history.items=[...unique.values()];history.nextCursor=typeof result.nextCursor==='string'&&result.nextCursor?result.nextCursor:null;history.loaded=true;history.hasNew=false;
    const list=$('run-history-list'),keys=new Set(history.items.map(item=>item.id));
    history.items.forEach((item,index)=>{let entry=history.entries.get(item.id);if(!entry||entry.signature!==JSON.stringify(item)){entry=createRunHistoryEntry(item);history.entries.set(item.id,entry);}if(list.children[index]!==entry.node)list.insertBefore(entry.node,list.children[index]||null);});
    while(list.children.length>history.items.length)list.lastElementChild.remove();for(const id of history.entries.keys())if(!keys.has(id))history.entries.delete(id);
    if(more&&moreFocused&&!history.nextCursor&&history.items.length>previousCount)list.children[previousCount]?.querySelector('summary')?.focus({preventScroll:true});
    observeRunHistory(state.selected);
  }catch(error){if(validHistoryRequest(history,generation,navigation)&&request===history.listRequest&&!error.staleContext)history.error=error.message;}
  finally{if(validHistoryRequest(history,generation,navigation)&&request===history.listRequest){history.loading=false;renderRunHistoryStatus();}}
}
function renderRunRecord(record) {
  const run=record.run,section=el('div','history-record');
  const title=el('h3','',`只读执行记录 · ${statusText[run.status]||'历史状态未知'}`);section.append(title,el('p','context-note',historyConnection(run.connection)),el('p','context-note','开始：'+historyTime(run.startedAt)+'；结束：'+historyTime(run.finishedAt)));
  if(run.requestPreview!=null)section.append(el('p','history-request',run.requestPreview));
  if(run.error){section.append(el('h4','','错误'),scrollText(stringify(run.error),'history-output','历史执行错误'));}
  section.append(el('h4','','执行步骤'));const steps=el('ol','history-steps');
  const stepStatus={completed:'已完成',failed:'失败',cancelled:'已中断',running:'当时未完成',pending:'当时未完成',awaiting_approval:'当时未完成'};
  for(const step of run.steps||[]){const row=el('li');row.append(el('strong','',step.title||step.type||'未命名步骤'),el('span','context-note',stepStatus[step.status]||'状态未记录'));if(step.detail)row.append(el('p','',stringify(step.detail)));row.append(createModelStepNotes().render(step));appendStepContext(row,step,run,record.sessionId,true);steps.append(row);}section.append(steps);if(!steps.children.length)section.append(el('p','context-note','此记录未保存步骤。'));
  section.append(el('h4','','此次执行用量'));const usage=el('div','history-usage');renderUsagePanel(usage,run,run.connection?.type,run.id,true);section.append(usage);
  if(typeof run.output?.content==='string'&&run.output.content){section.append(el('h4','','未完成输出'),el('p','context-note','这是当时保留的未完成片段，不是完成的答案。'),scrollText(run.output.content,'history-output','历史未完成输出'));}
  section.append(el('h4','','审批记录'));if(!record.approvals?.length)section.append(el('p','context-note','此记录没有审批元数据。'));
  for(const approval of record.approvals||[]){
    if(approval.tool==='run_command'){
      const line=el('article','history-approval'),location=commandApprovalLocation(approval.command,false);
      line.append(el('strong','',({approved:'已批准',denied:'已拒绝',revoked:'已撤销'}[approval.status]||'状态未记录')+' · 命令执行'),location.node);
      if(location.count)line.append(commandPreviewNotice(null,location.count));
      line.append(el('p','context-note',approval.startedAt?'已记录进程启动：'+historyTime(approval.startedAt):'未记录进程启动；批准不等于执行成功。'));
      if(approval.command?.sha256)line.append(el('code','artifact-hash','命令 SHA-256：'+approval.command.sha256));if(approval.resolvedAt)line.append(el('p','context-note','决定时间：'+historyTime(approval.resolvedAt)));section.append(line);continue;
    }
    const line=el('article','history-approval');const status={approved:'已批准',denied:'已拒绝',revoked:'已撤销'}[approval.status]||'状态未记录';line.append(el('strong','',status+' · '+(approval.path||'路径未记录')),el('p','context-note',(approval.tool==='edit_file'?'文件修改':approval.tool==='write_file'?'文件写入':'操作未记录')+' · '+(approval.appliedAt?'已记录实际应用：'+historyTime(approval.appliedAt):'未记录实际应用；批准不等于成功写入。')));if(approval.resolvedAt)line.append(el('p','context-note','决定时间：'+historyTime(approval.resolvedAt)));section.append(line);
  }
  section.append(el('p','context-note','历史记录仅供查看，不恢复执行，也不能再次批准。'));return section;
}
async function loadRunRecord(id) {
  const history=state.runHistory,entry=history?.entries.get(id);if(!entry||state.view!=='chat'||state.selected?.id!==history.sessionId)return;
  const generation=state.generation,navigation=state.navigation,request=++entry.request;entry.loading=true;entry.error=false;entry.content.replaceChildren(el('p','context-note','正在读取这次执行…'));entry.content.setAttribute('aria-busy','true');
  try{const {record}=await api(`/api/sessions/${encodeURIComponent(history.sessionId)}/runs/${encodeURIComponent(id)}`);
    if(!validHistoryRequest(history,generation,navigation)||history.entries.get(id)!==entry||entry.request!==request)return;
    if(record?.sessionId!==history.sessionId||record.run?.id!==id)throw new Error('记录内容与所选执行不一致。');
    entry.content.replaceChildren(renderRunRecord(record));entry.loaded=true;
  }catch(error){if(validHistoryRequest(history,generation,navigation)&&history.entries.get(id)===entry&&entry.request===request&&!error.staleContext){entry.error=true;entry.content.replaceChildren(el('p','context-note','记录不可用：'+error.message),button('重新读取此记录','retry-run-record','text-button',{id}));}}
  finally{if(validHistoryRequest(history,generation,navigation)&&history.entries.get(id)===entry&&entry.request===request){entry.loading=false;entry.content.setAttribute('aria-busy','false');}}
}
function approvalPreview(approval) {
  if(approval.tool==='run_command')return commandApprovalValid(approval);
  const preview=approval.preview;
  return Boolean(preview&&(typeof preview.before==='string'||preview.before===null)&&typeof preview.after==='string'&&typeof approval.args?.content==='string'&&preview.after===approval.args.content);
}
function commandApprovalValid(approval){
  const command=approval.command;
  return Boolean(command&&typeof command.command==='string'&&command.command.trim()&&command.command.length<=8000&&command.command.isWellFormed()&&!command.command.includes('\0')&&typeof command.cwd==='string'&&command.cwd.isWellFormed()&&!command.cwd.includes('\0')&&['powershell','sh'].includes(command.shell)&&Number.isSafeInteger(command.timeoutMs)&&command.timeoutMs>=1000&&command.timeoutMs<=120000);
}
function commandPreviewCharacters(value,isPath=false){
  // Presentation only: keep the proposal untouched for approval and execution.
  const content=document.createDocumentFragment();let plain='',count=0,offset=0;
  for(const character of value){
    const point=character.codePointAt(0);
    const layout=!isPath&&(character==='\n'||character==='\t'||(character==='\r'&&value[offset+1]==='\n'));
    if((point<0x20&&!layout)||(point>=0x7f&&point<=0x9f)||/\p{Cf}/u.test(character)){
      if(plain){content.append(document.createTextNode(plain));plain='';}
      const code='U+'+point.toString(16).toUpperCase().padStart(4,'0');
      const marker=el('span','command-control','⟦'+code+'⟧');marker.title='原文实际包含字符 '+code;content.append(marker);count++;
    }else plain+=character;
    offset+=character.length;
  }
  if(plain)content.append(document.createTextNode(plain));
  return {content,count};
}
function commandApprovalLocation(command={},includeTimeout=true){
  const location=commandPreviewCharacters(command.cwd||'工作区根目录',true);
  const node=el('p','context-note'),path=el('span','command-cwd');path.append(location.content);
  node.append((command.shell==='powershell'?'PowerShell':'POSIX sh')+' · 工作目录：',path);
  if(includeTimeout)node.append(' · 最长 '+(command.timeoutMs/1000)+' 秒');
  return {node,count:location.count};
}
function commandPreviewNotice(commandCount,pathCount){
  const fields=(commandCount===null?'':'命令 '+commandCount+' 个，')+'工作目录 '+pathCount+' 个';
  return el('p','context-note command-control-note','检测到 '+((commandCount||0)+pathCount)+' 个控制或不可见格式字符（'+fields+'）。带边框的 U+XXXX 标记表示原文字符；命令与工作目录原文保持不变。');
}
function commandApprovalContent(approval){
  const fragment=document.createDocumentFragment();const command=approval.command;
  const location=commandApprovalLocation(command),preview=commandPreviewCharacters(command.command);
  fragment.append(location.node);
  if(preview.count||location.count)fragment.append(commandPreviewNotice(preview.count,location.count));
  const code=scrollText('','approval-preview approval-command','完整待执行命令');code.append(preview.content);fragment.append(code);
  return fragment;
}
function formatDocument(info) {
  if(!info.exists)return '文件不存在';
  if(info.oversized)return '超出差异预览大小上限，格式未分析';
  const endings=Object.entries(info.endings).filter(([,count])=>count>0).map(([kind,count])=>kind+' '+count).join(' / ')||'无换行符';
  return (info.bom?'有 UTF-8 BOM':'无 BOM')+' · '+endings+' · '+(info.finalEnding?'末尾有 '+info.finalEnding+' 换行':'末尾无换行')+' · '+info.lines+' 行';
}
function renderFileDiff(before,after) {
  const diff=buildTextDiff(before,after),region=el('div','approval-diff');
  const formats=el('div','diff-formats');formats.append(el('p','','原文：'+formatDocument(diff.summary.before)),el('p','','拟写入：'+formatDocument(diff.summary.after)));region.append(formats);
  if(diff.mode==='fallback'){
    const reasons={bytes:'文本超过 256 KiB',lines:'两份文本合计超过 10,000 行','long-line':'存在超过 4,000 字符的长行',matrix:'变更区间超过行匹配预算',display:'差异超过 500 个显示行'};
    region.append(el('p','diff-fallback',reasons[diff.reason]+'；未生成行差异。请展开下方完整原文与完整拟写入内容审核，不代表没有改动。'));return region;
  }
  const note=diff.changed?(diff.added||diff.removed?'增加 '+diff.added+' 行 · 删除 '+diff.removed+' 行':'正文行相同；文件存在状态或 BOM 格式发生变化。'):'内容与格式均未改变。';
  region.append(el('p','diff-summary',note));
  if(!diff.rows.length)return region;
  const viewport=el('div','diff-scroll');viewport.tabIndex=0;viewport.setAttribute('role','region');viewport.setAttribute('aria-label','文件行差异：减号为删除，加号为新增，等号为保留；列为原行号、拟写入行号和内容');
  const table=el('table','diff-table');const head=el('thead');const headings=el('tr');for(const label of ['原行','新行','变更','内容','换行']){const cell=el('th','',label);cell.scope='col';headings.append(cell);}head.append(headings);table.append(head);
  const body=el('tbody');for(const line of diff.rows){const row=el('tr','diff-row '+line.kind);row.dataset.kind=line.kind;if(line.kind==='gap'){const gap=el('td','diff-gap','… 已折叠 '+line.count+' 行未变内容；完整内容可在下方查看');gap.colSpan=5;row.append(gap);}else{
    row.append(el('td','diff-line-number',line.oldLine??'—'),el('td','diff-line-number',line.newLine??'—'),el('td','diff-sign',({add:'+',remove:'−',context:'='})[line.kind]));const code=el('td','diff-code');code.append(el('code','',line.text||' '));row.append(code,el('td','diff-ending',line.ending||'无'));}body.append(row);}table.append(body);viewport.append(table);region.append(viewport);return region;
}
function createApprovalCard(approval) {
  if(approval.tool==='run_command'){
    const card=el('article','approval-card command-approval');card.dataset.approvalId=approval.id;
    const heading=el('h3');heading.append(icon('terminal'),el('span','','执行命令需批准'));card.append(heading);
    const valid=commandApprovalValid(approval);
    if(valid)card.append(commandApprovalContent(approval));else card.append(el('p','diff-unavailable','完整命令预览不可用，请拒绝并重新生成提案。'));
    card.append(el('p','context-note','命令以本机当前用户权限执行，可修改文件和访问网络；工作目录不是安全沙箱。“批准这次命令”只允许上方这一条。可随时停止任务。'));
    const actions=el('div','approval-actions'),approve=button('批准这次命令','approve','button primary',{id:approval.id});approve.disabled=!valid;actions.append(approve,button('拒绝','deny','button secondary',{id:approval.id}));if(valid&&commandPolicyUI?.pendingEligibility(approval.id)?.sessionEligible===true)actions.append(button('批准并授权本轮…','approve-task','button secondary',{id:approval.id}));card.append(actions);return card;
  }
  const card=el('article','approval-card');card.dataset.approvalId=approval.id;const heading=el('h3');heading.append(icon('shield'),el('span','',approval.tool==='edit_file'?'文件修改需批准':'文件写入需批准'));
  card.append(heading,el('p','',approval.description||'智能体请求写入工作文件。批准仅对这一次操作有效。'),el('code','approval-path',approval.args?.path||approval.preview?.path||''));
  const valid=approvalPreview(approval);
  if(valid){const {before,after}=approval.preview;const changes=el('details','approval-changes');changes.dataset.approval=approval.id+':diff';changes.open=true;changes.append(el('summary','','查看行差异'),renderFileDiff(before,after));card.append(changes);
    const complete=el('details','approval-complete');complete.dataset.approval=approval.id+':after';complete.append(el('summary','','查看完整写入内容（'+after.length+' 字符）'),scrollText(after,'approval-preview approval-full-content','完整写入提案'));card.append(complete);
    if(before!==null){const old=el('details','approval-original');old.dataset.approval=approval.id+':before';old.append(el('summary','','此文件已存在：查看原始内容'),scrollText(before,'approval-preview approval-full-content','原始文件完整内容'));card.append(old,el('p','','批准后将替换上方路径的原内容。'));}
  }else card.append(el('p','diff-unavailable','完整写入预览不可用或与提案不一致。为避免批准未知内容，请拒绝此请求并重新生成提案。'));
  const actions=el('div','approval-actions');const approve=button('批准这次写入','approve','button primary',{id:approval.id});approve.disabled=!valid;actions.append(approve,button('拒绝','deny','button secondary',{id:approval.id}));card.append(actions);return card;
}
function renderApprovals(approvals) {
  const container=$('approval-list'),historyHost=$('run-panel'),signature=JSON.stringify([approvals,commandPolicyUI?.signature()]);if(container._signature===signature&&container._historyHost===historyHost._runCache)return;container._signature=signature;container._historyHost=historyHost._runCache;
  const nodes=[],pending=new Set();for(const approval of approvals.filter(item=>item.status==='pending')){pending.add(approval.id);const key=JSON.stringify([approval,commandPolicyUI?.pendingEligibility(approval.id)?.sessionEligible===true]);let cached=approvalCache.get(approval.id);if(!cached||cached.key!==key){cached={key,node:createApprovalCard(approval)};approvalCache.set(approval.id,cached);}nodes.push(cached.node);}
  for(const id of approvalCache.keys())if(!pending.has(id))approvalCache.delete(id);
  const resolved=approvals.filter(item=>item.status!=='pending'),resolvedIds=new Set(resolved.map(item=>item.id));for(const id of approvalHistoryCache.keys())if(!resolvedIds.has(id))approvalHistoryCache.delete(id);
  if(resolved.length){let history=historyHost.querySelector(':scope>.approval-history');if(!history){history=el('details','approval-history');history.append(el('summary'));historyHost.append(history);}history.firstElementChild.textContent='已处理的审批（'+resolved.length+'）';const records=[];
    for(const approval of resolved){const key=JSON.stringify(approval);let cached=approvalHistoryCache.get(approval.id);if(approval.tool==='run_command'){if(cached?.key===key){records.push(cached.node);continue;}const record=el('article','approval-record');const status=approval.revoked?'已撤销':approval.status==='approved'?'已批准':'已拒绝';record.append(el('strong','',status+' · 命令执行'));if(approval.description)record.append(el('p','context-note',approval.description));record.append(el('p','',approval.startedAt?'已记录进程启动；退出状态与结果请查看任务进度。':'未记录进程启动；批准不等于执行成功。'));if(commandApprovalValid(approval)){const details=el('details');details.append(el('summary','','查看当时的命令'),commandApprovalContent(approval));record.append(details);}approvalHistoryCache.set(approval.id,{key,node:record});records.push(record);continue;}if(!cached||cached.key!==key){const record=el('article','approval-record');const status=approval.revoked===true?'已撤销':({approved:'已批准',denied:'已拒绝'}[approval.status]||'已处理');record.append(el('strong','',status+' · '+(approval.args?.path||approval.description||'文件写入')),el('p','',approval.status==='approved'?'批准决定已记录；是否成功写入请以任务进度和文件内容为准。':'此条审批已结束，不能再次批准。'));const after=approval.preview?.after??approval.args?.content;if(typeof after==='string'){const details=el('details');details.append(el('summary','','查看当时的写入提案'));details.addEventListener('toggle',()=>{if(details.open&&!details.querySelector('pre'))details.append(scrollText(after,'approval-preview approval-full-content','完整写入提案'));});record.append(details);}else record.append(el('p','approval-archived','完整预览已归档，仅保留审批状态与路径等元数据。'));cached={key,node:record};approvalHistoryCache.set(approval.id,cached);}records.push(cached.node);}
    records.forEach((node,index)=>{if(history.children[index+1]!==node)history.insertBefore(node,history.children[index+1]||null);});while(history.children.length>records.length+1)history.lastElementChild.remove();
  }else historyHost.querySelector(':scope>.approval-history')?.remove();
  nodes.forEach((node,index)=>{if(container.children[index]!==node)container.insertBefore(node,container.children[index]||null);});while(container.children.length>nodes.length)container.lastElementChild.remove();
  container.hidden=!nodes.length;
}
async function sendMessage(event,{mode='queue'}={}) {
  event?.preventDefault(); const content = $('prompt-input').value.trim();
  const imageToken=imageInput?.snapshot();const images=imageToken?.images.map(({name,mimeType,data})=>({name,mimeType,data}))||[];
  if (imageInput?.pending())return;
  if ((!content&&!images.length) || nativeLeaveLock || state.sending || state.switching || !state.connected) return;
  if(state.view==='chat'&&unavailableSessions.has(state.selected)){toast('任务已删除，未发送内容仍保留。请新建任务后再发送。',true);return;}
  const busy=state.view==='chat'&&['running','awaiting_approval'].includes(state.selected?.run?.status);
  if(state.view==='chat'&&!busy&&state.selected?.queuedInputs?.some(item=>item.status==='pending')){toast('正在切换到已接收的补充内容，草稿已保留。');return;}
  if(mode==='interrupt'&&!busy){toast('当前任务已结束，草稿仍保留。可直接发送新一轮任务。');return;}
  if(busy&&!state.taskInputSupported){toast('此工作台暂不支持运行中补充，草稿已保留。',true);return;}
  if (!state.providers.some(item=>item.id===state.providerId&&item.enabled!==false) || (!busy&&state.providers.find(item=>item.id===state.providerId)?.toolMode!=='none'&&state.skillId&&!state.skills.some(item=>item.id===state.skillId))) {toast('请选择可用的模型和技能后再发送。',true);return;}
  if(images.length&&(!state.imagesSupported||state.providers.find(item=>item.id===state.providerId)?.type==='demo')){toast('请选择支持图片的真实模型，并确认工作台已支持图片消息。',true);return;}
  if (composerDrafts.uncertain()) {toast('上一次发送的结果尚未确认。请先核对任务记录，再打开本机草稿确认。',true);return;}
  if(!currentHistoryReady()){toast('正在读取任务，本次尚未发送。草稿已保留，请读取完成后再次发送。',true);return;}
  if(!handoffSupported&&hasHandoffHistory()){toast(handoffUnsupported+'；未发送消息，草稿已保留。',true);return;}
  if(!state.contextFilesSupported&&requiresContextFilesSupport()){toast(contextFilesUnsupported+'；未发送内容。请移除未发送引用，或新建不含文件资料的任务。',true);return;}
  const steering=busy?{mode,requestId:crypto.randomUUID(),expectedRunId:state.selected.run.id}:null;
  const navigation = state.navigation; const generation = state.generation; const sendRequest=++state.sendRequest; const providerId = state.providerId; const skillId = state.providers.find(item=>item.id===state.providerId)?.toolMode==='none'?'':state.skillId;
  const draftRevision=state.draftRevision;const files=state.draftFiles.map(({path,sha256})=>({path,sha256}));clearContextFileError();
  let targetSession = state.view === 'chat' ? state.selected : null;
  let draftToken = null, messageStarted = false;
  state.sending = true; updateComposer();
  try {
    draftToken = await composerDrafts.beginSend();
    if(generation!==state.generation)return;
    if (!targetSession) {
      const result = await api('/api/sessions', {method:'POST',body:{providerId}}); if (generation !== state.generation) throw new Error('连接已切换，请在当前工作台重新发送。'); targetSession = acceptCompleteSession(result.session);
      if (navigation === state.navigation) {
        const keepInputFocus=document.activeElement===$('prompt-input')&&!document.querySelector('dialog[open]');
        composerDrafts.moveCreated(draftToken,targetSession.id,true);if(imageToken)imageInput.moveCreated(imageToken,state.workspaceKey+':'+targetSession.id);
        state.selected=targetSession;showView('chat',{focus:false});renderChat();
        if(keepInputFocus)$('prompt-input').focus({preventScroll:true});
      }
    }
    const id = targetSession.id;
    if(generation!==state.generation)return;
    if(!state.contextFilesSupported&&(files.length||targetSession.messages.some(message=>message&&Object.hasOwn(message,'contextFiles'))))throw new Error(contextFilesUnsupported+'；未发送消息，草稿已保留。');
    if(!handoffSupported&&targetSession.messages.some(message=>message&&Object.hasOwn(message,'contextHandoff')))throw new Error(handoffUnsupported+'；未发送消息，草稿已保留。');
    messageStarted = true;
    const result = await api(`/api/sessions/${encodeURIComponent(id)}/messages`, {method:'POST',body:{content,...(steering||{providerId,skillId:skillId || undefined}),...(files.length?{files}:{}),...(images.length?{images}:{})}});
    composerDrafts.finishSend(draftToken,{accepted:true});if(imageToken)imageInput.accepted(imageToken);
    if (generation !== state.generation) return;
    if(steering)toast(steering.mode==='interrupt'?'已保存补充，并请求停止当前步骤后继续。':'补充已保存，将在安全节点处理。');
    if (state.selected?.id === id) { ++state.sessionRequest; state.selected = acceptCompleteSession(result.session,id); if(state.view === 'chat') renderChat(); }
    if (!draftToken && state.draftRevision===draftRevision && $('prompt-input').value.trim() === content) {$('prompt-input').value = '';clearDraftFiles();}
    if (!draftToken && state.skillId === skillId) state.skillId = '';
    if (!draftToken) composerDrafts.changed();
    await refreshState(); if(state.selected?.id === id) await refreshSession(id);
  } catch (error) { composerDrafts.finishSend(draftToken,{definite:!messageStarted || error.notSent===true || (error.status>=400&&error.status<500)}); if(generation===state.generation&&!error.staleContext){if(['CONTEXT_FILE_CHANGED','CONTEXT_FILES_LIMIT','INVALID_CONTEXT_FILES'].includes(error.code)&&state.draftRevision===draftRevision){$('context-file-error').textContent=error.message+' 请重新预览并加入文件，或移除引用后重试。';$('context-file-error').classList.remove('hidden');}toast(error.message, true);} }
  finally { if(sendRequest===state.sendRequest){state.sending = false; updateComposer();} }
}
function renderSkills() { const container = $('skills-list'); container.replaceChildren(); for (const [index,skill] of state.skills.entries()) { const card = el('article','skill-card'); card.append(icon(['pen','code','chart','folder','sparkles'][index%5],`template-icon ${['lilac','mint','blue','apricot'][index%4]}`),el('h3','',skill.name),el('p','',skill.description),button('使用这个技能','use-skill','button secondary',{id:skill.id})); container.append(card); } if (!state.skills.length) container.append(empty(state.connected?'暂无项目技能':'等待技能加载',state.connected?'在上方技能目录创建技能文件夹，并添加 SKILL.md。仍可直接开始普通任务。':'连接工作台后显示可用技能。','sparkles')); }
function renderProviders(){
  const container=$('providers-list');container.replaceChildren();const labels={demo:'本地演示',openai:'Chat Completions',responses:'Responses',anthropic:'Anthropic',ollama:'Ollama'};
  for(const provider of state.providers){const row=el('article','provider-row');const copy=el('div','provider-copy');const title=el('div','provider-title');title.append(el('strong','',provider.name),el('span','badge',labels[provider.type]||provider.type));if(provider.toolMode==='none')title.append(el('span','badge','仅对话'));if(provider.enabled===false)title.append(el('span','badge','已停用'));copy.append(title,el('p','',provider.type==='demo'?'确定性的本地演示 · 不调用 AI · 无需密钥':`${provider.model} · ${provider.baseUrl} · ${provider.hasKey?'已提供密钥':'未提供密钥'}`));const actions=el('div','provider-actions');const test=button('测试连接','test-provider','button secondary',{id:provider.id});test.disabled=provider.enabled===false;if(test.disabled)test.title='先编辑并启用此连接';actions.append(test);
    if(provider.type!=='demo'&&providerDiagnosticsSupported)test.textContent='兼容性诊断';
    if(provider.type!=='demo'){const edit=button('','edit-provider','icon-button',{id:provider.id});edit.setAttribute('aria-label',`编辑模型 ${provider.name}`);edit.title='编辑模型连接';edit.append(icon('sliders'));const remove=button('','delete-provider','icon-button danger-hover',{id:provider.id});remove.setAttribute('aria-label',`删除模型 ${provider.name}`);remove.title='删除模型连接';remove.append(icon('trash'));actions.append(edit,remove);}row.append(icon('sparkles','provider-icon'),copy,actions);container.append(row);
  }if(!state.providers.length)container.append(empty('接入你的第一个模型','添加兼容服务，或连接正在运行的工作台。','link'));
  syncProviderDiagnostics();
}
function scanIncomplete(scan,truncated){return Boolean(truncated||(scan?.excludedDirectories||0)>0||(scan?.skippedEntries||0)>0||scan?.ignore?.scopeIgnored||(scan?.ignore?.ignoredFiles||0)>0||(scan?.ignore?.ignoredDirectories||0)>0);}
function cancelBrowseRequest(){const wasLoading=state.browseLoading;state.browseController?.abort();state.browseController=null;legacyBrowseFlight=null;++state.browseRequest;state.browseLoading=false;$('file-list').setAttribute('aria-busy','false');if(wasLoading&&state.view==='workspace')renderFileList();}
function syncWorkspaceDiscovery(data){
  const supported=data.capabilities?.workspaceIgnore===1,directory=data.capabilities?.workspaceDirectory===1,project=typeof data.workspace?.projectMode==='boolean'?data.workspace.projectMode:null;
  if(supported===state.workspaceIgnoreSupported&&directory===state.workspaceDirectorySupported&&project===state.workspaceProjectMode)return false;
  cancelFilesRequest();cancelAuditRequest();cancelBrowseRequest();state.workspaceDirectorySupported=directory;state.workspaceIgnoreSupported=supported;state.workspaceProjectMode=project;++state.discoveryRevision;++state.filesRequest;
  state.files=[];state.filesLoaded=false;state.filesError='';state.filesScan=null;state.filesTruncated=false;
  state.browseFiles=[];state.browseScan=null;state.browseTruncated=false;state.browseIncludeGenerated=false;state.browseLoaded=false;state.browseLoading=false;state.browseError='';
  cancelWorkspaceSearch({clear:true,notice:'扫描规则已更改，请重新搜索。'});return true;
}
function workspaceListPath(scope,includeGenerated,supported,directory=false){
  const query=new URLSearchParams();if(scope)query.set('path',scope);
  if(supported){query.set('includeGenerated',String(includeGenerated));query.set('includeIgnored',String(includeGenerated));}else if(includeGenerated)query.set('includeGenerated','true');
  return (directory?'/api/workspace/directory':'/api/workspace')+(query.size?'?'+query:'');
}
function validateDirectoryListing(data,{scope,includeGenerated}){
  const fail=()=>{throw new Error('当前目录返回格式或范围无效，请更新工作台后重试。');};
  if(data?.version!==1||data.listing!=='children'||data.scope!==scope||typeof data.name!=='string'||typeof data.truncated!=='boolean'||!Array.isArray(data.files)||data.files.length>1000||typeof data.scan?.projectMode!=='boolean'||data.scan.includeGenerated!==includeGenerated||(state.workspaceProjectMode!==null&&data.scan.projectMode!==state.workspaceProjectMode)||!['excludedDirectories','skippedEntries','visitedEntries'].every(key=>Number.isSafeInteger(data.scan[key])&&data.scan[key]>=0)||!Array.isArray(data.scan.limits)||data.scan.limits.some(limit=>!['entries','directory-entries','depth'].includes(limit))||new Set(data.scan.limits).size!==data.scan.limits.length||data.truncated!==(data.scan.limits.length>0))fail();
  const prefix=scope?scope+'/':'',seen=new Set(),reserved=/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
  for(const file of data.files){
    const value=file?.path;
    if(typeof value!=='string'||!value||value.length>512||!value.isWellFormed()||/[\\\x00-\x1f\x7f<>:"|?*%]/u.test(value)||!value.startsWith(prefix)||seen.has(value)||!['file','directory'].includes(file.type)||!Number.isSafeInteger(file.size)||file.size<0||(file.type==='directory'&&file.size!==0))fail();
    const leaf=value.slice(prefix.length),parts=value.split('/');
    if(!leaf||leaf.includes('/')||parts.length>16||parts.some(part=>!part||part==='.'||part==='..'||part.length>128||/[. ]$/u.test(part)||reserved.test(part)||part.toLowerCase().startsWith('.openaster-')))fail();
    seen.add(value);
  }
}
function validateIgnoreScan(data,{supported,includeGenerated,project}){
  if(!supported)return;
  const scan=data.scan,ignore=scan?.ignore;
  if(typeof scan?.projectMode!=='boolean'||scan.includeGenerated!==includeGenerated||(project!==null&&scan.projectMode!==project)||!ignore||typeof ignore.enabled!=='boolean'||ignore.includeIgnored!==includeGenerated||ignore.caseSensitive!==true||typeof ignore.scopeIgnored!=='boolean'||ignore.enabled!==(scan.projectMode&&!includeGenerated)||!['files','rules','bytes','ignoredFiles','ignoredDirectories'].every(key=>Number.isSafeInteger(ignore[key])&&ignore[key]>=0))throw new Error('扫描规则返回不完整，请更新工作台后重试。');
}
function ignoredScanNotes(scan){
  const ignore=scan?.ignore,notes=[];
  if(ignore?.scopeIgnored)notes.push('当前范围被 .gitignore 忽略');
  if(ignore?.ignoredFiles>0||ignore?.ignoredDirectories>0)notes.push(`按 .gitignore 忽略 ${ignore.ignoredFiles} 个文件、${ignore.ignoredDirectories} 个目录入口（不计后代）`);
  return notes;
}
function workspaceScanError(error){return /^GITIGNORE_(?:LIMIT|INVALID|CHANGED|UNAVAILABLE)$/.test(error.code||'')?error.message+' 可包含被忽略的文件后重试，或检查工作区内的 .gitignore。':error.message;}
function adoptRootFiles(data){
  state.files=data.files||[];state.filesScan=data.scan||null;state.filesTruncated=Boolean(data.truncated);if(!state.workspaceNamed)state.workspaceName=data.name||'工作文件';state.filesLoaded=true;state.filesStale=false;state.filesError='';
}
function adoptBrowseFiles(data){
  state.browseFiles=data.files||[];state.browseScope=typeof data.scope==='string'?data.scope:state.browseScope;state.browseScan=data.scan||null;state.browseTruncated=Boolean(data.truncated);state.browseLoaded=true;state.browseLoading=false;state.browseError='';
  if(typeof data.scan?.includeGenerated==='boolean')state.browseIncludeGenerated=data.scan.includeGenerated;
}
function loadFiles({invalidate=false}={}) {
  if(invalidate)invalidateFiles();
  if(filesFlight)return filesFlight.promise;
  const flight={generation:state.generation,discovery:state.discoveryRevision,controller:new AbortController(),dirty:false,promise:null};
  filesFlight=flight;state.filesError='';state.filesStale=true;
  const current=()=>filesFlight===flight&&flight.generation===state.generation&&flight.discovery===state.discoveryRevision&&!flight.controller.signal.aborted;
  flight.promise=(async()=>{
    try{
      while(current()){
        flight.dirty=false;
        const request=++state.filesRequest,browseRequest=state.browseRequest,supported=state.workspaceIgnoreSupported,directory=state.workspaceDirectorySupported,project=state.workspaceProjectMode;
        try{
          const data=await api(workspaceListPath('',false,supported),{signal:flight.controller.signal,timeout:35000});
          if(!current()||request!==state.filesRequest)return;
          // An event received during this scan makes its snapshot obsolete.
          // Drain it before one follow-up scan; never publish the known-old view.
          if(flight.dirty){if(wantsRootFiles())continue;return;}
          validateIgnoreScan(data,{supported,includeGenerated:false,project});adoptRootFiles(data);
          if(!directory&&!state.browseScope&&!state.browseIncludeGenerated&&browseRequest===state.browseRequest)adoptBrowseFiles(data);
          if(directory)renderWorkspaceFileCount();else renderFileList();updateOverview();renderContext();commandPalette.refresh();return data;
        }catch(error){
          if(!current()||request!==state.filesRequest||error.staleContext||error.cancelled)return;
          if(flight.dirty){if(wantsRootFiles())continue;return;}
          state.filesError=workspaceScanError(error);
          if(!directory&&!state.browseScope&&!state.browseIncludeGenerated&&browseRequest===state.browseRequest){state.browseError=state.filesError;state.browseLoaded=false;state.browseLoading=false;state.browseFiles=[];renderFileList();}
          renderContext();throw error;
        }
      }
    }finally{if(filesFlight===flight){filesFlight=null;renderContext();renderWorkspaceFileCount();commandPalette.refresh();}}
  })();
  renderContext();renderWorkspaceFileCount();commandPalette.refresh();return flight.promise;
}
function loadBrowseFiles({scope=state.browseScope,includeGenerated=state.browseIncludeGenerated,invalidateIndex=false}={}){
  const shared=legacyBrowseFlight;
  if(!state.workspaceDirectorySupported&&shared&&shared.scope===scope&&shared.includeGenerated===includeGenerated&&shared.generation===state.generation&&shared.discovery===state.discoveryRevision&&state.browseController===shared.controller&&!shared.controller.signal.aborted){if(invalidateIndex)shared.dirty=true;return shared.promise;}
  state.browseController?.abort();
  const directory=state.workspaceDirectorySupported,controller=new AbortController();
  state.browseController=controller;
  const generation=state.generation,request=++state.browseRequest,rootIndex=!directory&&!scope&&!includeGenerated,discovery=state.discoveryRevision,supported=state.workspaceIgnoreSupported,project=state.workspaceProjectMode;
  const flight=!directory&&!rootIndex?{scope,includeGenerated,generation,discovery,controller,dirty:false,promise:null}:null;legacyBrowseFlight=flight;
  const changed=scope!==state.browseScope||includeGenerated!==state.browseIncludeGenerated;
  if(changed)cancelWorkspaceSearch({clear:true,notice:'范围已更改，点击搜索以读取这个范围。'});
  state.browseScope=scope;state.browseIncludeGenerated=includeGenerated;state.browseLoading=true;state.browseError='';
  if(changed){state.browseFiles=[];state.browseScan=null;state.browseTruncated=false;state.browseLoaded=false;$('file-search').value='';}
  renderFileList();
  const current=()=>generation===state.generation&&request===state.browseRequest&&discovery===state.discoveryRevision&&!controller.signal.aborted;
  const promise=(async()=>{try{let data;
    do{
      if(flight)flight.dirty=false;
      try{data=rootIndex?await loadFiles({invalidate:invalidateIndex}):await api(workspaceListPath(scope,includeGenerated,supported,directory),{signal:controller.signal,timeout:35000});}
      catch(error){if(current()&&flight?.dirty)continue;throw error;}
      if(!data||!current())return;
    }while(flight?.dirty);
    if(directory)validateDirectoryListing(data,{scope,includeGenerated});
    validateIgnoreScan(data,{supported,includeGenerated,project});if(supported&&data.scope!==scope)throw new Error('目录范围返回不一致，请重新读取。');
    adoptBrowseFiles(data);renderFileList();updateOverview();renderContext();commandPalette.refresh();
  }catch(error){if(generation!==state.generation||request!==state.browseRequest||discovery!==state.discoveryRevision||controller.signal.aborted||error.staleContext)return;state.browseError=workspaceScanError(error);state.browseFiles=[];state.browseScan=null;state.browseLoaded=false;throw error;}
  finally{if(legacyBrowseFlight===flight)legacyBrowseFlight=null;if(generation===state.generation&&request===state.browseRequest){state.browseController=null;state.browseLoading=false;renderFileList();}}})();
  if(flight)flight.promise=promise;return promise;
}
async function refreshWorkspaceFiles({refreshIndex=true,invalidateIndex=true}={}){
  if(refreshIndex&&invalidateIndex)invalidateFiles();
  const tasks=[];
  if(state.view==='workspace')tasks.push(loadBrowseFiles({invalidateIndex:refreshIndex&&invalidateIndex}));
  if(wantsRootFiles()&&(state.filesStale||!state.filesLoaded)&&!(state.view==='workspace'&&!state.workspaceDirectorySupported&&!state.browseScope&&!state.browseIncludeGenerated))tasks.push(loadFiles());
  await Promise.all(tasks);
}
function renderWorkspaceFileCount(){const count=state.files.filter(item=>item.type==='file').length;$('file-count').textContent=state.filesLoaded?String(count):'—';$('file-count').title=state.filesLoaded?`上次根目录扫描列出 ${count} 个文件${filesFlight?' · 正在更新':state.filesStale?' · 待更新':''}`:filesFlight?'正在扫描工作空间':'尚未扫描工作空间；打开任务详情或命令面板时读取';}
function renderFileList(){
  renderWorkspaceIdentity();renderWorkspaceFileCount();
  const items=state.browseFiles,files=items.filter(item=>item.type==='file'),directories=items.filter(item=>item.type==='directory');
  $('workspace-file-total').textContent=state.browseLoading?'正在读取…':state.browseLoaded?`已列出 ${files.length} 个文件 · ${directories.length} 个目录`:'尚未读取';
  const scope=state.browseScope?'/'+state.browseScope:'/';$('workspace-scope').textContent='当前范围：'+scope;$('workspace-scope').title=scope;$('browse-root').disabled=!state.browseScope;$('browse-up').disabled=!state.browseScope;
  $('workspace-listing-note').textContent=state.workspaceDirectorySupported?'仅显示当前目录，进入文件夹逐层浏览。':'当前范围内递归浏览（兼容模式）。';
  const scan=state.browseScan;const project=Boolean(state.workspaceProjectMode??scan?.projectMode??state.filesScan?.projectMode);$('workspace-generated-option').classList.toggle('hidden',!project);$('workspace-include-generated').checked=state.browseIncludeGenerated;
  $('workspace-discovery-label').textContent=state.workspaceIgnoreSupported?'包含被忽略的文件':'包含依赖与构建目录';
  $('workspace-discovery-note').textContent=state.workspaceIgnoreSupported?'包含 .gitignore 与依赖、构建目录中的忽略项；不改变文件访问权限。':'仅调整列表范围，不改变文件访问权限。';
  $('workspace-discovery-note').classList.toggle('hidden',!project);$('workspace-ignore-details').classList.toggle('hidden',!project||!state.workspaceIgnoreSupported);
  const notice=[];if(state.browseTruncated)notice.push('部分列表');
  notice.push(...ignoredScanNotes(scan));
  if(scan?.excludedDirectories>0)notice.push(`已排除 ${scan.excludedDirectories} 个依赖或构建目录入口（不计后代）`);
  if(scan?.skippedEntries>0)notice.push(`跳过 ${scan.skippedEntries} 个受限或不支持的条目`);
  const limits={entries:'返回项数上限','directory-entries':'扫描项数上限',depth:'目录深度上限','search-files':'搜索文件上限','search-matches':'搜索匹配上限'};
  const reached=[...new Set(scan?.limits||[])].map(value=>limits[value]).filter(Boolean);if(reached.length)notice.push('达到'+reached.join('、'));
  if((state.browseTruncated||reached.length)&&Number.isSafeInteger(scan?.visitedEntries))notice.push(`已读取 ${scan.visitedEntries} 个目录项`);
  $('workspace-scan-summary').textContent=notice.join('；');$('workspace-scan-summary').classList.toggle('hidden',!notice.length);$('workspace-scan-notice').classList.toggle('hidden',!notice.length);
  const query=$('file-search').value.trim().toLowerCase();const list=$('file-list');list.replaceChildren();list.setAttribute('aria-busy',String(state.browseLoading));
  for(const file of items.filter(item=>item.path.toLowerCase().includes(query))){const directory=file.type==='directory';const row=button('',directory?'open-directory':'open-file',`file-row${state.currentFile===file.path?' selected':''}`,{path:file.path});row.title=directory?'进入目录：'+file.path:file.path;row.append(icon(directory?'folder':'file'),el('span','',state.workspaceDirectorySupported?file.path.split('/').at(-1):file.path),el('small','',directory?'进入':formatBytes(file.size)));list.append(row);}
  if(!list.children.length){
    if(state.browseLoading)list.append(empty('正在读取目录','请稍候。','folder'));
    else if(state.browseError)list.append(empty('目录暂不可用',state.browseError,'folder'));
    else if(query)list.append(empty('当前列表没有匹配的文件','这里只筛选已列出的内容；可返回根目录或切换浏览范围。','search'));
    else if(scan?.ignore?.scopeIgnored)list.append(empty('当前目录已被忽略','可开启“包含被忽略的文件”，或返回上一级。','folder'));
    else if(scanIncomplete(scan,state.browseTruncated))list.append(empty('当前范围未列出文件','部分目录或条目未包含在这次列表中，请查看下方扫描说明。','folder'));
    else if(state.browseLoaded)list.append(empty(state.browseScope?'这个目录还是空的':'工作空间还是空的','导入文本，或让智能体创建第一个文件。','folder'));
    else list.append(empty('等待目录加载','连接工作台后可浏览文件。','folder'));
  }
  renderWorkspaceSearch();
}
const workspaceSearchUnsupported='当前工作台版本不支持内容搜索，请更新后重连。';
function workspaceQueryError(query){return !query?'请输入要搜索的原文。':query.length>256||!query.isWellFormed()||/[\0\r\n\u2028\u2029]/u.test(query)?'搜索文字须为 1–256 个字符，不能包含换行或无效字符。':'';}
function clearSearchPreview(){
  if(!state.searchPreview)return;state.searchPreview=null;++state.fileRequest;state.currentFile='';
  $('file-preview').replaceChildren(empty('选择文件','选择搜索结果或文件以查看内容。','file'));
}
function cancelWorkspaceSearch({clear=false,notice=''}={}){
  const search=state.workspaceSearch;search.controller?.abort();search.controller=null;++search.request;search.loading=false;search.error='';search.notice=notice;
  if(clear){search.result=null;++search.revision;$('workspace-search-results').replaceChildren();clearSearchPreview();}
  renderWorkspaceSearch();
}
function syncWorkspaceSearchCapability(supported){
  if(state.workspaceSearchSupported&&!supported)cancelWorkspaceSearch({clear:true});state.workspaceSearchSupported=supported;renderWorkspaceSearch();
}
function setWorkspaceMode(mode){
  if(!['files','content'].includes(mode))return;
  if(mode==='content'&&!state.workspaceSearchSupported)throw new Error(workspaceSearchUnsupported);
  if(state.workspaceMode!==mode)cancelWorkspaceSearch({clear:true});state.workspaceMode=mode;renderFileList();
  $(mode==='content'?'workspace-search-query':'file-search').focus({preventScroll:true});
}
function renderWorkspaceSearch(){
  const content=state.workspaceMode==='content',search=state.workspaceSearch,supported=state.workspaceSearchSupported;
  for(const node of document.querySelectorAll('[data-action=workspace-mode]'))node.setAttribute('aria-pressed',String(node.dataset.mode===state.workspaceMode));
  $('workspace-content-mode').disabled=!supported;$('workspace-content-mode').title=supported?'按原文搜索文件内容':workspaceSearchUnsupported;
  for(const id of ['workspace-search-form','workspace-search-status','workspace-search-results'])$(id).classList.toggle('hidden',!content);
  $('workspace-file-filter').classList.toggle('hidden',content);$('file-list').classList.toggle('hidden',content);$('workspace-listing-note').classList.toggle('hidden',content);
  if(content)$('workspace-scan-notice').classList.add('hidden');
  $('workspace-search-query').disabled=!supported;$('workspace-search-case').disabled=!supported;
  $('workspace-search-submit').disabled=!supported||!state.connected||state.switching||search.loading||Boolean(workspaceQueryError($('workspace-search-query').value));
  $('workspace-search-cancel').classList.toggle('hidden',!search.loading);$('workspace-search-results').setAttribute('aria-busy',String(search.loading));
  const result=search.result;let status=!supported?workspaceSearchUnsupported:search.loading?'正在搜索当前范围…':search.error||($('workspace-search-query').value&&workspaceQueryError($('workspace-search-query').value))||search.notice;
  if(!status&&result){const scan=result.scan||{},notes=[];notes.push(`${result.matches.length} 个命中行 · 尝试读取 ${result.searchedFiles} 个文件`);
    if(result.truncated)notes.push('部分搜索结果');
    notes.push(...ignoredScanNotes(scan));
    if(scan.excludedDirectories>0)notes.push(`排除 ${scan.excludedDirectories} 个依赖或构建目录入口（不计后代）`);
    if(scan.skippedEntries>0)notes.push(`跳过 ${scan.skippedEntries} 个受限或不支持的条目`);
    const names={entries:'返回项数上限','directory-entries':'扫描项数上限',depth:'目录深度上限','search-files':'搜索文件上限','search-matches':'命中行数上限'};const limits=[...new Set(scan.limits||[])].map(key=>names[key]).filter(Boolean);if(limits.length)notes.push('达到'+limits.join('、'));
    if(!result.matches.length)notes.push(scanIncomplete(scan,result.truncated)?'本次已搜索部分没有匹配行，未覆盖全部文件。':'本次扫描范围内没有匹配行。');
    notes.push('结果不会自动刷新；打开时会重新核对文件版本。');status=notes.join('；');
  }
  $('workspace-search-status').textContent=status||'输入查询后点击搜索；不会逐字读取文件。';
  if(content)$('workspace-file-total').textContent=search.loading?'正在搜索…':result?`${result.matches.length} 个命中行`:'内容搜索';
}
function validateWorkspaceSearch(data,request){
  validateIgnoreScan(data,{supported:Object.hasOwn(request,'includeIgnored'),includeGenerated:request.includeGenerated,project:state.workspaceProjectMode});
  if(data?.version!==1||data.query!==request.query||data.scope!==request.path||data.caseSensitive!==request.caseSensitive||data.scan?.includeGenerated!==request.includeGenerated||!Number.isSafeInteger(data.searchedFiles)||data.searchedFiles<0||!Array.isArray(data.matches)||data.matches.length>100)throw new Error('搜索结果格式不完整，请更新工作台后重试。');
  for(const match of data.matches){if(typeof match?.path!=='string'||!Number.isSafeInteger(match.line)||match.line<1||typeof match.text!=='string'||match.text.length>600||!match.text.isWellFormed()||typeof match.sha256!=='string'||!/^[a-f0-9]{64}$/.test(match.sha256)||!['matchStart','matchEnd','excerptStart','excerptEnd','lineLength'].every(key=>Number.isSafeInteger(match[key])&&match[key]>=0)||match.matchStart>=match.matchEnd||match.matchEnd>match.text.length||match.excerptStart>match.excerptEnd||match.excerptEnd>match.lineLength||match.excerptEnd-match.excerptStart!==match.text.length)throw new Error('搜索命中位置无效，请重新搜索。');}
  return data;
}
async function searchWorkspace(event){
  event?.preventDefault();if(state.view!=='workspace'||state.workspaceMode!=='content')return;
  if(!state.workspaceSearchSupported){state.workspaceSearch.error=workspaceSearchUnsupported;renderWorkspaceSearch();return;}
  const query=$('workspace-search-query').value,error=workspaceQueryError(query);if(error){state.workspaceSearch.error=error;renderWorkspaceSearch();return;}
  if(state.workspaceSearch.loading||!state.connected||state.switching)return;
  const form=$('workspace-search-form'),revealResult=form.contains(document.activeElement);
  cancelWorkspaceSearch({clear:true});const search=state.workspaceSearch,request=++search.request,generation=state.generation,navigation=state.navigation,controller=new AbortController();
  const discovery=state.discoveryRevision,body={query,path:state.browseScope,includeGenerated:state.browseIncludeGenerated,caseSensitive:$('workspace-search-case').checked,...(state.workspaceIgnoreSupported?{includeIgnored:state.browseIncludeGenerated}:{})};search.controller=controller;search.loading=true;renderWorkspaceSearch();
  const current=()=>search.request===request&&generation===state.generation&&navigation===state.navigation&&discovery===state.discoveryRevision&&state.view==='workspace'&&state.workspaceMode==='content'&&state.workspaceSearchSupported&&!controller.signal.aborted&&body.query===$('workspace-search-query').value&&body.caseSensitive===$('workspace-search-case').checked&&body.path===state.browseScope&&body.includeGenerated===state.browseIncludeGenerated;
  try{const data=await api('/api/workspace/search',{method:'POST',body,timeout:35000,signal:controller.signal});if(!current())return;search.result=validateWorkspaceSearch(data,body);search.notice='';renderSearchResults();}
  catch(error){if(!current()||error.staleContext||error.cancelled)return;search.result=null;search.error=error.code==='WORKSPACE_SEARCH_BUSY'?'另一项搜索仍在进行，请稍后点击搜索重试。':error.code==='WORKSPACE_SEARCH_TIMEOUT'?'搜索超过时限，请缩小目录范围后重试。':workspaceScanError(error);}
  finally{if(search.request===request){
    search.loading=false;search.controller=null;renderWorkspaceSearch();
    // Reveal only an explicit search that still owns the form; preserve keyboard focus.
    if(current()&&revealResult&&(form.contains(document.activeElement)||document.activeElement===document.body))$('workspace-search-results').querySelector('[data-action=search-result]')?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
  }}
}
function renderSearchResults(){
  const search=state.workspaceSearch,result=search.result,list=$('workspace-search-results');list.replaceChildren();if(!result)return;
  const groups=new Map();for(const[ index,match ]of result.matches.entries()){
    let group=groups.get(match.path);if(!group){const section=el('section','workspace-search-group'),heading=el('h2','',match.path);heading.id=`search-file-${search.revision}-${groups.size}`;section.append(heading);list.append(section);group={section,heading};groups.set(match.path,group);}
    const row=button('','search-result','workspace-search-result',{index:String(index),revision:String(search.revision)});row.title=`${match.path}：第 ${match.line} 行`;row.setAttribute('aria-describedby',group.heading.id);
    const before=match.text.slice(0,match.matchStart),after=match.text.slice(match.matchEnd),leading=Array.from(before).slice(-20).join(''),trailing=Array.from(after).slice(0,36).join('');
    const snippet=el('span','search-result-snippet');if(match.excerptStart>0||leading.length<before.length)snippet.append(document.createTextNode('…'));snippet.append(document.createTextNode(leading),el('mark','',match.text.slice(match.matchStart,match.matchEnd)),document.createTextNode(trailing));if(match.excerptEnd<match.lineLength||trailing.length<after.length)snippet.append(document.createTextNode('…'));
    row.append(el('span','search-result-line',`第 ${match.line} 行`),snippet);group.section.append(row);
  }
}
async function openSearchResult(node){
  const index=Number(node.dataset.index),revision=Number(node.dataset.revision),search=state.workspaceSearch;if(state.view!=='workspace'||state.workspaceMode!=='content'||revision!==search.revision||!Number.isSafeInteger(index))return;
  const match=search.result?.matches[index];if(!match)return;await openFile(match.path,{match,index,revision});
}
function returnToSearchResults(node){
  if(Number(node.dataset.revision)!==state.workspaceSearch.revision||state.workspaceMode!=='content')return;
  const result=$('workspace-search-results').querySelector(`[data-index="${Number(node.dataset.index)}"]`);if(!result)return;result.scrollIntoView({block:'center',behavior:'instant'});result.focus({preventScroll:true});
}
function highlightSearchLine(content,text,match){
  const endings=/\r\n|\r|\n/gu;let start=0;for(let line=1;line<match.line;line++){const newline=endings.exec(text);if(!newline)return null;start=newline.index+newline[0].length;}
  const newline=endings.exec(text),end=newline?newline.index:text.length;
  const line=text.slice(start,end),first=match.excerptStart+match.matchStart,last=match.excerptStart+match.matchEnd;
  if(line.length!==match.lineLength||line.slice(match.excerptStart,match.excerptEnd)!==match.text||first<0||last>line.length)return null;
  const highlighted=el('span','search-hit-line');highlighted.append(document.createTextNode(line.slice(0,first)),el('mark','',line.slice(first,last)),document.createTextNode(line.slice(last)));
  content.replaceChildren(document.createTextNode(text.slice(0,start)),highlighted,document.createTextNode(text.slice(end)));return highlighted;
}
function formatBytes(bytes) { const value=Number(bytes)||0; return value<1024?`${value} B`:`${(value/1024).toFixed(1)} KB`; }
function syncFileEditControls() {
  fileEditor?.syncContext();
  for (const node of document.querySelectorAll('#file-preview [data-action="edit-file"]')) {
    const record = fileEditReferences.get(node);
    node.disabled = Boolean(nativeLeaveLock) || !state.workspaceEditSupported || !state.connected || state.switching || pageSuspended || !record || record.generation !== state.generation || record.workspaceKey !== state.workspaceKey || record.request !== state.fileRequest;
    node.title = !state.workspaceEditSupported ? '当前工作台不支持手动编辑文件，请更新后重连。' : node.disabled ? '文件预览或连接已变化，请重新打开文件。' : '编辑后审阅修改，再明确确认写入文件。';
  }
}
function fileEditButton(data, request) {
  const node = button('编辑', 'edit-file', 'text-button');
  fileEditReferences.set(node, { data: { path: data.path, content: data.content, sha256: data.sha256 }, generation: state.generation, workspaceKey: state.workspaceKey, request });
  return node;
}
function editFile(node) {
  const record = fileEditReferences.get(node);
  if (!record || !node.isConnected || state.view !== 'workspace' || record.generation !== state.generation || record.workspaceKey !== state.workspaceKey || record.request !== state.fileRequest) throw new Error('文件预览已变化，请重新打开后编辑。');
  fileEditor.open(record.data, node);
}
async function openFile(path,searchResult=null){
  const request=++state.fileRequest;const generation=state.generation;const navigation=state.navigation;state.currentFile=path;state.searchPreview=searchResult;
  if(searchResult)$('file-preview').replaceChildren(empty('正在核对文件版本',path,'file'));
  let data;try{data=await api(`/api/workspace/file?path=${encodeURIComponent(path)}`);}catch(error){if(searchResult&&(request!==state.fileRequest||generation!==state.generation||navigation!==state.navigation))return;if(searchResult&&request===state.fileRequest&&generation===state.generation&&navigation===state.navigation){const back=button('返回搜索结果','return-search-results','text-button',{index:String(searchResult.index),revision:String(searchResult.revision)});$('file-preview').replaceChildren(empty('文件暂不可用',error.message,'file'),back);}throw error;}
  if(request!==state.fileRequest||generation!==state.generation||navigation!==state.navigation||state.view!=='workspace'||(searchResult&&(searchResult.revision!==state.workspaceSearch.revision||state.workspaceMode!=='content')))return;
  const title=el('div','panel-heading editor-tabbar');const tab=el('span','editor-tab');tab.append(icon('file'),el('strong','',data.path.split('/').pop()));const tools=el('div','file-preview-actions');tools.append(fileEditButton(data,request),attachmentButton(data,'file',request),button('复制内容','copy-file','text-button'));title.append(tab,tools);
  const content=scrollText(data.content,'file-content',`文件内容：${data.path}`);content.id='selected-file-content';const meta=el('div','editor-status');const file=state.browseFiles.find(item=>item.path===path)||state.files.find(item=>item.path===path);meta.append(el('span','',data.path),el('span','',`${data.content.split(/\r\n|\r|\n/u).length} 行 · ${formatBytes(file?.size ?? new TextEncoder().encode(data.content).length)} · UTF-8`));
  let location=null,hit=null;if(searchResult){const{match,index,revision}=searchResult;location=el('div','search-preview-location');const note=el('span');note.setAttribute('role','status');
    if(data.sha256!==match.sha256)note.textContent='文件自搜索后已更改。下面是当前内容，请重新搜索；未定位旧命中。';
    else if((hit=highlightSearchLine(content,data.content,match)))note.textContent=`搜索命中：第 ${match.line} 行 · 文件版本已核对`;
    else note.textContent='命中位置无法与当前文件对应，请重新搜索；未定位旧命中。';
    location.append(note,button('返回搜索结果','return-search-results','text-button',{index:String(index),revision:String(revision)}));
  }
  $('file-preview').replaceChildren(title,contextFileCompatibilityNote(),...(location?[location]:[]),content,meta);renderFileList();syncFileEditControls();
  if(searchResult){content.focus({preventScroll:true});if(hit)hit.querySelector('mark').scrollIntoView({block:'center',behavior:'instant'});else content.scrollIntoView({block:'center',behavior:'instant'});}
}
function loadAudit({restart=false}={}){
  if(restart)cancelAuditRequest();
  if(auditFlight)return auditFlight.promise;
  const flight={generation:state.generation,controller:new AbortController(),dirty:false,promise:null};
  auditFlight=flight;state.auditError='';state.auditStale=true;
  const current=()=>auditFlight===flight&&flight.generation===state.generation&&!flight.controller.signal.aborted;
  flight.promise=(async()=>{
    try{
      while(current()){
        flight.dirty=false;
        try{
          const {entries=[]}=await api('/api/audit',{signal:flight.controller.signal});
          if(!current())return;
          if(flight.dirty){if(wantsAudit())continue;return;}
          state.auditEntries=entries;state.auditLoaded=true;state.auditStale=false;state.auditError='';
          return;
        }catch(error){
          if(!current()||error.cancelled||error.staleContext)return;
          if(flight.dirty){if(wantsAudit())continue;return;}
          state.auditError=error.message;throw error;
        }
      }
    }finally{if(auditFlight===flight){auditFlight=null;renderAudit();renderContext();commandPalette.refresh();}}
  })();
  renderAudit();renderContext();commandPalette.refresh();return flight.promise;
}
function renderAudit(){
  const entries=state.auditEntries,list=$('audit-list');list.replaceChildren();list.setAttribute('aria-busy',String(Boolean(auditFlight)));
  $('audit-count').textContent=state.auditLoaded?`${entries.length} 条近期记录`:'尚未读取';
  if(state.auditError)list.append(el('p','context-empty','活动记录读取失败，请重试。'));
  else if(auditFlight)list.append(el('p','context-empty',state.auditLoaded?'正在更新近期活动…':'正在读取近期活动…'));
  for(const entry of [...entries].reverse()){const row=el('article','audit-row');const copy=el('div','audit-copy');copy.append(el('strong','',entry.action),el('p','',stringify(entry.detail)));row.append(icon('activity'),copy,el('time','',formatDate(entry.time,true)));list.append(row);}
  if(state.auditLoaded&&!entries.length&&!auditFlight&&!state.auditError)list.append(empty('暂无近期记录','这里显示最近的任务运行、文件写入和批准操作。','shield'));
}
function updateOverview(){
  renderWorkspaceFileCount();
  if($('overview-files'))$('overview-files').textContent=state.filesLoaded?String(state.files.filter(file=>file.type==='file').length):'—';if($('overview-models'))$('overview-models').textContent=String(state.providers.filter(item=>item.enabled!==false).length);
  const pending=state.sessions.filter(item=>item.run?.status==='awaiting_approval').length;if($('overview-pending')){$('overview-pending').textContent=String(pending);$('overview-pending').classList.toggle('needs-attention',pending>0);}
  const active=state.sessions.filter(item=>['running','awaiting_approval'].includes(item.run?.status)).length;$('statusbar-tasks').textContent=active?`${active} 个任务进行中`:`${state.sessions.length} 个任务 · 已同步`;
  $('statusbar-connection').textContent=state.connected?(state.gateway?'远程工作台':'本地工作台'):'服务未连接';
}
function syncContextPanel(){
  $('context-panel').classList.toggle('hidden',!state.contextOpen);$('chat-layout').classList.toggle('panel-collapsed',!state.contextOpen);$('context-toggle').setAttribute('aria-expanded',String(state.contextOpen));$('context-toggle').classList.toggle('selected',state.contextOpen);
  commandPolicyUI?.sync();
}
function renderContext(){
  const session=state.selected;if(!session)return;const provider=state.providers.find(item=>item.id===session.providerId);const meta=$('chat-meta');meta.replaceChildren();meta.append(el('span',`task-status-badge ${session.run?.status||'idle'}`,unavailableSessions.has(session)?'已删除':statusText[session.run?.status]||'准备开始'));
  const pin=$('pin-current');pin.classList.toggle('selected',pinnedIds.includes(session.id));pin.setAttribute('aria-label',pinnedIds.includes(session.id)?'取消置顶当前任务':'置顶当前任务');
  const details=$('context-details');details.replaceChildren();for(const[label,value]of [['工作空间',state.workspaceName],['当前模型',provider?.type==='demo'?'本地确定性演示':provider?.model||'尚未连接'],['访问方式',state.gateway?'你配置的网关':'本地工作台'],['创建时间',formatDate(session.createdAt,true)||'未记录']]){const row=el('div','context-data-row');row.append(el('span','',label),el('strong','',value));if(label==='工作空间')row.title=state.workspacePath;details.append(row);}
  const artifacts=$('artifact-list');artifacts.replaceChildren();artifacts.setAttribute('aria-busy',String(Boolean(auditFlight)));const writes=state.auditEntries.filter(item=>item.action==='workspace.written'&&item.sessionId===session.id);const paths=[...new Set(writes.map(item=>{try{return(typeof item.detail==='string'?JSON.parse(item.detail):item.detail)?.path;}catch{return undefined;}}).filter(path=>typeof path==='string'))];$('artifact-count').textContent=state.auditLoaded?String(paths.length):'—';
  if(state.auditError)artifacts.append(el('p','context-empty','文件活动暂不可用。'),button('重新读取文件活动','refresh-context-audit','context-import'));
  else if(auditFlight)artifacts.append(el('p','context-empty',state.auditLoaded?'正在更新文件活动…':'正在读取文件活动…'));
  else if(!state.auditLoaded)artifacts.append(el('p','context-empty','打开详情时读取近期文件活动。'));
  else if(state.auditStale)artifacts.append(el('p','context-footnote','上次读取的文件活动，待更新。'));
  if(state.auditLoaded&&!paths.length)artifacts.append(el('p','context-empty','近期记录中暂无此任务写入的文件。'));
  for(const path of paths){const row=button('','preview-context-file','context-file artifact-file',{path});row.append(icon('file'),el('span','',path),icon('arrow-up-right'));row.title='根据写入记录打开当前文件：'+path;artifacts.append(row);}
  if(paths.length)artifacts.append(el('p','context-footnote','来自最近 300 条活动中的写入记录；预览展示文件的当前内容。'));
  const files=$('context-files');files.replaceChildren();files.setAttribute('aria-busy',String(Boolean(filesFlight)));
  if(state.filesError)files.append(el('p','context-empty','文件列表暂不可用。'),button('重新读取文件列表','refresh-context-files','context-import'));
  else if(filesFlight)files.append(el('p','context-empty',state.filesLoaded?'正在更新文件列表…':'正在读取工作空间…'));
  else if(!state.filesLoaded)files.append(el('p','context-empty','打开详情时读取工作空间文件。'));
  if(state.filesLoaded){
    files.append(el('p','context-footnote',state.filesStale?'上次扫描的文件，待更新。':'上次扫描的文件；打开时读取当前内容。'));
    const items=state.files.filter(item=>item.type==='file');for(const file of items.slice(0,20)){const row=button('','preview-context-file','context-file',{path:file.path});row.title=file.path;row.append(icon('file'),el('span','',file.path),el('small','',formatBytes(file.size)));files.append(row);}if(scanIncomplete(state.filesScan,state.filesTruncated))files.append(el('p','context-footnote','当前根目录扫描未包含全部目录或条目；可在工作空间切换范围。'));else if(items.length>20)files.append(el('p','context-footnote','显示已扫描文件中的前 20 项。'));if(!items.length)files.append(button(scanIncomplete(state.filesScan,state.filesTruncated)?'导入参考文本':'导入第一份参考文本','import','context-import'));
  }
}
async function previewContextFile(path){
  const generation=state.generation,navigation=state.navigation,request=++state.contextFileRequest;const sessionId=state.selected?.id;const data=await api(`/api/workspace/file?path=${encodeURIComponent(path)}`);if(generation!==state.generation||navigation!==state.navigation||request!==state.contextFileRequest||sessionId!==state.selected?.id||state.view!=='chat')return;
  const target=$('context-preview');target.classList.remove('hidden');const heading=el('div','context-section-title');heading.append(el('h2','','快速预览'));const close=button('','close-context-preview','icon-button');close.setAttribute('aria-label','关闭文件快速预览');close.append(icon('x'));heading.append(close);target.replaceChildren(heading,el('code','context-preview-path',data.path),contextFileCompatibilityNote(),scrollText(data.content,'',`文件快速预览：${data.path}`),attachmentButton(data,'context',request),button('在工作空间中打开','workspace-file','button secondary',{path}));target.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function togglePin(id){if(!id)return;const index=pinnedIds.indexOf(id);if(index>=0)pinnedIds.splice(index,1);else pinnedIds.unshift(id);pinnedIds=pinnedIds.slice(0,100);saveStorage('openaster.pins',JSON.stringify(pinnedIds));renderSessions();renderContext();}
function commandEntries(){
  const entries=[['new','新建任务','开始新的任务','Ctrl K'],['home','返回新任务','继续编辑尚未发送的内容'],['workspace','打开工作空间','浏览和预览真实工作文件'],['workspace-search','搜索工作区文件内容','在当前目录及子目录中按原文搜索'],['skills','打开技能库','为下一次对话选择指令模板'],['settings','模型与连接设置','管理服务商、模型和网关'],['security','查看安全与活动','回顾审批与实际工具操作'],['import','导入文本','把本机文本带入独立工作空间'],['theme','切换明暗主题','切换工作台的外观']].map(([id,label,description,shortcut])=>({id:`action:${id}`,label,description,group:'快捷操作',shortcut}));
  for(const item of state.sessions)entries.push({id:`task:${item.id}`,label:item.title,description:statusText[item.run?.status]||'准备开始',group:'你的任务'});
  const indexed=new Map();for(const file of [...state.files,...state.browseFiles].filter(item=>item.type==='file'))indexed.set(file.path,{id:`file:${file.path}`,label:file.path,description:`上次扫描 · ${formatBytes(file.size)}`,group:'工作区文件'});
  for(const entry of state.auditEntries){if(entry.action!=='workspace.written')continue;try{const path=(typeof entry.detail==='string'?JSON.parse(entry.detail):entry.detail)?.path;if(typeof path==='string'&&!indexed.has(path))indexed.set(path,{id:`file:${path}`,label:path,description:'文件写入记录 · 打开当前文件',group:'工作区文件'});}catch{}}
  entries.push(...indexed.values());return entries;
}
function commandFileStatus(){
  const busy=Boolean(filesFlight||auditFlight),failed=Boolean(state.filesError||state.auditError);
  if(busy)return{busy,message:failed?'正在读取文件 · 部分来源暂不可用':'正在读取文件',emptyMessage:'文件仍在读取，可以继续输入…'};
  if(failed)return{busy:false,message:'部分文件来源读取失败',emptyMessage:'部分文件来源暂不可用，可在工作空间直接浏览文件。'};
  return{busy:false};
}
const commandPalette=createCommandPalette({getEntries:commandEntries,getStatus:commandFileStatus,onOpen:()=>{void refreshVisibleReads({fresh:true});},onSelect:entry=>{let task;const split=entry.id.indexOf(':');const type=entry.id.slice(0,split),value=entry.id.slice(split+1);if(type==='action')task=actions[value]?.();else if(type==='task')task=openSession(value);else if(type==='file')task=actions['workspace-file']({dataset:{path:value}});Promise.resolve(task).catch(error=>toast(error.message,true));}});
function field(label, name, {value='',type='text',placeholder='',hint='',required=false,options,maxLength,min,max}={}) { const wrap=el('label','form-field'); wrap.append(el('span','',label)); const input=el(options?'select':type==='textarea'?'textarea':'input'); input.name=name; input.id=`field-${name}`; if(options){for(const option of options){const item=el('option','',option.label);item.value=option.value;input.append(item);}}else if(type!=='textarea')input.type=type; input.value=value;input.placeholder=placeholder;input.required=required;if(maxLength)input.maxLength=maxLength;if(min!==undefined)input.min=String(min);if(max!==undefined)input.max=String(max);if(type==='password'){input.autocomplete='off';input.spellcheck=false;}wrap.append(input);if(hint)wrap.append(el('small','',hint));return wrap; }
let dialogRevealFrame=0;
function revealFocusedDialogField(){
  if(!$('app-dialog').open||dialogRevealFrame)return;
  dialogRevealFrame=requestAnimationFrame(()=>{
    dialogRevealFrame=0;
    const body=$('dialog-body'),field=document.activeElement;
    if(!$('app-dialog').open||!body.contains(field)||!field.matches('input:not([type="hidden"]),select,textarea')||field.disabled||!field.getClientRects().length||!body.clientHeight)return;
    const viewport=window.visualViewport,bounds=body.getBoundingClientRect(),rect=field.getBoundingClientRect();
    const top=Math.max(bounds.top+body.clientTop,viewport?.offsetTop??0);
    const bottom=Math.min(bounds.top+body.clientTop+body.clientHeight,(viewport?.offsetTop??0)+(viewport?.height??innerHeight));
    if(bottom<=top)return;
    // Only reveal clipped fields; never move focus, selection or the whole page.
    // An oversized textarea already intersecting the body stays put, avoiding
    // alternating edge alignment during a keyboard's series of resize events.
    if(rect.height>bottom-top){if(rect.bottom<=top||rect.top>=bottom)body.scrollTop+=rect.top-top;return;}
    if(rect.top<top)body.scrollTop+=rect.top-top;
    else if(rect.bottom>bottom)body.scrollTop+=rect.bottom-bottom;
  });
}
function openDialog(title, body, submit, handler, {stayOpen=false}={}) { discardProviderDiagnostics();discardHandoffEditor();state.dialogStayOpen=stayOpen;state.branchEditor=null;$('dialog-title').textContent=title;$('dialog-body').replaceChildren(...(Array.isArray(body)?body:[body]));$('dialog-submit').textContent=submit;$('dialog-submit').disabled=false;$('dialog-submit').className='button primary';$('dialog-error').classList.add('hidden');const cancel=$('app-dialog').querySelector('.dialog-actions [data-action="close-dialog"]');cancel.textContent='取消';cancel.classList.remove('hidden');state.dialogSubmit=handler;$('app-dialog').showModal(); $('dialog-body').querySelector('input:not([type="file"]):not([disabled]),select,textarea')?.focus({preventScroll:true});revealFocusedDialogField(); }
function diagnosticConnection(provider){return{id:provider.id,name:provider.name,type:provider.type,baseUrl:provider.baseUrl??'',model:provider.model??'',streaming:provider.streaming!==false,toolMode:provider.toolMode==='none'?'none':'workspace',tokenParameter:provider.tokenParameter??'max_completion_tokens',maxTokens:provider.maxTokens??4096,enabled:provider.enabled!==false};}
function diagnosticCurrent(editor){return providerDiagnostics===editor&&state.dialogSubmit===editor.submit&&$('app-dialog').open&&editor.generation===state.generation&&editor.navigation===state.navigation&&state.view==='settings';}
function discardProviderDiagnostics(){const editor=providerDiagnostics;if(editor){++editor.request;editor.controller?.abort();editor.controller=null;providerDiagnostics=null;}return editor;}
function invalidateProviderDiagnostics(editor,message){if(!diagnosticCurrent(editor)||editor.phase==='invalid')return;++editor.request;editor.controller?.abort();editor.controller=null;editor.phase='invalid';editor.results.replaceChildren();editor.results.setAttribute('aria-busy','false');editor.status.textContent=message+' 停止等待，已发请求仍可能计费。请关闭后重新打开检测。';}
function syncProviderDiagnostics(){
  const editor=providerDiagnostics;if(!editor||!diagnosticCurrent(editor))return;
  const provider=state.providers.find(item=>item.id===editor.id);
  if(!provider||JSON.stringify(diagnosticConnection(provider))!==editor.signature)invalidateProviderDiagnostics(editor,'连接配置已变化，原检测结果已失效。');
  else if(editor.mode!=='demo'&&(providerDiagnosticsSupported!==editor.supported))invalidateProviderDiagnostics(editor,'工作台诊断能力已变化，原检测已失效。');
  else if(!state.connected||state.switching)invalidateProviderDiagnostics(editor,'工作台连接未就绪。');
  $('dialog-submit').disabled=editor.phase==='running';$('dialog-submit').textContent=editor.phase==='ready'?editor.startLabel:editor.phase==='running'?'正在检测…':'关闭';
  const cancel=$('app-dialog').querySelector('.dialog-actions [data-action="close-dialog"]');cancel.textContent=editor.phase==='running'?'停止等待并关闭':'关闭';cancel.classList.toggle('hidden',!['ready','running'].includes(editor.phase));
}
function renderDiagnosticChecks(editor,checks){
  const labels={text:'完整文本',stream:'实际流式响应',tools:'合成工具往返'},statuses={passed:'通过',unverified:'未验证',failed:'失败',skipped:'已跳过'};
  editor.results.replaceChildren();
  for(const key of ['text','stream','tools']){const value=checks?.[key],row=el('section','diagnostic-check');row.dataset.check=key;row.dataset.status=value?.status||'pending';const heading=el('div','diagnostic-check-heading');heading.append(el('h3','',labels[key]),el('span',`diagnostic-outcome ${value?.status||'pending'}`,value?statuses[value.status]:'待检测'));row.append(heading,el('p','',value?.message||'点击开始后进行检测。'));
    if(value&&editor.mode==='diagnostics')row.append(el('small','',`${value.requestCount} 次请求 · ${Math.round(value.durationMs)} 毫秒`));editor.results.append(row);}
}
function validateDiagnosticResult(data,editor){
  if(data?.version!==1||!data.connection||JSON.stringify(diagnosticConnection(data.connection))!==editor.signature||!Number.isFinite(Date.parse(data.startedAt))||!Number.isFinite(Date.parse(data.finishedAt))||!Number.isSafeInteger(data.requestsStarted)||data.requestsStarted<0||data.requestsStarted>4)throw new Error('诊断返回的数据与所选连接不一致，请关闭后重试。');
  let total=0;for(const key of ['text','stream','tools']){const value=data.checks?.[key];if(!value||!['passed','unverified','failed','skipped'].includes(value.status)||typeof value.message!=='string'||value.message.length>4000||(value.code!==null&&typeof value.code!=='string')||(typeof value.code==='string'&&value.code.length>128)||!Number.isFinite(value.durationMs)||value.durationMs<0||!Number.isSafeInteger(value.requestCount)||value.requestCount<0||value.requestCount>(key==='tools'?2:1))throw new Error('诊断返回了无法识别的结果，请关闭后重试。');total+=value.requestCount;}if(total!==data.requestsStarted)throw new Error('诊断请求计数不一致，请关闭后重试。');return data;
}
async function runProviderDiagnostics(editor){
  if(!diagnosticCurrent(editor))return;syncProviderDiagnostics();if(editor.phase!=='ready'){if(editor.phase!=='running')closeDialog();return;}
  const request=++editor.request,controller=new AbortController();editor.controller=controller;editor.phase='running';editor.results.setAttribute('aria-busy','true');editor.status.textContent=editor.mode==='demo'?'正在检查本地演示状态…':'正在检测，请等待本次结果；不会自动重试。停止等待，已发请求仍可能计费。';syncProviderDiagnostics();
  try{
    const data=await api(`/api/providers/${encodeURIComponent(editor.id)}/${editor.mode==='diagnostics'?'diagnostics':'test'}`,{method:'POST',body:{},timeout:editor.mode==='diagnostics'?135000:65000,signal:controller.signal});
    if(!diagnosticCurrent(editor)||request!==editor.request)return;syncProviderDiagnostics();if(editor.phase!=='running')return;
    if(editor.mode==='diagnostics'){const result=validateDiagnosticResult(data,editor);renderDiagnosticChecks(editor,result.checks);editor.status.textContent=`检测时间：${formatDate(result.finishedAt,true)} · 发起 ${result.requestsStarted} 次模型请求。这是当时配置的一次结果，不代表持续兼容性或当前密钥状态。`;}
    else{const demo=editor.mode==='demo',ok=data?.ok===true,message=typeof data?.message==='string'?data.message.slice(0,4000):ok?'短文本连接测试通过。':'连接测试未通过。';renderDiagnosticChecks(editor,{text:{status:demo?'skipped':ok?'passed':'failed',message:demo?'本地演示没有调用模型，不验证真实模型文本能力。':message},stream:{status:'skipped',message:'本次未检测流式协议。'},tools:{status:'skipped',message:'本次未检测合成工具往返。'}});editor.status.textContent=`检测时间：${formatDate(new Date().toISOString(),true)} · ${demo?message:'旧版工作台仅完成短文本测试；这不代表流式或工具调用兼容。'}这是当时配置的一次结果。`;}
    editor.phase='complete';
  }catch(error){if(!diagnosticCurrent(editor)||request!==editor.request||error.staleContext||error.cancelled)return;editor.phase='error';editor.results.replaceChildren();editor.status.textContent=(error.message||'检测未完成。')+' 未获得可确认结果，不会自动重试；已发出的模型请求仍可能计费。';}
  finally{if(diagnosticCurrent(editor)&&request===editor.request){editor.controller=null;editor.results.setAttribute('aria-busy','false');syncProviderDiagnostics();}}
}
function showProviderDiagnostics(id){
  const provider=state.providers.find(item=>item.id===id);if(!provider||provider.enabled===false)throw new Error('请先启用仍然存在的模型连接。');
  const connection=diagnosticConnection(provider),mode=provider.type==='demo'?'demo':providerDiagnosticsSupported?'diagnostics':'legacy';
  const title=mode==='diagnostics'?'模型兼容性诊断':mode==='demo'?'本地演示检查':'短文本连接测试';
  const description=el('p','dialog-description',mode==='demo'?'本地演示不访问模型服务，也不发送网络模型请求。检查结果不能证明真实模型兼容性。':mode==='diagnostics'?'只发送内置测试内容，不读取工作区或历史对话。合成工具只验证协议往返，不进行文件操作。最多 4 次模型请求，可能计费；本次不会修改连接配置。':'当前工作台不支持完整诊断，只发送短文本测试，可能计费。不会读取工作区或历史对话，不能据此确认流式和工具调用兼容。');
  const identity=el('div','diagnostic-connection');identity.append(el('strong','',connection.name),el('span','',connection.type==='demo'?'本地确定性演示':`${connection.type} · ${connection.model}`));if(connection.baseUrl)identity.append(el('code','',connection.baseUrl));
  const scope=el('p','context-note',mode==='diagnostics'?`按保存的配置检测：${connection.streaming?'流式开启':'流式关闭，将跳过'}；${connection.toolMode==='workspace'?'工具开启':'仅对话，将跳过工具'}。每次模型请求限时 30 秒；整次诊断约 125 秒后取消。`:'仅检查当前选中的连接。');
  const status=el('p','diagnostic-status','尚未发送请求。');status.id='provider-diagnostic-status';status.setAttribute('role','status');
  const results=el('div','diagnostic-checks');results.id='provider-diagnostic-checks';results.setAttribute('aria-busy','false');
  const editor={id,mode,supported:providerDiagnosticsSupported,signature:JSON.stringify(connection),connection,generation:state.generation,navigation:state.navigation,phase:'ready',request:0,controller:null,status,results,startLabel:mode==='diagnostics'?'开始诊断':mode==='demo'?'检查本地演示':'发送短文本测试'};editor.submit=()=>runProviderDiagnostics(editor);
  openDialog(title,[description,identity,scope,results,status],editor.startLabel,editor.submit,{stayOpen:true});providerDiagnostics=editor;renderDiagnosticChecks(editor);syncProviderDiagnostics();$('dialog-submit').focus({preventScroll:true});
}
const branchUnsupported='当前工作台版本不支持编辑分支，请更新后重连。';
const handoffUnsupported='当前工作台版本不支持交接摘要，请更新后重连';
function handoffCurrent(editor){return handoffEditor===editor&&state.dialogSubmit===editor.submit&&$('app-dialog').open&&editor.generation===state.generation&&editor.navigation===state.navigation&&state.view==='chat'&&state.selected?.id===editor.sessionId;}
function discardHandoffEditor({cancelSummary=true}={}){const editor=handoffEditor;if(editor){discardSummaryDraft(editor,{cancel:cancelSummary});++editor.request;editor.controller?.abort();handoffEditor=null;}return editor;}
function handoffReason(editor){
  if(!handoffSupported)return handoffUnsupported;
  if(state.switching)return '连接未就绪，请重新连接工作台。';
  if(editor&&!handoffCurrent(editor))return '任务已切换，请重新打开整理后续接。';
  if(editor?.intent||(!editor&&handoffIntents.has(state.selected?.id)))return '';
  if(unavailableSessions.has(state.selected))return '任务已删除，不能继续整理。已编辑的文字仍保留。';
  if(!state.connected)return '连接未就绪，请重新连接工作台。';
  if(!currentHistoryReady())return '任务历史尚未加载完成，请稍候。';
  if(sourceBusy(editor?.sessionId||state.selected?.id))return '任务结束后可整理后续接。';
  if(editor&&!state.providers.some(item=>item.id===editor.provider.value&&item.enabled!==false))return '请选择仍然启用的模型连接。';
  if(editor?.skill.value&&!state.skills.some(item=>item.id===editor.skill.value))return '所选技能已不可用，请重新选择。';
  return '';
}
function syncHandoffControls(){
  const reason=handoffReason();const entry=$('handoff-button');if(entry){entry.disabled=Boolean(reason)||!state.selected;entry.title=reason||'审阅交接摘要，在新任务继续；原任务保留。';$('handoff-availability').textContent=!handoffSupported?reason:'';$('handoff-availability').classList.toggle('hidden',handoffSupported);}
  for(const button of $('messages').querySelectorAll('[data-handoff-source]')){const available=state.sessions.some(item=>item.id===button.dataset.id);button.disabled=!available;button.title=available?'打开来源任务':'来源任务已不可用；已保存的交接摘要仍可查看。';}
  const editor=handoffEditor;if(!editor||!handoffCurrent(editor))return;
  if(!handoffSupported&&editor.phase==='loading'){++editor.request;editor.controller?.abort();editor.controller=null;editor.phase='error';editor.status.textContent='当前连接不支持交接摘要，来源核对已停止。';}
  const error=handoffReason(editor),bytes=new TextEncoder().encode(editor.summary.value).length;
  editor.counter.textContent=`${editor.summary.value.length.toLocaleString('zh-CN')} / 24,000 字符 · ${bytes.toLocaleString('zh-CN')} / 65,536 字节（UTF-8）`;
  editor.availability.textContent=error;editor.availability.classList.toggle('hidden',!error);
  const frozen=editor.phase==='posting'||editor.phase==='uncertain';for(const control of [editor.summary,editor.content,editor.provider,editor.skill])control.disabled=frozen;
  const generating=summaryDraftBusy(editor),chatOnly=state.providers.find(item=>item.id===editor.provider.value)?.toolMode==='none';editor.provider.disabled=frozen||generating;editor.skill.disabled=frozen||chatOnly;editor.skill.title=chatOnly?'仅对话模式不加载技能':'';
  const valid=editor.summary.value.trim()&&editor.content.value.trim()&&editor.summary.value.length<=24000&&bytes<=65536&&editor.content.value.length<=16000;
  $('dialog-submit').disabled=Boolean(error)||generating||!((editor.phase==='ready'&&editor.preview&&valid)||(editor.phase==='uncertain'&&editor.intent));
  $('dialog-submit').textContent=editor.phase==='posting'?'正在创建…':editor.phase==='uncertain'?'重试同一次提交':'创建续接任务并运行';
  editor.reload.disabled=['loading','posting','uncertain'].includes(editor.phase)||generating||!handoffSupported;
  editor.inspect.classList.toggle('hidden',editor.phase!=='uncertain');
  syncSummaryDraft(editor);
}
function renderHandoffSnapshot(snapshot){
  const group=el('div','message-handoff');
  if(snapshot?.version!==1||typeof snapshot.summary!=='string'||typeof snapshot.sourceTitle!=='string'||typeof snapshot.sourceSessionId!=='string'){group.append(el('p','context-note','交接摘要格式无法识别，请更新工作台后查看。'));return group;}
  const source=button(snapshot.sourceTitle,'open-session','text-button',{id:snapshot.sourceSessionId});source.dataset.handoffSource='true';source.disabled=!state.sessions.some(item=>item.id===snapshot.sourceSessionId);
  const origin=el('p','handoff-origin');origin.append(el('span','','续接自'),source);const details=el('details','handoff-snapshot');details.append(el('summary','','查看交接摘要'));
  details.addEventListener('toggle',()=>{if(details.open&&!details.querySelector('pre'))details.append(el('p','context-note',`由用户整理的摘要，替代原任务 ${Number.isSafeInteger(snapshot.sourceMessageCount)?snapshot.sourceMessageCount:'未知'} 条消息及其中的资料快照；原历史和审批未复制。`),scrollText(snapshot.summary,'handoff-snapshot-content','随消息保存的交接摘要'));});
  group.append(origin,details);return group;
}
function showHandoffDialog(){
  const source=state.selected;if(state.view!=='chat'||!source)throw new Error('请先打开需要续接的任务。');
  const pending=handoffIntents.get(source.id),reason=handoffReason(pending?{intent:pending,sessionId:source.id}:undefined);if(reason&&!pending)throw new Error(reason);if(!handoffSupported)throw new Error(handoffUnsupported);
  const description=el('p','dialog-description','手写或审阅一份交接摘要，在新任务继续。原任务保留；已写文件不会撤回，后续写入仍需重新批准。');
  const scope=el('p','context-note handoff-scope','正在核对来源任务…');
  const summaryField=field('交接摘要','handoffSummary',{type:'textarea',value:pending?.body.summary||'',required:true,maxLength:24000});const summary=summaryField.querySelector('textarea');summary.rows=6;
  const counter=el('p','context-note handoff-counter');counter.id='handoff-counter';summary.setAttribute('aria-describedby',counter.id);summaryField.append(counter);
  const contentField=field('本次新请求','handoffContent',{type:'textarea',value:pending?.body.content??$('prompt-input').value,required:true,maxLength:16000});const content=contentField.querySelector('textarea');content.rows=3;
  const providers=state.providers.filter(item=>item.enabled!==false),selected=pending?.body.providerId||state.providerId;const options=[{value:'',label:'请选择模型连接'},...providers.map(item=>({value:item.id,label:`${item.name} · ${item.model||'本地演示'}${item.toolMode==='none'?' · 仅对话':''}`}))];if(pending&&!providers.some(item=>item.id===selected))options.push({value:selected,label:pending.providerLabel+'（原提交配置）'});
  const providerField=field('本次使用的模型','handoffProvider',{value:selected,required:true,options});const provider=providerField.querySelector('select');
  const skills=[{value:'',label:'不使用技能'},...state.skills.map(item=>({value:item.id,label:item.name}))],skillId=pending?.body.skillId??state.skillId;if(pending&&skillId&&!skills.some(item=>item.value===skillId))skills.push({value:skillId,label:'原提交的技能'});
  const skillField=field('本次使用的技能','handoffSkill',{value:skillId,options:skills,hint:'仅对话模式不加载技能。'});const skill=skillField.querySelector('select'),choices=el('div','branch-run-choices');choices.append(providerField,skillField);
  const policy=el('p','context-note','仅发送下方摘要和新请求，原历史、文件快照和工具结果不会自动复制。摘要可能遗漏细节，请核对目标、约束和未完成事项。真实模型运行可能计费。');
  const draft=el('p','context-note','输入框原草稿保持不变；此处使用其文字副本，未发送的文件引用不会自动带入。');
  const status=el('p','context-note handoff-status');status.setAttribute('role','status');const availability=el('p','dialog-error hidden');availability.setAttribute('role','status');
  const reload=button('重新核对来源','','text-button'),inspect=button('刷新任务列表','','text-button hidden'),tools=el('div','branch-preview-tools');tools.append(reload,inspect);
  const editor={sessionId:source.id,generation:state.generation,navigation:state.navigation,summary,content,provider,skill,counter,scope,status,availability,reload,inspect,preview:pending?.preview||null,intent:pending||null,phase:pending?'uncertain':'loading',request:0,controller:null};editor.submit=()=>submitHandoff(editor);
  const generator=createSummaryDraftPanel(editor);
  openDialog('整理后续接',[description,scope,policy,summaryField,generator,contentField,choices,draft,status,availability,tools],'创建续接任务并运行',editor.submit,{stayOpen:true});handoffEditor=editor;
  for(const node of [summary,content,provider,skill])node.addEventListener(node.tagName==='SELECT'?'change':'input',()=>syncHandoffControls());
  reload.addEventListener('click',()=>void loadHandoffPreview(editor));inspect.addEventListener('click',async()=>{inspect.disabled=true;try{await refreshState();if(handoffCurrent(editor))editor.status.textContent='任务列表已刷新。重试仍使用原提交标识与内容；已创建且仍保留的目标任务不会重复运行；若目标已删除，重试可能重新运行并计费。';}catch(error){if(handoffCurrent(editor))dialogError(error.message);}finally{if(handoffCurrent(editor))inspect.disabled=false;}});
  if(pending){renderHandoffPreview(editor);editor.status.textContent='上次提交结果尚未确认。重试使用同一标识和内容；若此前未创建或目标已删除，重试会创建并运行，可能计费。';syncHandoffControls();$('dialog-submit').focus({preventScroll:true});}else{syncHandoffControls();void loadHandoffPreview(editor);}
}
function renderHandoffPreview(editor){const preview=editor.preview;if(!preview)return;editor.scope.textContent=`来源：${preview.source.title} · ${preview.source.messageCount} 条消息 · ${preview.files.count} 份文件快照（${formatBytes(preview.files.bytes)}）。全部由你的摘要替代，不额外保留近期对话。`;}
async function loadHandoffPreview(editor){
  if(!handoffCurrent(editor)||['posting','uncertain'].includes(editor.phase))return;
  const request=++editor.request;editor.controller?.abort();const controller=new AbortController();editor.controller=controller;editor.preview=null;editor.phase='loading';editor.status.textContent='正在核对来源任务…';syncHandoffControls();
  try{const data=await api(`/api/sessions/${encodeURIComponent(editor.sessionId)}/handoff-preview`,{signal:controller.signal});if(!handoffCurrent(editor)||request!==editor.request||!handoffSupported)return;
    if(data?.version!==1||data.source?.sessionId!==editor.sessionId||typeof data.source.title!=='string'||typeof data.source.lastMessageId!=='string'||!/^[a-f0-9]{64}$/.test(data.source.hash)||!Number.isSafeInteger(data.source.messageCount)||data.source.messageCount<1||!Number.isSafeInteger(data.files?.count)||data.files.count<0||!Number.isSafeInteger(data.files?.bytes)||data.files.bytes<0)throw new Error('来源预览不完整，请更新工作台后重试。');
    editor.preview=data;editor.phase='ready';editor.status.textContent='来源已核对。提交前请审阅摘要与新请求。';renderHandoffPreview(editor);
  }catch(error){if(handoffCurrent(editor)&&request===editor.request&&!error.cancelled){editor.phase='error';editor.status.textContent='来源核对未完成，没有创建任务。';if(!error.staleContext)dialogError(error.message);}}
  finally{if(handoffCurrent(editor)&&request===editor.request){editor.controller=null;syncHandoffControls();}}
}
async function submitHandoff(editor){
  if(!handoffCurrent(editor)||!['ready','uncertain'].includes(editor.phase)||summaryDraftBusy(editor))return;
  const retrying=editor.phase==='uncertain';
  const reason=handoffReason(editor);if(reason)throw new Error(reason);
  if(!editor.intent){
    const summary=editor.summary.value,content=editor.content.value.trim();if(!editor.preview||!summary.trim()||!content||summary.length>24000||new TextEncoder().encode(summary).length>65536||content.length>16000)throw new Error('请检查摘要和新请求的内容及长度。');
    const body={requestId:crypto.randomUUID(),expectedSourceHash:editor.preview.source.hash,summary,content,providerId:editor.provider.value,...(editor.skill.value&&state.providers.find(item=>item.id===editor.provider.value)?.toolMode!=='none'?{skillId:editor.skill.value}:{})};
    editor.intent={body,preview:editor.preview,providerLabel:editor.provider.selectedOptions[0]?.textContent||'原模型连接'};handoffIntents.set(editor.sessionId,editor.intent);
  }
  const intent=editor.intent;editor.phase='posting';editor.status.textContent='正在创建续接任务。关闭弹窗只停止等待，不会撤回已发出的运行请求。';syncHandoffControls();
  try{const {session}=await api(`/api/sessions/${encodeURIComponent(editor.sessionId)}/continuations`,{method:'POST',body:intent.body});if(editor.generation!==state.generation)return;
    const complete=acceptCompleteSession(session);if(complete.id===editor.sessionId)throw new Error('服务未返回独立任务，请先核对任务列表。');if(handoffIntents.get(editor.sessionId)===intent)handoffIntents.delete(editor.sessionId);
    if(handoffCurrent(editor)&&handoffSupported){closeDialog({restoreFocus:false});++state.sessionRequest;++state.sessionRevision;state.fullSessionRequest=null;state.selected=complete;state.sessions=[complete,...state.sessions.filter(item=>item.id!==complete.id)];showView('chat',{focus:false});renderChat();renderSessions();renderModels();$('chat-title').tabIndex=-1;$('chat-title').focus({preventScroll:true});}
    else{if(handoffCurrent(editor))closeDialog({restoreFocus:false});toast('续接任务已创建，当前页面和输入框草稿保持不变。可从任务列表打开。');}
    void refreshState().catch(()=>{});
  }catch(error){if(editor.generation!==state.generation||error.staleContext)return;
    const uncertain=retrying||!error.status||error.status>=500||['HANDOFF_ID_CONFLICT','BRANCH_SOURCE_BUSY','RUN_ACTIVE'].includes(error.code);if(!uncertain&&handoffIntents.get(editor.sessionId)===intent)handoffIntents.delete(editor.sessionId);
    if(!handoffCurrent(editor))return;
    if(uncertain){editor.phase='uncertain';editor.status.textContent='无法确认创建结果。可先刷新任务列表，或显式重试同一次提交；已创建且仍保留的目标任务不会重复运行；若目标已删除，重试可能重新运行并计费。内容已锁定，避免重复创建。';}
    else{editor.intent=null;if(error.code==='HANDOFF_SOURCE_CHANGED'){editor.phase='changed';editor.preview=null;editor.status.textContent='原任务已变化，摘要和新请求仍保留。请重新核对来源后提交。';}else{editor.phase='ready';editor.status.textContent='此次请求未完成，请检查提示后再操作。';}}
    syncHandoffControls();throw error;
  }
}
function summaryDraftBusy(editor){return Boolean(editor?.generator&&(editor.generator.intent||['starting','unknown','running'].includes(editor.generator.phase)||editor.generator.job?.status==='running'));}
function summaryDraftCurrent(editor,request){return handoffCurrent(editor)&&summaryDraftSupported&&(request===undefined||editor.generator.request===request);}
function summaryDraftPath(editor,id=''){return `/api/sessions/${encodeURIComponent(editor.sessionId)}/summary-drafts${id?'/'+encodeURIComponent(id):''}`;}
function cancelSummaryBestEffort(editor,id){if(id&&editor.generation===state.generation&&!state.switching)void api(summaryDraftPath(editor,id)+'/cancel',{method:'POST',body:{},timeout:10000}).catch(()=>{});}
function discardSummaryDraft(editor,{cancel=true}={}){const g=editor.generator;if(!g)return;clearTimeout(g.timer);++g.request;g.controller?.abort();g.controller=null;if(cancel&&summaryDraftBusy(editor))cancelSummaryBestEffort(editor,g.intent?.body.requestId||g.job?.id);}
function createSummaryDraftPanel(editor){
  const panel=el('details','summary-draft-panel');panel.id='summary-draft-panel';panel.append(el('summary','','生成摘要草稿'));
  const policy=el('p','context-note','将完整历史及旧附件发给所选模型，生成后由你审阅采用。仅整理已保存对话，不读取当前文件或执行操作。');
  const availability=el('p','context-note');availability.id='summary-draft-availability';
  const plan=el('div','summary-draft-plan');plan.id='summary-draft-plan';
  const planButton=button('查看生成范围','','text-button');planButton.id='summary-plan-button';const start=button('开始生成草稿','','button secondary hidden');start.id='summary-start-button';
  const query=button('查询本次生成结果','','text-button hidden');query.id='summary-query-button';const cancel=button('停止生成','','text-button hidden');cancel.id='summary-cancel-button';
  const controls=el('div','summary-draft-actions');controls.append(planButton,start,query,cancel);
  const status=el('p','context-note');status.id='summary-job-status';status.setAttribute('role','status');status.textContent='尚未请求模型。先查看范围，再明确开始。';
  const result=el('div','summary-draft-result hidden');result.id='summary-draft-result';const resultLabel=el('p','context-note');const text=scrollText('','summary-draft-text','模型生成的完整摘要草稿，尚未使用');text.id='summary-result-text';
  const replaceLabel=el('label','summary-replace hidden'),replace=el('input');replace.type='checkbox';replace.id='summary-replace-confirm';replaceLabel.append(replace,el('span','','替换上方已编辑的摘要（新请求和原输入框草稿不变）'));
  const use=button('使用这份草稿','','button secondary');use.id='summary-use-button';result.append(resultLabel,text,replaceLabel,use);
  panel.append(policy,availability,plan,controls,status,result);
  const intent=summaryDraftIntents.get(editor.sessionId)||null;
  editor.generator={panel,availability,plan,planButton,start,query,cancel,status,result,resultLabel,text,replaceLabel,replace,use,phase:intent?'unknown':'idle',request:0,controller:null,timer:null,preview:null,job:null,intent,loaded:false,cancelRequested:false,signature:'',renderedSummary:null};
  panel.addEventListener('toggle',()=>{if(panel.open&&!editor.generator.loaded&&summaryDraftSupported){editor.generator.loaded=true;void readSummaryDraft(editor);}});
  planButton.addEventListener('click',()=>void loadSummaryPlan(editor));start.addEventListener('click',()=>void startSummaryDraft(editor));query.addEventListener('click',()=>void readSummaryDraft(editor));cancel.addEventListener('click',()=>void stopSummaryDraft(editor));replace.addEventListener('change',()=>syncSummaryDraft(editor));
  use.addEventListener('click',()=>void useSummaryDraft(editor));
  return panel;
}
function syncSummaryDraft(editor){
  const g=editor.generator;if(!g||!handoffCurrent(editor))return;
  if(!summaryDraftSupported){if(!g.invalidated){discardSummaryDraft(editor);g.invalidated=true;g.preview=null;g.plan.replaceChildren();g.result.classList.add('hidden');g.phase=g.intent?'unknown':'idle';}g.availability.textContent='当前工作台不支持生成摘要草稿，可继续手写摘要。';}
  else{g.invalidated=false;g.availability.textContent=g.intent?.persistent===false?'浏览器未能保存本次标识，仅在本页可恢复同一次生成；刷新前请先查询结果。':'';}g.availability.classList.toggle('hidden',!g.availability.textContent);
  const provider=state.providers.find(item=>item.id===editor.provider.value&&item.enabled!==false),signature=provider?JSON.stringify(diagnosticConnection(provider)):'';
  if(g.preview&&signature!==g.signature){g.preview=null;g.plan.replaceChildren();if(g.phase==='ready')g.phase='idle';}
  if(g.job?.status==='running'&&!g.cancelRequested&&(!provider||signature!==JSON.stringify(diagnosticConnection(g.job.preview.provider))))void stopSummaryDraft(editor,'模型配置已变化，已请求停止原生成。');
  const frozen=Boolean(editor.intent)||['posting','uncertain'].includes(editor.phase),busy=summaryDraftBusy(editor),loading=['loading','planning'].includes(g.phase),enabled=summaryDraftSupported&&state.connected&&!state.switching&&!frozen;
  g.planButton.disabled=!enabled||busy||loading||editor.phase!=='ready'||!editor.preview||!provider||provider.type==='demo';
  g.planButton.title=provider?.type==='demo'?'本地演示不生成模型摘要；可手写摘要或选择模型连接。':'';
  g.start.classList.toggle('hidden',!g.preview);g.start.disabled=!enabled||busy||loading||g.phase!=='ready'||!g.preview||g.preview.source.hash!==editor.preview?.source.hash;
  g.query.classList.toggle('hidden',!['unknown','error'].includes(g.phase)&&!g.job);g.query.disabled=!summaryDraftSupported||loading||g.phase==='starting'||g.cancelPending||frozen;
  g.cancel.classList.toggle('hidden',!busy);g.cancel.disabled=!summaryDraftSupported||g.cancelRequested;g.cancel.textContent=g.cancelRequested?'已请求停止':'停止生成';
  const completed=summaryDraftSupported&&g.job?.status==='completed';g.result.classList.toggle('hidden',!completed);
  if(completed){const same=editor.preview?.source.hash===g.job.preview.source.hash;g.resultLabel.textContent=`${g.job.preview.provider.name} · ${formatDate(g.job.finishedAt,true)}${same?'':' · 来源已变化，请重新核对并生成；不能直接使用此草稿。'}`;
    if(g.renderedSummary!==g.job.summary){g.text.textContent=g.job.summary;g.renderedSummary=g.job.summary;g.replace.checked=false;}g.replaceLabel.classList.toggle('hidden',!editor.summary.value);g.use.disabled=!same||busy||frozen||g.applying||Boolean(editor.summary.value&&!g.replace.checked);}
}
async function useSummaryDraft(editor){
  const g=editor.generator;if(!summaryDraftCurrent(editor)||g.job?.status!=='completed'||editor.preview?.source.hash!==g.job.preview.source.hash||editor.intent||summaryDraftBusy(editor)||g.applying||(editor.summary.value&&!g.replace.checked))return;
  const before=editor.summary.value,job=g.job,request=g.request;g.applying=true;syncSummaryDraft(editor);
  try{const preview=await api(`/api/sessions/${encodeURIComponent(editor.sessionId)}/handoff-preview`);if(!summaryDraftCurrent(editor,request)||g.job!==job)return;
    if(preview?.version!==1||preview.source?.sessionId!==editor.sessionId||preview.source.hash!==job.preview.source.hash){editor.preview=null;editor.phase='changed';g.status.textContent='原任务已变化，未使用旧草稿。请重新核对来源；你的编辑保持不变。';return;}
    if(editor.summary.value!==before){g.replace.checked=false;g.status.textContent='摘要在核对期间被编辑，未替换。请重新确认是否使用生成草稿。';return;}
    editor.summary.value=job.summary;g.replace.checked=false;g.status.textContent='草稿已放入上方摘要。请继续审阅和编辑，再确认是否创建续接任务。';editor.summary.focus();
  }catch(error){if(summaryDraftCurrent(editor,request))g.status.textContent=`使用前核对失败：${error.message} 未替换你的编辑。`;}
  finally{g.applying=false;if(summaryDraftCurrent(editor))syncHandoffControls();}
}
function validateSummaryPlan(data,editor){
  if(data?.version!==1||data.source?.sessionId!==editor.sessionId||!/^[a-f0-9]{64}$/.test(data.source?.hash)||!/^[a-f0-9]{64}$/.test(data.planHash)||!data.provider||typeof data.provider.name!=='string'||typeof data.provider.model!=='string'||!Number.isSafeInteger(data.source.messageCount)||data.source.messageCount<1||data.source.messageCount>201||!Number.isSafeInteger(data.sourceBytes)||data.sourceBytes<1||data.sourceBytes>8388608||!Number.isSafeInteger(data.partCount)||data.partCount<1||data.partCount>33||data.maxRequests!==(data.partCount===1?1:data.partCount+1)||!Number.isSafeInteger(data.maxOutputTokens)||data.maxOutputTokens<1||data.maxOutputTokens>100000||!Number.isSafeInteger(data.files?.count)||data.files.count<0||!Number.isSafeInteger(data.files?.bytes)||data.files.bytes<0)throw new Error('生成范围返回不完整，未发起模型请求。');return data;
}
function validateSummaryJob(data,editor,expectedId){
  if(data?.version!==1||data.sessionId!==editor.sessionId||typeof data.id!=='string'||(expectedId&&data.id!==expectedId)||!['running','completed','failed','cancelled'].includes(data.status)||!Array.isArray(data.steps)||data.steps.length>34)throw new Error('摘要记录与本次任务不一致。');validateSummaryPlan(data.preview,editor);
  if(data.status==='completed'&&(typeof data.summary!=='string'||!data.summary.trim()||data.summary.length>24000||new TextEncoder().encode(data.summary).length>65536||!/^[a-f0-9]{64}$/.test(data.summaryHash)))throw new Error('完整摘要草稿格式无效，未替换编辑内容。');return data;
}
function renderSummaryPlan(g,preview){
  if(g.plan.dataset.planHash===preview.planHash&&g.plan.childElementCount)return;g.plan.dataset.planHash=preview.planHash;
  const details=el('details','summary-request-details'),heading=el('summary','','请求详情');details.append(heading,el('p','context-note',`来源序列化文本 ${formatBytes(preview.sourceBytes)}，其中旧文件快照 ${formatBytes(preview.files.bytes)}。包括已有交接摘要，不含原工具返回正文。`),el('p','context-note',`请求的输出上限合计 ${preview.maxOutputTokens.toLocaleString('zh-CN')} token；这不是输入 token 计量、费用或实际用量。已知用量计入工作区运行用量。`),el('p','context-note','每次请求限时 60 秒；整次生成约 10 分钟后取消，不会自动重试。完整输入覆盖不保证摘要无遗漏，也不保证模型的 token 窗口能容纳请求。'));
  const expanded=g.plan.querySelector('.summary-request-details')?.open;details.open=Boolean(expanded);g.plan.replaceChildren(el('strong','',`${preview.provider.name} · ${preview.provider.model}`),el('p','context-note',`全部 ${preview.source.messageCount} 条消息 · ${preview.files.count} 份旧文件快照 · ${preview.partCount} 个分段`),el('p','context-note',`最多 ${preview.maxRequests} 次模型请求，可能计费。`),details);
}
async function loadSummaryPlan(editor){
  const g=editor.generator;if(!summaryDraftCurrent(editor)||summaryDraftBusy(editor)||editor.intent||editor.phase!=='ready'||!editor.preview)return;
  const provider=state.providers.find(item=>item.id===editor.provider.value&&item.enabled!==false);if(!provider||provider.type==='demo')return;
  const sourceHash=editor.preview.source.hash,signature=JSON.stringify(diagnosticConnection(provider)),request=++g.request;clearTimeout(g.timer);g.controller?.abort();g.controller=new AbortController();g.phase='planning';g.preview=null;g.plan.replaceChildren();g.status.textContent='正在核对生成范围，没有请求模型…';syncHandoffControls();
  try{const preview=validateSummaryPlan(await api(`/api/sessions/${encodeURIComponent(editor.sessionId)}/summary-preview`,{method:'POST',body:{providerId:provider.id,expectedSourceHash:sourceHash},signal:g.controller.signal}),editor);if(!summaryDraftCurrent(editor,request)||editor.preview?.source.hash!==sourceHash||JSON.stringify(diagnosticConnection(state.providers.find(item=>item.id===editor.provider.value)||{}))!==signature)return;
    if(preview.source.hash!==sourceHash||JSON.stringify(diagnosticConnection(preview.provider))!==signature)throw new Error('来源或模型配置已变化，请重新查看生成范围。');g.preview=preview;g.signature=signature;g.phase='ready';renderSummaryPlan(g,preview);g.status.textContent='范围已核对。只有点击“开始生成草稿”才会请求模型。';
  }catch(error){if(summaryDraftCurrent(editor,request)&&!error.cancelled){g.phase='error';g.status.textContent=error.message;if(error.code==='HANDOFF_SOURCE_CHANGED'){editor.phase='changed';editor.preview=null;editor.status.textContent='来源已变化，请重新核对；已编辑文字保持不变。';}}}
  finally{if(summaryDraftCurrent(editor,request)){g.controller=null;if(g.phase==='planning')g.phase='idle';syncHandoffControls();}}
}
function acceptSummaryJob(editor,job){
  const g=editor.generator;g.job=job;g.phase=job.status;g.intent=job.status==='running'?(g.intent||{body:{requestId:job.id}}):null;renderSummaryPlan(g,job.preview);
  if(job.status==='running'){keepSummaryIntent(editor,g.intent);const complete=job.steps.filter(step=>step.status==='completed').length;g.status.textContent=`正在生成：已完成 ${complete} / ${job.preview.maxRequests} 个模型步骤。${g.cancelRequested?'正在等待停止确认；':''}已发出的请求仍可能计费。`;}
  else{forgetSummaryIntent(editor);g.cancelRequested=false;g.status.textContent=job.status==='completed'?'草稿已生成，尚未采用。':`${job.status==='cancelled'?'生成已停止':'生成失败'}：${job.error?.message||'没有得到完整草稿。'} 已完成的中间片段不能作为完整摘要使用，已发请求仍可能计费。`;}
  syncHandoffControls();if(job.status==='running')scheduleSummaryRead(editor);
}
function scheduleSummaryRead(editor){const g=editor.generator;clearTimeout(g.timer);if(summaryDraftCurrent(editor)&&g.job?.status==='running')g.timer=setTimeout(()=>void readSummaryDraft(editor),900);}
async function readSummaryDraft(editor){
  const g=editor.generator;if(!summaryDraftCurrent(editor)||editor.intent||['starting','planning','loading'].includes(g.phase))return;
  clearTimeout(g.timer);g.controller?.abort();const request=++g.request,controller=new AbortController();g.controller=controller;const id=g.intent?.body.requestId||g.job?.id||'latest',previous=g.phase;g.phase='loading';syncHandoffControls();
  try{const {draft}=await api(summaryDraftPath(editor,id),{signal:controller.signal});if(!summaryDraftCurrent(editor,request))return;if(!draft){g.phase='idle';g.status.textContent='没有已保存的摘要草稿。先查看范围，再明确开始。';syncHandoffControls();return;}acceptSummaryJob(editor,validateSummaryJob(draft,editor,id==='latest'?undefined:id));}
  catch(error){if(summaryDraftCurrent(editor,request)&&!error.cancelled){g.phase=g.intent?'unknown':'error';g.status.textContent=`${error.message} 仅查询已有记录，不会重新请求模型。${g.intent?'保留本次标识，可稍后再次查询。':''}`;syncHandoffControls();}}
  finally{if(summaryDraftCurrent(editor,request)){g.controller=null;if(g.phase==='loading')g.phase=previous;syncHandoffControls();}}
}
async function startSummaryDraft(editor){
  const g=editor.generator;if(!summaryDraftCurrent(editor)||editor.intent||summaryDraftBusy(editor)||g.phase!=='ready'||!g.preview||g.preview.source.hash!==editor.preview?.source.hash)return;
  const preview=g.preview,provider=state.providers.find(item=>item.id===editor.provider.value&&item.enabled!==false);if(!provider||JSON.stringify(diagnosticConnection(provider))!==g.signature)return;
  const intent={body:{requestId:crypto.randomUUID(),providerId:provider.id,expectedSourceHash:preview.source.hash,expectedPlanHash:preview.planHash}},request=++g.request;g.intent=intent;keepSummaryIntent(editor,intent);g.phase='starting';g.job=null;g.cancelRequested=false;g.stopWanted=false;g.status.textContent='正在启动生成。关闭会请求停止，但已发出的模型请求仍可能计费。';syncHandoffControls();
  try{const {draft}=await api(summaryDraftPath(editor),{method:'POST',body:intent.body});if(!summaryDraftCurrent(editor,request)){if(editor.generation===state.generation)cancelSummaryBestEffort(editor,intent.body.requestId);return;}acceptSummaryJob(editor,validateSummaryJob(draft,editor,intent.body.requestId));if(g.stopWanted&&g.job.status==='running')void stopSummaryDraft(editor);}
  catch(error){if(!summaryDraftCurrent(editor,request))return;const uncertain=!error.status||error.status>=500||error.code==='SUMMARY_JOB_ID_CONFLICT';g.phase=uncertain?'unknown':'error';if(!uncertain){g.intent=null;forgetSummaryIntent(editor);}g.status.textContent=uncertain?'无法确认生成是否已启动。请查询本次生成结果；不会自动再次提交或重新计费。':error.message;if(error.code==='HANDOFF_SOURCE_CHANGED'){editor.phase='changed';editor.preview=null;editor.status.textContent='来源已变化，请重新核对。已编辑的摘要和新请求仍保留。';}if(error.code==='SUMMARY_PLAN_CHANGED')g.preview=null;syncHandoffControls();}
}
async function stopSummaryDraft(editor,message='已请求停止生成，已发出的模型请求仍可能计费。'){
  const g=editor.generator,id=g.intent?.body.requestId||g.job?.id;if(!summaryDraftCurrent(editor)||!id||g.cancelRequested)return;
  g.stopWanted=true;g.cancelRequested=true;g.cancelPending=true;clearTimeout(g.timer);g.controller?.abort();g.controller=null;const request=++g.request;g.status.textContent=message;syncHandoffControls();
  try{const {draft}=await api(summaryDraftPath(editor,id)+'/cancel',{method:'POST',body:{}});if(!summaryDraftCurrent(editor,request))return;acceptSummaryJob(editor,validateSummaryJob(draft,editor,id));}
  catch(error){if(summaryDraftCurrent(editor,request)){g.cancelRequested=false;g.phase=g.intent?'unknown':'error';g.status.textContent=`停止请求未获确认：${error.message} 可查询本次结果，已发请求仍可能计费。`;}}
  finally{g.cancelPending=false;if(summaryDraftCurrent(editor,request))syncHandoffControls();}
}
function sourceBusy(id){return [state.selected?.id===id?state.selected:null,state.sessions.find(item=>item.id===id)].some(session=>['running','awaiting_approval'].includes(session?.run?.status));}
function branchEditorCurrent(editor){return state.branchEditor===editor&&state.dialogSubmit===editor.submit&&$('app-dialog').open&&editor.generation===state.generation&&editor.navigation===state.navigation&&state.view==='chat'&&state.selected?.id===editor.sessionId;}
function branchUnavailable(editor){
  if(unavailableSessions.has(state.selected))return '原任务已删除，不能新建分支。已编辑的文字仍保留。';
  if(!state.conversationBranchSupported)return branchUnsupported;
  if(!handoffSupported&&hasHandoffHistory())return handoffUnsupported;
  if(!state.connected||state.switching)return '连接未就绪，请重新连接工作台。';
  if(!branchEditorCurrent(editor))return '任务已切换，请在需要编辑的消息旁重新打开分支。';
  if(!currentHistoryReady())return '任务历史尚未加载完成，请稍候。';
  if(sourceBusy(editor.sessionId))return '原任务正在运行或等待批准，请结束后再新建分支。';
  if(!state.providers.some(item=>item.id===editor.provider.value&&item.enabled!==false))return '请选择仍然启用的模型连接。';
  if(state.providers.find(item=>item.id===editor.provider.value)?.toolMode!=='none'&&editor.skill.value&&!state.skills.some(item=>item.id===editor.skill.value))return '所选技能已不可用，请重新选择。';
  return '';
}
function syncBranchControls(){
  syncHandoffControls();
  const unavailable=!state.conversationBranchSupported?branchUnsupported:!handoffSupported&&hasHandoffHistory()?handoffUnsupported:!state.connected?'连接未就绪。':!currentHistoryReady()?'任务历史尚未加载完成。':sourceBusy(state.selected?.id)?'任务结束后可编辑并新建分支。':'';
  for(const node of $('messages').querySelectorAll('[data-action=branch-message]')){node.disabled=Boolean(unavailable);node.title=unavailable||'编辑这条消息，在新任务中运行；保留原任务。';}
  const editor=state.branchEditor;if(!editor||!branchEditorCurrent(editor))return;
  const reason=branchUnavailable(editor);editor.availability.textContent=reason;editor.availability.classList.toggle('hidden',!reason);
  $('dialog-submit').disabled=Boolean(reason)||editor.phase!=='ready'||!editor.preview||(!editor.content.value.trim()&&!editor.preview.images?.length);
  editor.content.required=!editor.preview?.images?.length;
  editor.reload.disabled=editor.phase==='loading'||editor.phase==='posting'||editor.phase==='uncertain'||!state.conversationBranchSupported;
  editor.content.disabled=editor.phase==='posting';editor.mode.disabled=editor.phase==='posting';editor.provider.disabled=editor.phase==='posting';editor.skill.disabled=editor.phase==='posting'||state.providers.find(item=>item.id===editor.provider.value)?.toolMode==='none';editor.skill.title=editor.skill.disabled&&editor.phase!=='posting'?'仅对话模式不加载技能':'';
}
function renderBranchOrigin(session){
  const target=$('branch-origin'),branch=session.branch;
  if(branch?.version!==1||typeof branch.sourceTitle!=='string'||!['prefix','message'].includes(branch.mode)){target.classList.add('hidden');target.replaceChildren();target._signature=null;return;}
  const available=state.sessions.some(item=>item.id===branch.sourceSessionId),signature=JSON.stringify([session.id,branch,available]);target.classList.remove('hidden');if(target._signature===signature)return;target._signature=signature;
  const origin=available?button(branch.sourceTitle,'open-session','text-button',{id:branch.sourceSessionId}):el('span','',branch.sourceTitle);origin.title='来源任务：'+branch.sourceTitle;
  target.replaceChildren(el('span','','分支自'),origin,el('span','',branch.mode==='message'?'仅此消息':`保留此前 ${Number.isSafeInteger(branch.retainedMessages)?branch.retainedMessages:'未知'} 条消息`));
}
function showBranchDialog(messageId){
  const source=state.selected;
  if(state.view!=='chat'||!source||!currentHistoryReady()||!source.messages.some(item=>item.id===messageId&&item.role==='user'))throw new Error('请先完整打开原任务，再选择一条用户消息。');
  if(!state.conversationBranchSupported)throw new Error(branchUnsupported);
  if(sourceBusy(source.id))throw new Error('原任务正在运行或等待批准，请结束后再新建分支。');
  const description=el('p','dialog-description','编辑这条消息，在新任务中运行。原任务会保留，已经写入的文件不会撤回。');
  const body=field('修改后的消息','branchContent',{type:'textarea',value:source.messages.find(item=>item.id===messageId).content,required:!source.messages.find(item=>item.id===messageId).images?.length,maxLength:16000});const content=body.querySelector('textarea');content.rows=7;
  const modeField=field('保留范围','branchMode',{value:'prefix',options:[{value:'prefix',label:'保留此前对话'},{value:'message',label:'仅此消息'}]});const mode=modeField.querySelector('select');
  const enabled=state.providers.filter(item=>item.enabled!==false),providerField=field('本次使用的模型','branchProvider',{value:enabled.some(item=>item.id===state.providerId)?state.providerId:'',required:true,options:[{value:'',label:'请选择模型连接'},...enabled.map(item=>({value:item.id,label:`${item.name} · ${item.model||'本地演示'}${item.toolMode==='none'?' · 仅对话':''}`}))]});const provider=providerField.querySelector('select');
  const skillField=field('本次使用的技能','branchSkill',{value:state.skills.some(item=>item.id===state.skillId)?state.skillId:'',options:[{value:'',label:'不使用技能'},...state.skills.map(item=>({value:item.id,label:item.name}))],hint:'仅对话模式不加载技能。'});const skill=skillField.querySelector('select');
  const choices=el('div','branch-run-choices');choices.append(providerField,skillField);
  const scope=el('p','context-note branch-scope'),files=el('div','branch-files'),status=el('p','context-note branch-preview-status','正在读取原消息…');status.setAttribute('role','status');
  const draft=el('p','context-note','输入框的未发送草稿会保留，不会随本次提交。');
  const policy=el('p','context-note','沿用原消息的文件快照与图片；所选对话、文件和图片将发送给上方模型。后续文件写入仍需批准。');
  const availability=el('p','dialog-error hidden');availability.setAttribute('role','status');
  const reload=button('重新预览原消息','','text-button'),inspect=button('刷新任务列表','','text-button hidden');const tools=el('div','branch-preview-tools');tools.append(reload,inspect);
  const editor={sessionId:source.id,messageId,generation:state.generation,navigation:state.navigation,content,mode,provider,skill,scope,files,status,availability,reload,inspect,preview:null,loaded:false,phase:'loading',request:0};
  editor.submit=()=>submitBranch(editor);
  openDialog('编辑并新建分支',[description,body,modeField,scope,choices,files,policy,draft,status,availability,tools],'新建分支并运行',editor.submit);state.branchEditor=editor;syncBranchControls();
  content.addEventListener('input',()=>{editor.edited=true;syncBranchControls();});provider.addEventListener('change',syncBranchControls);skill.addEventListener('change',syncBranchControls);mode.addEventListener('change',()=>renderBranchPreview(editor));
  reload.addEventListener('click',()=>void loadBranchPreview(editor));inspect.addEventListener('click',async()=>{inspect.disabled=true;try{await refreshState();if(branchEditorCurrent(editor))status.textContent='任务列表已刷新。请关闭弹窗，检查是否已经创建分支；本次不会自动重新提交。';}catch(error){if(branchEditorCurrent(editor))dialogError(error.message);}finally{inspect.disabled=false;}});
  void loadBranchPreview(editor);
}
function renderBranchPreview(editor){
  const preview=editor.preview;if(!preview)return;
  editor.scope.textContent=editor.mode.value==='prefix'?`保留所选消息之前的 ${preview.previousMessages} 条消息，并以编辑后的消息开始新运行；之后的对话不复制。`:'只使用编辑后的消息和这条消息的原文件快照，不保留更早的对话。';
  if(preview.handoff?.inPrefix)editor.scope.textContent+=editor.mode.value==='prefix'||preview.handoff.onSelectedMessage?' 本次保留已保存的交接摘要。':' 本次不复制此前的交接摘要。';
  const retainedImages=Array.isArray(preview.images)?preview.images:[];if(retainedImages.length)editor.scope.textContent+=` 将保留这条消息的 ${retainedImages.length} 张原始图片，并发送给所选模型。`;
  const signature=JSON.stringify(preview.files);
  if(editor.filesSignature!==signature){editor.filesSignature=signature;editor.files.replaceChildren(el('strong','',preview.files.length?'原消息的文件快照':'原消息未附文件资料'));
    for(const file of preview.files){const row=el('div','branch-file'),heading=el('div','branch-file-heading'),hash=el('details','branch-file-hash');heading.append(el('span','',file.path),el('small','',formatBytes(file.bytes)));hash.append(el('summary','','查看 SHA-256'),el('code','context-file-hash',file.sha256));row.append(heading,hash);editor.files.append(row);}
  }
  syncBranchControls();
}
async function loadBranchPreview(editor){
  if(!branchEditorCurrent(editor)||editor.phase==='posting'||editor.phase==='uncertain')return;
  const request=++editor.request;editor.phase='loading';editor.preview=null;editor.status.textContent='正在读取原消息…';$('dialog-error').classList.add('hidden');syncBranchControls();
  try{
    const data=await api(`/api/sessions/${encodeURIComponent(editor.sessionId)}/branch-preview?messageId=${encodeURIComponent(editor.messageId)}`);
    if(!branchEditorCurrent(editor)||request!==editor.request)return;
    if(data?.version!==1||data.source?.sessionId!==editor.sessionId||data.source?.messageId!==editor.messageId||typeof data.source.prefixHash!=='string'||!/^[a-f0-9]{64}$/.test(data.source.prefixHash)||typeof data.content!=='string'||!Number.isSafeInteger(data.previousMessages)||data.previousMessages<0||!Array.isArray(data.files)||data.files.some(file=>typeof file?.path!=='string'||!Number.isSafeInteger(file.bytes)||file.bytes<0||typeof file.sha256!=='string'))throw new Error('分支预览不完整，请更新工作台后重试。');
    editor.preview=data;if(!editor.loaded){if(!editor.edited)editor.content.value=data.content;editor.loaded=true;}editor.phase='ready';editor.status.textContent='预览已就绪。';renderBranchPreview(editor);
  }catch(error){if(branchEditorCurrent(editor)&&request===editor.request){editor.phase='error';editor.status.textContent='原消息预览未完成；没有创建新任务。';if(!error.staleContext)dialogError(error.message);syncBranchControls();}}
}
async function submitBranch(editor){
  if(editor.phase!=='ready'||!editor.preview)throw new Error('请先重新预览原消息。');
  const reason=branchUnavailable(editor);if(reason)throw new Error(reason);
  const content=editor.content.value.trim();if(!content&&!editor.preview.images?.length)throw new Error('请输入修改后的消息，或保留原消息中的图片。');
  const body={messageId:editor.messageId,expectedPrefixHash:editor.preview.source.prefixHash,mode:editor.mode.value,content,providerId:editor.provider.value,...(editor.skill.value&&state.providers.find(item=>item.id===editor.provider.value)?.toolMode!=='none'?{skillId:editor.skill.value}:{})};
  editor.phase='posting';editor.status.textContent='正在新建分支并开始运行，请勿重复提交。';syncBranchControls();
  try{
    const {session}=await api(`/api/sessions/${encodeURIComponent(editor.sessionId)}/branches`,{method:'POST',body});
    if(editor.generation!==state.generation)return;
    const complete=acceptCompleteSession(session);if(complete.id===editor.sessionId)throw new Error('服务未返回独立分支，请先检查任务列表。');
    const navigate=branchEditorCurrent(editor);
    if(navigate){closeDialog();++state.sessionRequest;++state.sessionRevision;state.fullSessionRequest=null;state.selected=complete;state.sessions=[complete,...state.sessions.filter(item=>item.id!==complete.id)];showView('chat',{focus:false});renderChat();renderSessions();renderModels();$('chat-title').tabIndex=-1;$('chat-title').focus({preventScroll:true});}
    else toast('分支任务已创建。当前页面和未发送草稿保持不变，可从任务列表打开。');
    void refreshState().catch(error=>{if(editor.generation===state.generation&&!error.staleContext)toast('分支已创建，任务列表暂未刷新。请检查连接。',true);});
  }catch(error){
    if(!branchEditorCurrent(editor)||error.staleContext)return;
    if(error.code==='BRANCH_SOURCE_CHANGED'){editor.preview=null;editor.phase='changed';editor.status.textContent='原消息或此前对话已变化。你的编辑仍保留，请重新预览文件与保留范围后再提交。';}
    else if(!error.status||error.status>=500){editor.phase='uncertain';editor.inspect.classList.remove('hidden');editor.status.textContent='无法确认是否已创建分支。请先刷新并查看任务列表，确认后再决定是否重新打开弹窗；不会自动重试。';}
    else{editor.phase='ready';editor.status.textContent='此次请求未完成。请检查错误信息后再操作。';}
    syncBranchControls();throw error;
  }
}
function dialogError(message){$('dialog-error').textContent=message;$('dialog-error').classList.remove('hidden');revealFocusedDialogField();}
function closeDialog({restoreFocus=true}={}){ const diagnostic=discardProviderDiagnostics(),handoff=discardHandoffEditor();state.branchEditor=null;$('app-dialog').close(); state.dialogSubmit=null;state.dialogStayOpen=false;if(handoff&&restoreFocus&&handoff.generation===state.generation&&handoff.navigation===state.navigation&&state.selected?.id===handoff.sessionId&&state.view==='chat')$('handoff-button').focus({preventScroll:true});if(diagnostic&&restoreFocus&&diagnostic.generation===state.generation&&diagnostic.navigation===state.navigation&&state.view==='settings'){const target=[...$('providers-list').querySelectorAll('[data-action="test-provider"]')].find(node=>node.dataset.id===diagnostic.id&&!node.disabled)||$('settings-view').querySelector('h1');if(target){if(target.tagName==='H1')target.tabIndex=-1;target.focus({preventScroll:true});}} }
function showProviderDialog(providerId){
  const existing=typeof providerId==='string'?state.providers.find(item=>item.id===providerId):null;if(existing?.type==='demo')return;
  const desc=el('p','dialog-description',existing?'编辑连接配置，保留现有任务关联。密钥留空表示不改变；更改地址或协议时，必须重新输入或明确清除密钥。':'选择兼容协议，连接自己的服务商。密钥只发送给你的工作台服务，不会出现在列表和数据导出里。');
  const type=field('API 协议','type',{value:existing?.type||'openai',options:[{value:'openai',label:'OpenAI 兼容 · Chat Completions'},{value:'responses',label:'OpenAI 兼容 · Responses'},{value:'anthropic',label:'Anthropic Messages'},{value:'ollama',label:'Ollama · 本地模型'}]});
  const name=field('连接名称','name',{value:existing?.name||'',required:true,maxLength:80,placeholder:'例如：我的工作模型'});
  const base=field('API 基础地址','baseUrl',{type:'url',required:true,value:existing?.baseUrl||'https://api.openai.com/v1',hint:'使用服务商提供的 API 基础地址；只允许 HTTPS 和本机 HTTP。'});
  const model=field('模型 ID','model',{value:existing?.model||'',required:true,maxLength:120,placeholder:'填写服务商提供的准确模型 ID'});
  const key=field(existing?'新的 API 密钥（留空保留现有值）':'API 密钥（本机服务可留空）','apiKey',{type:'password',maxLength:8192,placeholder:existing?'不回显已存储的密钥':'在这里粘贴密钥',hint:'独立运行时密钥仅驻留服务内存；桌面版使用操作系统保护存储。'});
  const clear=el('label','check-field');const checkbox=el('input');checkbox.type='checkbox';checkbox.name='clearKey';clear.append(checkbox,el('span','','清除此连接已保存的密钥'));checkbox.addEventListener('change',()=>{const input=key.querySelector('input');input.disabled=checkbox.checked;if(checkbox.checked)input.value='';});
  const advanced=el('details');advanced.append(el('summary','','高级兼容选项'),field('输出 token 上限','maxTokens',{type:'number',value:String(existing?.maxTokens||4096),min:128,max:16384,required:true,hint:'实际可用上限取决于模型与服务商。'}),field('Chat Completions token 参数','tokenParameter',{value:existing?.tokenParameter||'max_completion_tokens',options:[{value:'max_completion_tokens',label:'max_completion_tokens（默认）'},{value:'max_tokens',label:'max_tokens（部分兼容服务）'}],hint:'仅用于 Chat Completions；根据服务商接口文档选择。'}));
  const capabilities=field('任务能力','toolMode',{value:existing?.toolMode==='none'?'none':'workspace',options:[{value:'workspace',label:'对话、文件与命令'},{value:'none',label:'仅对话'}],hint:'文件写入逐次审批，命令按任务策略审核；仅对话不调用任何工具，但已有对话内容仍会发送给模型。'});
  const streaming=field('响应显示方式','streaming',{value:existing?.streaming===false?'false':'true',options:[{value:'true',label:'逐步显示输出（默认）'},{value:'false',label:'兼容模式 · 等待完整响应'}],hint:'如果服务商不支持流式响应，请选择兼容模式。未完成的片段不会作为完成结果保存。'});
  const enabled=el('label','check-field');const enabledInput=el('input');enabledInput.type='checkbox';enabledInput.name='enabled';enabledInput.checked=existing?.enabled!==false;enabled.append(enabledInput,el('span','','启用此连接'));
  const nodes=[desc,name,type,base,model,key,capabilities,streaming];if(existing)nodes.push(enabled,clear);nodes.push(advanced);
  openDialog(existing?'编辑模型连接':'连接一个模型',nodes,existing?'保存连接':'添加连接',async form=>{const values=Object.fromEntries(new FormData(form));const body={name:values.name,type:values.type,baseUrl:values.baseUrl,model:values.model,maxTokens:Number(values.maxTokens),tokenParameter:values.tokenParameter,toolMode:values.toolMode,streaming:values.streaming!=='false'};if(String(values.apiKey||'').trim())body.apiKey=String(values.apiKey).trim();if(existing){body.enabled=enabledInput.checked;if(checkbox.checked)body.clearKey=true;}
    const saved=await api(existing?`/api/providers/${encodeURIComponent(existing.id)}`:'/api/providers',{method:existing?'PATCH':'POST',body});
    // A newer SSE refresh may supersede refreshState before it adopts anything.
    // Use this mutation's public result before closing, so reopening cannot read
    // the previous provider while the newer state response is still in flight.
    if(saved.provider&&typeof saved.provider.id==='string'&&(!existing||saved.provider.id===existing.id)){
      const index=state.providers.findIndex(item=>item.id===saved.provider.id);
      if(index>=0)state.providers=state.providers.map((item,i)=>i===index?saved.provider:item);
      else if(!existing)state.providers=[...state.providers,saved.provider];
      renderModels();renderProviders();
    }
    await refreshState();toast(existing?'模型连接已更新，任务关联已保留。':'模型连接已添加。可以先测试连接，再开始任务。');});
  type.querySelector('select').addEventListener('change',event=>{const defaults={openai:'https://api.openai.com/v1',responses:'https://api.openai.com/v1',anthropic:'https://api.anthropic.com/v1',ollama:'http://127.0.0.1:11434'};base.querySelector('input').value=defaults[event.target.value];});
}
function showImportDialog(){const desc=el('p','dialog-description','导入的文本会复制到独立工作空间。智能体可通过文件工具或你批准的命令读取内容。已有同名文件不会被覆盖。');const picker=field('选择本机文本文件（可选）','source',{type:'file',hint:'支持 TXT、Markdown、JSON、CSV、代码等 UTF-8 文本，最多 200 KB。'});picker.querySelector('input').accept='.txt,.md,.json,.csv,.tsv,.js,.mjs,.ts,.py,.html,.css,.yaml,.yml,.xml,.log';const path=field('工作空间中的相对路径','path',{required:true,maxLength:240,placeholder:'notes/project-brief.md'});const content=field('文本内容','content',{type:'textarea',required:true,maxLength:200000,placeholder:'粘贴参考内容，或选择上方的文本文件…'});openDialog('导入文本',[desc,picker,path,content],'导入工作空间',async form=>{const generation=state.generation,data=new FormData(form);await api('/api/workspace/files',{method:'POST',body:{path:data.get('path'),content:data.get('content')}});if(generation!==state.generation)return;invalidateFiles();invalidateAudit();await Promise.allSettled([refreshWorkspaceFiles(),refreshVisibleReads()]);if(generation===state.generation)toast('文本已导入工作空间。');});picker.querySelector('input').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;try{if(file.size>200000)throw new Error('文件超过 200 KB，请选择更小的文本。');const text=await file.text();if(text.includes('\0'))throw new Error('这个文件不是可读文本，请选择 UTF-8 文本文件。');content.querySelector('textarea').value=text;path.querySelector('input').value=file.name;$('dialog-error').classList.add('hidden');}catch(error){dialogError(error.message);}});}
function showGatewayDialog() {
  if(desktop){
    const help=el('div','dialog-help');help.append(el('p','','桌面应用连接随应用运行的内置本地服务，不能切换为远程网关。'),el('p','','需要跨设备访问时，请在手机配套客户端配置你自行部署的 HTTPS 网关，或使用系统浏览器打开网关网址。'),el('p','','当前桌面应用不会把访问令牌发送到外部网关。'));
    openDialog('桌面版的连接方式',help,'明白了',async()=>{});return;
  }
  const desc=el('p','dialog-description',native?'连接你自己部署的 HTTPS 工作台网关。任务、文件与模型请求由该网关处理。访问令牌仅保留在当前页面内存，重新打开后需再次输入。':'浏览器中的工作台只连接当前页面同源的服务。若要使用其他 HTTPS 网关，请先在浏览器打开该网关页面，再在那里输入令牌。');desc.append(document.createTextNode(' 切换工作台不会带入原草稿；重新连接同一工作台可恢复本机已保存的草稿。发送结果未确认时，请先核对任务记录。'));
  const url=field('HTTPS 网关地址','url',{value:state.gateway || (!native&&location.protocol==='https:'?location.origin:''),type:'url',placeholder:'https://agent.example.com',hint:native?'手机配套客户端必须使用 HTTPS。网关需允许本应用的来源。':'当前页面地址：'+location.origin+'。留空恢复当前页面服务。'});
  const token=field('访问令牌','token',{type:'password',value:state.bearer,maxLength:4096,placeholder:'输入服务端配置的访问令牌'});
  const tip=el('div','gateway-current hidden');const openLink=el('a','button secondary hidden','在浏览器新页打开网关');openLink.target='_blank';openLink.rel='noopener noreferrer';
  const updateTarget=()=>{
    let target='';try{target=normalizeGateway(url.querySelector('input').value,{native});}catch{}
    const otherOrigin=Boolean(!native&&target&&target!==location.origin);
    tip.classList.toggle('hidden',!otherOrigin);openLink.classList.toggle('hidden',!otherOrigin);token.querySelector('input').disabled=otherOrigin;
    if(otherOrigin){tip.textContent='当前页面的安全策略不允许连接这个外部地址。请打开目标网关页面后再配对；这里不会发送访问令牌。';openLink.href=target;token.querySelector('input').value='';}else openLink.removeAttribute('href');
  };
  openDialog('连接你的工作台',[desc,url,tip,openLink,token],'连接并验证',async form=>{
    const data=new FormData(form);const gateway=normalizeGateway(data.get('url'),{native});
    if(native&&!gateway)throw new Error('请输入你自己的 HTTPS 网关地址。');
    if(!native&&gateway&&gateway!==location.origin)throw new Error('当前页面不能直接连接其他网关。请先在浏览器打开该 HTTPS 网关页面，再输入令牌。');
    const bearer=String(data.get('token')||'').trim();if(gateway&&!bearer)throw new Error('连接网关时请输入访问令牌。');
    const previous={gateway:state.gateway,bearer:state.bearer};resetWorkspaceContext({keepDialog:true,clearIdentity:true});state.gateway=gateway;state.bearer=bearer;const generation=state.generation;
    try{const result=await api('/api/bootstrap');if(generation!==state.generation)return;acceptAuthentication(result);saveStorage('openaster.gateway',gateway);connection(true);void connectStream(state.generation);void refreshVisibleReads({browse:true});if(generation===state.generation)toast('工作台连接成功，未带入原工作区的未发送内容。');}
    catch(error){if(generation!==state.generation||error.staleContext)return;state.gateway=previous.gateway;state.bearer=previous.bearer;resetWorkspaceContext({keepDialog:true,clearIdentity:true});await bootstrap();throw error;}
  });
  url.querySelector('input').addEventListener('input',updateTarget);updateTarget();
}
function showHelp(){const body=el('div','dialog-help');body.append(el('p','','OpenAster 是开源、本地优先的智能体工作台。这个预览版本提供对话、工作区文件工具、可配置的命令审批和可核查的执行过程。'));const list=el('ul');for(const text of ['1. 在「设置」连接自己的模型，或先体验标注明确的本地演示。','2. 在「工作空间」查看完整路径；桌面菜单「工作区 → 新建项目…」可创建自己的项目文件夹。','3. 查看任务步骤，检查完整写入内容或命令，再批准或拒绝。命令使用本机用户权限，可通过停止任务中断。','4. 在「安全与活动记录」回顾操作，或在设置导出自己的数据。'])list.append(el('li','',text));body.append(list,el('p','','快捷键：Ctrl / ⌘ P 搜索任务、文件与操作；Ctrl / ⌘ K 新建任务；Enter 发送；Shift + Enter 换行。中文输入法选词期间不会误发送。'),el('p','','移动端作为配套客户端连接你自行托管的 HTTPS 网关。PWA 离线只保留界面资源，任务操作需要工作台服务。'),el('p','','AI 结果需要核实。接入云端模型后，对话与模型读取的文件会发送到所选服务商。本预览版本不宣称已达到绝对安全或零缺陷。'));openDialog('使用帮助',body,'开始使用',async()=>{});}
function confirmDialog(title,description,submit,handler){openDialog(title,el('p','dialog-description',description),submit,handler);$('dialog-submit').className='button danger';}
function downloadJson(value,filename){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function showComposerDrafts(){
  const generation=state.generation;
  try { await composerDrafts.ready(); } catch {}
  if(generation!==state.generation)return;
  const body=el('div','device-draft-manager');
  body.append(el('p','dialog-description',desktop?'未发送内容仅保存在此设备，并使用系统加密。草稿不包含文件正文或访问凭据，也不会自动发送。':'未发送内容保存在此浏览器，按工作台与任务分开。清除网站数据或系统回收存储可能移除草稿；不会自动发送。'));
  const note=el('p','context-note');note.setAttribute('role','status');body.append(note);
  const controls=el('div','draft-manager-actions'),list=el('div');body.append(controls,list);
  function control(label,handler){const node=el('button','button secondary',label);node.type='button';node.addEventListener('click',async()=>{node.disabled=true;try{await handler();if(generation===state.generation)render();}catch{note.textContent='操作未完成，内容仍保留。请检查连接或重新读取草稿。';}finally{node.disabled=false;}});return node;}
  controls.append(control('重试保存',()=>composerDrafts.flush()),control('重新读取',()=>composerDrafts.refresh()));
  function preview(title,draft){const section=el('section','device-draft-preview');section.append(el('h3','',title));if(!draft){section.append(el('p','context-note','此版本已删除草稿。'));return section;}const text=el('textarea');text.readOnly=true;text.rows=4;text.value=draft?.text||'';text.setAttribute('aria-label',title+'的完整内容');section.append(text);if(draft?.files.length)section.append(el('p','context-note','文件引用：'+draft.files.map(file=>file.path).join('、')));return section;}
  function render(){
    if(generation!==state.generation)return;list.replaceChildren();const drafts=composerDrafts.list(),conflicts=composerDrafts.conflicts();
    note.textContent=composerDraftState?.unavailable || (composerDraftState?.error?'有草稿尚未保存。达到 20 份或 512 KiB 限制时，请先删除不再需要的草稿；不会自动清理。':drafts.length+' / 20 份本机草稿');
    for(const conflict of conflicts){const box=el('section','device-draft-conflict');box.append(el('h3','','另一个窗口修改了同一份草稿'),preview('本页版本',conflict.local),preview('已保存版本',conflict.remote));box.append(control(conflict.local?'保留本页版本':'确认删除已保存版本',()=>composerDrafts.resolve(conflict.slot,conflict.remote,'local')),control(conflict.remote?'使用已保存版本':'采用已删除状态',()=>composerDrafts.resolve(conflict.slot,conflict.remote,'remote')));list.append(box);}
    for(const draft of drafts){const session=state.sessions.find(item=>item.id===draft.slot),title=draft.slot==='new'?'新任务':session?.title||'原任务已不可用';const row=preview(title,draft);row.append(el('p','context-note','最后编辑：'+formatDate(draft.updatedAt,true)));
      if(draft.uncertain){row.append(el('p','context-note','上一次发送结果尚未确认。请核对对应任务记录，避免重复发送。'));if(draft.slot===composerDrafts.currentSlot())row.append(control('已核对记录，允许再次发送',()=>composerDrafts.acknowledge()));}
      if(draft.slot==='new'||session)row.append(control('打开这份草稿',async()=>{closeDialog();if(draft.slot==='new')startNew();else await openSession(draft.slot);}));
      row.append(control('删除草稿',async()=>{const removed=await composerDrafts.discard(draft.slot,draft.revision);if(!removed)throw new Error('changed');}));list.append(row);
    }
    if(!drafts.length&&!conflicts.length)list.append(el('p','context-note','当前工作台没有已保存的草稿。'));
  }
  render();openDialog('本机草稿',body,'完成',async()=>{});
}
function startNew(){state.selected=null;++state.sessionRequest;showView('home');renderSessions();$('prompt-input').focus();}
const templates={workspace:'请查看我的工作空间，概括现有文件的内容与结构，并提出下一步建议。',writing:'请帮我完成一份清晰、有条理的初稿。\n\n主题：\n目标读者：\n想表达的重点：',build:'请先分析这个需求，拆解实现步骤。在任何文件写入前，展示完整内容供我批准。\n\n我要构建：',analyze:'请基于工作空间中的材料提炼主要结论，区分事实与推断，并列出仍需要补充的信息。'};
const actions={
  handoff:showHandoffDialog, 'composer-drafts':showComposerDrafts,
  'workspace-mode':node=>setWorkspaceMode(node.dataset.mode),
  'workspace-search':()=>{showView('workspace');setWorkspaceMode('content');void refreshWorkspaceFiles({refreshIndex:false}).catch(error=>{if(!error.staleContext)toast(error.message,true);});},
  'cancel-workspace-search':()=>{cancelWorkspaceSearch({clear:true,notice:'已取消搜索。'});$('workspace-search-query').focus();},
  'search-result':node=>openSearchResult(node), 'return-search-results':node=>returnToSearchResults(node),
  'branch-message':node=>showBranchDialog(node.dataset.messageId),
  command:()=>commandPalette.open(),
  'attach-context-file':attachContextFile,'remove-context-file':removeContextFile,
  'refresh-usage-overview':()=>loadUsageOverview(), 'more-usage-overview':()=>loadUsageOverview({more:true}),
  'refresh-run-history':()=>loadRunHistory(), 'more-run-history':()=>loadRunHistory({more:true}), 'retry-run-record':node=>loadRunRecord(node.dataset.id),
  'pin-session':node=>togglePin(node.dataset.id),'pin-current':()=>togglePin(state.selected?.id),
  'filter-recent':node=>{state.recentFilter=node.dataset.filter;renderSessions();},
  attention:()=>{const waiting=state.sessions.find(item=>item.run?.status==='awaiting_approval');if(waiting)return openSession(waiting.id);toast('当前没有等待批准的任务。');},
  'toggle-context':()=>{state.contextOpen=!state.contextOpen;saveStorage('openaster.context',state.contextOpen?'open':'closed');syncContextPanel();if(state.contextOpen)void refreshVisibleReads({fresh:true});else $('context-toggle').focus();if(state.contextOpen&&mobileLayout.matches)$('context-panel').scrollIntoView({block:'start',behavior:'smooth'});},
  'preview-context-file':node=>previewContextFile(node.dataset.path),
  'close-context-preview':()=>{++state.contextFileRequest;$('context-preview').classList.add('hidden');$('context-toggle').focus();},
  'workspace-file':async node=>{const path=node.dataset.path;showView('workspace');const generation=state.generation,navigation=state.navigation;await Promise.allSettled([refreshWorkspaceFiles({refreshIndex:false})]);if(generation!==state.generation||navigation!==state.navigation||state.view!=='workspace')return;await openFile(path);},
  'edit-provider':node=>showProviderDialog(node.dataset.id),
  home:()=>{showView('home');renderSessions();},new:startNew,
  sidebar:()=>{$('sidebar').classList.add('open');$('sidebar-scrim').classList.remove('hidden');syncSidebarAccessibility();$('sidebar').querySelector('.new-task').focus();},'close-sidebar':closeSidebar,
  workspace:async()=>{showView('workspace');await refreshWorkspaceFiles({refreshIndex:false});},skills:()=>showView('skills'),settings:()=>{showView('settings');renderProviders();},security:async()=>{showView('security');await loadAudit();},
  search:()=>{$('task-search').classList.remove('hidden');if(matchMedia('(max-width:760px)').matches)actions.sidebar();$('search-input').focus();},
  template:node=>{if($('quick-start'))$('quick-start').open=false;startNew();$('prompt-input').value=templates[node.dataset.template]||'';updateComposer();composerDrafts.changed();$('prompt-input').focus();},
  'open-session':node=>openSession(node.dataset.id),
  'use-skill':node=>{startNew();state.skillId=node.dataset.id;updateComposer();composerDrafts.changed();$('prompt-input').focus();},'clear-skill':()=>{state.skillId='';updateComposer();composerDrafts.changed();},
  'add-provider':showProviderDialog,import:showImportDialog,gateway:showGatewayDialog,help:showHelp,'close-dialog':closeDialog,reconnect:bootstrap,
  'android-notices':()=>androidNotices.open(),
  'file-permissions':changeFilePermissions,'web-access-settings':()=>{showView('settings');$('web-access-toggle').focus();},'open-workspace-project':()=>openWorkspaceProject(false),'create-workspace-project':()=>openWorkspaceProject(true),
  theme:()=>{document.body.classList.toggle('dark');saveStorage('openaster.theme',document.body.classList.contains('dark')?'dark':'light');syncThemeAppearance();toast(document.body.classList.contains('dark')?'已切换为深色主题':'已切换为浅色主题');},
  'refresh-files':refreshWorkspaceFiles,'open-file':node=>openFile(node.dataset.path),'refresh-audit':()=>loadAudit({restart:true}),
  'refresh-context-files':()=>loadFiles({invalidate:true}),'refresh-context-audit':()=>loadAudit({restart:true}),
  'open-directory':node=>loadBrowseFiles({scope:node.dataset.path}),'browse-root':()=>loadBrowseFiles({scope:''}),'browse-up':()=>loadBrowseFiles({scope:state.browseScope.split('/').slice(0,-1).join('/')}),
  'copy-file':async()=>{await navigator.clipboard.writeText($('selected-file-content')?.textContent||'');toast('文件内容已复制。');},
  'copy-workspace-path':async()=>{if(!state.workspacePath)return;await navigator.clipboard.writeText(state.workspacePath);toast('工作空间完整路径已复制。');},
  'edit-file':editFile,
  'test-provider':node=>showProviderDiagnostics(node.dataset.id),
  'delete-provider':node=>{const provider=state.providers.find(item=>item.id===node.dataset.id);if(!provider)return;confirmDialog('删除模型连接',`删除「${provider.name}」的配置和密钥？已有任务记录将保留。`,'删除连接',async()=>{await api(`/api/providers/${encodeURIComponent(provider.id)}`,{method:'DELETE'});await refreshState();toast('模型连接已删除。');});},
  rename:()=>{const session=state.selected;if(!session)return;openDialog('重命名任务',field('任务名称','title',{value:session.title,required:true,maxLength:120}),'保存名称',async form=>{const title=String(new FormData(form).get('title')||'').trim();if(!title)throw new Error('请输入任务名称。');const {session:updated}=await api(`/api/sessions/${encodeURIComponent(session.id)}`,{method:'PATCH',body:{title}});if(state.selected?.id===session.id){state.selected=acceptCompleteSession(updated,session.id);renderChat();}await refreshState();});},
  'delete-session':()=>{const session=state.selected;if(!session)return;confirmDialog('删除这个任务',`确定删除「${session.title}」、对话及执行记录？该任务对应的本地累计用量也会移除。工作空间中的文件会保留，此操作无法撤销。`,'删除任务',async()=>{await api(`/api/sessions/${encodeURIComponent(session.id)}`,{method:'DELETE'});if(state.selected?.id===session.id)startNew();await refreshState();toast('任务已删除。');});},
  'export-session':()=>{if(state.selected)downloadJson(state.selected,`openaster-task-${state.selected.id}.json`);},
  'export-all':async()=>{const data=await api('/api/export');downloadJson(data,`openaster-export-${new Date().toISOString().slice(0,10)}.json`);toast('已导出工作台数据，未包含模型密钥。');},
  cancel:async()=>{if(!state.selected)return;const id=state.selected.id;await api(`/api/sessions/${encodeURIComponent(id)}/cancel`,{method:'POST',body:{}});await refreshSession(id);toast('已请求停止任务。');},
  approve:node=>decide(node,'approve'),deny:node=>decide(node,'deny'),
  'approve-task':node=>commandPolicyUI?.approveForRun(node.dataset.id,()=>decide(node,'approve','session'))
};
async function decide(node,decision,scope='once'){if(!state.selected||!completeSessionHistory.has(state.selected))throw new Error('正在重新读取任务，本次审批尚未发送。请读取完成后核对审批状态。');const sessionId=state.selected.id,generation=state.generation,approval=state.selected.approvals?.find(item=>item.id===node.dataset.id);if(!approval||approval.status!=='pending')throw new Error('此审批已变化，请重新核对当前待审批内容。');if(decision==='approve'&&!approvalPreview(approval))throw new Error('完整操作预览不可用，请拒绝后重新生成提案。');if(scope==='session'&&commandPolicyUI?.pendingEligibility(approval.id)?.sessionEligible!==true)throw new Error('此命令不支持本轮授权。');node.disabled=true;try{await api(`/api/approvals/${encodeURIComponent(node.dataset.id)}`,{method:'POST',body:{decision,...(scope==='session'?{scope:'session',confirmRisk:true}:{})}});if(generation===state.generation&&state.selected?.id===sessionId)await refreshSession(sessionId);toast(decision==='approve'?'批准已记录，请查看任务中的实际执行结果。':'已拒绝这一次操作。');}finally{node.disabled=false;}}
document.addEventListener('click',event=>{const node=event.target.closest('[data-action]');if(!node||node.disabled)return;const action=actions[node.dataset.action];if(!action)return;event.preventDefault();Promise.resolve().then(()=>action(node)).catch(error=>{if(!error.staleContext)toast(error.message||'操作失败，请重试。',true);});});
$('usage-overview').addEventListener('toggle',()=>{if($('usage-overview').open&&state.view==='settings'&&state.usageOverviewSupported&&!state.usageOverview?.snapshot&&!state.usageOverview?.loading)void loadUsageOverview();});
$('run-history').addEventListener('toggle',()=>{const history=state.runHistory;if($('run-history').open&&history?.sessionId&&!history.loaded&&!history.loading)void loadRunHistory();});
$('web-access-toggle').addEventListener('change',event=>void changeWebAccess(event.target.checked));
$('web-search-provider').addEventListener('change',event=>{webSearchDraft=event.target.value;syncWebAccessControls();});
$('web-search-save').addEventListener('click',()=>void saveWebSearchProvider());
$('composer').addEventListener('submit',sendMessage);
$('prompt-input').addEventListener('input',()=>{++state.draftRevision;updateComposer();composerDrafts.changed();});
let composerComposing=false,composerCompositionEndedAt=-Infinity;
$('prompt-input').addEventListener('compositionstart',()=>{composerComposing=true;});
$('prompt-input').addEventListener('compositionend',()=>{composerComposing=false;composerCompositionEndedAt=performance.now();});
$('prompt-input').addEventListener('keydown',event=>{
  if(event.key!=='Enter'||event.shiftKey)return;
  if(composerComposing||event.isComposing||event.keyCode===229)return;
  event.preventDefault();
  if(event.repeat||performance.now()-composerCompositionEndedAt<60)return;
  void sendMessage();
});
$('search-input').addEventListener('input',renderSessions);
$('file-search').addEventListener('input',renderFileList);
$('workspace-search-form').addEventListener('submit',searchWorkspace);
$('workspace-search-query').addEventListener('input',()=>cancelWorkspaceSearch({clear:true}));
$('workspace-search-case').addEventListener('change',()=>cancelWorkspaceSearch({clear:true,notice:'匹配方式已更改，点击搜索以重新读取。'}));
let workspaceSearchComposing=false,workspaceSearchCompositionEndedAt=-Infinity;
$('workspace-search-query').addEventListener('compositionstart',()=>{workspaceSearchComposing=true;});
$('workspace-search-query').addEventListener('compositionend',()=>{workspaceSearchComposing=false;workspaceSearchCompositionEndedAt=performance.now();});
$('workspace-search-query').addEventListener('keydown',event=>{
  if(event.key==='Enter'&&(workspaceSearchComposing||event.isComposing||event.keyCode===229||performance.now()-workspaceSearchCompositionEndedAt<60)){event.preventDefault();return;}
  if(event.key==='ArrowDown'&&!event.isComposing){const first=$('workspace-search-results').querySelector('[data-action=search-result]');if(first){event.preventDefault();first.focus();}}
  if(event.key==='Escape'&&state.workspaceSearch.loading){event.preventDefault();cancelWorkspaceSearch({clear:true,notice:'已取消搜索。'});}
});
$('workspace-search-results').addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp'].includes(event.key)||event.isComposing)return;const rows=[...$('workspace-search-results').querySelectorAll('[data-action=search-result]')],index=rows.indexOf(event.target.closest('[data-action=search-result]'));if(index<0)return;event.preventDefault();const next=index+(event.key==='ArrowDown'?1:-1);if(next<0)$('workspace-search-query').focus();else rows[Math.min(next,rows.length-1)]?.focus();});
$('workspace-include-generated').addEventListener('change',event=>{void loadBrowseFiles({includeGenerated:event.target.checked}).catch(error=>{if(!error.staleContext)toast(error.message,true);});});
commandPolicyUI=createCommandPolicyUI({context:()=>{const session=state.selected,provider=state.providers.find(item=>item.id===session?.providerId);return{key:JSON.stringify([state.generation,state.navigation,state.workspaceKey,session?.id]),sessionId:session?.id,title:session?.title,supported:state.commandPolicySupported===true,available:state.commandPolicySupported===true&&authenticationReady&&state.connected&&!state.switching&&!unavailableSessions.has(session),toolsAvailable:Boolean(provider&&provider.toolMode!=='none'),visible:state.view==='settings'||state.view==='chat'&&(state.contextOpen||session?.approvals?.some(item=>item.status==='pending'))};},request:api,openDialog,onUpdate:()=>{if(state.view==='chat'&&state.selected)renderApprovals(state.selected.approvals||[]);},onChanged:async()=>{const sessionId=state.selected?.id;if(sessionId)await refreshSession(sessionId);toast('命令策略已更新。');}});
$('file-permissions-section').after(commandPolicyUI.settingsNode);
imageInput=createImageInputUI({container:$('image-input-region'),list:$('image-input-list'),status:$('image-input-status'),input:$('image-input-file'),button:$('attach-image-button'),pasteTarget:$('prompt-input'),dropTarget:$('composer'),onChange:()=>updateComposer()});
taskInputUI=createTaskInputUI({input:$('prompt-input'),onInterrupt:()=>void sendMessage(undefined,{mode:'interrupt'})});
queuedInputView=createQueuedInputView({renderImages:renderMessageImages});
modelPicker=createModelPicker({select:$('model-select'),trigger:$('model-picker-trigger'),popup:$('model-picker-popup'),label:$('model-picker-label'),readProviders:()=>state.providers});
workspaceManagerUI=createWorkspaceUI({api,reconnect:bootstrap,notify:toast,getContext:()=>({path:state.workspacePath}),beforeSwitch:async()=>{
  if(fileEditor?.hasPending())throw new Error('请先保存或取消当前文件编辑，再切换项目。');
  if(imageInput?.hasAny())throw new Error('请先发送或移除待发送图片，再切换项目。');
  await composerDrafts.flush();
}});
$('model-select').addEventListener('change',event=>{state.providerId=event.target.value;updateComposer();composerDrafts.changed();});
$('dialog-form').addEventListener('submit',async event=>{event.preventDefault();if(!state.dialogSubmit||$('dialog-submit').disabled)return;const handler=state.dialogSubmit;$('dialog-submit').disabled=true;$('dialog-error').classList.add('hidden');try{await handler(event.currentTarget);if(state.dialogSubmit===handler&&!state.dialogStayOpen)closeDialog();}catch(error){if(state.dialogSubmit===handler&&!error.staleContext)dialogError(error.message||'无法完成操作，请重试。');}finally{if(state.dialogSubmit===handler){$('dialog-submit').disabled=false;syncBranchControls();syncProviderDiagnostics();}}});
$('app-dialog').addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
$('dialog-body').addEventListener('focusin',revealFocusedDialogField);
window.addEventListener('resize',revealFocusedDialogField);
window.visualViewport?.addEventListener('resize',revealFocusedDialogField);
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!event.isComposing&&event.keyCode!==229&&!event.defaultPrevented){event.preventDefault();if(!document.querySelector('dialog[open]'))startNew();}if(document.querySelector('dialog[open]'))return;if(event.key==='Escape')closeSidebar();if(event.key==='Tab'&&mobileLayout.matches&&$('sidebar').classList.contains('open')){const focusable=[...$('sidebar').querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),summary,[tabindex="0"]')].filter(node=>node.getClientRects().length&&!node.closest('[inert]'));const first=focusable[0],last=focusable.at(-1),inside=$('sidebar').contains(document.activeElement);if(first&&((event.shiftKey&&(document.activeElement===first||!inside))||(!event.shiftKey&&(document.activeElement===last||!inside)))){event.preventDefault();(event.shiftKey?last:first).focus({preventScroll:true});}}});
mobileLayout.addEventListener('change',syncSidebarAccessibility);
window.addEventListener('online',()=>{void bootstrap();});
window.addEventListener('beforeunload',event=>{if(composerDrafts.pending()||fileEditor?.hasPending()||imageInput?.hasAny()){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',()=>{
  fileEditor?.suspend();
  void composerDrafts.flush().catch(()=>{});
  if(providerDiagnostics||handoffEditor||state.branchEditor)closeDialog({restoreFocus:false});
  interruptedSend ||= state.sending;
  // A page can survive navigation in BFCache. Invalidate late results and
  // credentials now; only a new bootstrap may restore its event connection.
  pageSuspended=true;++state.generation;++state.sendRequest;state.sending=false;state.switching=false;
  cancelFilesRequest();cancelAuditRequest();cancelBrowseRequest();cancelWorkspaceSearch({clear:true});stopStream();
  authenticationReady=false;++authenticationRevision;++state.stateRequest;
  state.bearer='';state.csrf='';document.querySelectorAll('input[type="password"]').forEach(input=>{input.value='';});
  connection(false,state.gateway?'页面已离开，访问令牌已清除。请配置网关并重新输入令牌。':'页面已暂停，返回后将重新连接工作台。');
});
window.addEventListener('pageshow',event=>{
  if (event.persisted || pageSuspended) syncThemeAppearance();
  if(!pageSuspended)return;pageSuspended=false;
  if(interruptedSend){interruptedSend=false;toast('离开页面时仍在处理任务。请核对任务记录后再决定是否重试。',true);}
  if(state.gateway&&!state.bearer){connection(false,'访问令牌已清除。请配置网关并重新输入令牌。');return;}
  void bootstrap();
});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void composerDrafts.flush().catch(()=>{});if(!pageSuspended&&document.visibilityState==='visible'){syncThemeAppearance();if(state.connected){scheduleRefresh();void composerDrafts.refresh().catch(()=>{});}}});
if($('workspace-date'))$('workspace-date').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'short'});
hydrateIcons();showView('home',{focus:false});syncContextPanel();renderSessions();renderSkills();renderProviders();void bootstrap();
if('serviceWorker'in navigator&&!native){window.addEventListener('load',()=>{navigator.serviceWorker.register('./sw.js').catch(()=>{});});}









