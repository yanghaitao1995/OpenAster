// SPDX-License-Identifier: Apache-2.0

const PAGE_SIZE = 20;
const PROFILE_LIMIT = 100;
const menuLabel = value => value.replaceAll('&', '&&');
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'variant' });
const compare = (a, b) => collator.compare(a.label, b.label)
  || collator.compare(a.workspace, b.workspace)
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Build native menu templates from registered metadata, without filesystem I/O.
 * Selection captures the original ID; the existing action owns revalidation. */
export function createWorkspaceNavigation({ entries, activeId, onSelect }) {
  if (!Array.isArray(entries) || typeof activeId !== 'string' || typeof onSelect !== 'function') throw new TypeError('Invalid workspace navigation options');
  const profiles = entries.filter(entry => entry.kind !== 'default');
  if (profiles.length > PROFILE_LIMIT || new Set(profiles.map(entry => entry.id)).size !== profiles.length
    || profiles.some(entry => typeof entry.id !== 'string' || !entry.id || typeof entry.label !== 'string' || typeof entry.workspace !== 'string')) {
    throw new TypeError('Invalid registered workspace entries');
  }
  function leaf(entry, recent) {
    const { id, label, workspace } = entry;
    return {
      id: `${recent ? 'workspace-recent-' : 'workspace-all-'}${id}`,
      label: menuLabel(recent ? workspace : `${label} — ${workspace}`),
      type: 'checkbox', checked: id === activeId, enabled: id !== activeId,
      click: () => onSelect(id),
    };
  }
  const sorted = [...profiles].sort(compare);
  const allItems = sorted.map(entry => leaf(entry, false));
  const all = allItems.length <= PAGE_SIZE ? allItems : [];
  if (allItems.length > PAGE_SIZE) {
    for (let offset = 0; offset < allItems.length; offset += PAGE_SIZE) {
      all.push({ label: `第 ${offset + 1}–${Math.min(offset + PAGE_SIZE, allItems.length)} 项`,
        submenu: allItems.slice(offset, offset + PAGE_SIZE) });
    }
  }
  return {
    recent: { id: 'workspace-recent', label: '最近的工作区', enabled: profiles.length > 0,
      submenu: profiles.slice(0, PAGE_SIZE).map(entry => leaf(entry, true)) },
    all: { id: 'workspace-all', label: `全部工作区（${profiles.length}）`, enabled: profiles.length > 0, submenu: all },
  };
}
