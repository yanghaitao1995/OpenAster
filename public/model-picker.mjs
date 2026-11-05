// SPDX-License-Identifier: Apache-2.0
// The native select remains the single source of truth for drafts and sessions.
export function createModelPicker({ select, trigger, popup, label, readProviders }) {
  let signature = '', options = [], search = '', searchedAt = 0;
  const node = (tag, className, text) => { const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const opened = () => popup.matches(':popover-open');
  function close(restoreFocus = false) {
    if (opened()) popup.hidePopover();
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !trigger.disabled) trigger.focus({ preventScroll: true });
  }
  function position() {
    const rect = trigger.getBoundingClientRect(), margin = 12;
    const width = Math.min(340, innerWidth - margin * 2);
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${Math.max(120, Math.min(420, innerHeight - margin * 2))}px`;
    const height = popup.getBoundingClientRect().height;
    popup.style.left = `${Math.max(margin, Math.min(rect.left, innerWidth - width - margin))}px`;
    popup.style.top = `${Math.max(margin, rect.top >= height + margin ? rect.top - height - 8 : Math.min(rect.bottom + 8, innerHeight - height - margin))}px`;
  }
  function focusOption(index) {
    const option = options[Math.max(0, Math.min(index, options.length - 1))];
    option?.focus({ preventScroll: true }); option?.scrollIntoView({ block: 'nearest' });
  }
  function open(last = false) {
    if (trigger.disabled) return;
    sync(); popup.showPopover(); trigger.setAttribute('aria-expanded', 'true'); position();
    const selected = options.findIndex(option => option.dataset.value === select.value);
    focusOption(selected >= 0 ? selected : last ? options.length - 1 : 0);
  }
  function sync() {
    trigger.disabled = select.disabled;
    const selected = select.selectedOptions[0];
    label.textContent = selected?.textContent || '选择模型';
    trigger.setAttribute('aria-label', `选择模型：${label.textContent}`);
    trigger.title = label.textContent;
    if (trigger.disabled) close();
    const providers = readProviders();
    const next = JSON.stringify([...select.options].map(option => {
      const provider = providers.find(item => item.id === option.value);
      return [option.value, option.textContent, option.disabled, option.selected, provider?.model, provider?.type, provider?.toolMode];
    }));
    if (next === signature) return;
    signature = next;
    const focused = popup.contains(document.activeElement) ? document.activeElement.dataset.value : null;
    const heading = node('div', 'model-picker-heading', '选择模型'); heading.setAttribute('aria-hidden', 'true');
    popup.replaceChildren(heading); options = [];
    for (const option of select.options) {
      const provider = providers.find(item => item.id === option.value);
      const item = node('button', 'model-picker-option'); item.type = 'button'; item.tabIndex = -1;
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(option.selected));
      item.setAttribute('aria-disabled', String(option.disabled || !option.value)); item.dataset.value = option.value;
      const text = node('span', 'model-picker-copy');
      text.append(node('strong', '', provider?.name || option.textContent));
      text.append(node('small', '', provider?.type === 'demo' ? '本机演示 · 不调用模型服务' : provider?.model || '请在设置中配置模型连接'));
      const badge = node('span', 'model-picker-capability', provider ? provider.type === 'demo' ? '本地' : provider.toolMode === 'none' ? '对话' : '工具' : '');
      const check = node('span', 'model-picker-check', option.selected ? '✓' : ''); check.setAttribute('aria-hidden', 'true');
      item.append(text, badge, check); popup.append(item);
      if (!option.disabled && option.value) options.push(item);
      item.addEventListener('click', () => {
        if (select.disabled || option.disabled || !option.value || ![...select.options].some(current => current.value === option.value && !current.disabled)) return;
        select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); sync(); close(true);
      });
    }
    if (opened()) {
      position();
      if (focused !== null) (options.find(item => item.dataset.value === focused) || options[0] || popup).focus({ preventScroll: true });
    }
  }
  trigger.addEventListener('click', () => opened() ? close(true) : open());
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); open(event.key === 'ArrowUp');
  });
  popup.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const index = options.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(true);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      focusOption(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      event.preventDefault(); const time = Date.now(); search = time - searchedAt > 800 ? event.key : search + event.key; searchedAt = time;
      const match = options.findIndex(item => item.textContent.toLocaleLowerCase().startsWith(search.toLocaleLowerCase())); if (match >= 0) focusOption(match);
    }
  });
  popup.addEventListener('toggle', () => { trigger.setAttribute('aria-expanded', String(opened())); });
  window.addEventListener('resize', () => close());
  window.addEventListener('pagehide', () => close());
  document.addEventListener('focusin', event => { if (opened() && !popup.contains(event.target) && event.target !== trigger) close(); });
  return { sync, close };
}
