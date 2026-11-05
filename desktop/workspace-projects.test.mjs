// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceProfiles } from './workspace-profiles.mjs';
import { createWorkspaceActions } from './workspace-actions.mjs';
import { createDesktopLifecycle } from './lifecycle.mjs';

async function fixture(t) {
  const temporaryRoot = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'openaster-project-create-'));
  const identity = await fs.lstat(root, { bigint: true });
  t.after(async () => {
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), temporaryRoot);
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.equal(current.isSymbolicLink(), false);
    await fs.rm(root, { recursive: true, force: true });
  });
  const options = { userData: path.join(root, 'data'), homeDirectory: path.join(root, 'home'), appRoots: [path.join(root, 'app')] };
  const parent = path.join(root, 'projects'), project = path.join(parent, '我的项目 & notes');
  for (const directory of [options.userData, options.homeDirectory, ...options.appRoots, parent]) await fs.mkdir(directory);
  const profiles = createWorkspaceProfiles(options); await profiles.initialize();
  return { root, options, parent, project, profiles, registry: path.join(options.userData, 'workspaces.json') };
}
const missing = location => assert.rejects(fs.lstat(location), { code: 'ENOENT' });

test('new project creates one empty directory, registers it, and retains its identity and recent selection across restart', async t => {
  const f = await fixture(t), before = await fs.readFile(f.registry);
  const candidate = await f.profiles.prepareProject(f.project);
  await missing(f.project); assert.deepEqual(await fs.readFile(f.registry), before);
  const selected = await f.profiles.createProject(candidate);
  assert.equal(selected.kind, 'external'); assert.equal(selected.workspace, f.project);
  assert.deepEqual(await fs.readdir(f.project), []);
  assert.equal((await f.profiles.getActive()).id, selected.id);
  const restarted = createWorkspaceProfiles(f.options); await restarted.initialize();
  assert.deepEqual(await restarted.getActive(), selected);
  assert.equal((await restarted.list())[0].id, selected.id);
  assert.equal((await fs.lstat(selected.dataDir)).isDirectory(), true);
  assert.notEqual(selected.dataDir, selected.workspace);
});

test('existing files/directories and a late occupant are never adopted or overwritten', async t => {
  const f = await fixture(t), before = await fs.readFile(f.registry);
  for (const name of ['existing-file', 'existing-directory']) {
    const location = path.join(f.parent, name);
    if (name.endsWith('file')) await fs.writeFile(location, 'keep'); else await fs.mkdir(location);
    await assert.rejects(f.profiles.prepareProject(location), { code: 'WORKSPACE_PROJECT_EXISTS' });
  }
  const candidate = await f.profiles.prepareProject(f.project);
  await fs.mkdir(f.project); await fs.writeFile(path.join(f.project, 'keep.txt'), 'user material');
  await assert.rejects(f.profiles.createProject(candidate), { code: 'WORKSPACE_PROJECT_EXISTS' });
  assert.equal(await fs.readFile(path.join(f.project, 'keep.txt'), 'utf8'), 'user material');
  assert.deepEqual(await fs.readFile(f.registry), before);
});

test('replaced parent after selection is rejected without creating in either directory', async t => {
  const f = await fixture(t), candidate = await f.profiles.prepareProject(f.project);
  const oldParent = f.parent + '-original'; await fs.rename(f.parent, oldParent); await fs.mkdir(f.parent);
  await assert.rejects(f.profiles.createProject(candidate), { code: 'WORKSPACE_IDENTITY_CHANGED' });
  await missing(f.project); await missing(path.join(oldParent, path.basename(f.project)));
  assert.equal((await f.profiles.getActive()).id, 'default');
});

test('new project rejects protected paths, invalid names, absent parents and linked ancestors before creating', async t => {
  const f = await fixture(t);
  await assert.rejects(f.profiles.prepareProject(path.join(f.options.userData, 'project')), { code: 'WORKSPACE_PROTECTED_PATH' });
  await assert.rejects(f.profiles.prepareProject(path.join(f.parent, 'missing-parent', 'project')), { code: 'WORKSPACE_MISSING' });
  for (const name of ['COM0', 'LPT0', 'conin$', 'conout$', 'clock$', 'COM¹', 'bad*name']) {
    await assert.rejects(f.profiles.prepareProject(path.join(f.parent, name)), error => ['WORKSPACE_PROJECT_NAME', 'WORKSPACE_INVALID_PATH'].includes(error.code));
  }
  const alias = path.join(f.root, 'alias'); await fs.symlink(f.parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.profiles.prepareProject(path.join(alias, 'project')), { code: 'WORKSPACE_UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(f.parent), []);
});

for (const keepUnknownContent of [false, true]) test('registration failure '+(keepUnknownContent ? 'preserves new unknown content' : 'cleans only the owned empty project'), async t => {
  const f = await fixture(t), candidate = await f.profiles.prepareProject(f.project), before = await fs.readFile(f.registry);
  const original = fs.rename;
  fs.rename = async (from, to) => {
    if (to === f.registry) {
      if (keepUnknownContent) await fs.writeFile(path.join(f.project, 'keep.txt'), 'created by another operation');
      throw Object.assign(new Error('simulated registry failure'), { code: 'EIO' });
    }
    return original(from, to);
  };
  try {
    await assert.rejects(f.profiles.createProject(candidate), error => {
      assert.equal(error.code, keepUnknownContent ? 'WORKSPACE_PROJECT_RETAINED' : 'WORKSPACE_REGISTRY_WRITE_FAILED');
      if (keepUnknownContent) { assert.equal(error.projectPath, f.project); assert.equal(error.cause.code, 'WORKSPACE_REGISTRY_WRITE_FAILED'); }
      return true;
    });
  } finally { fs.rename = original; }
  if (keepUnknownContent) assert.equal(await fs.readFile(path.join(f.project, 'keep.txt'), 'utf8'), 'created by another operation');
  else await missing(f.project);
  assert.deepEqual(await fs.readFile(f.registry), before);
  assert.equal((await f.profiles.getActive()).id, 'default');
});

function actions(f, overrides = {}) {
  const calls = [], errors = [];
  const lifecycle = createDesktopLifecycle({
    prepareTransition: async () => { calls.push('leave-check'); return { release: async () => { calls.push('release'); return true; } }; },
    closeService: async () => { calls.push('stop'); await missing(f.project); },
    relaunch: async () => calls.push('relaunch'), quit: () => calls.push('quit'),
    reportError: async (error, meta) => errors.push({ error, meta }), ...overrides.lifecycle,
  });
  const api = createWorkspaceActions({
    profiles: { ...f.profiles, createProject: async candidate => { calls.push('create'); return f.profiles.createProject(candidate); } },
    activeProfile: overrides.activeProfile ?? { id: 'default' }, lifecycle,
    dialogs: { chooseProjectLocation: async () => f.project, confirmCreateProject: async () => { calls.push('confirm'); return true; }, ...overrides.dialogs },
    validateWorkspace: async () => calls.push('validate'),
    openDirectory: async directory => calls.push(['open', directory]), copyPath: async directory => calls.push(['copy', directory]),
  });
  return { api, calls, errors, lifecycle };
}

test('create action uses the departure guard and stopped-service lifecycle before any directory write', async t => {
  const f = await fixture(t), a = actions(f);
  const selected = await a.api.createProject(); assert.equal(selected.workspace, f.project);
  assert.deepEqual(a.calls, ['confirm', 'leave-check', 'stop', 'create', 'relaunch', 'quit']);
  assert.deepEqual(a.errors, []);
});

test('cancel, dirty-page refusal and busy service cannot create or change the selected workspace', async t => {
  const f = await fixture(t);
  const cancelled = actions(f, { dialogs: { confirmCreateProject: async () => false } });
  assert.equal(await cancelled.api.createProject(), false); assert.deepEqual(cancelled.calls, []);
  const dirty = actions(f, { lifecycle: { prepareTransition: async () => { throw Object.assign(new Error(), { code: 'NATIVE_LEAVE_PENDING' }); } } });
  assert.equal(await dirty.api.createProject(), false); assert.deepEqual(dirty.calls, ['confirm']); assert.equal(dirty.errors[0].error.code, 'NATIVE_LEAVE_PENDING');
  const busy = actions(f, { lifecycle: { closeService: async () => { throw Object.assign(new Error(), { code: 'WORKSPACE_BUSY' }); } } });
  assert.equal(await busy.api.createProject(), false); assert.deepEqual(busy.calls, ['confirm', 'leave-check', 'release']); assert.equal(busy.errors[0].meta.restartRequired, false);
  await missing(f.project); assert.equal((await f.profiles.getActive()).id, 'default');
});

test('open and copy use the revalidated current directory without stopping service; replacement blocks both', async t => {
  const f = await fixture(t), selected = await f.profiles.createProject(await f.profiles.prepareProject(f.project));
  const a = actions(f, { activeProfile: selected });
  assert.equal(await a.api.showCurrentDirectory(), true);
  assert.equal(await a.api.showCurrentDirectory({ copy: true }), true);
  assert.deepEqual(a.calls, ['validate', ['open', f.project], 'validate', ['copy', f.project]]);
  await fs.rename(f.project, f.project+'-original'); await fs.mkdir(f.project);
  assert.equal(await a.api.showCurrentDirectory(), false);
  assert.equal(await a.api.showCurrentDirectory({ copy: true }), false);
  assert.equal(a.errors.length, 2); assert.ok(a.errors.every(item => item.error.code === 'WORKSPACE_IDENTITY_CHANGED'));
  assert.equal(a.calls.length, 4);
});
