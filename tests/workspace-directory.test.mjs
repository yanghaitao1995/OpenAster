// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { createWorkspace } from '../core/workspace.mjs';

const paths = result => result.files.map(file => file.path);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Filesystem gate did not settle')), 15000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t, options = {}) {
  const parent = await fs.realpath(tmpdir()), base = await fs.mkdtemp(path.join(parent, 'openaster-directory-'));
  const root = path.join(base, 'project'); await fs.mkdir(root);
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(base)), parent);
    assert.match(path.basename(base), /^openaster-directory-[A-Za-z0-9]+$/u);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { base, root, workspace: createWorkspace(root, { createRoot: false, ...options }) };
}
async function write(root, relative, content = 'needle') {
  const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
}
function patch(method, replacement) {
  const original = fs[method]; fs[method] = replacement(original); syncBuiltinESMExports();
  return () => { fs[method] = original; syncBuiltinESMExports(); };
}

test('children listing never opens descendants or reads descendant ignore policy; list and search remain recursive', async t => {
  const { root, workspace } = await fixture(t, { projectScan: true });
  for (const [name, content] of Object.entries({ '.gitignore': '*.log\n', 'README.md': 'needle', 'a/child.txt': 'needle', 'a/.gitignore': '\0', 'z/deep/child.txt': 'needle' })) await write(root, name, content);
  const opened = [], read = [];
  const restoreDirectory = patch('opendir', original => async function (target, ...args) { opened.push(path.relative(root, target)); return original.call(this, target, ...args); });
  const restoreOpen = patch('open', original => async function (target, ...args) { read.push(path.relative(root, target)); return original.call(this, target, ...args); });
  let result;
  try { result = await workspace.directory(); } finally { restoreOpen(); restoreDirectory(); }
  assert.equal(result.version, 1); assert.equal(result.listing, 'children'); assert.equal(result.scope, '');
  assert.deepEqual(paths(result), ['.gitignore', 'README.md', 'a', 'z']);
  assert.deepEqual(opened, ['']); assert.deepEqual(read, ['.gitignore', '.gitignore']);
  assert.equal(result.scan.visitedEntries, 4); assert.equal(result.scan.ignore.files, 1); assert.equal(result.truncated, false);
  await assert.rejects(workspace.list(), { code: 'GITIGNORE_INVALID' });
  await fs.writeFile(path.join(root, 'a/.gitignore'), '');
  const recursive = await workspace.list({ recursive: false });
  assert.ok(paths(recursive).includes('z/deep/child.txt'), 'No caller-facing recursive switch changes the model inventory');
  assert.equal(Object.hasOwn(recursive, 'listing'), false);
  assert.deepEqual((await workspace.search('needle')).matches.map(match => match.path), ['README.md', 'a/child.txt', 'z/deep/child.txt']);
});

test('scoped children inherit root and scope rules without opening an ignored scope or its child rules', async t => {
  const { root, workspace } = await fixture(t, { projectScan: true });
  for (const [name, content] of Object.entries({ '.gitignore': '/src/root-hidden.txt\n', 'src/.gitignore': '*.tmp\n!keep.tmp\nhidden/\n', 'src/root-hidden.txt': '', 'src/a.tmp': '', 'src/keep.tmp': '', 'src/good.txt': '', 'src/folder/.gitignore': '\0', 'src/hidden/.gitignore': '\0', 'src/hidden/hidden.txt': '' })) await write(root, name, content);
  const result = await workspace.directory({ path: 'src' });
  assert.deepEqual(paths(result), ['src/.gitignore', 'src/folder', 'src/good.txt', 'src/keep.tmp']);
  assert.equal(result.scope, 'src'); assert.equal(result.scan.ignore.files, 2);
  assert.equal(result.scan.ignore.ignoredFiles, 2); assert.equal(result.scan.ignore.ignoredDirectories, 1);
  const restore = patch('opendir', original => async function (target, ...args) { assert.notEqual(key(target), key(path.join(root, 'src/hidden'))); return original.call(this, target, ...args); });
  try {
    const ignored = await workspace.directory({ path: 'src/hidden' });
    assert.deepEqual(ignored.files, []); assert.equal(ignored.scan.ignore.scopeIgnored, true); assert.equal(ignored.scan.visitedEntries, 0); assert.equal(ignored.truncated, false);
  } finally { restore(); }
  const included = await workspace.directory({ path: 'src/hidden', includeIgnored: true });
  assert.deepEqual(paths(included), ['src/hidden/.gitignore', 'src/hidden/hidden.txt']);
  assert.deepEqual(included.scan.ignore, { enabled: false, includeIgnored: true, caseSensitive: true, files: 0, rules: 0, bytes: 0, ignoredFiles: 0, ignoredDirectories: 0, scopeIgnored: false });
});

test('generated and ignored switches are independent and cannot reveal sensitive paths', async t => {
  const { root, workspace } = await fixture(t, { projectScan: true, denySensitivePaths: true });
  for (const [name, content] of Object.entries({ '.gitignore': 'ignored/\n', '.env': '', '.env.example': '', '.git/config': '', 'node_modules/a.txt': '', 'node_modules/nested/b.txt': '', 'ignored/a.txt': '', 'ordinary/a.txt': '' })) await write(root, name, content);
  assert.deepEqual(paths(await workspace.directory()), ['.env.example', '.gitignore', 'ordinary']);
  assert.deepEqual(paths(await workspace.directory({ includeGenerated: true })), ['.env.example', '.gitignore', 'node_modules', 'ordinary']);
  assert.deepEqual(paths(await workspace.directory({ includeIgnored: true })), ['.env.example', '.gitignore', 'ignored', 'ordinary']);
  assert.deepEqual(paths(await workspace.directory({ path: 'node_modules' })), ['node_modules/a.txt', 'node_modules/nested']);
  for (const scope of ['.git', '../outside', 'ordinary/../ignored', '/absolute', 'ordinary\\child']) await assert.rejects(workspace.directory({ path: scope }), error => ['SENSITIVE_PATH', 'INVALID_PATH'].includes(error.code));
  await assert.rejects(workspace.directory({ path: '.env.example' }), { code: 'NOT_DIRECTORY' });
  await assert.rejects(workspace.directory({ path: 'missing' }), { code: 'FILE_NOT_FOUND' });
  for (const value of [null, [], { path: null }, { includeGenerated: 'true' }, { includeIgnored: 1 }]) await assert.rejects(workspace.directory(value), error => ['INVALID_SCAN_OPTIONS', 'INVALID_PATH'].includes(error.code));
});

test('independent workspaces leave ignore rules disabled and each call observes file and rule changes', async t => {
  const { root } = await fixture(t);
  const workspace = createWorkspace(root, { createRoot: false, projectScan: true });
  await write(root, '.gitignore', 'old.txt\n'); await write(root, 'old.txt'); await write(root, 'new.txt');
  assert.deepEqual(paths(await workspace.directory()), ['.gitignore', 'new.txt']);
  await fs.writeFile(path.join(root, '.gitignore'), 'new.txt\n'); await fs.unlink(path.join(root, 'old.txt')); await write(root, 'added.txt');
  assert.deepEqual(paths(await workspace.directory()), ['.gitignore', 'added.txt']);
  await fs.unlink(path.join(root, '.gitignore'));
  assert.deepEqual(paths(await workspace.directory()), ['added.txt', 'new.txt']);
  await write(root, '.gitignore', '\0');
  const independent = await createWorkspace(root, { createRoot: false }).directory();
  assert.deepEqual(paths(independent), ['.gitignore', 'added.txt', 'new.txt']); assert.equal(independent.scan.ignore.enabled, false);
});

test('final verification rejects both changed and newly created rules during a child listing', async t => {
  const { root, workspace } = await fixture(t, { projectScan: true }); await write(root, 'safe.txt');
  for (const initiallyPresent of [false, true]) {
    if (initiallyPresent) await write(root, '.gitignore', '# initial\n');
    let changed = false;
    const restore = patch('opendir', original => async function (target, ...args) {
      if (key(target) === key(root) && !changed) { changed = true; await fs.writeFile(path.join(root, '.gitignore'), 'safe.txt\n'); }
      return original.call(this, target, ...args);
    });
    try { await assert.rejects(workspace.directory(), { code: 'GITIGNORE_CHANGED' }); } finally { restore(); }
    assert.equal(changed, true); await fs.unlink(path.join(root, '.gitignore'));
  }
});

test('root replacement during directory enumeration remains fatal and the replacement is never rebound', async t => {
  const { base, root, workspace } = await fixture(t); await write(root, 'old.txt'); await workspace.getIdentity();
  let changed = false;
  const restore = patch('opendir', original => async function (target, ...args) {
    if (key(target) === key(root) && !changed) { changed = true; await fs.rename(root, path.join(base, 'moved-project')); await fs.mkdir(root); await write(root, 'replacement.txt'); }
    return original.call(this, target, ...args);
  });
  try { await assert.rejects(workspace.directory(), { code: 'WORKSPACE_CHANGED' }); } finally { restore(); }
  await assert.rejects(workspace.directory(), { code: 'WORKSPACE_CHANGED' });
  assert.equal(await fs.readFile(path.join(root, 'replacement.txt'), 'utf8'), 'needle');
});

test('hardlinks and directory links are skipped and cannot be used as a scope', async t => {
  const { base, root, workspace } = await fixture(t, { denySensitivePaths: true });
  await write(root, 'safe.txt'); await write(base, 'outside/secret.txt');
  await fs.link(path.join(base, 'outside/secret.txt'), path.join(root, 'linked.txt'));
  await fs.symlink(path.join(base, 'outside'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await workspace.directory({ includeGenerated: true, includeIgnored: true });
  assert.deepEqual(paths(result), ['safe.txt']); assert.equal(result.scan.skippedEntries, 2);
  await assert.rejects(workspace.directory({ path: 'alias' }), { code: 'UNSAFE_PATH' });
  await assert.rejects(workspace.directory({ path: 'linked.txt' }), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(path.join(base, 'outside/secret.txt'), 'utf8'), 'needle');
});

test('999 and 1000 direct entries are complete; the next legal sibling alone triggers the output cap', { timeout: 60000 }, async t => {
  const { root, workspace } = await fixture(t, { createRoot: true });
  for (let start = 0; start < 999; start += 64) await Promise.all(Array.from({ length: Math.min(64, 999 - start) }, (_, offset) => write(root, `file-${String(start + offset).padStart(4, '0')}.txt`, '')));
  for (const count of [999, 1000, 1001]) {
    if (count > 999) await write(root, `file-${String(count - 1).padStart(4, '0')}.txt`, '');
    const result = await workspace.directory();
    assert.equal(result.files.length, Math.min(count, 1000)); assert.equal(result.truncated, count > 1000);
    assert.deepEqual(result.scan.limits, count > 1000 ? ['entries'] : []); assert.equal(result.scan.visitedEntries, count);
  }
});

test('entry budget counts only observed direct dirents and reports its extra lookahead', { timeout: 60000 }, async t => {
  const { root, workspace } = await fixture(t, { createRoot: true });
  for (let start = 0; start < 10001; start += 128) await Promise.all(Array.from({ length: Math.min(128, 10001 - start) }, (_, offset) => write(root, `.openaster-hidden-${start + offset}`, '')));
  const result = await workspace.directory();
  assert.equal(result.files.length, 0); assert.equal(result.scan.visitedEntries, 10001); assert.equal(result.scan.skippedEntries, 10000);
  assert.deepEqual(result.scan.limits, ['directory-entries']); assert.equal(result.truncated, true);
});

test('depth is relative to the workspace boundary and does not count unvisited grandchildren', async t => {
  const { root, workspace } = await fixture(t);
  const scope = Array.from({ length: 15 }, (_, index) => `d${index}`).join('/');
  await write(root, `${scope}/last/deeper.txt`);
  const permitted = await workspace.directory({ path: scope });
  assert.deepEqual(paths(permitted), [`${scope}/last`]); assert.deepEqual(permitted.scan.limits, []); assert.equal(permitted.truncated, false);
  const bounded = await workspace.directory({ path: `${scope}/last` });
  assert.deepEqual(bounded.files, []); assert.deepEqual(bounded.scan.limits, ['depth']); assert.equal(bounded.scan.skippedEntries, 1);
});

test('cancelled child metadata batches drain all started work without probing the next sibling', async t => {
  const { root, workspace } = await fixture(t);
  for (const name of ['a', 'b', 'c', 'd', 'e']) await write(root, name);
  const controller = new AbortController(), gates = new Map(['a', 'b', 'c', 'd'].map(name => [name, { entered: deferred(), release: deferred() }]));
  const seen = new Set(); let active = 0, settled = false;
  const restore = patch('lstat', original => async function (target, options) {
    const name = !options?.bigint && path.dirname(key(target)) === key(root) ? path.basename(target) : null;
    if (!name || seen.has(name)) return original.call(this, target, options);
    seen.add(name); const gate = gates.get(name); active++;
    try { if (gate) { gate.entered.resolve(); await gate.release.promise; } return await original.call(this, target, options); }
    finally { active--; }
  });
  const operation = workspace.directory({ signal: controller.signal }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  try {
    await within(Promise.all([...gates.values()].map(gate => gate.entered.promise))); assert.equal(active, 4); controller.abort();
    for (const name of ['b', 'c', 'd']) gates.get(name).release.resolve();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(seen.has('e'), false);
    gates.get('a').release.resolve(); assert.equal((await within(operation)).error?.code, 'CANCELLED'); assert.equal(active, 0); assert.equal(seen.has('e'), false);
    await assert.rejects(workspace.directory({ signal: controller.signal }), { code: 'CANCELLED' });
  } finally { for (const gate of gates.values()) gate.release.resolve(); await within(operation); restore(); }
});
