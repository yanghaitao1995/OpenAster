import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createWorkspace, MAX_FILE_BYTES } from '../core/workspace.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'openaster-edit-'));
  const root = path.join(base, 'workspace');
  await fs.mkdir(root);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, root, workspace: createWorkspace(root, options) };
}
async function put(root, content, relative = 'file.txt') {
  const file = path.join(root, relative);
  await fs.writeFile(file, content);
  return { file, hash: sha256(content) };
}
function mockFilesystem(t, name, implementation) {
  const mock = t.mock.method(filesystem, name, implementation);
  syncBuiltinESMExports();
  const restore = () => { mock.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}
function holdRenameBackoff(t) {
  const timers = new Set();
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  const set = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (![25, 75, 150].includes(delay)) return originalSet(callback, delay, ...args);
    const timer = { callback: () => callback(...args), delay, cancelled: false };
    timers.add(timer); ready(timer); return timer;
  });
  const clear = t.mock.method(globalThis, 'clearTimeout', timer => {
    if (timers.has(timer)) { timer.cancelled = true; return; }
    originalClear(timer);
  });
  t.after(() => { set.mock.restore(); clear.mock.restore(); });
  return { waiting, release(timer) { if (!timer.cancelled) timer.callback(); } };
}
const busyError = (code = 'EPERM') => Object.assign(new Error('Injected native file occupancy'), { code });

test('read exposes the raw file hash and an exact edit preserves BOM, CRLF and absent trailing newline', async t => {
  const { root, workspace } = await fixture(t);
  const original = '\uFEFF标题\r\n  old 文本  \r\n尾行';
  const { file, hash } = await put(root, original);
  assert.deepEqual(await workspace.read('file.txt'), { path: 'file.txt', content: original, sha256: hash });
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'old 文本', newText: 'new 内容', expectedHash: hash });
  const expected = '\uFEFF标题\r\n  new 内容  \r\n尾行';
  assert.equal(proposal.originalContent, original);
  assert.equal(proposal.originalHash, hash);
  assert.equal(proposal.content, expected);
  assert.equal(proposal.newHash, sha256(expected));
  assert.equal(proposal.bytes, Buffer.byteLength(expected));
  assert.deepEqual(await fs.readFile(file), Buffer.from(original));
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
  assert.deepEqual(await workspace.commitWrite(proposal), { path: 'file.txt', bytes: Buffer.byteLength(expected), sha256: sha256(expected) });
  assert.deepEqual(await fs.readFile(file), Buffer.from(expected));
});

test('matching and replacement are literal, keep surrounding whitespace and do not normalize Unicode', async t => {
  const { root, workspace } = await fixture(t);
  const original = 'prefix \n [a].*$ old \n e\u0301 😀 suffix ';
  const { file, hash } = await put(root, original);
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: '[a].*$ old', newText: '$& $1 \\n', expectedHash: hash });
  await workspace.commitWrite(proposal);
  assert.equal(await fs.readFile(file, 'utf8'), 'prefix \n $& $1 \\n \n e\u0301 😀 suffix ');
  const current = await workspace.read('file.txt');
  await assert.rejects(workspace.prepareEdit({ path: 'file.txt', oldText: 'é', newText: 'x', expectedHash: current.sha256 }), { code: 'EDIT_NO_MATCH' });
});

test('repeated and overlapping matches, missing matches and no-op edits fail explicitly without writes', async t => {
  const { root, workspace } = await fixture(t);
  for (const [content, oldText, newText, code] of [
    ['hello hello', 'hello', 'new', 'EDIT_AMBIGUOUS'],
    ['aaa', 'aa', 'new', 'EDIT_AMBIGUOUS'],
    ['😀😀😀', '😀😀', 'new', 'EDIT_AMBIGUOUS'],
    ['hello', 'absent', 'new', 'EDIT_NO_MATCH'],
    ['hello', 'hello', 'hello', 'EDIT_NO_CHANGE'],
  ]) {
    const { file, hash } = await put(root, content);
    await assert.rejects(workspace.prepareEdit({ path: 'file.txt', oldText, newText, expectedHash: hash }), { code });
    assert.equal(await fs.readFile(file, 'utf8'), content);
    assert.deepEqual(await fs.readdir(root), ['file.txt']);
  }
});

test('expectedHash is required strict lowercase SHA-256 and stale reads cannot prepare edits', async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, 'before');
  for (const expectedHash of [undefined, null, '', false, 123, 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), hash.toUpperCase(), ` ${hash}`, `${hash}\n`]) {
    await assert.rejects(workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: 'after', expectedHash }), { code: 'INVALID_HASH' });
  }
  await fs.writeFile(file, 'changed');
  await assert.rejects(workspace.prepareEdit({ path: 'file.txt', oldText: 'changed', newText: 'after', expectedHash: hash }), { code: 'WRITE_CONFLICT' });
  assert.equal(await fs.readFile(file, 'utf8'), 'changed');
});

test('oldText and newText enforce Unicode, no-NUL and byte limits, and oldText cannot be empty', async t => {
  const { root, workspace } = await fixture(t);
  const { hash } = await put(root, 'before');
  const input = { path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash };
  for (const key of ['oldText', 'newText']) {
    for (const value of [undefined, null, 12, {}, 'bad\ud800', '\udc00', 'x\0y']) {
      await assert.rejects(workspace.prepareEdit({ ...input, [key]: value }), { code: 'INVALID_CONTENT' });
    }
    for (const value of ['x'.repeat(MAX_FILE_BYTES + 1), '中'.repeat(Math.ceil(MAX_FILE_BYTES / 3))]) {
      await assert.rejects(workspace.prepareEdit({ ...input, [key]: value }), { code: 'FILE_TOO_LARGE' });
    }
  }
  await assert.rejects(workspace.prepareEdit({ ...input, oldText: '' }), { code: 'EDIT_EMPTY_MATCH' });
});

test('the final file must fit the byte limit and an exactly-full file can be edited', async t => {
  const { root, workspace } = await fixture(t);
  const original = 'a'.repeat(MAX_FILE_BYTES - 1) + 'b';
  const { file, hash } = await put(root, original);
  await assert.rejects(workspace.prepareEdit({ path: 'file.txt', oldText: 'b', newText: 'zz', expectedHash: hash }), { code: 'FILE_TOO_LARGE' });
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'b', newText: 'z', expectedHash: hash });
  assert.equal(proposal.bytes, MAX_FILE_BYTES);
  await workspace.commitWrite(proposal);
  assert.equal((await fs.readFile(file)).length, MAX_FILE_BYTES);
  assert.equal((await fs.readFile(file, 'utf8')).endsWith('z'), true);
});

test('an empty replacement deletes exactly the matched text, including a whole-file deletion', async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, '😀');
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: '😀', newText: '', expectedHash: hash });
  assert.equal(proposal.content, '');
  assert.equal(proposal.bytes, 0);
  assert.equal(proposal.newHash, sha256(''));
  await workspace.commitWrite(proposal);
  assert.deepEqual(await fs.readFile(file), Buffer.alloc(0));
  assert.equal((await workspace.read('file.txt')).sha256, sha256(''));
});

test('edits require an existing ordinary bounded UTF-8 file', async t => {
  const { root, workspace } = await fixture(t);
  const input = { path: 'file.txt', oldText: 'a', newText: 'b', expectedHash: sha256('a') };
  await assert.rejects(workspace.prepareEdit(input), { code: 'FILE_NOT_FOUND' });
  assert.deepEqual(await fs.readdir(root), []);
  for (const [content, code] of [[Buffer.from([97, 0, 98]), 'BINARY_FILE'], [Buffer.from([0xc3, 0x28]), 'BINARY_FILE'], [Buffer.alloc(MAX_FILE_BYTES + 1, 97), 'FILE_TOO_LARGE']]) {
    const { hash } = await put(root, content);
    await assert.rejects(workspace.prepareEdit({ ...input, expectedHash: hash }), { code });
  }
  await fs.mkdir(path.join(root, 'folder'));
  await assert.rejects(workspace.prepareEdit({ ...input, path: 'folder' }), { code: 'UNSAFE_PATH' });
});

test('path traversal, sensitive files, junctions and hardlinks stay inaccessible to edits', async t => {
  const { base, root, workspace } = await fixture(t, { createRoot: false, denySensitivePaths: true });
  const input = { path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: sha256('before') };
  for (const relative of ['../outside/file.txt', '/absolute', 'x/../file.txt', 'x\\file.txt']) {
    await assert.rejects(workspace.prepareEdit({ ...input, path: relative }), { code: 'INVALID_PATH' });
  }
  await put(root, 'before', '.env');
  await assert.rejects(workspace.prepareEdit({ ...input, path: '.env' }), { code: 'SENSITIVE_PATH' });
  const external = path.join(base, 'outside');
  await fs.mkdir(external);
  await put(external, 'before');
  await fs.symlink(external, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.prepareEdit({ ...input, path: 'escape/file.txt' }), { code: 'UNSAFE_PATH' });
  await put(root, 'before');
  await fs.link(path.join(root, 'file.txt'), path.join(root, 'alias.txt'));
  await assert.rejects(workspace.prepareEdit(input), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(path.join(external, 'file.txt'), 'utf8'), 'before');
});

test('ordinary dotfiles and generated files remain editable through the same approval boundary', async t => {
  const { root, workspace } = await fixture(t, { createRoot: false, denySensitivePaths: true, projectScan: true });
  await fs.mkdir(path.join(root, 'dist'));
  for (const relative of ['.env.example', '.ordinary', 'dist/generated.txt']) {
    const { file, hash } = await put(root, 'before', relative);
    const proposal = await workspace.prepareEdit({ path: relative, oldText: 'before', newText: 'after', expectedHash: hash });
    assert.equal(await fs.readFile(file, 'utf8'), 'before');
    await workspace.commitWrite(proposal);
    assert.equal(await fs.readFile(file, 'utf8'), 'after');
  }
});

test('replacing an edit parent with a junction after preview cannot write outside the workspace', async t => {
  const { base, root, workspace } = await fixture(t);
  await fs.mkdir(path.join(root, 'parent'));
  const { hash } = await put(root, 'before', 'parent/file.txt');
  const proposal = await workspace.prepareEdit({ path: 'parent/file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
  const external = path.join(base, 'outside');
  await fs.mkdir(external);
  await put(external, 'before');
  await fs.rename(path.join(root, 'parent'), path.join(root, 'old-parent'));
  await fs.symlink(external, path.join(root, 'parent'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.commitWrite(proposal), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(path.join(external, 'file.txt'), 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(root, 'old-parent/file.txt'), 'utf8'), 'before');
});

test('edit proposals are immutable, instance-bound and single-use capabilities', async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, 'before');
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
  assert.equal(Object.isFrozen(proposal), true);
  assert.throws(() => { proposal.content = 'forged'; }, TypeError);
  await assert.rejects(workspace.commitWrite({ ...proposal }), { code: 'INVALID_APPROVAL' });
  await assert.rejects(createWorkspace(root).commitWrite(proposal), { code: 'INVALID_APPROVAL' });
  assert.equal(await fs.readFile(file, 'utf8'), 'before');
  await workspace.commitWrite(proposal);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
  assert.equal(await fs.readFile(file, 'utf8'), 'after');
});

test('post-preview modification and deletion reject an approved edit without recreating or overwriting', async t => {
  const { root, workspace } = await fixture(t);
  for (const action of ['modify', 'delete']) {
    const { file, hash } = await put(root, 'before');
    const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
    if (action === 'modify') await fs.writeFile(file, 'external'); else await fs.unlink(file);
    await assert.rejects(workspace.commitWrite(proposal), { code: 'WRITE_CONFLICT' });
    await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
    if (action === 'modify') assert.equal(await fs.readFile(file, 'utf8'), 'external');
    else await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test('cancellation before and during snapshot prevents an edit proposal and cancelled commit consumes approval', async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, 'before');
  const input = { path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash };
  await assert.rejects(workspace.prepareEdit(input, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  const probe = await fs.open(file, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  const controller = new AbortController();
  const mock = t.mock.method(prototype, 'read', async function (...args) {
    const result = await originalRead.apply(this, args);
    controller.abort();
    return result;
  });
  await assert.rejects(workspace.prepareEdit(input, { signal: controller.signal }), { code: 'CANCELLED' });
  mock.mock.restore();
  const proposal = await workspace.prepareEdit(input);
  await assert.rejects(workspace.commitWrite(proposal, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
  assert.equal(await fs.readFile(file, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
});

test('prepareEdit retains its one checked snapshot if the file changes just after its bounded read', async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, 'before');
  const probe = await fs.open(file, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  let changed = false;
  const mock = t.mock.method(prototype, 'read', async function (...args) {
    const result = await originalRead.apply(this, args);
    if (!changed && result.bytesRead === 0) { changed = true; await fs.writeFile(file, 'external'); }
    return result;
  });
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
  mock.mock.restore();
  assert.equal(changed, true);
  assert.equal(proposal.originalHash, hash);
  assert.equal(proposal.originalContent, 'before');
  assert.equal(proposal.content, 'after');
  assert.equal(await fs.readFile(file, 'utf8'), 'external');
  await assert.rejects(workspace.commitWrite(proposal), { code: 'WRITE_CONFLICT' });
});

test('cancellation during the final existing-file snapshot prevents rename and consumes the edit proposal', async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, 'before');
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
  const probe = await fs.open(file, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = prototype.read;
  const controller = new AbortController();
  let reads = 0;
  const mock = t.mock.method(prototype, 'read', async function (...args) {
    const result = await originalRead.apply(this, args);
    // Each snapshot reads the short file then EOF; cancel after the second EOF.
    if (++reads === 4) controller.abort();
    return result;
  });
  await assert.rejects(workspace.commitWrite(proposal, { signal: controller.signal }), { code: 'CANCELLED' });
  mock.mock.restore();
  assert.equal(reads, 4);
  assert.equal(controller.signal.aborted, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('cancellation in the last missing-target resolve prevents link and removes the temporary file', async t => {
  const { root, workspace } = await fixture(t);
  const target = path.join(root, 'new.txt');
  const proposal = await workspace.prepareWrite({ path: 'new.txt', content: 'proposed' });
  const originalLstat = filesystem.lstat;
  const controller = new AbortController();
  let missingTargetChecks = 0;
  const mock = t.mock.method(filesystem, 'lstat', async function (...args) {
    try { return await originalLstat.apply(this, args); }
    catch (error) {
      // First snapshot, parent resolution, final snapshot, then final resolve.
      if (args[0] === target && error.code === 'ENOENT' && ++missingTargetChecks === 4) controller.abort();
      throw error;
    }
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(workspace.commitWrite(proposal, { signal: controller.signal }), { code: 'CANCELLED' });
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(missingTargetChecks, 4);
  assert.equal(controller.signal.aborted, true);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('root identity replacement invalidates preparation and pending edits', async t => {
  const { base, root, workspace } = await fixture(t, { createRoot: false });
  const { hash } = await put(root, 'before');
  const input = { path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash };
  const proposal = await workspace.prepareEdit(input);
  await fs.rename(root, path.join(base, 'old-workspace'));
  await fs.mkdir(root);
  await put(root, 'before');
  await assert.rejects(workspace.prepareEdit(input), { code: 'WORKSPACE_CHANGED' });
  await assert.rejects(workspace.commitWrite(proposal), { code: 'WORKSPACE_CHANGED' });
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'before');
});

test('edits and full writes share the same bounded proposal registry and discard behavior', async t => {
  const { root, workspace } = await fixture(t);
  const { hash } = await put(root, 'before');
  const input = { path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash };
  for (let i = 0; i < 99; i++) await workspace.prepareWrite({ path: `pending-${i}.txt`, content: 'pending' });
  const proposal = await workspace.prepareEdit(input);
  await assert.rejects(workspace.prepareEdit(input), { code: 'TOO_MANY_PROPOSALS' });
  workspace.discardWrite(proposal);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
  const replacement = await workspace.prepareEdit(input);
  workspace.discardWrite(replacement);
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
});

test('Windows retries a transient EPERM, EACCES or EBUSY rename and commits the approved exact bytes', { skip: process.platform !== 'win32' }, async t => {
  const { root, workspace } = await fixture(t);
  const originalRename = filesystem.rename;
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const { file, hash } = await put(root, '\uFEFFbefore\r\n');
    const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: '$&after', expectedHash: hash });
    let attempts = 0;
    const restore = mockFilesystem(t, 'rename', async (...args) => {
      if (++attempts === 1) throw busyError(code);
      return originalRename(...args);
    });
    const result = await workspace.commitWrite(proposal);
    restore();
    assert.equal(attempts, 2);
    assert.equal(result.sha256, sha256('\uFEFF$&after\r\n'));
    assert.deepEqual(await fs.readFile(file), Buffer.from('\uFEFF$&after\r\n'));
    assert.deepEqual(await fs.readdir(root), ['file.txt']);
    await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
  }
});

test('Windows persistent rename occupancy is limited to three retries and fails with FILE_BUSY', { skip: process.platform !== 'win32' }, async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, 'before');
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
  let attempts = 0;
  const restore = mockFilesystem(t, 'rename', async () => { attempts++; throw busyError(); });
  const delays = [], originalSet = globalThis.setTimeout;
  const timerMock = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => { delays.push(delay); return originalSet(callback, delay, ...args); });
  await assert.rejects(workspace.commitWrite(proposal), { code: 'FILE_BUSY', status: 409 });
  timerMock.mock.restore(); restore();
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [25, 75, 150]);
  assert.equal(await fs.readFile(file, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('cancelling while Windows rename waits stops immediately and consumes the proposal', { skip: process.platform !== 'win32' }, async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, 'before');
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
  const controller = new AbortController();
  let attempts = 0;
  mockFilesystem(t, 'rename', async () => { attempts++; throw busyError(); });
  const backoff = holdRenameBackoff(t);
  const committing = workspace.commitWrite(proposal, { signal: controller.signal });
  const rejected = assert.rejects(committing, { code: 'CANCELLED' });
  const timer = await backoff.waiting;
  assert.equal(timer.delay, 25);
  controller.abort();
  await rejected;
  assert.equal(timer.cancelled, true);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('an external modification during Windows retry delay invalidates the original hash', { skip: process.platform !== 'win32' }, async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, 'before');
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
  let attempts = 0;
  mockFilesystem(t, 'rename', async () => { attempts++; throw busyError(); });
  const backoff = holdRenameBackoff(t);
  const committing = workspace.commitWrite(proposal);
  const rejected = assert.rejects(committing, { code: 'WRITE_CONFLICT' });
  const timer = await backoff.waiting;
  await fs.writeFile(file, 'external change');
  backoff.release(timer);
  await rejected;
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'external change');
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('a parent junction swap during Windows retry delay remains forbidden', { skip: process.platform !== 'win32' }, async t => {
  const { base, root, workspace } = await fixture(t);
  await fs.mkdir(path.join(root, 'parent'));
  const { hash } = await put(root, 'before', 'parent/file.txt');
  const proposal = await workspace.prepareEdit({ path: 'parent/file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await put(outside, 'before');
  const originalRename = filesystem.rename;
  let attempts = 0;
  mockFilesystem(t, 'rename', async () => { attempts++; throw busyError(); });
  const backoff = holdRenameBackoff(t);
  const committing = workspace.commitWrite(proposal);
  const rejected = assert.rejects(committing, { code: 'UNSAFE_PATH' });
  const timer = await backoff.waiting;
  await originalRename(path.join(root, 'parent'), path.join(root, 'moved-parent'));
  const temporaryName = (await fs.readdir(path.join(root, 'moved-parent'))).find(name => name.startsWith('.openaster-'));
  assert.ok(temporaryName);
  await fs.writeFile(path.join(outside, temporaryName), 'unowned external marker');
  await fs.symlink(outside, path.join(root, 'parent'), 'junction');
  backoff.release(timer);
  await rejected;
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(path.join(outside, 'file.txt'), 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(root, 'moved-parent/file.txt'), 'utf8'), 'before');
  // The original directory moved with its already-written temporary file. It is
  // outside the current resolved target path, so cleanup must not follow the junction.
  assert.equal(await fs.readFile(path.join(outside, temporaryName), 'utf8'), 'unowned external marker');
  assert.deepEqual((await fs.readdir(outside)).sort(), ['file.txt', temporaryName].sort());
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('other native rename errors are not retried or relabeled', async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, 'before');
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
  let attempts = 0;
  const nativeError = busyError('EIO');
  mockFilesystem(t, 'rename', async () => { attempts++; throw nativeError; });
  await assert.rejects(workspace.commitWrite(proposal), error => error === nativeError);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(root), ['file.txt']);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('cleanup preserves an unowned replacement at the staging filename', { skip: process.platform !== 'win32' }, async t => {
  const { root, workspace } = await fixture(t);
  const { file, hash } = await put(root, 'before');
  const proposal = await workspace.prepareEdit({ path: 'file.txt', oldText: 'before', newText: 'after', expectedHash: hash });
  const originalRename = filesystem.rename;
  let attempts = 0;
  mockFilesystem(t, 'rename', async () => { attempts++; throw busyError(); });
  const backoff = holdRenameBackoff(t);
  const controller = new AbortController();
  const committing = workspace.commitWrite(proposal, { signal: controller.signal });
  const rejected = assert.rejects(committing, { code: 'CANCELLED' });
  await backoff.waiting;
  const temporaryName = (await fs.readdir(root)).find(name => name.startsWith('.openaster-'));
  assert.ok(temporaryName);
  await originalRename(path.join(root, temporaryName), path.join(root, 'moved-staging.txt'));
  await fs.writeFile(path.join(root, temporaryName), 'unowned replacement marker');
  controller.abort();
  await rejected;
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(file, 'utf8'), 'before');
  assert.equal(await fs.readFile(path.join(root, temporaryName), 'utf8'), 'unowned replacement marker');
  assert.equal(await fs.readFile(path.join(root, 'moved-staging.txt'), 'utf8'), 'after');
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('a new-file link failure never enters the existing-file rename retry path', async t => {
  const { root, workspace } = await fixture(t);
  const proposal = await workspace.prepareWrite({ path: 'new.txt', content: 'new' });
  let attempts = 0;
  const nativeError = busyError();
  mockFilesystem(t, 'link', async () => { attempts++; throw nativeError; });
  await assert.rejects(workspace.commitWrite(proposal), error => error === nativeError);
  assert.equal(attempts, 1);
  assert.deepEqual(await fs.readdir(root), []);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('a successful new-file link reports its side effect if staging cleanup cannot complete', async t => {
  const { root, workspace } = await fixture(t);
  const proposal = await workspace.prepareWrite({ path: 'new.txt', content: 'approved content' });
  let cleanupAttempts = 0;
  const originalUnlink = filesystem.unlink;
  const restore = mockFilesystem(t, 'unlink', async (file, ...args) => {
    if (path.dirname(file) === root && path.basename(file).startsWith('.openaster-')) { cleanupAttempts++; throw busyError('EACCES'); }
    return originalUnlink(file, ...args);
  });
  await assert.rejects(workspace.commitWrite(proposal), { code: 'POST_WRITE_CLEANUP_FAILED', status: 503, message: '文件已写入，但临时文件未能安全清理；请检查工作区。' });
  restore();
  assert.equal(cleanupAttempts, 2);
  assert.equal(await fs.readFile(path.join(root, 'new.txt'), 'utf8'), 'approved content');
  assert.equal((await fs.readdir(root)).filter(name => name.startsWith('.openaster-')).length, 1);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});
