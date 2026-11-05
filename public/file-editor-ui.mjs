// SPDX-License-Identifier: Apache-2.0
// Manual, explicitly reviewed file writes. File buffers never enter task drafts.
import { inspectEditorText, encodeEditorText } from './file-editor-text.mjs';

const HASH = /^[a-f0-9]{64}$/;
const make = (tag, className = '', text) => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const bytes = value => new TextEncoder().encode(value);
async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value)))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function completeFile(value, path) {
  if (!value || typeof value.path !== 'string' || value.path !== path || typeof value.content !== 'string' || !HASH.test(value.sha256 || '')) throw new Error('文件版本信息不完整，请重新读取。');
  inspectEditorText(value.content);
  return Object.freeze({ path: value.path, content: value.content, sha256: value.sha256 });
}
function fullText(title, content, name) {
  const details = make('details', 'file-editor-complete'); details.dataset.fileEditorContent = name;
  const pre = make('pre', 'file-editor-full-text', content); pre.tabIndex = 0; pre.setAttribute('role', 'region'); pre.setAttribute('aria-label', title);
  details.append(make('summary', '', title), pre); return details;
}

export function createFileEditorUI({ request, getContext, renderDiff, onSaved = () => {}, notify = () => {} }) {
  let editor = null;
  let leaveLocked = false;
  const dialog = make('dialog', 'file-editor-dialog'); dialog.id = 'file-editor-dialog'; dialog.setAttribute('aria-labelledby', 'file-editor-title');
  const header = make('div', 'file-editor-header'); const title = make('h2', '', '编辑文件'); title.id = 'file-editor-title';
  const path = make('code', 'file-editor-path'); path.id = 'file-editor-path'; header.append(title, path);
  const body = make('div', 'file-editor-body');
  const note = make('p', 'context-note', '修改仅保留在本页，审阅后确认写入工作区；不会发送给模型。已有任务中的文件快照不会改变。');
  const status = make('p', 'file-editor-status'); status.id = 'file-editor-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const editPane = make('div', 'file-editor-edit');
  const label = make('label', 'file-editor-label', '编辑文件内容'); label.htmlFor = 'file-editor-input';
  const input = make('textarea', 'file-editor-input'); input.id = 'file-editor-input'; input.spellcheck = false; input.setAttribute('aria-describedby', 'file-editor-format file-editor-status');
  const format = make('p', 'context-note'); format.id = 'file-editor-format';
  const eolLabel = make('label', 'file-editor-eol-label', '换行格式'); eolLabel.htmlFor = 'file-editor-eol';
  const eol = make('select'); eol.id = 'file-editor-eol';
  for (const [value, text] of [['', '沿用原文件格式'], ['LF', '统一为 LF'], ['CRLF', '统一为 CRLF'], ['CR', '统一为 CR']]) {
    const option = make('option', '', text); option.value = value; eol.append(option);
  }
  const formatControl = make('div', 'file-editor-format-control'); formatControl.append(eolLabel, eol);
  editPane.append(label, input, formatControl, format);
  const review = make('section', 'file-editor-review'); review.id = 'file-editor-review'; review.setAttribute('aria-label', '文件修改审阅'); review.hidden = true;
  const latest = make('section', 'file-editor-latest'); latest.id = 'file-editor-latest'; latest.setAttribute('aria-label', '当前磁盘版本'); latest.hidden = true;
  body.append(note, status, editPane, review, latest);
  const confirmation = make('div', 'file-editor-discard'); confirmation.id = 'file-editor-discard'; confirmation.hidden = true;
  confirmation.setAttribute('role', 'group'); confirmation.setAttribute('aria-label', '关闭编辑确认');
  const discardNote = make('p'); confirmation.append(discardNote);
  const actions = make('div', 'file-editor-actions');
  const resume = make('div', 'file-editor-resume'); resume.hidden = true; resume.setAttribute('role', 'region'); resume.setAttribute('aria-label', '本页保留的文件编辑');
  const resumeText = make('span', '', '文件编辑仍保留在本页');
  const resumeButton = make('button', 'text-button', '继续文件编辑'); resumeButton.type = 'button'; resumeButton.id = 'file-editor-resume'; resume.append(resumeText, resumeButton);
  const main = document.getElementById('main'); if (main) main.before(resume); else document.body.append(resume);
  const controls = {};
  function control(action, text, primary = false) {
    const node = make('button', primary ? 'button primary' : 'button secondary', text); node.type = 'button'; node.dataset.fileEditorAction = action; controls[action] = node; return node;
  }
  confirmation.append(control('keep-editing', '继续编辑', true), control('discard', '放弃本页编辑并关闭'));
  actions.append(control('close', '关闭'), control('park', '保留编辑并关闭'), control('verify', '读取当前版本'), control('rebase', '以当前版本重新审阅'), control('back', '返回编辑'), control('review', '审阅修改', true), control('save', '确认写入文件', true));
  dialog.append(header, body, confirmation, actions); document.body.append(dialog);

  function scopeMatches(current, captured) {
    return Boolean(current.storageId && current.storageId === captured.storageId && current.workspaceKey === captured.workspaceKey);
  }
  function available(current, value = editor) {
    return Boolean(value && scopeMatches(current, value.context) && current.supported === true && current.connected && !current.switching && !current.suspended);
  }
  function authorized(value = editor) {
    const current = getContext();
    return available(current, value) && !value.revoked && current.generation === value.authorizedGeneration && current.navigation === value.authorizedNavigation;
  }
  function busy(value = editor) { return Boolean(leaveLocked || (value && ['reading', 'reviewing', 'saving'].includes(value.phase))); }
  function dirty(value = editor) {
    if (!value) return false;
    try { return encodeEditorText(value.original.content, input.value, eol.value ? { ending: eol.value } : {}) !== value.original.content; } catch { return true; }
  }
  function pending() { return Boolean(editor && (dirty() || editor.uncertain || editor.phase === 'saving')); }
  function message(text, error = false) { status.textContent = text; status.classList.toggle('file-editor-error', error); }
  function formatText() {
    if (!editor) return;
    const info = inspectEditorText(editor.original.content);
    format.textContent = (info.bom ? '保留 UTF-8 BOM。' : '无 UTF-8 BOM。') + (info.ending === 'mixed' ? '原文件使用混合换行；修改内容时须明确选择统一格式。' : '原换行：' + (info.ending === 'none' ? '无换行（新增换行默认 LF）' : info.ending) + '。') + ' 不自动增删末尾换行。';
  }
  function render() {
    if (!editor) return;
    dialog.dataset.phase = editor.phase; dialog.setAttribute('aria-busy', String(Boolean(busy())));
    body.inert = !confirmation.hidden; actions.inert = !confirmation.hidden;
    resume.hidden = dialog.open || !editor;
    const reviewing = editor.phase === 'review', locked = busy() || editor.phase === 'review';
    input.readOnly = locked; eol.disabled = locked;
    editPane.hidden = reviewing || editor.phase === 'saving';
    review.hidden = !editor.candidate || !['review', 'saving', 'unknown', 'conflict', 'invalid', 'post-write', 'reading'].includes(editor.phase);
    latest.hidden = !editor.latest;
    controls.review.hidden = reviewing || editor.phase === 'saving' || editor.phase === 'saved';
    controls.review.disabled = Boolean(busy()) || !authorized() || !dirty() || editor.uncertain || ['conflict', 'post-write', 'unknown', 'invalid'].includes(editor.phase);
    controls.save.hidden = !editor.candidate; controls.save.disabled = Boolean(busy()) || !reviewing || !authorized() || !editor.candidate;
    controls.back.hidden = !reviewing; controls.back.disabled = Boolean(busy());
    controls.verify.hidden = !editor.revoked && !['unknown', 'conflict', 'post-write', 'invalid'].includes(editor.phase);
    controls.verify.disabled = Boolean(busy()) || !available(getContext());
    controls.rebase.hidden = !editor.latest || editor.phase === 'saved';
    controls.rebase.disabled = Boolean(busy()) || !available(getContext()) || !editor.latestContext || editor.latestContext.generation !== getContext().generation;
    controls.close.disabled = leaveLocked || editor.phase === 'saving';
    controls.park.hidden = !editor.revoked && !editor.uncertain; controls.park.disabled = leaveLocked || editor.phase === 'saving';
  }
  function invalidate(text = '工作区连接已变化。编辑内容仍保留，请连接原工作区后读取当前版本核对。') {
    if (!editor) return;
    if (editor.phase === 'saving') editor.uncertain = true;
    ++editor.request; editor.controller?.abort(); editor.controller = null;
    editor.revoked = true; editor.phase = 'invalid'; editor.latest = null; editor.latestContext = null;
    latest.replaceChildren(); message(text + (editor.uncertain ? ' 先前保存结果尚未确认，不会自动重试。' : ''), true); render();
  }
  function syncContext() {
    if (!editor) return;
    const current = getContext();
    if (!editor.revoked && (!available(current) || current.generation !== editor.authorizedGeneration || current.navigation !== editor.authorizedNavigation)) invalidate();
    else render();
  }
  function currentRead(value, sequence, context) {
    const current = getContext();
    return editor === value && value.request === sequence && available(current, value) && current.generation === context.generation && current.navigation === context.navigation;
  }
  function focusInput() { (editPane.hidden ? controls.back : input).focus({ preventScroll: true }); }
  function closeNow() {
    const previous = editor; if (!previous) return;
    const verified = previous.lastVerified; previous.lastVerified = null;
    ++previous.request; previous.controller?.abort(); editor = null; dialog.close(); input.value = ''; eol.value = ''; review.replaceChildren(); latest.replaceChildren(); confirmation.hidden = true; resume.hidden = true;
    const opener = previous.opener;
    if (opener?.isConnected && opener.getClientRects().length && !opener.closest('[inert]') && !opener.disabled) opener.focus({ preventScroll: true });
    else document.querySelector('#file-preview [data-action="edit-file"]:not(:disabled), .nav-item[data-action="workspace"]')?.focus({ preventScroll: true });
    // Keep a retained editor's original preview request identity until it closes.
    // A verified save followed by newer input must not invalidate its own preview.
    if (verified) Promise.resolve().then(() => onSaved(verified, previous.context)).catch(() => notify('文件内容已核对，列表暂未刷新。请手动刷新文件列表。', true));
  }
  function requestClose() {
    if (!editor) return;
    if (leaveLocked) return;
    if (editor.phase === 'saving') { message('正在保存，请等待结果。关闭页面不会撤销已发出的写入。'); return; }
    if (!pending()) { closeNow(); return; }
    discardNote.textContent = editor.uncertain ? '关闭会丢弃本页编辑。先前保存可能已执行，之后仍需核对文件。' : '文件修改尚未保存，是否放弃本页编辑？';
    confirmation.hidden = false; render(); controls['keep-editing'].focus({ preventScroll: true });
  }
  async function buildReview() {
    const value = editor; if (!value || leaveLocked || !['edit', 'saved'].includes(value.phase)) return;
    syncContext(); if (!authorized() || value.uncertain) { message('请先读取当前版本核对，再明确选择重新审阅。', true); return; }
    let content; try { content = encodeEditorText(value.original.content, input.value, eol.value ? { ending: eol.value } : {}); } catch (error) { message(error.message, true); return; }
    if (content === value.original.content) { message('内容与格式均未改变，没有需要保存的修改。'); return; }
    const sequence = ++value.request, revision = value.textRevision; value.phase = 'reviewing'; message('正在准备修改审阅…'); render();
    try {
      const [sha256, originalHash] = await Promise.all([hash(content), hash(value.original.content)]);
      if (editor !== value || value.request !== sequence || value.textRevision !== revision || !authorized(value)) return;
      if (originalHash !== value.original.sha256) { value.phase = 'invalid'; value.revoked = true; message('原文与读取的版本信息不一致，不能保存。请读取当前版本重新核对。', true); render(); return; }
      value.candidate = Object.freeze({ storageId: value.context.storageId, path: value.original.path, expectedHash: value.original.sha256, content, sha256, bytes: bytes(content).length, revision });
      review.replaceChildren(renderDiff(value.original.content, content), fullText('完整原文', value.original.content, 'before'), fullText('完整拟写入内容', content, 'after'));
      value.phase = 'review'; message('请核对修改。确认后将替换此文件；原版本变化时会拒绝写入。'); render(); controls.save.focus({ preventScroll: true });
    } catch { if (editor === value && value.request === sequence) { value.phase = 'edit'; message('无法准备修改审阅，编辑内容已保留。', true); render(); } }
  }
  function reportSaved(value, data, text) {
    const newerEdit = value.candidate && value.textRevision !== value.candidate.revision;
    if (value.postWriteFailure) text += ' 服务曾报告写入后的处理失败，核对内容不代表该后续错误已解决。';
    value.original = Object.freeze({ path: value.original.path, content: data.content, sha256: data.sha256 });
    value.lastVerified = value.original;
    value.uncertain = false; value.revoked = false; value.authorizedGeneration = getContext().generation; value.authorizedNavigation = getContext().navigation; value.phase = newerEdit ? 'edit' : 'saved'; value.candidate = null; value.latest = null; value.latestContext = null;
    if (!newerEdit) { input.value = inspectEditorText(data.content).text; eol.value = ''; }
    review.replaceChildren(); latest.replaceChildren(); formatText(); message(newerEdit ? '先前保存的内容已核对。较新的编辑仍未保存，请重新审阅。' : text); render();
    if (!newerEdit) { closeNow(); notify(text); }
  }
  async function save() {
    const value = editor; if (!value || leaveLocked || value.phase !== 'review' || !value.candidate) return;
    syncContext(); if (!authorized(value)) return;
    const candidate = value.candidate, context = { ...getContext() }, sequence = ++value.request;
    if (candidate.revision !== value.textRevision) { value.phase = 'edit'; value.candidate = null; message('编辑内容已变化，请重新审阅。', true); render(); return; }
    value.phase = 'saving'; value.controller = new AbortController(); message('正在保存。请勿重复提交；关闭页面不会撤销已发出的写入。'); render();
    try {
      const result = await request('/api/workspace/file', { method: 'PATCH', timeout: 40000, signal: value.controller.signal, body: { storageId: candidate.storageId, path: candidate.path, expectedHash: candidate.expectedHash, content: candidate.content } });
      if (!currentRead(value, sequence, context)) { if (editor === value && value.request === sequence) invalidate(); return; }
      if (result?.version !== 1 || result.storageId !== candidate.storageId || result.path !== candidate.path || result.sha256 !== candidate.sha256 || result.bytes !== candidate.bytes || typeof result.changed !== 'boolean' || (!result.changed && candidate.sha256 !== candidate.expectedHash)) throw new Error('保存结果尚未核对');
      reportSaved(value, { path: candidate.path, content: candidate.content, sha256: candidate.sha256 }, result.changed ? '文件已保存。已有任务中的文件快照保持不变。' : '文件内容已核对，与拟保存内容一致。');
    } catch (error) {
      if (editor !== value || value.request !== sequence) return;
      if (error.staleContext || !available(getContext(), value) || getContext().generation !== context.generation) { value.uncertain = true; invalidate(); return; }
      if (error.code === 'FILE_EDIT_WORKSPACE_CHANGED') { value.uncertain = false; invalidate('工作区存储身份已变化，已拒绝保存。编辑内容仍保留，请返回原工作区重新核对。'); return; }
      if (['FILE_CHANGED', 'WRITE_CONFLICT'].includes(error.code)) { value.phase = 'conflict'; message('文件已被其他操作更改，未覆盖当前版本。编辑内容已保留，请读取当前版本核对。', true); }
      else if (['POST_WRITE_AUDIT_FAILED', 'POST_WRITE_CLEANUP_FAILED'].includes(error.code)) { value.phase = 'post-write'; value.uncertain = true; value.postWriteFailure = true; message('文件写入已完成，但后续处理失败。请读取当前版本核对，不要重复保存。', true); }
      else if (!error.status || error.status >= 500) { value.phase = 'unknown'; value.uncertain = true; message('保存结果尚未确认，文件可能已写入。请读取当前版本核对；不会自动重试。', true); }
      else { value.phase = 'edit'; value.candidate = null; message(error.message || '此次保存未完成，编辑内容已保留。', true); }
      render();
    } finally { if (editor === value && value.request === sequence) value.controller = null; }
  }
  async function verify() {
    const value = editor; if (!value || busy() || !available(getContext(), value)) return;
    const sequence = ++value.request, context = { ...getContext() }; value.phase = 'reading'; value.controller = new AbortController(); message('正在读取当前磁盘版本；不会写入文件。'); render();
    try {
      const raw = await request('/api/workspace/file?path=' + encodeURIComponent(value.original.path), { signal: value.controller.signal });
      if (!currentRead(value, sequence, context)) { if (editor === value && value.request === sequence) invalidate(); return; }
      const data = completeFile(raw, value.original.path);
      if (await hash(data.content) !== data.sha256) throw new Error('文件内容与版本信息不一致，请重新读取。');
      if (!currentRead(value, sequence, context)) { if (editor === value && value.request === sequence) invalidate(); return; }
      if (value.candidate && data.sha256 === value.candidate.sha256 && data.content === value.candidate.content) { reportSaved(value, data, '当前文件与审阅内容完全一致。已核对内容，不会再次写入。'); return; }
      value.latest = data; value.latestContext = context; value.phase = 'conflict';
      latest.replaceChildren(fullText('查看当前磁盘内容', data.content, 'current'));
      message(data.sha256 === value.original.sha256 && data.content === value.original.content
        ? (value.uncertain ? '当前文件仍是原版本；这不能证明先前请求未执行。可继续核对，或明确以此版本重新审阅。' : '当前文件与原版本一致。编辑内容已保留，请明确以此版本重新审阅。')
        : '当前文件与编辑基线不同。你的修改未被替换；选择以当前版本重新审阅后，还须再次确认写入。', true);
      render();
    } catch (error) { if (editor === value && value.request === sequence) { value.phase = 'invalid'; value.revoked = true; message(error.staleContext ? '工作区连接已变化，编辑内容仍保留。请返回原工作区核对。' : error.message || '无法读取当前版本，编辑内容仍保留。', true); render(); } }
    finally { if (editor === value && value.request === sequence) value.controller = null; }
  }
  async function rebase() {
    const value = editor; if (!value || busy() || !value.latest || !available(getContext(), value) || value.latestContext?.generation !== getContext().generation) return;
    value.original = value.latest; value.latest = null; value.latestContext = null; value.candidate = null; value.revoked = false; value.uncertain = false; value.authorizedGeneration = getContext().generation; value.authorizedNavigation = getContext().navigation; value.phase = 'edit'; ++value.textRevision;
    review.replaceChildren(); latest.replaceChildren(); formatText(); message('已明确采用当前文件作为新基线，保留你的编辑内容和所选换行格式。请重新审阅全部差异。'); render(); focusInput(); await buildReview();
  }
  function edited() {
    if (!editor || busy() || editor.phase === 'review') return;
    ++editor.textRevision;
    if (!editor.uncertain && !editor.revoked && !['conflict', 'post-write', 'unknown'].includes(editor.phase)) { editor.phase = 'edit'; editor.candidate = null; message('修改尚未保存。请先审阅，再确认写入。'); }
    render();
  }
  input.addEventListener('input', edited); eol.addEventListener('change', edited);
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!event.isComposing && !event.repeat) void buildReview(); }
    if (event.key === 'Tab' && !event.isComposing) {
      const focusable = [...dialog.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex],[contenteditable="true"]')]
        .filter(node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length && !node.closest('[hidden],[inert]') && getComputedStyle(node).visibility === 'visible');
      const first = focusable[0], last = focusable.at(-1), current = document.activeElement;
      if (!first) { event.preventDefault(); return; }
      if ((event.shiftKey && (current === first || !focusable.includes(current))) || (!event.shiftKey && (current === last || !focusable.includes(current)))) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    }
  });
  dialog.addEventListener('click', event => {
    const node = event.target.closest('[data-file-editor-action]'); if (!node || node.disabled || leaveLocked) return;
    const action = node.dataset.fileEditorAction;
    if (action === 'close') requestClose();
    else if (action === 'keep-editing') { confirmation.hidden = true; render(); focusInput(); }
    else if (action === 'discard' && editor?.phase !== 'saving') closeNow();
    else if (action === 'park' && editor?.phase !== 'saving') { dialog.close(); confirmation.hidden = true; resume.hidden = false; resumeText.textContent = '文件编辑仍保留在本页：' + editor.original.path; resumeText.title = editor.original.path; resumeButton.focus({ preventScroll: true }); }
    else if (action === 'review') void buildReview();
    else if (action === 'save') void save();
    else if (action === 'verify') void verify();
    else if (action === 'rebase') void rebase();
    else if (action === 'back' && editor?.phase === 'review') { editor.phase = 'edit'; editor.candidate = null; render(); focusInput(); }
  });
  resumeButton.addEventListener('click', () => { if (!editor || leaveLocked) return; dialog.showModal(); confirmation.hidden = true; syncContext(); render(); focusInput(); });
  return {
    open(file, opener) {
      if (leaveLocked) throw new Error('正在离开当前工作区，操作结束后才能继续编辑。');
      if (editor) { if (!dialog.open) dialog.showModal(); confirmation.hidden = true; syncContext(); render(); notify('已重新打开此前保留的文件编辑。'); focusInput(); return; }
      const context = { ...getContext() }; if (!context.supported || !context.storageId || !context.connected || context.switching || context.suspended) throw new Error('当前工作台不支持文件编辑或连接尚未就绪，请更新后重连。');
      const original = completeFile(file, file?.path), info = inspectEditorText(original.content);
      editor = { context, authorizedGeneration: context.generation, authorizedNavigation: context.navigation, original, opener, phase: 'edit', revoked: false, uncertain: false, postWriteFailure: false, textRevision: 0, request: 0, controller: null, candidate: null, latest: null, latestContext: null, lastVerified: null };
      path.textContent = original.path; path.title = original.path; input.value = info.text; eol.value = ''; review.replaceChildren(); latest.replaceChildren(); confirmation.hidden = true; formatText(); message('修改尚未写入。审阅后才能确认保存。'); dialog.showModal(); render(); focusInput();
    },
    syncContext, invalidate,
    suspend() { invalidate('页面已离开，保存权限已撤销。编辑内容仍保留；返回并连接原工作区后，请读取当前版本核对。'); },
    hasPending: pending,
    hasUnconfirmedSave: () => Boolean(editor && (editor.uncertain || editor.phase === 'saving')),
    setLeaveLocked(value) { leaveLocked = value === true; render(); },
    isOpen: () => dialog.open,
  };
}
