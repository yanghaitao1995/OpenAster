import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { normalizeProviderUsage, sanitizeUsage } from '../core/usage.mjs';
import { callProvider, parseResponse } from '../core/providers.mjs';

const unknown = () => ({ inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null });
const expected = extra => ({ ...unknown(), ...extra });
const invalidCounts = [undefined, null, -1, 0.5, '12', true, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER, 1_000_000_000_001];
const types = ['openai', 'responses', 'anthropic', 'ollama'];
const sse = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`;
const chat = (delta, finish_reason = null, extra = {}) => ({ choices: [{ index: 0, delta, finish_reason }], ...extra });

test('usage is nullable and rejects invalid counters without inventing zero', () => {
  for (const value of [undefined, null, false, 'usage', [], {}, unknown()]) assert.equal(sanitizeUsage(value), null);
  for (const value of invalidCounts) {
    assert.equal(sanitizeUsage({ inputTokens: value }), null);
    assert.deepEqual(sanitizeUsage({ inputTokens: 0, outputTokens: value }), expected({ inputTokens: 0 }));
  }
  assert.deepEqual(sanitizeUsage({ inputTokens: -0, outputTokens: 1_000_000_000_000 }), expected({ inputTokens: 0, outputTokens: 1_000_000_000_000 }));
  assert.equal(Object.is(sanitizeUsage({ inputTokens: -0 }).inputTokens, -0), false);
});

test('sanitization copies exactly six own data properties without getters or raw payload', () => {
  let reads = 0;
  const source = Object.assign(Object.create({ outputTokens: 13 }), { inputTokens: 12, untrusted: { secret: 'never retain' } });
  Object.defineProperty(source, 'totalTokens', { get() { reads++; throw Error('getter invoked'); } });
  const result = sanitizeUsage(source);
  assert.deepEqual(result, expected({ inputTokens: 12 }));
  assert.equal(reads, 0);
  assert.notEqual(source, result);
  source.inputTokens = 99;
  assert.equal(result.inputTokens, 12);
  assert.equal(sanitizeUsage(new Proxy({}, { getOwnPropertyDescriptor() { throw Error('bad proxy'); } })), null);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(sanitizeUsage(revoked.proxy), null);
});

test('sanitization preserves partial values, checks totals and stays idempotent', () => {
  for (const totalTokens of [3, 14, 16]) {
    const result = sanitizeUsage({ inputTokens: 10, outputTokens: 5, totalTokens });
    assert.deepEqual(result, expected({ inputTokens: 10, outputTokens: 5 }));
    assert.deepEqual(sanitizeUsage(result), result);
  }
  assert.deepEqual(sanitizeUsage({ inputTokens: 10, totalTokens: 20 }), expected({ inputTokens: 10, totalTokens: 20 }));
  assert.deepEqual(sanitizeUsage({ inputTokens: 10, totalTokens: 9 }), expected({ inputTokens: 10 }));
  assert.deepEqual(sanitizeUsage({ outputTokens: 10, totalTokens: 9 }), expected({ outputTokens: 10 }));
  assert.deepEqual(sanitizeUsage({ totalTokens: 0 }), expected({ totalTokens: 0 }));
});

test('cache and reasoning detail are subsets, not extra total tokens', () => {
  assert.deepEqual(sanitizeUsage({ inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: 11, cacheWriteInputTokens: 12, reasoningOutputTokens: 8 }), expected({ inputTokens: 10, outputTokens: 7, totalTokens: 17 }));
  assert.deepEqual(sanitizeUsage({ inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: 10, cacheWriteInputTokens: 10, reasoningOutputTokens: 7 }), expected({ inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: 10, cacheWriteInputTokens: 10, reasoningOutputTokens: 7 }));
  assert.deepEqual(sanitizeUsage({ cachedInputTokens: 9, reasoningOutputTokens: 4 }), expected({ cachedInputTokens: 9, reasoningOutputTokens: 4 }));
});

test('known subsets bound totals even when their parent count is unknown', () => {
  assert.deepEqual(sanitizeUsage({ totalTokens: 0, cachedInputTokens: 1 }), expected({ cachedInputTokens: 1 }));
  assert.deepEqual(sanitizeUsage({ totalTokens: 0, reasoningOutputTokens: 1 }), expected({ reasoningOutputTokens: 1 }));
  assert.deepEqual(sanitizeUsage({ inputTokens: 5, totalTokens: 6, reasoningOutputTokens: 4 }), expected({ inputTokens: 5, reasoningOutputTokens: 4 }));
  assert.deepEqual(sanitizeUsage({ outputTokens: 5, totalTokens: 6, cacheWriteInputTokens: 4 }), expected({ outputTokens: 5, cacheWriteInputTokens: 4 }));
  const compatible = expected({ totalTokens: 12, cachedInputTokens: 8, cacheWriteInputTokens: 7, reasoningOutputTokens: 4 });
  assert.deepEqual(sanitizeUsage(compatible), compatible); // Cache subsets are not added.
  assert.deepEqual(sanitizeUsage({ inputTokens: 10, totalTokens: 10, cachedInputTokens: 11 }), expected({ inputTokens: 10, totalTokens: 10 })); // Invalid subset is removed first.
});

test('provider mapping does not retain a total below known cache/reasoning subsets', () => {
  const mapped = normalizeProviderUsage('openai', { usage: { total_tokens: 0, prompt_tokens_details: { cached_tokens: 1 } } });
  assert.deepEqual(mapped, expected({ cachedInputTokens: 1 }));
  assert.deepEqual(sanitizeUsage(mapped), mapped);
  assert.deepEqual(normalizeProviderUsage('responses', { usage: { input_tokens: 5, total_tokens: 6, output_tokens_details: { reasoning_tokens: 4 } } }), expected({ inputTokens: 5, reasoningOutputTokens: 4 }));
});

test('OpenAI protocols normalize cache writes and reasoning without copying arbitrary usage', () => {
  const want = expected({ inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: 5, cacheWriteInputTokens: 2, reasoningOutputTokens: 3 });
  assert.deepEqual(normalizeProviderUsage('openai', { usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17, prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 2, audio_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 }, secret: 'discard' } }), want);
  assert.deepEqual(normalizeProviderUsage('responses', { usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 }, service_tier: 'discard' } }), want);
});

test('normalization derives only absent totals with complete parents; bad totals stay unknown', () => {
  for (const [type, inputKey, outputKey] of [['openai', 'prompt_tokens', 'completion_tokens'], ['responses', 'input_tokens', 'output_tokens']]) {
    const usage = { [inputKey]: 10, [outputKey]: 7 };
    assert.deepEqual(normalizeProviderUsage(type, { usage }), expected({ inputTokens: 10, outputTokens: 7, totalTokens: 17 }));
    for (const total_tokens of [...invalidCounts, 16, 18]) assert.deepEqual(normalizeProviderUsage(type, { usage: { ...usage, total_tokens } }), expected({ inputTokens: 10, outputTokens: 7 }));
    const accessor = { ...usage };
    Object.defineProperty(accessor, 'total_tokens', { get() { throw Error('must not read'); } });
    assert.deepEqual(normalizeProviderUsage(type, { usage: accessor }), expected({ inputTokens: 10, outputTokens: 7 }));
    assert.deepEqual(normalizeProviderUsage(type, { usage: { [inputKey]: 10, total_tokens: 17 } }), expected({ inputTokens: 10, totalTokens: 17 }));
  }
});

test('Anthropic combines all three input counters once and does not reuse nested cache counts', () => {
  const usage = { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 0 }, total_tokens: 999 };
  assert.deepEqual(normalizeProviderUsage('anthropic', { usage }), expected({ inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: 5, cacheWriteInputTokens: 2 }));
  assert.deepEqual(normalizeProviderUsage('anthropic', { usage: { input_tokens: 3, output_tokens: 7 } }), expected({ outputTokens: 7 }));
  assert.deepEqual(normalizeProviderUsage('anthropic', { usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7 } }), expected({ inputTokens: 3, outputTokens: 7, totalTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0 }));
  assert.deepEqual(normalizeProviderUsage('anthropic', { usage: { ...usage, cache_creation_input_tokens: '2' } }), expected({ outputTokens: 7, cachedInputTokens: 5 }));
});

test('Ollama uses top-level token counts rather than nested usage or nanosecond durations', () => {
  assert.deepEqual(normalizeProviderUsage('ollama', { prompt_eval_count: 10, prompt_eval_cached_count: 5, eval_count: 7, eval_duration: 1234567890, usage: { total_tokens: 999 } }), expected({ inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: 5 }));
  assert.equal(normalizeProviderUsage('ollama', { eval_duration: 7 }), null);
  assert.deepEqual(normalizeProviderUsage('ollama', { eval_count: 0 }), expected({ outputTokens: 0 }));
});

test('bounded sums never overflow the usage limit', () => {
  assert.deepEqual(normalizeProviderUsage('ollama', { prompt_eval_count: 1_000_000_000_000, eval_count: 1 }), expected({ inputTokens: 1_000_000_000_000, outputTokens: 1 }));
  assert.deepEqual(normalizeProviderUsage('anthropic', { usage: { input_tokens: 1_000_000_000_000, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 2 } }), expected({ outputTokens: 2, cachedInputTokens: 1, cacheWriteInputTokens: 0 }));
  assert.equal(normalizeProviderUsage('unknown', { usage: { input_tokens: 3 } }), null);
});

function fixture(type, usageOverride) {
  const text = '已完成🌍';
  const usage = {
    openai: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17, prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } },
    responses: { input_tokens: 10, output_tokens: 7, total_tokens: 17, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } },
    anthropic: { input_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 7 },
    ollama: { prompt_eval_count: 10, prompt_eval_cached_count: 5, eval_count: 7 },
  }[type];
  const selected = usageOverride === undefined ? usage : usageOverride;
  if (type === 'openai') return {
    json: { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: selected },
    stream: [chat({ role: 'assistant', content: text }, null, { usage: { prompt_tokens: 999, completion_tokens: 1 } }), chat({}, 'stop'), { choices: [], usage: selected }, '[DONE]'].map(sse).join(''),
  };
  if (type === 'responses') {
    const json = { status: 'completed', output: [{ id: 'message-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: selected };
    return { json, stream: [{ type: 'response.created', response: { usage: { input_tokens: 999, output_tokens: 1 } } }, { type: 'response.completed', response: json }].map(sse).join('') };
  }
  if (type === 'anthropic') return {
    json: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: selected },
    stream: [
      { type: 'message_start', message: { role: 'assistant', content: [], usage: usageOverride === undefined ? { ...usage, output_tokens: 1 } : selected } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 3 } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usageOverride === undefined ? { output_tokens: 7 } : selected },
      { type: 'message_stop' },
    ].map(sse).join(''),
  };
  return {
    json: { message: { role: 'assistant', content: text }, done: true, ...(selected && typeof selected === 'object' && !Array.isArray(selected) ? selected : {}) },
    stream: [
      { message: { role: 'assistant', content: text }, done: false, prompt_eval_count: 999, eval_count: 1 },
      { message: { role: 'assistant', content: '' }, done: true, ...(selected && typeof selected === 'object' && !Array.isArray(selected) ? selected : {}) },
    ].map(value => JSON.stringify(value)).join('\n') + '\n',
  };
}

async function serve(t, type, wire, { streaming = false, fallback = false } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      response.setHeader('content-type', streaming && !fallback ? type === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' : 'application/json');
      const bytes = Buffer.from(streaming && !fallback ? wire.stream : JSON.stringify(wire.json));
      // Write actual HTTP chunked bytes with code points split across writes.
      for (let offset = 0; offset < bytes.length; offset += 13) response.write(bytes.subarray(offset, offset + 13));
      response.end();
    } catch { response.destroy(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const deltas = [];
  const result = await callProvider({ type, model: 'local-usage-fixture', baseUrl: `http://127.0.0.1:${server.address().port}` }, { messages: [{ role: 'user', content: '本机统计测试' }], ...(streaming ? { onText: delta => deltas.push(delta) } : {}) });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.stream, streaming);
  if (type === 'openai' && streaming) assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.equal(result.content, '已完成🌍');
  if (streaming) assert.equal(deltas.join(''), result.content);
  return result;
}

for (const type of types) {
  for (const streaming of [false, true]) test(`${type} ${streaming ? 'stream' : 'JSON'} normalizes usage over real localhost HTTP`, async t => {
    const result = await serve(t, type, fixture(type), { streaming });
    assert.deepEqual(result.usage, expected({ inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: 5, ...(type !== 'ollama' ? { cacheWriteInputTokens: 2 } : {}), ...(['openai', 'responses'].includes(type) ? { reasoningOutputTokens: 3 } : {}) }));
    assert.equal(sanitizeUsage(result.usage).totalTokens, 17);
  });
}

test('bad statistics never reject otherwise valid complete replies', () => {
  for (const type of types) {
    for (const usage of [null, 'bad', [], { secret: 'do not retain' }, { prompt_tokens: -1, completion_tokens: '7', input_tokens: -1, output_tokens: '7', prompt_eval_count: -1, eval_count: '7' }]) {
      const reply = parseResponse(type, fixture(type, usage).json);
      assert.equal(reply.content, '已完成🌍');
      assert.equal(reply.usage, null);
    }
  }
});

test('malformed streamed usage is ignored without retrying or discarding completed text', async t => {
  for (const type of types) {
    const result = await serve(t, type, fixture(type, 'invalid usage container'), { streaming: true });
    assert.equal(result.usage, null);
  }
});

test('JSON fallback retains the same normalized counters when streaming was requested', async t => {
  const result = await serve(t, 'responses', fixture('responses'), { streaming: true, fallback: true });
  assert.equal(result.usage.totalTokens, 17);
  assert.equal(result.usage.reasoningOutputTokens, 3);
});

test('streams without final usage never report provisional output as a completed total', async t => {
  const openai = fixture('openai');
  openai.stream = [chat({ role: 'assistant', content: '已完成🌍' }, null, { usage: { prompt_tokens: 10, completion_tokens: 1 } }), chat({}, 'stop'), '[DONE]'].map(sse).join('');
  assert.equal((await serve(t, 'openai', openai, { streaming: true })).usage, null);
  const anthropic = fixture('anthropic');
  anthropic.stream = anthropic.stream.replace('"usage":{"output_tokens":7}', '"usage":{}');
  assert.deepEqual((await serve(t, 'anthropic', anthropic, { streaming: true })).usage, expected({ inputTokens: 10, cachedInputTokens: 5, cacheWriteInputTokens: 2 }));
});
