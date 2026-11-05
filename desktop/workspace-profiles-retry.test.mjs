// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceProfiles } from './workspace-profiles.mjs';

const temporary = value => /^\.workspaces-[0-9a-f-]+\.tmp$/.test(path.basename(String(value)));
const nativeError = (code, syscall = 'rename') => Object.assign(new Error(`injected ${code}`), { code, syscall });
const text = file => fs.readFile(file, 'utf8');
const failureOf = async promise => { let caught; await assert.rejects(promise, error => { caught = error; return true; }); return caught; };
function chainContains(error, expected) {
  const seen = new Set();
  while (error && !seen.has(error)) { if (error === expected) return true; seen.add(error); error = error.cause; }
  return false;
}
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-registry-retry-'));
  const identity = await fs.lstat(root, { bigint: true });
  t.after(async () => {
    t.mock.restoreAll();
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.ok(!current.isSymbolicLink());
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const userData = path.join(root, 'data'), homeDirectory = path.join(root, 'home'), install = path.join(root, 'install'), workspace = path.join(root, 'project');
  for (const directory of [userData, homeDirectory, install, workspace]) await fs.mkdir(directory);
  const options = { userData, homeDirectory, appRoots: [install] }, manager = createWorkspaceProfiles(options);
  await manager.initialize();
  const registry = path.join(userData, 'workspaces.json'), candidate = await manager.inspect(workspace), before = await text(registry);
  return { root, userData, workspace, options, manager, registry, candidate, before, profiles: path.join(userData, 'profiles') };
}
async function intact(f) {
  assert.equal(await text(f.registry), f.before);
  assert.equal((await f.manager.getActive()).id, 'default');
  assert.deepEqual(await fs.readdir(f.profiles), []);
  assert.deepEqual((await fs.readdir(f.userData)).filter(temporary), []);
}
function delays(t) {
  const recorded = [], original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    recorded.push(milliseconds); return original(callback, milliseconds, ...args);
  });
  return recorded;
}
const windowsOnly = { skip: process.platform !== 'win32' ? 'Windows-only EPERM recovery branch' : false };

test('Windows EPERM replacement retries once only after rereading both original registry and exact temporary bytes', windowsOnly, async t => {
  const f = await fixture(t), rename = fs.rename, open = fs.open, waits = delays(t);
  let attempts = 0; const reads = [];
  t.mock.method(fs, 'rename', async (...args) => { if (++attempts === 1) throw nativeError('EPERM'); return rename(...args); });
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (attempts === 1) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...values) => { reads.push(args[0]); return read(...values); });
    }
    return handle;
  });
  const selected = await f.manager.activate(f.candidate);
  assert.equal(attempts, 2); assert.deepEqual(waits, [25]);
  assert.ok(reads.includes(f.registry)); assert.ok(reads.some(temporary));
  assert.equal(JSON.parse(await text(f.registry)).activeId, selected.id);
  assert.deepEqual((await fs.readdir(f.userData)).filter(temporary), []);
  const restarted = createWorkspaceProfiles(f.options); await restarted.initialize(); assert.equal((await restarted.getActive()).id, selected.id);
});

test('Windows recovery permits at most three delayed retries and then can commit', windowsOnly, async t => {
  const f = await fixture(t), rename = fs.rename, waits = delays(t); let attempts = 0;
  t.mock.method(fs, 'rename', async (...args) => { if (++attempts <= 3) throw nativeError('EPERM'); return rename(...args); });
  const selected = await f.manager.activate(f.candidate);
  assert.equal(attempts, 4); assert.deepEqual(waits, [25, 75, 150]);
  assert.equal(JSON.parse(await text(f.registry)).activeId, selected.id);
});

test('exhausted EPERM retries keep the first native cause and remove only unchanged owned temporary/profile data', windowsOnly, async t => {
  const f = await fixture(t), waits = delays(t), causes = [];
  t.mock.method(fs, 'rename', async () => { const cause = nativeError('EPERM'); causes.push(cause); throw cause; });
  const error = await failureOf(f.manager.activate(f.candidate));
  assert.equal(causes.length, 4); assert.deepEqual(waits, [25, 75, 150]);
  assert.equal(error.code, 'WORKSPACE_REGISTRY_WRITE_FAILED'); assert.ok(chainContains(error, causes[0]));
  assert.deepEqual(error.registryDiagnostic, { version: 1, stage: 'rename-registry', committed: false, systemCode: 'EPERM', syscall: 'rename' });
  await intact(f);
});

test('exhausted EPERM plus cleanup failure retains independent diagnostics and the owned temporary', windowsOnly, async t => {
  const f = await fixture(t), unlink = fs.unlink, primary = nativeError('EPERM'), cleanup = nativeError('EBUSY', 'unlink'); let file, attempts = 0;
  t.mock.method(fs, 'rename', async source => { file = source; attempts++; throw primary; });
  t.mock.method(fs, 'unlink', async target => { if (target === file) throw cleanup; return unlink(target); });
  const error = await failureOf(f.manager.activate(f.candidate));
  assert.equal(attempts, 4); assert.equal(error.code, 'WORKSPACE_CLEANUP_INCOMPLETE'); assert.ok(chainContains(error, primary));
  assert.equal(error.registryDiagnostic.stage, 'rename-registry'); assert.equal(error.registryDiagnostic.systemCode, 'EPERM');
  assert.ok(error.registryDiagnostic.cleanup.some(item => item.stage === 'remove-temporary' && item.systemCode === 'EBUSY' && item.syscall === 'unlink'));
  assert.equal(Object.getOwnPropertyDescriptor(error, 'cleanupCauses').enumerable, false); assert.ok(error.cleanupCauses.includes(cleanup));
  assert.ok(error.retainedPaths.includes(file)); assert.ok((await fs.lstat(file)).isFile());
  assert.equal(await text(f.registry), f.before); assert.deepEqual(await fs.readdir(f.profiles), []);
});

for (const code of ['EACCES', 'EBUSY', 'EIO']) test(`${code} replacement errors are not retried`, async t => {
  const f = await fixture(t), cause = nativeError(code), waits = delays(t); let attempts = 0;
  t.mock.method(fs, 'rename', async () => { attempts++; throw cause; });
  const error = await failureOf(f.manager.activate(f.candidate));
  assert.equal(attempts, 1); assert.deepEqual(waits, []); assert.ok(chainContains(error, cause)); await intact(f);
});

test('non-Windows EPERM is not retried (platform gate simulation)', async t => {
  const f = await fixture(t), original = Object.getOwnPropertyDescriptor(process, 'platform'), waits = delays(t); let attempts = 0;
  t.mock.method(fs, 'rename', async () => { attempts++; Object.defineProperty(process, 'platform', { ...original, value: 'linux' }); throw nativeError('EPERM'); });
  try {
    const error = await failureOf(f.manager.activate(f.candidate));
    assert.equal(error.code, 'WORKSPACE_REGISTRY_WRITE_FAILED'); assert.equal(attempts, 1); assert.deepEqual(waits, []);
  } finally { Object.defineProperty(process, 'platform', original); }
  await intact(f);
});

for (const replace of [false, true]) test(`registry ${replace ? 'identity replacement' : 'same-inode byte change'} during backoff stops before any retry`, windowsOnly, async t => {
  const f = await fixture(t), rename = fs.rename; let attempts = 0;
  const foreign = f.before + '\n';
  t.mock.method(fs, 'rename', async () => {
    attempts++;
    if (replace) await rename(f.registry, path.join(f.root, 'previous-registry.json'));
    await fs.writeFile(f.registry, foreign); throw nativeError('EPERM');
  });
  const error = await failureOf(f.manager.activate(f.candidate));
  assert.equal(error.code, 'WORKSPACE_REGISTRY_CHANGED'); assert.equal(error.registryDiagnostic.stage, 'verify-before-commit'); assert.equal(attempts, 1);
  assert.equal(await text(f.registry), foreign); assert.deepEqual((await fs.readdir(f.userData)).filter(temporary), []);
  assert.deepEqual(await fs.readdir(f.profiles), []);
});

for (const kind of ['content', 'identity', 'hardlink']) test(`temporary ${kind} change during backoff is never installed or deleted`, windowsOnly, async t => {
  const f = await fixture(t), rename = fs.rename; let attempts = 0, file, foreign, original;
  t.mock.method(fs, 'rename', async source => {
    attempts++; file = source; original = await text(file);
    if (kind === 'content') { foreign = '[' + original.slice(1); await fs.writeFile(file, foreign); }
    if (kind === 'identity') { await rename(file, path.join(f.root, 'moved-owned.tmp')); foreign = original; await fs.writeFile(file, foreign, { flag: 'wx' }); }
    if (kind === 'hardlink') { foreign = original; await fs.link(file, path.join(f.root, 'other-link.tmp')); }
    throw nativeError('EPERM');
  });
  const error = await failureOf(f.manager.activate(f.candidate));
  assert.equal(attempts, 1); assert.equal(error.code, 'WORKSPACE_CLEANUP_INCOMPLETE'); assert.equal(error.registryDiagnostic.stage, 'inspect-before-commit');
  assert.ok(error.retainedPaths.includes(file)); assert.equal(await text(file), foreign); assert.equal(await text(f.registry), f.before);
  assert.deepEqual(await fs.readdir(f.profiles), []);
  if (kind === 'identity') assert.equal(await text(path.join(f.root, 'moved-owned.tmp')), original);
  if (kind === 'hardlink') assert.equal((await fs.lstat(file)).nlink, 2);
});

test('replacing the parent root during backoff preserves both old owned data and foreign replacement markers', windowsOnly, async t => {
  const f = await fixture(t), rename = fs.rename; let attempts = 0, file;
  const moved = path.join(f.root, 'moved-data');
  t.mock.method(fs, 'rename', async source => {
    attempts++; file = source; await rename(f.userData, moved); await fs.mkdir(f.userData);
    await fs.writeFile(f.registry, 'foreign registry'); await fs.writeFile(file, 'foreign temporary'); throw nativeError('EPERM');
  });
  const error = await failureOf(f.manager.activate(f.candidate));
  assert.equal(attempts, 1); assert.equal(error.code, 'WORKSPACE_CLEANUP_INCOMPLETE'); assert.equal(error.registryDiagnostic.stage, 'verify-before-commit');
  assert.equal(await text(f.registry), 'foreign registry'); assert.equal(await text(file), 'foreign temporary');
  assert.equal(await text(path.join(moved, 'workspaces.json')), f.before); assert.ok((await fs.lstat(path.join(moved, path.basename(file)))).isFile());
});

test('temporary byte mutation after verification closes is caught by the final named-file check', windowsOnly, async t => {
  const f = await fixture(t), open = fs.open; let attempts = 0, file, foreign, mutated = false;
  t.mock.method(fs, 'rename', async source => { attempts++; file = source; throw nativeError('EPERM'); });
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (attempts === 1 && args[0] === file && !mutated) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); mutated = true; foreign = 'foreign bytes after closed verification'; await fs.writeFile(file, foreign); });
    }
    return handle;
  });
  const error = await failureOf(f.manager.activate(f.candidate));
  assert.equal(attempts, 1); assert.equal(error.code, 'WORKSPACE_CLEANUP_INCOMPLETE'); assert.equal(error.registryDiagnostic.stage, 'inspect-before-commit');
  assert.equal(await text(file), foreign); assert.equal(await text(f.registry), f.before);
});

test('retry verification read and close failures preserve the primary read and secondary close diagnostics', windowsOnly, async t => {
  const f = await fixture(t), open = fs.open, primary = nativeError('EIO', 'read'), cleanup = nativeError('EBADF', 'close');
  let attempts = 0, injected = false;
  t.mock.method(fs, 'rename', async () => { attempts++; throw nativeError('EPERM'); });
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (attempts === 1 && temporary(args[0]) && !injected) {
      injected = true; const close = handle.close.bind(handle);
      t.mock.method(handle, 'read', async () => { throw primary; });
      t.mock.method(handle, 'close', async () => { await close(); throw cleanup; });
    }
    return handle;
  });
  const error = await failureOf(f.manager.activate(f.candidate));
  assert.equal(attempts, 1); assert.ok(chainContains(error, primary)); assert.equal(error.registryDiagnostic.stage, 'inspect-before-commit');
  assert.equal(error.registryDiagnostic.systemCode, 'EIO'); assert.ok(error.cleanupCauses.includes(cleanup));
  assert.ok(error.registryDiagnostic.cleanup.some(item => item.stage === 'close-temporary' && item.systemCode === 'EBADF'));
  await intact(f);
});

test('failed retry-verification close gets a final cleanup attempt without another rename', windowsOnly, async t => {
  const f = await fixture(t), open = fs.open, primary = nativeError('EIO', 'close'); let attempts = 0, closes = 0, checked;
  t.mock.method(fs, 'rename', async () => { attempts++; throw nativeError('EPERM'); });
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (attempts === 1 && temporary(args[0]) && !checked) {
      checked = handle; const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { if (++closes === 1) throw primary; return close(); });
    }
    return handle;
  });
  const error = await failureOf(f.manager.activate(f.candidate));
  assert.equal(attempts, 1); assert.equal(closes, 2); assert.equal(checked.fd, -1); assert.ok(chainContains(error, primary));
  assert.equal(error.registryDiagnostic.stage, 'inspect-before-commit'); assert.equal(error.registryDiagnostic.syscall, 'close');
  await intact(f);
});

test('an EPERM readback after successful replacement is committed uncertainty and never retries replacement', async t => {
  const f = await fixture(t), rename = fs.rename, open = fs.open; let attempts = 0, committed = false;
  const renameMock = t.mock.method(fs, 'rename', async (...args) => { attempts++; await rename(...args); committed = true; });
  const openMock = t.mock.method(fs, 'open', async (...args) => { if (committed && args[0] === f.registry) throw nativeError('EPERM', 'open'); return open(...args); });
  const error = await failureOf(f.manager.activate(f.candidate)); renameMock.mock.restore(); openMock.mock.restore();
  assert.equal(attempts, 1); assert.equal(error.code, 'WORKSPACE_REGISTRY_COMMIT_UNCERTAIN'); assert.equal(error.committed, true);
  assert.equal(error.registryDiagnostic.stage, 'readback-registry'); assert.notEqual(JSON.parse(await text(f.registry)).activeId, 'default');
  assert.equal((await fs.readdir(f.profiles)).length, 1);
});

test('initial installation EPERM remains a single link failure without replacement retries', async t => {
  const f = await fixture(t); await fs.unlink(f.registry);
  const manager = createWorkspaceProfiles(f.options), waits = delays(t); let links = 0, renames = 0;
  t.mock.method(fs, 'link', async () => { links++; throw nativeError('EPERM', 'link'); });
  t.mock.method(fs, 'rename', async () => { renames++; throw new Error('Unexpected replacement'); });
  const error = await failureOf(manager.initialize());
  assert.equal(error.code, 'WORKSPACE_REGISTRY_WRITE_FAILED'); assert.equal(error.registryDiagnostic.stage, 'link-registry');
  assert.equal(links, 1); assert.equal(renames, 0); assert.deepEqual(waits, []);
  await assert.rejects(fs.lstat(f.registry), { code: 'ENOENT' }); assert.deepEqual((await fs.readdir(f.userData)).filter(temporary), []);
});
