// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { CoreError } from '../core/errors.mjs';
import { Store } from '../server/store.mjs';
import { callProvider } from '../core/providers.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = (content = 'done', toolCalls = []) => ({ content, toolCalls });
async function until(check) { for (let i = 0; i < 3000; i++) { if (check()) return; await delay(5); } throw Error('Long task fixture timeout'); }
async function fixture(t, operation, provider = {}, limits = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openaster-long-task-')));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const store = new Store(path.join(root, 'data'));
  store.putProvider({ id: 'p', name: 'Fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', ...provider });
  const session = store.createSession({ providerId: 'p' });
  const runtime = createRuntime({ workspace: createWorkspace(workspace), providers: async id => store.getProvider(id),
    getSession: async id => store.getSession(id), saveSession: async (value, metadata) => store.putSession(value, metadata),
    providerCall: operation, limits: { providerRetryBaseMs: 1, providerRetryMaxMs: 1, streamCheckpointMs: 1, ...limits } });
  t.after(async () => { await runtime.shutdown(); store.close(); assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  return { store, session, runtime, workspace, root, get: () => store.getSession(session.id),
    start: content => runtime.start(session.id, { content }), done: () => until(() => !runtime.isActive(session.id)) };
}

test('default task continues beyond 12 model calls and 32 tools, persisting more than 64 steps', async t => {
  let calls = 0;
  const f = await fixture(t, async () => ++calls <= 35
    ? response('', [{ id: `tool-${calls}`, name: 'list_workspace', args: {} }]) : response());
  await f.start('Inspect repeatedly for the bounded fixture'); await f.done();
  const saved = f.get(); assert.equal(saved.run.status, 'completed'); assert.equal(calls, 36);
  assert.equal(saved.run.steps.length, 71); assert.equal(saved.run.budget.modelCalls, 36); assert.equal(saved.run.budget.toolCalls, 35);
  assert.equal(f.store.getRunHistory(saved.id, saved.run.id).run.steps.length, 71);
});

test('model retries consume a shared finite budget and preserve their partial output', async t => {
  let calls = 0;
  const f = await fixture(t, async (_provider, { onText }) => { calls++; await onText(`partial-${calls}`); throw new CoreError('PROVIDER_UNAVAILABLE', 'fixture', 502); }, { maxModelCalls: 3 });
  await f.start('Test a disconnected provider'); await f.done();
  const saved = f.get(); assert.equal(calls, 3); assert.equal(saved.run.error.code, 'MODEL_CALL_LIMIT');
  assert.equal(saved.run.budget.modelCalls, 3); assert.equal(saved.run.output.content, 'partial-3');
});

test('the last allowed request ends immediately without entering a retry delay', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new CoreError('PROVIDER_UNAVAILABLE', 'fixture', 502); },
    { maxModelCalls: 1 }, { providerRetryBaseMs: 30000, providerRetryMaxMs: 30000 });
  await f.start('Stop when the request budget is used'); await f.done();
  assert.equal(calls, 1); assert.equal(f.get().run.error.code, 'MODEL_CALL_LIMIT');
  assert.equal(f.get().run.steps[0].phase, 'failed'); assert.equal(f.get().run.steps[0].connection.nextRetryAt, null);
});

test('a tool batch exceeding the remaining budget executes none of its calls', async t => {
  const f = await fixture(t, async () => response('', [1, 2].map(i => ({ id: `read-${i}`, name: 'list_workspace', args: {} }))), { maxTools: 1 });
  await f.start('Test a batch'); await f.done();
  const saved = f.get(); assert.equal(saved.run.error.code, 'TOOL_LIMIT'); assert.equal(saved.run.budget.toolCalls, 0);
  assert.equal(saved.run.steps.filter(step => step.type === 'tool').length, 0);
});

test('explicit pure-text output limit safely continues and joins the final answer', async t => {
  let calls = 0, continuation;
  const f = await fixture(t, (provider, options) => callProvider(provider, { ...options, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body); if (++calls === 2) continuation = body.messages;
    return Response.json({ choices: [{ message: { role: 'assistant', content: calls === 1 ? 'alpha ' : 'beta' }, finish_reason: calls === 1 ? 'length' : 'stop' }] });
  } }), { streaming: false });
  await f.start('Write a short answer'); await f.done();
  const saved = f.get(); assert.equal(saved.run.status, 'completed'); assert.equal(calls, 2);
  assert.equal(saved.messages.at(-1).content, 'alpha beta'); assert.equal(saved.run.steps[1].purpose, 'continuation');
  assert.equal(saved.run.budget.modelCalls, 2); assert.equal(continuation.at(-2).content, 'alpha ');
  assert.match(continuation.at(-1).content, /without repeating/);
});

test('an incomplete tool call never gets repaired, executed or auto-continued', async t => {
  let calls = 0;
  const f = await fixture(t, (provider, options) => callProvider(provider, { ...options, fetchImpl: async () => {
    calls++; return Response.json({ choices: [{ message: { role: 'assistant', content: 'partial', tool_calls: [{ id: 'x', type: 'function', function: { name: 'write_file', arguments: '{' } }] }, finish_reason: 'length' }] });
  } }), { streaming: false });
  await f.start('Test truncated tool arguments'); await f.done();
  assert.equal(calls, 1); assert.equal(f.get().run.error.code, 'MODEL_OUTPUT_LIMIT');
  assert.equal(f.get().approvals.length, 0); assert.deepEqual(await fs.readdir(f.workspace), []);
});

test('autoContinue false preserves one interrupted response without another paid request', async t => {
  let calls = 0;
  const f = await fixture(t, async (_provider, { onText }) => { calls++; await onText('partial'); const error = new CoreError('MODEL_OUTPUT_LIMIT', 'fixture', 502); error.continuationSafe = true; throw error; }, { autoContinue: false });
  await f.start('Test explicit opt-out'); await f.done();
  assert.equal(calls, 1); assert.equal(f.get().run.error.code, 'MODEL_OUTPUT_LIMIT'); assert.equal(f.get().run.output.content, 'partial');
});

test('automatic compaction is visible, uses no tools, retains the latest request, and preserves raw history', async t => {
  let summaries = 0, answering;
  const f = await fixture(t, async (provider, options) => {
    if (options.system.includes('compact historical memory')) { summaries++; assert.deepEqual(options.tools, []); assert.equal(provider.streaming, false); assert.equal(provider.toolMode, 'none'); assert.equal(provider.autoContinue, false); return response('Earlier discussion has been summarized; no actions were performed.'); }
    answering = options.messages; return response('final');
  }, { contextWindowTokens: 16384, maxTokens: 1024, toolMode: 'none' });
  const saved = f.get();
  for (let i = 0; i < 8; i++) saved.messages.push({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', content: `${i}:` + 'older facts '.repeat(650), createdAt: new Date().toISOString() });
  const original = structuredClone(saved.messages); f.store.putSession(saved);
  await f.start('LATEST: preserve this exact instruction'); await f.done();
  const after = f.get(); assert.equal(after.run.status, 'completed'); assert.ok(summaries > 0);
  assert.deepEqual(after.messages.slice(0, original.length), original); assert.equal(answering.at(-1).content, 'LATEST: preserve this exact instruction');
  assert.ok(answering.some(message => message.content.includes('automatic_context_compaction')));
  assert.equal(after.run.steps[0].purpose, 'compaction'); assert.equal(after.run.budget.modelCalls, summaries + 1);
  assert.ok(after.run.steps.at(-1).contextUsage.estimatedInputTokens > 0);
});

test('a follow-up after the budget stops receives prior execution facts but no inherited approval', async t => {
  let calls = 0, followup;
  const f = await fixture(t, async (_provider, { messages }) => {
    if (++calls === 1) return response('', [{ id: 'one', name: 'list_workspace', args: {} }]);
    followup = messages; return response('continued');
  }, { maxModelCalls: 1 });
  await f.start('Inspect the workspace'); await f.done(); const firstRun = f.get().run.id;
  assert.equal(f.get().run.error.code, 'MODEL_CALL_LIMIT');
  await f.start('Continue unfinished work'); await f.done();
  const prior = followup.find(message => message.content.includes('untrusted_prior_run'));
  assert.ok(prior); assert.match(prior.content, /fresh approval/); assert.match(prior.content, new RegExp(firstRun));
  assert.equal(f.get().run.status, 'completed'); assert.notEqual(f.get().run.id, firstRun);
  assert.equal(f.get().run.budget.modelCalls, 1);
});

test('compaction after executed tools persists explicit summary references and finishes through the real store', async t => {
  let responses = 0, summaries = 0;
  const f = await fixture(t, async (_provider, options) => {
    if (options.system.includes('compact historical memory')) { summaries++; return response('Earlier readonly inspections completed. Continue the original task; no new permissions.'); }
    return ++responses <= 7 ? response(`Inspection ${responses}: ` + 'detail '.repeat(1000),
      [{ id: `call-${responses}`, name: 'list_workspace', args: {} }]) : response('Completed synthetic check.');
  }, { contextWindowTokens: 16384, maxTokens: 1024, maxModelCalls: 20 });
  await f.start('Perform readonly inspections, then finish'); await f.done();
  const saved = f.get(); assert.equal(saved.run.status, 'completed'); assert.equal(responses, 8); assert.ok(summaries > 0);
  const tools = saved.run.steps.filter(step => step.type === 'tool'); assert.equal(tools.length, 7);
  const plans = saved.run.steps.filter(step => step.contextPlan?.compaction);
  assert.ok(plans.some(step => step.contextPlan.compaction.artifactIds.length > 0));
  for (const step of plans) {
    const proof = step.contextPlan.compaction;
    assert.ok(saved.run.steps.slice(0, saved.run.steps.indexOf(step)).some(prior => prior.id === proof.summaryStepId && prior.purpose === 'compaction' && prior.status === 'completed'));
    assert.deepEqual([...proof.artifactIds, ...step.contextPlan.toolResults.map(item => item.artifactId)],
      saved.run.steps.slice(0, saved.run.steps.indexOf(step)).filter(prior => prior.toolResultRef).map(prior => prior.toolResultRef.artifactId));
  }
  assert.equal(saved.run.budget.modelCalls, responses + summaries);
  assert.equal(saved.messages.at(-1).content, 'Completed synthetic check.');
  assert.equal(f.store.getRunHistory(saved.id, saved.run.id).run.status, 'completed');
});

test('a fully summarized latest tool group preserves its strict proof and original result through store and backup', async t => {
  let responses = 0, summaries = 0, projected;
  const originalInstruction = 'Inspect once and finish; preserve this exact instruction.';
  const originalOutput = 'The readonly inspection completed. ' + 'detail '.repeat(6000);
  const f = await fixture(t, async (_provider, options) => {
    if (options.system.includes('compact historical memory')) { summaries++; return response('The workspace was inspected once. Keep the original instruction and finish without repeating the action.'); }
    if (++responses === 1) return response(originalOutput, [{ id: 'large-completed-group', name: 'list_workspace', args: {} }]);
    projected = structuredClone(options.messages); return response('Finished without repeating the inspection.');
  }, { contextWindowTokens: 16384, maxTokens: 1024, maxModelCalls: 12, enabled: true });
  await fs.writeFile(path.join(f.workspace, 'fixture.txt'), 'Preserved fixture content.');
  await f.start(originalInstruction); await f.done();
  const saved = f.get(); assert.equal(saved.run.status, 'completed', JSON.stringify(saved.run.error));
  assert.equal(responses, 2); assert.ok(summaries > 0); assert.equal(saved.run.budget.toolCalls, 1);
  assert.equal(projected.length, 2); assert.equal(projected[1].content, originalInstruction);
  assert.equal(JSON.parse(projected[0].content).historical_memory.coveredMessages, 3);
  const tool = saved.run.steps.find(step => step.type === 'tool'), last = saved.run.steps.at(-1);
  assert.deepEqual(last.contextPlan.toolResults, []);
  assert.deepEqual(last.contextPlan.compaction.artifactIds, [tool.toolResultRef.artifactId]);
  const summary = saved.run.steps.find(step => step.id === last.contextPlan.compaction.summaryStepId);
  assert.equal(summary.status, 'completed'); assert.equal(summary.purpose, 'compaction');
  assert.equal(saved.run.steps[0].publicSummary, originalOutput);
  const artifact = f.store.getToolArtifact(saved.id, saved.run.id, tool.toolResultRef.artifactId);
  const record = f.store.getRunHistory(saved.id, saved.run.id);
  const output = path.join(f.root, 'compacted-backup.json'), dataDir = path.join(f.root, 'restored');
  await createBackup({ dataDir: path.join(f.root, 'data'), workspace: f.workspace, output });
  await restoreBackup({ input: output, dataDir });
  const restored = new Store(dataDir);
  try {
    assert.deepEqual(restored.getRunHistory(saved.id, saved.run.id), record);
    assert.deepEqual(restored.getToolArtifact(saved.id, saved.run.id, artifact.id), artifact);
    assert.deepEqual(restored.getSession(saved.id).run.steps.at(-1).contextPlan, last.contextPlan);
    assert.equal(restored.getSession(saved.id).messages[0].content, originalInstruction);
  } finally { restored.close(); }
  assert.equal(await fs.readFile(path.join(dataDir, 'workspace', 'fixture.txt'), 'utf8'), 'Preserved fixture content.');
});

test('large cumulative public output stops with a durable terminal record below the store bound', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return { ...response('', [{ id: `tool-${calls}`, name: 'list_workspace', args: {} }]), publicReasoning: 'x'.repeat(1024 * 1024) };
  });
  await f.start('Exercise a bounded output archive'); await f.done();
  const saved = f.get(); assert.equal(saved.run.status, 'failed'); assert.equal(saved.run.error.code, 'RUN_STORAGE_LIMIT');
  assert.ok(saved.run.finishedAt); assert.ok(calls < 7); assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 8 * 1024 * 1024);
  assert.equal(f.store.getRunHistory(saved.id, saved.run.id).run.status, 'failed');
});

for (const channel of ['onText', 'onPublicReasoning']) test(`escaped streaming ${channel} stops before durable JSON capacity is exhausted`, async t => {
  const delta = '\u0001'.repeat(16 * 1024);
  const f = await fixture(t, async (_provider, callbacks) => {
    for (let i = 0; i < 64; i++) await callbacks[channel](delta);
    return response('unreachable');
  });
  await f.start('Exercise escaped streamed text'); await f.done();
  const saved = f.get(); assert.equal(saved.run.status, 'failed'); assert.equal(saved.run.error.code, 'RUN_STORAGE_LIMIT');
  const output = channel === 'onText' ? saved.run.output.content : saved.run.output.publicReasoning;
  assert.ok(output.length > 0); assert.ok(output.length < 1024 * 1024);
  assert.equal(saved.run.steps[0].phase, 'failed');
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) < 8 * 1024 * 1024);
  assert.equal(f.store.getRunHistory(saved.id, saved.run.id).run.status, 'failed');
});

test('an invalid summary never appears as applied context and never triggers a tool', async t => {
  const f = await fixture(t, async (_provider, { tools }) => { assert.deepEqual(tools, []); return response('x'.repeat(32769)); },
    { contextWindowTokens: 16384, maxTokens: 1024, toolMode: 'none' });
  const saved = f.get();
  for (let i = 0; i < 8; i++) saved.messages.push({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', content: 'older '.repeat(1300), createdAt: new Date().toISOString() });
  f.store.putSession(saved);
  await f.start('Continue'); await f.done();
  const after = f.get(); assert.equal(after.run.error.code, 'INVALID_COMPACTION_RESPONSE');
  assert.equal(after.run.steps[0].status, 'failed'); assert.equal(after.run.steps[0].title, '上下文压缩未完成');
  assert.equal(after.run.budget.modelCalls, 1); assert.equal(after.run.budget.toolCalls, 0);
});

test('cancelling an in-flight compaction preserves original history and starts no answering call', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return new Promise(() => {}); }, { contextWindowTokens: 16384, maxTokens: 1024, toolMode: 'none' });
  const saved = f.get();
  for (let i = 0; i < 8; i++) saved.messages.push({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', content: 'older '.repeat(1300), createdAt: new Date().toISOString() });
  const original = structuredClone(saved.messages); f.store.putSession(saved);
  await f.start('Continue'); await until(() => calls === 1); f.runtime.cancel(f.session.id); await f.done();
  const after = f.get(); assert.equal(after.run.status, 'cancelled'); assert.equal(calls, 1);
  assert.deepEqual(after.messages.slice(0, original.length), original); assert.equal(after.run.steps[0].status, 'cancelled');
});
