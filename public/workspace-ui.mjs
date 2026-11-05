// SPDX-License-Identifier: Apache-2.0
const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Same controls on browser, desktop and mobile; every path belongs to the connected host. */
export function createWorkspaceUI({ api, beforeSwitch, reconnect, notify, getContext }) {
  const dialog = node('dialog', undefined, 'project-manager');
  dialog.setAttribute('aria-labelledby', 'project-manager-title');
  const heading = node('div', undefined, 'project-manager-heading'), title = node('h2', '项目', '');
  title.id = 'project-manager-title';
  const close = node('button', '关闭', 'text-button'); close.type = 'button';
  heading.append(title, close);
  const note = node('p', '这些目录位于运行 OpenAster 服务的主机上。手机或远程连接不会访问手机本地磁盘。', 'context-note');
  const current = node('code', '', 'project-current-path'), error = node('p', '', 'project-manager-error'); error.setAttribute('role', 'alert');
  const content = node('div'), status = node('p', '', 'project-manager-status'); status.setAttribute('role', 'status');
  dialog.append(heading, note, current, content, error, status); document.body.append(dialog);
  let state = null, listing = null, busy = false, revision = 0, opener, createMode = false;
  const rootSelect = node('select'); rootSelect.setAttribute('aria-label', '服务主机上的项目根目录');
  const buttons = [];
  const setBusy = value => { busy = value; close.disabled = value; for (const button of dialog.querySelectorAll('button,select,input')) button.disabled = value; };
  const fail = cause => { error.textContent = cause?.message || '项目操作未完成，请重试。'; };
  const action = (label, callback, className = 'button secondary') => {
    const button = node('button', label, className); button.type = 'button';
    button.addEventListener('click', () => { if (busy) return; error.textContent = ''; Promise.resolve().then(callback).catch(fail); });
    return button;
  };
  function finish() { if (!busy) { revision++; dialog.close(); opener?.focus?.(); } }
  close.addEventListener('click', finish);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else revision++; });
  async function browse(rootId, path = '') {
    const request = ++revision;
    setBusy(true); status.textContent = '正在读取主机目录…'; error.textContent = '';
    try {
      const result = await api('/api/projects/browse', { method: 'POST', body: { rootId, path } });
      if (request !== revision || !dialog.open) return;
      if (result.version !== 1 || !Array.isArray(result.directories)) throw new Error('目录列表格式无效。');
      listing = result; render(); status.textContent = result.truncated ? '当前目录项目较多，仅显示前一部分；可输入完整路径打开本机项目。' : '';
    } finally { if (request === revision) setBusy(false); }
  }
  async function activate(body) {
    setBusy(true); error.textContent = ''; status.textContent = '正在检查项目…';
    try {
      await beforeSwitch();
      const prepared = await api('/api/projects/prepare', { method: 'POST', body });
      if (prepared.alreadyActive) { status.textContent = '此项目已经打开。'; return; }
      const accepted = await api('/api/projects/activate', { method: 'POST', body: { ticket: prepared.ticket } });
      status.textContent = '正在打开项目，任务和模型连接按项目独立保存…';
      for (let attempt = 0; attempt < 20; attempt++) {
        await wait(attempt < 3 ? 400 : 1000);
        if (attempt === 1 || attempt === 5 || attempt === 12) await reconnect();
        let operation;
        try { operation = (await api(`/api/projects/operations/${encodeURIComponent(accepted.operationId)}`, { timeout: 3000 })).operation; }
        catch (cause) {
          if (cause.status === 404 && getContext().path === prepared.path) { operation = { status: 'completed' }; }
          else if (cause.status === 401 || cause.status === 503 || !cause.status || cause.staleContext) continue;
          else throw cause;
        }
        if (operation?.status === 'failed') throw new Error(operation.error?.message || '项目未能打开，当前项目保持不变。');
        if (operation?.status === 'completed') {
          await reconnect(); setBusy(false); dialog.close(); notify('已打开项目：' + prepared.name); return;
        }
      }
      throw new Error('项目切换尚未确认。请重新连接后核对当前位置，不要重复新建同名项目。');
    } finally { setBusy(false); }
  }
  function render() {
    content.replaceChildren(); buttons.length = 0;
    current.textContent = '当前项目：' + state.current.path;
    const recent = node('div', undefined, 'project-recents'); recent.append(node('h3', '最近项目'));
    for (const project of state.projects) {
      const button = action(project.name + (project.id === state.current.id ? ' · 当前' : ''), () => activate({ action: 'switch', id: project.id }), 'project-recent');
      button.title = project.path; button.append(node('small', project.path)); recent.append(button);
    }
    content.append(recent);
    const browser = node('section', undefined, 'project-browser'); browser.append(node('h3', createMode ? '新建项目文件夹' : '选择主机上的文件夹'));
    rootSelect.replaceChildren();
    for (const root of state.roots) { const option = node('option', root.name); option.value = root.id; rootSelect.append(option); }
    rootSelect.value = listing?.rootId || 'projects'; browser.append(rootSelect);
    if (listing) {
      browser.append(node('code', listing.hostPath, 'project-browser-path'));
      const toolbar = node('div', undefined, 'project-manager-toolbar');
      if (listing.path) toolbar.append(action('上一级', () => browse(listing.rootId, listing.path.split('/').slice(0, -1).join('/')), 'text-button'));
      toolbar.append(action('刷新', () => browse(listing.rootId, listing.path), 'text-button'));
      if (!createMode && listing.exists) toolbar.append(action('打开此文件夹', () => activate({ action: 'open', rootId: listing.rootId, path: listing.path }), 'button primary'));
      browser.append(toolbar);
      const directories = node('div', undefined, 'project-directory-list');
      for (const directory of listing.directories) directories.append(action('▸ ' + directory.name, () => browse(listing.rootId, directory.path), 'project-directory'));
      if (!listing.directories.length) directories.append(node('p', listing.exists ? '此处没有可浏览的子目录。' : '首次新建项目时会创建这个项目目录。', 'context-note'));
      browser.append(directories);
      const form = node('form', undefined, 'project-create-form'), label = node('label', '新项目名称'), name = node('input');
      name.name = 'projectName'; name.maxLength = 100; name.required = true; name.autocomplete = 'off'; name.placeholder = '例如：我的项目';
      label.append(name); form.append(label);
      const submit = node('button', '新建并打开', 'button primary'); submit.type = 'submit'; form.append(submit);
      form.addEventListener('submit', event => { event.preventDefault(); if (!busy) void activate({ action: 'create', rootId: listing.rootId, path: listing.path, name: name.value }).catch(fail); });
      browser.append(form);
    }
    content.append(browser);
    if (state.allowAbsolutePath) {
      const form = node('form', undefined, 'project-absolute-form'), label = node('label', '或输入本机已有项目的完整路径'), input = node('input');
      input.name = 'absolutePath'; input.required = true; input.maxLength = 4096; input.autocomplete = 'off'; input.placeholder = '服务主机上的绝对目录路径'; label.append(input);
      const submit = node('button', '打开路径', 'button secondary'); submit.type = 'submit'; form.append(label, submit);
      form.addEventListener('submit', event => { event.preventDefault(); if (!busy) void activate({ action: 'open', absolutePath: input.value }).catch(fail); });
      content.append(form);
    }
  }
  rootSelect.addEventListener('change', () => void browse(rootSelect.value).catch(fail));
  return {
    async open({ create = false } = {}) {
      if (busy) return;
      opener = document.activeElement; createMode = create; title.textContent = create ? '新建项目' : '打开或切换项目';
      error.textContent = ''; status.textContent = '正在读取项目…'; content.replaceChildren(); current.textContent = getContext().path || '';
      if (!dialog.open) dialog.showModal();
      const request = ++revision; setBusy(true);
      try {
        const result = await api('/api/projects');
        if (request !== revision || !dialog.open) return;
        if (result.version !== 1 || !Array.isArray(result.projects) || !Array.isArray(result.roots)) throw new Error('项目列表格式无效。');
        state = result; listing = null; render(); setBusy(false); await browse('projects');
      } catch (cause) { fail(cause); } finally { setBusy(false); }
    },
  };
}
