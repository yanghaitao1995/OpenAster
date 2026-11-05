// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { CoreError } from './errors.mjs';
import { validateRelativePath } from './workspace.mjs';

export const MODEL_REQUEST_BYTE_LIMIT = 2 * 1024 * 1024;
export const TOOL_ARTIFACT_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  runBytes: 16 * 1024 * 1024,
  storeBytes: 128 * 1024 * 1024,
  maxPerRun: 32,
  pageBytes: 8192,
  maxPageBytes: 16384,
});
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ARTIFACT_FIELDS = ['id', 'sessionId', 'runId', 'stepId', 'callId', 'name', 'path', 'isError', 'createdAt', 'bytes', 'sha256', 'content'];
const REF_FIELDS = ['artifactId', 'name', 'path', 'isError', 'bytes', 'sha256'];
const PLAN_FIELDS = ['version', 'policy', 'requestBytes', 'requestByteLimit', 'requestSha256', 'preservedMessages', 'toolResults'];
const invalid = () => new CoreError('INVALID_TOOL_ARTIFACT', '工具结果记录的数据格式或关联信息无效。');
const invalidPlan = () => new CoreError('INVALID_CONTEXT_PLAN', '模型请求上下文记录的数据格式无效。');
const invalidRange = () => new CoreError('INVALID_ARTIFACT_RANGE', '工具结果分页范围无效，请从已返回的分页位置继续读取。');
const requireValue = (condition, failure = invalid) => { if (!condition) throw failure(); };
const text = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const digest = content => createHash('sha256').update(content, 'utf8').digest('hex');

// Imported records may be constructed by adapters, not only JSON.parse. Do not
// invoke accessors, inherited fields, or sparse array entries during validation.
function fields(value, names, failure = invalid) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), failure);
  let keys, descriptors;
  try { keys = Reflect.ownKeys(value); descriptors = Object.getOwnPropertyDescriptors(value); }
  catch { throw failure(); }
  requireValue(keys.length === names.length && keys.every(key => names.includes(key))
    && names.every(key => descriptors[key] && Object.hasOwn(descriptors[key], 'value')), failure);
  return Object.fromEntries(names.map(key => [key, descriptors[key].value]));
}
function array(value, max, failure) {
  let keys, length;
  try {
    requireValue(Array.isArray(value), failure);
    length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    keys = Reflect.ownKeys(value);
  } catch { throw failure(); }
  requireValue(integer(length, 0, max) && keys.length === length + 1, failure);
  const result = [];
  for (let index = 0; index < length; index++) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, index); } catch { throw failure(); }
    requireValue(descriptor && Object.hasOwn(descriptor, 'value'), failure);
    result.push(descriptor.value);
  }
  return result;
}
function metadata(value) {
  requireValue(typeof value.name === 'string' && NAME.test(value.name));
  requireValue(value.path === null || typeof value.path === 'string');
  if (value.path !== null) { try { validateRelativePath(value.path); } catch { throw invalid(); } }
  requireValue(typeof value.isError === 'boolean');
  requireValue(integer(value.bytes, 1, TOOL_ARTIFACT_LIMITS.maxBytes));
  requireValue(typeof value.sha256 === 'string' && HASH.test(value.sha256));
}

export function validateToolResultRef(value) {
  const clean = fields(value, REF_FIELDS);
  requireValue(typeof clean.artifactId === 'string' && ID.test(clean.artifactId));
  metadata(clean);
  return clean;
}

/** Exact, immutable tool message content. It is data, never executable consent. */
export function validateToolArtifact(value) {
  const clean = fields(value, ARTIFACT_FIELDS);
  for (const key of ['id', 'sessionId', 'runId', 'stepId']) requireValue(typeof clean[key] === 'string' && ID.test(clean[key]));
  requireValue(clean.id === clean.stepId);
  requireValue(text(clean.callId) && clean.callId.length > 0 && clean.callId.length <= 200);
  requireValue(typeof clean.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(clean.createdAt)
    && Number.isFinite(Date.parse(clean.createdAt)) && new Date(clean.createdAt).toISOString() === clean.createdAt);
  metadata(clean);
  requireValue(text(clean.content) && clean.content.length <= TOOL_ARTIFACT_LIMITS.maxBytes);
  requireValue(Buffer.byteLength(clean.content, 'utf8') === clean.bytes && digest(clean.content) === clean.sha256);
  let decoded;
  try { decoded = JSON.parse(clean.content); } catch { throw invalid(); }
  requireValue(decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
    && decoded.untrusted_data === true && Object.keys(decoded).length === 2
    && Object.hasOwn(decoded, clean.isError ? 'error' : 'result'));
  return clean;
}

export function validateContextPlan(value) {
  const clean = fields(value, PLAN_FIELDS, invalidPlan);
  requireValue(clean.version === 1 && clean.policy === 'preserve-messages-reference-tools', invalidPlan);
  requireValue(integer(clean.requestByteLimit, 1, MODEL_REQUEST_BYTE_LIMIT)
    && integer(clean.requestBytes, 1, clean.requestByteLimit), invalidPlan);
  requireValue(typeof clean.requestSha256 === 'string' && HASH.test(clean.requestSha256), invalidPlan);
  requireValue(integer(clean.preservedMessages, 1, 1024), invalidPlan);
  const seen = new Set();
  clean.toolResults = array(clean.toolResults, TOOL_ARTIFACT_LIMITS.maxPerRun, invalidPlan).map(value => {
    const item = fields(value, ['artifactId', 'mode', 'sourceBytes', 'sentBytes', 'ranges'], invalidPlan);
    requireValue(typeof item.artifactId === 'string' && ID.test(item.artifactId) && !seen.has(item.artifactId), invalidPlan);
    seen.add(item.artifactId);
    requireValue(['full', 'excerpt', 'reference'].includes(item.mode), invalidPlan);
    requireValue(integer(item.sourceBytes, 1, TOOL_ARTIFACT_LIMITS.maxBytes)
      && integer(item.sentBytes, 1, MODEL_REQUEST_BYTE_LIMIT), invalidPlan);
    let previous = 0, included = 0;
    item.ranges = array(item.ranges, 4, invalidPlan).map(value => {
      const range = fields(value, ['start', 'end'], invalidPlan);
      requireValue(integer(range.start, previous, item.sourceBytes - 1)
        && integer(range.end, range.start + 1, item.sourceBytes), invalidPlan);
      previous = range.end; included += range.end - range.start;
      return range;
    });
    if (item.mode === 'full') requireValue(item.ranges.length === 1 && item.ranges[0].start === 0
      && item.ranges[0].end === item.sourceBytes && item.sentBytes === item.sourceBytes, invalidPlan);
    else if (item.mode === 'reference') requireValue(item.ranges.length === 0, invalidPlan);
    else requireValue(item.ranges.length > 0 && included < item.sourceBytes, invalidPlan);
    return item;
  });
  return clean;
}

export function isUtf8Boundary(bytes, offset) {
  return integer(offset, 0, bytes.length) && (offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80);
}

/** Pages preserve original BOM/newline bytes and never round an invalid start. */
export function paginateToolArtifact(value, { offset = 0, maxBytes = TOOL_ARTIFACT_LIMITS.pageBytes } = {}) {
  const artifact = validateToolArtifact(value);
  requireValue(integer(offset, 0, artifact.bytes) && integer(maxBytes, 4, TOOL_ARTIFACT_LIMITS.maxPageBytes), invalidRange);
  const bytes = Buffer.from(artifact.content, 'utf8');
  requireValue(isUtf8Boundary(bytes, offset), invalidRange);
  let endOffset = Math.min(artifact.bytes, offset + maxBytes);
  while (!isUtf8Boundary(bytes, endOffset)) endOffset--;
  return {
    offset, endOffset, nextOffset: endOffset === artifact.bytes ? null : endOffset,
    complete: offset === 0 && endOffset === artifact.bytes,
    content: bytes.subarray(offset, endOffset).toString('utf8'),
  };
}
