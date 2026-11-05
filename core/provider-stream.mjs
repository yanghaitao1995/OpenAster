// SPDX-License-Identifier: Apache-2.0
// Protocol references:
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
// https://developers.openai.com/api/reference/resources/responses/streaming-events
// https://platform.claude.com/docs/en/build-with-claude/streaming
// https://docs.ollama.com/capabilities/tool-calling
// https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation
import { CoreError, checkAbort } from './errors.mjs';
import { validateTerminal } from './provider-terminal.mjs';
import { publicReasoning } from './provider-progress.mjs';

const MAX_CONTENT = 256 * 1024;
const MAX_TOOLS = 8;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new CoreError('INVALID_PROVIDER_RESPONSE', '服务商流式响应格式无效。', 502);
const incomplete = () => new CoreError('MODEL_RESPONSE_INCOMPLETE', '模型未完整结束响应，请重试。', 502);
const streamError = () => new CoreError('PROVIDER_STREAM_ERROR', '模型服务在流式响应中返回错误，请重试。', 502);
const has = (value, key) => Object.hasOwn(value, key);
const index = (value, limit = 256) => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= limit) throw invalid();
  return value;
};
const string = value => {
  if (typeof value !== 'string') throw invalid();
  return value;
};
const identity = (target, key, value) => {
  if (value == null) return;
  if (has(target, key) && target[key] !== value) throw invalid();
  target[key] = value;
};

/** Abort even when a custom fetch, stream reader or async consumer ignores AbortSignal. */
export function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => { signal.removeEventListener('abort', aborted); settle(value); };
    const aborted = () => finish(reject, new CoreError('CANCELLED', '任务已取消。', 409));
    signal.addEventListener('abort', aborted, { once: true });
    // Attach rejection handling even if cancellation occurred while constructing the promise.
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) aborted();
  });
}

function emitter(onText, signal) {
  let bytes = 0;
  return async text => {
    string(text);
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_CONTENT) throw new CoreError('MODEL_OUTPUT_LIMIT', '单段模型公开输出超过 256 KiB 保存上限。请缩小请求后继续；已保存内容不会被当作完整答复。', 413);
    checkAbort(signal);
    if (text && onText) await withAbort(Promise.resolve().then(() => onText(text)), signal);
    checkAbort(signal);
  };
}

function chatCollector(emit, emitReasoning) {
  const message = { role: 'assistant', content: '' };
  const calls = new Map();
  let finishReason;
  let usage = null;
  let started = false;
  let done = false;
  return {
    get done() { return done; },
    async event(data) {
      if (done) throw invalid();
      if (data === '[DONE]') {
        if (!started || !finishReason) throw incomplete();
        done = true;
        return;
      }
      if (!object(data) || !Array.isArray(data.choices)) throw invalid();
      // Usage is cumulative, never a delta. Malformed statistics must not make
      // an otherwise complete text/tool response fail. The normalizer filters it.
      if (!data.choices.length) {
        if (!finishReason || !has(data, 'usage')) throw invalid();
        usage = data.usage;
        return;
      }
      if (data.choices.length !== 1 || data.choices[0]?.index !== 0 || finishReason) throw invalid();
      const choice = data.choices[0];
      const delta = choice.delta;
      if (!object(delta)) throw invalid();
      started = true;
      if (delta.role != null && delta.role !== 'assistant') throw invalid();
      if ((message.content || delta.content) && (message.refusal || delta.refusal)) throw invalid();
      if (delta.content != null) { message.content += string(delta.content); await emit(delta.content, choice.finish_reason == null); }
      if (delta.refusal != null) {
        message.refusal = (message.refusal ?? '') + string(delta.refusal);
        await emit(delta.refusal, choice.finish_reason == null);
      }
      // These fields are retained for compatible providers, but never exposed to onText.
      for (const field of ['reasoning_content', 'reasoning', 'thinking']) {
        if (delta[field] != null) message[field] = (message[field] ?? '') + string(delta[field]);
      }
      if (delta.reasoning_content != null) await emitReasoning(delta.reasoning_content);
      if (delta.function_call != null || delta.audio != null) throw invalid();
      if (delta.tool_calls != null) {
        if (!Array.isArray(delta.tool_calls)) throw invalid();
        for (const part of delta.tool_calls) {
          if (!object(part)) throw invalid();
          const position = index(part.index, MAX_TOOLS);
          if (!calls.has(position)) calls.set(position, { type: 'function', function: { arguments: '' } });
          const call = calls.get(position);
          if (part.type != null && part.type !== 'function') throw invalid();
          if (part.id != null) identity(call, 'id', string(part.id));
          if (part.function != null) {
            if (!object(part.function)) throw invalid();
            if (part.function.name != null) identity(call.function, 'name', string(part.function.name));
            if (part.function.arguments != null) call.function.arguments += string(part.function.arguments);
          }
        }
      }
      if (choice.finish_reason != null) {
        validateTerminal('openai', { choices: [{ finish_reason: choice.finish_reason }] }, { hasTools: calls.size > 0 });
        finishReason = choice.finish_reason;
        usage = has(data, 'usage') ? data.usage : null;
      }
    },
    result() {
      if (!done) throw incomplete();
      if (calls.size) {
        message.tool_calls = [...calls.entries()].sort(([left], [right]) => left - right).map(([position, call], expected) => {
          if (position !== expected) throw invalid();
          return call;
        });
      }
      return { choices: [{ message, finish_reason: finishReason }], usage };
    },
  };
}

function responsesCollector(emit, emitReasoning) {
  let done = false;
  let terminal;
  let sequence = -1;
  let terminalSentinel = false;
  const items = new Map();
  const parts = new Map();
  const summaries = new Map();
  let lastSummary, reasoning = '';
  async function summaryPart(key, delta) {
    if (lastSummary !== undefined && lastSummary !== key) { reasoning += '\n'; await emitReasoning('\n'); }
    lastSummary = key;
    reasoning += delta;
    await emitReasoning(delta);
  }
  let lastVisible;
  let visible = '';
  async function textPart(key, delta) {
    if (lastVisible !== undefined && lastVisible !== key) { visible += '\n'; await emit('\n'); }
    lastVisible = key;
    visible += delta;
    await emit(delta, true);
  }
  return {
    get done() { return done; },
    async event(data) {
      if (data === '[DONE]') {
        if (!done || terminalSentinel) throw incomplete();
        terminalSentinel = true;
        return;
      }
      if (!object(data) || typeof data.type !== 'string' || done) throw invalid();
      if (data.sequence_number != null) {
        if (!Number.isSafeInteger(data.sequence_number) || data.sequence_number <= sequence) throw invalid();
        sequence = data.sequence_number;
      }
      if (data.type === 'response.failed' || data.type === 'response.cancelled') throw streamError();
      if (data.type === 'response.incomplete') {
        // An explicit token/safety terminal cannot improve by retrying the same
        // request indefinitely. Transport EOF without a terminal remains retryable.
        validateTerminal('responses', data.response ?? { status: 'incomplete' });
        throw incomplete();
      }
      if (data.type === 'response.output_item.added') {
        const position = index(data.output_index);
        if (items.has(position) || !object(data.item)) throw invalid();
        if (data.item.type === 'message' && data.item.role !== 'assistant') throw invalid();
        items.set(position, { item: data.item, done: false });
        if ([...items.values()].filter(value => value.item.type === 'function_call').length > MAX_TOOLS) throw invalid();
      } else if (data.type === 'response.reasoning_summary_part.added') {
        const position = index(data.output_index), key = `${position}/${index(data.summary_index)}`;
        const owner = items.get(position);
        if (!owner || owner.done || owner.item.type !== 'reasoning' || owner.item.id !== data.item_id || summaries.has(key) || data.part?.type !== 'summary_text') throw invalid();
        summaries.set(key, { text: string(data.part.text), done: false, textDone: false, owner: data.item_id });
        await summaryPart(key, data.part.text);
      } else if (data.type === 'response.reasoning_summary_text.delta') {
        const key = `${index(data.output_index)}/${index(data.summary_index)}`, value = summaries.get(key);
        if (!value || value.done || value.textDone || value.owner !== data.item_id) throw invalid();
        value.text += string(data.delta);
        await summaryPart(key, data.delta);
      } else if (data.type === 'response.reasoning_summary_text.done') {
        const value = summaries.get(`${index(data.output_index)}/${index(data.summary_index)}`);
        if (!value || value.done || value.textDone || value.owner !== data.item_id || value.text !== data.text) throw invalid();
        value.textDone = true;
      } else if (data.type === 'response.reasoning_summary_part.done') {
        const value = summaries.get(`${index(data.output_index)}/${index(data.summary_index)}`);
        if (!value || value.done || value.owner !== data.item_id || data.part?.type !== 'summary_text' || value.text !== data.part.text) throw invalid();
        value.done = true;
      } else if (data.type === 'response.content_part.added') {
        const position = index(data.output_index);
        const contentPosition = index(data.content_index);
        const owner = items.get(position);
        const key = `${position}/${contentPosition}`;
        if (!owner || owner.done || owner.item.type !== 'message' || owner.item.id !== data.item_id || parts.has(key) || !object(data.part)) throw invalid();
        const part = { ...data.part };
        parts.set(key, { part, done: false, owner: data.item_id });
        if (part.type === 'output_text') await textPart(key, string(part.text));
        else if (part.type === 'refusal') await textPart(key, string(part.refusal));
      } else if (['response.output_text.delta', 'response.refusal.delta'].includes(data.type)) {
        const key = `${index(data.output_index)}/${index(data.content_index)}`;
        const value = parts.get(key);
        const kind = data.type === 'response.output_text.delta' ? 'output_text' : 'refusal';
        if (!value || value.done || value.owner !== data.item_id || value.part.type !== kind) throw invalid();
        const field = kind === 'output_text' ? 'text' : 'refusal';
        value.part[field] += string(data.delta);
        await textPart(key, data.delta);
      } else if (data.type === 'response.content_part.done') {
        const key = `${index(data.output_index)}/${index(data.content_index)}`;
        const value = parts.get(key);
        if (!value || value.done || value.owner !== data.item_id || !object(data.part) || value.part.type !== data.part.type) throw invalid();
        for (const field of ['text', 'refusal']) {
          if (has(value.part, field) && value.part[field] !== data.part[field]) throw invalid();
        }
        value.done = true;
      } else if (data.type === 'response.output_item.done') {
        const position = index(data.output_index);
        const owner = items.get(position);
        if (!owner || owner.done || !object(data.item) || owner.item.id !== data.item.id || owner.item.type !== data.item.type) throw invalid();
        owner.done = true;
      } else if (data.type === 'response.completed') {
        if (!object(data.response) || data.response.status !== 'completed' || data.response.error != null || !Array.isArray(data.response.output)) throw incomplete();
        validateTerminal('responses', data.response, { hasTools: data.response.output.some(item => item?.type === 'function_call') });
        if ([...items.values()].some(value => !value.done) || [...parts.values()].some(value => !value.done) || [...summaries.values()].some(value => !value.done)) throw incomplete();
        for (const [position, value] of items) {
          if (data.response.output[position]?.id !== value.item.id || data.response.output[position]?.type !== value.item.type) throw invalid();
        }
        const finalText = data.response.output.filter(item => item?.type === 'message').map(item => {
          if (item.role !== 'assistant' || !Array.isArray(item.content)) throw invalid();
          return item.content.filter(part => ['output_text', 'refusal'].includes(part?.type)).map(part => string(part.type === 'refusal' ? part.refusal : part.text)).join('\n');
        }).join('\n');
        // Some compatible servers send only a completed response; disclose its text once.
        if (!parts.size && !visible) await emit(finalText);
        else if (visible !== finalText) throw invalid();
        const finalReasoning = publicReasoning('responses', data.response);
        if (!summaries.size && !reasoning) await emitReasoning(finalReasoning);
        else if (reasoning !== finalReasoning) throw invalid();
        terminal = data.response; // Preserve final encrypted reasoning and all output metadata.
        done = true;
      }
      // Unknown lifecycle/progress events are ignored. Their text is never displayed.
    },
    result() { if (!done) throw incomplete(); return terminal; },
  };
}

function anthropicCollector(emit, emitReasoning) {
  let message;
  let done = false;
  let stopReason;
  const blocks = [];
  const open = new Set();
  const inputs = new Map();
  let textBlocks = 0;
  let thinkingBlocks = 0;
  return {
    get done() { return done; },
    async event(data) {
      if (!object(data) || typeof data.type !== 'string' || done) throw invalid();
      if (data.type === 'ping') return;
      if (data.type === 'message_start') {
        if (message || !object(data.message) || data.message.role !== 'assistant' || !Array.isArray(data.message.content) || data.message.content.length) throw invalid();
        message = { ...data.message, content: blocks };
        // message_start output_tokens is a provisional count, not a completed
        // generation total. Only message_delta may supply its final value.
        message.usage = object(message.usage) ? { ...message.usage, output_tokens: null } : null;
      } else if (data.type === 'content_block_start') {
        if (!message || stopReason || open.size || index(data.index) !== blocks.length || !object(data.content_block)) throw invalid();
        const block = { ...data.content_block };
        blocks.push(block);
        open.add(data.index);
        if (block.type === 'tool_use') {
          if (blocks.filter(item => item.type === 'tool_use').length > MAX_TOOLS || !object(block.input)) throw invalid();
          inputs.set(data.index, '');
        } else if (block.type === 'text') {
          if (textBlocks++) await emit('\n');
          await emit(string(block.text), true);
        } else if (block.type === 'thinking') {
          if (thinkingBlocks++) await emitReasoning('\n');
          await emitReasoning(string(block.thinking ?? ''));
        }
      } else if (data.type === 'content_block_delta') {
        const position = index(data.index);
        if (!message || !open.has(position) || !object(data.delta)) throw invalid();
        const block = blocks[position];
        const delta = data.delta;
        if (delta.type === 'text_delta') {
          if (block.type !== 'text') throw invalid();
          block.text += string(delta.text);
          await emit(delta.text, true);
        } else if (delta.type === 'input_json_delta') {
          if (block.type !== 'tool_use') throw invalid();
          inputs.set(position, inputs.get(position) + string(delta.partial_json));
        } else if (delta.type === 'thinking_delta') {
          if (block.type !== 'thinking') throw invalid();
          block.thinking = (block.thinking ?? '') + string(delta.thinking);
          await emitReasoning(delta.thinking);
        } else if (delta.type === 'signature_delta') {
          if (block.type !== 'thinking') throw invalid();
          block.signature = (block.signature ?? '') + string(delta.signature);
        } else if (delta.type === 'citations_delta') {
          if (block.type !== 'text' || !object(delta.citation)) throw invalid();
          (block.citations ??= []).push(delta.citation);
        } else throw invalid(); // Unknown state-changing deltas cannot be safely replayed.
      } else if (data.type === 'content_block_stop') {
        if (!open.delete(index(data.index))) throw invalid();
      } else if (data.type === 'message_delta') {
        if (!message || open.size || !object(data.delta)) throw invalid();
        if (data.delta.stop_reason != null) {
          validateTerminal('anthropic', { stop_reason: data.delta.stop_reason }, { hasTools: inputs.size > 0 });
          if (stopReason && stopReason !== data.delta.stop_reason) throw invalid();
          stopReason = data.delta.stop_reason;
        }
        if (has(data, 'usage')) message.usage = object(data.usage) ? { ...message.usage, ...data.usage } : null;
        if (data.delta.stop_reason != null && (!object(data.usage) || !has(data.usage, 'output_tokens')) && object(message.usage)) message.usage.output_tokens = null;
        for (const key of ['stop_sequence', 'input_transformations']) if (has(data.delta, key)) message[key] = data.delta[key];
      } else if (data.type === 'message_stop') {
        if (!message || open.size || !stopReason || (inputs.size && stopReason !== 'tool_use')) throw incomplete();
        done = true;
      }
    },
    result() {
      if (!done) throw incomplete();
      // JSON parsing is deliberately deferred until the whole stream succeeds.
      for (const [position, partial] of inputs) {
        if (partial) { try { blocks[position].input = JSON.parse(partial); } catch { throw invalid(); } }
      }
      return { ...message, stop_reason: stopReason };
    },
  };
}

function ollamaCollector(emit, emitReasoning) {
  const message = { role: 'assistant', content: '' };
  let terminal;
  let done = false;
  return {
    get done() { return done; },
    async event(data) {
      if (!object(data) || done || typeof data.done !== 'boolean' || !object(data.message) || data.message.role !== 'assistant') throw invalid();
      if (data.message.content != null) { message.content += string(data.message.content); await emit(data.message.content, !data.done); }
      if (data.message.thinking != null) { message.thinking = (message.thinking ?? '') + string(data.message.thinking); await emitReasoning(data.message.thinking); }
      if (data.message.tool_calls != null) {
        if (!Array.isArray(data.message.tool_calls)) throw invalid();
        (message.tool_calls ??= []).push(...data.message.tool_calls);
        if (message.tool_calls.length > MAX_TOOLS) throw invalid();
      }
      if (data.done) {
        validateTerminal('ollama', data, { hasTools: Boolean(message.tool_calls?.length) });
        terminal = { ...data, message };
        done = true;
      }
    },
    result() { if (!done) throw incomplete(); return terminal; },
  };
}

/** Incremental UTF-8 line parser. A final SSE event requires its blank delimiter. */
function framing(format, accept) {
  let fragments = [];
  let afterCR = false;
  let data = [];
  let event = '';
  async function line(value) {
    if (format === 'ndjson') { if (value.trim()) await accept(value, ''); return; }
    if (!value) {
      if (data.length) await accept(data.join('\n'), event);
      data = [];
      event = '';
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') data.push(content);
    else if (field === 'event') event = content;
    // SSE ignores unrecognized fields. id/retry are irrelevant to this non-retrying POST.
  }
  return {
    async push(text, final = false) {
      let offset = 0;
      if (afterCR && text) { if (text[0] === '\n') offset = 1; afterCR = false; }
      for (let position = offset; position < text.length; position++) {
        const character = text[position];
        if (character !== '\r' && character !== '\n') continue;
        fragments.push(text.slice(offset, position));
        await line(fragments.join(''));
        fragments = [];
        if (character === '\r' && text[position + 1] === '\n') position++;
        else if (character === '\r' && position === text.length - 1) afterCR = true;
        offset = position + 1;
      }
      if (offset < text.length) fragments.push(text.slice(offset));
      if (final) {
        const buffer = fragments.join('');
        if (format === 'ndjson' && buffer.trim()) await line(buffer);
        else if (buffer && !buffer.startsWith(':')) throw incomplete();
        fragments = [];
        if (data.length || event) throw incomplete();
      }
    },
  };
}

async function readStream(type, reader, { onText, onPublicReasoning, onActivity, signal, maxBytes = 1024 * 1024 }) {
  const emitText = emitter(onText, signal);
  let incrementalText = false;
  const emit = async (text, beforeTerminal = false) => {
    await emitText(text);
    // Count only visible text from a real pre-terminal protocol event, never
    // whitespace, synthetic separators, reasoning, or compatibility completed-only text.
    if (text.trim() && beforeTerminal) incrementalText = true;
  };
  const factory = { openai: chatCollector, responses: responsesCollector, anthropic: anthropicCollector, ollama: ollamaCollector }[type];
  if (!factory) throw invalid();
  const collector = factory(emit, emitter(onPublicReasoning, signal));
  const frame = framing(type === 'ollama' ? 'ndjson' : 'sse', async (source, event) => {
    let data;
    if (source === '[DONE]') data = source;
    else { try { data = JSON.parse(source); } catch { throw invalid(); } }
    if (event === 'error' || (object(data) && (data.type === 'error' || data.error != null))) throw streamError();
    if (event && ['responses', 'anthropic'].includes(type) && event !== data?.type) throw invalid();
    await collector.event(data);
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const noBufferedChunk = Symbol('no buffered chunk');
  let total = 0;
  while (true) {
    checkAbort(signal);
    // After completion inspect already queued chunks, but never await a future EOF.
    const next = collector.done
      ? await Promise.race([reader.read(), Promise.resolve(noBufferedChunk)])
      : await withAbort(reader.read(), signal);
    if (next === noBufferedChunk || next.done) break;
    if (!(next.value instanceof Uint8Array)) throw invalid();
    if (next.value.byteLength) onActivity?.();
    total += next.value.byteLength;
    if (total > maxBytes) throw new CoreError('PROVIDER_RESPONSE_TOO_LARGE', '服务商响应超过 1 MiB 限制。', 502);
    let text;
    try { text = decoder.decode(next.value, { stream: true }); } catch { throw invalid(); }
    await frame.push(text);
  }
  let tail;
  try { tail = decoder.decode(); } catch { throw invalid(); }
  await frame.push(tail, true);
  checkAbort(signal);
  return { data: collector.result(), incrementalText };
}

/** Preserve the existing raw-data interface for protocol consumers. */
export async function readProviderStream(type, reader, options) {
  return (await readStream(type, reader, options)).data;
}

/** Evidence is returned only after the entire stream has passed validation. */
export async function readProviderStreamWithTransport(type, reader, options) {
  return readStream(type, reader, options);
}
