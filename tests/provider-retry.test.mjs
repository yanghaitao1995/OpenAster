// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreError } from '../core/errors.mjs';
import { retryableProviderError, retryProviderRequest, abortableRetryDelay } from '../core/provider-retry.mjs';
import { callProvider } from '../core/providers.mjs';
import { validateTerminal } from '../core/provider-terminal.mjs';

const transient = () => new CoreError('PROVIDER_UNAVAILABLE', 'must not leak arbitrary upstream text', 502);
test('retry classification excludes auth, invalid protocols, output limits and internal failures', () => {
  for (const code of ['PROVIDER_AUTH_FAILED', 'INVALID_PROVIDER_RESPONSE', 'MODEL_OUTPUT_LIMIT', 'MODEL_CONTEXT_LIMIT', 'PROVIDER_STREAM_ERROR', 'INTERNAL_ERROR', 'COMMAND_TIMEOUT', 'CANCELLED']) assert.equal(retryableProviderError(new CoreError(code, 'opaque')), null);
  assert.equal(retryableProviderError(new Error('network?')), null);
  assert.deepEqual(retryableProviderError(transient()), { code: 'PROVIDER_UNAVAILABLE', message: '暂时无法连接模型服务。' });
  for (const providerStatus of [400, 401, 403, 404, 422]) assert.equal(retryableProviderError(Object.assign(new CoreError('PROVIDER_HTTP_ERROR', 'opaque'), { providerStatus })), null);
  for (const providerStatus of [408, 425, 500, 502, 503, 504]) assert.equal(retryableProviderError(Object.assign(new CoreError('PROVIDER_HTTP_ERROR', 'opaque'), { providerStatus })).code, 'PROVIDER_HTTP_ERROR');
});

test('backoff is capped and can continue beyond the model round count without leaking errors', async () => {
  let count = 0, clock = 100000;
  const attempts = [], retries = [], delays = [];
  const result = await retryProviderRequest(async () => { if (++count < 40) throw transient(); return 'OK'; }, {
    baseDelayMs: 10, maxDelayMs: 80, random: () => 1, clock: () => clock,
    onAttempt: value => attempts.push(value), onRetry: value => retries.push(value),
    wait: async ms => { delays.push(ms); clock += ms; },
  });
  assert.equal(result, 'OK'); assert.equal(count, 40); assert.equal(attempts.length, 40); assert.equal(retries.length, 39);
  assert.deepEqual(delays.slice(0, 5), [10, 20, 40, 80, 80]);
  assert.ok(delays.every(ms => ms <= 80 && ms > 0));
  assert.equal(retries.at(-1).retryCount, 39); assert.ok(attempts.at(-1).elapsedMs > 0);
  assert.doesNotMatch(JSON.stringify(retries), /must not leak/);
});

test('retry-after is respected with a bounded maximum and authentication stops once', async () => {
  let calls = 0; const delays = [];
  await retryProviderRequest(async () => { if (++calls === 1) throw Object.assign(new CoreError('PROVIDER_RATE_LIMIT', 'limited'), { retryAfterMs: 900000 }); return 'OK'; }, { wait: async value => delays.push(value) });
  assert.deepEqual(delays, [300000]);
  calls = 0;
  await assert.rejects(retryProviderRequest(async () => { calls++; throw new CoreError('PROVIDER_AUTH_FAILED', 'auth'); }), { code: 'PROVIDER_AUTH_FAILED' });
  assert.equal(calls, 1);
});

test('cancel interrupts a long backoff and never starts another attempt', async () => {
  const controller = new AbortController(); let calls = 0;
  const operation = retryProviderRequest(async () => { calls++; throw transient(); }, { signal: controller.signal, onRetry: () => setTimeout(() => controller.abort(), 10), baseDelayMs: 30000 });
  await assert.rejects(operation, { code: 'CANCELLED' }); assert.equal(calls, 1);
  assert.throws(() => abortableRetryDelay(30000, controller.signal), { code: 'CANCELLED' });
});

test('attempt timeout and manual cancellation terminate a non-cooperative transport promise', async () => {
  let calls = 0, previousSignal;
  const value = await retryProviderRequest(async ({ signal }) => { calls++; if (calls === 1) { previousSignal = signal; return new Promise(() => {}); } return 'OK'; }, { attemptTimeoutMs: 15, baseDelayMs: 1, maxDelayMs: 1 });
  assert.equal(value, 'OK'); assert.equal(calls, 2); assert.equal(previousSignal.aborted, true);
  const controller = new AbortController();
  const promise = retryProviderRequest(async () => new Promise(() => {}), { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { code: 'CANCELLED' });
});

test('provider HTTP contract returns only bounded retry metadata and discards the body', async () => {
  const provider = { type: 'openai', model: 'fixture', baseUrl: 'https://example.test/v1' };
  for (const status of [400, 401, 429, 503]) {
    const error = await callProvider(provider, { messages: [{ role: 'user', content: 'OK' }], fetchImpl: async () => new Response('private response body', { status, headers: { 'retry-after': '900' } }) }).then(() => assert.fail('expected rejection'), value => value);
    assert.equal(error.providerStatus, status); assert.equal(error.retryAfterMs, 300000);
    assert.doesNotMatch(JSON.stringify(error), /private response/);
    assert.equal(Boolean(retryableProviderError(error)), [429, 503].includes(status));
  }
});

test('explicit refusal, output exhaustion and context exhaustion retain distinct codes without retrying', async () => {
  for (const [type, data, code] of [
    ['openai', { choices: [{ finish_reason: 'content_filter' }] }, 'MODEL_RESPONSE_INCOMPLETE'],
    ['responses', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'MODEL_OUTPUT_LIMIT'],
    ['anthropic', { stop_reason: 'model_context_window_exceeded' }, 'MODEL_CONTEXT_LIMIT'],
  ]) {
    let failure;
    try { validateTerminal(type, data); } catch (value) { failure = value; }
    assert.equal(failure.code, code); assert.equal(failure.retryable, false); assert.equal(retryableProviderError(failure), null);
    let calls = 0;
    await assert.rejects(retryProviderRequest(async () => { calls++; validateTerminal(type, data); }, {
      wait: async () => assert.fail('Explicit terminal must not enter backoff'),
      onRetry: () => assert.fail('Explicit terminal must not schedule another request'),
    }), { code });
    assert.equal(calls, 1);
  }
});
