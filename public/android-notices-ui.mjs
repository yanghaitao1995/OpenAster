const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');

function validInventory(value) {
  if (value?.schemaVersion !== 1 || value.platform !== 'android' || !nonempty(value.summary) ||
      !nonempty(value.scope?.description) || !strings(value.scope.limitations) || !strings(value.coverageGaps) ||
      !Array.isArray(value.licenses) || !value.licenses.length || !Array.isArray(value.components) || !value.components.length) return false;
  const ids = new Set();
  for (const license of value.licenses) {
    if (!nonempty(license?.id) || ids.has(license.id) || !nonempty(license.name) || !nonempty(license.text)) return false;
    ids.add(license.id);
  }
  return value.components.every(component => nonempty(component?.name) && nonempty(component.version) &&
    strings(component.licenseIds) && component.licenseIds.length > 0 && component.licenseIds.every(id => ids.has(id)) &&
    nonempty(component.noticeStatus) && Array.isArray(component.notices) &&
    component.notices.every(notice => nonempty(notice?.name) && nonempty(notice.text)));
}

// This viewer reads a fixed packaged asset. It never uses the gateway API,
// credentials, source URLs, HTML parsing, or native navigation plugins.
export function createAndroidNoticesUI({
  openDialog,
  document = globalThis.document,
  capacitor = globalThis.Capacitor,
  userAgent = globalThis.navigator?.userAgent || '',
  fetch = globalThis.fetch.bind(globalThis),
} = {}) {
  const entry = document.getElementById('android-notices-entry');
  const trigger = document.getElementById('android-notices-button');
  const dialog = document.getElementById('app-dialog');
  let enabled = false;
  try { enabled = !/\bElectron\//.test(userAgent) && capacitor?.isNativePlatform?.() === true && capacitor?.getPlatform?.() === 'android'; } catch {}
  entry.classList.toggle('hidden', !enabled);
  let request = 0, controller = null, content = null;

  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const details = title => {
    const node = element('details');
    node.append(element('summary', title));
    return node;
  };
  const paragraph = text => element('p', text, 'dialog-description');
  const fullText = (text, label) => {
    const node = element('pre', text, 'android-notices-text');
    node.tabIndex = 0;
    node.setAttribute('role', 'region');
    node.setAttribute('aria-label', label);
    return node;
  };
  const sourceText = source => [source?.path, source?.entry, source?.url].filter(nonempty).join(' · ');
  const appendSources = (parent, sources) => {
    const labels = Array.isArray(sources) ? sources.map(sourceText).filter(nonempty) : [];
    if (!labels.length) return;
    const list = details('收录来源');
    for (const label of labels) list.append(paragraph(label));
    parent.append(list);
  };

  function render(inventory) {
    const nodes = [paragraph(inventory.summary), paragraph('仅展示随此应用收录的声明；来源范围和已知缺口见下方。')];
    const scope = details('来源范围与已知缺口');
    scope.append(paragraph(inventory.scope.description));
    for (const text of [...inventory.scope.limitations, ...inventory.coverageGaps]) scope.append(paragraph(text));
    for (const project of inventory.generatedProjects || []) {
      if (nonempty(project?.name) && nonempty(project.description)) scope.append(paragraph(`${project.name}：${project.description}`));
    }
    nodes.push(scope, element('h3', '许可全文'));
    for (const license of inventory.licenses) {
      const item = details(`${license.id} · ${license.name}`);
      item.className = 'android-notices-license';
      item.append(fullText(license.text, `${license.id} 完整许可文本`));
      appendSources(item, license.sources);
      nodes.push(item);
    }
    nodes.push(element('h3', `已收录组件（${inventory.components.length}）`));
    for (const component of inventory.components) {
      const item = details(`${component.name} · ${component.version}`);
      item.className = 'android-notices-component';
      item.append(paragraph(`许可声明：${component.licenseIds.join('、')}；全文见上方。`), paragraph(component.noticeStatus));
      for (const notice of component.notices) {
        const record = details(notice.name);
        record.append(fullText(notice.text, `${component.name} · ${notice.name}`));
        appendSources(record, notice.source ? [notice.source] : []);
        item.append(record);
      }
      nodes.push(item);
    }
    return nodes;
  }

  dialog.addEventListener('close', () => {
    if (dialog.open || !content?.isConnected) return;
    ++request;
    controller?.abort();
    controller = null;
    content = null;
    if (trigger.isConnected && trigger.getClientRects().length && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true });
  });

  return {
    async open() {
      if (!enabled) return;
      controller?.abort();
      controller = new AbortController();
      const current = ++request, signal = controller.signal;
      content = element('div', undefined, 'android-notices');
      const target = content;
      const status = paragraph('正在读取随应用收录的开源许可…');
      status.setAttribute('role', 'status');
      target.append(status);
      openDialog('Android 开源许可', target, '关闭', async () => {});
      dialog.querySelector('.dialog-actions [data-action="close-dialog"]').classList.add('hidden');
      try {
        const response = await fetch(new URL('./android-notices.json', import.meta.url), {
          credentials: 'omit', mode: 'same-origin', redirect: 'error', signal,
        });
        if (!response.ok) throw new Error('Packaged notices are unavailable');
        const inventory = await response.json();
        if (!validInventory(inventory)) throw new Error('Unsupported packaged notices');
        if (current !== request || !dialog.open || !target.isConnected) return;
        target.replaceChildren(...render(inventory));
      } catch {
        if (current !== request || !dialog.open || !target.isConnected) return;
        status.textContent = '无法读取随应用打包的开源许可文件。文件可能缺失、损坏或版本不受支持；这不表示应用没有使用开源组件。请关闭后重试，或更新、重新安装应用。';
        status.setAttribute('role', 'alert');
      }
    },
  };
}
