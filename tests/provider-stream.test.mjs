import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { buildRequest, callProvider, parseResponse, validateProvider } from '../core/providers.mjs';
import { CoreError } from '../core/errors.mjs';
import { withAbort } from '../core/provider-stream.mjs';
import { getEventListeners } from 'node:events';
import { normalizeProviderUsage } from '../core/usage.mjs';

const provider = (type = 'openai', extra = {}) => ({ type, model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1', apiKey: 'never-sent-to-network', ...extra });
const messages = [{ role: 'user', content: 'fixture' }];
const sse = (data, event = '') => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const typed = data => sse(data, data.type);
const chat = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const chatText = value => sse(chat({ role: 'assistant', content: value })) + sse(chat({}, 'stop')) + sse('[DONE]');
const ndjson = data => `${JSON.stringify(data)}\n`;
const parts = (text, width = 7) => {
  const bytes = Buffer.from(text);
  return Array.from({ length: Math.ceil(bytes.length / width) }, (_, index) => bytes.subarray(index * width, (index + 1) * width));
};
function response(chunks, type = 'text/event-stream', { open = false, cancelNever = false } = {}) {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      if (!open) controller.close();
    },
    cancel() { state.cancelled = true; if (cancelNever) return new Promise(() => {}); },
  });
  return { state, value: new Response(body, { headers: { 'content-type': type } }) };
}
async function run(type, chunks, options = {}) {
  const deltas = [];
  const transport = response(chunks, type === 'ollama' ? 'application/x-ndjson' : 'text/event-stream', options);
  const result = await callProvider(provider(type), { messages, onText: async value => { deltas.push(value); await options.onText?.(value); }, fetchImpl: async () => transport.value, ...options.callOptions });
  return { result, deltas, transport };
}

function responsesFixture() {
  const reasoning = { id: 'reasoning-1', type: 'reasoning', summary: [], encrypted_content: 'final-opaque-state' };
  const message = { id: 'message-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '你好 🌍', annotations: [] }] };
  const call = { id: 'function-1', type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"notes.txt"}', status: 'completed' };
  const final = { id: 'resp-1', status: 'completed', output: [reasoning, message, call], usage: { input_tokens: 7, output_tokens: 12 } };
  const events = [
    { type: 'response.created', response: { id: 'resp-1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: 'incomplete-state' } },
    { type: 'response.reasoning_text.delta', item_id: reasoning.id, output_index: 0, delta: 'private reasoning never shown' },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 1, content_index: 0, item_id: message.id, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: message.id, delta: '你好 ' },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: message.id, delta: '🌍' },
    { type: 'response.output_text.done', output_index: 1, content_index: 0, item_id: message.id, text: '你好 🌍' },
    { type: 'response.content_part.done', output_index: 1, content_index: 0, item_id: message.id, part: message.content[0] },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.output_item.added', output_index: 2, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, item_id: call.id, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, item_id: call.id, delta: '"notes.txt"}' },
    { type: 'response.function_call_arguments.done', output_index: 2, item_id: call.id, arguments: call.arguments },
    { type: 'response.output_item.done', output_index: 2, item: call },
    { type: 'response.completed', response: final },
  ].map((value, sequence_number) => ({ ...value, sequence_number }));
  return { events, final };
}

function anthropicFixture() {
  return [
    { type: 'message_start', message: { id: 'msg-1', role: 'assistant', content: [], usage: { input_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-state' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'ping' },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '读取中' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { type: 'char_location', start_char_index: 0, end_char_index: 1 } } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"notes.txt"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 21 } },
    { type: 'message_stop' },
  ];
}

test('streaming is boolean, defaults on, and request construction preserves JSON without a callback', () => {
  for (const value of [null, 'true', 1, {}, []]) assert.throws(() => validateProvider(provider('openai', { streaming: value })), { code: 'INVALID_PROVIDER' });
  assert.equal(validateProvider(provider()).streaming, true);
  for (const type of ['openai', 'responses', 'anthropic', 'ollama']) {
    assert.equal(JSON.parse(buildRequest(provider(type), { messages }).body).stream, false);
    assert.equal(JSON.parse(buildRequest(provider(type), { messages, onText() {} }).body).stream, true);
    assert.equal(JSON.parse(buildRequest(provider(type), { messages, stream: true }).body).stream, true);
    assert.equal(JSON.parse(buildRequest(provider(type, { streaming: false }), { messages, onText() {} }).body).stream, false);
  }
  assert.deepEqual(JSON.parse(buildRequest(provider(), { messages, stream: true }).body).stream_options, { include_usage: true });
});

test('Chat SSE decodes byte-split UTF-8, BOM, CRLF, comments and usage after finish', async () => {
  const source = '\ufeff: heartbeat\r\nid: 1\r\nretry: 1000\r\n' + (
    sse(chat({ role: 'assistant', reasoning_content: 'secret thought', content: '你' })) +
    sse(chat({ content: '好🌍' })) + sse(chat({}, 'stop')) +
    sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }) + sse('[DONE]')
  ).replaceAll('\n', '\r\n');
  const { result, deltas } = await run('openai', parts(source, 1));
  assert.equal(result.content, '你好🌍');
  assert.deepEqual(deltas, ['你', '好🌍']);
  assert.equal(result.wire.message.reasoning_content, 'secret thought');
  assert.equal(result.usage.outputTokens, 4);
});

test('Chat accumulates interleaved indexed calls and returns arguments only after DONE', async () => {
  const source = [
    chat({ role: 'assistant', tool_calls: [
      { index: 1, id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
      { index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } },
    ] }),
    chat({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }, { index: 1, function: { arguments: '"b.txt"}' } }] }),
    chat({}, 'tool_calls'), '[DONE]',
  ].map(value => sse(value)).join('');
  const { result, deltas } = await run('openai', parts(source));
  assert.deepEqual(result.toolCalls.map(call => [call.id, call.args.path]), [['call-1', 'a.txt'], ['call-2', 'b.txt']]);
  assert.deepEqual(deltas, []);
  const body = JSON.parse(buildRequest(provider(), { messages: [{ role: 'assistant', content: result.content, wire: result.wire }] }).body);
  assert.equal(body.messages[1].tool_calls[1].function.arguments, '{"path":"b.txt"}');
});

test('SSE handles bare CR and multiline data fields', async () => {
  const source = 'data: {"choices":\ndata: [{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n' + sse('[DONE]');
  assert.equal((await run('openai', parts(source.replaceAll('\n', '\r'), 2))).result.content, 'OK');
});

test('SSE ignores unknown extension fields and treats field names as case sensitive', async () => {
  const extension = 'vendor-trace: ignored\nDATA: private must not display\nunknown-field\nretry: invalid\nid: ignored\n\n';
  const { result, deltas } = await run('openai', parts(extension + chatText('OK') + extension, 1));
  assert.equal(result.content, 'OK');
  assert.deepEqual(deltas, ['OK']);
});

test('Responses keeps final encrypted reasoning and full function output without revealing reasoning events', async () => {
  const { events, final } = responsesFixture();
  const { result, deltas } = await run('responses', parts(events.map(typed).join(''), 3));
  assert.equal(deltas.join(''), '你好 🌍');
  assert.deepEqual(result.wire.output, final.output);
  assert.deepEqual(result.toolCalls[0], { id: 'call-1', name: 'read_file', args: { path: 'notes.txt' } });
  assert.deepEqual(result.usage, normalizeProviderUsage('responses', final));
});

test('Responses visible text whitelist excludes unknown reasoning-like content even in JSON fallback', () => {
  const result = parseResponse('responses', { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'reasoning_text', text: 'never display' }, { type: 'output_text', text: 'public' }] }] });
  assert.equal(result.content, 'public');
  assert.equal(result.wire.output[0].content[0].text, 'never display');
  const anthropic = parseResponse('anthropic', { content: [{ type: 'output_text', text: 'unverified content type' }, { type: 'text', text: 'public' }] });
  assert.equal(anthropic.content, 'public');
  assert.equal(anthropic.wire.content[0].text, 'unverified content type');
});

test('Responses completed-only compatibility emits visible final text once and preserves opaque output', async () => {
  const response = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Unable to help.' }] }] };
  const { result, deltas } = await run('responses', [typed({ type: 'response.completed', response }) + sse('[DONE]')]);
  assert.deepEqual(deltas, ['Unable to help.']);
  assert.equal(result.content, 'Unable to help.');
});

test('Anthropic reconstructs thinking signature, citations, complete tool JSON and cumulative usage', async () => {
  const { result, deltas } = await run('anthropic', parts(anthropicFixture().map(typed).join(''), 1));
  assert.deepEqual(deltas, ['读取中']);
  assert.deepEqual(result.wire.content[0], { type: 'thinking', thinking: 'private thought', signature: 'signed-state' });
  assert.equal(result.wire.content[1].citations.length, 1);
  assert.equal(result.toolCalls[0].args.path, 'notes.txt');
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 21, totalTokens: 30, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: null });
});

test('Ollama appends complete tool objects and terminal text while preserving private thinking', async () => {
  const source = [
    { message: { role: 'assistant', content: '读', thinking: 'private ' }, done: false },
    { message: { role: 'assistant', content: '', thinking: 'state', tool_calls: [{ function: { index: 0, name: 'read_file', arguments: { path: 'notes.txt' } } }] }, done: false },
    { message: { role: 'assistant', content: '取' }, done: true, done_reason: 'stop', eval_count: 3 },
  ].map(ndjson).join('').trimEnd();
  const { result, deltas } = await run('ollama', parts(source, 1));
  assert.equal(result.content, '读取');
  assert.deepEqual(deltas, ['读', '取']);
  assert.equal(result.wire.message.thinking, 'private state');
  assert.equal(result.toolCalls[0].args.path, 'notes.txt');
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: 3, totalTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null });
});

test('all protocols reject EOF without their global successful terminal', async () => {
  const cases = [
    ['openai', sse(chat({ content: 'partial' })) + sse(chat({}, 'stop'))],
    ['responses', responsesFixture().events.slice(0, -1).map(typed).join('')],
    ['anthropic', anthropicFixture().slice(0, -1).map(typed).join('')],
    ['ollama', ndjson({ message: { role: 'assistant', content: 'partial' }, done: false })],
  ];
  for (const [type, source] of cases) await assert.rejects(run(type, parts(source)), { code: 'MODEL_RESPONSE_INCOMPLETE' });
});

test('SSE requires a blank event delimiter and does not accept a truncated final frame', async () => {
  await assert.rejects(run('openai', [chatText('OK').trimEnd()]), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  await assert.rejects(run('openai', [sse(chat({ content: 'OK' }, 'stop')) + 'data: {']), { code: 'MODEL_RESPONSE_INCOMPLETE' });
});

test('completion closes a never-ending stream promptly, even when cancel itself never settles', async () => {
  const { result, transport } = await run('openai', [chatText('OK')], { open: true, cancelNever: true, callOptions: { timeoutMs: 200 } });
  assert.equal(result.content, 'OK');
  assert.equal(transport.state.cancelled, true);
});

test('already-received data after terminal is validated across current and queued chunks', async () => {
  for (const suffix of ['data: {\n\n', 'data: {', sse('[DONE]'), sse(chat({ content: 'unexpected' }))]) {
    for (const chunks of [[chatText('OK') + suffix], [chatText('OK'), suffix]]) {
      await assert.rejects(run('openai', chunks), error => ['INVALID_PROVIDER_RESPONSE', 'MODEL_RESPONSE_INCOMPLETE'].includes(error.code));
    }
  }
});

test('malformed and incomplete UTF-8 after terminal fail rather than disappearing in decoder state', async () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe4, 0xbd])]) {
    for (const chunks of [[Buffer.concat([Buffer.from(chatText('OK')), bytes])], [chatText('OK'), bytes]]) {
      await assert.rejects(run('openai', chunks), { code: 'INVALID_PROVIDER_RESPONSE' });
    }
  }
});

test('stream errors never leak upstream private text or credentials', async () => {
  for (const type of ['openai', 'responses', 'anthropic', 'ollama']) {
    const error = { type: 'error', error: { message: 'private prompt never-sent-to-network' } };
    const source = type === 'ollama' ? ndjson(error) : sse(error, type === 'openai' ? '' : 'error');
    await assert.rejects(run(type, [source]), value => value.code === 'PROVIDER_STREAM_ERROR' && !value.message.includes('private prompt') && !value.message.includes('never-sent'));
  }
});

test('HTTP errors, JSON fallback and disabled streaming do not trigger an automatic retry', async () => {
  let attempts = 0;
  const deltas = [];
  const result = await callProvider(provider(), { messages, onText: value => deltas.push(value), fetchImpl: async (_url, options) => {
    attempts++;
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'complete JSON' } }] }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(attempts, 1);
  assert.equal(result.content, 'complete JSON');
  assert.deepEqual(deltas, ['complete JSON']);
  await callProvider(provider('openai', { streaming: false }), { messages, onText() {}, fetchImpl: async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, false);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  } });
  await assert.rejects(callProvider(provider(), { messages, onText() {}, fetchImpl: async () => { attempts++; return new Response('secret', { status: 400 }); } }), { code: 'PROVIDER_HTTP_ERROR' });
  assert.equal(attempts, 2);
});

test('onText is awaited in order and callback CoreError is preserved unchanged', async () => {
  const order = [];
  const source = sse(chat({ content: 'a' })) + sse(chat({ content: 'b' }, 'stop')) + sse('[DONE]');
  await run('openai', [source], { onText: async value => { order.push('start:' + value); await delay(3); order.push('end:' + value); } });
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
  const failure = new CoreError('AUDIT_UNAVAILABLE', 'checkpoint failed', 503);
  await assert.rejects(run('openai', [source], { onText: () => { throw failure; } }), error => error === failure);
});

test('timeout and cancellation interrupt hanging readers and hanging text consumers', async () => {
  const controller = new AbortController();
  const transport = response([], 'text/event-stream', { open: true });
  const pending = callProvider(provider(), { messages, onText() {}, signal: controller.signal, fetchImpl: async () => transport.value });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(transport.state.cancelled, true);
  await assert.rejects(run('openai', [], { open: true, callOptions: { timeoutMs: 10 } }), { code: 'PROVIDER_TIMEOUT' });
  await assert.rejects(run('openai', [chatText('OK')], { onText: () => new Promise(() => {}), callOptions: { timeoutMs: 10 } }), { code: 'PROVIDER_TIMEOUT' });
});

test('cancellation inside text callback cannot return completed tool calls', async () => {
  const controller = new AbortController();
  const source = sse(chat({ content: 'x', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, 'tool_calls')) + sse('[DONE]');
  await assert.rejects(run('openai', [source], { onText: () => controller.abort(), callOptions: { signal: controller.signal } }), { code: 'CANCELLED' });
});

test('raw byte and visible content budgets apply across stream chunks', async () => {
  await assert.rejects(run('openai', [':' + 'x'.repeat(1024 * 1024) + '\n', chatText('OK')]), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  await assert.rejects(run('openai', parts(chatText('x'.repeat(256 * 1024 + 1)), 64000)), { code: 'MODEL_OUTPUT_LIMIT' });
  const oversizedHeader = new Response(chatText('OK'), { headers: { 'content-type': 'text/event-stream', 'content-length': String(1024 * 1024 + 1) } });
  await assert.rejects(callProvider(provider(), { messages, onText() {}, fetchImpl: async () => oversizedHeader }), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
});

test('Chat rejects tool identity changes, duplicate ids, excess calls and invalid final arguments', async () => {
  const first = { index: 0, id: 'one', type: 'function', function: { name: 'read_file', arguments: '{}' } };
  const cases = [
    [chat({ tool_calls: [first] }), chat({ tool_calls: [{ index: 0, id: 'different' }] }, 'tool_calls')],
    [chat({ tool_calls: [first, { ...first, index: 1 }] }, 'tool_calls')],
    [chat({ tool_calls: Array.from({ length: 9 }, (_, index) => ({ ...first, index, id: String(index) })) }, 'tool_calls')],
    [chat({ tool_calls: [{ ...first, function: { name: 'read_file', arguments: '{' } }] }, 'tool_calls')],
    [chat({ tool_calls: [{ ...first, function: { name: 'read_file', arguments: '[]' } }] }, 'tool_calls')],
    [chat({ tool_calls: [{ ...first, function: { name: 'read_file', arguments: JSON.stringify({ path: 'x'.repeat(300 * 1024) }) } }] }, 'tool_calls')],
  ];
  for (const events of cases) await assert.rejects(run('openai', [...events, '[DONE]'].map(value => sse(value))), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('output-limit, filter and protocol incomplete terminals never return a partial tool', async () => {
  await assert.rejects(run('openai', [sse(chat({ content: 'partial' }, 'length'))]), { code: 'MODEL_OUTPUT_LIMIT' });
  await assert.rejects(run('openai', [sse(chat({ content: 'partial' }, 'content_filter'))]), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  await assert.rejects(run('responses', [typed({ type: 'response.incomplete', response: { status: 'incomplete', output: [] } })]), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  const anthropic = anthropicFixture().map(value => value.type === 'message_delta' ? { ...value, delta: { stop_reason: 'max_tokens' } } : value);
  await assert.rejects(run('anthropic', [anthropic.map(typed).join('')]), { code: 'MODEL_OUTPUT_LIMIT' });
  await assert.rejects(run('ollama', [ndjson({ message: { role: 'assistant', content: 'partial' }, done: true, done_reason: 'length' })]), { code: 'MODEL_OUTPUT_LIMIT' });
});

test('Anthropic rejects deltas for unopened/closed blocks, mismatched event names and incomplete tools', async () => {
  const events = anthropicFixture();
  await assert.rejects(run('anthropic', [typed(events[0]) + typed(events[2])]), { code: 'INVALID_PROVIDER_RESPONSE' });
  await assert.rejects(run('anthropic', [events.slice(0, 5).map(typed).join('') + typed(events[2])]), { code: 'INVALID_PROVIDER_RESPONSE' });
  await assert.rejects(run('anthropic', [sse(events[0], 'content_block_start')]), { code: 'INVALID_PROVIDER_RESPONSE' });
  await assert.rejects(run('anthropic', [events.filter(value => !(value.type === 'content_block_stop' && value.index === 2)).map(typed).join('')]), error => ['INVALID_PROVIDER_RESPONSE', 'MODEL_RESPONSE_INCOMPLETE'].includes(error.code));
  const malformed = events.map(value => value.type === 'content_block_delta' && value.index === 2 && value.delta.partial_json.includes('notes') ? { ...value, delta: { type: 'input_json_delta', partial_json: 'not-json' } } : value);
  await assert.rejects(run('anthropic', [malformed.map(typed).join('')]), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('Responses rejects unverified visible deltas, open blocks at terminal and altered final text', async () => {
  const { events } = responsesFixture();
  await assert.rejects(run('responses', [typed(events.find(value => value.type === 'response.output_text.delta'))]), { code: 'INVALID_PROVIDER_RESPONSE' });
  await assert.rejects(run('responses', [events.filter(value => value.type !== 'response.content_part.done').map(typed).join('')]), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  const altered = structuredClone(events);
  altered.at(-1).response.output[1].content[0].text = 'different answer';
  await assert.rejects(run('responses', [altered.map(typed).join('')]), { code: 'INVALID_PROVIDER_RESPONSE' });
});

test('abort listeners are released even for consumers that never settle', async () => {
  const controller = new AbortController();
  const waiting = withAbort(new Promise(() => {}), controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await assert.rejects(waiting, { code: 'CANCELLED' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(withAbort(Promise.reject(new Error('discarded upstream rejection')), controller.signal), { code: 'CANCELLED' });
});

test('empty visible blocks preserve exact final newlines without exposing hidden blocks', async () => {
  const events = [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-state' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'public' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  const anthropic = await run('anthropic', parts(events.map(typed).join('')));
  assert.equal(anthropic.result.content, '\npublic\n');
  assert.equal(anthropic.deltas.join(''), anthropic.result.content);
  assert.equal(anthropic.result.wire.content[1].data, 'opaque-state');
  const message = { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }, { type: 'output_text', text: 'public' }, { type: 'refusal', refusal: '' }] };
  const responseEvents = [{ type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } }];
  for (const [content_index, part] of message.content.entries()) responseEvents.push(
    { type: 'response.content_part.added', output_index: 0, item_id: 'msg', content_index, part },
    { type: 'response.content_part.done', output_index: 0, item_id: 'msg', content_index, part },
  );
  responseEvents.push({ type: 'response.output_item.done', output_index: 0, item: message }, { type: 'response.completed', response: { status: 'completed', output: [message] } });
  const responses = await run('responses', parts(responseEvents.map(typed).join('')));
  assert.equal(responses.result.content, '\npublic\n');
  assert.equal(responses.deltas.join(''), responses.result.content);
});

test('ambiguous Chat content/refusal and interleaved Anthropic blocks fail closed', async () => {
  await assert.rejects(run('openai', [sse(chat({ content: 'public', refusal: 'different' }, 'stop')) + sse('[DONE]')]), { code: 'INVALID_PROVIDER_RESPONSE' });
  const start = { type: 'message_start', message: { role: 'assistant', content: [] } };
  const first = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  const second = { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } };
  await assert.rejects(run('anthropic', [[start, first, second].map(typed).join('')]), { code: 'INVALID_PROVIDER_RESPONSE' });
});
