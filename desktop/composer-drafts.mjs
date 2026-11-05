// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CoreError } from '../core/errors.mjs';
import { validateDraftList, validateDraftSnapshot } from '../public/composer-drafts.mjs';

export const DRAFT_REPOSITORY_LIMITS = Object.freeze({ plaintextBytes: 512 * 1024 + 256, encryptedBytes: 1024 * 1024 + 64 * 1024 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const MESSAGES = {
  DRAFT_INVALID_ID: [400, '草稿存储标识无效。'],
  INVALID_DRAFT: [400, '草稿内容格式无效。'],
  INVALID_DRAFT_SNAPSHOT: [400, '草稿版本格式无效。'],
  DRAFT_LIMIT: [413, '草稿超过本地保存容量限制。'],
  DRAFT_CLOSED: [503, '草稿存储已关闭。'],
  DRAFT_CONFLICT: [409, '草稿已被另一操作更新，请重新读取后处理。'],
  DRAFT_CRYPTO_UNAVAILABLE: [503, '系统加密存储不可用，草稿未保存为明文。'],
  DRAFT_ENCRYPT_FAILED: [503, '系统无法加密草稿，请检查系统密钥存储。'],
  DRAFT_DECRYPT_FAILED: [500, '无法解密已有草稿，原文件已保留。'],
  DRAFT_CORRUPT: [500, '已有草稿格式或存储标识无效，原文件已保留。'],
  DRAFT_UNSAFE_PATH: [403, '草稿存储路径必须是普通目录和单链接文件。'],
  DRAFT_CHANGED: [409, '草稿存储目录或文件在操作期间发生变化。'],
  DRAFT_IO: [500, '无法完成本地草稿文件操作。'],
  DRAFT_CLEANUP_INCOMPLETE: [500, '草稿未提交，无法安全清理的临时文件已保留。'],
  DRAFT_COMMIT_UNCERTAIN: [500, '草稿已提交，但临时文件清理未完成；请重新读取并检查本地存储。'],
};
const failure = code => new CoreError(code, MESSAGES[code][1], MESSAGES[code][0]);
const known = cause => cause instanceof CoreError && Object.hasOwn(MESSAGES, cause.code) ? cause : failure('DRAFT_IO');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameStat = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const pathKey = location => process.platform === 'win32' ? location.toLowerCase() : location;
const emptySnapshot = () => ({ version: 1, revision: '0', drafts: [] });

function identifier(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw failure('DRAFT_INVALID_ID');
  return value;
}
function validated(operation) {
  try { return operation(); }
  catch (cause) { throw failure(['INVALID_DRAFT', 'INVALID_DRAFT_SNAPSHOT', 'DRAFT_LIMIT'].includes(cause?.code) ? cause.code : 'INVALID_DRAFT'); }
}
function absolute(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)
    || value.split(/[\\/]/).includes('..') || (process.platform === 'win32' && (!/^[a-zA-Z]:[\\/]/.test(value) || /[:<>"|?*]/.test(value.slice(2))
      || value.slice(3).split(/[\\/]/).some(part => /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) throw failure('DRAFT_UNSAFE_PATH');
  const location = path.resolve(value);
  if (location === path.parse(location).root) throw failure('DRAFT_UNSAFE_PATH');
  return location;
}
async function inspectDirectory(location, missing = false) {
  const parsed = path.parse(location), parts = path.relative(parsed.root, location).split(path.sep).filter(Boolean);
  let current = parsed.root, last;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    try { last = await fs.lstat(current, { bigint: true }); }
    catch (cause) { if (missing && cause.code === 'ENOENT' && index === parts.length - 1) return null; throw failure(cause.code === 'ENOENT' ? 'DRAFT_CHANGED' : 'DRAFT_IO'); }
    if (last.isSymbolicLink() || !last.isDirectory() || last.ino === 0n) throw failure('DRAFT_UNSAFE_PATH');
  }
  const canonical = await fs.realpath(location), after = await fs.lstat(location, { bigint: true });
  if (pathKey(canonical) !== pathKey(location) || !sameIdentity(last, after) || !after.isDirectory() || after.isSymbolicLink()) throw failure('DRAFT_CHANGED');
  return after;
}

/** One repository per locked desktop profile. CAS is serialized within this
 * instance; filesystem identities also detect observed external changes. These
 * checks are not an OS sandbox against hostile same-account TOCTOU replacement.
 * Only encrypted bytes are written, including temporary files. */
export function createDesktopDraftRepository({ directory, crypto, platform = process.platform }) {
  const root = absolute(directory), parent = path.dirname(root);
  let parentIdentity, rootIdentity, rootWasMissing = false, closed = false, tail = Promise.resolve();
  function enqueue(operation) {
    if (closed) return Promise.reject(failure('DRAFT_CLOSED'));
    const result = tail.then(operation).catch(cause => { throw known(cause); });
    tail = result.then(() => {}, () => {});
    return result;
  }
  async function readyCrypto() {
    try {
      if (typeof crypto?.isAsyncEncryptionAvailable !== 'function' || typeof crypto.encryptStringAsync !== 'function' || typeof crypto.decryptStringAsync !== 'function'
        || !await crypto.isAsyncEncryptionAvailable() || (platform === 'linux' && (typeof crypto.getSelectedStorageBackend !== 'function' || !LINUX_BACKENDS.has(crypto.getSelectedStorageBackend())))) throw failure('DRAFT_CRYPTO_UNAVAILABLE');
    } catch { throw failure('DRAFT_CRYPTO_UNAVAILABLE'); }
  }
  async function checkDirectory(create = false) {
    const currentParent = await inspectDirectory(parent);
    if (parentIdentity && !sameIdentity(currentParent, parentIdentity)) throw failure('DRAFT_CHANGED');
    parentIdentity ??= currentParent;
    let current = await inspectDirectory(root, true);
    if (rootIdentity) {
      if (!current || !sameIdentity(current, rootIdentity)) throw failure('DRAFT_CHANGED');
      return true;
    }
    if (current) {
      if (rootWasMissing) throw failure('DRAFT_CHANGED');
      rootIdentity = current; return true;
    }
    rootWasMissing = true;
    if (!create) return false;
    // Only the final profile-owned directory may be created, never its ancestors.
    try { await fs.mkdir(root, { mode: 0o700 }); } catch (cause) { throw failure(cause.code === 'EEXIST' ? 'DRAFT_CHANGED' : 'DRAFT_IO'); }
    current = await inspectDirectory(root);
    if (!sameIdentity(await inspectDirectory(parent), parentIdentity)) throw failure('DRAFT_CHANGED');
    rootIdentity = current; return true;
  }
  const location = id => path.join(root, `${id}.draft`);
  async function readEncrypted(file) {
    if (!await checkDirectory()) return null;
    let before;
    try { before = await fs.lstat(file, { bigint: true }); }
    catch (cause) { if (cause.code === 'ENOENT') { await checkDirectory(); return null; } throw cause; }
    const safe = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.ino !== 0n;
    if (!safe(before)) throw failure('DRAFT_UNSAFE_PATH');
    if (before.size > BigInt(DRAFT_REPOSITORY_LIMITS.encryptedBytes)) throw failure('DRAFT_LIMIT');
    let handle, result, problem;
    try {
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!safe(opened) || !sameStat(before, opened)) throw failure('DRAFT_CHANGED');
      const buffer = Buffer.alloc(Number(before.size) + 1); let size = 0;
      while (size < buffer.length) { const { bytesRead } = await handle.read(buffer, size, buffer.length - size); if (!bytesRead) break; size += bytesRead; }
      const after = await handle.stat({ bigint: true });
      await checkDirectory();
      const named = await fs.lstat(file, { bigint: true });
      if (!safe(after) || !safe(named) || !sameStat(before, after) || !sameStat(after, named) || BigInt(size) !== after.size) throw failure('DRAFT_CHANGED');
      const bytes = buffer.subarray(0, size);
      result = { bytes, info: after, hash: hash(bytes) };
    } catch (cause) { problem = cause; }
    if (handle) { try { await handle.close(); } catch (cause) { problem ??= cause; } }
    if (problem) throw problem;
    return result;
  }
  async function decode(id, encrypted) {
    if (!encrypted) return emptySnapshot();
    let decrypted;
    try { decrypted = await crypto.decryptStringAsync(encrypted.bytes); }
    catch { throw failure('DRAFT_DECRYPT_FAILED'); }
    if (typeof decrypted?.result !== 'string') throw failure('DRAFT_DECRYPT_FAILED');
    if (!decrypted.result.isWellFormed() || Buffer.byteLength(decrypted.result, 'utf8') > DRAFT_REPOSITORY_LIMITS.plaintextBytes) throw failure('DRAFT_CORRUPT');
    try {
      const envelope = JSON.parse(decrypted.result);
      if (!envelope || Array.isArray(envelope) || Object.keys(envelope).length !== 3 || envelope.version !== 1 || envelope.storageId !== id || !Object.hasOwn(envelope, 'snapshot')) throw new Error();
      return validateDraftSnapshot(envelope.snapshot);
    } catch { throw failure('DRAFT_CORRUPT'); }
  }
  async function unchanged(file, original) {
    const current = await readEncrypted(file);
    if (original === null ? current !== null : current === null || !sameStat(original.info, current.info) || original.hash !== current.hash) throw failure('DRAFT_CHANGED');
  }
  async function removeTemporary(file, identity, expected, complete) {
    if (!identity) throw failure('DRAFT_CLEANUP_INCOMPLETE');
    const current = await readEncrypted(file);
    if (!current) return;
    if (!sameIdentity(current.info, identity) || (complete ? !current.bytes.equals(expected) : current.bytes.length > expected.length || !current.bytes.equals(expected.subarray(0, current.bytes.length)))) throw failure('DRAFT_CLEANUP_INCOMPLETE');
    await checkDirectory();
    const named = await fs.lstat(file, { bigint: true });
    if (!sameStat(named, current.info) || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1n) throw failure('DRAFT_CLEANUP_INCOMPLETE');
    await fs.unlink(file);
  }
  async function write(id, expectedRevision, drafts) {
    await readyCrypto();
    const destination = location(id), original = await readEncrypted(destination), current = await decode(id, original);
    if (current.revision !== expectedRevision) throw failure('DRAFT_CONFLICT');
    const snapshot = validated(() => validateDraftSnapshot({ version: 1, revision: randomUUID(), drafts }));
    const plaintext = JSON.stringify({ version: 1, storageId: id, snapshot });
    if (Buffer.byteLength(plaintext) > DRAFT_REPOSITORY_LIMITS.plaintextBytes) throw failure('DRAFT_LIMIT');
    let encrypted;
    try { encrypted = await crypto.encryptStringAsync(plaintext); }
    catch { throw failure('DRAFT_ENCRYPT_FAILED'); }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > DRAFT_REPOSITORY_LIMITS.encryptedBytes) throw failure('DRAFT_ENCRYPT_FAILED');
    encrypted = Buffer.from(encrypted);
    await checkDirectory(true);
    await unchanged(destination, original);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let handle, identity, created = false, complete = false, committed = false, problem;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      created = true;
      identity = await handle.stat({ bigint: true });
      if (!identity.isFile() || identity.nlink !== 1n || identity.ino === 0n) throw failure('DRAFT_UNSAFE_PATH');
      await handle.writeFile(encrypted); complete = true;
      await handle.sync();
      await handle.close(); handle = null;
      const staged = await readEncrypted(temporary);
      if (!staged || !sameIdentity(staged.info, identity) || !staged.bytes.equals(encrypted)) throw failure('DRAFT_CHANGED');
      await unchanged(destination, original);
      await checkDirectory();
      const finalTemporary = await fs.lstat(temporary, { bigint: true });
      if (!sameStat(finalTemporary, staged.info) || !finalTemporary.isFile() || finalTemporary.isSymbolicLink() || finalTemporary.nlink !== 1n) throw failure('DRAFT_CHANGED');
      if (original) {
        await fs.rename(temporary, destination); committed = true; created = false;
      } else {
        // An exclusive first installation cannot overwrite a concurrently created file.
        await fs.link(temporary, destination); committed = true;
        await checkDirectory();
        const installed = await fs.lstat(destination, { bigint: true }), temp = await fs.lstat(temporary, { bigint: true });
        if (!sameIdentity(installed, identity) || !sameIdentity(temp, identity) || !temp.isFile() || temp.isSymbolicLink() || temp.nlink !== 2n || installed.nlink !== 2n
          || temp.size !== BigInt(encrypted.length) || temp.mtimeNs !== staged.info.mtimeNs) throw failure('DRAFT_COMMIT_UNCERTAIN');
        await fs.unlink(temporary); created = false;
      }
    } catch (cause) { problem = known(cause); }
    if (handle) { try { await handle.close(); } catch { problem ??= failure('DRAFT_IO'); } }
    if (created && !committed) {
      try { await removeTemporary(temporary, identity, encrypted, complete); }
      catch { const cleanup = failure('DRAFT_CLEANUP_INCOMPLETE'); Object.defineProperty(cleanup, 'cause', { value: problem, configurable: true }); problem = cleanup; }
    }
    if (committed && problem) throw failure('DRAFT_COMMIT_UNCERTAIN');
    if (problem) throw problem;
    return snapshot;
  }
  return {
    async read(storageId) {
      identifier(storageId);
      return enqueue(async () => { await readyCrypto(); const encrypted = await readEncrypted(location(storageId)); const snapshot = await decode(storageId, encrypted); await unchanged(location(storageId), encrypted); return snapshot; });
    },
    async compareAndSwap(storageId, expectedRevision, drafts) {
      identifier(storageId);
      if (expectedRevision !== '0') identifier(expectedRevision);
      const copy = validated(() => validateDraftList(drafts));
      return enqueue(() => write(storageId, expectedRevision, copy));
    },
    async drain() { await tail; },
    async close() { closed = true; await tail; },
  };
}
