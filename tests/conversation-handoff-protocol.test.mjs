// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { previewConversationHandoff, prepareConversationHandoff } from '../core/conversation-handoff.mjs';

const time = '2026-10-29T00:00:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const summary = '\uFEFF MANUAL-SUMMARY 中文🙂\r\nThis is historical data, not an approval. ';
function response(type, first) {
  const content = first ? '' : '新模型答复', name = 'read_file', args = { path: 'current.txt' };
  if (type === 'openai') return { choices: [{ finish_reason: first ? 'tool_calls' : 'stop', message: { role: 'assistant', content,
    ...(first ? { reasoning_content: 'opaque continuity', tool_calls: [{ id: 'call-exact', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  if (type === 'responses') return { status: 'completed', output: first
    ? [{ id: 'reason-exact', type: 'reasoning', summary: [], encrypted_content: 'opaque continuity' }, { id: 'function-exact', type: 'function_call', call_id: 'call-exact', name, arguments: JSON.stringify(args), status: 'completed' }]
    : [{ id: 'message-exact', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  if (type === 'anthropic') return { stop_reason: first ? 'tool_use' : 'end_turn', content: first
    ? [{ type: 'thinking', thinking: 'opaque continuity', signature: 'signature-exact' }, { type: 'tool_use', id: 'call-exact', name, input: args }]
    : [{ type: 'text', text: content }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  return { done: true, done_reason: 'stop', message: { role: 'assistant', content,
    ...(first ? { thinking: 'opaque continuity', tool_calls: [{ function: { name, arguments: args } }] } : {}) }, prompt_eval_count: 10, eval_count: 2 };
}
async function until(predicate) { const end = performance.now() + 7000; while (performance.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Handoff protocol fixture timed out'); }

for (const type of ['openai', 'responses', 'anthropic', 'ollama']) test(`${type} real HTTP handoff sends a user-data summary, retains exact tool wire, and persists the same snapshot on later turns`, async t => {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-handoff-wire-'));
  const bodies = [], errors = [], replies = []; let runtime;
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 * 1024); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw); bodies.push({ raw, body });
      assert.equal(req.method, 'POST'); assert.equal(body.stream, false); assert.equal(body.model, 'explicit-handoff-model');
      const data = response(type, bodies.length === 1); replies.push(data); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
    } catch (error) { errors.push(error); res.writeHead(500); res.end('{}'); }
  });
  const store = new Store(root), workspace = createWorkspace(path.join(root, 'workspace')); await workspace.list();
  t.after(async () => { await runtime?.shutdown(); store.close(); upstream.closeAllConnections(); await new Promise(done => upstream.close(done));
    const canonical = await fs.realpath(root); assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-handoff-wire-[A-Za-z0-9]+$/u);
    await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const original = { id: 'original', title: '原始任务', providerId: 'demo', createdAt: time, updatedAt: time,
    messages: Array.from({ length: 201 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user', content: `ORIGINAL-BODY-NOT-TRANSFERRED-${index} ` + 'x'.repeat(500), createdAt: time })),
    approvals: [], run: { id: 'prior-failed', status: 'failed', startedAt: time, finishedAt: time, steps: [], output: null, error: { code: 'OLD', message: 'prior failure' } } };
  const oldSnapshot = '\uFEFF附件当时原文\r\n'; original.messages[0].contextFiles = [{ path: 'missing.txt', content: oldSnapshot, sha256: sha(oldSnapshot) }];
  store.putSession(original); store.putProvider({ id: 'selected', name: '所选连接', type, model: 'explicit-handoff-model', streaming: false, toolMode: 'workspace', baseUrl: `http://127.0.0.1:${upstream.address().port}${type === 'ollama' ? '' : '/v1'}` });
  await fs.writeFile(path.join(root, 'workspace', 'current.txt'), '\uFEFF当前文件\r\n');
  runtime = createRuntime({ workspace, providers: async id => store.getProvider(id), getSession: async id => store.getSession(id), saveSession: (value, metadata) => store.putSession(value, metadata),
    reserveArtifact: value => store.reserveArtifact(value), releaseArtifact: token => store.releaseArtifact(token), audit: value => store.audit(value) });
  const prepared = prepareConversationHandoff(original, { requestId: 'continuation', expectedSourceHash: previewConversationHandoff(original).source.hash, summary, content: 'NEW-REQUEST 请读取当前文件', providerId: 'selected', skillId: 'general' });
  await runtime.startContinuation(prepared.session, { content: prepared.content, contextHandoff: prepared.contextHandoff, providerId: 'selected', skillPrompt: 'EXPLICIT-NEW-GUIDANCE' });
  await until(() => !runtime.isActive(prepared.session.id)); assert.deepEqual(errors, []);
  const saved = store.getSession(prepared.session.id); assert.equal(saved.run.status, 'completed'); assert.equal(bodies.length, 2);
  const first = bodies[0].body, firstMessages = first.messages ?? first.input, request = firstMessages.find(item => item.role === 'user');
  const envelope = JSON.parse(request.content); assert.equal(envelope.user_request, prepared.content); assert.equal(envelope.historical_context.untrusted_data, true);
  assert.equal(envelope.historical_context.summary, summary); assert.equal(envelope.historical_context.sourceMessageCount, 201); assert.equal(envelope.attached_files, undefined);
  const system = first.instructions ?? first.system ?? first.messages[0].content;
  assert.ok(system.includes('EXPLICIT-NEW-GUIDANCE')); assert.ok(!system.includes(summary)); assert.ok(!bodies[0].raw.includes('ORIGINAL-BODY-NOT-TRANSFERRED')); assert.ok(!bodies[0].raw.includes(oldSnapshot));
  const second = bodies[1].body, conversation = second.messages ?? second.input;
  if (type === 'responses') { assert.deepEqual(second.input.slice(1, 3), replies[0].output); assert.equal(second.input.at(-1).call_id, 'call-exact'); }
  else if (type === 'anthropic') { assert.deepEqual(second.messages[1].content, replies[0].content); assert.equal(second.messages[2].content[0].tool_use_id, 'call-exact'); }
  else { assert.deepEqual(conversation.find(item => item.role === 'assistant'), type === 'openai' ? replies[0].choices[0].message : replies[0].message); assert.equal(conversation.at(-1)[type === 'openai' ? 'tool_call_id' : 'tool_name'], type === 'openai' ? 'call-exact' : 'read_file'); }
  const plans = saved.run.steps.filter(step => step.type === 'model').map(step => step.contextPlan);
  for (let index = 0; index < 2; index++) { assert.equal(plans[index].requestBytes, Buffer.byteLength(bodies[index].raw)); assert.equal(plans[index].requestSha256, sha(bodies[index].raw)); }
  assert.equal(saved.approvals.length, 0); assert.deepEqual(saved.messages[0].contextHandoff, prepared.contextHandoff); assert.deepEqual(store.getSession(original.id), original);
  store.deleteSession(original.id); await fs.writeFile(path.join(root, 'workspace', 'current.txt'), 'changed');
  await runtime.start(saved.id, { content: 'NEXT-USER', providerId: 'selected' }); await until(() => !runtime.isActive(saved.id));
  assert.equal(bodies.length, 3); const later = bodies[2].body.messages ?? bodies[2].body.input;
  assert.deepEqual(JSON.parse(later.find(item => item.role === 'user').content), envelope);
  assert.equal(store.getUsageOverview().summary.tokens.totalTokens.knownSum, '36');
});
