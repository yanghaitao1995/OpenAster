// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceProfiles } from '../desktop/workspace-profiles.mjs';
import { createWorkspaceManager } from '../server/workspace-manager.mjs';

async function fixture(t, options = {}) {
  const parent = await fs.realpath(path.resolve('.diagnostics'));
  const root = await fs.mkdtemp(path.join(parent, 'v42-workspace-manager-'));
  const identity = await fs.lstat(root, { bigint: true }), owner = randomUUID();
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  t.after(async () => {
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), parent);
    assert.equal(current.isSymbolicLink(), false); assert.equal(current.ino, identity.ino); assert.equal(current.dev, identity.dev);
    assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const data = path.join(root, 'data'), app = path.join(root, 'app'), projects = path.join(root, 'projects');
  await fs.mkdir(data); await fs.mkdir(app);
  const profiles = createWorkspaceProfiles({ userData: data, appRoots: [app], homeDirectory: root });
  await profiles.initialize();
  let active = await profiles.getActive(), transitions = 0, now = 1000;
  const manager = createWorkspaceManager({ profiles, getCurrent: async () => active,
    projectsRoot: projects, homeDirectory: root, protectedRoots: [data, app], now: () => now,
    transition: async commit => { transitions++; if (options.busy) throw Object.assign(new Error('busy'), { code: 'WORKSPACE_BUSY' }); active = await commit(); return true; },
  });
  const context = { owner: 'isolated-session-owner', remote: false };
  return { root, data, app, projects, profiles, manager, context, active: () => active, transitions: () => transitions, expire: () => { now += 300001; } };
}

test('project manager creates lazily, uses one-use owner-bound tickets and persists independent profiles', async t => {
  const f = await fixture(t);
  const list = await f.manager.list();
  assert.equal(list.location, 'service-host'); assert.equal(list.allowAbsolutePath, true);
  assert.equal((await f.manager.list({ remote: true })).roots.some(root => root.id === 'home'), false);
  assert.equal((await f.manager.browse({ rootId: 'projects' })).exists, false);
  await assert.rejects(fs.stat(f.projects), { code: 'ENOENT' });
  await assert.rejects(f.manager.prepare({ action: 'create', rootId: 'projects', name: '../bad' }, f.context), { code: 'INVALID_PROJECT_NAME' });
  await assert.rejects(fs.stat(f.projects), { code: 'ENOENT' });
  const choice = await f.manager.prepare({ action: 'create', rootId: 'projects', name: '学习项目' }, f.context);
  await assert.rejects(f.manager.reserve({ ticket: choice.ticket }, { owner: 'different' }), { code: 'PROJECT_TICKET_EXPIRED' });
  const operation = await f.manager.reserve({ ticket: choice.ticket }, f.context);
  await operation.run(); await operation.run();
  assert.equal(f.transitions(), 1); assert.equal(f.manager.operation(operation.id).status, 'completed');
  assert.equal(f.active().workspace, path.join(f.projects, '学习项目'));
  assert.notEqual(f.active().dataDir, f.data);
  await assert.rejects(f.manager.reserve({ ticket: choice.ticket }, f.context), { code: 'PROJECT_TICKET_EXPIRED' });
  const reopened = createWorkspaceProfiles({ userData: f.data, appRoots: [f.app], homeDirectory: f.root });
  await reopened.initialize(); assert.equal((await reopened.getActive()).id, f.active().id);
  await assert.rejects(f.manager.prepare({ action: 'create', rootId: 'projects', name: '学习项目' }, f.context), { code: 'WORKSPACE_PROJECT_EXISTS' });
});

test('remote project navigation is bounded; browsing excludes protected directories, links and sensitive names', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.projects); await fs.mkdir(path.join(f.projects, 'ordinary')); await fs.mkdir(path.join(f.projects, '.ssh'));
  await fs.symlink(f.app, path.join(f.projects, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const remote = { ...f.context, remote: true };
  assert.deepEqual((await f.manager.browse({ rootId: 'projects' }, remote)).directories.map(item => item.name), ['ordinary']);
  for (const requested of ['../data', '/absolute', 'ordinary/../.ssh', 'ordinary\\child']) await assert.rejects(f.manager.browse({ rootId: 'projects', path: requested }, remote), { code: 'WORKSPACE_INVALID_PATH' });
  await assert.rejects(f.manager.browse({ rootId: 'home' }, remote), { code: 'PROJECT_ROOT_UNAVAILABLE' });
  await assert.rejects(f.manager.prepare({ action: 'open', absolutePath: f.projects }, remote), { code: 'LOCAL_PROJECT_PATH_REQUIRED' });
  await assert.rejects(f.manager.prepare({ action: 'open', rootId: 'projects', path: 'linked' }, remote), { code: 'WORKSPACE_UNSAFE_PATH' });
  await assert.rejects(f.manager.prepare({ action: 'open', absolutePath: f.data }, f.context), { code: 'WORKSPACE_PROTECTED_PATH' });
  const selected = await f.manager.prepare({ action: 'open', rootId: 'projects', path: 'ordinary' }, remote);
  const operation = await f.manager.reserve({ ticket: selected.ticket }, remote); await operation.run();
  assert.equal(f.manager.operation(operation.id).status, 'completed');
});

test('project selection rejects replacement identities, expiry and concurrent activations without rebinding data', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.projects); const project = path.join(f.projects, 'replace'); await fs.mkdir(project);
  const choice = await f.manager.prepare({ action: 'open', absolutePath: project }, f.context);
  await fs.rename(project, project + '-original'); await fs.mkdir(project);
  const operation = await f.manager.reserve({ ticket: choice.ticket }, f.context); await operation.run();
  assert.equal(f.manager.operation(operation.id).status, 'failed'); assert.equal(f.manager.operation(operation.id).error.code, 'WORKSPACE_IDENTITY_CHANGED');
  assert.equal(f.active().id, 'default');
  const expired = await f.manager.prepare({ action: 'open', absolutePath: project }, f.context); f.expire();
  await assert.rejects(f.manager.reserve({ ticket: expired.ticket }, f.context), { code: 'PROJECT_TICKET_EXPIRED' });
  const a = await f.manager.prepare({ action: 'open', absolutePath: project }, f.context), b = await f.manager.prepare({ action: 'open', absolutePath: project }, f.context);
  const reservations = await Promise.allSettled([f.manager.reserve({ ticket: a.ticket }, f.context), f.manager.reserve({ ticket: b.ticket }, f.context)]);
  assert.equal(reservations.filter(result => result.status === 'fulfilled').length, 1);
  await reservations.find(result => result.status === 'fulfilled').value.run();
});

test('busy transition records failure and leaves original active profile intact', async t => {
  const f = await fixture(t, { busy: true });
  const selected = await f.manager.prepare({ action: 'create', rootId: 'projects', name: 'still-pending' }, f.context);
  const operation = await f.manager.reserve({ ticket: selected.ticket }, f.context); await operation.run();
  assert.equal(f.manager.operation(operation.id).error.code, 'WORKSPACE_BUSY'); assert.equal(f.active().id, 'default');
  await assert.rejects(fs.stat(path.join(f.projects, 'still-pending')), { code: 'ENOENT' });
  assert.equal(f.manager.busy, false);
});
