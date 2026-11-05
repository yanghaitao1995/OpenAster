// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createDesktopDraftRepository, DRAFT_REPOSITORY_LIMITS } from './composer-drafts.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const draft = (text = '未发送的草稿', slot = 'new') => ({ slot, text, files: [], providerId: 'demo', skillId: 'general', updatedAt: new Date().toISOString(), revision: randomUUID(), uncertain: false });
const code = expected => cause => { assert.equal(cause.code, expected); assert.ok(cause.status >= 400); return true; };
const nativeFailure = (code = 'EIO') => Object.assign(new Error('fixture-only failure'), { code });
function simulatedCrypto() {
  // Real authenticated encryption for file integrity fixtures; this is not DPAPI evidence.
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    async encryptStringAsync(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async decryptStringAsync(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
  };
}
async function fixture(t, overrides = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'openaster-drafts-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const profile = path.join(parent, 'profile'); await fs.mkdir(profile);
  const directory = path.join(profile, 'drafts'), crypto = simulatedCrypto(), id = randomUUID();
  const repo = createDesktopDraftRepository({ directory, crypto, ...overrides });
  t.after(() => repo.close());
  return { parent, profile, directory, crypto, id, repo, file: path.join(directory, `${id}.draft`) };
}
async function temporaryNames(directory) { return (await fs.readdir(directory)).filter(name => name.endsWith('.tmp')); }

test('encrypted roundtrip preserves raw draft text and references above credential-vault size', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.repo.read(f.id), { version: 1, revision: '0', drafts: [] });
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
  const items = [draft('\ufeff  中文\r\n' + '甲'.repeat(12000))];
  items[0].files = [{ path: '源代码/ file.txt', sha256: 'a'.repeat(64), bytes: 256 * 1024 }];
  items[0].uncertain = true;
  const saved = await f.repo.compareAndSwap(f.id, '0', items);
  const bytes = await fs.readFile(f.file);
  assert.ok(bytes.length > 16 * 1024);
  assert.equal(bytes.includes(Buffer.from('中文')), false);
  assert.equal(bytes.includes(Buffer.from(items[0].files[0].path)), false);
  assert.deepEqual(saved.drafts, items);
  saved.drafts[0].text = 'caller mutated result'; items[0].text = 'caller mutated input';
  await f.repo.close();
  const restarted = createDesktopDraftRepository({ directory: f.directory, crypto: f.crypto }); t.after(() => restarted.close());
  const read = await restarted.read(f.id);
  assert.ok(read.drafts[0].text.startsWith('\ufeff  中文\r\n'));
  const cleared = await restarted.compareAndSwap(f.id, read.revision, []);
  assert.notEqual(cleared.revision, '0');
  assert.deepEqual(await restarted.read(f.id), cleared);
  assert.deepEqual(await temporaryNames(f.directory), []);
});

test('CAS serializes competing revisions and snapshots mutable arguments before queuing', async t => {
  const f = await fixture(t), input = [draft('first')];
  const first = f.repo.compareAndSwap(f.id, '0', input);
  input[0].text = 'mutated';
  const outcomes = await Promise.allSettled([first, f.repo.compareAndSwap(f.id, '0', [draft('second')])]);
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].reason.code, 'DRAFT_CONFLICT');
  assert.equal((await f.repo.read(f.id)).drafts[0].text, 'first');
});

test('drain and close wait for admitted encryption, and close refuses new operations', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const original = f.crypto.encryptStringAsync;
  f.crypto.encryptStringAsync = async value => { entered.resolve(); await release.promise; return original(value); };
  const write = f.repo.compareAndSwap(f.id, '0', [draft()]); await entered.promise;
  let drained = false, closed = false;
  const draining = f.repo.drain().then(() => { drained = true; });
  const closing = f.repo.close().then(() => { closed = true; });
  await assert.rejects(f.repo.read(f.id), code('DRAFT_CLOSED'));
  await assert.rejects(f.repo.compareAndSwap(f.id, '0', []), code('DRAFT_CLOSED'));
  assert.equal(drained, false); assert.equal(closed, false);
  release.resolve(); const result = await write; await Promise.all([draining, closing]);
  assert.equal(drained, true); assert.equal(closed, true);
  const reopened = createDesktopDraftRepository({ directory: f.directory, crypto: f.crypto }); t.after(() => reopened.close());
  assert.deepEqual(await reopened.read(f.id), result);
});

test('missing OS encryption and weak or unknown Linux backends never create plaintext', async t => {
  const f = await fixture(t);
  for (const backend of ['basic_text', 'unknown', '', undefined]) {
    const repo = createDesktopDraftRepository({ directory: f.directory, platform: 'linux', crypto: { ...f.crypto, getSelectedStorageBackend: () => backend } });
    await assert.rejects(repo.compareAndSwap(f.id, '0', [draft()]), code('DRAFT_CRYPTO_UNAVAILABLE')); await repo.close();
  }
  for (const crypto of [{}, { ...f.crypto, isAsyncEncryptionAvailable: async () => false }, { ...f.crypto, isAsyncEncryptionAvailable: async () => { throw nativeFailure(); } }]) {
    const repo = createDesktopDraftRepository({ directory: f.directory, crypto });
    await assert.rejects(repo.read(f.id), code('DRAFT_CRYPTO_UNAVAILABLE')); await repo.close();
  }
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('invalid identifiers, strict schema and aggregate limits preserve the old encrypted file', async t => {
  const f = await fixture(t), saved = await f.repo.compareAndSwap(f.id, '0', [draft('original')]), before = await fs.readFile(f.file);
  for (const id of ['../outside', '', 'CON', f.id.toUpperCase(), `${f.id}:stream`]) await assert.rejects(f.repo.read(id), code('DRAFT_INVALID_ID'));
  await assert.rejects(f.repo.compareAndSwap(f.id, null, []), code('DRAFT_INVALID_ID'));
  for (const items of [[{ ...draft(), apiKey: 'secret' }], [draft('\ud800')], [draft('x\0y')]]) await assert.rejects(f.repo.compareAndSwap(f.id, saved.revision, items), code('INVALID_DRAFT'));
  for (const items of [[draft('x'.repeat(16001))], Array.from({ length: 21 }, (_, i) => draft('', `slot${i}`)), Array.from({ length: 20 }, (_, i) => draft('中'.repeat(16000), `slot${i}`))]) await assert.rejects(f.repo.compareAndSwap(f.id, saved.revision, items), code('DRAFT_LIMIT'));
  assert.deepEqual(await fs.readFile(f.file), before);
});

test('encryption failure and oversized provider output leave the old value and queue usable', async t => {
  const f = await fixture(t), saved = await f.repo.compareAndSwap(f.id, '0', [draft('old')]), before = await fs.readFile(f.file), original = f.crypto.encryptStringAsync;
  for (const result of [null, Buffer.alloc(0), Buffer.alloc(DRAFT_REPOSITORY_LIMITS.encryptedBytes + 1)]) {
    f.crypto.encryptStringAsync = async () => result;
    await assert.rejects(f.repo.compareAndSwap(f.id, saved.revision, [draft('new')]), code('DRAFT_ENCRYPT_FAILED'));
  }
  f.crypto.encryptStringAsync = async () => { throw new Error('plaintext must not appear in public error'); };
  const error = await f.repo.compareAndSwap(f.id, saved.revision, []).catch(value => value);
  assert.equal(error.code, 'DRAFT_ENCRYPT_FAILED'); assert.equal(error.message.includes('plaintext'), false);
  assert.deepEqual(await fs.readFile(f.file), before);
  f.crypto.encryptStringAsync = original;
  assert.equal((await f.repo.compareAndSwap(f.id, saved.revision, [draft('recovered')])).drafts[0].text, 'recovered');
});

test('corrupt, transplanted and invalid decrypted snapshots cannot be overwritten', async t => {
  const f = await fixture(t); await f.repo.compareAndSwap(f.id, '0', [draft()]);
  const good = await fs.readFile(f.file), foreignId = randomUUID();
  await fs.copyFile(f.file, path.join(f.directory, `${foreignId}.draft`));
  await assert.rejects(f.repo.read(foreignId), code('DRAFT_CORRUPT'));
  await fs.writeFile(f.file, Buffer.from('not encrypted'));
  await assert.rejects(f.repo.read(f.id), code('DRAFT_DECRYPT_FAILED'));
  await assert.rejects(f.repo.compareAndSwap(f.id, '0', []), code('DRAFT_DECRYPT_FAILED'));
  assert.equal((await fs.readFile(f.file)).toString(), 'not encrypted');
  const bad = await f.crypto.encryptStringAsync(JSON.stringify({ version: 1, storageId: f.id, snapshot: { version: 1, revision: '0', drafts: [draft()] } }));
  await fs.writeFile(f.file, bad);
  await assert.rejects(f.repo.read(f.id), code('DRAFT_CORRUPT'));
  assert.deepEqual(await fs.readFile(f.file), bad);
  await fs.writeFile(f.file, good);
  assert.equal((await f.repo.read(f.id)).drafts.length, 1);
});

test('oversized existing ciphertext is rejected before decrypting or reading its body', async t => {
  const f = await fixture(t); await fs.mkdir(f.directory);
  const file = await fs.open(f.file, 'wx'); await file.truncate(DRAFT_REPOSITORY_LIMITS.encryptedBytes + 1); await file.close();
  let decrypts = 0; f.crypto.decryptStringAsync = async () => { decrypts++; throw new Error(); };
  await assert.rejects(f.repo.read(f.id), code('DRAFT_LIMIT'));
  assert.equal(decrypts, 0); assert.equal((await fs.stat(f.file)).size, DRAFT_REPOSITORY_LIMITS.encryptedBytes + 1);
});

test('hardlinked ciphertext and ancestor junctions are rejected without changing targets', async t => {
  const f = await fixture(t); await f.repo.compareAndSwap(f.id, '0', [draft()]);
  const alias = path.join(f.parent, 'alias.draft'), bytes = await fs.readFile(f.file);
  await fs.link(f.file, alias);
  await assert.rejects(f.repo.read(f.id), code('DRAFT_UNSAFE_PATH'));
  await assert.rejects(f.repo.compareAndSwap(f.id, '0', []), code('DRAFT_UNSAFE_PATH'));
  assert.deepEqual(await fs.readFile(alias), bytes); await fs.unlink(alias);
  const linked = path.join(f.parent, 'linked-profile'); await fs.symlink(f.profile, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const repo = createDesktopDraftRepository({ directory: path.join(linked, 'drafts'), crypto: f.crypto });
  await assert.rejects(repo.read(f.id), code('DRAFT_UNSAFE_PATH')); await repo.close();
});

test('root or parent replacement after binding cannot be silently adopted or recreated', async t => {
  for (const part of ['root', 'parent']) {
    const f = await fixture(t), saved = await f.repo.compareAndSwap(f.id, '0', [draft('retained')]);
    const target = part === 'root' ? f.directory : f.profile, moved = `${target}-moved`;
    await fs.rename(target, moved);
    await assert.rejects(f.repo.read(f.id), code('DRAFT_CHANGED'));
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    await fs.mkdir(target);
    await assert.rejects(f.repo.compareAndSwap(f.id, saved.revision, []), code('DRAFT_CHANGED'));
    const originalFile = part === 'root' ? path.join(moved, `${f.id}.draft`) : path.join(moved, 'drafts', `${f.id}.draft`);
    assert.ok((await fs.stat(originalFile)).size > 0);
  }
});

test('an observed external change during asynchronous encryption is not overwritten', async t => {
  const f = await fixture(t), saved = await f.repo.compareAndSwap(f.id, '0', [draft('old')]);
  const encrypt = f.crypto.encryptStringAsync;
  f.crypto.encryptStringAsync = async value => { await fs.writeFile(f.file, 'external marker'); return encrypt(value); };
  await assert.rejects(f.repo.compareAndSwap(f.id, saved.revision, [draft('new')]), code('DRAFT_CHANGED'));
  assert.equal((await fs.readFile(f.file)).toString(), 'external marker');
  assert.deepEqual(await temporaryNames(f.directory), []);
});

test('rename rejection preserves old bytes and safely removes only its owned temporary', async t => {
  const f = await fixture(t), saved = await f.repo.compareAndSwap(f.id, '0', [draft('old')]), before = await fs.readFile(f.file);
  const mock = t.mock.method(fs, 'rename', async () => { throw nativeFailure('EPERM'); });
  await assert.rejects(f.repo.compareAndSwap(f.id, saved.revision, [draft('new')]), code('DRAFT_IO'));
  mock.mock.restore();
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(await temporaryNames(f.directory), []);
  assert.equal((await f.repo.compareAndSwap(f.id, saved.revision, [draft('after failure')])).drafts[0].text, 'after failure');
});

test('exclusive first installation never overwrites a foreign file appearing at link time', async t => {
  const f = await fixture(t), link = fs.link;
  const mock = t.mock.method(fs, 'link', async (source, destination) => { await fs.writeFile(destination, 'foreign marker', { flag: 'wx' }); return link(source, destination); });
  await assert.rejects(f.repo.compareAndSwap(f.id, '0', [draft()]), code('DRAFT_IO')); mock.mock.restore();
  assert.equal((await fs.readFile(f.file)).toString(), 'foreign marker'); assert.deepEqual(await temporaryNames(f.directory), []);
});

test('same-inode temporary changes are preserved when a replacement fails', async t => {
  const f = await fixture(t), saved = await f.repo.compareAndSwap(f.id, '0', [draft('old')]), before = await fs.readFile(f.file);
  const mock = t.mock.method(fs, 'rename', async temporary => { await fs.writeFile(temporary, 'unowned content'); throw nativeFailure(); });
  await assert.rejects(f.repo.compareAndSwap(f.id, saved.revision, [draft('new')]), code('DRAFT_CLEANUP_INCOMPLETE')); mock.mock.restore();
  assert.deepEqual(await fs.readFile(f.file), before);
  const names = await temporaryNames(f.directory); assert.equal(names.length, 1);
  assert.equal((await fs.readFile(path.join(f.directory, names[0]))).toString(), 'unowned content');
});

test('cleanup never follows a replaced root to delete a foreign temporary-name marker', async t => {
  const f = await fixture(t), saved = await f.repo.compareAndSwap(f.id, '0', [draft('old')]), before = await fs.readFile(f.file), rename = fs.rename;
  const moved = `${f.directory}-moved`; let temporaryName;
  const mock = t.mock.method(fs, 'rename', async temporary => {
    temporaryName = path.basename(temporary);
    await rename(f.directory, moved); await fs.mkdir(f.directory);
    await fs.writeFile(path.join(f.directory, temporaryName), 'foreign marker', { flag: 'wx' });
    throw nativeFailure();
  });
  await assert.rejects(f.repo.compareAndSwap(f.id, saved.revision, [draft('new')]), code('DRAFT_CLEANUP_INCOMPLETE')); mock.mock.restore();
  assert.equal((await fs.readFile(path.join(f.directory, temporaryName))).toString(), 'foreign marker');
  assert.deepEqual(await fs.readFile(path.join(moved, `${f.id}.draft`)), before);
  assert.ok((await fs.stat(path.join(moved, temporaryName))).size > 0);
});

test('a ciphertext replaced while OS decryption waits is not reported as a current snapshot', async t => {
  const f = await fixture(t); await f.repo.compareAndSwap(f.id, '0', [draft('old')]);
  const decrypt = f.crypto.decryptStringAsync;
  f.crypto.decryptStringAsync = async bytes => { const result = await decrypt(bytes); await fs.writeFile(f.file, 'new external marker'); return result; };
  await assert.rejects(f.repo.read(f.id), code('DRAFT_CHANGED'));
  assert.equal((await fs.readFile(f.file)).toString(), 'new external marker');
});

for (const point of ['stat', 'writeFile', 'sync', 'close']) {
  test(`temporary ${point} failure preserves original and follows known-identity cleanup`, async t => {
    const f = await fixture(t), saved = await f.repo.compareAndSwap(f.id, '0', [draft('old')]), before = await fs.readFile(f.file), open = fs.open;
    let failed = false;
    const mock = t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (!String(file).endsWith('.tmp') || typeof args[0] !== 'number' || !(args[0] & 1)) return handle;
      return new Proxy(handle, { get(target, property) {
        const method = target[property];
        if (typeof method !== 'function') return method;
        if (property === point) return async (...values) => { if (!failed) { failed = true; throw nativeFailure(); } return method.apply(target, values); };
        return method.bind(target);
      } });
    });
    await assert.rejects(f.repo.compareAndSwap(f.id, saved.revision, [draft('new')]), code(point === 'stat' ? 'DRAFT_CLEANUP_INCOMPLETE' : 'DRAFT_IO')); mock.mock.restore();
    assert.equal(failed, true); assert.deepEqual(await fs.readFile(f.file), before);
    assert.equal((await temporaryNames(f.directory)).length, point === 'stat' ? 1 : 0);
  });
}

test('first installation cleanup failure reports committed uncertainty and preserves both hardlinks', async t => {
  const f = await fixture(t), unlink = fs.unlink;
  const mock = t.mock.method(fs, 'unlink', async file => { if (String(file).endsWith('.tmp')) throw nativeFailure('EPERM'); return unlink(file); });
  await assert.rejects(f.repo.compareAndSwap(f.id, '0', [draft()]), code('DRAFT_COMMIT_UNCERTAIN')); mock.mock.restore();
  const names = await temporaryNames(f.directory); assert.equal(names.length, 1);
  assert.equal((await fs.stat(f.file)).nlink, 2);
  assert.deepEqual(await fs.readFile(f.file), await fs.readFile(path.join(f.directory, names[0])));
  await assert.rejects(f.repo.read(f.id), code('DRAFT_UNSAFE_PATH'));
});
