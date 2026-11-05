import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkspace, MAX_FILE_BYTES } from '../core/workspace.mjs';

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'openaster-scan-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  return { base, root, workspace: createWorkspace(root, { createRoot: false, denySensitivePaths: true, projectScan: true, ...options }) };
}

async function write(root, relative, content = 'needle') {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function manyFiles(directory, count, prefix = 'file-', content = '') {
  await fs.mkdir(directory, { recursive: true });
  for (let offset = 0; offset < count; offset += 64) {
    await Promise.all(Array.from({ length: Math.min(64, count - offset) }, (_, index) => fs.writeFile(path.join(directory, `${prefix}${String(offset + index).padStart(5, '0')}.txt`), content)));
  }
}

async function withDirectoryEntries(root, hook, run) {
  const directory = await fs.opendir(root);
  const prototype = Object.getPrototypeOf(directory);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, Symbol.asyncIterator);
  await directory.close();
  Object.defineProperty(prototype, Symbol.asyncIterator, { ...descriptor, value: async function* () {
    for await (const entry of descriptor.value.call(this)) {
      await hook(this.path, entry);
      yield entry;
    }
  } });
  try { return await run(); }
  finally { Object.defineProperty(prototype, Symbol.asyncIterator, descriptor); }
}

test('project scan is opt-in and scan options reject nonboolean controls and invalid scopes', async t => {
  const { root } = await fixture(t);
  for (const projectScan of [null, 1, 'true', []]) assert.throws(() => createWorkspace(root, { projectScan }), { code: 'INVALID_WORKSPACE' });
  const legacy = createWorkspace(root);
  await write(root, 'node_modules/package/index.js');
  const inventory = await legacy.list();
  assert.deepEqual(inventory.files.map(file => file.path), ['node_modules', 'node_modules/package', 'node_modules/package/index.js']);
  assert.equal(inventory.scope, '');
  assert.deepEqual(inventory.scan, { projectMode: false, includeGenerated: false, excludedDirectories: 0, skippedEntries: 0, visitedEntries: 3, limits: [], ignore: { enabled: false, includeIgnored: false, caseSensitive: true, files: 0, rules: 0, bytes: 0, ignoredFiles: 0, ignoredDirectories: 0, scopeIgnored: false } });
  for (const options of [null, [], { includeGenerated: null }, { includeGenerated: 'true' }, { includeGenerated: 1 }]) {
    await assert.rejects(legacy.list(options), { code: 'INVALID_SCAN_OPTIONS' });
    await assert.rejects(legacy.search('needle', options), { code: 'INVALID_SCAN_OPTIONS' });
  }
  for (const scope of [null, 1, '.', '..', 'a/../b', '/absolute', 'a\\b', '.git/../safe']) {
    await assert.rejects(legacy.list({ path: scope }), { code: 'INVALID_PATH' });
    await assert.rejects(legacy.search('needle', { path: scope }), { code: 'INVALID_PATH' });
  }
});

test('project exclusions cover named directories and apply gitignore independently of generated-directory overrides', async t => {
  const { root, workspace } = await fixture(t);
  const generated = ['node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.cache', '.next', '.nuxt', '.turbo', 'coverage', 'dist', 'build', 'target', 'vendor'];
  for (const directory of generated) await write(root, `${directory}/generated.txt`);
  await write(root, '.gitignore', 'source.txt');
  await write(root, 'source.txt');
  await write(root, 'ordinary/dist', 'a file, not a directory');
  const result = await workspace.list();
  assert.deepEqual(result.files.map(file => file.path), ['.gitignore', 'ordinary', 'ordinary/dist']);
  assert.deepEqual(result.scan, { projectMode: true, includeGenerated: false, excludedDirectories: 14, skippedEntries: 0, visitedEntries: 18, limits: [], ignore: { enabled: true, includeIgnored: false, caseSensitive: true, files: 1, rules: 1, bytes: 10, ignoredFiles: 1, ignoredDirectories: 0, scopeIgnored: false } });
  assert.equal(result.truncated, false);
  const all = await workspace.list({ includeGenerated: true });
  assert.equal(all.files.length, 31);
  assert.equal(all.scan.excludedDirectories, 0);
  assert.equal(all.scan.includeGenerated, true);
  assert.equal(all.scan.visitedEntries, 32);
});

test('more than a thousand dependency files cannot consume the default project inventory', async t => {
  const { root, workspace } = await fixture(t);
  await manyFiles(path.join(root, 'node_modules'), 1100);
  await write(root, 'README.md');
  await write(root, 'src/index.js');
  const inventory = await workspace.list();
  assert.deepEqual(inventory.files.map(file => file.path), ['README.md', 'src', 'src/index.js']);
  assert.equal(inventory.scan.excludedDirectories, 1);
  assert.equal(inventory.scan.visitedEntries, 4);
  assert.equal(inventory.truncated, false);
  const search = await workspace.search('needle');
  assert.equal(search.searchedFiles, 2);
  assert.deepEqual(search.matches.map(match => match.path), ['README.md', 'src/index.js']);
  const explicit = await workspace.list({ path: 'node_modules' });
  assert.equal(explicit.scope, 'node_modules');
  assert.equal(explicit.files.length, 1000);
  assert.equal(explicit.scan.excludedDirectories, 0);
  assert.deepEqual(explicit.scan.limits, ['entries']);
  assert.equal(explicit.scan.visitedEntries, 1100);
  assert.ok(explicit.files.every(file => file.path.startsWith('node_modules/')));
  const all = await workspace.list({ includeGenerated: true });
  assert.equal(all.files.length, 1000);
  assert.ok(all.files.some(file => file.path === 'README.md'));
  assert.ok(all.files.some(file => file.path === 'src'));
  assert.deepEqual(all.scan.limits, ['entries']);
});

test('explicit generated scopes work without an override and keep nested exclusions independent', async t => {
  const { root, workspace } = await fixture(t);
  await write(root, 'node_modules/package/index.js');
  await write(root, 'node_modules/package/dist/bundle.js');
  await write(root, 'node_modules/package/.env', 'secret');
  const scoped = await workspace.list({ path: 'node_modules/package' });
  assert.deepEqual(scoped.files.map(file => file.path), ['node_modules/package/index.js']);
  assert.equal(scoped.scan.excludedDirectories, 1);
  assert.equal(scoped.scan.skippedEntries, 1);
  const direct = await workspace.list({ path: 'node_modules/package/dist' });
  assert.deepEqual(direct.files.map(file => file.path), ['node_modules/package/dist/bundle.js']);
  const all = await workspace.search('needle', { path: 'node_modules/package', includeGenerated: true });
  assert.deepEqual(all.matches.map(match => match.path), ['node_modules/package/index.js', 'node_modules/package/dist/bundle.js']);
  assert.equal(all.scope, 'node_modules/package');
  assert.equal(all.searchedFiles, 2);
  assert.equal(all.scan.skippedEntries, 1);
});

test('scan preferences never restrict known generated files or bypass approval writes', async t => {
  const { root, workspace } = await fixture(t);
  await write(root, 'dist/result.txt', 'before');
  assert.deepEqual((await workspace.list()).files, []);
  assert.equal((await workspace.read('dist/result.txt')).content, 'before');
  const proposal = await workspace.prepareWrite({ path: 'dist/result.txt', content: 'after approval' });
  assert.equal(await fs.readFile(path.join(root, 'dist/result.txt'), 'utf8'), 'before');
  await workspace.commitWrite(proposal);
  assert.equal((await workspace.read('dist/result.txt')).content, 'after approval');
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('scope must be an existing safe directory and includeGenerated never overrides sensitive paths', async t => {
  const { base, root, workspace } = await fixture(t);
  await write(root, 'file.txt');
  await write(root, '.git/config', 'secret');
  await write(root, 'dist/.env', 'secret');
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const [scope, code] of [['file.txt', 'NOT_DIRECTORY'], ['missing', 'FILE_NOT_FOUND'], ['.git', 'SENSITIVE_PATH'], ['dist/.env', 'SENSITIVE_PATH'], ['linked', 'UNSAFE_PATH'], ['../outside', 'INVALID_PATH']]) {
    await assert.rejects(workspace.list({ path: scope, includeGenerated: true }), { code });
    await assert.rejects(workspace.search('secret', { path: scope, includeGenerated: true }), { code });
  }
  const all = await workspace.list({ includeGenerated: true });
  assert.deepEqual(all.files.map(file => file.path), ['dist', 'file.txt']);
  assert.equal(all.scan.skippedEntries, 3);
  assert.equal(all.scan.excludedDirectories, 0);
  assert.deepEqual((await workspace.search('secret', { includeGenerated: true })).matches, []);
});

test('directory scopes preserve full workspace-relative paths and search only their contents', async t => {
  const { root, workspace } = await fixture(t);
  await write(root, 'top.txt');
  await write(root, 'src/a.txt', 'line one\nNeedle here');
  await write(root, 'src/nested/b.txt', 'needle');
  await write(root, 'other/c.txt');
  const scoped = await workspace.list({ path: 'src' });
  assert.equal(scoped.name, 'project');
  assert.equal(scoped.scope, 'src');
  assert.deepEqual(scoped.files.map(file => file.path), ['src/a.txt', 'src/nested', 'src/nested/b.txt']);
  const result = await workspace.search('needle', { path: 'src' });
  assert.deepEqual(result.matches, [
    { path: 'src/a.txt', line: 2, text: 'Needle here', sha256: (await workspace.read('src/a.txt')).sha256,
      matchStart: 0, matchEnd: 6, excerptStart: 0, excerptEnd: 11, lineLength: 11 },
    { path: 'src/nested/b.txt', line: 1, text: 'needle', sha256: (await workspace.read('src/nested/b.txt')).sha256,
      matchStart: 0, matchEnd: 6, excerptStart: 0, excerptEnd: 6, lineLength: 6 },
  ]);
  assert.equal(result.searchedFiles, 2);
  assert.deepEqual(result.scan, scoped.scan);
});

test('breadth-first sorted inventory preserves root and shallow files before a deep flood', async t => {
  const { root, workspace } = await fixture(t, { createRoot: true });
  await manyFiles(path.join(root, 'a', 'deep'), 1001);
  await write(root, 'z-root.txt', 'root needle');
  await write(root, 'b/shallow.txt', 'shallow needle');
  const result = await workspace.list();
  assert.equal(result.files.length, 1000);
  assert.deepEqual(result.files.slice(0, 5).map(file => file.path), ['a', 'b', 'z-root.txt', 'a/deep', 'b/shallow.txt']);
  assert.ok(result.files.slice(5).every(file => file.path.startsWith('a/deep/')));
  assert.deepEqual(result.scan.limits, ['entries']);
  const found = await workspace.search('needle');
  assert.deepEqual(found.matches.map(match => match.path), ['z-root.txt', 'b/shallow.txt']);
  assert.equal(found.searchedFiles, 100);
  assert.deepEqual(found.scan.limits, ['entries', 'search-files']);
});

test('exactly one thousand visible entries are complete; the next visible entry reports entries', async t => {
  const { root, workspace } = await fixture(t, { createRoot: true });
  await manyFiles(root, 1000);
  const exact = await workspace.list();
  assert.equal(exact.files.length, 1000);
  assert.equal(exact.scan.visitedEntries, 1000);
  assert.equal(exact.truncated, false);
  assert.deepEqual(exact.scan.limits, []);
  await write(root, '.env', 'excluded');
  const excluded = await workspace.list();
  assert.equal(excluded.files.length, 1000);
  assert.equal(excluded.scan.skippedEntries, 1);
  assert.equal(excluded.truncated, false);
  await write(root, 'next.txt');
  const overflow = await workspace.list();
  assert.equal(overflow.files.length, 1000);
  assert.equal(overflow.scan.visitedEntries, 1002);
  assert.deepEqual(overflow.scan.limits, ['entries']);
});

test('raw directory enumeration stays bounded even when every entry is hidden', async t => {
  const { root, workspace } = await fixture(t, { createRoot: true });
  await manyFiles(root, 10000, '.openaster-hidden-');
  const exact = await workspace.list();
  assert.deepEqual(exact.files, []);
  assert.equal(exact.scan.visitedEntries, 10000);
  assert.equal(exact.scan.skippedEntries, 10000);
  assert.equal(exact.truncated, false);
  await write(root, '.openaster-hidden-extra.txt');
  const overflow = await workspace.list();
  assert.deepEqual(overflow.files, []);
  assert.equal(overflow.scan.visitedEntries, 10001);
  assert.equal(overflow.scan.skippedEntries, 10000);
  assert.deepEqual(overflow.scan.limits, ['directory-entries']);
  assert.equal(overflow.truncated, true);
});

test('depth is measured from the workspace root and only actual deeper candidates report a limit', async t => {
  const { root, workspace } = await fixture(t);
  const deepest = Array.from({ length: 16 }, (_, i) => `d${i}`).join('/');
  await fs.mkdir(path.join(root, deepest), { recursive: true });
  const empty = await workspace.list();
  assert.equal(empty.files.length, 16);
  assert.equal(empty.scan.visitedEntries, 16);
  assert.equal(empty.truncated, false);
  await write(root, `${deepest}/too-deep.txt`);
  const full = await workspace.list();
  assert.equal(full.files.length, 16);
  assert.deepEqual(full.scan.limits, ['depth']);
  assert.equal(full.scan.skippedEntries, 1);
  const scoped = await workspace.search('needle', { path: deepest, includeGenerated: true });
  assert.equal(scoped.scope, deepest);
  assert.equal(scoped.searchedFiles, 0);
  assert.deepEqual(scoped.scan.limits, ['depth']);
  await fs.unlink(path.join(root, deepest, 'too-deep.txt'));
  await write(root, `${deepest}/.env`, 'secret');
  const onlySensitive = await workspace.list({ path: deepest });
  assert.equal(onlySensitive.scan.skippedEntries, 1);
  assert.deepEqual(onlySensitive.scan.limits, []);
  assert.equal(onlySensitive.truncated, false);
  await write(root, `${deepest}/unsupported%.txt`);
  const unsupported = await workspace.list({ path: deepest });
  assert.equal(unsupported.scan.skippedEntries, 2);
  assert.deepEqual(unsupported.scan.limits, []);
  assert.equal(unsupported.truncated, false);
});

test('exactly one hundred search files is complete and file 101 is never read', async t => {
  const { root, workspace } = await fixture(t, { createRoot: true });
  await manyFiles(root, 100, 'file-', 'nothing');
  const exact = await workspace.search('needle');
  assert.equal(exact.searchedFiles, 100);
  assert.equal(exact.truncated, false);
  assert.deepEqual(exact.scan.limits, []);
  await write(root, 'z-last.txt', 'needle');
  const overflow = await workspace.search('needle');
  assert.equal(overflow.searchedFiles, 100);
  assert.deepEqual(overflow.matches, []);
  assert.deepEqual(overflow.scan.limits, ['search-files']);
  assert.equal(overflow.scan.visitedEntries, 101);
});

test('exactly one hundred matches is complete; an extra observed match sets only search-matches', async t => {
  const { root, workspace } = await fixture(t);
  await write(root, 'matches.txt', 'needle\n'.repeat(100));
  const exact = await workspace.search('needle');
  assert.equal(exact.matches.length, 100);
  assert.equal(exact.searchedFiles, 1);
  assert.equal(exact.truncated, false);
  assert.deepEqual(exact.scan.limits, []);
  await fs.appendFile(path.join(root, 'matches.txt'), 'needle\n');
  const overflow = await workspace.search('needle');
  assert.equal(overflow.matches.length, 100);
  assert.equal(overflow.searchedFiles, 1);
  assert.equal(overflow.truncated, true);
  assert.deepEqual(overflow.scan.limits, ['search-matches']);
});

test('searchedFiles counts attempted bounded ordinary files rather than the whole inventory', async t => {
  const { root, workspace } = await fixture(t);
  await write(root, 'ordinary.txt', 'needle');
  await write(root, 'binary.bin', Buffer.from([0, 1, 2]));
  await write(root, 'too-large.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 65));
  await fs.mkdir(path.join(root, 'empty'));
  const inventory = await workspace.list();
  assert.equal(inventory.scan.skippedEntries, 0);
  const result = await workspace.search('needle');
  assert.equal(result.searchedFiles, 2);
  assert.deepEqual(result.matches.map(match => match.path), ['ordinary.txt']);
  assert.equal(result.scan.visitedEntries, 4);
  assert.equal(result.scan.skippedEntries, 2);
  assert.equal(inventory.scan.skippedEntries, 0);
  assert.equal(result.truncated, false);
  const noMatch = await workspace.search('absent');
  assert.deepEqual(noMatch.matches, []);
  assert.equal(noMatch.searchedFiles, 2);
  assert.equal(noMatch.scan.skippedEntries, 2);
});

test('pre-aborted and mid-enumeration cancelled scans fail without returning partial data', async t => {
  const { root, workspace } = await fixture(t);
  await manyFiles(root, 80);
  await assert.rejects(workspace.list({ signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  await assert.rejects(workspace.search('needle', { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  const controller = new AbortController();
  let observed = 0;
  await withDirectoryEntries(root, async directory => {
    if (directory === root && ++observed === 10) controller.abort();
  }, async () => assert.rejects(workspace.list({ signal: controller.signal }), { code: 'CANCELLED' }));
  assert.equal(observed, 10);
  assert.equal((await workspace.list()).files.length, 80);
});

test('long directory enumeration rechecks protected-root boundaries before processing file content', async t => {
  const { base, root } = await fixture(t);
  await manyFiles(root, 100);
  const protectedRoot = path.join(base, 'protected');
  await fs.mkdir(protectedRoot);
  const workspace = createWorkspace(root, { createRoot: false, projectScan: true, protectedRoots: [protectedRoot] });
  let observed = 0;
  await withDirectoryEntries(root, async directory => {
    if (directory === root && ++observed === 8) {
      await fs.rename(protectedRoot, path.join(base, 'previous-protected'));
      await fs.symlink(root, protectedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }, async () => assert.rejects(workspace.search('needle'), { code: 'PROTECTED_WORKSPACE' }));
  assert.ok(observed >= 8 && observed <= 64);
});

test('scoped scans cannot rebind a replaced or disappeared external workspace', async t => {
  const { base, root, workspace } = await fixture(t);
  await write(root, 'src/original.txt');
  await workspace.list({ path: 'src' });
  await fs.rename(root, path.join(base, 'previous-project'));
  await assert.rejects(workspace.search('needle', { path: 'src' }), { code: 'WORKSPACE_CHANGED' });
  await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
  await write(root, 'src/new.txt');
  await assert.rejects(workspace.list({ path: 'src', includeGenerated: true }), { code: 'WORKSPACE_CHANGED' });
  await assert.rejects(workspace.search('needle', { path: 'src', includeGenerated: true }), { code: 'WORKSPACE_CHANGED' });
});
