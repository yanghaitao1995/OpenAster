// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceProfiles } from './workspace-profiles.mjs';

const injected = (code, syscall) => Object.assign(new Error(`Injected ${syscall} failure`), { code, syscall });
const temporary = file => typeof file === 'string' && /^\.workspaces-[0-9a-f-]+\.tmp$/.test(path.basename(file));
const read = file => fs.readFile(file, 'utf8');
const missing = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
async function rejected(operation) { let failure; await assert.rejects(operation, error => { failure = error; return true; }); return failure; }
function chainIncludes(error, expected) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) { if (current === expected) return true; seen.add(current); }
  return false;
}
function diagnostic(failure, { code, stage, committed = false, cause, cleanup = [] }) {
  assert.equal(failure.code, code);
  const value = failure.registryDiagnostic;
  assert.equal(value?.version, 1); assert.equal(value.stage, stage); assert.equal(value.committed, committed);
  if (committed) assert.equal(failure.committed, true);
  if (failure.orphanPath) {
    assert.ok(Array.isArray(failure.retainedPaths));
    assert.ok(failure.retainedPaths.includes(failure.orphanPath));
    assert.ok(failure.retainedPaths.length <= 3);
    assert.equal(new Set(failure.retainedPaths).size, failure.retainedPaths.length);
    assert.ok(failure.retainedPaths.every(item => typeof item === 'string' && path.isAbsolute(item)));
  }
  if (cause) {
    assert.ok(chainIncludes(failure, cause), 'The original failure remains in the cause chain');
    assert.equal(value.systemCode, cause.code); assert.equal(value.syscall, cause.syscall);
  }
  for (const item of cleanup) {
    assert.ok(value.cleanup?.some(entry => entry.stage === item.stage && entry.systemCode === item.cause.code && entry.syscall === item.cause.syscall), `Missing cleanup metadata for ${item.stage}`);
    const descriptor = Object.getOwnPropertyDescriptor(failure, 'cleanupCauses');
    assert.equal(descriptor?.enumerable, false); assert.ok(Array.isArray(descriptor?.value));
    assert.ok(descriptor.value.some(error => chainIncludes(error, item.cause)), 'Independent cleanup failure remains inspectable');
  }
}
async function fixture(t, { initialize = true } = {}) {
  // Restore injected methods before fixture cleanup, including a failed assertion.
  t.after(() => t.mock.restoreAll());
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-profile-faults-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const userData = path.join(root, 'data'), homeDirectory = path.join(root, 'home'), install = path.join(root, 'install'), workspace = path.join(root, 'project');
  for (const directory of [userData, homeDirectory, install, workspace]) await fs.mkdir(directory);
  const options = { userData, homeDirectory, appRoots: [install] }, manager = createWorkspaceProfiles(options);
  const result = { root, userData, workspace, options, manager, registry: path.join(userData, 'workspaces.json'), profiles: path.join(userData, 'profiles') };
  if (initialize) { await manager.initialize(); result.before = await read(result.registry); result.candidate = await manager.inspect(workspace); }
  return result;
}
async function cleanPrior(f) {
  assert.equal(await read(f.registry), f.before); assert.equal((await f.manager.getActive()).id, 'default');
  assert.deepEqual(await fs.readdir(f.profiles), []);
  assert.deepEqual((await fs.readdir(f.userData)).filter(temporary), []);
}
async function noRegistryTemporary(f) { assert.deepEqual((await fs.readdir(f.userData)).filter(temporary), []); }

for (const [method, stage, syscall] of [
  ['open', 'open-temporary', 'open'], ['stat', 'inspect-temporary', 'fstat'],
  ['writeFile', 'write-temporary', 'write'], ['sync', 'sync-temporary', 'fsync'], ['close', 'close-temporary', 'close'],
]) test(`registry persist identifies one ${method} failure without changing selection`, async t => {
  const f = await fixture(t), cause = injected('EIO', syscall), open = fs.open;
  let file, handle, closeCalls = 0, originalClose;
  const mock = t.mock.method(fs, 'open', async (...args) => {
    if (!temporary(args[0])) return open(...args);
    file = args[0]; if (method === 'open') throw cause;
    handle = await open(...args); originalClose = handle.close.bind(handle);
    t.mock.method(handle, 'close', async (...values) => {
      closeCalls++; if (method === 'close' && closeCalls === 1) throw cause;
      return originalClose(...values);
    });
    if (method !== 'close') t.mock.method(handle, method, async () => { throw cause; });
    return handle;
  });
  try {
    const failure = await rejected(f.manager.activate(f.candidate)); mock.mock.restore();
    diagnostic(failure, { code: method === 'stat' ? 'WORKSPACE_CLEANUP_INCOMPLETE' : 'WORKSPACE_REGISTRY_WRITE_FAILED', stage, cause });
    if (method === 'stat') {
      assert.equal(failure.orphanPath, file); assert.ok((await fs.lstat(file)).isFile());
      assert.equal(await read(f.registry), f.before); assert.deepEqual(await fs.readdir(f.profiles), []);
      assert.equal((await f.manager.getActive()).id, 'default');
    } else await cleanPrior(f);
    assert.equal(closeCalls, method === 'open' ? 0 : method === 'close' ? 2 : 1);
    if (handle) assert.equal(handle.fd, -1, 'Real file descriptor was closed');
  } finally { await originalClose?.().catch(() => {}); }
});

test('a second close failure retains primary close diagnostics and reports its cleanup cause', async t => {
  const f = await fixture(t), primary = injected('EIO', 'close'), cleanup = injected('EBUSY', 'close'), open = fs.open;
  let calls = 0, actualClose;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args); if (!temporary(args[0])) return handle;
    actualClose = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { calls++; if (calls === 1) { await actualClose(); throw primary; } throw cleanup; });
    return handle;
  });
  try {
    const failure = await rejected(f.manager.activate(f.candidate));
    diagnostic(failure, { code: 'WORKSPACE_CLEANUP_INCOMPLETE', stage: 'close-temporary', cause: primary, cleanup: [{ stage: 'close-temporary', cause: cleanup }] });
    assert.equal(calls, 2); assert.equal(await read(f.registry), f.before); assert.equal((await f.manager.getActive()).id, 'default');
    assert.deepEqual(await fs.readdir(f.profiles), []);
  } finally { await actualClose?.().catch(() => {}); }
});

test('rename failure followed by unlink failure preserves the old active profile and both causes', async t => {
  const f = await fixture(t), selected = await f.manager.activate(f.candidate);
  f.before = await read(f.registry);
  const primary = injected('EACCES', 'rename'), cleanup = injected('EBUSY', 'unlink'), unlink = fs.unlink;
  let file;
  t.mock.method(fs, 'rename', async source => { file = source; throw primary; });
  t.mock.method(fs, 'unlink', async target => { if (target === file) throw cleanup; return unlink(target); });
  const failure = await rejected(f.manager.activate('default'));
  diagnostic(failure, { code: 'WORKSPACE_CLEANUP_INCOMPLETE', stage: 'rename-registry', cause: primary, cleanup: [{ stage: 'remove-temporary', cause: cleanup }] });
  assert.equal(failure.orphanPath, file); assert.ok((await fs.lstat(file)).isFile());
  assert.equal(await read(f.registry), f.before); assert.equal((await f.manager.getActive()).id, selected.id);
  assert.ok((await fs.lstat(selected.dataDir)).isDirectory());
});

test('initial registry link failure removes only its owned temporary and leaves no registry', async t => {
  const f = await fixture(t, { initialize: false }), cause = injected('EACCES', 'link');
  const mock = t.mock.method(fs, 'link', async () => { throw cause; });
  const failure = await rejected(f.manager.initialize()); mock.mock.restore();
  diagnostic(failure, { code: 'WORKSPACE_REGISTRY_WRITE_FAILED', stage: 'link-registry', cause });
  await missing(f.registry); await noRegistryTemporary(f);
  await assert.rejects(f.manager.getActive(), { code: 'WORKSPACE_NOT_INITIALIZED' });
  await f.manager.initialize(); assert.equal((await f.manager.getActive()).id, 'default');
});

test('initial link EEXIST never replaces a registry created by another actor', async t => {
  const f = await fixture(t, { initialize: false }), link = fs.link;
  const foreign = 'foreign registry bytes'; let primary;
  t.mock.method(fs, 'link', async (...args) => {
    await fs.writeFile(f.registry, foreign, { flag: 'wx' });
    try { return await link(...args); } catch (cause) { primary = cause; throw cause; }
  });
  const failure = await rejected(f.manager.initialize());
  assert.equal(primary.code, 'EEXIST');
  diagnostic(failure, { code: 'WORKSPACE_REGISTRY_WRITE_FAILED', stage: 'link-registry', cause: primary });
  assert.equal(await read(f.registry), foreign); await noRegistryTemporary(f);
});

test('successful initial link with failed temporary cleanup remains committed and retains both hardlinks', async t => {
  const f = await fixture(t, { initialize: false }), unlink = fs.unlink, cause = injected('EACCES', 'unlink');
  let file;
  const mock = t.mock.method(fs, 'unlink', async target => { if (temporary(target)) { file = target; throw cause; } return unlink(target); });
  const failure = await rejected(f.manager.initialize()); mock.mock.restore();
  diagnostic(failure, { code: 'WORKSPACE_REGISTRY_COMMIT_UNCERTAIN', stage: 'remove-installed-temporary', committed: true, cause });
  assert.equal(failure.orphanPath, file);
  const a = await fs.lstat(f.registry, { bigint: true }), b = await fs.lstat(file, { bigint: true });
  assert.equal(a.ino, b.ino); assert.equal(a.dev, b.dev); assert.equal(a.nlink, 2n); assert.equal(b.nlink, 2n);
  assert.equal(JSON.parse(await read(f.registry)).activeId, 'default');
  await assert.rejects(createWorkspaceProfiles(f.options).initialize(), { code: 'WORKSPACE_REGISTRY_UNSAFE' });
});

test('post-rename read failure retains the committed profile and resolves on a clean restart', async t => {
  const f = await fixture(t), rename = fs.rename, open = fs.open, cause = injected('EIO', 'read'); let committed = false;
  const renameMock = t.mock.method(fs, 'rename', async (...args) => { await rename(...args); committed = true; });
  const openMock = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (committed && args[0] === f.registry) t.mock.method(handle, 'read', async () => { throw cause; });
    return handle;
  });
  const failure = await rejected(f.manager.activate(f.candidate)); renameMock.mock.restore(); openMock.mock.restore();
  diagnostic(failure, { code: 'WORKSPACE_REGISTRY_COMMIT_UNCERTAIN', stage: 'readback-registry', committed: true, cause });
  const saved = JSON.parse(await read(f.registry)); assert.notEqual(saved.activeId, 'default');
  assert.ok((await fs.lstat(path.join(f.profiles, saved.activeId))).isDirectory()); await noRegistryTemporary(f);
  const restarted = createWorkspaceProfiles(f.options); await restarted.initialize(); assert.equal((await restarted.getActive()).id, saved.activeId);
});

test('post-rename valid but different readback is not success and does not remove the committed new directory', async t => {
  const f = await fixture(t), rename = fs.rename;
  t.mock.method(fs, 'rename', async (...args) => { await rename(...args); await fs.writeFile(f.registry, f.before); });
  const failure = await rejected(f.manager.activate(f.candidate));
  diagnostic(failure, { code: 'WORKSPACE_REGISTRY_COMMIT_UNCERTAIN', stage: 'validate-readback', committed: true });
  assert.equal(await read(f.registry), f.before); assert.equal((await fs.readdir(f.profiles)).length, 1);
  await noRegistryTemporary(f);
});

test('new profile identity read failure retains an unverified directory with an explicit orphan path', async t => {
  const f = await fixture(t), mkdir = fs.mkdir, lstat = fs.lstat, cause = injected('EIO', 'lstat'); let directory, failed = false;
  t.mock.method(fs, 'mkdir', async (...args) => { const result = await mkdir(...args); if (path.dirname(args[0]) === f.profiles) directory = args[0]; return result; });
  const statMock = t.mock.method(fs, 'lstat', async (...args) => { if (args[0] === directory && !failed) { failed = true; throw cause; } return lstat(...args); });
  const failure = await rejected(f.manager.activate(f.candidate)); statMock.mock.restore();
  diagnostic(failure, { code: 'WORKSPACE_CLEANUP_INCOMPLETE', stage: 'prepare-profile', cause });
  assert.equal(failure.orphanPath, directory); assert.ok((await fs.lstat(directory)).isDirectory()); assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(await read(f.registry), f.before); assert.equal((await f.manager.getActive()).id, 'default'); await noRegistryTemporary(f);
});

test('new profile rmdir failure keeps the owned directory and preserves the original commit failure', async t => {
  const f = await fixture(t), rmdir = fs.rmdir, primary = injected('EACCES', 'rename'), cleanup = injected('EBUSY', 'rmdir'); let directory;
  t.mock.method(fs, 'rename', async () => { throw primary; });
  t.mock.method(fs, 'rmdir', async target => { if (path.dirname(target) === f.profiles) { directory = target; throw cleanup; } return rmdir(target); });
  const failure = await rejected(f.manager.activate(f.candidate));
  diagnostic(failure, { code: 'WORKSPACE_CLEANUP_INCOMPLETE', stage: 'rename-registry', cause: primary, cleanup: [{ stage: 'remove-profile', cause: cleanup }] });
  assert.equal(failure.orphanPath, directory); assert.ok((await fs.lstat(directory)).isDirectory());
  assert.equal(await read(f.registry), f.before); assert.equal((await f.manager.getActive()).id, 'default'); await noRegistryTemporary(f);
});

test('new profile replaced before failed activation cleanup is never deleted or adopted', async t => {
  const f = await fixture(t), rename = fs.rename, cause = injected('EACCES', 'rename'); let replaced, moved;
  t.mock.method(fs, 'rename', async () => {
    const names = await fs.readdir(f.profiles); assert.equal(names.length, 1);
    replaced = path.join(f.profiles, names[0]); moved = path.join(f.root, 'original-profile');
    await rename(replaced, moved); await fs.mkdir(replaced); await fs.writeFile(path.join(replaced, 'foreign.txt'), 'foreign content'); throw cause;
  });
  const failure = await rejected(f.manager.activate(f.candidate));
  diagnostic(failure, { code: 'WORKSPACE_CLEANUP_INCOMPLETE', stage: 'rename-registry', cause });
  assert.equal(failure.orphanPath, replaced); assert.equal(await read(path.join(replaced, 'foreign.txt')), 'foreign content');
  assert.ok((await fs.lstat(moved)).isDirectory()); assert.equal(await read(f.registry), f.before);
  assert.equal((await f.manager.getActive()).id, 'default'); assert.equal((await f.manager.list()).length, 1); await noRegistryTemporary(f);
});

test('temporary and new-profile cleanup failures preserve both retained paths and independent causes', async t => {
  const f = await fixture(t), unlink = fs.unlink, rmdir = fs.rmdir;
  const primary = injected('EACCES', 'rename'), fileFailure = injected('EBUSY', 'unlink'), directoryFailure = injected('EACCES', 'rmdir');
  let file, directory;
  t.mock.method(fs, 'rename', async source => { file = source; throw primary; });
  t.mock.method(fs, 'unlink', async target => { if (target === file) throw fileFailure; return unlink(target); });
  t.mock.method(fs, 'rmdir', async target => { if (path.dirname(target) === f.profiles) { directory = target; throw directoryFailure; } return rmdir(target); });
  const failure = await rejected(f.manager.activate(f.candidate));
  diagnostic(failure, { code: 'WORKSPACE_CLEANUP_INCOMPLETE', stage: 'rename-registry', cause: primary,
    cleanup: [{ stage: 'remove-temporary', cause: fileFailure }, { stage: 'remove-profile', cause: directoryFailure }] });
  assert.deepEqual(new Set(failure.retainedPaths), new Set([file, directory]));
  assert.ok((await fs.lstat(file)).isFile()); assert.ok((await fs.lstat(directory)).isDirectory());
  assert.equal(await read(f.registry), f.before); assert.equal((await f.manager.getActive()).id, 'default');
});

test('post-commit registry read and close failures preserve the read cause and committed state', async t => {
  const f = await fixture(t), rename = fs.rename, open = fs.open;
  const primary = injected('EIO', 'read'), cleanup = injected('EBADF', 'close'); let committed = false;
  const renameMock = t.mock.method(fs, 'rename', async (...args) => { await rename(...args); committed = true; });
  const openMock = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args); if (!committed || args[0] !== f.registry) return handle;
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'read', async () => { throw primary; });
    t.mock.method(handle, 'close', async () => { await close(); throw cleanup; });
    return handle;
  });
  const failure = await rejected(f.manager.activate(f.candidate)); renameMock.mock.restore(); openMock.mock.restore();
  diagnostic(failure, { code: 'WORKSPACE_REGISTRY_COMMIT_UNCERTAIN', stage: 'readback-registry', committed: true, cause: primary,
    cleanup: [{ stage: 'close-registry', cause: cleanup }] });
  const saved = JSON.parse(await read(f.registry)); assert.notEqual(saved.activeId, 'default');
  assert.ok((await fs.lstat(path.join(f.profiles, saved.activeId))).isDirectory()); await noRegistryTemporary(f);
  const restarted = createWorkspaceProfiles(f.options); await restarted.initialize(); assert.equal((await restarted.getActive()).id, saved.activeId);
});

for (const scenario of ['read', 'json']) test(`pre-commit registry ${scenario} and close failures do not hide the primary failure or write data`, async t => {
  const f = await fixture(t), open = fs.open, primary = injected('EIO', 'read'), cleanup = injected('EBADF', 'close');
  const expectedBytes = scenario === 'json' ? '{invalid registry json' : f.before;
  if (scenario === 'json') await fs.writeFile(f.registry, expectedBytes);
  const openMock = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args); if (args[0] !== f.registry) return handle;
    const close = handle.close.bind(handle);
    if (scenario === 'read') t.mock.method(handle, 'read', async () => { throw primary; });
    t.mock.method(handle, 'close', async () => { await close(); throw cleanup; });
    return handle;
  });
  const failure = await rejected(f.manager.activate('default')); openMock.mock.restore();
  diagnostic(failure, { code: scenario === 'read' ? 'WORKSPACE_REGISTRY_READ_FAILED' : 'WORKSPACE_REGISTRY_INVALID', stage: 'read-registry',
    ...(scenario === 'read' ? { cause: primary } : {}), cleanup: [{ stage: 'close-registry', cause: cleanup }] });
  if (scenario === 'json') {
    let original = failure, found = false;
    while (original) { if (original instanceof SyntaxError) { found = true; break; } original = original.cause; }
    assert.equal(found, true, 'The JSON parse failure remains in the cause chain');
  }
  assert.equal(await read(f.registry), expectedBytes); assert.equal((await f.manager.list()).length, 1);
  await missing(f.profiles); await noRegistryTemporary(f);
});
