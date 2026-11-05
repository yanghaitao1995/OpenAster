// SPDX-License-Identifier: Apache-2.0
import { validateImages } from './image-attachments.mjs';
import { createHash } from 'node:crypto';
import { CoreError } from './errors.mjs';
import { validateContextFiles } from './context-files.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SOURCE_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_FIELDS = ['version', 'sourceSessionId', 'sourceLastMessageId', 'sourceTitle', 'sourceHash', 'sourceMessageCount', 'summary', 'summaryHash', 'createdAt', 'continuationId', 'requestHash'];
const fail = (code, message, status = 400) => new CoreError(code, message, status);
const validId = value => typeof value === 'string' && ID.test(value);
const text = (value, limit, nonempty = false) => typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && value.length <= limit && (!nonempty || value.trim().length > 0);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const digest = value => createHash('sha256').update(value).digest('hex');

function object(value, allowed, required, invalid) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const entries = Object.getOwnPropertyDescriptors(value), result = {};
    if (Reflect.ownKeys(entries).some(key => typeof key !== 'string' || !allowed.includes(key)) || required.some(key => !Object.hasOwn(entries, key))) throw invalid();
    for (const key of allowed) {
      const descriptor = entries[key];
      if (!descriptor) continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
      result[key] = descriptor.value;
    }
    return result;
  } catch { throw invalid(); }
}
function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Missing data property');
  return descriptor.value;
}

/** A confirmed manual summary is historical data, never permission or system instructions. */
export function validateContextHandoff(value) {
  const invalid = () => fail('INVALID_CONTEXT_HANDOFF', '交接摘要快照格式无效。');
  const result = object(value, SNAPSHOT_FIELDS, SNAPSHOT_FIELDS, invalid);
  if (result.version !== 1 || !validId(result.sourceSessionId) || !validId(result.sourceLastMessageId)
    || !validId(result.continuationId) || result.continuationId === result.sourceSessionId || result.continuationId === result.sourceLastMessageId
    || !text(result.sourceTitle, 160, true) || typeof result.sourceHash !== 'string' || !HASH.test(result.sourceHash)
    || !Number.isSafeInteger(result.sourceMessageCount) || result.sourceMessageCount < 1 || result.sourceMessageCount > 201
    || !text(result.summary, 24000, true) || Buffer.byteLength(result.summary) > 64 * 1024
    || typeof result.summaryHash !== 'string' || result.summaryHash !== digest(result.summary)
    || typeof result.requestHash !== 'string' || !HASH.test(result.requestHash) || !timestamp(result.createdAt)) throw invalid();
  return result;
}

export function validateHandoffRequest(value) {
  const invalid = () => fail('INVALID_HANDOFF_REQUEST', '续接请求格式无效。');
  const fields = ['requestId', 'expectedSourceHash', 'summary', 'content', 'providerId', 'skillId'];
  const result = object(value, fields, fields.slice(0, -1), invalid);
  if (!validId(result.requestId) || typeof result.expectedSourceHash !== 'string' || !HASH.test(result.expectedSourceHash)
    || !text(result.summary, 24000, true) || Buffer.byteLength(result.summary) > 64 * 1024
    || !text(result.content, 16000, true) || !validId(result.providerId)
    || (Object.hasOwn(result, 'skillId') && !validId(result.skillId))) throw invalid();
  return { ...result, skillId: result.skillId ?? 'general' };
}

/** Property order and an omitted/default skill produce the same idempotency digest. */
export function handoffRequestHash(value) {
  return digest(JSON.stringify(validateHandoffRequest(value)));
}

export function snapshotConversationHandoff(session) {
  const invalid = () => fail('INVALID_HANDOFF_SOURCE', '原任务消息无法安全生成交接来源。', 409);
  const limited = () => fail('HANDOFF_SOURCE_LIMIT', '交接来源最多包含 201 条消息，且消息及文件快照 JSON 不能超过 8 MiB。', 413);
  let id, title, providerId, messages;
  try {
    id = own(session, 'id'); title = own(session, 'title'); messages = own(session, 'messages');
    providerId = Object.getOwnPropertyDescriptor(session, 'providerId')?.value;
    const run = Object.getOwnPropertyDescriptor(session, 'run')?.value;
    const approvals = Object.getOwnPropertyDescriptor(session, 'approvals')?.value;
    if (['running', 'awaiting_approval'].includes(run && Object.getOwnPropertyDescriptor(run, 'status')?.value)
      || (Array.isArray(approvals) && approvals.some(approval => approval && Object.getOwnPropertyDescriptor(approval, 'status')?.value === 'pending'))) {
      throw fail('RUN_ACTIVE', '原任务正在执行或仍有待处理的批准，请停止并处理完毕后再续接。', 409);
    }
    if (!validId(id) || !text(title, 160, true) || !Array.isArray(messages) || !messages.length) throw invalid();
    if (messages.length > 201) throw limited();
    const copied = [], ids = new Set(); let totalBytes = 2;
    for (let index = 0; index < messages.length; index++) {
      const message = object(own(messages, String(index)), ['id', 'role', 'content', 'createdAt', 'contextFiles', 'contextHandoff', 'images'], ['id', 'role', 'content', 'createdAt'], invalid);
      if (!validId(message.id) || ids.has(message.id) || !['user', 'assistant'].includes(message.role)
        || !text(message.content, 256 * 1024) || Buffer.byteLength(message.content) > 256 * 1024 || !timestamp(message.createdAt)) throw invalid();
      ids.add(message.id);
      if(Object.hasOwn(message,'images')) { if(message.role!=='user')throw invalid(); message.images=validateImages(message.images); }
      if (Object.hasOwn(message, 'contextFiles')) {
        if (message.role !== 'user') throw invalid();
        message.contextFiles = validateContextFiles(message.contextFiles);
      }
      if (Object.hasOwn(message, 'contextHandoff')) {
        if (index !== 0 || message.role !== 'user') throw invalid();
        message.contextHandoff = validateContextHandoff(message.contextHandoff);
        if (message.contextHandoff.sourceSessionId === id) throw invalid();
      }
      totalBytes += Buffer.byteLength(JSON.stringify(message)) + (index ? 1 : 0);
      if (totalBytes > SOURCE_BYTES) throw limited();
      copied.push(message);
    }
    messages = copied;
  } catch (error) {
    if (error instanceof CoreError && ['HANDOFF_SOURCE_LIMIT', 'RUN_ACTIVE'].includes(error.code)) throw error;
    throw invalid();
  }
  if (Buffer.byteLength(JSON.stringify(messages)) > SOURCE_BYTES) throw limited();
  const lastMessageId = messages.at(-1).id;
  const hash = digest(JSON.stringify({ version: 1, sessionId: id, title, messages }));
  return { id, title, providerId: validId(providerId) ? providerId : null, messages, lastMessageId, hash };
}

export function previewConversationHandoff(session) {
  const source = snapshotConversationHandoff(session), snapshots = source.messages.flatMap(message => message.contextFiles ?? []);
  return { version: 1, source: { sessionId: source.id, lastMessageId: source.lastMessageId, title: source.title, hash: source.hash, messageCount: source.messages.length },
    files: { count: snapshots.length, bytes: snapshots.reduce((total, file) => total + Buffer.byteLength(file.content), 0) }, sourceProviderId: source.providerId };
}

/** A new task is not written until runtime's exact first-request preflight succeeds. */
export function prepareConversationHandoff(session, value, { now = () => new Date().toISOString() } = {}) {
  const request = validateHandoffRequest(value), source = snapshotConversationHandoff(session);
  if (request.expectedSourceHash !== source.hash) throw fail('HANDOFF_SOURCE_CHANGED', '原任务消息已改变，请重新打开交接预览。', 409);
  if (request.requestId === source.id || source.messages.some(message => message.id === request.requestId)) throw fail('HANDOFF_ID_CONFLICT', '续接标识与原任务或消息冲突。', 409);
  const createdAt = now();
  const contextHandoff = validateContextHandoff({ version: 1, sourceSessionId: source.id, sourceLastMessageId: source.lastMessageId,
    sourceTitle: source.title, sourceHash: source.hash, sourceMessageCount: source.messages.length, summary: request.summary,
    summaryHash: digest(request.summary), createdAt, continuationId: request.requestId, requestHash: handoffRequestHash(request) });
  return { session: { id: request.requestId, title: Array.from(`${source.title} · 续接`).slice(0, 80).join(''), providerId: request.providerId,
    createdAt, updatedAt: createdAt, messages: [], approvals: [], run: null }, content: request.content, contextHandoff };
}
