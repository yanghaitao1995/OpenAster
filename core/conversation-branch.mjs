// SPDX-License-Identifier: Apache-2.0
import { validateImages } from './image-attachments.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { CoreError } from './errors.mjs';
import { validateContextFiles } from './context-files.mjs';
import { validateContextHandoff } from './conversation-handoff.mjs';
import { MAX_MODEL_OUTPUT_BYTES } from './model-limits.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const fail = (code = 'INVALID_BRANCH_REQUEST', message = '分支请求格式无效。', status = 400) => new CoreError(code, message, status);
const validId = value => typeof value === 'string' && ID.test(value);
const text = (value, limit, nonempty = false) => typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && value.length <= limit && (!nonempty || value.trim().length > 0);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
  const entries = Object.getOwnPropertyDescriptors(value), result = {};
  if (Reflect.ownKeys(entries).some(key => typeof key !== 'string' || !allowed.includes(key)) || required.some(key => !Object.hasOwn(entries, key))) throw fail();
  for (const [key, descriptor] of Object.entries(entries)) { if (!Object.hasOwn(descriptor, 'value')) throw fail(); result[key] = descriptor.value; }
  return result;
}

export function validateBranchMetadata(value) {
  const result = object(value, ['version', 'sourceSessionId', 'sourceMessageId', 'sourceTitle', 'sourcePrefixHash', 'mode', 'retainedMessages', 'createdAt']);
  if (result.version !== 1 || !validId(result.sourceSessionId) || !validId(result.sourceMessageId)
    || !text(result.sourceTitle, 160, true) || typeof result.sourcePrefixHash !== 'string' || !HASH.test(result.sourcePrefixHash)
    || !['prefix', 'message'].includes(result.mode) || !Number.isSafeInteger(result.retainedMessages) || result.retainedMessages < 0 || result.retainedMessages > 200
    || (result.mode === 'message' && result.retainedMessages !== 0) || !timestamp(result.createdAt)) throw fail();
  return result;
}

export function validateBranchRequest(value) {
  const result = object(value, ['messageId', 'expectedPrefixHash', 'mode', 'content', 'providerId', 'skillId'], ['messageId', 'expectedPrefixHash', 'mode', 'content', 'providerId']);
  if (!validId(result.messageId) || typeof result.expectedPrefixHash !== 'string' || !HASH.test(result.expectedPrefixHash)
    || !['prefix', 'message'].includes(result.mode) || !text(result.content, 16000) || !validId(result.providerId)
    || (Object.hasOwn(result, 'skillId') && !validId(result.skillId))) throw fail();
  return result;
}

function sourcePrefix(session, messageId) {
  if (!validId(messageId)) throw fail();
  if (!session || !validId(session.id) || !text(session.title, 160, true) || !Array.isArray(session.messages) || session.messages.length > 201) throw fail('INVALID_BRANCH_SOURCE', '原任务消息无法安全复制。', 409);
  const positions = [];
  for (let i = 0; i < session.messages.length; i++) if (session.messages[i]?.id === messageId) positions.push(i);
  if (positions.length === 0 || session.messages[positions[0]]?.role !== 'user') throw fail('BRANCH_MESSAGE_NOT_FOUND', '原任务中没有这条可分支的用户消息。', 404);
  if (positions.length !== 1) throw fail('INVALID_BRANCH_SOURCE', '原任务消息标识不唯一。', 409);
  const prefix = [], ids = new Set();
  try {
    for (let i = 0; i <= positions[0]; i++) {
      const message = object(session.messages[i], ['id', 'role', 'content', 'createdAt', 'contextFiles', 'contextHandoff', 'images'], ['id', 'role', 'content', 'createdAt']);
      const contentLimit = message.role === 'assistant' ? MAX_MODEL_OUTPUT_BYTES : 256 * 1024;
      if (!validId(message.id) || ids.has(message.id) || !['user', 'assistant'].includes(message.role)
        || !text(message.content, contentLimit) || Buffer.byteLength(message.content) > contentLimit || !timestamp(message.createdAt)) throw fail();
      ids.add(message.id);
      const copy = { id: message.id, role: message.role, content: message.content, createdAt: message.createdAt };
      if(Object.hasOwn(message,'images')) { if(message.role!=='user')throw fail(); copy.images=validateImages(message.images); }
      if (Object.hasOwn(message, 'contextFiles')) {
        if (message.role !== 'user') throw fail();
        copy.contextFiles = validateContextFiles(message.contextFiles);
      }
      if (Object.hasOwn(message, 'contextHandoff')) {
        if (i !== 0 || message.role !== 'user') throw fail();
        copy.contextHandoff = validateContextHandoff(message.contextHandoff);
        if (copy.contextHandoff.sourceSessionId === session.id) throw fail();
      }
      prefix.push(copy);
    }
  } catch { throw fail('INVALID_BRANCH_SOURCE', '原任务消息或附件无法安全复制。', 409); }
  const prefixHash = createHash('sha256').update(JSON.stringify({ version: 1, sessionId: session.id, messageId, title: session.title, messages: prefix })).digest('hex');
  return { prefix, prefixHash };
}

export function previewConversationBranch(session, messageId) {
  const { prefix, prefixHash } = sourcePrefix(session, messageId), selected = prefix.at(-1);
  return { version: 1, source: { sessionId: session.id, messageId, title: session.title, prefixHash }, content: selected.content,
    images: (selected.images??[]).map(({name,mimeType,bytes,sha256,width,height})=>({name,mimeType,bytes,sha256,width,height})),
    files: (selected.contextFiles ?? []).map(file => ({ path: file.path, bytes: Buffer.byteLength(file.content), sha256: file.sha256 })),
    handoff: prefix[0]?.contextHandoff ? { inPrefix: true, onSelectedMessage: prefix.length === 1 } : null,
    previousMessages: prefix.length - 1, sourceProviderId: validId(session.providerId) ? session.providerId : null };
}

/** Builds an unpersisted session; only the runtime's first successful save may create it. */
export function prepareConversationBranch(session, input, { createId = randomUUID, now = () => new Date().toISOString() } = {}) {
  const request = validateBranchRequest(input), { prefix, prefixHash } = sourcePrefix(session, request.messageId);
  if(!request.content.trim()&&!prefix.at(-1).images?.length)throw fail();
  if (request.expectedPrefixHash !== prefixHash) throw fail('BRANCH_SOURCE_CHANGED', '原任务内容已改变，请重新打开分支预览。', 409);
  const used = new Set([session.id, ...session.messages.map(message => message?.id)]);
  const nextId = () => { const value = createId(); if (!validId(value) || used.has(value)) throw fail('BRANCH_ID_CONFLICT', '无法创建唯一的分支标识。', 409); used.add(value); return value; };
  const id = nextId(), createdAt = now();
  const messages = request.mode === 'prefix' ? prefix.slice(0, -1).map(message => ({ ...structuredClone(message), id: nextId() })) : [];
  const branch = validateBranchMetadata({ version: 1, sourceSessionId: session.id, sourceMessageId: request.messageId, sourceTitle: session.title,
    sourcePrefixHash: prefixHash, mode: request.mode, retainedMessages: messages.length, createdAt });
  return { session: { id, title: Array.from(`${session.title} · 分支`).slice(0, 80).join(''), providerId: request.providerId, createdAt, updatedAt: createdAt, messages, approvals: [], run: null, branch },
    content: request.content, contextFiles: structuredClone(prefix.at(-1).contextFiles ?? []), images: structuredClone(prefix.at(-1).images??[]),
    ...(prefix.at(-1).contextHandoff ? { contextHandoff: structuredClone(prefix.at(-1).contextHandoff) } : {}) };
}
