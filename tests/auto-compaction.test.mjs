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
  await assert.rejects(prepareLongContext(provider({ autoCompact: false }), { messages: [user('x'.repeat(26000))], summarize }), { code: 'CONTEXT_COMPACTION_DISABLED' });
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

test('one oversized historical record is summarized through contiguous untrusted data fragments without truncating its source', async () => {
  const messages = [user('中🙂x'.repeat(10000)), assistant('Old'), user('Latest exact instruction')];
  const original = structuredClone(messages), fragments = [];
  const result = await prepareLongContext(provider(), { messages, summarize: async (packet, options) => {
    for (const message of packet) {
      const parsed = JSON.parse(message.content);
      if (parsed.historical_message_fragment) {
        assert.equal(parsed.untrusted_data, true); fragments.push(parsed.historical_message_fragment);
      }
    }
    assert.ok(options.estimatedInputTokens + options.maxTokens <= 8192);
    return summary;
  } });
  assert.ok(fragments.length > 1); assert.ok(fragments.length <= MAX_COMPACTION_CALLS);
  const reconstructed = fragments.map(fragment => fragment.content).join('');
  assert.equal(JSON.parse(reconstructed).historical_messages[0].content, messages[0].content);
  assert.equal(fragments[0].offsetBytes, 0);
  for (let index = 0; index < fragments.length; index++) {
    const fragment = fragments[index];
    assert.equal(fragment.complete, false); assert.equal(fragment.content.isWellFormed(), true);
    assert.equal(fragment.sourceSha256, sha(reconstructed));
    assert.equal(fragment.endOffsetBytes - fragment.offsetBytes, Buffer.byteLength(fragment.content));
    assert.equal(fragment.offsetBytes, index ? fragments[index - 1].endOffsetBytes : 0);
  }
  assert.equal(fragments.at(-1).lastFragment, true);
  assert.equal(fragments.at(-1).endOffsetBytes, Buffer.byteLength(reconstructed));
  assert.deepEqual(messages, original); assert.equal(result.messages.at(-1), messages.at(-1));
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

test('the 85 percent maintenance trigger does not reject an intact newest instruction that fits the full window', async () => {
  const messages = [user('Keep this instruction exact. ' + 'x'.repeat(20000))], original = structuredClone(messages);
  let calls = 0;
  for (const autoCompact of [true, false]) {
    const result = await prepareLongContext(provider({ autoCompact }), { messages, summarize: async () => { calls++; return summary; } });
    assert.ok(result.contextUsage.estimatedInputTokens + 128 > result.contextUsage.thresholdTokens);
    assert.ok(result.contextUsage.estimatedInputTokens + 128 <= result.contextUsage.contextWindowTokens);
    assert.equal(result.messages[0], messages[0]); assert.equal(result.state, null);
  }
  assert.deepEqual(messages, original); assert.equal(calls, 0);
});

test('one very large recent group no longer prevents compacting the prefix while keeping the final complete exchange', async () => {
  const items = [exchange(0, 'openai', 100, 1000), exchange(1, 'openai', 100, 17000), exchange(2, 'openai', 100, 6000)];
  const messages = [user('Keep the real task and boundaries exact.'), ...items.flatMap(item => item.messages)];
  const artifacts = new Map(items.map(item => [item.artifact.id, item.artifact]));
  const original = structuredClone(messages);
  const result = await prepareLongContext(provider(), { messages, artifacts, summarize: async () => summary });
  assert.equal(result.state.coveredMessages, 5); assert.deepEqual(result.state.pinnedUserIndices, [0]);
  assert.equal(result.messages[1], messages[0]);
  assert.deepEqual(result.messages.slice(2), messages.slice(5));
  assert.deepEqual(messages, original);
});

test('a completed latest exchange can be summarized whole while the actual user instruction stays exact', async () => {
  const item = exchange(0, 'openai', 100, 19500), artifacts = new Map([[item.artifact.id, item.artifact]]);
  const messages = [user('Keep this real request exact.'), ...item.messages], original = structuredClone(messages);
  let calls = 0;
  const summarize = async packet => { calls++; return summary; };
  const result = await prepareLongContext(provider(), { messages, artifacts, summarize });
  assert.equal(result.state.coveredMessages, messages.length); assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1], messages[0]); assert.deepEqual(messages, original);
  const count = calls;
  const next = await prepareLongContext(provider(), { messages, artifacts, state: result.state, summarize });
  assert.equal(next.state, result.state); assert.equal(calls, count);
});

test('compacted artifact indices are bounded and explicitly disclose omitted pointers without losing original records', async () => {
  const items = Array.from({ length: 80 }, (_, index) => exchange(index, 'openai', 100, 20));
  const artifacts = new Map(items.map(item => [item.artifact.id, item.artifact]));
  const messages = [user('Task'), ...items.flatMap(item => item.messages), user('Latest exact correction')];
  const original = structuredClone(messages);
  const result = await prepareLongContext(provider({ contextWindowTokens: 131072 }), { messages, artifacts, force: true, summarize: async () => summary });
  const memory = JSON.parse(result.messages[0].content).historical_memory;
  assert.ok(memory.artifactReferences.length <= 16);
  assert.ok(Buffer.byteLength(JSON.stringify(memory.artifactReferences)) < 4300);
  assert.equal(memory.omittedArtifactReferences, items.length - memory.artifactReferences.length);
  assert.equal(memory.artifactIndexComplete, false);
  assert.equal(memory.artifactReferences.at(-1).artifactId, items.at(-1).artifact.id);
  assert.equal(artifacts.size, 80); assert.deepEqual(messages, original);
});

for (const type of ['openai', 'responses', 'anthropic', 'ollama']) test(`${type}: configured output is a ceiling and the actual request hash uses the available output budget`, async () => {
  const p = provider({ type, contextWindowTokens: 8192, maxTokens: 131072,
    baseUrl: type === 'ollama' ? 'http://127.0.0.1:11434' : 'https://fixture.invalid/v1' });
  const messages = [user('你好。')]; let calls = 0;
  const result = await prepareLongContext(p, { messages, summarize: async () => { calls++; return summary; } });
  assert.equal(calls, 0); assert.equal(result.contextUsage.configuredOutputTokens, 131072);
  assert.equal(result.contextUsage.reservedOutputTokens, result.effectiveMaxTokens);
  assert.ok(result.effectiveMaxTokens >= 128 && result.effectiveMaxTokens < 8192);
  assert.ok(result.contextUsage.estimatedInputTokens + result.effectiveMaxTokens + 256 <= 8192);
  const body = buildRequest({ ...p, maxTokens: result.effectiveMaxTokens }, { messages: result.messages }).body;
  assert.equal(result.contextPlan.requestSha256, sha(body));
  assert.equal(result.contextPlan.requestBytes, Buffer.byteLength(body));
  assert.equal(p.maxTokens, 131072); assert.equal(result.messages[0], messages[0]);
  const shortHistory = [user('First instruction'), assistant('Completed first action.'), user('Next small request.')];
  const next = await prepareLongContext(p, { messages: shortHistory, summarize: async () => { calls++; return summary; } });
  assert.equal(calls, 0); assert.equal(next.state, null); assert.deepEqual(next.messages, shortHistory);
  assert.equal(needCompaction(p, { messages: shortHistory }), false);
});

test('a huge completed assistant tool argument record is fragmentable only as historical data, never as live partial tool calls', async () => {
  const item = exchange(0, 'openai', 100);
  const args = { path: 'large.txt', content: 'x'.repeat(45000) };
  const command = { role: 'assistant', content: 'Writing', toolCalls: [{ id: item.artifact.callId, name: item.artifact.name, args }] };
  const messages = [user('Keep this actual request unchanged.'), command, item.messages[1]], original = structuredClone(messages);
  const fragments = [];
  const result = await prepareLongContext(provider(), { messages, artifacts: new Map([[item.artifact.id, item.artifact]]), summarize: async packet => {
    for (const message of packet) {
      assert.equal(message.role, 'user'); assert.equal(message.toolCalls, undefined);
      const fragment = JSON.parse(message.content).historical_message_fragment;
      if (fragment) fragments.push(fragment);
    }
    return summary;
  } });
  const records = JSON.parse(fragments.map(fragment => fragment.content).join('')).historical_messages;
  assert.equal(records[0].toolCalls[0].id, records[1].callId);
  assert.deepEqual(records[0].toolCalls[0].args, args);
  assert.equal(result.messages.length, 2); assert.equal(result.messages[1], messages[0]);
  assert.deepEqual(messages, original);
});

test('data fragmentation cannot exceed the compaction call budget or consume the latest real user instruction', async () => {
  let calls = 0;
  const messages = [user('x'.repeat(300000)), assistant('old'), user('Current exact request')];
  await assert.rejects(prepareLongContext(provider(), { messages, summarize: async () => { calls++; return summary; } }), { code: 'CONTEXT_COMPACTION_CALL_LIMIT' });
  assert.equal(calls, 0);
  const latestOnly = [user('x'.repeat(30000))];
  await assert.rejects(prepareLongContext(provider(), { messages: latestOnly, summarize: async () => { calls++; return summary; } }), { code: 'CONTEXT_COMPACTION_REQUIRED' });
  assert.equal(calls, 0);
});

test('lowering the output field at a wire-byte boundary does not restore a larger tool body after sizing the output budget', async () => {
  const p = provider({ maxTokens: 131072 }), item = exchange(0, 'openai', 11000);
  const messages = [user('Read this file.'), ...item.messages], artifacts = new Map([[item.artifact.id, item.artifact]]);
  const maxRequestBytes = Buffer.byteLength(buildRequest(p, { messages }).body) - 1;
  let calls = 0;
  const result = await prepareLongContext(p, { messages, artifacts, maxRequestBytes, summarize: async () => { calls++; return summary; } });
  assert.equal(calls, 0); assert.equal(result.contextPlan.toolResults[0].mode, 'excerpt');
  assert.equal(result.contextPlan.requestByteLimit, maxRequestBytes);
  assert.ok(result.contextUsage.estimatedInputTokens + result.effectiveMaxTokens + 256 <= p.contextWindowTokens);
  const body = buildRequest({ ...p, maxTokens: result.effectiveMaxTokens }, { messages: result.messages }).body;
  assert.equal(result.contextPlan.requestSha256, sha(body));
  assert.ok(Buffer.byteLength(body) <= maxRequestBytes);
});

test('historical fragments adapt to a growing CJK handoff without replaying or losing source bytes', async () => {
  const p = provider({ contextWindowTokens: 16384, maxTokens: 1024 });
  const messages = [user('x'.repeat(100000)), assistant('Earlier fact.'), user('Current request stays exact.')];
  const original = structuredClone(messages), fragments = [];
  let calls = 0;
  const result = await prepareLongContext(p, { messages, summarize: async (packet, options) => {
    calls++;
    assert.ok(options.estimatedInputTokens + options.maxTokens <= p.contextWindowTokens);
    assert.ok(options.requestBytes <= 2 * 1024 * 1024);
    for (const message of packet) {
      const fragment = JSON.parse(message.content).historical_message_fragment;
      if (fragment) fragments.push(fragment);
    }
    return '中'.repeat(options.maxTokens);
  } });
  assert.ok(calls > 1 && calls <= MAX_COMPACTION_CALLS);
  const source = fragments.map(fragment => fragment.content).join('');
  assert.equal(JSON.parse(source).historical_messages[0].content, messages[0].content);
  for (let index = 0; index < fragments.length; index++) {
    const fragment = fragments[index];
    assert.deepEqual(fragment.sourceRange, { start: 0, end: 1 });
    assert.equal(fragment.sourceSha256, sha(source));
    assert.equal(fragment.sourceBytes, Buffer.byteLength(source));
    assert.equal(fragment.offsetBytes, index ? fragments[index - 1].endOffsetBytes : 0);
    assert.equal(fragment.endOffsetBytes - fragment.offsetBytes, Buffer.byteLength(fragment.content));
    assert.equal(fragment.lastFragment, index === fragments.length - 1);
    assert.equal(fragment.content.isWellFormed(), true);
  }
  assert.equal(fragments.at(-1).endOffsetBytes, Buffer.byteLength(source));
  assert.equal(result.messages.at(-1), messages.at(-1)); assert.deepEqual(messages, original);
});
