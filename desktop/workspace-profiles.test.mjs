// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createWorkspaceProfiles } from './workspace-profiles.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { Store } from '../server/store.mjs';

async function fixture(t) {
  const temporaryRoot = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'openaster-profiles-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), temporaryRoot); await fs.rm(root, { recursive: true, force: true }); });
  const userData = path.join(root, 'user-data'), homeDirectory = path.join(root, 'home'), install = path.join(root, 'install');
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  for (const directory of [userData, homeDirectory, install, first, second]) await fs.mkdir(directory);
  const options = { userData, homeDirectory, appRoots: [install] };
  const registry = path.join(userData, 'workspaces.json');
  return { root, userData, homeDirectory, install, first, second, options, registry, manager: createWorkspaceProfiles(options) };
}
const missing = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = (file, value) => fs.writeFile(file, JSON.stringify(value));

test('default profile retains legacy data and initialize does not create or move its workspace', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.userData, 'existing-data'), 'legacy');
  assert.deepEqual(await f.manager.initialize(), [{ id: 'default', kind: 'default', label: '默认工作区', workspace: path.join(f.userData, 'workspace'), dataDir: f.userData, secretsDir: path.join(f.userData, 'secrets') }]);
  assert.equal((await f.manager.getActive()).id, 'default');
  await missing(path.join(f.userData, 'workspace')); await missing(path.join(f.userData, 'profiles'));
  assert.equal(await fs.readFile(path.join(f.userData, 'existing-data'), 'utf8'), 'legacy');
  assert.equal((await fs.lstat(f.registry)).nlink, 1);
  const nested = { ...f.options, userData: path.join(f.root, 'new-data') };
  assert.equal((await createWorkspaceProfiles(nested).initialize())[0].id, 'default');
});

test('inspection has no persistence, external profiles are isolated, recent order and bindings survive restart', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const original = await fs.readFile(f.registry, 'utf8');
  await fs.writeFile(path.join(f.first, 'keep.txt'), 'user document');
  const candidate = await f.manager.inspect(f.first + path.sep);
  assert.equal(candidate.id, null); assert.equal(candidate.kind, 'external'); assert.equal(candidate.identity.canonical, f.first);
  const identity = await fs.lstat(f.first, { bigint: true });
  assert.equal(candidate.identity.dev, identity.dev.toString()); assert.equal(candidate.identity.ino, identity.ino.toString());
  assert.equal(await fs.readFile(f.registry, 'utf8'), original); await missing(path.join(f.userData, 'profiles'));
  const first = await f.manager.activate(candidate);
  assert.equal(first.dataDir, path.join(f.userData, 'profiles', first.id)); assert.equal(first.secretsDir, path.join(first.dataDir, 'secrets')); assert.equal(first.label, 'first');
  await fs.writeFile(path.join(first.dataDir, 'history'), 'first history');
  const duplicate = await f.manager.inspect(process.platform === 'win32' ? f.first.toUpperCase() : f.first);
  assert.equal(duplicate.id, first.id);
  const second = await f.manager.activate(await f.manager.inspect(f.second)); assert.notEqual(second.id, first.id);
  await fs.writeFile(path.join(second.dataDir, 'history'), 'second history');
  assert.deepEqual((await f.manager.list()).map(item => item.id), [second.id, first.id, 'default']);
  await f.manager.activate(first.id);
  const restarted = createWorkspaceProfiles(f.options); await restarted.initialize();
  assert.deepEqual(await restarted.getActive(), first);
  assert.equal(await fs.readFile(path.join(second.dataDir, 'history'), 'utf8'), 'second history');
  assert.equal(await fs.readFile(path.join(f.first, 'keep.txt'), 'utf8'), 'user document');
  assert.equal((await restarted.activate('default')).workspace, path.join(f.userData, 'workspace'));
  assert.equal((await read(f.registry)).profiles.length, 2);
});

test('selection rejects roots, home, protected overlaps, files and nonlocal or traversal paths', async t => {
  const f = await fixture(t); await f.manager.initialize();
  await fs.mkdir(path.join(f.userData, 'secrets')); await fs.mkdir(path.join(f.install, 'child'));
  await fs.writeFile(path.join(f.root, 'file.txt'), 'not directory');
  for (const directory of [path.parse(f.root).root, f.homeDirectory, f.userData, path.join(f.userData, 'secrets'), f.install, path.join(f.install, 'child'), f.root]) await assert.rejects(f.manager.inspect(directory), { code: 'WORKSPACE_PROTECTED_PATH' });
  for (const value of ['relative', path.join(f.first, '..', 'second').replace('second', `first${path.sep}..${path.sep}second`), '', null, `${f.first}\0suffix`]) await assert.rejects(f.manager.inspect(value), { code: 'WORKSPACE_INVALID_PATH' });
  await assert.rejects(f.manager.inspect(path.join(f.root, 'file.txt')), { code: 'WORKSPACE_UNSAFE_PATH' });
  if (process.platform === 'win32') for (const value of ['\\\\server\\share\\dir', '\\\\?\\C:\\directory', `${f.first}:stream`, `${f.userData}.`, `${f.userData} `, path.join(f.root, 'CON.txt')]) await assert.rejects(f.manager.inspect(value), { code: 'WORKSPACE_INVALID_PATH' });
  await fs.mkdir(path.join(f.homeDirectory, 'project'));
  assert.equal((await f.manager.inspect(path.join(f.homeDirectory, 'project'))).id, null);
});

test('symlink or junction at selected directory or any ancestor is rejected, including protected internal paths', async t => {
  const f = await fixture(t); await f.manager.initialize();
  await fs.mkdir(path.join(f.first, 'child'));
  const alias = path.join(f.root, 'alias'); await fs.symlink(f.first, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const directory of [alias, path.join(alias, 'child')]) await assert.rejects(f.manager.inspect(directory), { code: 'WORKSPACE_UNSAFE_PATH' });
  const selected = await f.manager.activate(await f.manager.inspect(f.first));
  await fs.symlink(f.second, selected.secretsDir, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.manager.getActive(), { code: 'WORKSPACE_UNSAFE_PATH' });
  const linkedData = createWorkspaceProfiles({ ...f.options, userData: path.join(alias, 'child') });
  await assert.rejects(linkedData.initialize(), { code: 'WORKSPACE_UNSAFE_PATH' });
});

test('missing and replaced external directories fail closed across restart without recreation or history rebinding', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const selected = await f.manager.activate(await f.manager.inspect(f.first));
  await fs.writeFile(path.join(selected.dataDir, 'history'), 'old-history');
  const before = await fs.readFile(f.registry, 'utf8');
  await fs.rename(f.first, path.join(f.root, 'old-first'));
  const restarted = createWorkspaceProfiles(f.options); await restarted.initialize();
  assert.equal((await restarted.list())[0].id, selected.id);
  await assert.rejects(restarted.getActive(), { code: 'WORKSPACE_MISSING' }); await missing(f.first);
  await fs.mkdir(f.first);
  await assert.rejects(restarted.getActive(), { code: 'WORKSPACE_IDENTITY_CHANGED' });
  await assert.rejects(restarted.activate(selected.id), { code: 'WORKSPACE_IDENTITY_CHANGED' });
  await assert.rejects(restarted.inspect(f.first), { code: 'WORKSPACE_IDENTITY_CHANGED' });
  assert.equal(await fs.readFile(f.registry, 'utf8'), before);
  assert.equal(await fs.readFile(path.join(selected.dataDir, 'history'), 'utf8'), 'old-history');
  assert.equal((await restarted.activate('default')).id, 'default');
});

test('stale inspected candidates and missing registered data directories cannot be silently regenerated', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const candidate = await f.manager.inspect(f.first);
  await fs.rename(f.first, path.join(f.root, 'original-first')); await fs.mkdir(f.first);
  await assert.rejects(f.manager.activate(candidate), { code: 'WORKSPACE_IDENTITY_CHANGED' });
  assert.equal((await f.manager.getActive()).id, 'default');
  const selected = await f.manager.activate(await f.manager.inspect(f.second));
  await fs.rmdir(selected.dataDir);
  await assert.rejects(f.manager.getActive(), { code: 'WORKSPACE_MISSING' });
  await assert.rejects(f.manager.activate(selected.id), { code: 'WORKSPACE_MISSING' }); await missing(selected.dataDir);
});

test('registry schema is strict and bounded; malformed files are preserved instead of reset', async t => {
  const f = await fixture(t); await f.manager.initialize(); await f.manager.activate(await f.manager.inspect(f.first));
  const valid = await read(f.registry);
  const mutations = [
    value => { value.extra = true; }, value => { value.version = 3; }, value => { value.activeId = 'missing'; },
    value => { value.recent.push('default'); }, value => { value.recent.reverse(); },
    value => { value.profiles[0].identity.ino = 1; }, value => { value.profiles[0].identity.canonical = f.second; },
    value => { value.profiles[0].dataDir = f.second; }, value => { value.profiles[0].workspace = f.userData; value.profiles[0].identity.canonical = f.userData; },
    value => { value.profiles.push({ ...structuredClone(value.profiles[0]), id: randomUUID() }); value.recent.push(value.profiles[1].id); },
    value => { value.profiles = Array.from({ length: 101 }, () => ({ ...structuredClone(value.profiles[0]), id: randomUUID() })); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(valid); mutate(value); await write(f.registry, value);
    const before = await fs.readFile(f.registry);
    await assert.rejects(createWorkspaceProfiles(f.options).initialize(), { code: 'WORKSPACE_REGISTRY_INVALID' });
    assert.deepEqual(await fs.readFile(f.registry), before);
  }
  for (const content of [Buffer.from('{broken'), Buffer.from([0xff, 0xfe])]) {
    await fs.writeFile(f.registry, content);
    await assert.rejects(createWorkspaceProfiles(f.options).initialize(), { code: 'WORKSPACE_REGISTRY_INVALID' });
  }
  await fs.writeFile(f.registry, Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(createWorkspaceProfiles(f.options).initialize(), { code: 'WORKSPACE_REGISTRY_UNSAFE' });
});

test('registry hardlinks, replaced registry state and unsafe initial registry directories are rejected', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const outside = path.join(f.root, 'outside-registry'); await fs.link(f.registry, outside);
  await assert.rejects(createWorkspaceProfiles(f.options).initialize(), { code: 'WORKSPACE_REGISTRY_UNSAFE' });
  await assert.rejects(f.manager.getActive(), { code: 'WORKSPACE_REGISTRY_UNSAFE' });
  await fs.unlink(outside);
  await assert.rejects(f.manager.getActive(), { code: 'WORKSPACE_REGISTRY_CHANGED' });
  const restarted = createWorkspaceProfiles(f.options); await restarted.initialize();
  const value = await read(f.registry); await fs.writeFile(f.registry, JSON.stringify(value, null, 4));
  await assert.rejects(restarted.activate('default'), { code: 'WORKSPACE_REGISTRY_CHANGED' });
  await fs.unlink(f.registry); await fs.symlink(f.first, f.registry, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createWorkspaceProfiles(f.options).initialize(), { code: 'WORKSPACE_REGISTRY_UNSAFE' });
});

test('atomic replacement failure preserves the prior selection and bytes and removes only owned empty new paths', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const before = await fs.readFile(f.registry); const candidate = await f.manager.inspect(f.first);
  const mocked = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('injected disk failure'), { code: 'EACCES' }); });
  await assert.rejects(f.manager.activate(candidate), { code: 'WORKSPACE_REGISTRY_WRITE_FAILED' });
  mocked.mock.restore();
  assert.deepEqual(await fs.readFile(f.registry), before); assert.equal((await f.manager.getActive()).id, 'default');
  assert.deepEqual(await fs.readdir(path.join(f.userData, 'profiles')), []);
  assert.equal((await fs.readdir(f.userData)).some(name => name.startsWith('.workspaces-')), false);
  const selected = await f.manager.activate(candidate); assert.equal(selected.kind, 'external');
});

test('failed activation preserves an unknown file injected into the newly created profile', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const before = await fs.readFile(f.registry); const candidate = await f.manager.inspect(f.first); let unknown;
  const mocked = t.mock.method(fs, 'rename', async () => {
    const directory = (await fs.readdir(path.join(f.userData, 'profiles')))[0];
    unknown = path.join(f.userData, 'profiles', directory, 'unknown.txt'); await fs.writeFile(unknown, 'keep me');
    throw Object.assign(new Error('injected failure'), { code: 'EACCES' });
  });
  await assert.rejects(f.manager.activate(candidate), { code: 'WORKSPACE_CLEANUP_INCOMPLETE' }); mocked.mock.restore();
  assert.deepEqual(await fs.readFile(f.registry), before); assert.equal(await fs.readFile(unknown, 'utf8'), 'keep me');
  assert.equal((await f.manager.getActive()).id, 'default');
});

test('failed commit never deletes an unknown replacement of its temporary filename', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const before = await fs.readFile(f.registry); const candidate = await f.manager.inspect(f.first);
  const rename = fs.rename; let unknown;
  const mocked = t.mock.method(fs, 'rename', async temporary => {
    await rename(temporary, `${temporary}.kept`); await fs.writeFile(temporary, 'foreign data'); unknown = temporary;
    throw Object.assign(new Error('injected failure'), { code: 'EACCES' });
  });
  await assert.rejects(f.manager.activate(candidate), { code: 'WORKSPACE_CLEANUP_INCOMPLETE' }); mocked.mock.restore();
  assert.deepEqual(await fs.readFile(f.registry), before); assert.equal(await fs.readFile(unknown, 'utf8'), 'foreign data');
});

test('profile bound, snapshots and serialized parallel selections are enforced without aliasing state', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const first = await f.manager.inspect(f.first), second = await f.manager.inspect(f.second);
  const [a, b] = await Promise.all([f.manager.activate(first), f.manager.activate(second)]);
  const listed = await f.manager.list(); assert.deepEqual(listed.map(item => item.id), [b.id, a.id, 'default']);
  listed[0].identity.ino = '123'; listed.pop(); assert.equal((await f.manager.getActive()).identity.ino, b.identity.ino);
  await assert.rejects(f.manager.activate('missing'), { code: 'WORKSPACE_UNKNOWN_PROFILE' });
  await assert.rejects(f.manager.activate({ ...first, extra: true }), { code: 'WORKSPACE_INVALID_CANDIDATE' });
  const registry = await read(f.registry);
  registry.profiles = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(), kind: 'external', workspace: path.join(f.root, `offline-${index}`), identity: { canonical: path.join(f.root, `offline-${index}`), dev: '1', ino: String(index + 1) } }));
  registry.activeId = 'default'; registry.recent = ['default', ...registry.profiles.map(item => item.id)]; await write(f.registry, registry);
  const full = createWorkspaceProfiles(f.options); await full.initialize();
  assert.equal((await full.list()).length, 101);
  await assert.rejects(full.activate(await full.inspect(f.first)), { code: 'WORKSPACE_PROFILE_LIMIT' });
  let called = false;
  await assert.rejects(full.createRestored({ restore: async () => { called = true; } }), { code: 'WORKSPACE_PROFILE_LIMIT' });
  assert.equal(called, false);
});

test('replacement of the entire application data directory is detected before state is used', async t => {
  const f = await fixture(t); await f.manager.initialize();
  await fs.rename(f.userData, path.join(f.root, 'old-data')); await fs.mkdir(f.userData);
  await assert.rejects(f.manager.getActive(), { code: 'WORKSPACE_CHANGED' });
  await missing(f.registry);
});

test('a committed selection with failed readback retains its newly registered data directory for recovery', async t => {
  const f = await fixture(t); await f.manager.initialize(); const candidate = await f.manager.inspect(f.first);
  const rename = fs.rename, open = fs.open; let committed = false;
  const renameMock = t.mock.method(fs, 'rename', async (...args) => { await rename(...args); committed = true; });
  const readMock = t.mock.method(fs, 'open', async (...args) => {
    if (committed && args[0] === f.registry) throw Object.assign(new Error('injected readback failure'), { code: 'EACCES' });
    return open(...args);
  });
  await assert.rejects(f.manager.activate(candidate), { code: 'WORKSPACE_REGISTRY_COMMIT_UNCERTAIN', committed: true });
  renameMock.mock.restore(); readMock.mock.restore();
  const saved = await read(f.registry); assert.notEqual(saved.activeId, 'default');
  assert.ok((await fs.lstat(path.join(f.userData, 'profiles', saved.activeId))).isDirectory());
  const recovered = createWorkspaceProfiles(f.options); await recovered.initialize(); assert.equal((await recovered.getActive()).id, saved.activeId);
});

async function restoredFixture({ dataDir }) {
  await missing(dataDir);
  await fs.mkdir(dataDir);
  await fs.mkdir(path.join(dataDir, 'workspace'));
  // Unit fixtures exercise registration, not database contents; the integration
  // test below delegates the actual database validation to restoreBackup.
  await fs.writeFile(path.join(dataDir, 'openaster.sqlite'), 'registered test database', { flag: 'wx' });
  await fs.writeFile(path.join(dataDir, 'workspace', 'kept.txt'), 'restored content');
  return { path: dataDir, sessions: 0 };
}

test('strict v1 migration atomically adds kinds without moving or rebinding existing profiles', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const external = await f.manager.activate(await f.manager.inspect(f.first));
  await fs.writeFile(path.join(external.dataDir, 'history'), 'original history');
  const previous = await read(f.registry);
  const legacy = { ...previous, version: 1, profiles: previous.profiles.map(({ kind, ...item }) => item) };
  await write(f.registry, legacy);
  const manager = createWorkspaceProfiles(f.options); await manager.initialize();
  const migrated = await read(f.registry);
  assert.deepEqual(migrated, { ...legacy, version: 2, profiles: legacy.profiles.map(item => ({ ...item, kind: 'external' })) });
  assert.deepEqual(await manager.getActive(), external);
  assert.equal(await fs.readFile(path.join(external.dataDir, 'history'), 'utf8'), 'original history');
  await manager.activate('default');
  await missing(path.join(f.userData, 'workspace'));
  assert.equal((await fs.lstat(f.registry)).nlink, 1);
});

test('failed v1 migration preserves legacy bytes and remains uninitialized until a successful retry', async t => {
  const f = await fixture(t); await f.manager.initialize();
  await write(f.registry, { version: 1, activeId: 'default', recent: ['default'], profiles: [] });
  const before = await fs.readFile(f.registry), manager = createWorkspaceProfiles(f.options);
  const mock = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('migration disk failure'), { code: 'EACCES' }); });
  await assert.rejects(manager.initialize(), { code: 'WORKSPACE_REGISTRY_WRITE_FAILED' }); mock.mock.restore();
  assert.deepEqual(await fs.readFile(f.registry), before);
  await assert.rejects(manager.getActive(), { code: 'WORKSPACE_NOT_INITIALIZED' });
  assert.equal((await manager.initialize())[0].id, 'default');
  assert.equal((await read(f.registry)).version, 2);
});

test('v1 rejects new fields before migration and restored v2 records cannot declare arbitrary paths or bindings', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const { profile } = await f.manager.createRestored({ restore: restoredFixture });
  const valid = await read(f.registry);
  const mutations = [
    v => { v.version = 1; },
    v => { v.profiles[0].workspace = f.first; },
    v => { v.profiles[0].dataDir = f.first; },
    v => { v.profiles[0].label = 'untrusted'; },
    v => { v.profiles[0].kind = 'default'; },
    v => { v.profiles[0].identity.canonical = f.first; },
    v => { v.profiles[0].dataIdentity.canonical = f.userData; },
    v => { v.profiles[0].dataIdentity.ino = 0; },
    v => { v.profiles[0].dataIdentity.extra = true; },
    v => { v.profiles.push({ ...structuredClone(v.profiles[0]), id: randomUUID() }); v.recent.push(v.profiles[1].id); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(valid); mutate(value); await write(f.registry, value);
    const before = await fs.readFile(f.registry);
    await assert.rejects(createWorkspaceProfiles(f.options).initialize(), { code: 'WORKSPACE_REGISTRY_INVALID' });
    assert.deepEqual(await fs.readFile(f.registry), before);
  }
  const externalId = randomUUID();
  const legacyWithKind = { version: 1, activeId: 'default', recent: ['default', externalId], profiles: [{ id: externalId, kind: 'external', workspace: f.first, identity: { canonical: f.first, dev: '1', ino: '2' } }] };
  await write(f.registry, legacyWithKind);
  await assert.rejects(createWorkspaceProfiles(f.options).initialize(), { code: 'WORKSPACE_REGISTRY_INVALID' });
  assert.equal(await fs.readFile(path.join(profile.workspace, 'kept.txt'), 'utf8'), 'restored content');
});

test('a real offline backup restores only to a new managed profile and remains selectable after restart', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const source = path.join(f.root, 'backup-source'); await fs.mkdir(source); await fs.mkdir(path.join(source, 'workspace'));
  const content = '\ufeff原始内容\r\n'; await fs.writeFile(path.join(source, 'workspace', 'note.txt'), content);
  const store = new Store(source);
  try {
    store.putProvider({ id: 'model', name: 'Model', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true, toolMode: 'workspace' });
    store.putSession({ id: 'session', title: '恢复会话', providerId: 'model', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', messages: [], approvals: [], run: null });
  } finally { store.close(); }
  const input = path.join(f.root, 'archive.json'); await createBackup({ dataDir: source, output: input });
  const { profile, result } = await f.manager.createRestored({ restore: async ({ dataDir }) => {
    assert.equal(path.dirname(dataDir), path.join(f.userData, 'profiles')); await missing(dataDir);
    return restoreBackup({ input, dataDir });
  } });
  assert.equal(profile.kind, 'restored'); assert.equal(profile.dataDir, result.path);
  assert.equal(profile.workspace, path.join(profile.dataDir, 'workspace'));
  assert.equal(profile.label, `恢复的工作区 · ${profile.id.slice(0, 8)}`);
  assert.equal(profile.identity.canonical, profile.workspace); assert.equal(profile.dataIdentity.canonical, profile.dataDir);
  assert.equal(await fs.readFile(path.join(profile.workspace, 'note.txt'), 'utf8'), content);
  await missing(profile.secretsDir);
  const restoredStore = new Store(profile.dataDir);
  try { assert.equal(restoredStore.getProvider('model').enabled, false); assert.equal(restoredStore.getSession('session').title, '恢复会话'); }
  finally { restoredStore.close(); }
  const restarted = createWorkspaceProfiles(f.options); await restarted.initialize();
  assert.deepEqual(await restarted.getActive(), profile);
  await restarted.activate('default'); assert.equal((await restarted.activate(profile.id)).id, profile.id);
  await assert.rejects(restarted.inspect(profile.workspace), { code: 'WORKSPACE_PROTECTED_PATH' });
  await assert.rejects(restarted.activate(profile), { code: 'WORKSPACE_INVALID_CANDIDATE' });
  profile.identity.ino = '999'; profile.dataIdentity.ino = '999';
  assert.notEqual((await restarted.getActive()).identity.ino, '999');
});

test('restored data and workspace identity replacements fail closed without recreation or implicit default', async t => {
  for (const which of ['workspace', 'dataDir', 'database']) await t.test(which, async t => {
    const f = await fixture(t); await f.manager.initialize();
    const { profile } = await f.manager.createRestored({ restore: restoredFixture });
    const target = which === 'database' ? path.join(profile.dataDir, 'openaster.sqlite') : profile[which];
    const saved = path.join(f.root, `old-${which}`); await fs.rename(target, saved);
    const restarted = createWorkspaceProfiles(f.options); await restarted.initialize();
    assert.equal((await restarted.list())[0].id, profile.id);
    await assert.rejects(restarted.getActive(), { code: 'WORKSPACE_MISSING' }); await missing(target);
    if (which !== 'database') {
      await fs.mkdir(target);
      await assert.rejects(restarted.activate(profile.id), { code: 'WORKSPACE_IDENTITY_CHANGED' });
    }
    assert.equal((await read(f.registry)).activeId, profile.id);
    assert.equal((await restarted.activate('default')).id, 'default');
  });
});

test('restored linked directories and hardlinked databases are rejected', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const { profile } = await f.manager.createRestored({ restore: restoredFixture });
  const database = path.join(profile.dataDir, 'openaster.sqlite'), alias = path.join(f.root, 'database-alias');
  await fs.link(database, alias);
  await assert.rejects(f.manager.getActive(), { code: 'WORKSPACE_UNSAFE_PATH' }); await fs.unlink(alias);
  await fs.rename(profile.workspace, path.join(f.root, 'original-workspace'));
  await fs.symlink(f.first, profile.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.manager.getActive(), { code: 'WORKSPACE_UNSAFE_PATH' });
});

test('registration failure preserves the complete restored directory and returns its result without changing selection', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const before = await fs.readFile(f.registry); let dataDir;
  const mock = t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('registration disk failure'), { code: 'EACCES' }); });
  let failure;
  await assert.rejects(f.manager.createRestored({ restore: async options => { dataDir = options.dataDir; return restoredFixture(options); } }), e => { failure = e; return e.code === 'WORKSPACE_REGISTRY_WRITE_FAILED'; });
  mock.mock.restore();
  assert.equal(failure.orphanPath, dataDir); assert.deepEqual(failure.restoreResult, { path: dataDir, sessions: 0 });
  assert.deepEqual(await fs.readFile(f.registry), before); assert.equal((await f.manager.getActive()).id, 'default');
  assert.equal(await fs.readFile(path.join(dataDir, 'workspace', 'kept.txt'), 'utf8'), 'restored content');
  assert.equal((await f.manager.list()).length, 1);
});

test('a committed restored registration with uncertain readback retains data and resolves on restart', async t => {
  const f = await fixture(t); await f.manager.initialize();
  const rename = fs.rename, open = fs.open; let committed = false, failure;
  const renameMock = t.mock.method(fs, 'rename', async (...args) => { await rename(...args); committed = true; });
  const readMock = t.mock.method(fs, 'open', async (...args) => {
    if (committed && args[0] === f.registry) throw Object.assign(new Error('postcommit failure'), { code: 'EACCES' });
    return open(...args);
  });
  await assert.rejects(f.manager.createRestored({ restore: restoredFixture }), e => { failure = e; return e.code === 'WORKSPACE_REGISTRY_COMMIT_UNCERTAIN' && e.committed === true; });
  renameMock.mock.restore(); readMock.mock.restore();
  assert.equal(failure.restoreResult.path, failure.orphanPath);
  assert.equal(await fs.readFile(path.join(failure.orphanPath, 'workspace', 'kept.txt'), 'utf8'), 'restored content');
  const manager = createWorkspaceProfiles(f.options); await manager.initialize();
  assert.equal((await manager.getActive()).dataDir, failure.orphanPath);
});

test('callback failures and unknown partial files are never cleaned or registered by the profile manager', async t => {
  const f = await fixture(t); await f.manager.initialize(); const before = await fs.readFile(f.registry); let target;
  const failure = Object.assign(new Error('restore cleanup refused'), { code: 'RESTORE_CLEANUP_INCOMPLETE' });
  await assert.rejects(f.manager.createRestored({ restore: async ({ dataDir }) => {
    target = dataDir; await fs.mkdir(dataDir); await fs.writeFile(path.join(dataDir, 'unknown.txt'), 'preserve'); throw failure;
  } }), e => e === failure);
  assert.equal(failure.orphanPath, target); assert.equal(failure.partialRestore, true);
  assert.equal(await fs.readFile(path.join(target, 'unknown.txt'), 'utf8'), 'preserve');
  assert.deepEqual(await fs.readFile(f.registry), before);
  assert.equal((await f.manager.getActive()).id, 'default'); assert.equal((await f.manager.list()).length, 1);
  await assert.rejects(f.manager.activate(path.basename(target)), { code: 'WORKSPACE_UNKNOWN_PROFILE' });
  await assert.rejects(f.manager.createRestored({ restore: restoredFixture, dataDir: target }), { code: 'WORKSPACE_INVALID_RESTORE' });
});

test('a failed real restore that cleans its target does not claim partial data remains', async t => {
  const f = await fixture(t); await f.manager.initialize(); const before = await fs.readFile(f.registry);
  const source = path.join(f.root, 'source'); await fs.mkdir(path.join(source, 'workspace'), { recursive: true });
  await fs.writeFile(path.join(source, 'workspace', 'original.txt'), 'preserve source');
  const store = new Store(source); store.createSession({ title: 'restore failure' }); store.close();
  const input = path.join(f.root, 'archive.json'); await createBackup({ dataDir: source, output: input });
  let target, failure;
  const mock = t.mock.method(Store.prototype, 'putSession', () => { throw Object.assign(new Error('injected restore write failure'), { code: 'EIO' }); });
  await assert.rejects(f.manager.createRestored({ restore: async ({ dataDir }) => {
    target = dataDir; return restoreBackup({ input, dataDir });
  } }), e => { failure = e; return e.code === 'EIO'; });
  mock.mock.restore();
  await missing(target); assert.equal(Object.hasOwn(failure, 'orphanPath'), false); assert.equal(Object.hasOwn(failure, 'partialRestore'), false);
  assert.deepEqual(await fs.readFile(f.registry), before); assert.equal((await f.manager.getActive()).id, 'default');
  assert.equal((await f.manager.list()).length, 1); assert.equal(await fs.readFile(path.join(source, 'workspace', 'original.txt'), 'utf8'), 'preserve source');
});

for (const scenario of ['linked target', 'replaced parent', 'unreadable target']) test(`failed restore reports ${scenario} as an unverified partial site without adopting or deleting it`, async t => {
  const f = await fixture(t); await f.manager.initialize(); const before = await fs.readFile(f.registry);
  const failure = Object.assign(new Error('worker exited after a partial write'), { code: 'BACKUP_WORKER_EXIT' });
  let target, saved, denied = false, mock;
  if (scenario === 'unreadable target') {
    const lstat = fs.lstat;
    mock = t.mock.method(fs, 'lstat', async (...args) => {
      if (denied && args[0] === target) throw Object.assign(new Error('inspection denied'), { code: 'EACCES' });
      return lstat(...args);
    });
  }
  await assert.rejects(f.manager.createRestored({ restore: async ({ dataDir }) => {
    target = dataDir;
    if (scenario === 'linked target') {
      await fs.writeFile(path.join(f.first, 'foreign.txt'), 'foreign');
      await fs.symlink(f.first, target, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      await fs.mkdir(target); await fs.writeFile(path.join(target, 'partial.txt'), 'partial');
      if (scenario === 'replaced parent') {
        saved = path.join(f.root, 'moved-profiles'); await fs.rename(path.dirname(target), saved);
        await fs.mkdir(path.dirname(target)); await fs.mkdir(target); await fs.writeFile(path.join(target, 'foreign.txt'), 'foreign');
      } else denied = true;
    }
    throw failure;
  } }), e => e === failure);
  mock?.mock.restore();
  assert.equal(failure.orphanPath, target); assert.equal(failure.partialRestore, true); assert.equal(Object.hasOwn(failure, 'restoreResult'), false);
  assert.deepEqual(await fs.readFile(f.registry), before); assert.equal((await f.manager.getActive()).id, 'default');
  assert.equal((await f.manager.list()).length, 1); await assert.rejects(f.manager.activate(path.basename(target)), { code: 'WORKSPACE_UNKNOWN_PROFILE' });
  if (scenario === 'linked target') { assert.equal((await fs.lstat(target)).isSymbolicLink(), true); assert.equal(await fs.readFile(path.join(f.first, 'foreign.txt'), 'utf8'), 'foreign'); }
  else if (scenario === 'replaced parent') { assert.equal(await fs.readFile(path.join(target, 'foreign.txt'), 'utf8'), 'foreign'); assert.equal(await fs.readFile(path.join(saved, path.basename(target), 'partial.txt'), 'utf8'), 'partial'); }
  else assert.equal(await fs.readFile(path.join(target, 'partial.txt'), 'utf8'), 'partial');
});

test('restored registration rejects incomplete output and replacement of the managed parent', async t => {
  const f = await fixture(t); await f.manager.initialize();
  let incomplete;
  await assert.rejects(f.manager.createRestored({ restore: async ({ dataDir }) => {
    incomplete = dataDir; await fs.mkdir(dataDir); await fs.mkdir(path.join(dataDir, 'workspace')); return { path: dataDir };
  } }), e => e.code === 'WORKSPACE_MISSING' && e.orphanPath === incomplete);
  const before = await fs.readFile(f.registry); let target;
  await assert.rejects(f.manager.createRestored({ restore: async options => {
    target = options.dataDir; const result = await restoredFixture(options);
    const parent = path.dirname(target); await fs.rename(parent, path.join(f.root, 'moved-profiles')); await fs.mkdir(parent);
    await fs.mkdir(target); await fs.writeFile(path.join(target, 'foreign.txt'), 'foreign'); return result;
  } }), e => e.code === 'WORKSPACE_IDENTITY_CHANGED' && e.orphanPath === target);
  assert.equal(await fs.readFile(path.join(target, 'foreign.txt'), 'utf8'), 'foreign');
  assert.deepEqual(await fs.readFile(f.registry), before);
});

test('concurrent restore and selection operations serialize with unique targets and stable recent order', async t => {
  const f = await fixture(t); await f.manager.initialize();
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const first = f.manager.createRestored({ restore: async options => { entered(); await gate; return restoredFixture(options); } });
  await started;
  let secondEntered = false;
  const second = f.manager.createRestored({ restore: async options => { secondEntered = true; return restoredFixture(options); } });
  const selection = f.manager.activate('default');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(secondEntered, false);
  release(); const [a, b, selected] = await Promise.all([first, second, selection]);
  assert.notEqual(a.profile.id, b.profile.id); assert.equal(selected.id, 'default');
  assert.deepEqual((await f.manager.list()).map(item => item.id), ['default', b.profile.id, a.profile.id]);
});
