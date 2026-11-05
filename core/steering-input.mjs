// SPDX-License-Identifier: Apache-2.0
import { CoreError } from './errors.mjs';
import { prepareImages, validateImages } from './image-attachments.mjs';
import { validateContextSelections, validateContextFiles } from './context-files.mjs';
import { isDeepStrictEqual } from 'node:util';

export const STEERING_LIMITS = Object.freeze({ pending: 16, perSession: 64, records: 1000, recordBytes: 2 * 1024 * 1024, sessionBytes: 16 * 1024 * 1024, bytes: 64 * 1024 * 1024 });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(value);
const invalid = () => new CoreError('INVALID_STEERING_INPUT', '追加消息的内容、执行标识或附件格式无效。');
function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value')) || required.some(key => !Object.hasOwn(value, key))) throw invalid();
}
function base(value, images) {
  if (!uuid(value.requestId) || !uuid(value.expectedRunId) || !['queue', 'interrupt'].includes(value.mode)
    || typeof value.content !== 'string' || !value.content.isWellFormed() || value.content.includes('\0') || value.content.length > 16000
    || !value.content.trim() && !images.length) throw invalid();
}
export function validateSteeringPayload(value) {
  fields(value, ['mode', 'requestId', 'expectedRunId', 'content', 'files', 'images'], ['mode', 'requestId', 'expectedRunId', 'content']);
  const images = value.images === undefined ? [] : prepareImages(value.images), files = validateContextSelections(value.files);
  base(value, images);
  return { mode: value.mode, requestId: value.requestId, expectedRunId: value.expectedRunId, content: value.content, files, images };
}
export function validateSteeringRecord(value) {
  fields(value, ['version', 'sessionId', 'requestId', 'expectedRunId', 'mode', 'content', 'files', 'contextFiles', 'images', 'providerId', 'skillId', 'createdAt', 'sequence', 'status', 'runId', 'error']);
  if (!Array.isArray(value.images) || !Array.isArray(value.files)) throw invalid();
  const images = value.images.length ? validateImages(value.images) : [], files = validateContextSelections(value.files);
  const snapshots = Array.isArray(value.contextFiles) && value.contextFiles.length === 0 ? [] : validateContextFiles(value.contextFiles);
  base(value, images);
  if (value.version !== 1 || !id(value.sessionId) || !id(value.providerId) || !(value.skillId === null || typeof value.skillId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.skillId))
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !['pending', 'consumed', 'failed'].includes(value.status)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
    || !isDeepStrictEqual(files, snapshots.map(({ path, sha256 }) => ({ path, sha256 })))) throw invalid();
  if (value.status === 'consumed' ? !uuid(value.runId) || value.error !== null : value.runId !== null) throw invalid();
  if (value.status === 'failed') {
    fields(value.error, ['code', 'message']);
    if (typeof value.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/u.test(value.error.code) || typeof value.error.message !== 'string'
      || !value.error.message.isWellFormed() || !value.error.message || value.error.message.length > 2000 || value.error.message.includes('\0')) throw invalid();
  } else if (value.error !== null) throw invalid();
  const result = { ...value, files, contextFiles: snapshots, images };
  if (Buffer.byteLength(JSON.stringify(result)) > STEERING_LIMITS.recordBytes) throw new CoreError('STEERING_LIMIT', '追加消息和附件超过存储上限。', 413);
  return structuredClone(result);
}
export function steeringRequestIdentity(value) {
  return { mode: value.mode, requestId: value.requestId, expectedRunId: value.expectedRunId, content: value.content, files: value.files, images: value.images };
}
