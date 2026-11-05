// SPDX-License-Identifier: Apache-2.0
import { CoreError, checkAbort } from './errors.mjs';
import { measureProviderRequest } from './providers.mjs';
import { paginateToolArtifact, TOOL_ARTIFACT_LIMITS, MODEL_REQUEST_BYTE_LIMIT } from './tool-artifacts.mjs';

const exhausted = limit => new CoreError('CONTEXT_TOO_LARGE', `保留全部对话、文件快照和模型调用记录后，请求仍超过本地 ${limit === MODEL_REQUEST_BYTE_LIMIT ? '2 MiB' : `${limit} 字节`} 传输预算。未静默删减内容，请明确拆分任务；这不是模型令牌窗口的测量。`, 413);
const unavailable = () => new CoreError('TOOL_ARTIFACT_UNAVAILABLE', '工具结果原文不可用，任务已停止。', 503);

/** A page is deterministic: validate and construct the same result before any group side effect. */
export function prepareToolResultPage(artifacts, value) {
  const invalid = () => new CoreError('INVALID_TOOL_ARGUMENTS', '工具参数不符合定义。');
  let args;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['artifactId', 'offset', 'maxBytes'].includes(key))) throw invalid();
    args = {};
    for (const key of ['artifactId', 'offset', 'maxBytes']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) { if (key !== 'maxBytes') throw invalid(); continue; }
      if (!Object.hasOwn(descriptor, 'value')) throw invalid();
      args[key] = descriptor.value;
    }
    if (typeof args.artifactId !== 'string' || !Number.isSafeInteger(args.offset) || args.offset < 0
      || (Object.hasOwn(args, 'maxBytes') && (!Number.isSafeInteger(args.maxBytes)
        || args.maxBytes < 4 || args.maxBytes > TOOL_ARTIFACT_LIMITS.maxPageBytes))) throw invalid();
  } catch { throw invalid(); }
  const artifact = artifacts.get(args.artifactId);
  if (!artifact) throw new CoreError('TOOL_ARTIFACT_NOT_FOUND', '当前任务中没有该工具结果。', 404);
  return { artifact, result: { artifactId: artifact.id, sha256: artifact.sha256, sourceBytes: artifact.bytes,
    format: 'application/json; charset=utf-8', ...paginateToolArtifact(artifact, args) } };
}

function reference(artifact, mode, page) {
  return JSON.stringify({ untrusted_data: true, tool_result_view: {
    artifactId: artifact.id, name: artifact.name, path: artifact.path, isError: artifact.isError,
    sourceBytes: artifact.bytes, sha256: artifact.sha256, sha256Kind: 'archived-tool-result-json', mode,
    format: 'application/json; charset=utf-8', complete: false,
    ...(page ? { content: page.content, offset: page.offset, endOffset: page.endOffset } : {}),
    readMore: { tool: 'read_tool_result', arguments: { artifactId: artifact.id, offset: page?.nextOffset ?? 0 } }
  } });
}

function view(message, artifacts, requestedMode = 'full') {
  const artifact = artifacts.get(message.artifactId);
  if (!artifact || artifact.callId !== message.callId || artifact.name !== message.name) throw unavailable();
  let mode = 'full', content = artifact.content, ranges = [{ start: 0, end: artifact.bytes }];
  // A requested page must not recursively become a page of its own wrapper.
  if (requestedMode === 'reference') { mode = 'reference'; content = reference(artifact, mode); ranges = []; }
  else if (requestedMode === 'excerpt' && artifact.bytes > TOOL_ARTIFACT_LIMITS.pageBytes && artifact.name !== 'read_tool_result') {
    const page = paginateToolArtifact(artifact, { offset: 0, maxBytes: TOOL_ARTIFACT_LIMITS.pageBytes });
    mode = 'excerpt'; content = reference(artifact, mode, page); ranges = [{ start: page.offset, end: page.endOffset }];
  }
  return { message: { ...message, content }, entry: { artifactId: artifact.id, mode, sourceBytes: artifact.bytes,
    sentBytes: Buffer.byteLength(content), ranges } };
}

/** Only tool.content may change. Original messages, tool IDs and provider wire remain intact. */
function measure(provider, options, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MODEL_REQUEST_BYTE_LIMIT) throw new TypeError('Invalid request byte limit');
  return { ...measureProviderRequest(provider, options), requestByteLimit: limit };
}

export function planContext(provider, { messages, artifacts = new Map(), signal, maxRequestBytes = MODEL_REQUEST_BYTE_LIMIT, ...options }) {
  checkAbort(signal);
  const views = messages.map(message => message.role === 'tool' ? view(message, artifacts) : { message });
  let prepared = views.map(item => item.message);
  let measurement = measure(provider, { ...options, messages: prepared }, maxRequestBytes);
  // Ordinary reads keep their full text whenever the actual serialized request
  // fits. Excerpt oldest large observations only when pressure is measured.
  for (let index = 0; index < views.length && measurement.requestBytes > measurement.requestByteLimit; index++) {
    checkAbort(signal);
    if (!views[index].entry || messages[index].name === 'read_tool_result'
      || views[index].entry.sourceBytes <= TOOL_ARTIFACT_LIMITS.pageBytes) continue;
    const smaller = view(messages[index], artifacts, 'excerpt');
    if (smaller.entry.sentBytes >= views[index].entry.sentBytes) continue;
    views[index] = smaller; prepared[index] = smaller.message;
    measurement = measure(provider, { ...options, messages: prepared }, maxRequestBytes);
  }
  // Prefer replacing large old observations; small operation receipts/errors stay full when possible.
  const latestAssistant = messages.findLastIndex(message => message.role === 'assistant');
  const eligible = views.map((item, index) => ({ item, index })).filter(({ item, index }) => item.entry
    && !(index > latestAssistant && messages[index].name === 'read_tool_result'))
    .sort((a, b) => Number(a.item.entry.sentBytes <= 1024) - Number(b.item.entry.sentBytes <= 1024) || a.index - b.index);
  for (const { index } of eligible) {
    if (measurement.requestBytes <= measurement.requestByteLimit) break;
    checkAbort(signal);
    const smaller = view(messages[index], artifacts, 'reference');
    if (smaller.entry.sentBytes >= views[index].entry.sentBytes) continue;
    views[index] = smaller; prepared[index] = smaller.message;
    measurement = measure(provider, { ...options, messages: prepared }, maxRequestBytes);
  }
  checkAbort(signal);
  if (measurement.requestBytes > measurement.requestByteLimit) throw exhausted(maxRequestBytes);
  return { messages: prepared, contextPlan: { version: 1, policy: 'preserve-messages-reference-tools', ...measurement,
    preservedMessages: messages.filter(message => message.role !== 'tool').length,
    toolResults: views.flatMap(item => item.entry ? [item.entry] : []) } };
}

/** Refuse an unrepresentable assistant/tool group before any requested side effect. */
export function assertToolGroupFits(provider, { messages, assistant, artifacts = new Map(), signal, maxRequestBytes = MODEL_REQUEST_BYTE_LIMIT, ...options }) {
  checkAbort(signal);
  const prepared = messages.map(message => message.role === 'tool' ? view(message, artifacts, 'reference').message : message);
  const placeholders = assistant.toolCalls.map(call => {
    if (call.name === 'read_tool_result') {
      const { result } = prepareToolResultPage(artifacts, call.args);
      // Unlike old observations, every requested page in this group must remain
      // whole in the next request. Its real envelope cannot be a small reference.
      return { role: 'tool', callId: call.id, name: call.name,
        content: JSON.stringify({ untrusted_data: true, result }) };
    }
    let path = null;
    try { const descriptor = Object.getOwnPropertyDescriptor(call.args, 'path'); if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string') path = descriptor.value; }
    catch { /* Argument validation will report malformed objects without executing getters. */ }
    return { role: 'tool', callId: call.id, name: call.name,
      content: reference({ id: '0'.repeat(100), name: call.name, path,
        isError: false, bytes: TOOL_ARTIFACT_LIMITS.maxBytes, sha256: '0'.repeat(64) }, 'reference') };
  });
  const measurement = measure(provider, { ...options, messages: [...prepared, assistant, ...placeholders] }, maxRequestBytes);
  checkAbort(signal);
  if (measurement.requestBytes > measurement.requestByteLimit) throw exhausted(maxRequestBytes);
}
