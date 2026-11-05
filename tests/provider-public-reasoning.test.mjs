// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { callProvider, parseResponse, buildRequest } from '../core/providers.mjs';
import { retryProviderRequest } from '../core/provider-retry.mjs';
import { PUBLIC_OUTPUT_BYTES } from '../core/provider-progress.mjs';

const provider = type => ({ type, model: 'fixture', baseUrl: 'https://fixture.invalid/v1' });
const messages = [{ role: 'user', content: 'fixture' }];
const sse = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const chat = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const answer = { role: 'assistant', content: 'OK' };
const json = {
  openai: { choices: [{ message: { ...answer, reasoning_content: 'public explanation', reasoning: 'unknown field', signature: 'opaque' }, finish_reason: 'stop' }] },
  ollama: { message: { ...answer, thinking: 'public explanation' }, done: true, done_reason: 'stop' },
  anthropic: { role: 'assistant', content: [{ type: 'thinking', thinking: 'public explanation', signature: 'opaque' }, { type: 'redacted_thinking', data: 'encrypted' }, { type: 'text', text: 'OK' }], stop_reason: 'end_turn' },
  responses: { status: 'completed', output: [{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'public explanation' }], encrypted_content: 'opaque', content: [{ type: 'reasoning_text', text: 'not a public summary' }] }, { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] },
};

for (const type of Object.keys(json)) test(`${type} JSON returns only documented public reasoning and preserves opaque continuation separately`, async () => {
  const visible = [], text = [];
  const result = await callProvider(provider(type), { messages, onText: value => text.push(value), onPublicReasoning: value => visible.push(value), fetchImpl: async () => Response.json(json[type]) });
  assert.equal(result.content, 'OK'); assert.equal(result.publicReasoning, 'public explanation');
  assert.deepEqual(visible, ['public explanation']); assert.deepEqual(text, ['OK']);
  assert.doesNotMatch(visible.join(''), /opaque|encrypted|unknown|not a public/);
  const request = buildRequest(provider(type), { messages: [...messages, { role: 'assistant', content: result.content, toolCalls: [], wire: result.wire }] });
  if (type === 'anthropic' || type === 'responses') assert.match(request.body, /opaque/);
});

function events(type) {
  if (type === 'openai') return [chat({ role: 'assistant', reasoning_content: 'public ' }), chat({ reasoning_content: 'explanation' }), chat({ content: 'OK' }), chat({}, 'stop'), '[DONE]'];
  if (type === 'ollama') return [{ message: { role: 'assistant', thinking: 'public ', content: '' }, done: false }, { message: { role: 'assistant', thinking: 'explanation', content: 'OK' }, done: true, done_reason: 'stop' }];
  if (type === 'anthropic') return [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'public ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'explanation' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'OK' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
  ];
  return [
    { type: 'response.output_item.added', output_index: 0, item: { id: 'r', type: 'reasoning', summary: [], encrypted_content: 'partial-opaque' } },
    { type: 'response.reasoning_summary_part.added', output_index: 0, item_id: 'r', summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'r', summary_index: 0, delta: 'public ' },
    { type: 'response.reasoning_text.delta', output_index: 0, item_id: 'r', content_index: 0, delta: 'not a public summary' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'r', summary_index: 0, delta: 'explanation' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, item_id: 'r', summary_index: 0, text: 'public explanation' },
    { type: 'response.reasoning_summary_part.done', output_index: 0, item_id: 'r', summary_index: 0, part: { type: 'summary_text', text: 'public explanation' } },
    { type: 'response.output_item.done', output_index: 0, item: json.responses.output[0] },
    { type: 'response.completed', response: json.responses },
  ];
}

for (const type of Object.keys(json)) test(`${type} streaming public explanation is separate and matches the terminal`, async () => {
  const source = events(type).map(value => type === 'ollama' ? `${JSON.stringify(value)}\n` : sse(value)).join('');
  const reasoning = [], body = [];
  const result = await callProvider(provider(type), { messages, onText: value => body.push(value), onPublicReasoning: value => reasoning.push(value), fetchImpl: async () => new Response(source, { headers: { 'content-type': type === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' } }) });
  assert.equal(body.join(''), 'OK'); assert.equal(reasoning.join(''), 'public explanation'); assert.equal(result.publicReasoning, reasoning.join(''));
  assert.doesNotMatch(reasoning.join(''), /opaque|not a public/);
});

test('Responses summary identity/terminal mismatches and duplicate completion are rejected', async () => {
  for (const change of [
    values => { values[2].item_id = 'other'; },
    values => { values[5].text = 'changed'; },
    values => { values.at(-1).response.output[0].summary[0].text = 'changed'; },
    values => values.splice(6, 0, structuredClone(values[5])),
  ]) {
    const values = structuredClone(events('responses')); change(values);
    await assert.rejects(callProvider(provider('responses'), { messages, onText: () => {}, onPublicReasoning: () => {}, fetchImpl: async () => new Response(values.map(sse).join(''), { headers: { 'content-type': 'text/event-stream' } }) }), { code: 'INVALID_PROVIDER_RESPONSE' });
  }
});

test('reasoning-only response is not accepted as an answer; malformed or oversized public text fails closed', () => {
  assert.throws(() => parseResponse('openai', { choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'only explanation' }, finish_reason: 'stop' }] }));
  for (const value of [{ encrypted_content: 'opaque' }, '\ud800', 'bad\0text', 'x'.repeat(PUBLIC_OUTPUT_BYTES + 1)]) {
    assert.throws(() => parseResponse('openai', { choices: [{ message: { ...answer, reasoning_content: value }, finish_reason: 'stop' }] }));
  }
});

test('truncated thinking stream and explicit incomplete terminal never return an executable tool response', async () => {
  const seen = [];
  await assert.rejects(callProvider(provider('openai'), { messages, onText: () => {}, onPublicReasoning: value => seen.push(value), fetchImpl: async () => new Response(sse(chat({ reasoning_content: 'partial explanation', tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'write_file', arguments: '{' } }] })), { headers: { 'content-type': 'text/event-stream' } }) }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  assert.deepEqual(seen, ['partial explanation']);
  let attempts = 0;
  await assert.rejects(retryProviderRequest(() => { attempts++; return callProvider(provider('responses'), { messages, onText: () => {}, fetchImpl: async () => new Response(sse({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }), { headers: { 'content-type': 'text/event-stream' } }) }); }, { baseDelayMs: 1, maxDelayMs: 1 }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  assert.equal(attempts, 1);
});

for (const type of Object.keys(json)) test(`${type} explicit JSON truncation preserves public partial text without accepting a reply`, async () => {
  const data = structuredClone(json[type]), visible = [], text = [];
  if (type === 'openai') data.choices[0].finish_reason = 'length';
  else if (type === 'ollama') data.done_reason = 'length';
  else if (type === 'anthropic') data.stop_reason = 'max_tokens';
  else { data.status = 'incomplete'; data.incomplete_details = { reason: 'max_output_tokens' }; }
  const error = await callProvider({ ...provider(type), streaming: false }, { messages, onText: value => text.push(value), onPublicReasoning: value => visible.push(value), fetchImpl: async () => Response.json(data) }).then(() => assert.fail('must not accept truncation'), value => value);
  assert.equal(error.code, type === 'responses' ? 'MODEL_RESPONSE_INCOMPLETE' : 'MODEL_OUTPUT_LIMIT');
  assert.deepEqual(text, ['OK']); assert.deepEqual(visible, ['public explanation']);
  assert.doesNotMatch(JSON.stringify(error), /public explanation|opaque|encrypted/);
});
