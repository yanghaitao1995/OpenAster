// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkspace } from '../core/workspace.mjs';
import { GITIGNORE_LIMITS } from '../core/workspace-ignore.mjs';

async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-ignore-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.match(path.basename(root), /^openaster-ignore-/);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const write = async (name, text = 'needle') => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  return { root, write, workspace: createWorkspace(root, { createRoot: false, projectScan: true, denySensitivePaths: true, ...options }) };
}
const paths = result => result.files.map(file => file.path);

async function afterRead(t, root, callback, run) {
  const handle = await fs.open(path.join(root, '.gitignore'));
  const prototype = Object.getPrototypeOf(handle), original = prototype.read;
  await handle.close();
  let called = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await original.apply(this, args);
    if (!called && result.bytesRead) { called = true; await callback(); }
    return result;
  });
  try { return await run(); } finally { t.mock.restoreAll(); }
}

test('hierarchical overrides apply only after every parent remains included, including explicit scopes', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', '*.log\nblocked/\n!blocked/keep.txt\nparent/*\n!parent/open/\n');
  await f.write('src/.gitignore', '!keep.log\n/local.txt\n');
  await f.write('src/keep.log'); await f.write('src/drop.log'); await f.write('src/local.txt'); await f.write('src/nested/local.txt');
  await f.write('blocked/.gitignore', '!keep.txt\n'); await f.write('blocked/keep.txt');
  await f.write('parent/open/readme.txt'); await f.write('parent/closed/drop.txt');
  const result = await f.workspace.list();
  assert.ok(paths(result).includes('src/keep.log')); assert.ok(paths(result).includes('src/nested/local.txt'));
  assert.ok(paths(result).includes('parent/open/readme.txt'));
  for (const name of ['blocked', 'src/drop.log', 'src/local.txt', 'parent/closed']) assert.ok(!paths(result).includes(name), name);
  assert.equal(result.scan.ignore.files, 2, 'blocked/.gitignore was not loaded');
  const scoped = await f.workspace.list({ path: 'blocked' });
  assert.deepEqual(scoped.files, []); assert.equal(scoped.scan.ignore.scopeIgnored, true); assert.equal(scoped.truncated, false);
  const deeper = await f.workspace.search('needle', { path: 'blocked', includeIgnored: true });
  assert.ok(deeper.matches.some(item => item.path === 'blocked/keep.txt')); assert.equal(deeper.scan.ignore.enabled, false);
  assert.deepEqual((await f.workspace.list({ path: 'src' })).files.map(item => item.path), ['src/.gitignore', 'src/keep.log', 'src/nested', 'src/nested/local.txt']);
});

test('includeIgnored and includeGenerated are independent and neither weakens paths or approval writes', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', 'private.txt\ndist/\n!.env\n');
  await f.write('private.txt'); await f.write('dist/bundle.txt'); await f.write('.env', 'secret');
  assert.ok(!paths(await f.workspace.list({ includeGenerated: true })).includes('private.txt'));
  const ignored = await f.workspace.list({ includeIgnored: true });
  assert.ok(paths(ignored).includes('private.txt')); assert.ok(!paths(ignored).includes('dist'));
  const all = await f.workspace.list({ includeIgnored: true, includeGenerated: true });
  assert.ok(paths(all).includes('dist/bundle.txt')); assert.ok(!paths(all).includes('.env'));
  assert.equal((await f.workspace.list({ path: 'dist' })).scan.ignore.scopeIgnored, true);
  assert.equal((await f.workspace.read('private.txt')).content, 'needle');
  const proposal = await f.workspace.prepareWrite({ path: 'private.txt', content: 'approved replacement' });
  assert.equal(await fs.readFile(path.join(f.root, 'private.txt'), 'utf8'), 'needle');
  await f.workspace.commitWrite(proposal);
  assert.equal(await fs.readFile(path.join(f.root, 'private.txt'), 'utf8'), 'approved replacement');
  await assert.rejects(f.workspace.list({ path: '.git', includeIgnored: true }), { code: 'SENSITIVE_PATH' });
  for (const includeIgnored of [null, 1, 'true', []]) await assert.rejects(f.workspace.search('x', { includeIgnored }), { code: 'INVALID_SCAN_OPTIONS' });
});

test('independent workspaces never interpret rules; an explicit override can recover invalid rule files', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', Buffer.from([0xff, 0])); await f.write('source.txt');
  await assert.rejects(f.workspace.list(), { code: 'GITIGNORE_INVALID' });
  await assert.rejects(f.workspace.search('needle'), { code: 'GITIGNORE_INVALID' });
  const ignored = await f.workspace.list({ includeIgnored: true });
  assert.equal(ignored.scan.ignore.enabled, false); assert.equal(ignored.scan.ignore.bytes, 0);
  const legacy = createWorkspace(f.root, { createRoot: false });
  assert.ok(paths(await legacy.list()).includes('source.txt'));
  await f.write('.gitignore', 'source.txt');
  assert.ok(!paths(await f.workspace.list()).includes('source.txt'));
});

test('rule files are loaded even when their filename is excluded and ignored descendants cannot consume output capacity', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', '.gitignore\nlarge/\n');
  await f.write('src/.gitignore', 'hidden.txt\n'); await f.write('src/hidden.txt'); await f.write('src/visible.txt');
  for (let batch = 0; batch < 1100; batch += 100) await Promise.all(Array.from({ length: 100 }, (_, index) => f.write(`large/f${batch + index}.txt`)));
  const found = await f.workspace.list();
  assert.deepEqual(paths(found), ['src', 'src/visible.txt']);
  assert.equal(found.scan.ignore.files, 2); assert.equal(found.scan.ignore.ignoredDirectories, 1);
  assert.equal(found.scan.ignore.ignoredFiles, 3); assert.equal(found.truncated, false);
});

test('unsafe rule links reject the whole scan; override never permits reading the link', async t => {
  const f = await fixture(t);
  await f.write('original', '*.txt'); await fs.link(path.join(f.root, 'original'), path.join(f.root, '.gitignore'));
  await assert.rejects(f.workspace.list(), { code: 'GITIGNORE_UNAVAILABLE' });
  const all = await f.workspace.list({ includeIgnored: true });
  assert.deepEqual(all.files, []); assert.equal(all.scan.skippedEntries, 2);
});

test('rule size, per-pattern, aggregate bytes and actual file count are bounded without fallback', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', '#' + 'x'.repeat(GITIGNORE_LIMITS.fileBytes));
  await assert.rejects(f.workspace.list(), { code: 'GITIGNORE_LIMIT' });
  await f.write('.gitignore', 'a'.repeat(GITIGNORE_LIMITS.patternBytes + 1));
  await assert.rejects(f.workspace.list(), { code: 'GITIGNORE_LIMIT' });
  const comment = '#' + 'x'.repeat(GITIGNORE_LIMITS.fileBytes - 1);
  await f.write('.gitignore', comment);
  for (const name of ['a', 'b', 'c']) await f.write(`${name}/.gitignore`, comment);
  assert.equal((await f.workspace.list()).scan.ignore.bytes, GITIGNORE_LIMITS.totalBytes);
  await f.write('d/.gitignore', '#');
  await assert.rejects(f.workspace.list(), { code: 'GITIGNORE_LIMIT' });
  for (const name of ['', 'a/', 'b/', 'c/', 'd/']) await f.write(`${name}.gitignore`, '');
  for (let index = 0; index < 123; index++) await f.write(`dir-${index}/.gitignore`, '');
  assert.equal((await f.workspace.list()).scan.ignore.files, GITIGNORE_LIMITS.files);
  await f.write('dir-last/.gitignore', '');
  await assert.rejects(f.workspace.list(), { code: 'GITIGNORE_LIMIT' });
});

test('rule counts are shared across nested files and ignored scope reports complete deliberate exclusion', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', 'nonmatching\n'.repeat(2048));
  await f.write('src/.gitignore', 'nonmatching\n'.repeat(2048));
  await f.write('src/file.txt');
  assert.equal((await f.workspace.list()).scan.ignore.rules, GITIGNORE_LIMITS.rules);
  await f.write('src/nested/.gitignore', 'one-more-rule');
  await assert.rejects(f.workspace.list(), { code: 'GITIGNORE_LIMIT' });
});

test('a rule changing during bounded reads fails and cancellation never returns partial success', async t => {
  const f = await fixture(t);
  await f.write('.gitignore', 'hidden.txt\n'); await f.write('hidden.txt');
  await afterRead(t, f.root, () => fs.appendFile(path.join(f.root, '.gitignore'), 'other.txt\n'), () => assert.rejects(f.workspace.list(), { code: 'GITIGNORE_CHANGED' }));
  const controller = new AbortController();
  await afterRead(t, f.root, () => controller.abort(), () => assert.rejects(f.workspace.list({ signal: controller.signal }), { code: 'CANCELLED' }));
});

test('search rechecks absent and present rule files after reading candidate text', async t => {
  const f = await fixture(t); await f.write('source.txt');
  const opened = await fs.open(path.join(f.root, 'source.txt'));
  const prototype = Object.getPrototypeOf(opened), original = prototype.read;
  await opened.close();
  let changed = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await original.apply(this, args);
    if (!changed && result.bytesRead) { changed = true; await f.write('.gitignore', 'source.txt\n'); }
    return result;
  });
  try { await assert.rejects(f.workspace.search('needle'), { code: 'GITIGNORE_CHANGED' }); }
  finally { t.mock.restoreAll(); }
  assert.equal((await f.workspace.search('needle')).matches.length, 0);
});
