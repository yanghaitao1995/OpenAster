// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { callProvider } from '../core/providers.mjs';
import { retryProviderRequest } from '../core/provider-retry.mjs';

const provider = { type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' };
const messages = [{ role: 'user', content: 'fixture' }];
const sse = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const chunk = (delta, finish_reason = null) => sse({ choices: [{ index: 0, delta, finish_reason }] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function slowResponse(parts, interval = 25, contentType = 'text/event-stream') {
  let position = 0, timer, cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      return new Promise(resolve => { timer = setTimeout(() => {
        if (!cancelled) { if (position === parts.length) controller.close(); else controller.enqueue(Buffer.from(parts[position++])); }
        resolve();
      }, interval); });
    },
    cancel() { cancelled = true; clearTimeout(timer); },
  });
  return new Response(body, { headers: { 'content-type': contentType } });
}

test('nested retry and transport watchdogs allow continuous generation beyond their timeout interval', async () => {
  let attempts = 0; const explanation = [], text = [], started = performance.now();
  const parts = [': heartbeat\n\n', chunk({ reasoning_content: 'A' }), ': heartbeat\n\n', chunk({ reasoning_content: 'B' }), chunk({ content: 'O' }), chunk({ content: 'K' }), chunk({}, 'stop'), sse('[DONE]')];
  const result = await retryProviderRequest(({ signal, onActivity }) => { attempts++; return callProvider(provider, { messages, signal, onActivity, timeoutMs: 100, onText: value => text.push(value), onPublicReasoning: value => explanation.push(value), fetchImpl: async () => slowResponse(parts) }); }, { attemptTimeoutMs: 100 });
  assert.ok(performance.now() - started > 100); assert.equal(attempts, 1); assert.equal(result.content, 'OK'); assert.equal(text.join(''), 'OK'); assert.equal(explanation.join(''), 'AB');
});

test('slow JSON byte activity refreshes inactivity even before a complete text exists', async () => {
  const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] });
  const parts = body.match(/.{1,15}/g), started = performance.now();
  const result = await callProvider(provider, { messages, timeoutMs: 100, fetchImpl: async () => slowResponse(parts, 25, 'application/json') });
  assert.equal(result.content, 'OK'); assert.ok(performance.now() - started > 100);
});

test('connection and stalled stream have bounded inactivity; cancellation remains immediate', async () => {
  const started = performance.now();
  await assert.rejects(callProvider(provider, { messages, connectionTimeoutMs: 30, fetchImpl: async () => new Promise(() => {}) }), { code: 'PROVIDER_TIMEOUT' });
  assert.ok(performance.now() - started < 1000);
  let cancelled = false, signal;
  const partial = [];
  await assert.rejects(callProvider(provider, { messages, idleTimeoutMs: 30, onText: value => partial.push(value), fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(chunk({ content: 'partial' }))); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  } }), { code: 'PROVIDER_TIMEOUT' });
  assert.deepEqual(partial, ['partial']); assert.equal(cancelled, true); assert.equal(signal.aborted, true);
  const controller = new AbortController();
  const promise = callProvider(provider, { messages, signal: controller.signal, fetchImpl: async () => new Promise(() => {}) });
  await delay(5); controller.abort(); await assert.rejects(promise, { code: 'CANCELLED' });
});
