import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkspace, validateRelativePath, MAX_FILE_BYTES } from '../core/workspace.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openaster-core-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, workspace: createWorkspace(root) };
}

test('portable path policy rejects traversal, ADS, device names and encoded aliases', () => {
  for (const value of ['', '.', '..', '/tmp/x', '../x', 'a/../x', 'a//b', 'a\\b', 'C:/secret', 'x:stream', '//server/share', 'CON', 'CONIN$', 'CONOUT$.txt', 'nul.txt', 'lpt1.log', 'com¹.txt', 'file.', 'file ', 'a\u0000b', 'a?b', '%2e%2e/x', '.openaster-temp', 'a/./b', 'bad\ud800']) {
    assert.throws(() => validateRelativePath(value), { code: 'INVALID_PATH' }, value);
  }
  assert.equal(validateRelativePath('资料/任务-1.md'), '资料/任务-1.md');
});

test('imports create nested UTF-8 files, search is literal and line-numbered', async t => {
  const { workspace } = await fixture(t);
  await workspace.importText({ path: 'notes/项目.md', content: '你好\n[abc].*\nEND' });
  assert.equal((await workspace.read('notes/项目.md')).content, '你好\n[abc].*\nEND');
  const list = await workspace.list();
  assert.deepEqual(list.files.map(file => file.path), ['notes', 'notes/项目.md']);
  assert.deepEqual((await workspace.search('[abc].*')).matches, [{ path: 'notes/项目.md', line: 2, text: '[abc].*',
    sha256: (await workspace.read('notes/项目.md')).sha256, matchStart: 0, matchEnd: 7, excerptStart: 0, excerptEnd: 7, lineLength: 7 }]);
  assert.equal((await workspace.search('end')).matches[0].line, 3);
  await assert.rejects(workspace.importText({ path: 'notes/项目.md', content: 'replacement' }), { code: 'FILE_EXISTS' });
});

test('proposals capture old and new content; exact capability is single-use', async t => {
  const { workspace } = await fixture(t);
  const proposal = await workspace.prepareWrite({ path: 'task.md', content: 'first' });
  assert.equal(proposal.originalHash, null);
  await assert.rejects(workspace.read('task.md'), { code: 'FILE_NOT_FOUND' });
  assert.throws(() => { proposal.content = 'tampered'; }, TypeError);
  await assert.rejects(workspace.commitWrite({ ...proposal }), { code: 'INVALID_APPROVAL' });
  await workspace.commitWrite(proposal);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
  const replacement = await workspace.prepareWrite({ path: 'task.md', content: 'second' });
  assert.equal(replacement.originalContent, 'first');
  assert.match(replacement.originalHash, /^[a-f0-9]{64}$/u);
  await workspace.commitWrite(replacement);
  assert.equal((await workspace.read('task.md')).content, 'second');
});

test('stale overwrite and concurrently created targets fail without altering content', async t => {
  const { workspace, root } = await fixture(t);
  await workspace.importText({ path: 'existing.md', content: 'original' });
  const stale = await workspace.prepareWrite({ path: 'existing.md', content: 'proposed' });
  await fs.writeFile(path.join(root, 'existing.md'), 'external change');
  await assert.rejects(workspace.commitWrite(stale), { code: 'WRITE_CONFLICT' });
  assert.equal((await workspace.read('existing.md')).content, 'external change');
  const create = await workspace.prepareWrite({ path: 'new.md', content: 'proposed' });
  await fs.writeFile(path.join(root, 'new.md'), 'someone else');
  await assert.rejects(workspace.commitWrite(create), { code: 'WRITE_CONFLICT' });
  assert.equal((await workspace.read('new.md')).content, 'someone else');
});

test('concurrent proposals for one file cannot both consume an old snapshot', async t => {
  const { workspace } = await fixture(t);
  await workspace.importText({ path: 'same.md', content: 'before' });
  const a = await workspace.prepareWrite({ path: 'same.md', content: 'a' });
  const b = await workspace.prepareWrite({ path: 'same.md', content: 'b' });
  const results = await Promise.allSettled([workspace.commitWrite(a), workspace.commitWrite(b)]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'WRITE_CONFLICT');
});

test('symlinks/junctions cannot expose external contents or become write parents', async t => {
  const { workspace, root } = await fixture(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'openaster-outside-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.writeFile(path.join(external, 'secret.txt'), 'outside');
  await fs.symlink(external, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.read('escape/secret.txt'), { code: 'UNSAFE_PATH' });
  await assert.rejects(workspace.prepareWrite({ path: 'escape/new.txt', content: 'bad' }), { code: 'UNSAFE_PATH' });
  assert.equal((await workspace.list()).files.some(file => file.path.includes('escape')), false);
  await assert.rejects(fs.stat(path.join(external, 'new.txt')), { code: 'ENOENT' });
});

test('hardlinks are excluded from reads and writes', async t => {
  const { workspace, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'one'), 'private');
  await fs.link(path.join(root, 'one'), path.join(root, 'two'));
  await assert.rejects(workspace.read('two'), { code: 'UNSAFE_PATH' });
  await assert.rejects(workspace.prepareWrite({ path: 'one', content: 'replace' }), { code: 'UNSAFE_PATH' });
  assert.deepEqual((await workspace.list()).files, []);
});

test('root symlink is rejected, and replacing a previously validated root invalidates workspace', async t => {
  const { workspace, root } = await fixture(t);
  await workspace.list();
  const moved = `${root}-moved`;
  t.after(() => fs.rm(moved, { recursive: true, force: true }));
  await fs.rename(root, moved);
  await fs.mkdir(root);
  await assert.rejects(workspace.list(), { code: 'WORKSPACE_CHANGED' });
});

test('size, binary and UTF-8 limits apply before content enters model context', async t => {
  const { workspace, root } = await fixture(t);
  await assert.rejects(workspace.prepareWrite({ path: 'invalid-unicode', content: 'bad\ud800' }), { code: 'INVALID_CONTENT' });
  await assert.rejects(workspace.prepareWrite({ path: 'too-big', content: '中'.repeat(MAX_FILE_BYTES / 2) }), { code: 'FILE_TOO_LARGE' });
  await fs.writeFile(path.join(root, 'large'), Buffer.alloc(MAX_FILE_BYTES + 1, 65));
  await assert.rejects(workspace.read('large'), { code: 'FILE_TOO_LARGE' });
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([65, 0, 66]));
  await assert.rejects(workspace.read('binary'), { code: 'BINARY_FILE' });
  await fs.writeFile(path.join(root, 'invalid'), Buffer.from([0xc3, 0x28]));
  await assert.rejects(workspace.read('invalid'), { code: 'BINARY_FILE' });
});

test('discarding and cancellation revoke proposals without creating files or temp debris', async t => {
  const { workspace, root } = await fixture(t);
  const discarded = await workspace.prepareWrite({ path: 'nested/deep/no.txt', content: 'no' });
  assert.deepEqual(await fs.readdir(root), []);
  workspace.discardWrite(discarded);
  await assert.rejects(workspace.commitWrite(discarded), { code: 'INVALID_APPROVAL' });
  const cancelled = await workspace.prepareWrite({ path: 'nested/deep/cancelled.txt', content: 'no' });
  await assert.rejects(workspace.commitWrite(cancelled, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('swapping a parent to a junction after preview fails closed before approved writes', async t => {
  const { workspace, root } = await fixture(t);
  await fs.mkdir(path.join(root, 'parent'));
  const proposal = await workspace.prepareWrite({ path: 'parent/new.txt', content: 'approved' });
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'openaster-swap-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.rmdir(path.join(root, 'parent'));
  await fs.symlink(external, path.join(root, 'parent'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.commitWrite(proposal), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(external), []);
});

test('internal temporary namespace is rejected independently of filesystem casing', async t => {
  const { workspace } = await fixture(t);
  await assert.rejects(workspace.prepareWrite({ path: '.OPENASTER-reserved.tmp', content: 'x' }), { code: 'INVALID_PATH' });
});

test('search results are bounded and pre-aborted reads stop', async t => {
  const { workspace } = await fixture(t);
  await workspace.importText({ path: 'matches.txt', content: 'hit\n'.repeat(150) });
  const matches = await workspace.search('hit');
  assert.equal(matches.matches.length, 100);
  assert.equal(matches.truncated, true);
  await assert.rejects(workspace.read('matches.txt', { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
});
