let paletteSequence = 0;

const SVG_NS = 'http://www.w3.org/2000/svg';
const iconPaths = {
  search: ['M21 21l-4.6-4.6', 'M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0'],
  plus: ['M12 5v14', 'M5 12h14'],
  home: ['M3 10l9-7 9 7', 'M5 9v11h14V9', 'M9 20v-7h6v7'],
  folder: ['M3 6h7l2 3h9v11H3z'],
  message: ['M21 4H3v13h5l4 4v-4h9z'],
  sparkles: ['M12 3l2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6z'],
  shield: ['M12 3l8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6z', 'M8 12l3 3 5-6'],
  file: ['M5 3h9l5 5v13H5z', 'M14 3v6h5', 'M9 13h6', 'M9 17h6'],
  moon: ['M20.5 13.5A9 9 0 0 1 10.5 3.5a9 9 0 1 0 10 10'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 17v4h16v-4'],
  arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const paths = Object.hasOwn(iconPaths, name) ? iconPaths[name] : iconPaths.arrow;
  for (const path of paths) {
    const node = document.createElementNS(SVG_NS, 'path');
    node.setAttribute('d', path);
    svg.append(node);
  }
  return svg;
}

function searchable(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase();
}

/**
 * Mount an accessible command palette. Entries are read afresh whenever it opens.
 * onSelect owns action execution and error reporting; it runs after the dialog closes.
 * Optional lifecycle hooks run synchronously and own any asynchronous work they start.
 */
export function createCommandPalette({ getEntries, onSelect, onOpen, onClose, getStatus }) {
  if (typeof getEntries !== 'function' || typeof onSelect !== 'function'
    || (onOpen !== undefined && typeof onOpen !== 'function')
    || (onClose !== undefined && typeof onClose !== 'function')
    || (getStatus !== undefined && typeof getStatus !== 'function')) {
    throw new TypeError('Command palette requires getEntries and onSelect functions.');
  }

  const prefix = `command-palette-${++paletteSequence}`;
  const dialog = element('dialog', 'command-palette');
  dialog.id = prefix;
  dialog.setAttribute('aria-labelledby', `${prefix}-title`);

  const title = element('h2', 'command-palette__sr-only', '命令面板');
  title.id = `${prefix}-title`;
  const header = element('div', 'command-palette__header');
  const searchIcon = element('span', 'command-palette__search-icon');
  searchIcon.append(icon('search'));
  const input = element('input', 'command-palette__input');
  // A text combobox lets Escape reach the native dialog; type=search consumes
  // the first Escape to clear its value instead of dismissing the palette.
  input.type = 'text';
  input.placeholder = '搜索操作、页面或任务…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-label', '搜索命令');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-controls', `${prefix}-results`);
  input.setAttribute('aria-expanded', 'false');
  const dismiss = element('button', 'command-palette__dismiss');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', '关闭命令面板 Esc');
  dismiss.append(element('kbd', '', 'Esc'));
  header.append(searchIcon, input, dismiss);

  const results = element('div', 'command-palette__results');
  results.id = `${prefix}-results`;
  results.setAttribute('role', 'listbox');
  results.setAttribute('aria-label', '可用命令');
  const empty = element('div', 'command-palette__empty');
  empty.hidden = true;
  const emptyIcon = element('span', 'command-palette__empty-icon');
  emptyIcon.append(icon('search'));
  const emptyTitle = element('strong', '', '没有找到匹配的命令');
  const emptyHint = element('p', '', '试试其他关键词，或清空搜索查看全部操作。');
  empty.append(emptyIcon, emptyTitle, emptyHint);

  const footer = element('div', 'command-palette__footer');
  const hints = element('div', 'command-palette__hints');
  const navigateHint = element('span', 'command-palette__hint');
  navigateHint.append(element('kbd', '', '↑'), element('kbd', '', '↓'), element('span', '', '选择'));
  const executeHint = element('span', 'command-palette__hint');
  executeHint.append(element('kbd', '', '↵'), element('span', '', '执行'));
  hints.append(navigateHint, executeHint);
  const status = element('span', 'command-palette__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  footer.append(hints, status);
  dialog.append(title, header, results, empty, footer);
  document.body.append(dialog);

  let entries = [];
  let visibleEntries = [];
  let options = [];
  let selectedIndex = -1;
  let composing = false;
  let compositionEndedAt = -Infinity;
  let pendingRefresh = false;
  let openCycle = 0;
  let closedCycle = 0;

  function renderStatus() {
    const current = getStatus?.();
    const message = typeof current?.message === 'string' ? current.message : '';
    const emptyMessage = typeof current?.emptyMessage === 'string' ? current.emptyMessage : '';
    results.setAttribute('aria-busy', String(current?.busy === true));
    const count = options.length ? `${options.length} 个可用命令` : '没有匹配的命令';
    status.textContent = message ? `${options.length} 个可用命令 · ${message}` : count;
    emptyTitle.textContent = emptyMessage || '没有找到匹配的命令';
    emptyHint.hidden = Boolean(emptyMessage);
  }

  function select(index, scroll = false) {
    if (!options.length) {
      selectedIndex = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    if (selectedIndex >= 0) options[selectedIndex]?.setAttribute('aria-selected', 'false');
    selectedIndex = (index + options.length) % options.length;
    const option = options[selectedIndex];
    option.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', option.id);
    if (scroll) option.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }

  function notifyClosed() {
    if (dialog.open || openCycle === closedCycle) return;
    closedCycle = openCycle;
    pendingRefresh = false;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    onClose?.();
  }

  function close() {
    if (!dialog.open) { notifyClosed(); return false; }
    dialog.close();
    notifyClosed();
    return true;
  }

  function execute(index) {
    const entry = visibleEntries[index];
    if (!entry || !dialog.open || composing) return;
    close();
    onSelect(entry);
  }

  function render({ preserve = false } = {}) {
    const previousId = preserve ? visibleEntries[selectedIndex]?.id : undefined;
    const previousIndex = selectedIndex;
    const previousScroll = results.scrollTop;
    const terms = searchable(input.value).trim().split(/\s+/u).filter(Boolean);
    const grouped = new Map();
    for (const entry of entries) {
      const text = searchable(`${entry.label ?? ''} ${entry.description ?? ''} ${entry.group ?? ''}`);
      if (!terms.every(term => text.includes(term))) continue;
      const group = String(entry.group || '操作');
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push(entry);
    }

    visibleEntries = [];
    options = [];
    selectedIndex = -1;
    input.removeAttribute('aria-activedescendant');
    const fragment = document.createDocumentFragment();
    let groupIndex = 0;
    for (const [name, items] of grouped) {
      const group = element('div', 'command-palette__group');
      group.setAttribute('role', 'group');
      const heading = element('div', 'command-palette__group-label', name);
      heading.id = `${prefix}-group-${groupIndex++}`;
      group.setAttribute('aria-labelledby', heading.id);
      group.append(heading);
      for (const entry of items) {
        const index = visibleEntries.length;
        const option = element('div', 'command-palette__option');
        option.id = `${prefix}-option-${index}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        const symbol = element('span', 'command-palette__option-icon');
        symbol.append(icon(typeof entry.icon === 'string' ? entry.icon : 'arrow'));
        const copy = element('span', 'command-palette__copy');
        const label = element('span', 'command-palette__label', String(entry.label ?? ''));
        label.id = `${option.id}-label`;
        option.setAttribute('aria-labelledby', label.id);
        copy.append(label);
        if (entry.description) {
          const description = element('span', 'command-palette__description', String(entry.description));
          description.id = `${option.id}-description`;
          option.setAttribute('aria-labelledby', `${label.id} ${description.id}`);
          copy.append(description);
        }
        option.append(symbol, copy);
        if (entry.shortcut) {
          const shortcut = element('kbd', 'command-palette__shortcut', String(entry.shortcut));
          shortcut.id = `${option.id}-shortcut`;
          option.setAttribute('aria-labelledby', `${option.getAttribute('aria-labelledby')} ${shortcut.id}`);
          option.append(shortcut);
        }
        const enter = element('span', 'command-palette__enter', '↵');
        enter.setAttribute('aria-hidden', 'true');
        option.append(enter);
        option.addEventListener('pointermove', event => {
          if (event.pointerType !== 'touch' && selectedIndex !== index) select(index);
        });
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('click', () => execute(index));
        options.push(option);
        visibleEntries.push(entry);
        group.append(option);
      }
      fragment.append(group);
    }
    results.replaceChildren(fragment);
    results.scrollTop = preserve ? previousScroll : 0;
    results.hidden = options.length === 0;
    input.setAttribute('aria-expanded', String(dialog.open && options.length > 0));
    empty.hidden = options.length > 0;
    renderStatus();
    const preservedIndex = previousId === undefined ? -1 : visibleEntries.findIndex(entry => entry.id === previousId);
    select(preserve ? (preservedIndex >= 0 ? preservedIndex : Math.max(0, Math.min(previousIndex, options.length - 1))) : 0);
    if (preserve && options[selectedIndex]) {
      const viewport = results.getBoundingClientRect(), selected = options[selectedIndex].getBoundingClientRect();
      if (selected.top < viewport.top) results.scrollTop += selected.top - viewport.top;
      else if (selected.bottom > viewport.bottom) results.scrollTop += selected.bottom - viewport.bottom;
    }
  }

  function refresh() {
    if (!dialog.open) return false;
    if (composing) { pendingRefresh = true; renderStatus(); return false; }
    pendingRefresh = false;
    const nextEntries = getEntries();
    entries = Array.isArray(nextEntries) ? nextEntries.filter(entry => entry && typeof entry === 'object') : [];
    render({ preserve: true });
    return true;
  }

  function hasOtherDialog() {
    return [...document.querySelectorAll('dialog[open]')].some(node => node !== dialog);
  }

  function open() {
    if (hasOtherDialog() || composing) return false;
    if (dialog.open) {
      input.focus({ preventScroll: true });
      return false;
    }
    // Native close events are queued. Settle an earlier closed cycle before a
    // new open; its eventual event must never reset the new dialog's state.
    notifyClosed();
    if (dialog.open || hasOtherDialog() || composing) return false;
    const nextEntries = getEntries();
    entries = Array.isArray(nextEntries) ? nextEntries.filter(entry => entry && typeof entry === 'object') : [];
    input.value = '';
    render();
    dialog.showModal();
    ++openCycle;
    input.setAttribute('aria-expanded', String(options.length > 0));
    input.focus({ preventScroll: true });
    onOpen?.();
    if (dialog.open) renderStatus();
    return true;
  }

  input.addEventListener('input', () => render());
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || composing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      select(selectedIndex + (event.key === 'ArrowDown' ? 1 : -1), true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (performance.now() - compositionEndedAt > 60) execute(selectedIndex);
    }
  });
  dismiss.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!composing) close();
  });
  dialog.addEventListener('close', notifyClosed);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });

  document.addEventListener('compositionstart', () => { composing = true; });
  document.addEventListener('compositionend', () => {
    composing = false;
    compositionEndedAt = performance.now();
    if (pendingRefresh && dialog.open) refresh();
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing || event.repeat) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLocaleLowerCase() !== 'p') return;
    if (hasOtherDialog()) return;
    event.preventDefault();
    open();
  });

  return { open, close, refresh, isOpen: () => dialog.open };
}
