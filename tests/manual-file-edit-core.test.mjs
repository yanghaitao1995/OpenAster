// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createWorkspace, MAX_FILE_BYTES } from '../core/workspace.mjs';
import { CoreError } from '../core/errors.mjs';
import { createManualFileEditor, validateManualFileEdit } from '../server/manual-file-edit.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'openaster-manual-core-'));
  const root = path.join(base, 'workspace'); await fs.mkdir(root);
  const restorers = [], gates = [];
  t.after(async () => { for (const gate of gates) gate.resolve(); for (const restore of restorers.reverse()) restore(); await fs.rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  const workspace = createWorkspace(root, options);
  function patch(object, key, replacement) {
    const original = object[key]; object[key] = replacement(original);
    syncBuiltinESMExports();
    const restore = () => { object[key] = original; syncBuiltinESMExports(); };
    restorers.push(restore); return restore;
  }
  async function put(content, relative = 'file.txt') { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); return { file, input: { path: relative, content: 'after', expectedHash: hash(content) } }; }
  function gate() { const value = deferred(); gates.push(value); return value; }
  return { root, base, workspace, put, patch, gate };
}

test('manual replacement binds an existing raw snapshot and preserves exact BOM, mixed endings and an empty file', async t => {
  const f = await fixture(t), before = '\uFEFF first\r\nnext\rlast\n😀', after = '\uFEFF first\r\nnext\rchanged\n😀';
  const { file, input } = await f.put(before, ' file.txt');
  const proposal = await f.workspace.prepareReplace({ ...input, content: after });
  assert.equal(proposal.originalHash, hash(before)); assert.equal(proposal.originalContent, before);
  assert.equal(Object.isFrozen(proposal), true); assert.equal(Object.hasOwn(proposal, 'mode'), false);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await f.workspace.commitWrite(proposal), { path: input.path, bytes: Buffer.byteLength(after), sha256: hash(after) });
  assert.deepEqual(await fs.readFile(file), Buffer.from(after));
  const empty = await f.workspace.prepareReplace({ ...input, content: '', expectedHash: hash(after) });
  await f.workspace.commitWrite(empty);
  assert.equal((await fs.stat(file)).isFile(), true); assert.equal((await fs.readFile(file)).length, 0);
  await f.workspace.commitWrite(await f.workspace.prepareReplace({ ...input, content: 'from empty', expectedHash: hash('') }));
  assert.equal(await fs.readFile(file, 'utf8'), 'from empty');
  await assert.rejects(f.workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('manual replacement rejects missing files, stale or malformed hashes and malformed or oversized UTF-8', async t => {
  const f = await fixture(t), { file, input } = await f.put('before');
  for (const expectedHash of [null, undefined, '', 'A'.repeat(64), 'a'.repeat(63)]) await assert.rejects(f.workspace.prepareReplace({ ...input, expectedHash }), { code: 'INVALID_HASH' });
  await assert.rejects(f.workspace.prepareReplace({ ...input, expectedHash: hash('stale') }), { code: 'WRITE_CONFLICT', status: 409 });
  for (const content of [null, 3, 'a\0b', '\ud800', '\udfff']) await assert.rejects(f.workspace.prepareReplace({ ...input, content }), { code: 'INVALID_CONTENT' });
  await assert.rejects(f.workspace.prepareReplace({ ...input, content: '中'.repeat(MAX_FILE_BYTES) }), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(f.workspace.prepareReplace({ ...input, path: 'absent/f.txt' }), { code: 'FILE_NOT_FOUND' });
  assert.deepEqual(await fs.readdir(f.root), ['file.txt']); assert.equal(await fs.readFile(file, 'utf8'), 'before');
  for (const [content, code] of [[Buffer.from([0xff]), 'BINARY_FILE'], [Buffer.from([0]), 'BINARY_FILE'], [Buffer.alloc(MAX_FILE_BYTES + 1), 'FILE_TOO_LARGE']]) {
    await fs.writeFile(file, content);
    await assert.rejects(f.workspace.prepareReplace({ ...input, expectedHash: hash(content) }), { code });
  }
  await fs.writeFile(file, Buffer.alloc(MAX_FILE_BYTES, 97));
  const proposal = await f.workspace.prepareReplace({ ...input, expectedHash: hash(Buffer.alloc(MAX_FILE_BYTES, 97)), content: 'b'.repeat(MAX_FILE_BYTES) });
  await f.workspace.commitWrite(proposal); assert.equal((await fs.stat(file)).size, MAX_FILE_BYTES);
});

test('manual replacement retains path, sensitive-file, hardlink and parent redirection boundaries', async t => {
  const f = await fixture(t, { denySensitivePaths: true }), { file, input } = await f.put('before');
  for (const relative of ['../file.txt', 'a/../file.txt', '/file.txt', 'CON.txt', 'a%2fb', 'a\\b']) await assert.rejects(f.workspace.prepareReplace({ ...input, path: relative }), { code: 'INVALID_PATH' });
  await f.put('secret', '.env'); await assert.rejects(f.workspace.prepareReplace({ ...input, path: '.env', expectedHash: hash('secret') }), { code: 'SENSITIVE_PATH' });
  await fs.link(file, path.join(f.root, 'alias.txt'));
  await assert.rejects(f.workspace.prepareReplace(input), { code: 'UNSAFE_PATH' });
  await fs.unlink(path.join(f.root, 'alias.txt'));
  const external = path.join(f.base, 'outside'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'file.txt'), 'before');
  await fs.symlink(external, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.workspace.prepareReplace({ ...input, path: 'linked/file.txt' }), { code: 'UNSAFE_PATH' });
  assert.equal(await fs.readFile(path.join(external, 'file.txt'), 'utf8'), 'before');
});

test('a manual capability is instance-bound and competing manual/model proposals cannot overwrite each other', async t => {
  const f = await fixture(t), { file, input } = await f.put('before');
  const manual = await f.workspace.prepareReplace(input), model = await f.workspace.prepareWrite({ path: input.path, content: 'model' });
  await assert.rejects(createWorkspace(f.root).commitWrite(manual), { code: 'INVALID_APPROVAL' });
  await assert.rejects(f.workspace.commitWrite({ ...manual }), { code: 'INVALID_APPROVAL' });
  const second = await f.workspace.prepareReplace({ ...input, content: 'other client' });
  const results = await Promise.allSettled([f.workspace.commitWrite(manual), f.workspace.commitWrite(second)]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']); assert.equal(results[1].reason.code, 'WRITE_CONFLICT');
  await assert.rejects(f.workspace.commitWrite(model), { code: 'WRITE_CONFLICT' });
  assert.equal(await fs.readFile(file, 'utf8'), 'after');
});

test('manual prepare preserves its one checked snapshot even if bytes change immediately after its read', async t => {
  const f = await fixture(t), { file, input } = await f.put('before');
  const handle = await fs.open(file, 'r'), proto = Object.getPrototypeOf(handle); await handle.close();
  let changed = false;
  const restore = f.patch(proto, 'read', original => async function (...args) {
    const result = await original.apply(this, args);
    if (!changed && result.bytesRead === 0) { changed = true; await fs.writeFile(file, 'external'); }
    return result;
  });
  const proposal = await f.workspace.prepareReplace(input); restore();
  assert.equal(proposal.originalHash, hash('before')); assert.equal(proposal.originalContent, 'before');
  await assert.rejects(f.workspace.commitWrite(proposal), { code: 'WRITE_CONFLICT' });
  assert.equal(await fs.readFile(file, 'utf8'), 'external');
});

test('removing an existing-file parent after the commit snapshot does not recreate directories', async t => {
  const f = await fixture(t), { file, input } = await f.put('before', 'parent/file.txt');
  const proposal = await f.workspace.prepareReplace(input); let targetStats = 0, removed = false;
  f.patch(fs, 'lstat', original => async function (target, ...args) {
    const stat = await original.call(this, target, ...args);
    if (path.resolve(target) === file && ++targetStats === 3) { await fs.rm(path.dirname(file), { recursive: true }); removed = true; }
    return stat;
  });
  await assert.rejects(f.workspace.commitWrite(proposal), { code: 'FILE_NOT_FOUND' });
  assert.equal(removed, true); assert.deepEqual(await fs.readdir(f.root), []);
});

test('post-preview deletion and root replacement fail without creating a replacement target', async t => {
  const f = await fixture(t), { file, input } = await f.put('before');
  const proposal = await f.workspace.prepareReplace(input); await fs.unlink(file);
  await assert.rejects(f.workspace.commitWrite(proposal), { code: 'WRITE_CONFLICT' });
  assert.deepEqual(await fs.readdir(f.root), []);
  await f.put('before'); const pending = await f.workspace.prepareReplace(input);
  await fs.rename(f.root, path.join(f.base, 'old')); await fs.mkdir(f.root);
  await assert.rejects(f.workspace.commitWrite(pending), { code: 'WORKSPACE_CHANGED' });
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('cancellation after preparing and while a staging write drains consumes the capability without mutation', async t => {
  const f = await fixture(t), { file, input } = await f.put('before');
  await assert.rejects(f.workspace.prepareReplace(input, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  const proposal = await f.workspace.prepareReplace(input);
  const handle = await fs.open(file, 'r'), proto = Object.getPrototypeOf(handle); await handle.close();
  const entered = f.gate(), release = f.gate(); let renameCalls = 0;
  f.patch(proto, 'sync', original => async function (...args) { entered.resolve(); await release.promise; return original.apply(this, args); });
  f.patch(fs, 'rename', original => async function (...args) { renameCalls++; return original.apply(this, args); });
  const controller = new AbortController(), pending = f.workspace.commitWrite(proposal, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'CANCELLED' }); await entered.promise; controller.abort(); await turn();
  assert.equal(renameCalls, 0); release.resolve(); await rejected;
  assert.equal(await fs.readFile(file, 'utf8'), 'before'); assert.deepEqual(await fs.readdir(f.root), ['file.txt']);
  await assert.rejects(f.workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('manual mode metadata stays private and POSIX replacement preserves rwx without special privilege bits', async t => {
  const f = await fixture(t), { file, input } = await f.put('before');
  if (process.platform !== 'win32') await fs.chmod(file, 0o6751);
  const proposal = await f.workspace.prepareReplace(input);
  assert.deepEqual(Object.keys(proposal).sort(), ['bytes','content','id','newHash','originalContent','originalHash','path']);
  await f.workspace.commitWrite(proposal);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o7777, 0o751);
  assert.equal(await fs.readFile(file, 'utf8'), 'after');
});

test('manual request validation rejects accessors and unknown fields without invoking getters', () => {
  const storageId = randomUUID(), input = { storageId, path: 'x', expectedHash: hash('x'), content: 'y' };
  assert.deepEqual(validateManualFileEdit(input, storageId), input);
  for (const value of [{ ...input, force: true }, { ...input, storageId: 'bad' }, { ...input, storageId: randomUUID() }]) assert.throws(() => validateManualFileEdit(value, storageId), e => ['INVALID_FILE_EDIT','FILE_EDIT_WORKSPACE_CHANGED'].includes(e.code));
  let calls = 0; const bad = { ...input }; Object.defineProperty(bad, 'content', { get() { calls++; return 'changed'; }, enumerable: true });
  assert.throws(() => validateManualFileEdit(bad, storageId), { code: 'INVALID_FILE_EDIT' }); assert.equal(calls, 0);
});

test('no-op manual saves do not rewrite the file or fabricate a save audit', async t => {
  const f = await fixture(t), { file, input } = await f.put('before'), storageId = randomUUID(), audits = [];
  const editor = createManualFileEditor({ workspace: f.workspace, storageId: () => storageId, audit: e => audits.push(e) });
  const before = await fs.stat(file, { bigint: true });
  const result = await editor.run({ ...input, storageId, content: 'before' });
  assert.equal(result.changed, false); assert.equal(result.sha256, hash('before')); assert.deepEqual(audits, []);
  const after = await fs.stat(file, { bigint: true }); assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  await editor.close();
});

test('manual audits fail closed before writing and report actual mutation after a post-write failure', async t => {
  const f = await fixture(t), { file, input } = await f.put('before'), storageId = randomUUID();
  let failAction = 'workspace.manual-save.requested', notified = 0;
  const editor = createManualFileEditor({ workspace: f.workspace, storageId: () => storageId, audit: e => { if (e.action === failAction) throw new Error('private database diagnostic'); }, onSaved: () => { notified++; } });
  await assert.rejects(editor.run({ ...input, storageId }), { code: 'AUDIT_UNAVAILABLE' });
  assert.equal(await fs.readFile(file, 'utf8'), 'before'); assert.equal(notified, 0);
  failAction = 'workspace.manual-saved';
  await assert.rejects(editor.run({ ...input, storageId }), e => e.code === 'POST_WRITE_AUDIT_FAILED' && e.message.includes('文件已写入') && !e.message.includes('private'));
  assert.equal(await fs.readFile(file, 'utf8'), 'after'); assert.equal(notified, 1);
  await editor.close();
});

test('post-write cleanup failures retain the save fact and notification failures do not invent rollback', async t => {
  const f = await fixture(t), { file, input } = await f.put('before'), storageId = randomUUID(), audits = [];
  const wrapped = { ...f.workspace, async commitWrite(...args) { await f.workspace.commitWrite(...args); throw new CoreError('POST_WRITE_CLEANUP_FAILED', '文件已写入，但临时文件未能安全清理。', 503); } };
  const editor = createManualFileEditor({ workspace: wrapped, storageId: () => storageId, audit: e => audits.push(e), onSaved: () => { throw new Error('notification only'); } });
  await assert.rejects(editor.run({ ...input, storageId }), { code: 'POST_WRITE_CLEANUP_FAILED' });
  assert.equal(await fs.readFile(file, 'utf8'), 'after'); assert.equal(audits.at(-1).action, 'workspace.manual-saved'); assert.equal(audits.at(-1).detail.cleanupPending, true);
  await editor.close();
});

test('an existing target removed immediately before the last resolve is not recreated by rename', async t => {
  const f = await fixture(t), { file, input } = await f.put('before');
  const proposal = await f.workspace.prepareReplace(input); let targetStats = 0, renameCalls = 0;
  f.patch(fs, 'lstat', original => async function (target, ...args) {
    if (path.resolve(target) === file && ++targetStats === 8) await fs.unlink(file);
    return original.call(this, target, ...args);
  });
  f.patch(fs, 'rename', original => async function (...args) { renameCalls++; return original.apply(this, args); });
  await assert.rejects(f.workspace.commitWrite(proposal), { code: 'FILE_NOT_FOUND' });
  assert.equal(targetStats, 8); assert.equal(renameCalls, 0); assert.deepEqual(await fs.readdir(f.root), []);
  await assert.rejects(f.workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
});

test('POSIX permission tightening before and during a manual commit is a conflict, not an implicit chmod reversal', { skip: process.platform === 'win32' ? 'POSIX rwx/chmod behavior requires a POSIX filesystem; Windows coverage does not claim ACL preservation.' : false }, async t => {
  const f = await fixture(t), { file, input } = await f.put('before');
  await fs.chmod(file, 0o755); const first = await f.workspace.prepareReplace(input);
  await fs.chmod(file, 0o700);
  await assert.rejects(f.workspace.commitWrite(first), { code: 'WRITE_CONFLICT' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o700); assert.equal(await fs.readFile(file, 'utf8'), 'before');
  await fs.chmod(file, 0o755); const second = await f.workspace.prepareReplace(input);
  const handle = await fs.open(file, 'r'), proto = Object.getPrototypeOf(handle); await handle.close();
  const entered = f.gate(), release = f.gate();
  f.patch(proto, 'sync', original => async function (...args) { entered.resolve(); await release.promise; return original.apply(this, args); });
  const pending = f.workspace.commitWrite(second), rejected = assert.rejects(pending, { code: 'WRITE_CONFLICT' });
  await entered.promise; await fs.chmod(file, 0o640); release.resolve(); await rejected;
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640); assert.equal(await fs.readFile(file, 'utf8'), 'before');
  assert.deepEqual(await fs.readdir(f.root), ['file.txt']);
});
