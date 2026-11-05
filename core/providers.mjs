import { randomUUID, createHash } from 'node:crypto';
import { CoreError, checkAbort } from './errors.mjs';
import { readProviderStreamWithTransport, withAbort } from './provider-stream.mjs';
import { normalizeProviderUsage } from './usage.mjs';
import { validateTerminal } from './provider-terminal.mjs';
import { validateImages } from './image-attachments.mjs';
import { publicReasoning } from './provider-progress.mjs';
import { providerActivityTimeout } from './provider-timeout.mjs';

export const PROVIDER_TYPES = ['demo', 'openai', 'responses', 'anthropic', 'ollama'];
const DEFAULT_URLS = { openai: 'https://api.openai.com/v1', responses: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', ollama: 'http://127.0.0.1:11434' };
const MAX_RESPONSE = 1024 * 1024;
const MAX_REQUEST = 2 * 1024 * 1024;
const MAX_TOOL_CALLS = 8;

export function validateProvider(provider) {
  if (!provider || !PROVIDER_TYPES.includes(provider.type)) throw new CoreError('INVALID_PROVIDER', '不支持的服务商协议。');
  if (provider.name !== undefined && (typeof provider.name !== 'string' || !provider.name.trim() || provider.name.length > 100 || !provider.name.isWellFormed() || provider.name.includes('\0'))) throw new CoreError('INVALID_PROVIDER', '模型连接名称须为有效文本。');
  if (provider.enabled === false) throw new CoreError('PROVIDER_DISABLED', '该服务商已停用。', 409);
  if (provider.streaming !== undefined && typeof provider.streaming !== 'boolean') throw new CoreError('INVALID_PROVIDER', '流式输出设置须为布尔值。');
  if (provider.toolMode !== undefined && !['workspace', 'none'].includes(provider.toolMode)) throw new CoreError('INVALID_PROVIDER', '工具模式须为 workspace 或 none。');
  const toolMode = provider.toolMode ?? 'workspace';
  if (provider.type === 'demo') {
    if (toolMode !== 'workspace') throw new CoreError('INVALID_PROVIDER', '本地演示仅支持工作区工具模式。');
    return { ...provider, type: 'demo', model: 'deterministic-demo', baseUrl: '', streaming: provider.streaming ?? true, toolMode };
  }
  if (typeof provider.model !== 'string' || !provider.model.trim() || provider.model.length > 200 || !provider.model.isWellFormed() || /[\x00-\x1f\x7f]/u.test(provider.model)) throw new CoreError('INVALID_MODEL', '请填写有效模型标识。');
  if (provider.baseUrl != null && (typeof provider.baseUrl !== 'string' || provider.baseUrl.length > 2048 || /[%\\\x00-\x20\x7f]/u.test(provider.baseUrl))) throw new CoreError('INVALID_PROVIDER_URL', '服务商地址不能包含编码路径、空白或控制字符。');
  let url;
  try { url = new URL(provider.baseUrl || DEFAULT_URLS[provider.type]); } catch { throw new CoreError('INVALID_PROVIDER_URL', '服务商地址无效。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || !url.hostname || /%|\\/u.test(url.pathname)) {
    throw new CoreError('INVALID_PROVIDER_URL', '服务商地址必须使用 HTTPS；仅本机回环地址允许 HTTP，且不可包含凭据、查询或片段。');
  }
  if (provider.apiKey != null && (typeof provider.apiKey !== 'string' || provider.apiKey.length > 8192 || /[\x00-\x1f\x7f]/u.test(provider.apiKey))) throw new CoreError('INVALID_API_KEY', '密钥格式无效。');
  if (provider.tokenParameter != null && !['max_completion_tokens', 'max_tokens'].includes(provider.tokenParameter)) throw new CoreError('INVALID_PROVIDER', '输出令牌参数无效。');
  if (provider.maxTokens != null && (!Number.isSafeInteger(provider.maxTokens) || provider.maxTokens < 128 || provider.maxTokens > 16384)) throw new CoreError('INVALID_PROVIDER', '输出令牌上限须为 128 到 16384。');
  return { ...provider, baseUrl: url.href.replace(/\/+$/u, ''), model: provider.model.trim(), tokenParameter: provider.tokenParameter ?? 'max_completion_tokens', maxTokens: provider.maxTokens ?? 4096, streaming: provider.streaming ?? true, toolMode };
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid() { return new CoreError('INVALID_PROVIDER_RESPONSE', '服务商响应格式无效，或所选模型不支持此协议。', 502); }
function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(part => part?.type === 'text' || part?.type === 'output_text').map(part => typeof part.text === 'string' ? part.text : '').join('\n');
  throw invalid();
}
function parseArguments(value) {
  try {
    const args = typeof value === 'string' ? JSON.parse(value) : value;
    if (!object(args)) throw invalid();
    if (Buffer.byteLength(JSON.stringify(args)) > 300 * 1024) throw invalid();
    return args;
  } catch { throw invalid(); }
}
function normalizeCalls(calls, type) {
  if (!Array.isArray(calls) || calls.length > MAX_TOOL_CALLS) throw invalid();
  const seen = new Set();
  return calls.map(call => {
    const id = type === 'ollama' ? randomUUID() : type === 'responses' ? call?.call_id : call?.id;
    const name = ['openai', 'ollama'].includes(type) ? call?.function?.name : call?.name;
    const args = ['openai', 'ollama'].includes(type) ? call?.function?.arguments : type === 'anthropic' ? call?.input : call?.arguments;
    if (typeof id !== 'string' || !id || id.length > 200 || seen.has(id) || typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(name)) throw invalid();
    seen.add(id);
    return { id, name, args: parseArguments(args) };
  });
}

// Official protocol references (image bytes remain inline; no upload or URL fetch):
// https://developers.openai.com/api/docs/guides/images-vision
// https://platform.claude.com/docs/en/build-with-claude/vision
// https://docs.ollama.com/capabilities/vision
function userContent(message, type) {
  if (message.role !== 'user' || !message.images?.length) return message.content;
  const textType = type === 'responses' ? 'input_text' : 'text';
  const parts = message.content ? [{ type: textType, text: message.content }] : [];
  for (const image of message.images) {
    const url = `data:${image.mimeType};base64,${image.data}`;
    if (type === 'openai') parts.push({ type: 'image_url', image_url: { url } });
    else if (type === 'responses') parts.push({ type: 'input_image', image_url: url });
    else if (type === 'anthropic') parts.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } });
  }
  return parts;
}

function chatHistory(messages, system, type) {
  const result = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'tool') {
      result.push(type === 'ollama' ? { role: 'tool', tool_name: message.name, content: message.content } : { role: 'tool', tool_call_id: message.callId, content: message.content });
    } else if (message.role === 'user' && message.images?.length) {
      result.push(type === 'ollama' ? { role: 'user', content: message.content, images: message.images.map(image => image.data) } : { role: 'user', content: userContent(message, type) });
    } else if (message.wire?.type === type) result.push(message.wire.message);
    else result.push({ role: message.role, content: message.content });
  }
  return result;
}

function anthropicHistory(messages) {
  const result = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.callId, content: message.content, is_error: Boolean(message.isError) };
      const last = result.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every(item => item.type === 'tool_result')) last.content.push(block);
      else result.push({ role: 'user', content: [block] });
    } else if (message.role === 'user' && message.images?.length) result.push({ role: 'user', content: userContent(message, 'anthropic') });
    else if (message.wire?.type === 'anthropic') result.push({ role: 'assistant', content: message.wire.content });
    else result.push({ role: message.role, content: userContent(message, 'anthropic') });
  }
  return result;
}

function responseHistory(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.callId, output: message.content });
    else if (message.role === 'user' && message.images?.length) input.push({ role: 'user', content: userContent(message, 'responses') });
    else if (message.wire?.type === 'responses') input.push(...message.wire.output);
    else input.push({ role: message.role, content: userContent(message, 'responses') });
  }
  return input;
}

function serializeRequest(providerInput, { messages, tools = [], system = 'You are a helpful assistant.', onText, stream }) {
  const provider = validateProvider(providerInput);
  messages = messages.map(message => {
    if (!Object.hasOwn(message, 'images')) return message;
    if (message.role !== 'user') throw new CoreError('INVALID_IMAGES', '只有用户消息可以附加图片。');
    return { ...message, images: validateImages(message.images) };
  });
  if (provider.toolMode === 'none') tools = [];
  if (onText !== undefined && typeof onText !== 'function') throw new CoreError('INVALID_PROVIDER', '流式文本接收器无效。');
  if (stream !== undefined && typeof stream !== 'boolean') throw new CoreError('INVALID_PROVIDER', '流式请求选项无效。');
  const streaming = provider.streaming && (stream ?? typeof onText === 'function');
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  let endpoint;
  let body;
  const toolSchemas = tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  if (provider.type === 'openai') {
    endpoint = '/chat/completions';
    body = { model: provider.model, messages: chatHistory(messages, system, 'openai'), stream: streaming, ...(streaming ? { stream_options: { include_usage: true } } : {}), [provider.tokenParameter]: provider.maxTokens, ...(tools.length ? { tools: toolSchemas } : {}) };
  } else if (provider.type === 'responses') {
    endpoint = '/responses';
    body = { model: provider.model, instructions: system, input: responseHistory(messages), stream: streaming, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: provider.maxTokens, ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })) } : {}) };
  } else if (provider.type === 'anthropic') {
    endpoint = '/messages';
    headers['anthropic-version'] = '2023-06-01';
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    body = { model: provider.model, max_tokens: provider.maxTokens, system, messages: anthropicHistory(messages), stream: streaming, ...(tools.length ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}) };
  } else if (provider.type === 'ollama') {
    endpoint = '/api/chat';
    body = { model: provider.model, messages: chatHistory(messages, system, 'ollama'), stream: streaming, options: { num_predict: provider.maxTokens }, ...(tools.length ? { tools: toolSchemas } : {}) };
  } else throw new CoreError('DEMO_HAS_NO_NETWORK', '演示模式不调用模型。');
  if (streaming) headers.accept = provider.type === 'ollama' ? 'application/x-ndjson, application/json' : 'text/event-stream, application/json';
  if (provider.apiKey && provider.type !== 'anthropic') headers.authorization = `Bearer ${provider.apiKey}`;
  let base = provider.baseUrl;
  if (provider.type === 'ollama' && base.endsWith('/api')) base = base.slice(0, -4);
  const json = JSON.stringify(body);
  return { url: `${base}${endpoint}`, headers, body: json };
}

/** Exact local transport measurement; this does not estimate a model's token window. */
export function measureProviderRequest(provider, options) {
  const { body } = serializeRequest(provider, options);
  return { requestBytes: Buffer.byteLength(body), requestByteLimit: MAX_REQUEST,
    requestSha256: createHash('sha256').update(body).digest('hex') };
}

export function buildRequest(provider, options) {
  const request = serializeRequest(provider, options);
  if (Buffer.byteLength(request.body) > MAX_REQUEST) throw new CoreError('CONTEXT_TOO_LARGE', '完整请求超过本地 2 MiB 传输预算；未删减用户内容。请减少所选资料或明确拆分任务。此限制不是模型的令牌窗口。', 413);
  return request;
}

export function parseResponse(type, data, { onIncompleteOutput } = {}) {
  if (!object(data)) throw invalid();
  let content = '';
  let rawCalls = [];
  let wire;
  if (type === 'openai' || type === 'ollama') {
    const message = type === 'openai' ? data.choices?.[0]?.message : data.message;
    if (!object(message) || message.role !== 'assistant') throw invalid();
    content = contentText(message.content) || contentText(message.refusal);
    rawCalls = message.tool_calls ?? [];
    // Preserve provider-specific assistant fields (e.g. reasoning_content) for exact continuation.
    wire = { type, message };
  } else if (type === 'anthropic') {
    if (!Array.isArray(data.content)) throw invalid();
    content = contentText(data.content.filter(part => part?.type === 'text'));
    rawCalls = data.content.filter(part => part?.type === 'tool_use');
    wire = { type, content: data.content };
  } else if (type === 'responses') {
    if (!Array.isArray(data.output)) throw invalid();
    content = data.output.filter(item => item?.type === 'message').map(item => {
      if (item.role != null && item.role !== 'assistant') throw invalid();
      if (!Array.isArray(item.content)) throw invalid();
      return item.content.filter(part => part?.type === 'output_text' || part?.type === 'refusal').map(part => {
        const text = part.type === 'refusal' ? part.refusal : part.text;
        if (typeof text !== 'string') throw invalid();
        return text;
      }).join('\n');
    }).join('\n');
    rawCalls = data.output.filter(item => item?.type === 'function_call');
    wire = { type, output: data.output };
  } else throw invalid();
  if (!Array.isArray(rawCalls)) throw invalid();
  const reasoning = publicReasoning(type, data);
  // A terminal token limit may leave function arguments as unfinished JSON.
  // Preserve validated public output before parsing any executable tool data.
  try { validateTerminal(type, data, { hasTools: rawCalls.length > 0, allowMissingText: true }); }
  catch (error) {
    if (['MODEL_OUTPUT_LIMIT', 'MODEL_RESPONSE_INCOMPLETE'].includes(error.code) && typeof content === 'string'
      && content.isWellFormed() && !content.includes('\0') && Buffer.byteLength(content) <= 256 * 1024) onIncompleteOutput?.({ content, ...(reasoning ? { publicReasoning: reasoning } : {}) });
    throw error;
  }
  const toolCalls = normalizeCalls(rawCalls, type);
  if (typeof content !== 'string' || Buffer.byteLength(content) > 256 * 1024 || (!content && !toolCalls.length)) throw invalid();
  return { content, toolCalls, wire, usage: normalizeProviderUsage(type, data), ...(reasoning ? { publicReasoning: reasoning } : {}) };
}

export async function callProvider(providerInput, options) {
  const provider = validateProvider(providerInput);
  const { signal, timeoutMs = 120_000, connectionTimeoutMs = timeoutMs, idleTimeoutMs = timeoutMs, fetchImpl = fetch, onText, onPublicReasoning, onActivity } = options;
  for (const callback of [onPublicReasoning, onActivity]) if (callback !== undefined && typeof callback !== 'function') throw new TypeError('Invalid provider callback');
  checkAbort(signal);
  // The public call only enables streaming when a consumer can receive the text.
  const streaming = typeof onText === 'function' && provider.streaming;
  const request = buildRequest(provider, { ...options, stream: streaming });
  const timeout = providerActivityTimeout({ connectionTimeoutMs, idleTimeoutMs });
  const activity = () => { timeout.activity(); onActivity?.(); };
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let reader;
  function accepted(data, options) {
    const parsed = parseResponse(provider.type, data, options);
    if (provider.toolMode === 'none' && parsed.toolCalls.length) throw new CoreError('TOOLS_DISABLED', '此模型连接为仅对话模式，不能执行工作区工具。', 409);
    return parsed;
  }
  try {
    const response = await withAbort(fetchImpl(request.url, { method: 'POST', headers: request.headers, body: request.body, redirect: 'error', signal: combined }), combined);
    activity();
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      const code = response.status === 429 ? 'PROVIDER_RATE_LIMIT' : [401, 403].includes(response.status) ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_HTTP_ERROR';
      const error = new CoreError(code, [401, 403].includes(response.status)
        ? '模型服务拒绝认证或访问。请检查密钥、模型权限及账户状态后重新发送。'
        : `模型服务请求失败（HTTP ${response.status}）。请检查地址、模型及额度。`, 502);
      // Keep only bounded transport metadata; never retain response bodies or headers.
      error.providerStatus = response.status;
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter && retryAfter.length <= 128) {
        const duration = /^\d+(?:\.\d+)?$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(duration) && duration > 0) error.retryAfterMs = Math.min(300000, Math.ceil(duration));
      }
      throw error;
    }
    if (!response.body) throw invalid();
    reader = response.body.getReader();
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new CoreError('PROVIDER_RESPONSE_TOO_LARGE', '服务商响应超过 1 MiB 限制。', 502);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const streamResponse = contentType === 'text/event-stream' || (provider.type === 'ollama' && ['application/x-ndjson', 'application/ndjson'].includes(contentType));
    if (streamResponse) {
      if (!streaming || (provider.type === 'ollama' ? contentType === 'text/event-stream' : contentType !== 'text/event-stream')) throw invalid();
      const { data, incrementalText } = await readProviderStreamWithTransport(provider.type, reader, { onText, onPublicReasoning, onActivity: activity, signal: combined, maxBytes: MAX_RESPONSE });
      checkAbort(combined);
      return { ...accepted(data), transport: { format: provider.type === 'ollama' ? 'ndjson' : 'sse', incrementalText } };
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await withAbort(reader.read(), combined);
      if (done) break;
      if (value.byteLength) activity();
      total += value.byteLength;
      if (total > MAX_RESPONSE) throw new CoreError('PROVIDER_RESPONSE_TOO_LARGE', '服务商响应超过 1 MiB 限制。', 502);
      chunks.push(value);
    }
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw invalid(); }
    let parsed, partial;
    try { parsed = accepted(data, { onIncompleteOutput: value => { partial = value; } }); }
    catch (error) {
      // A complete JSON envelope can still explicitly report a truncated answer.
      // Preserve only normalized display text; no partial tools are returned and
      // no upstream body is attached to the error/logging channel.
      checkAbort(combined);
      if (partial?.publicReasoning && onPublicReasoning) await withAbort(Promise.resolve().then(() => onPublicReasoning(partial.publicReasoning)), combined);
      if (partial?.content && onText) await withAbort(Promise.resolve().then(() => onText(partial.content)), combined);
      throw error;
    }
    checkAbort(combined);
    if (onPublicReasoning && parsed.publicReasoning) await withAbort(Promise.resolve().then(() => onPublicReasoning(parsed.publicReasoning)), combined);
    if (onText && parsed.content) await withAbort(Promise.resolve().then(() => onText(parsed.content)), combined);
    checkAbort(combined);
    return { ...parsed, transport: { format: 'json', incrementalText: false } };
  } catch (error) {
    if (signal?.aborted) throw new CoreError('CANCELLED', '任务已取消。', 409);
    if (timeout.signal.aborted) throw new CoreError('PROVIDER_TIMEOUT', '模型服务请求超时，请重试。', 504);
    if (error instanceof CoreError) throw error;
    throw new CoreError('PROVIDER_UNAVAILABLE', '无法连接模型服务，请检查网络和服务商地址。', 502);
  } finally {
    timeout.close();
    // Cancellation must not hang on a transport whose cancel() promise never settles.
    reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export async function testProvider(provider, options = {}) {
  const normalized = validateProvider(provider);
  if (normalized.type === 'demo') return { ok: true, message: '本地确定性演示可用；此模式不调用 AI 模型。' };
  const reply = await callProvider(normalized, { messages: [{ role: 'user', content: 'Reply with OK.' }], tools: [], system: 'Answer briefly.', ...options });
  if (!reply.content.trim() || !reply.content.isWellFormed() || reply.content.includes('\0') || reply.toolCalls.length) {
    throw new CoreError('PROVIDER_TEXT_TEST_FAILED', '未获得不含工具调用的完整文本回复；本次文本连接测试未通过。', 502);
  }
  return { ok: true, message: '文本连接测试成功。工具调用兼容性仍取决于所选模型。' };
}
