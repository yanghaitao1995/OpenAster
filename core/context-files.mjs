// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { CoreError, checkAbort } from './errors.mjs';
import { validateRelativePath } from './workspace.mjs';

export const CONTEXT_FILES_LIMITS = Object.freeze({ files: 5, totalBytes: 256 * 1024 });
const HASH = /^[a-f0-9]{64}$/u;
const invalid = () => new CoreError('INVALID_CONTEXT_FILES', '所选文件必须具有有效的相对路径、SHA-256 和文本快照。');
const limit = () => new CoreError('CONTEXT_FILES_LIMIT', '每次最多选择 5 个文本文件，内容合计不能超过 256 KiB。', 413);
const changed = () => new CoreError('CONTEXT_FILE_CHANGED', '所选文件在预览后已发生改变或已不存在，请重新预览并选择。', 409);
const digest = content => createHash('sha256').update(content, 'utf8').digest('hex');

function items(value, { empty }) {
  if (!Array.isArray(value) || (!empty && value.length === 0)) throw invalid();
  if (value.length > CONTEXT_FILES_LIMITS.files) throw limit();
  const result = [];
  for (let index = 0; index < value.length; index++) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, index); } catch { throw invalid(); }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
    result.push(descriptor.value);
  }
  return result;
}
function entry(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  let keys, descriptors;
  try { keys = Reflect.ownKeys(value); descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { throw invalid(); }
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))
    || fields.some(key => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value'))) throw invalid();
  return Object.fromEntries(fields.map(key => [key, descriptors[key].value]));
}
function identity(value, seen) {
  try { validateRelativePath(value.path); } catch { throw invalid(); }
  if (typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) throw invalid();
  // Conservative across supported platforms; preserve the original path for I/O.
  const key = value.path.normalize('NFC').toLowerCase();
  if (seen.has(key)) throw invalid();
  seen.add(key);
}
function textBytes(content) {
  if (typeof content !== 'string') throw invalid();
  if (content.length > CONTEXT_FILES_LIMITS.totalBytes) throw limit();
  if (!content.isWellFormed() || content.includes('\0')) throw invalid();
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > CONTEXT_FILES_LIMITS.totalBytes) throw limit();
  return bytes;
}

/** Only selection identities may arrive from a client, never client-supplied text. */
export function validateContextSelections(value) {
  if (value === undefined) return [];
  const seen = new Set();
  return items(value, { empty: true }).map(item => {
    const clean = entry(item, ['path', 'sha256']); identity(clean, seen); return clean;
  });
}

/** Canonical stored snapshots; omission is represented by no message field. */
export function validateContextFiles(value) {
  const seen = new Set(); let total = 0;
  return items(value, { empty: false }).map(item => {
    const clean = entry(item, ['path', 'sha256', 'content']); identity(clean, seen);
    total += textBytes(clean.content);
    if (total > CONTEXT_FILES_LIMITS.totalBytes) throw limit();
    if (digest(clean.content) !== clean.sha256) throw invalid();
    return clean;
  });
}

/** Read pinned workspace snapshots before changing a session or starting a model. */
export async function readContextFiles(workspace, selections, { signal } = {}) {
  const selected = validateContextSelections(selections);
  checkAbort(signal);
  if (!selected.length) return [];
  if (!workspace || typeof workspace.read !== 'function') throw invalid();
  const result = []; let total = 0;
  for (const selection of selected) {
    checkAbort(signal);
    let snapshot;
    try { snapshot = await workspace.read(selection.path, { signal }); }
    catch (error) {
      checkAbort(signal);
      if (error.code === 'FILE_TOO_LARGE') throw limit();
      if (['ENOENT', 'FILE_NOT_FOUND'].includes(error.code)) throw changed();
      throw error;
    }
    checkAbort(signal);
    if (!snapshot || snapshot.path !== selection.path || typeof snapshot.sha256 !== 'string' || !HASH.test(snapshot.sha256)) throw invalid();
    total += textBytes(snapshot.content);
    if (total > CONTEXT_FILES_LIMITS.totalBytes) throw limit();
    if (snapshot.sha256 !== selection.sha256 || digest(snapshot.content) !== selection.sha256) throw changed();
    result.push({ path: selection.path, sha256: selection.sha256, content: snapshot.content });
  }
  checkAbort(signal);
  return result;
}
