// SPDX-License-Identifier: Apache-2.0
// Device-local drafts only: this module has no network or file-content access.
export const DRAFT_LIMITS = Object.freeze({
  drafts: 20,
  textCharacters: 16000,
  files: 5,
  fileBytes: 256 * 1024,
  snapshotBytes: 512 * 1024,
});

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu;
const DRAFT_FIELDS = ['slot', 'text', 'files', 'providerId', 'skillId', 'updatedAt', 'revision', 'uncertain'];
const EMPTY = () => ({ version: 1, revision: '0', drafts: [] });
const SAMPLE_REVISION = '00000000-0000-4000-8000-000000000000';
const encoder = new TextEncoder();
const messages = Object.freeze({
  INVALID_DRAFT: '草稿格式无效，未保存任何更改。',
  INVALID_DRAFT_SNAPSHOT: '草稿快照格式或版本无效。',
  INVALID_DRAFT_SCOPE: '草稿所属工作台身份无效。',
  INVALID_DRAFT_REVISION: '草稿修订标识无效。',
  DRAFT_LIMIT: '草稿超过本机保存数量或大小限制；原有草稿未被删除。',
  DRAFT_CONFLICT: '草稿已被另一个页面更新，请重新读取后再保存。',
  DRAFT_STORAGE_UNAVAILABLE: '此环境暂时无法使用本机草稿存储。',
  DRAFT_STORAGE_CORRUPT: '本机草稿存储内容或版本无效，原有数据已保留。',
  DRAFT_STORAGE_QUOTA: '本机草稿存储空间不足，原有数据已保留。',
  DRAFT_STORAGE_ERROR: '无法读取或保存本机草稿，原有数据未被清除。',
  DRAFT_STORAGE_CLOSED: '本机草稿存储已关闭。',
});
function failure(code) { const error = new Error(messages[code]); error.code = code; return error; }
function reject(code) { throw failure(code); }
function record(value, fields, code) {
  let keys, descriptors, prototype;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { reject(code); }
  if ((prototype !== Object.prototype && prototype !== null) || keys.length !== fields.length
    || keys.some(key => !fields.includes(key))
    || fields.some(key => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) reject(code);
  return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
function array(value, maximum, code) {
  let descriptors, keys, length;
  try {
    if (!Array.isArray(value)) reject(code);
    length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  } catch { reject(code); }
  if (!Number.isSafeInteger(length) || length < 0) reject(code);
  if (length > maximum) reject('DRAFT_LIMIT');
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { reject(code); }
  if (keys.length !== length + 1) reject(code);
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject(code);
    result.push(descriptor.value);
  }
  return result;
}
function validText(value) {
  return typeof value === 'string' && !value.includes('\0') && value.isWellFormed();
}
function relativePath(value) {
  if (!validText(value) || !value || value.length > 512 || /[\\\x00-\x1f\x7f<>:"|?*%]/u.test(value)) reject('INVALID_DRAFT');
  const parts = value.split('/');
  if (parts.length > 16 || parts.some(part => !part || part === '.' || part === '..'
    || /[. ]$/u.test(part) || RESERVED.test(part) || part.length > 128 || part.toLowerCase().startsWith('.openaster-'))) reject('INVALID_DRAFT');
  return value;
}
function revision(value, initial = false) {
  return typeof value === 'string' && ((initial && value === '0') || UUID.test(value));
}
function withinSnapshotBudget(drafts, value = SAMPLE_REVISION) {
  if (encoder.encode(JSON.stringify({ version: 1, revision: value, drafts })).byteLength > DRAFT_LIMITS.snapshotBytes) reject('DRAFT_LIMIT');
}

/** Validate strict data fields and return a detached, canonical-order copy. */
export function validateDraft(value) {
  const clean = record(value, DRAFT_FIELDS, 'INVALID_DRAFT');
  if (typeof clean.slot !== 'string' || !ID.test(clean.slot) || !validText(clean.text)) reject('INVALID_DRAFT');
  if (clean.text.length > DRAFT_LIMITS.textCharacters) reject('DRAFT_LIMIT');
  if (typeof clean.providerId !== 'string' || (clean.providerId !== '' && !ID.test(clean.providerId))
    || typeof clean.skillId !== 'string' || (clean.skillId !== '' && !ID.test(clean.skillId))
    || !revision(clean.revision) || typeof clean.uncertain !== 'boolean'
    || typeof clean.updatedAt !== 'string' || !ISO.test(clean.updatedAt)) reject('INVALID_DRAFT');
  const timestamp = Date.parse(clean.updatedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== clean.updatedAt) reject('INVALID_DRAFT');
  let total = 0; const paths = new Set();
  clean.files = array(clean.files, DRAFT_LIMITS.files, 'INVALID_DRAFT').map(item => {
    const file = record(item, ['path', 'sha256', 'bytes'], 'INVALID_DRAFT');
    relativePath(file.path);
    if (typeof file.sha256 !== 'string' || !HASH.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0) reject('INVALID_DRAFT');
    const key = file.path.normalize('NFC').toLowerCase();
    if (paths.has(key)) reject('INVALID_DRAFT');
    paths.add(key); total += file.bytes;
    if (total > DRAFT_LIMITS.fileBytes) reject('DRAFT_LIMIT');
    return { path: file.path, sha256: file.sha256, bytes: file.bytes === 0 ? 0 : file.bytes };
  });
  return clean;
}

/** Validate the entire list; limits never truncate or evict another draft. */
export function validateDraftList(value) {
  const slots = new Set();
  const drafts = array(value, DRAFT_LIMITS.drafts, 'INVALID_DRAFT_SNAPSHOT').map(item => {
    const draft = validateDraft(item);
    if (slots.has(draft.slot)) reject('INVALID_DRAFT_SNAPSHOT');
    slots.add(draft.slot); return draft;
  });
  withinSnapshotBudget(drafts);
  return drafts;
}

export function validateDraftSnapshot(value) {
  const clean = record(value, ['version', 'revision', 'drafts'], 'INVALID_DRAFT_SNAPSHOT');
  if (clean.version !== 1 || !revision(clean.revision, true)) reject('INVALID_DRAFT_SNAPSHOT');
  clean.drafts = validateDraftList(clean.drafts);
  if (clean.revision === '0' && clean.drafts.length) reject('INVALID_DRAFT_SNAPSHOT');
  withinSnapshotBudget(clean.drafts, clean.revision);
  return clean;
}

export function draftScopeKey(value) {
  const { origin, storageId } = record(value, ['origin', 'storageId'], 'INVALID_DRAFT_SCOPE');
  if (typeof origin !== 'string' || origin.length > 2048 || !revision(storageId)) reject('INVALID_DRAFT_SCOPE');
  let url; try { url = new URL(origin); } catch { reject('INVALID_DRAFT_SCOPE'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) reject('INVALID_DRAFT_SCOPE');
  return JSON.stringify([origin, storageId]);
}
function scopeKey(value) {
  if (typeof value !== 'string' || value.length > 2200) reject('INVALID_DRAFT_SCOPE');
  let parts; try { parts = JSON.parse(value); } catch { reject('INVALID_DRAFT_SCOPE'); }
  if (!Array.isArray(parts) || parts.length !== 2 || draftScopeKey({ origin: parts[0], storageId: parts[1] }) !== value) reject('INVALID_DRAFT_SCOPE');
  return value;
}
function storageFailure(error) {
  let name; try { name = error?.name; } catch {}
  if (name === 'QuotaExceededError') return failure('DRAFT_STORAGE_QUOTA');
  if (name === 'SecurityError' || name === 'NotSupportedError') return failure('DRAFT_STORAGE_UNAVAILABLE');
  if (name === 'VersionError') return failure('DRAFT_STORAGE_CORRUPT');
  return failure('DRAFT_STORAGE_ERROR');
}

/** A scope is one atomic bundle. Every CAS, including an empty list, advances its revision. */
export function createBrowserDraftRepository({ indexedDB = globalThis.indexedDB, name = 'openaster-device-drafts-v1' } = {}) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(name)) reject('DRAFT_STORAGE_UNAVAILABLE');
  let database = null, opening = null, closed = false, invalidated = false;
  function available() {
    if (closed) reject('DRAFT_STORAGE_CLOSED');
    if (invalidated || !indexedDB || typeof indexedDB.open !== 'function') reject('DRAFT_STORAGE_UNAVAILABLE');
  }
  function open() {
    available();
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    const attempt = new Promise((resolve, fail) => {
      let request, settled = false, upgradeFailure;
      const stop = error => { if (!settled) { settled = true; fail(error); } };
      try { request = indexedDB.open(name, 1); } catch (error) { stop(storageFailure(error)); return; }
      request.onblocked = () => stop(failure('DRAFT_STORAGE_UNAVAILABLE'));
      request.onupgradeneeded = event => {
        if (settled || closed || event.oldVersion !== 0) {
          upgradeFailure = failure(closed ? 'DRAFT_STORAGE_CLOSED' : 'DRAFT_STORAGE_CORRUPT');
          request.transaction.abort(); return;
        }
        try { request.result.createObjectStore('scopes'); }
        catch (error) { upgradeFailure = storageFailure(error); request.transaction.abort(); }
      };
      request.onerror = () => stop(upgradeFailure || storageFailure(request.error));
      request.onsuccess = () => {
        const db = request.result;
        if (settled || closed) { db.close(); stop(failure('DRAFT_STORAGE_CLOSED')); return; }
        if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains('scopes')) {
          db.close(); stop(failure('DRAFT_STORAGE_CORRUPT')); return;
        }
        db.onversionchange = () => { invalidated = true; db.close(); if (database === db) database = null; };
        database = db; settled = true; resolve(db);
      };
    });
    opening = attempt;
    void attempt.then(() => { if (opening === attempt) opening = null; }, () => { if (opening === attempt) opening = null; });
    return attempt;
  }
  async function transact(scope, expectedRevision, drafts) {
    scopeKey(scope);
    const writing = expectedRevision !== undefined;
    if (writing && !revision(expectedRevision, true)) reject('INVALID_DRAFT_REVISION');
    const clean = writing ? validateDraftList(drafts) : null;
    const db = await open(); available();
    return new Promise((resolve, fail) => {
      let transaction, result, error, settled = false;
      const finish = (problem, value) => { if (settled) return; settled = true; if (problem) fail(problem); else resolve(value); };
      try { transaction = db.transaction('scopes', writing ? 'readwrite' : 'readonly'); }
      catch (problem) { finish(storageFailure(problem)); return; }
      transaction.oncomplete = () => finish(error || (!result ? failure('DRAFT_STORAGE_ERROR') : null), result);
      transaction.onabort = () => finish(error || storageFailure(transaction.error));
      transaction.onerror = () => { error ||= storageFailure(transaction.error); };
      const abort = problem => { error = problem; try { transaction.abort(); } catch { finish(error); } };
      const requestError = request => { request.onerror = () => { error ||= storageFailure(request.error); }; return request; };
      const store = transaction.objectStore('scopes');
      // Unknown key paths or generators indicate an incompatible existing schema.
      if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) { abort(failure('DRAFT_STORAGE_CORRUPT')); return; }
      function accept(value, exists) {
        let current;
        try { current = exists ? validateDraftSnapshot(value) : EMPTY(); }
        catch { abort(failure('DRAFT_STORAGE_CORRUPT')); return; }
        if (!writing) { result = current; return; }
        if (current.revision !== expectedRevision) { abort(failure('DRAFT_CONFLICT')); return; }
        let next;
        try { next = globalThis.crypto.randomUUID(); } catch { abort(failure('DRAFT_STORAGE_UNAVAILABLE')); return; }
        if (!revision(next) || next === current.revision) { abort(failure('DRAFT_STORAGE_ERROR')); return; }
        result = { version: 1, revision: next, drafts: clean };
        try { requestError(store.put(result, scope)); } catch (problem) { abort(storageFailure(problem)); }
      }
      try {
        const get = requestError(store.get(scope));
        get.onsuccess = () => {
          if (get.result !== undefined) { accept(get.result, true); return; }
          // A present `undefined` value is corruption, not an empty initial scope.
          try { const key = requestError(store.getKey(scope)); key.onsuccess = () => accept(undefined, key.result !== undefined); }
          catch (problem) { abort(storageFailure(problem)); }
        };
      } catch (problem) { abort(storageFailure(problem)); }
    });
  }
  return Object.freeze({
    read: scope => transact(scope),
    compareAndSwap: (scope, expectedRevision, drafts) => {
      if (!revision(expectedRevision, true)) return Promise.reject(failure('INVALID_DRAFT_REVISION'));
      return transact(scope, expectedRevision, drafts);
    },
    // Already-started transactions finish normally; no partial writes are cancelled.
    close() { closed = true; database?.close(); database = null; },
  });
}
