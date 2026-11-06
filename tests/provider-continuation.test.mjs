// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { callProvider, parseResponse } from '../core/providers.mjs';
import { retryProviderRequest, retryableProviderError } from '../core/provider-retry.mjs';

const provider = (type, extra = {}) => ({ type, model: 'continuation-fixture', baseUrl: 'https://fixture.invalid/v1', ...extra });
const messages = [{ role: 'user', content: 'fixture' }];
const text = '已收到的正文';
const sse = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
function envelope(type, tools = false) {
  if (type === 'openai') return { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: text, ...(tools ? { tool_calls: [{ id: 'partial', type: 'function', function: { name: 'write_file', arguments: '{' } }] } : {}) } }] };
  if (type === 'anthropic') return { role: 'assistant', stop_reason: 'max_tokens', content: [{ type: 'text', text }, ...(tools ? [{ type: 'tool_use', id: 'partial', name: 'write_file', input: '{' }] : [])] };
  if (type === 'responses') return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [
    { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: '公开说明' }], encrypted_content: 'opaque-never-display' },
    { type: 'message', id: 'm', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text }] },
    ...(tools ? [{ type: 'function_call', id: 'f', call_id: 'partial', name: 'write_file', arguments: '{', status: 'incomplete' }] : []),
  ] };
  return { done: true, done_reason: 'length', message: { role: 'assistant', content: text, ...(tools ? { tool_calls: [{ function: { name: 'write_file', arguments: '{' } }] } : {}) } };
}
function source(type, tools = false, complete = true) {
  const data = envelope(type, tools);
  if (type === 'openai') return sse({ choices: [{ index: 0, delta: { ...data.choices[0].message,
    ...(tools ? { tool_calls: data.choices[0].message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) }, finish_reason: 'length' }] }) + (complete ? sse('[DONE]') : '');
  if (type === 'responses') return sse({ type: 'response.incomplete', response: data });
  if (type === 'ollama') return `${JSON.stringify(data)}\n`;
  return [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    ...(tools ? [
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'partial', name: 'write_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{' } },
      { type: 'content_block_stop', index: 1 },
    ] : []),
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    ...(complete ? [{ type: 'message_stop' }] : []),
  ].map(sse).join('');
}
async function failure(type, body, { streaming = true, timeoutMs = 1000, open = false } = {}) {
  const received = [], reasoning = [];
  const response = open ? new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(body)); } }), { headers: { 'content-type': 'text/event-stream' } })
    : new Response(streaming ? body : JSON.stringify(body), { headers: { 'content-type': streaming ? type === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' : 'application/json' } });
  const error = await callProvider(provider(type, { streaming }), { messages, timeoutMs, onText: value => received.push(value), onPublicReasoning: value => reasoning.push(value), fetchImpl: async () => response }).then(() => assert.fail('must not return incomplete reply'), error => error);
  return { error, received: received.join(''), reasoning: reasoning.join('') };
}

for (const type of ['openai', 'responses', 'anthropic', 'ollama']) test(`${type} only explicit tool-free output-limit terminals permit continuation`, async () => {
  for (const tools of [false, true]) for (const streaming of [false, true]) {
    const result = await failure(type, streaming ? source(type, tools) : envelope(type, tools), { streaming });
    assert.equal(result.error.code, 'MODEL_OUTPUT_LIMIT');
    assert.equal(result.error.continuationSafe, tools ? undefined : true);
    assert.equal(retryableProviderError(result.error), null);
    assert.equal(result.received, text);
    assert.equal(Object.hasOwn(result.error, 'toolCalls'), false);
    assert.equal(Object.hasOwn(result.error, 'wire'), false);
    assert.doesNotMatch(JSON.stringify(result.error), /opaque-never-display|write_file/);
    if (type === 'responses') assert.equal(result.reasoning, '公开说明');
  }
});

test('missing global markers cannot authorize continuation or turn a known limit into automatic replay', async () => {
  for (const type of ['openai', 'anthropic']) {
    const result = await failure(type, source(type, false, false));
    assert.equal(result.error.code, 'MODEL_OUTPUT_LIMIT');
    assert.equal(result.error.continuationSafe, undefined);
    assert.equal(retryableProviderError(result.error), null);
  }
  let attempts = 0;
  await assert.rejects(retryProviderRequest(async () => {
    attempts++;
    throw (await failure('openai', source('openai', false, false), { open: true, timeoutMs: 20 })).error;
  }, { baseDelayMs: 1, maxDelayMs: 1 }), error => error.code === 'MODEL_OUTPUT_LIMIT' && error.continuationSafe === undefined);
  assert.equal(attempts, 1);
});

test('malformed trailing data and conflicting terminal state never expose continuation permission', async () => {
  for (const body of [source('openai') + 'data: {', source('openai') + sse('[DONE]'), source('openai') + sse({ choices: [] })]) {
    const { error } = await failure('openai', body);
    assert.equal(error.continuationSafe, undefined);
    assert.equal(retryableProviderError(error), null);
  }
  for (const type of ['responses', 'ollama']) {
    const data = envelope(type);
    if (type === 'responses') data.status = 'completed';
    else data.done = false;
    assert.throws(() => parseResponse(type, data), error => error.code === 'MODEL_OUTPUT_LIMIT' && error.continuationSafe === undefined);
  }
});

test('Responses terminal-only partial text is checked against streamed text and absence of tool evidence', async () => {
  const only = await failure('responses', source('responses'));
  assert.equal(only.received, text);
  assert.equal(only.reasoning, '公开说明');
  const incomplete = envelope('responses');
  const start = [
    { type: 'response.output_item.added', output_index: 1, item: { id: 'm', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', output_index: 1, content_index: 0, item_id: 'm', part: { type: 'output_text', text: 'different' } },
  ].map(sse).join('');
  const mismatch = await failure('responses', start + sse({ type: 'response.incomplete', response: incomplete }));
  assert.equal(mismatch.error.code, 'INVALID_PROVIDER_RESPONSE');
  assert.equal(mismatch.error.continuationSafe, undefined);
  const noOutput = await failure('responses', sse({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }));
  assert.equal(noOutput.error.code, 'MODEL_OUTPUT_LIMIT');
  assert.equal(noOutput.error.continuationSafe, undefined);
});

test('legacy and unrecognized tool-bearing envelopes are never classified as safe continuation', () => {
  const chat = envelope('openai'); chat.choices[0].message.function_call = { name: 'write_file', arguments: '{' };
  const response = envelope('responses'); response.output.push({ type: 'web_search_call', status: 'in_progress' });
  const anthropic = envelope('anthropic'); anthropic.content.push({ type: 'server_tool_use', name: 'unknown' });
  for (const [type, data] of [['openai', chat], ['responses', response], ['anthropic', anthropic]]) {
    assert.throws(() => parseResponse(type, data), error => error.code === 'MODEL_OUTPUT_LIMIT' && error.continuationSafe === undefined);
  }
});
