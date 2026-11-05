// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceNavigation } from './workspace-navigation.mjs';

const entry = index => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  kind: index % 2 ? 'external' : 'restored', label: `Project ${index}`, workspace: `/owned/project-${index}` });
const defaultEntry = { id: 'default', kind: 'default', label: '默认工作区', workspace: '/owned/default' };
const leaves = menu => menu.submenu.flatMap(item => item.submenu ? leaves(item) : [item]);
const ids = menu => leaves(menu).map(item => item.id.slice('workspace-all-'.length));

test('empty and default-only registries do not invent selectable non-default workspaces', () => {
  for (const entries of [[], [defaultEntry]]) {
    const navigation = createWorkspaceNavigation({ entries, activeId: 'default', onSelect: () => assert.fail('no selection') });
    assert.equal(navigation.all.id, 'workspace-all'); assert.equal(navigation.all.label, '全部工作区（0）');
    assert.equal(navigation.all.enabled, false); assert.equal(navigation.recent.enabled, false);
    assert.deepEqual(leaves(navigation.all), []); assert.deepEqual(leaves(navigation.recent), []);
  }
});

for (const count of [20, 21, 100]) test(`${count} registered workspaces remain reachable once each, with bounded pages and unchanged recent order`, () => {
  const profiles = Array.from({ length: count }, (_, index) => Object.freeze(entry(count - index)));
  const entries = Object.freeze([defaultEntry, ...profiles]), before = JSON.stringify(entries), selected = [];
  const navigation = createWorkspaceNavigation({ entries, activeId: profiles[0].id, onSelect: id => selected.push(id) });
  const all = leaves(navigation.all), recent = leaves(navigation.recent);
  assert.equal(navigation.all.label, `全部工作区（${count}）`);
  assert.equal(all.length, count); assert.equal(new Set(all.map(item => item.id)).size, count);
  assert.deepEqual(new Set(ids(navigation.all)), new Set(profiles.map(item => item.id)));
  assert.equal(recent.length, 20);
  assert.deepEqual(recent.map(item => item.id), profiles.slice(0, 20).map(item => `workspace-recent-${item.id}`));
  assert.deepEqual(recent.map(item => item.label), profiles.slice(0, 20).map(item => item.workspace));
  if (count === 20) assert.ok(navigation.all.submenu.every(item => !item.submenu));
  else {
    assert.equal(navigation.all.submenu.length, Math.ceil(count / 20));
    assert.ok(navigation.all.submenu.every(group => group.submenu.length > 0 && group.submenu.length <= 20));
    assert.ok(navigation.all.submenu.every(group => group.submenu.every(item => !item.submenu)));
  }
  const active = all.filter(item => item.checked);
  assert.equal(active.length, 1); assert.equal(active[0].id, `workspace-all-${profiles[0].id}`); assert.equal(active[0].enabled, false);
  for (const item of all) { assert.equal(item.type, 'checkbox'); if (item.enabled) item.click(); }
  assert.deepEqual(new Set(selected), new Set(profiles.slice(1).map(item => item.id)));
  assert.equal(JSON.stringify(entries), before, 'Building a menu must not reorder or mutate registered metadata');
});

test('all-workspace ordering is independent of recency, disambiguates identical names and escapes menu mnemonics', () => {
  const a = { ...entry(1), label: 'Project 2', workspace: '/owned/A&B' };
  const b = { ...entry(2), label: 'Project 2', workspace: '/owned/A&B' };
  const c = { ...entry(3), label: 'Project 2', workspace: '/owned/Z' };
  const d = { ...entry(4), label: 'Project 10', workspace: '/owned/early' };
  const options = { activeId: 'default', onSelect: () => {} };
  const first = createWorkspaceNavigation({ ...options, entries: [d, c, b, a] });
  const second = createWorkspaceNavigation({ ...options, entries: [b, a, d, c] });
  assert.deepEqual(ids(first.all), [a.id, b.id, c.id, d.id]);
  assert.deepEqual(ids(first.all), ids(second.all));
  assert.equal(leaves(first.all)[0].label, 'Project 2 — /owned/A&&B');
  assert.equal(leaves(first.all)[1].label, 'Project 2 — /owned/A&&B');
  assert.equal(leaves(first.recent)[0].label, d.workspace);
  const special = { ...entry(5), label: 'R&D', workspace: '/owned/X&Y' }, selected = [];
  const menu = createWorkspaceNavigation({ entries: [special], activeId: 'default', onSelect: id => selected.push(id) });
  assert.equal(menu.all.submenu[0].label, 'R&&D — /owned/X&&Y');
  const originalId = special.id; special.id = entry(6).id; special.workspace = '/changed';
  menu.all.submenu[0].click(); menu.recent.submenu[0].click();
  assert.deepEqual(selected, [originalId, originalId], 'Clicking an existing menu selects its original ID, not a mutated display object');
});

test('untrusted duplicate IDs and entries beyond the registry capacity are refused rather than silently dropped', () => {
  const options = { activeId: 'default', onSelect: () => {} };
  assert.throws(() => createWorkspaceNavigation({ ...options, entries: [entry(1), { ...entry(2), id: entry(1).id }] }), TypeError);
  assert.throws(() => createWorkspaceNavigation({ ...options, entries: Array.from({ length: 101 }, (_, index) => entry(index)) }), TypeError);
});
