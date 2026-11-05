// SPDX-License-Identifier: Apache-2.0
// Contract: https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses
// A single paid Responses request; no endpoint discovery, retries or fallback.
import { CoreError } from './errors.mjs';
import { validateWebUrl } from './web-fetch.mjs';
import { clippedText } from './web-text.mjs';

const RESPONSE_BYTES = 1024 * 1024, SUMMARY_CHARS = 20000, TIMEOUT_MS = 30000;
const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stopBody = response => { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {} };

export function createBailianSearch({ fetchImpl = fetch, clock = () => new Date() } = {}) {
  if (typeof fetchImpl !== 'function' || typeof clock !== 'function') throw new TypeError('Invalid search dependencies');
  const errors = new WeakSet();
  const error = (code, message, status = 400) => { const value = new CoreError(code, message, status); errors.add(value); return value; };
  const unavailable = () => error('SEARCH_UNAVAILABLE', '百炼搜索未完成或响应不可用；本次没有自动重试。', 502);
  function argumentsOf(input) {
    const invalid = () => error('WEB_INVALID_ARGUMENTS', '搜索参数须包含 1 到 500 个字符的公开搜索词，结果数量须为 1 到 10。');
    if (!object(input)) throw invalid();
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(input); } catch { throw invalid(); }
    if (Reflect.ownKeys(descriptors).some(key => !['query', 'maxResults'].includes(key) || !Object.hasOwn(descriptors[key], 'value')) || !Object.hasOwn(descriptors, 'query')) throw invalid();
    const query = descriptors.query.value, maxResults = descriptors.maxResults === undefined ? 5 : descriptors.maxResults.value;
    if (typeof query !== 'string' || !query.trim() || query.length > 500 || !query.isWellFormed() || /[\x00-\x1f\x7f]/u.test(query) || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 10) throw invalid();
    return { query: query.trim(), maxResults };
  }
  function configuration(provider) {
    let type, model, base, key;
    try { type = own(provider, 'type'); model = own(provider, 'model'); base = own(provider, 'baseUrl'); key = own(provider, 'apiKey'); } catch { throw error('SEARCH_NOT_CONFIGURED', '请先配置可用的百炼模型连接和密钥。'); }
    if (typeof key !== 'string' || !key.trim()) throw error('SEARCH_NOT_CONFIGURED', '百炼搜索需要当前模型连接的密钥，请在连接设置中配置。');
    if (!['openai', 'responses'].includes(type) || typeof model !== 'string' || !/^qwen[a-zA-Z0-9._-]{0,155}$/u.test(model)) throw error('SEARCH_UNSUPPORTED', '百炼搜索仅支持 OpenAI 兼容或 Responses 连接中的 Qwen 模型。');
    if (key.length > 8192 || /[^\x21-\x7e]/u.test(key) || typeof base !== 'string' || base.length > 2048 || /[%\\\x00-\x20\x7f]/u.test(base)) throw error('SEARCH_NOT_CONFIGURED', '百炼搜索连接地址或密钥格式无效，请检查连接设置。');
    let url;
    try { url = new URL(base); } catch { throw error('SEARCH_NOT_CONFIGURED', '百炼搜索连接地址无效，请检查连接设置。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /(?:^|\/)\.\.(?:\/|$)/u.test(base) || /(?:^|\/)\.(?:\/|$)/u.test(base)) throw error('SEARCH_NOT_CONFIGURED', '百炼搜索需要不含凭据、查询参数或路径跳转的 HTTPS 模型地址。');
    // Preserve the user's configured origin and base path. Never send this key
    // to a discovered/alternative host, including after a redirect response.
    const endpoint = `${base.replace(/\/+$/u, '')}/responses`;
    if (new URL(endpoint).origin !== url.origin) throw error('SEARCH_NOT_CONFIGURED', '百炼搜索连接地址无效，请检查连接设置。');
    return { model, endpoint, key };
  }
  function abortable(promise, signal, late) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', abort);
      const abort = () => { if (settled) return; settled = true; cleanup(); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      Promise.resolve(promise).then(value => { if (settled) { late?.(value); return; } settled = true; cleanup(); resolve(value); }, cause => { if (settled) return; settled = true; cleanup(); reject(cause); });
    });
  }
  function parsedResult(data, query, maxResults, key) {
    if (!object(data) || data.status !== 'completed' || data.error != null || !Array.isArray(data.output) || !data.output.length || data.output.length > 256) throw unavailable();
    const results = [], seen = new Set(), summaries = []; let calls = 0, truncated = false;
    for (const item of data.output) {
      if (!object(item)) throw unavailable();
      if (item.type === 'web_search_call') {
        if (item.status !== 'completed' || !object(item.action) || item.action.type !== 'search') throw unavailable();
        calls++;
        const sources = item.action.sources ?? [];
        if (!Array.isArray(sources) || sources.length > 4096) throw unavailable();
        for (const source of sources) {
          let url;
          try {
            if (!object(source) || source.type !== 'url' || typeof source.url !== 'string' || source.url.includes(key)) throw new Error();
            url = validateWebUrl(source.url);
          } catch { truncated = true; continue; }
          if (seen.has(url.href)) continue;
          seen.add(url.href);
          if (results.length >= maxResults) { truncated = true; continue; }
          results.push({ title: url.hostname, url: url.href, snippet: '' });
        }
      } else if (item.type === 'message') {
        if (item.role !== 'assistant' || item.status != null && item.status !== 'completed' || !Array.isArray(item.content)) throw unavailable();
        for (const part of item.content) {
          if (!object(part) || part.type !== 'output_text' || typeof part.text !== 'string' || !part.text.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(part.text) || part.text.includes(key)) throw unavailable();
          summaries.push(part.text);
        }
      } else if (item.type !== 'reasoning') throw unavailable();
    }
    if (!calls) throw unavailable();
    if (!results.length) throw error('SEARCH_SOURCES_MISSING', '百炼搜索未返回可验证的公开来源链接；未将模型生成内容作为搜索证据，本次没有自动重试。', 502);
    const summary = clippedText(summaries.join('\n'), SUMMARY_CHARS);
    const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000 ? value : null;
    const searchCount = data.usage?.x_tools?.web_search?.count;
    return { query, results, summary: summary.content, summaryKind: 'model-generated', provider: 'bailian', sourceStatus: 'provided',
      fetchedAt: new Date(clock()).toISOString(), untrusted_data: true, truncated: truncated || summary.truncated,
      usage: { inputTokens: count(data.usage?.input_tokens), outputTokens: count(data.usage?.output_tokens), totalTokens: count(data.usage?.total_tokens),
        reasoningTokens: count(data.usage?.output_tokens_details?.reasoning_tokens), searchCount: Number.isSafeInteger(searchCount) && searchCount >= 0 && searchCount <= 1000 ? searchCount : null } };
  }
  return Object.freeze({
    async search(input, { signal, provider } = {}) {
      const { query, maxResults } = argumentsOf(input), { model, endpoint, key } = configuration(provider);
      const controller = new AbortController();
      const cancel = () => controller.abort(error('CANCELLED', '搜索已取消；已提交的服务商请求仍可能计费。', 409));
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(error('SEARCH_UNAVAILABLE', '百炼搜索超过 30 秒时限，已停止接收；已提交的请求仍可能计费，本次没有自动重试。', 504)), TIMEOUT_MS);
      let response, reader, completed = false;
      try {
        controller.signal.throwIfAborted();
        response = await abortable(fetchImpl(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity', Authorization: `Bearer ${key}` }, signal: controller.signal,
          body: JSON.stringify({ model, input: query, tools: [{ type: 'web_search' }], tool_choice: 'required', reasoning: { effort: 'none' }, store: false, max_output_tokens: 512, stream: false }),
        }), controller.signal, stopBody);
        controller.signal.throwIfAborted();
        if (!response || response.redirected || response.url && response.url !== new URL(endpoint).href) throw unavailable();
        if ([401,403].includes(response.status)) throw error('SEARCH_AUTH_FAILED', '百炼拒绝搜索请求的鉴权或访问权限，请检查当前连接的密钥、地域和模型权限。', 403);
        if (response.status === 429) throw error('SEARCH_RATE_LIMIT', '百炼搜索达到频率或额度限制，本次没有自动重试。', 429);
        if ([404,405].includes(response.status)) throw error('SEARCH_UNSUPPORTED', '当前模型服务地址未提供可用的 Responses 搜索接口；未更换地址或自动回退。', 422);
        if (response.status !== 200 || !response.body?.getReader || !response.headers?.get) throw unavailable();
        const length = response.headers.get('content-length'), media = response.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase(), encoding = response.headers.get('content-encoding');
        if (length && (!/^\d{1,10}$/u.test(length) || Number(length) > RESPONSE_BYTES) || !media || !/^application\/(?:json|[a-z0-9.+-]+\+json)$/u.test(media) || encoding && encoding.toLowerCase() !== 'identity') throw unavailable();
        reader = response.body.getReader(); const chunks = []; let bytes = 0;
        for (;;) {
          const chunk = await abortable(reader.read(), controller.signal);
          controller.signal.throwIfAborted();
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw unavailable();
          bytes += chunk.value.byteLength;
          if (bytes > RESPONSE_BYTES) throw error('SEARCH_UNAVAILABLE', '百炼搜索响应超过 1 MiB 接收限制，已停止接收；本次没有自动重试。', 413);
          chunks.push(chunk.value);
        }
        if (length && bytes !== Number(length)) throw unavailable();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
        const result = parsedResult(JSON.parse(text), query, maxResults, key);
        controller.signal.throwIfAborted(); completed = true; return result;
      } catch (cause) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw errors.has(cause) ? cause : unavailable();
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (!completed) { controller.abort(); if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} } else stopBody(response); }
        try { reader?.releaseLock(); } catch {}
      }
    },
  });
}
