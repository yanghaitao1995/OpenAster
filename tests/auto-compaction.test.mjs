// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { estimateContextTokens, needCompaction, prepareLongContext, MAX_COMPACTION_CALLS } from '../core/auto-compaction.mjs';
import { buildRequest, parseResponse } from '../core/providers.mjs';
import { validateToolArtifact } from '../core/tool-artifacts.mjs';
import { prepareImages } from '../core/image-attachments.mjs';

const provider = (extra = {}) => ({ type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', contextWindowTokens: 8192, maxTokens: 128, ...extra });
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });
const history = () => [user('Original constraints. ' + 'a'.repeat(13000)), assistant('Completed facts. ' + 'b'.repeat(8000)),
  user('Second instruction stays exact.'), assistant('Confirmed.'), user('Latest correction stays exact.')];
const summary = 'Goal: finish the task. Preserve original constraints. Completed facts remain evidence-qualified. Latest correction has priority.';
const sha = text => createHash('sha256').update(text).digest('hex');

function exchange(index, type = 'openai', size = 5000, assistantSize = 0) {
  const id = `call${index}`, args = { path: `file${index}.txt` };
  const publicText = 'Reading. ' + 'p'.repeat(assistantSize);
  const data = type === 'openai' ? { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: publicText, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify(args) } }] } }] }
    : type === 'responses' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: publicText }] }, { type: 'function_call', id: `fc${index}`, call_id: id, name: 'read_file', arguments: JSON.stringify(args), status: 'completed' }] }
      : type === 'anthropic' ? { stop_reason: 'tool_use', content: [{ type: 'text', text: publicText }, { type: 'tool_use', id, name: 'read_file', input: args }] }
        : { done: true, done_reason: 'stop', message: { role: 'assistant', content: publicText, tool_calls: [{ function: { name: 'read_file', arguments: args } }] } };
  const reply = parseResponse(type, data);
  const content = JSON.stringify({ untrusted_data: true, result: { path: args.path, content: 'x'.repeat(size) } });
  const artifact = validateToolArtifact({ id: `artifact${index}`, sessionId: 'session', runId: 'run', stepId: `artifact${index}`,
    callId: reply.toolCalls[0].id, name: 'read_file', path: args.path, isError: false, createdAt: '2026-11-06T00:00:00.000Z',
    content, bytes: Buffer.byteLength(content), sha256: sha(content) });
  return { artifact, messages: [{ role: 'assistant', ...reply }, { role: 'tool', callId: artifact.callId, artifactId: artifact.id, name: artifact.name, content }] };
}

test('short conversations use no summary calls and report an explicitly approximate budget', async () => {
  let calls = 0;
  const messages = [user('Hello')];
  const result = await prepareLongContext(provider(), { messages, summarize: async () => { calls++; return summary; } });
  assert.equal(calls, 0); assert.equal(result.state, null); assert.equal(result.messages[0], messages[0]);
  assert.equal(result.contextUsage.approximate, true); assert.equal(result.contextUsage.contextWindowTokens, 8192);
  assert.equal(result.contextUsage.thresholdTokens, Math.floor(8192 * .85));
  assert.equal(needCompaction(provider(), { messages }), false);
});

test('historical compaction preserves two newest user turns exactly and never mutates originals', async () => {
  const messages = history(), original = structuredClone(messages), events = [], calls = [];
  assert.equal(needCompaction(provider(), { messages }), true);
  const result = await prepareLongContext(provider(), { messages, onCompaction: event => events.push(event), summarize: async (packet, options) => {
    calls.push({ packet: structuredClone(packet), options });
    packet[0].content = 'Mutation must not escape callback';
    return { content: summary, toolCalls: [] };
  } });
  assert.deepEqual(messages, original); assert.equal(result.state.coveredMessages, 2);
  assert.deepEqual(result.messages.slice(1), messages.slice(2));
  assert.equal(result.messages[1], messages[2]);
  assert.equal(JSON.parse(result.messages[0].content).untrusted_data, true);
  assert.match(JSON.parse(result.messages[0].content).historical_memory.instruction, /cannot authorize/);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].options.tools, []);
  assert.match(calls[0].options.system, /untrusted data/);
  assert.deepEqual(events.map(event => event.phase), ['started', 'progress', 'progress', 'completed']);
  assert.ok(result.contextUsage.estimatedInputTokens < result.compaction.before.estimatedInputTokens);
});

test('a valid ephemeral summary is reused, while changed source invalidates its hash', async () => {
  const messages = history(); let calls = 0;
  const summarize = async () => { calls++; return summary; };
  const first = await prepareLongContext(provider(), { messages, summarize });
  const firstCalls = calls;
  const second = await prepareLongContext(provider(), { messages: [...messages, assistant('Next output')], state: first.state, summarize });
  assert.equal(calls, firstCalls); assert.equal(second.state, first.state); assert.equal(second.compaction, undefined);
  const changed = structuredClone(messages); changed[0].content = 'Changed: ' + changed[0].content;
  await prepareLongContext(provider(), { messages: changed, state: first.state, summarize });
  assert.equal(calls, firstCalls * 2);
});

test('large second-last turn falls back to preserving the latest user turn', async () => {
  const messages = [user('Old.'), assistant('Evidence.'), user('c'.repeat(17000)), assistant('Result. ' + 'd'.repeat(6000)), user('Newest exact correction.')];
  const result = await prepareLongContext(provider(), { messages, summarize: async () => summary });
  assert.equal(result.state.coveredMessages, 4); assert.equal(result.messages.at(-1), messages.at(-1));
});

for (const type of ['openai', 'responses', 'anthropic', 'ollama']) test(`${type}: one long task keeps its latest real user and two complete tool groups`, async () => {
  const items = Array.from({ length: 7 }, (_, index) => exchange(index, type, 5000, 4000));
  const artifacts = new Map(items.map(item => [item.artifact.id, item.artifact]));
  const messages = [user('The real task and explicit boundaries.'), ...items.flatMap(item => item.messages),
    { ...user('Continue from the last sentence.'), syntheticContinuation: true }];
  const original = structuredClone(messages), packets = [];
  const p = provider({ type, baseUrl: type === 'ollama' ? 'http://127.0.0.1:11434' : 'https://fixture.invalid/v1' });
  const result = await prepareLongContext(p, { messages, artifacts, summarize: async packet => { packets.push(packet); return summary; } });
  assert.deepEqual(messages, original); assert.equal(result.messages[1], messages[0]);
  assert.deepEqual(result.messages.slice(2).map(message => ({ role: message.role, callId: message.callId, artifactId: message.artifactId })),
    messages.slice(11).map(message => ({ role: message.role, callId: message.callId, artifactId: message.artifactId })));
  for (const message of result.messages.slice(2).filter(message => message.role !== 'tool')) assert.ok(messages.includes(message));
  assert.deepEqual(result.state.pinnedUserIndices, [0]);
  const memory = JSON.parse(result.messages[0].content).historical_memory;
  assert.deepEqual(memory.artifactReferences.map(item => item.artifactId), items.slice(0, 5).map(item => item.artifact.id));
  for (const packet of packets) for (const message of packet) {
    assert.equal(message.role, 'user');
    const records = JSON.parse(message.content).historical_messages;
    if (!records?.some(record => record.role === 'tool')) continue;
    assert.equal(records[0].role, 'assistant');
    assert.equal(records[1].role, 'tool'); assert.equal(records[0].toolCalls[0].id, records[1].callId);
  }
  const body = JSON.parse(buildRequest(p, { messages: result.messages }).body);
  assert.ok(body); assert.ok(result.compaction.calls <= MAX_COMPACTION_CALLS);
});

test('large tool observations become traceable excerpts for summarization, never silent complete claims', async () => {
  const items = [exchange(0, 'openai', 120000), exchange(1, 'openai', 100), exchange(2, 'openai', 100)];
  const artifacts = new Map(items.map(item => [item.artifact.id, item.artifact]));
  const messages = [user('Task'), ...items.flatMap(item => item.messages)];
  let observed;
  await prepareLongContext(provider(), { messages, artifacts, force: true, toolResultMode: 'reference', summarize: async packet => {
    observed = packet.map(message => JSON.parse(message.content).historical_messages).filter(Boolean).flat().find(item => item.role === 'tool');
    return summary;
  } });
  assert.equal(observed.complete, false); assert.equal(observed.sourceBytes, items[0].artifact.bytes);
  assert.equal(observed.readMore.arguments.artifactId, items[0].artifact.id); assert.ok(Buffer.byteLength(observed.content) <= 8192);
  assert.equal(items[0].artifact.content.includes('x'.repeat(120000)), true);
});

test('the estimator excludes image base64 but reserves image tokens, dimensions and non-ASCII text', () => {
  const one = { ...user('Image'), images: [{ data: 'a'.repeat(1000), width: 100, height: 100 }] };
  const largerEncoding = { ...one, images: [{ ...one.images[0], data: 'a'.repeat(100000) }] };
  assert.equal(estimateContextTokens(provider(), { messages: [one] }), estimateContextTokens(provider(), { messages: [largerEncoding] }));
  assert.ok(estimateContextTokens(provider(), { messages: [one] }) >= estimateContextTokens(provider(), { messages: [user('Image')] }) + 4096);
  assert.ok(estimateContextTokens(provider(), { messages: [user('中'.repeat(100))] }) > estimateContextTokens(provider(), { messages: [user('a'.repeat(100))] }));
});

test('unsummarizable newest input fails before making any model calls', async () => {
  let calls = 0;
  await assert.rejects(prepareLongContext(provider(), { messages: [user('x'.repeat(24000))], summarize: async () => { calls++; return summary; } }), { code: 'CONTEXT_COMPACTION_REQUIRED' });
  assert.equal(calls, 0);
});

test('disabled compaction and unpaired tools fail explicitly without summarizing', async () => {
  let calls = 0; const summarize = async () => { calls++; return summary; };
  await assert.rejects(prepareLongContext(provider({ autoCompact: false }), { messages: history(), summarize }), { code: 'CONTEXT_COMPACTION_DISABLED' });
  const item = exchange(1);
  await assert.rejects(prepareLongContext(provider(), { messages: [user('task'), item.messages[0]], summarize }), { code: 'CONTEXT_PROTOCOL_INVALID' });
  await assert.rejects(prepareLongContext(provider(), { messages: [user('task'), item.messages[1]], summarize }), { code: 'CONTEXT_PROTOCOL_INVALID' });
  assert.equal(calls, 0);
});

test('tool calls in a summary response, empty summary and cancellation cannot replace history', async () => {
  const messages = history(), original = structuredClone(messages);
  for (const value of ['', { content: summary, toolCalls: [{ id: 'bad', name: 'run_command', args: {} }] }]) {
    await assert.rejects(prepareLongContext(provider(), { messages, summarize: async () => value }), { code: 'INVALID_COMPACTION_RESPONSE' });
  }
  const controller = new AbortController();
  await assert.rejects(prepareLongContext(provider(), { messages, signal: controller.signal, summarize: async () => { controller.abort(); return summary; } }), { code: 'CANCELLED' });
  assert.deepEqual(messages, original);
});

test('force compresses an eligible prefix once even below the estimated trigger', async () => {
  const messages = [user('x'.repeat(6000)), assistant('Confirmed old result.'), user('Current task.')]; let calls = 0;
  assert.equal(needCompaction(provider(), { messages }), false);
  const result = await prepareLongContext(provider(), { messages, force: true, summarize: async () => { calls++; return summary; } });
  assert.equal(calls, 1); assert.ok(result.compaction.after.estimatedInputTokens < result.compaction.before.estimatedInputTokens);
  await assert.rejects(prepareLongContext(provider(), { messages, state: result.state, force: true, summarize: async () => { calls++; return summary; } }), { code: 'CONTEXT_COMPACTION_REQUIRED' });
  assert.equal(calls, 1);
});

test('summary calls are individually bounded and stop after eight attempts', async () => {
  const messages = Array.from({ length: 12 }, (_, index) => [user(`Old ${index} ` + 'x'.repeat(15000)), assistant('Evidence')]).flat();
  messages.push(user('Keep current task exact.')); let calls = 0;
  await assert.rejects(prepareLongContext(provider(), { messages, summarize: async (packet, options) => {
    calls++; assert.ok(options.estimatedInputTokens + options.maxTokens <= Math.floor(8192 * .85));
    assert.ok(options.requestBytes <= 2 * 1024 * 1024); return summary;
  } }), { code: 'CONTEXT_COMPACTION_CALL_LIMIT' });
  assert.equal(calls, 8);
});

test('one atomic source group larger than the summary window is rejected without truncation', async () => {
  let calls = 0;
  await assert.rejects(prepareLongContext(provider(), { messages: [user('x'.repeat(40000)), assistant('Old'), user('Latest')],
    summarize: async () => { calls++; return summary; } }), { code: 'CONTEXT_COMPACTION_INPUT_TOO_LARGE' });
  assert.equal(calls, 0);
});

test('wire-byte pressure alone triggers bounded compaction, independent of the estimated token window', async () => {
  const p = provider({ contextWindowTokens: 2000000 });
  const messages = Array.from({ length: 10 }, (_, index) => index % 2 ? assistant('b'.repeat(250000)) : user('a'.repeat(250000)));
  messages.push(user('Current'), assistant('Recent evidence'), user('Newest'));
  let calls = 0;
  const result = await prepareLongContext(p, { messages, summarize: async (_, options) => {
    calls++; assert.ok(options.requestBytes <= 2 * 1024 * 1024); return summary;
  } });
  assert.ok(result.compaction.before.estimatedInputTokens + 128 < result.compaction.before.thresholdTokens);
  assert.ok(result.compaction.before.requestBytes > 2 * 1024 * 1024);
  assert.ok(result.contextPlan.requestBytes <= 2 * 1024 * 1024); assert.equal(calls, 2);
});

test('old images are actually delivered to the summary callback and remain unchanged in original history', async () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/image-attachments.json', import.meta.url), 'utf8'));
  const images = prepareImages([fixtures.png_rgb]);
  const messages = [{ ...user('Describe this image for this task.'), images }, assistant('a'.repeat(16000)), user('Current task')];
  const original = structuredClone(messages); let seen = false;
  await prepareLongContext(provider(), { messages, summarize: async packet => {
    const item = packet.find(message => message.images?.length);
    if (item) { seen = true; assert.deepEqual(item.images, images); item.images[0].name = 'changed.png'; }
    return summary;
  } });
  assert.equal(seen, true); assert.deepEqual(messages, original);
});

test('one batch of eight 256 KiB tools fits by changing views without paid summarization or splitting the group', async () => {
  const items = Array.from({ length: 8 }, (_, index) => exchange(index, 'openai', 256 * 1024));
  const combined = { ...items[0].messages[0], toolCalls: items.flatMap(item => item.messages[0].toolCalls), wire: { type: 'openai', message: {
    ...items[0].messages[0].wire.message, tool_calls: items.flatMap(item => item.messages[0].wire.message.tool_calls) } } };
  const artifacts = new Map(items.map(item => [item.artifact.id, item.artifact]));
  const messages = [user('Read these files.'), combined, ...items.map(item => item.messages[1])]; let calls = 0;
  const original = structuredClone(messages);
  const result = await prepareLongContext(provider({ contextWindowTokens: 131072, maxTokens: 16384 }), { messages, artifacts,
    summarize: async () => { calls++; return summary; } });
  assert.equal(calls, 0); assert.equal(result.state, null); assert.equal(result.messages.length, messages.length);
  assert.equal(result.messages[1], combined); assert.deepEqual(messages, original);
  assert.equal(result.contextPlan.requestByteLimit, 2 * 1024 * 1024);
  assert.ok(result.contextPlan.toolResults.every(item => item.mode === 'excerpt'));
  assert.ok(result.contextUsage.estimatedInputTokens + 16384 <= result.contextUsage.thresholdTokens);
});

test('newest read_tool_result pages stay whole even if the context window cannot contain them', async () => {
  const item = exchange(0, 'openai', 30000);
  const name = 'read_tool_result', artifact = { ...item.artifact, name };
  const command = { ...item.messages[0], toolCalls: [{ ...item.messages[0].toolCalls[0], name }], wire: { type: 'openai', message: {
    ...item.messages[0].wire.message, tool_calls: [{ ...item.messages[0].wire.message.tool_calls[0], function: {
      ...item.messages[0].wire.message.tool_calls[0].function, name } }] } } };
  const messages = [user('Read this exact page.'), command, { ...item.messages[1], name }];
  let calls = 0;
  await assert.rejects(prepareLongContext(provider(), { messages, artifacts: new Map([[artifact.id, artifact]]),
    summarize: async () => { calls++; return summary; } }), { code: 'CONTEXT_COMPACTION_REQUIRED' });
  assert.equal(calls, 0); assert.equal(messages[2].content, item.artifact.content);
});

test('a larger summary cannot be accepted as successful compaction', async () => {
  const messages = [user('x'.repeat(6000)), assistant('Fact'), user('Latest task')];
  await assert.rejects(prepareLongContext(provider(), { messages, force: true, summarize: async () => 's'.repeat(12000) }), { code: 'CONTEXT_COMPACTION_INSUFFICIENT' });
});

test('forced overflow recovery first reduces tool views and never restores them on the next request', async () => {
  const item = exchange(0, 'openai', 10000), artifacts = new Map([[item.artifact.id, item.artifact]]);
  const messages = [user('Task'), ...item.messages], events = []; let calls = 0;
  const summarize = async () => { calls++; return summary; };
  const first = await prepareLongContext(provider(), { messages, artifacts, summarize });
  assert.equal(first.contextPlan.toolResults[0].mode, 'full');
  const forced = await prepareLongContext(provider(), { messages, artifacts, summarize, force: true, onCompaction: event => events.push(event) });
  assert.equal(forced.contextPlan.toolResults[0].mode, 'reference'); assert.equal(forced.compaction.calls, 0);
  assert.equal(forced.state.coveredMessages, 0); assert.equal(forced.state.toolResultMode, 'reference');
  assert.equal(calls, 0); assert.deepEqual(events.map(event => event.phase), ['started', 'completed']);
  assert.ok(forced.contextPlan.requestBytes < first.contextPlan.requestBytes);
  const next = await prepareLongContext(provider(), { messages: [...messages, assistant('Continuing')], artifacts, summarize, state: forced.state });
  assert.equal(next.contextPlan.toolResults[0].mode, 'reference'); assert.equal(next.compaction, undefined);
  await assert.rejects(prepareLongContext(provider(), { messages, artifacts, summarize, state: forced.state, force: true }), { code: 'CONTEXT_COMPACTION_REQUIRED' });
  const invalidState = { ...forced.state, toolResultMode: 'unsafe' };
  const fresh = await prepareLongContext(provider(), { messages, artifacts, summarize, state: invalidState });
  assert.equal(fresh.state, null); assert.equal(fresh.contextPlan.toolResults[0].mode, 'full'); assert.equal(calls, 0);
});

test('estimation, summary input and cached-history hashes never evaluate rejected argument getters or toJSON hooks', async () => {
  let getters = 0, jsonHooks = 0;
  const args = Object.defineProperty({ path: 'file0.txt', toJSON() { jsonHooks++; throw new Error('must not execute'); } },
    'includeIgnored', { enumerable: true, get() { getters++; throw new Error('must not execute'); } });
  const item = exchange(0, 'openai', 100);
  const firstAssistant = { role: 'assistant', content: 'Previous public progress. ' + 'f'.repeat(4000),
    toolCalls: [{ ...item.messages[0].toolCalls[0], args }] };
  const messages = [user('x'.repeat(15000)), firstAssistant, item.messages[1], user('Latest exact user instruction')];
  const artifacts = new Map([[item.artifact.id, item.artifact]]);
  const estimate = estimateContextTokens(provider(), { messages });
  assert.ok(Number.isSafeInteger(estimate)); assert.equal(getters, 0); assert.equal(jsonHooks, 0);
  let calls = 0, recordedArguments;
  const summarize = async packet => {
    calls++;
    for (const message of packet) for (const record of JSON.parse(message.content).historical_messages ?? []) {
      if (record.toolCalls?.length) recordedArguments = record.toolCalls[0].args;
    }
    return summary;
  };
  const result = await prepareLongContext(provider(), { messages, artifacts, summarize, force: true, toolResultMode: 'reference' });
  assert.match(recordedArguments.includeIgnored.unavailable_data, /accessor/);
  assert.match(recordedArguments.toJSON.unavailable_data, /non-JSON/);
  assert.equal(getters, 0); assert.equal(jsonHooks, 0);
  const beforeReuse = calls;
  await prepareLongContext(provider(), { messages, artifacts, summarize, state: result.state });
  assert.equal(calls, beforeReuse); assert.equal(getters, 0); assert.equal(jsonHooks, 0);
  assert.equal(firstAssistant.toolCalls[0].args, args);
});

test('estimation does not invoke proxy traps, inherited toJSON hooks or recurse through cycles', () => {
  let invoked = 0;
  const inherited = Object.create({ toJSON() { invoked++; return 'must not execute'; } });
  inherited.path = 'ordinary.txt';
  const proxy = new Proxy({}, { get() { invoked++; throw new Error('must not execute'); }, ownKeys() { invoked++; throw new Error('must not execute'); } });
  const circular = {}; circular.self = circular;
  for (const args of [proxy, inherited, circular]) {
    const count = estimateContextTokens(provider(), { messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read_file', args }] }] });
    assert.ok(Number.isSafeInteger(count));
  }
  assert.equal(invoked, 0);
});

test('state and summarizer response accessors are rejected without evaluating them', async () => {
  let invoked = 0;
  const previousState = Object.defineProperty({}, 'summary', { enumerable: true, get() { invoked++; return 'injected'; } });
  const short = await prepareLongContext(provider(), { messages: [user('Hello')], state: previousState });
  assert.equal(short.state, null); assert.equal(invoked, 0);
  const response = Object.defineProperty({ toolCalls: [] }, 'content', { enumerable: true, get() { invoked++; return summary; } });
  await assert.rejects(prepareLongContext(provider(), { messages: history(), summarize: async () => response }), { code: 'INVALID_COMPACTION_RESPONSE' });
  assert.equal(invoked, 0);
});
