// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRequest, measureProviderRequest, parseResponse } from '../core/providers.mjs';
import { planContext, assertToolGroupFits, prepareToolResultPage } from '../core/context-planner.mjs';
import { validateToolArtifact, validateContextPlan } from '../core/tool-artifacts.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const provider = type => ({ id: 'p', type, model: 'fixture', baseUrl: type === 'ollama' ? 'http://127.0.0.1:11434' : 'https://fixture.invalid/v1' });
const user = { role: 'user', content: 'Keep every original user constraint. \ufeff中文🙂\r\n' };
function artifact(id, content, name = 'read_file', callId = id) {
  const raw = JSON.stringify({ untrusted_data: true, result: { path: 'file.txt', content } });
  return validateToolArtifact({ id, sessionId: 's', runId: 'r', stepId: id, callId, name, path: 'file.txt', isError: false,
    createdAt: '2026-10-28T00:00:00.000Z', content: raw, bytes: Buffer.byteLength(raw), sha256: sha(raw) });
}
const tool = value => ({ role: 'tool', name: value.name, callId: value.callId, artifactId: value.id, content: value.content, isError: value.isError });

for (const type of ['openai', 'responses', 'anthropic', 'ollama']) test(`${type} measurement equals the exact send body and planner preserves opaque wire`, () => {
  const p = provider(type), args = { path: 'file.txt' };
  const data = type === 'openai' ? { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', reasoning_content: 'opaque', tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: JSON.stringify(args) } }] } }] }
    : type === 'responses' ? { status: 'completed', output: [{ type: 'reasoning', id: 'reason', summary: [], encrypted_content: 'opaque' }, { type: 'function_call', id: 'fc', call_id: 'call', name: 'read_file', arguments: JSON.stringify(args), status: 'completed' }] }
      : type === 'anthropic' ? { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'opaque', signature: 'signed' }, { type: 'tool_use', id: 'call', name: 'read_file', input: args }] }
        : { done: true, done_reason: 'stop', message: { role: 'assistant', content: '', thinking: 'opaque', tool_calls: [{ function: { name: 'read_file', arguments: args } }] } };
  const reply = parseResponse(type, data), assistant = { role: 'assistant', ...reply };
  const full = artifact('a', '中\r\n"'.repeat(20000), 'read_file', reply.toolCalls[0].id);
  const messages = [user, assistant, tool(full)], original = structuredClone(messages);
  const options = { messages, artifacts: new Map([[full.id, full]]), system: 'policy', stream: true, maxRequestBytes: 32000 };
  const prepared = planContext(p, options), sent = buildRequest(p, { ...options, messages: prepared.messages });
  const measured = measureProviderRequest(p, { ...options, messages: prepared.messages });
  assert.equal(measured.requestBytes, Buffer.byteLength(sent.body)); assert.equal(measured.requestSha256, sha(sent.body));
  assert.equal(prepared.contextPlan.requestSha256, measured.requestSha256); assert.deepEqual(validateContextPlan(prepared.contextPlan), prepared.contextPlan);
  assert.deepEqual(messages, original); assert.equal(prepared.messages[0], user); assert.equal(prepared.messages[1], assistant);
  assert.deepEqual(prepared.messages[1].wire, reply.wire); assert.equal(prepared.messages[2].callId, full.callId);
  assert.equal(prepared.contextPlan.toolResults[0].mode, 'excerpt'); assert.equal(prepared.contextPlan.preservedMessages, 2);
  const view = JSON.parse(prepared.messages[2].content).tool_result_view;
  assert.equal(view.complete, false); assert.equal(view.artifactId, full.id); assert.ok(view.endOffset <= 8192);
  assert.equal(view.content, Buffer.from(full.content).subarray(0, view.endOffset).toString('utf8'));
});

test('exact pressure replaces old tool bodies with explicit references and retains all non-tool messages', () => {
  const first = artifact('first', 'x'.repeat(100000)), second = artifact('second', 'y'.repeat(100000));
  const messages = [user, { role: 'assistant', content: 'first turn' }, tool(first), { role: 'assistant', content: 'second turn' }, tool(second)];
  const prepared = planContext(provider('openai'), { messages, artifacts: new Map([[first.id, first], [second.id, second]]), maxRequestBytes: 12000 });
  assert.deepEqual(prepared.contextPlan.toolResults.map(item => item.mode), ['reference', 'excerpt']);
  assert.ok(prepared.contextPlan.requestBytes <= 12000); assert.equal(prepared.contextPlan.requestByteLimit, 12000);
  assert.deepEqual(prepared.messages.filter(item => item.role !== 'tool'), messages.filter(item => item.role !== 'tool'));
  assert.deepEqual(prepared.contextPlan.toolResults[0].ranges, []);
  assert.equal(JSON.parse(prepared.messages[2].content).tool_result_view.readMore.arguments.offset, 0);
});

test('a single 256 KiB file remains complete under the default request budget', () => {
  const full = artifact('source', 'x'.repeat(256 * 1024));
  const messages = [user, { role: 'assistant', content: 'read the complete file' }, tool(full)];
  const prepared = planContext(provider('openai'), { messages, artifacts: new Map([[full.id, full]]) });
  assert.equal(prepared.messages.at(-1).content, full.content);
  assert.deepEqual(prepared.contextPlan.toolResults, [{ artifactId: full.id, mode: 'full', sourceBytes: full.bytes,
    sentBytes: full.bytes, ranges: [{ start: 0, end: full.bytes }] }]);
  assert.ok(prepared.contextPlan.requestBytes < prepared.contextPlan.requestByteLimit);
});

test('a requested current page stays whole; it cannot recursively become a reference', () => {
  const page = artifact('page', 'x'.repeat(9000), 'read_tool_result');
  const messages = [user, { role: 'assistant', content: 'fetch page' }, tool(page)];
  const options = { messages, artifacts: new Map([[page.id, page]]) };
  const full = planContext(provider('openai'), options); assert.equal(full.messages[2].content, page.content);
  assert.equal(full.contextPlan.toolResults[0].mode, 'full');
  assert.throws(() => planContext(provider('openai'), { ...options, maxRequestBytes: 2000 }), { code: 'CONTEXT_TOO_LARGE' });
  const later = planContext(provider('openai'), { ...options, messages: [...messages, { role: 'assistant', content: 'later turn' }], maxRequestBytes: 2000 });
  assert.equal(later.contextPlan.toolResults[0].mode, 'reference');
});

test('unrepresentable pinned content and tool-group wire fail without mutation or fake plan', () => {
  const messages = [user], original = structuredClone(messages);
  assert.throws(() => planContext(provider('openai'), { messages, maxRequestBytes: 20 }), { code: 'CONTEXT_TOO_LARGE' });
  const assistant = { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'write_file', args: { path: 'file.txt', content: 'new' } }],
    wire: { type: 'openai', message: { role: 'assistant', content: 'x'.repeat(10000) } } };
  assert.throws(() => assertToolGroupFits(provider('openai'), { messages, assistant, maxRequestBytes: 5000 }), { code: 'CONTEXT_TOO_LARGE' });
  assert.deepEqual(messages, original);
  assert.throws(() => planContext(provider('openai'), { messages, maxRequestBytes: 2 * 1024 * 1024 + 1 }), TypeError);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => planContext(provider('openai'), { messages, signal: controller.signal }), { code: 'CANCELLED' });
});

test('small operation receipts remain exact and unarchived results cannot masquerade as evidence', () => {
  const saved = artifact('saved', 'saved fact', 'write_file'), messages = [user, tool(saved)];
  const result = planContext(provider('openai'), { messages, artifacts: new Map([[saved.id, saved]]) });
  assert.equal(result.messages[1].content, saved.content); assert.equal(result.contextPlan.toolResults[0].mode, 'full');
  assert.throws(() => planContext(provider('openai'), { messages }), { code: 'TOOL_ARTIFACT_UNAVAILABLE' });
});

for (const type of ['openai', 'responses', 'anthropic', 'ollama']) test(`${type} group preflight measures the full requested page before earlier writes`, () => {
  const source = artifact('source', 'x'.repeat(20000));
  const artifacts = new Map([[source.id, source]]), messages = [user, { role: 'assistant', content: 'read' }, tool(source)];
  const args = { artifactId: source.id, offset: 0, maxBytes: 8192 };
  const assistant = { role: 'assistant', content: '', toolCalls: [
    { id: 'write', name: 'write_file', args: { path: 'new.txt', content: 'new' } },
    { id: 'page', name: 'read_tool_result', args },
  ] };
  const before = structuredClone(messages);
  assert.throws(() => assertToolGroupFits(provider(type), { messages, assistant, artifacts, maxRequestBytes: 4000 }), { code: 'CONTEXT_TOO_LARGE' });
  assert.doesNotThrow(() => assertToolGroupFits(provider(type), { messages, assistant, artifacts, maxRequestBytes: 24000 }));
  const page = prepareToolResultPage(artifacts, args).result;
  assert.equal(page.content, Buffer.from(source.content).subarray(0, page.endOffset).toString('utf8'));
  assert.deepEqual(messages, before);
});

test('explicit tool-result modes preserve true wire budget and keep the most recent requested page whole', () => {
  const full = artifact('source', 'x'.repeat(50000)), page = artifact('page', 'y'.repeat(9000), 'read_tool_result');
  const messages = [user, { role: 'assistant', content: 'read old source' }, tool(full), { role: 'assistant', content: 'read exact page' }, tool(page)];
  const artifacts = new Map([[full.id, full], [page.id, page]]), original = structuredClone(messages);
  for (const toolResultMode of ['excerpt', 'reference']) {
    const result = planContext(provider('openai'), { messages, artifacts, toolResultMode });
    assert.equal(result.contextPlan.requestByteLimit, 2 * 1024 * 1024);
    assert.equal(result.contextPlan.toolResults[0].mode, toolResultMode);
    assert.equal(result.contextPlan.toolResults[1].mode, 'full'); assert.equal(result.messages.at(-1).content, page.content);
    assert.equal(result.messages[1], messages[1]);
  }
  assert.deepEqual(messages, original);
  assert.throws(() => planContext(provider('openai'), { messages, artifacts, toolResultMode: 'truncate' }), TypeError);
});
