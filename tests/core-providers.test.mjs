import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseResponse, callProvider, testProvider, validateProvider } from '../core/providers.mjs';
import { TOOL_DEFINITIONS } from '../core/runtime.mjs';

const provider = (type, extra = {}) => ({ id: 'provider-1', type, model: 'user-selected-model', baseUrl: type === 'ollama' ? 'http://127.0.0.1:11434' : 'https://example.test/v1', apiKey: 'test-secret', ...extra });
const user = { role: 'user', content: 'Read notes.txt' };
const toolResult = (id = 'call1', name = 'read_file', isError = false) => ({ role: 'tool', callId: id, name, content: '{"untrusted_data":true,"result":"hello"}', isError });
const replyMessage = reply => ({ role: 'assistant', content: reply.content, wire: reply.wire, toolCalls: reply.toolCalls });

test('provider validation requires secure URLs and bounded model/key configuration', () => {
  for (const baseUrl of ['http://example.test/v1', 'file:///etc/passwd', 'https://key@example.test/v1', 'https://example.test/v1?key=x', 'https://example.test/v1#x', 'https://example.test/%2e%2e']) {
    assert.throws(() => validateProvider(provider('openai', { baseUrl })), { code: 'INVALID_PROVIDER_URL' });
  }
  assert.equal(validateProvider(provider('openai', { baseUrl: 'http://127.0.0.1:1234/v1' })).model, 'user-selected-model');
  assert.equal(validateProvider(provider('ollama', { baseUrl: 'http://[::1]:11434' })).type, 'ollama');
  assert.throws(() => validateProvider(provider('openai', { model: '' })), { code: 'INVALID_MODEL' });
  assert.throws(() => validateProvider(provider('openai', { apiKey: 'evil\r\nx:y' })), { code: 'INVALID_API_KEY' });
  assert.throws(() => validateProvider(provider('openai', { maxTokens: 100000 })), { code: 'INVALID_PROVIDER' });
  assert.throws(() => validateProvider(provider('openai', { tokenParameter: '__proto__' })), { code: 'INVALID_PROVIDER' });
});

test('OpenAI chat preserves call ids, serialized arguments and reasoning fields in exact tool roundtrip', () => {
  const message = { role: 'assistant', content: null, reasoning_content: 'provider-specific-field', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } }] };
  const reply = parseResponse('openai', { choices: [{ message, finish_reason: 'tool_calls' }] });
  assert.deepEqual(reply.toolCalls, [{ id: 'call1', name: 'read_file', args: { path: 'notes.txt' } }]);
  const request = buildRequest(provider('openai'), { messages: [user, replyMessage(reply), toolResult()], tools: TOOL_DEFINITIONS, system: 'system' });
  const body = JSON.parse(request.body);
  assert.equal(request.url, 'https://example.test/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer test-secret');
  assert.deepEqual(body.messages[2], message);
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'call1', content: toolResult().content });
  assert.equal(body.tools[0].function.name, 'list_workspace');
  assert.equal(body.max_completion_tokens, 4096);
});

test('OpenAI-compatible legacy token parameter is explicit and configurable', () => {
  const request = buildRequest(provider('openai', { tokenParameter: 'max_tokens', maxTokens: 1024 }), { messages: [user] });
  const body = JSON.parse(request.body);
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.max_completion_tokens, undefined);
});

test('Responses replays reasoning and encrypted state, and matches function_call_output call_id', () => {
  const output = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-reasoning' },
    { type: 'function_call', id: 'fc_1', call_id: 'call1', name: 'read_file', arguments: '{"path":"notes.txt"}', status: 'completed' }
  ];
  const reply = parseResponse('responses', { id: 'resp_1', status: 'completed', output });
  const request = buildRequest(provider('responses'), { messages: [user, replyMessage(reply), toolResult()], tools: TOOL_DEFINITIONS, system: 'system' });
  const body = JSON.parse(request.body);
  assert.deepEqual(body.input.slice(1, 3), output);
  assert.deepEqual(body.input[3], { type: 'function_call_output', call_id: 'call1', output: toolResult().content });
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.equal(body.store, false);
  assert.equal(body.instructions, 'system');
  assert.equal(body.tools[0].name, 'list_workspace');
  assert.equal(body.tools[0].strict, false);
});

test('Anthropic groups all tool results immediately after exact assistant blocks', () => {
  const content = [
    { type: 'text', text: 'I will read files.' },
    { type: 'tool_use', id: 'call1', name: 'read_file', input: { path: 'notes.txt' } },
    { type: 'tool_use', id: 'call2', name: 'read_file', input: { path: 'missing.txt' } }
  ];
  const reply = parseResponse('anthropic', { content, stop_reason: 'tool_use' });
  const request = buildRequest(provider('anthropic'), { messages: [user, replyMessage(reply), toolResult(), toolResult('call2', 'read_file', true)], tools: TOOL_DEFINITIONS, system: 'system' });
  const body = JSON.parse(request.body);
  assert.equal(request.headers['x-api-key'], 'test-secret');
  assert.equal(request.headers.authorization, undefined);
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[1].content, content);
  assert.equal(body.messages[2].role, 'user');
  assert.deepEqual(body.messages[2].content.map(block => [block.type, block.tool_use_id, block.is_error]), [['tool_result', 'call1', false], ['tool_result', 'call2', true]]);
  assert.equal(body.tools[0].input_schema.type, 'object');
});

test('Ollama retains object arguments and emits tool_name without invented wire ids', () => {
  const message = { role: 'assistant', content: '', thinking: 'opaque', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }] };
  const reply = parseResponse('ollama', { message, done: true, done_reason: 'stop' });
  const request = buildRequest(provider('ollama', { baseUrl: 'http://127.0.0.1:11434/api' }), { messages: [user, replyMessage(reply), toolResult(reply.toolCalls[0].id)], tools: TOOL_DEFINITIONS });
  const body = JSON.parse(request.body);
  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  assert.deepEqual(body.messages[2], message);
  assert.deepEqual(body.messages[3], { role: 'tool', tool_name: 'read_file', content: toolResult().content });
  assert.equal(body.stream, false);
});

test('malformed, duplicate, excessive or truncated tool calls fail closed', () => {
  const call = { id: 'same', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } };
  for (const tool_calls of [[call, call], [{ ...call, function: { name: 'read_file', arguments: 'not json' } }], [{ ...call, function: { name: 'read_file', arguments: '[]' } }], Array.from({ length: 9 }, (_, index) => ({ ...call, id: `id${index}` }))]) {
    assert.throws(() => parseResponse('openai', { choices: [{ message: { role: 'assistant', content: '', tool_calls }, finish_reason: 'tool_calls' }] }), { code: 'INVALID_PROVIDER_RESPONSE' });
  }
  assert.throws(() => parseResponse('openai', { choices: [{ message: { role: 'assistant', content: 'cut off' }, finish_reason: 'length' }] }), { code: 'MODEL_OUTPUT_LIMIT' });
  assert.throws(() => parseResponse('responses', { status: 'incomplete', output: [] }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  assert.throws(() => parseResponse('responses', { status: 'in_progress', output: [] }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  assert.throws(() => parseResponse('anthropic', { content: [{ type: 'text', text: 'cut off' }], stop_reason: 'max_tokens' }), { code: 'MODEL_OUTPUT_LIMIT' });
  assert.throws(() => parseResponse('ollama', { done: false, message: { role: 'assistant', content: 'partial' } }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
});

test('bounded transport refuses redirects and never exposes upstream error body or key', async () => {
  let seen;
  await assert.rejects(callProvider(provider('openai'), {
    messages: [user], fetchImpl: async (url, options) => {
      seen = options;
      return new Response('secret response body: test-secret', { status: 401 });
    }
  }), error => error.code === 'PROVIDER_AUTH_FAILED' && !error.message.includes('test-secret') && !error.message.includes('secret response body'));
  assert.equal(seen.redirect, 'error');
  assert.equal(seen.method, 'POST');
});

test('response bound applies to headerless chunked bodies and declared content length', async () => {
  for (const response of [new Response('x'.repeat(1024 * 1024 + 1)), new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } })]) {
    await assert.rejects(callProvider(provider('openai'), { messages: [user], fetchImpl: async () => response }), { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  }
  await assert.rejects(callProvider(provider('openai'), { messages: [user], fetchImpl: async () => new Response('not JSON') }), { code: 'INVALID_PROVIDER_RESPONSE' });
  assert.throws(() => buildRequest(provider('openai'), { messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] }), { code: 'CONTEXT_TOO_LARGE' });
});

test('timeout and user cancellation have distinct typed errors', async () => {
  const blockedFetch = async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  await assert.rejects(callProvider(provider('openai'), { messages: [user], fetchImpl: blockedFetch, timeoutMs: 20 }), { code: 'PROVIDER_TIMEOUT' });
  const controller = new AbortController();
  const pending = callProvider(provider('openai'), { messages: [user], fetchImpl: blockedFetch, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});

test('text test consumes a bounded real model request and demo never fetches', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] })); };
  assert.equal((await testProvider(provider('openai'), { fetchImpl })).ok, true);
  assert.equal((await testProvider({ type: 'demo' }, { fetchImpl })).ok, true);
  assert.equal(requests, 1);
});
