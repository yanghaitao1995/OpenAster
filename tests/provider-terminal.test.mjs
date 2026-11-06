import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, callProvider, parseResponse, validateProvider } from '../core/providers.mjs';

const types = ['openai', 'responses', 'anthropic', 'ollama'];
const provider = (type, extra = {}) => ({ type, model: 'local-protocol-fixture', baseUrl: 'http://127.0.0.1:1', ...extra });
const messages = [{ role: 'user', content: 'fixture' }];
const tools = [{ name: 'read_file', description: 'fixture', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const sse = data => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const usage = { inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null };

function fixture(type, withTools = false) {
  const text = '已完成';
  if (type === 'openai') return { choices: [{ finish_reason: withTools ? 'tool_calls' : 'stop', message: { role: 'assistant', content: text, ...(withTools ? { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } }] } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } };
  if (type === 'responses') return { status: 'completed', output: [{ type: 'reasoning', id: 'r-1', summary: [], encrypted_content: 'opaque' }, { type: 'message', id: 'm-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }, ...(withTools ? [{ type: 'function_call', id: 'f-1', call_id: 'call-1', name: 'read_file', arguments: '{"path":"notes.txt"}', status: 'completed' }] : [])], usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17 } };
  if (type === 'anthropic') return { role: 'assistant', stop_reason: withTools ? 'tool_use' : 'end_turn', content: [{ type: 'text', text }, ...(withTools ? [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'notes.txt' } }] : [])], usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  return { message: { role: 'assistant', content: text, ...(withTools ? { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'notes.txt' } } }] } : {}) }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 7 };
}

function terminal(type, data, reason) {
  if (type === 'openai') data.choices[0].finish_reason = reason;
  else if (type === 'responses') data.status = reason;
  else if (type === 'anthropic') data.stop_reason = reason;
  else data.done_reason = reason;
  return data;
}

function stream(type, data) {
  if (type === 'openai') {
    const { message, finish_reason } = data.choices[0];
    const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
    return sse({ choices: [{ index: 0, delta, finish_reason }] }) + (finish_reason == null ? '' : sse({ choices: [], usage: data.usage })) + sse('[DONE]');
  }
  if (type === 'responses') return sse({ type: 'response.completed', response: data });
  if (type === 'anthropic') return [
    { type: 'message_start', message: { role: 'assistant', content: [], usage: data.usage } },
    ...data.content.flatMap((content_block, index) => [{ type: 'content_block_start', index, content_block }, { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: data.stop_reason }, usage: data.usage }, { type: 'message_stop' },
  ].map(sse).join('');
  return `${JSON.stringify(data)}\n`;
}

async function request(type, data, { streaming = false, fallback = false, toolMode, inspect = () => {} } = {}) {
  let attempts = 0;
  const pending = callProvider(provider(type, toolMode === undefined ? {} : { toolMode }), {
    messages, tools, ...(streaming ? { onText() {} } : {}), fetchImpl: async (_url, options) => {
      attempts++;
      inspect(JSON.parse(options.body));
      return new Response(streaming && !fallback ? stream(type, data) : JSON.stringify(data), { headers: { 'content-type': streaming && !fallback ? type === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' : 'application/json' } });
    },
  });
  try { return await pending; }
  finally { assert.equal(attempts, 1, 'protocol or capability failure must not retry the request'); }
}

for (const type of types) {
  test(`${type} successful JSON and stream terminals retain exact calls, wire and usage`, async () => {
    for (const withTools of [false, true]) {
      const data = fixture(type, withTools);
      for (const streaming of [false, true]) {
        const result = await request(type, data, { streaming });
        assert.equal(result.content, '已完成');
        assert.equal(result.toolCalls.length, withTools ? 1 : 0);
        if (withTools) {
          assert.equal(result.toolCalls[0].name, 'read_file');
          assert.deepEqual(result.toolCalls[0].args, { path: 'notes.txt' });
          if (type !== 'ollama') assert.equal(result.toolCalls[0].id, 'call-1');
        }
        const expectedWire = type === 'responses' ? { type, output: data.output } : type === 'anthropic' ? { type, content: data.content } : { type, message: type === 'openai' ? data.choices[0].message : data.message };
        assert.deepEqual(result.wire, expectedWire);
        assert.deepEqual(result.usage, type === 'anthropic' ? { ...usage, cachedInputTokens: 0, cacheWriteInputTokens: 0 } : usage);
      }
    }
  });

  test(`${type} explicit unsuccessful JSON and stream terminals reject text and tools`, async () => {
    const failures = {
      openai: ['content_filter', 'function_call', 'unknown', '', false, 'length'],
      responses: ['failed', 'in_progress', 'queued', 'cancelled', 'incomplete', 'unknown', '', false],
      anthropic: ['pause_turn', 'unknown', '', false, 'max_tokens', 'model_context_window_exceeded'],
      ollama: ['load', 'unload', 'tool_calls', 'unknown', '', false, 'length'],
    }[type];
    for (const reason of failures) for (const withTools of [false, true]) {
      const code = reason === 'model_context_window_exceeded' ? 'MODEL_CONTEXT_LIMIT' : ['length', 'max_tokens'].includes(reason) ? 'MODEL_OUTPUT_LIMIT' : 'MODEL_RESPONSE_INCOMPLETE';
      const data = terminal(type, fixture(type, withTools), reason);
      assert.throws(() => parseResponse(type, data), { code });
      await assert.rejects(request(type, data, { streaming: true }), { code });
    }
  });

  test(`${type} tool calls cannot use missing/null terminals even in complete JSON`, async () => {
    for (const reason of [undefined, null]) {
      const data = terminal(type, fixture(type, true), reason);
      assert.throws(() => parseResponse(type, data), { code: 'MODEL_RESPONSE_INCOMPLETE' });
      await assert.rejects(request(type, data, { streaming: true }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
    }
  });

  test(`${type} full JSON text preserves omitted terminals but rejects explicit null`, () => {
    assert.equal(parseResponse(type, terminal(type, fixture(type), undefined)).content, '已完成');
    assert.throws(() => parseResponse(type, terminal(type, fixture(type), null)), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  });

  test(`${type} none mode omits tools and refuses unsolicited calls for JSON, stream and fallback`, async () => {
    for (const options of [{}, { streaming: true }, { streaming: true, fallback: true }]) {
      const inspect = body => assert.equal(Object.hasOwn(body, 'tools'), false);
      await assert.rejects(request(type, fixture(type, true), { ...options, toolMode: 'none', inspect }), { code: 'TOOLS_DISABLED' });
      assert.equal((await request(type, fixture(type), { ...options, toolMode: 'none', inspect })).content, '已完成');
    }
  });
}

test('explicit tool terminals and text terminals cannot contradict actual tool presence', async () => {
  for (const [type, textReason, toolReason] of [['openai', 'stop', 'tool_calls'], ['anthropic', 'end_turn', 'tool_use']]) {
    for (const data of [terminal(type, fixture(type, true), textReason), terminal(type, fixture(type), toolReason)]) {
      assert.throws(() => parseResponse(type, data), { code: 'MODEL_RESPONSE_INCOMPLETE' });
      await assert.rejects(request(type, data, { streaming: true }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
    }
  }
  for (const reason of ['stop_sequence', 'refusal']) {
    assert.equal(parseResponse('anthropic', terminal('anthropic', fixture('anthropic'), reason)).content, '已完成');
    assert.throws(() => parseResponse('anthropic', terminal('anthropic', fixture('anthropic', true), reason)), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  }
});

test('Responses completed status cannot conceal partial items, errors or incomplete details', async () => {
  for (const withTools of [false, true]) {
    for (const status of ['in_progress', 'incomplete', 'unknown', false, '']) {
      const data = fixture('responses', withTools);
      data.output.at(-1).status = status;
      assert.throws(() => parseResponse('responses', data), { code: 'MODEL_RESPONSE_INCOMPLETE' });
      await assert.rejects(request('responses', data, { streaming: true }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
    }
    const incomplete = { ...fixture('responses', withTools), incomplete_details: { reason: 'max_output_tokens' } };
    assert.throws(() => parseResponse('responses', incomplete), { code: 'MODEL_OUTPUT_LIMIT' });
    await assert.rejects(request('responses', incomplete, { streaming: true }), { code: 'MODEL_OUTPUT_LIMIT' });
    const errored = { ...fixture('responses', withTools), error: { message: 'private token never reveal' } };
    assert.throws(() => parseResponse('responses', errored), error => error.code === 'PROVIDER_RESPONSE_ERROR' && !error.message.includes('private token'));
    await assert.rejects(request('responses', errored, { streaming: true }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  }
  const optionalItemStatus = fixture('responses', true);
  delete optionalItemStatus.output.at(-1).status;
  assert.equal(parseResponse('responses', optionalItemStatus).toolCalls.length, 1);
  assert.equal((await request('responses', optionalItemStatus, { streaming: true })).toolCalls.length, 1);
});

test('Ollama tools require explicit done true while legacy JSON text may omit done', () => {
  for (const done of [false, undefined, null, 1, 'true']) {
    assert.throws(() => parseResponse('ollama', { ...fixture('ollama', true), done }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  }
  assert.equal(parseResponse('ollama', { ...fixture('ollama'), done: undefined }).content, '已完成');
  assert.throws(() => parseResponse('ollama', { ...fixture('ollama'), done: false }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
  assert.throws(() => parseResponse('ollama', { ...fixture('ollama'), done: null }), { code: 'MODEL_RESPONSE_INCOMPLETE' });
});

test('toolMode validation is explicit, defaults workspace and cannot disable demo tools', () => {
  for (const type of [...types, 'demo']) {
    assert.equal(validateProvider(provider(type)).toolMode, 'workspace');
    assert.equal(validateProvider(provider(type, { toolMode: 'workspace' })).toolMode, 'workspace');
    for (const toolMode of [null, false, true, '', 'auto', 0, {}, []]) assert.throws(() => validateProvider(provider(type, { toolMode })), { code: 'INVALID_PROVIDER' });
  }
  assert.throws(() => validateProvider(provider('demo', { toolMode: 'none' })), { code: 'INVALID_PROVIDER' });
  for (const type of types) {
    assert.equal(validateProvider(provider(type, { toolMode: 'none' })).toolMode, 'none');
    assert.equal(Object.hasOwn(JSON.parse(buildRequest(provider(type, { toolMode: 'none' }), { messages, tools: { map() { throw Error('should not inspect disabled tools'); } } }).body), 'tools'), false);
    assert.equal(JSON.parse(buildRequest(provider(type), { messages, tools }).body).tools.length, 1);
  }
});
