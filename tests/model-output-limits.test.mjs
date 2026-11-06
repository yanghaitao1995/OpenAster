// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, callProvider, validateProvider } from '../core/providers.mjs';
import { readProviderStream } from '../core/provider-stream.mjs';
import { retryableProviderError } from '../core/provider-retry.mjs';
import { validatePublicOutput } from '../core/provider-progress.mjs';
import { MIN_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, MAX_MODEL_OUTPUT_BYTES, MAX_JSON_RESPONSE_BYTES, MAX_STREAM_RESPONSE_BYTES } from '../core/model-limits.mjs';

const provider = (type = 'openai', extra = {}) => ({ type, model: 'bounded-output-fixture', baseUrl: 'https://fixture.invalid/v1', ...extra });
const messages = [{ role: 'user', content: 'fixture' }];
const answer = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const sse = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const delta = (content, finish_reason = null) => sse({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason }] });
const stream = content => delta(content) + delta('', 'stop') + sse('[DONE]');

test('all adapters honor larger explicit output budgets and preserve existing configured budgets', () => {
  for (const type of ['openai', 'responses', 'anthropic', 'ollama']) {
    assert.equal(validateProvider(provider(type)).maxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
    for (const maxTokens of [MIN_OUTPUT_TOKENS, 4096, 32768, MAX_OUTPUT_TOKENS]) {
      const configured = validateProvider(provider(type, { maxTokens }));
      assert.equal(configured.maxTokens, maxTokens);
      const body = JSON.parse(buildRequest(configured, { messages }).body);
      const sent = type === 'openai' ? body.max_completion_tokens : type === 'responses' ? body.max_output_tokens : type === 'anthropic' ? body.max_tokens : body.options.num_predict;
      assert.equal(sent, maxTokens);
    }
    for (const maxTokens of [MIN_OUTPUT_TOKENS - 1, MAX_OUTPUT_TOKENS + 1, 1024.5, '32768', NaN, Infinity]) {
      assert.throws(() => validateProvider(provider(type, { maxTokens })), { code: 'INVALID_PROVIDER' });
    }
  }
  const legacy = JSON.parse(buildRequest(provider('openai', { maxTokens: 65536, tokenParameter: 'max_tokens' }), { messages }).body);
  assert.equal(legacy.max_tokens, 65536);
  assert.equal(Object.hasOwn(legacy, 'max_completion_tokens'), false);
});

test('long-task settings have explicit bounded defaults, preserve chosen values and stay out of provider payloads', () => {
  const defaults = { contextWindowTokens: 131072, maxModelCalls: 64, maxTools: 256, maxRunMinutes: 60, autoCompact: true, autoContinue: true };
  for (const type of ['demo', 'openai', 'responses', 'anthropic', 'ollama']) {
    const normalized = validateProvider(provider(type));
    for (const [key, value] of Object.entries(defaults)) assert.equal(normalized[key], value);
    const selected = { contextWindowTokens: 32768, maxModelCalls: 12, maxTools: 32, maxRunMinutes: 10, autoCompact: false, autoContinue: false };
    const configured = validateProvider(provider(type, selected));
    for (const [key, value] of Object.entries(selected)) assert.equal(configured[key], value);
    if (type !== 'demo') {
      const body = JSON.parse(buildRequest(configured, { messages }).body);
      for (const key of Object.keys(defaults)) assert.equal(Object.hasOwn(body, key), false);
    }
  }
  for (const [key, min, max] of [['contextWindowTokens', 8192, 2000000], ['maxModelCalls', 1, 512], ['maxTools', 1, 2048], ['maxRunMinutes', 1, 240]]) {
    for (const value of [min, max]) assert.equal(validateProvider(provider('openai', { [key]: value }))[key], value);
    for (const value of [min - 1, max + 1, 1.5, null, String(min), NaN, Infinity]) assert.throws(() => validateProvider(provider('openai', { [key]: value })), { code: 'INVALID_PROVIDER' });
  }
  for (const key of ['autoCompact', 'autoContinue']) for (const value of [null, 0, 1, 'true', 'false']) assert.throws(() => validateProvider(provider('openai', { [key]: value })), { code: 'INVALID_PROVIDER' });
});

test('one MiB of public UTF-8 output survives JSON and streaming without changing its contents', async () => {
  const content = '中'.repeat(Math.floor(MAX_MODEL_OUTPUT_BYTES / 3)) + 'x';
  assert.equal(Buffer.byteLength(content), MAX_MODEL_OUTPUT_BYTES);
  for (const streaming of [false, true]) {
    const received = [];
    const result = await callProvider(provider('openai', { streaming }), { messages, onText: text => received.push(text),
      fetchImpl: async () => streaming ? new Response(stream(content), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(answer(content)) });
    assert.equal(result.content, content);
    assert.equal(received.join(''), content);
  }
  assert.equal(validatePublicOutput(content), content);
  assert.throws(() => validatePublicOutput(content + 'x'), { code: 'MODEL_OUTPUT_LIMIT' });
});

test('SSE protocol overhead above the old one MiB transport cap no longer rejects short replies', async () => {
  const padding = `:${'x'.repeat(2 * 1024 * 1024)}\n\n`;
  const result = await callProvider(provider(), { messages, onText() {}, fetchImpl: async () => new Response(padding + stream('OK'), { headers: { 'content-type': 'text/event-stream' } }) });
  assert.equal(result.content, 'OK');
  const json = { ...answer('OK'), unused: 'x'.repeat(2 * 1024 * 1024) };
  assert.equal((await callProvider(provider(), { messages, fetchImpl: async () => Response.json(json) })).content, 'OK');
});

test('JSON and stream transport bounds remain distinct and enforce declared and chunked limits', async () => {
  for (const [contentType, limit] of [['application/json', MAX_JSON_RESPONSE_BYTES], ['text/event-stream', MAX_STREAM_RESPONSE_BYTES]]) {
    await assert.rejects(callProvider(provider(), { messages, onText() {}, fetchImpl: async () => new Response('{}', { headers: { 'content-type': contentType, 'content-length': String(limit + 1) } }) }), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  }
  const response = new Response('x'.repeat(MAX_JSON_RESPONSE_BYTES + 1));
  await assert.rejects(callProvider(provider(), { messages, fetchImpl: async () => response }), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  const reader = new Response(`:${'x'.repeat(1024)}\n\n${stream('OK')}`).body.getReader();
  try { await assert.rejects(readProviderStream('openai', reader, { maxBytes: 1024 }), { code: 'PROVIDER_RESPONSE_TOO_LARGE' }); }
  finally { await reader.cancel(); reader.releaseLock(); }
});

test('explicit model context exhaustion preserves public text while refusing partial tool data and automatic transport retry', async () => {
  const content = '已收到的部分正文', seen = [];
  const data = { role: 'assistant', stop_reason: 'model_context_window_exceeded', content: [{ type: 'text', text: content }, { type: 'tool_use', id: 'partial', name: 'write_file', input: '{' }] };
  const error = await callProvider(provider('anthropic', { streaming: false }), { messages, onText: value => seen.push(value), fetchImpl: async () => Response.json(data) }).then(() => assert.fail('partial tools must not be accepted'), value => value);
  assert.equal(error.code, 'MODEL_CONTEXT_LIMIT');
  assert.equal(error.retryable, false);
  assert.equal(retryableProviderError(error), null);
  assert.deepEqual(seen, [content]);
  assert.equal(Object.hasOwn(error, 'toolCalls'), false);
});
