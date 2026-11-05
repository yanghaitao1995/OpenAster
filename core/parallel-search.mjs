// SPDX-License-Identifier: Apache-2.0
// Fixed, unauthenticated MCP search contract:
// https://docs.parallel.ai/integrations/mcp/quickstart
import { CoreError } from './errors.mjs';
import { APP_VERSION } from './app-version.mjs';
import { validateWebUrl } from './web-fetch.mjs';
import { clippedText } from './web-text.mjs';

const ENDPOINT = 'https://mcp.parallel.ai/mcp', PROTOCOL = '2025-03-26';
const RESPONSE_BYTES = 1024 * 1024, RESULT_BYTES = 128 * 1024, TIMEOUT_MS = 30000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);
const identifier = (value, max) => text(value) && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/u.test(value);
const stopBody = response => { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {} };

function abortable(promise, signal, late) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { if (!settled) { settled = true; cleanup(); reject(signal.reason); } };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(value => {
      if (settled) { late?.(value); return; }
      settled = true; cleanup(); resolve(value);
    }, cause => { if (!settled) { settled = true; cleanup(); reject(cause); } });
  });
}

export function createParallelSearch({ fetchImpl = fetch, clock = () => new Date() } = {}) {
  if (typeof fetchImpl !== 'function' || typeof clock !== 'function') throw new TypeError('Invalid search dependencies');
  const errors = new WeakSet(), sessions = new Map();
  const error = (code, message, status = 400) => { const value = new CoreError(code, message, status); errors.add(value); return value; };
  const unavailable = () => error('SEARCH_UNAVAILABLE', 'Parallel 搜索未完成或响应不可用；本次没有自动重试。', 502);
  function argumentsOf(input, contextKey) {
    const invalid = () => error('WEB_INVALID_ARGUMENTS', '搜索参数须包含 1 到 500 个字符的公开搜索词，结果数量须为 1 到 10。');
    if (!object(input)) throw invalid();
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(input); } catch { throw invalid(); }
    if (Reflect.ownKeys(descriptors).some(key => !['query', 'maxResults'].includes(key) || !Object.hasOwn(descriptors[key], 'value')) || !Object.hasOwn(descriptors, 'query')) throw invalid();
    const query = descriptors.query.value, maxResults = descriptors.maxResults === undefined ? 5 : descriptors.maxResults.value;
    if (!text(query) || !query.trim() || query.length > 500 || /[\x00-\x1f\x7f]/u.test(query)
      || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 10
      || contextKey !== undefined && !identifier(contextKey, 1024)) throw invalid();
    return { query: query.trim(), maxResults };
  }
  function remember(contextKey, sessionId) {
    if (contextKey === undefined || sessionId === undefined) return;
    sessions.delete(contextKey); sessions.set(contextKey, sessionId);
    // A local memory bound only. Never generate or rotate correlation IDs, and
    // never remove a retained ID in response to rate limiting or other errors.
    if (sessions.size > 128) sessions.delete(sessions.keys().next().value);
  }
  function resultOf(result, query, maxResults) {
    if (!object(result) || result.isError !== undefined && result.isError !== false) throw unavailable();
    let data = result.structuredContent;
    if (!Object.hasOwn(result, 'structuredContent')) {
      if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== 'text' || !text(result.content[0].text)) throw unavailable();
      data = JSON.parse(result.content[0].text);
    }
    if (!object(data) || !identifier(data.search_id, 1000) || !Array.isArray(data.results) || data.results.length > 4096
      || data.session_id !== undefined && !identifier(data.session_id, 1000)) throw unavailable();
    const results = [], seen = new Set(); let truncated = false;
    for (const item of data.results) {
      if (!object(item) || typeof item.url !== 'string' || !text(item.title) || !Array.isArray(item.excerpts)
        || item.excerpts.length > 1024 || !item.excerpts.every(text)) throw unavailable();
      let publishedAt;
      if (item.publish_date !== undefined && item.publish_date !== null) {
        if (!text(item.publish_date) || item.publish_date.length > 64 || !/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/u.test(item.publish_date) || !Number.isFinite(Date.parse(item.publish_date))) throw unavailable();
        publishedAt = item.publish_date;
      }
      let url;
      try { url = validateWebUrl(item.url).href; } catch { truncated = true; continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      if (results.length >= maxResults) { truncated = true; continue; }
      const title = clippedText(item.title, 400), snippet = clippedText(item.excerpts.join('\n\n'), 4000);
      truncated ||= title.truncated || snippet.truncated;
      results.push({ title: title.content, url, snippet: snippet.content, ...(publishedAt ? { publishedAt } : {}) });
    }
    if (!results.length) throw error('SEARCH_SOURCES_MISSING', 'Parallel 搜索没有返回可验证的公开来源链接；未生成替代来源，本次没有自动重试。', 502);
    const value = { query, results, provider: 'parallel', fetchedAt: new Date(clock()).toISOString(), untrusted_data: true, truncated };
    while (Buffer.byteLength(JSON.stringify(value)) > RESULT_BYTES && results.length > 1) { results.pop(); value.truncated = true; }
    if (Buffer.byteLength(JSON.stringify(value)) > RESULT_BYTES) throw unavailable();
    return { value, sessionId: data.session_id };
  }
  return Object.freeze({
    async search(input, { signal, contextKey } = {}) {
      const { query, maxResults } = argumentsOf(input, contextKey);
      const controller = new AbortController();
      const cancel = () => controller.abort(error('CANCELLED', '搜索已取消。', 409));
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(error('SEARCH_UNAVAILABLE', 'Parallel 搜索超过 30 秒总时限，已停止接收；本次没有自动重试。', 504)), TIMEOUT_MS);
      let receivedBytes = 0, transportSession;
      async function rpc(method, params, id) {
        let response, reader, finished = false;
        try {
          controller.signal.throwIfAborted();
          response = await abortable(fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Accept-Encoding': 'identity',
              ...(method !== 'initialize' ? { 'MCP-Protocol-Version': PROTOCOL } : {}), ...(transportSession ? { 'Mcp-Session-Id': transportSession } : {}) },
            body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }), signal: controller.signal,
          }), controller.signal, stopBody);
          controller.signal.throwIfAborted();
          if (!response || response.redirected || response.url && response.url !== ENDPOINT || !response.headers?.get) throw unavailable();
          if ([401, 403].includes(response.status)) throw error('SEARCH_AUTH_FAILED', 'Parallel 拒绝当前搜索访问；请检查服务可用性和访问权限。', 403);
          if (response.status === 429) throw error('SEARCH_RATE_LIMIT', 'Parallel 免费搜索达到频率或额度限制；请稍后再试，本次没有自动重试。', 429);
          const assigned = response.headers.get('mcp-session-id');
          if (assigned !== null) {
            if (!/^[\x21-\x7e]{1,1024}$/u.test(assigned) || transportSession !== undefined && assigned !== transportSession) throw unavailable();
            transportSession = assigned;
          }
          if (id === undefined) {
            if (![202, 204].includes(response.status)) throw unavailable();
            stopBody(response); finished = true; return null;
          }
          if (response.status !== 200 || !response.body?.getReader) throw unavailable();
          const length = response.headers.get('content-length'), encoding = response.headers.get('content-encoding');
          const media = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
          if (length !== null && (!/^\d{1,10}$/u.test(length) || Number(length) > RESPONSE_BYTES - receivedBytes)
            || !['application/json', 'text/event-stream'].includes(media) || encoding && encoding.toLowerCase() !== 'identity') throw unavailable();
          const decode = new TextDecoder('utf-8', { fatal: true }), chunks = [];
          let bodyBytes = 0, pending = '', dataLines = [];
          const envelope = (message, allowOther = false) => {
            if (!object(message) || message.jsonrpc !== '2.0') throw unavailable();
            if (message.id !== id) { if (allowOther) return undefined; throw unavailable(); }
            if (Object.hasOwn(message, 'error') || !object(message.result) || Object.hasOwn(message, 'method')) throw unavailable();
            return message.result;
          };
          const event = () => {
            if (!dataLines.length) return undefined;
            const raw = dataLines.join('\n'); dataLines = [];
            return envelope(JSON.parse(raw), true);
          };
          const feed = (part, final = false) => {
            pending += part;
            for (;;) {
              const index = pending.search(/[\r\n]/u);
              if (index < 0 || pending[index] === '\r' && index === pending.length - 1 && !final) return undefined;
              const line = pending.slice(0, index), size = pending[index] === '\r' && pending[index + 1] === '\n' ? 2 : 1;
              pending = pending.slice(index + size);
              if (!line) { const value = event(); if (value !== undefined) return value; }
              else if (line === 'data') dataLines.push('');
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /u, ''));
              // Ignore SSE IDs, comments, retry hints and all other fields. No
              // server event can request another tool, reconnect or redirect.
            }
          };
          reader = response.body.getReader();
          for (;;) {
            const chunk = await abortable(reader.read(), controller.signal);
            controller.signal.throwIfAborted();
            if (chunk.done) break;
            if (!(chunk.value instanceof Uint8Array)) throw unavailable();
            bodyBytes += chunk.value.byteLength; receivedBytes += chunk.value.byteLength;
            if (receivedBytes > RESPONSE_BYTES || length !== null && bodyBytes > Number(length)) throw unavailable();
            if (media === 'text/event-stream') {
              const value = feed(decode.decode(chunk.value, { stream: true }));
              if (value !== undefined) return value; // finally cancels a still-open SSE stream.
            } else chunks.push(chunk.value);
          }
          if (length !== null && bodyBytes !== Number(length)) throw unavailable();
          if (media === 'text/event-stream') {
            const tail = decode.decode();
            const value = feed(tail, true);
            if (value !== undefined) { finished = true; return value; }
            throw unavailable();
          }
          const value = envelope(JSON.parse(decode.decode(Buffer.concat(chunks, bodyBytes))));
          finished = true; return value;
        } finally {
          if (!finished) { if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} } else stopBody(response); }
          try { reader?.releaseLock(); } catch {}
        }
      }
      try {
        const initialized = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'OpenAster', version: APP_VERSION } }, 1);
        if (initialized.protocolVersion !== PROTOCOL || !object(initialized.capabilities) || !object(initialized.capabilities.tools)
          || !object(initialized.serverInfo) || !text(initialized.serverInfo.name) || !text(initialized.serverInfo.version)) throw unavailable();
        await rpc('notifications/initialized', {});
        const sessionId = contextKey === undefined ? undefined : sessions.get(contextKey);
        if (sessionId !== undefined) remember(contextKey, sessionId);
        const result = await rpc('tools/call', { name: 'web_search', arguments: { objective: query, search_queries: [query], ...(sessionId ? { session_id: sessionId } : {}) } }, 2);
        const parsed = resultOf(result, query, maxResults);
        controller.signal.throwIfAborted(); remember(contextKey, parsed.sessionId); return parsed.value;
      } catch (cause) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw errors.has(cause) ? cause : unavailable();
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    },
  });
}
