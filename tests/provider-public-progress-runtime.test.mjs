// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../server/store.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { CoreError } from '../core/errors.mjs';
import { callProvider } from '../core/providers.mjs';
import { validateRunHistoryRecord } from '../core/run-history.mjs';
import { validateInterruptedOutputs, INTERRUPTED_OUTPUT_BYTES } from '../core/provider-progress.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 1000; i++) { if (check()) return; await sleep(5); } throw new Error('Public output fixture timed out'); }
async function fixture(t, providerCall, limits = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openaster-public-progress-'));
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  let store = new Store(dataDir);
  store.putProvider({ id: 'p', name: 'Fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true });
  const session = store.createSession({ providerId: 'p' }), snapshots = [];
  const runtime = createRuntime({ workspace: createWorkspace(workspace), providers: async id => store.getProvider(id), getSession: async id => store.getSession(id), saveSession: async (value, metadata) => { store.putSession(value, metadata); snapshots.push(structuredClone(value)); },
    providerCall, limits: { streamCheckpointMs: 1, providerRetryBaseMs: 1, providerRetryMaxMs: 1, ...limits } });
  t.after(async () => { await runtime.shutdown(); store?.close(); assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  return { root, dataDir, workspace, session, runtime, snapshots, get store() { return store; }, get: () => store.getSession(session.id), done: () => until(() => !runtime.isActive(session.id)), close() { store.close(); store = null; }, reopen() { store = new Store(dataDir); } };
}

test('retry preserves distinct partial explanation/body while accepted full pretool text persists through reopen and backup', async t => {
  let calls = 0, secondMessages;
  const longExplanation = '公开解释'.repeat(5000);
  const longBody = '完整进展正文'.repeat(5000);
  const f = await fixture(t, async (_provider, { onText, onPublicReasoning, messages }) => {
    if (++calls === 1) { await onPublicReasoning('第一次的未完成解释'); await onText('第一次的未完成正文'); throw new CoreError('MODEL_RESPONSE_INCOMPLETE', 'fixture', 502); }
    if (calls === 2) {
      secondMessages = structuredClone(messages);
      await onPublicReasoning(longExplanation); await onText(longBody);
      return { content: longBody, publicReasoning: longExplanation, toolCalls: [{ id: 'read1', name: 'list_files', args: {} }], wire: { type: 'openai', message: { signature: 'opaque-never-display' } } };
    }
    return { content: 'OK', publicReasoning: '最后解释', toolCalls: [] };
  });
  await f.runtime.start(f.session.id, { content: 'fixture' }); await f.done();
  const saved = f.get(), step = saved.run.steps[0];
  assert.equal(saved.run.status, 'completed'); assert.equal(saved.messages.at(-1).content, 'OK');
  assert.equal(step.publicSummary, longBody); assert.equal(step.publicSummaryTruncated, undefined); assert.equal(step.publicReasoning, longExplanation);
  assert.deepEqual(step.interruptedOutputs, [{ attempt: 1, content: '第一次的未完成正文', publicReasoning: '第一次的未完成解释' }]);
  assert.doesNotMatch(JSON.stringify(secondMessages), /第一次/); assert.doesNotMatch(JSON.stringify(saved), /opaque-never-display/);
  assert.ok(f.snapshots.some(value => value.run?.steps[0]?.connection?.attempt === 2 && value.run.output === null && value.run.steps[0].publicReasoning === undefined));
  const history = f.store.getRunHistory(f.session.id, saved.run.id); assert.deepEqual(validateRunHistoryRecord(history), history);
  await f.runtime.shutdown(); f.close(); f.reopen(); assert.deepEqual(f.get().run, saved.run); f.close();
  const archive = path.join(f.root, 'backup.json'), restoredDir = path.join(f.root, 'restored');
  await createBackup({ dataDir: f.dataDir, workspace: f.workspace, output: archive }); await restoreBackup({ input: archive, dataDir: restoredDir });
  const restored = new Store(restoredDir);
  try { assert.deepEqual(restored.getSession(f.session.id).run, saved.run); assert.deepEqual(restored.getRunHistory(f.session.id, saved.run.id), history); }
  finally { restored.close(); }
});

test('reasoning-only live output uses narrow projection and cancellation preserves it without inventing an answer', async t => {
  const f = await fixture(t, async (_provider, { onPublicReasoning }) => { await onPublicReasoning('仍在解释'); return new Promise(() => {}); });
  await f.runtime.start(f.session.id, { content: 'fixture' });
  await until(() => f.store.getSessionOutput(f.session.id).run?.output?.publicReasoning === '仍在解释');
  const projected = f.store.getSessionOutput(f.session.id);
  assert.equal(projected.run.output.content, ''); assert.equal(projected.messages, undefined); assert.equal(projected.run.steps, undefined);
  f.runtime.cancel(f.session.id); await f.done();
  const saved = f.get(); assert.equal(saved.run.status, 'cancelled'); assert.equal(saved.run.steps[0].publicReasoning, '仍在解释'); assert.equal(saved.run.output.publicReasoning, '仍在解释'); assert.equal(saved.run.output.status, 'interrupted'); assert.equal(saved.messages.filter(value => value.role === 'assistant').length, 0);
  assert.equal(f.store.getRunHistory(f.session.id, saved.run.id).run.output.publicReasoning, '仍在解释');
});

test('service restart marks current explanation as cancelled and preserves current plus older attempt text', async t => {
  const f = await fixture(t, async () => ({ content: 'OK', toolCalls: [] }));
  const session = f.get(), now = new Date().toISOString();
  session.run = { id: 'interrupted-run', status: 'running', startedAt: now, output: { stepId: 'm', content: 'current body', publicReasoning: 'current explanation', status: 'streaming' }, steps: [{ id: 'm', type: 'model', title: 'model', detail: 'fixture', createdAt: now, status: 'running', phase: 'streaming', publicReasoning: 'current explanation', interruptedOutputs: [{ attempt: 1, content: 'old body', publicReasoning: 'old explanation' }] }] };
  f.store.putSession(session); f.close(); f.reopen();
  const saved = f.get(); assert.equal(saved.run.status, 'cancelled'); assert.equal(saved.run.output.status, 'interrupted'); assert.equal(saved.run.steps[0].phase, 'cancelled'); assert.ok(saved.run.steps[0].finishedAt); assert.equal(saved.run.steps[0].publicReasoning, 'current explanation'); assert.equal(saved.run.steps[0].interruptedOutputs[0].content, 'old body');
});

test('history public fields reject unbounded, injected or malformed records without silently truncating', () => {
  const base = { sessionId: 's', run: { id: 'r', status: 'failed', steps: [{ id: 'm', type: 'model', publicReasoning: 'shown', interruptedOutputs: [{ attempt: 1, content: 'partial' }] }] }, approvals: [] };
  for (const mutate of [record => { record.run.steps[0].publicReasoning = { signature: 'opaque' }; }, record => { record.run.steps[0].interruptedOutputs[0].wire = {}; }, record => { record.run.steps[0].interruptedOutputs[0].attempt = 0; }, record => { record.run.steps[0].publicReasoning = 'x'.repeat(256 * 1024 + 1); }]) {
    const value = structuredClone(base); mutate(value); assert.throws(() => validateRunHistoryRecord(value), { code: 'INVALID_RUN_HISTORY' });
  }
  const values = Array.from({ length: INTERRUPTED_OUTPUT_BYTES / (256 * 1024) + 1 }, (_, i) => ({ attempt: i + 1, content: 'x'.repeat(256 * 1024) }));
  assert.throws(() => validateInterruptedOutputs(values), { code: 'MODEL_OUTPUT_LIMIT' });
});

test('non-streaming incomplete JSON preserves both fields and never retries a token limit', async t => {
  let calls = 0;
  const f = await fixture(t, (provider, options) => callProvider(provider, { ...options, fetchImpl: async (_url, request) => {
    calls++; assert.equal(JSON.parse(request.body).stream, false);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'partial answer', reasoning_content: 'public explanation' }, finish_reason: 'length' }] });
  } }));
  f.store.putProvider({ ...f.store.getProvider('p'), streaming: false });
  await f.runtime.start(f.session.id, { content: 'fixture' }); await f.done();
  const saved = f.get(); assert.equal(calls, 1); assert.equal(saved.run.status, 'failed'); assert.equal(saved.run.error.code, 'MODEL_OUTPUT_LIMIT');
  assert.equal(saved.run.output.content, 'partial answer'); assert.equal(saved.run.output.publicReasoning, 'public explanation'); assert.equal(saved.run.output.status, 'interrupted');
});

test('exhausting interrupted output storage stops explicitly and retains the last draft plus all archived attempts', async t => {
  let calls = 0;
  const f = await fixture(t, async (_provider, { onText }) => {
    calls++; await onText(String(calls).repeat(256 * 1024)); throw new CoreError('MODEL_RESPONSE_INCOMPLETE', 'fixture', 502);
  });
  await f.runtime.start(f.session.id, { content: 'fixture' }); await f.done();
  const saved = f.get(); assert.equal(calls, 9); assert.equal(saved.run.status, 'failed'); assert.equal(saved.run.error.code, 'MODEL_OUTPUT_LIMIT');
  assert.equal(saved.run.steps[0].interruptedOutputs.length, 8); assert.equal(saved.run.output.content, '9'.repeat(256 * 1024)); assert.equal(saved.run.output.status, 'interrupted');
  assert.equal(saved.run.steps[0].interruptedOutputs[0].content, '1'.repeat(256 * 1024));
  assert.equal(saved.messages.filter(value => value.role === 'assistant').length, 0);
});

for (const type of ['openai', 'responses']) for (const complete of [false, true]) {
  test(`${type} ${complete ? 'completed malformed' : 'explicitly truncated'} JSON tool arguments cannot execute or hide valid interrupted public output`, async t => {
    let calls = 0;
    const data = type === 'openai'
      ? { choices: [{ message: { role: 'assistant', content: 'received body', reasoning_content: 'public explanation', tool_calls: [{ id: 'write1', type: 'function', function: { name: 'write_file', arguments: '{' } }] }, finish_reason: complete ? 'tool_calls' : 'length' }] }
      : { status: complete ? 'completed' : 'incomplete', ...(complete ? {} : { incomplete_details: { reason: 'max_output_tokens' } }), output: [
        { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'public explanation' }], encrypted_content: 'opaque-not-displayed' },
        { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'received body' }] },
        { type: 'function_call', id: 'f', call_id: 'write1', name: 'write_file', arguments: '{', status: complete ? 'completed' : 'incomplete' },
      ] };
    const f = await fixture(t, (provider, options) => callProvider(provider, { ...options, fetchImpl: async () => { calls++; return Response.json(data); } }));
    f.store.putProvider({ ...f.store.getProvider('p'), type, streaming: false });
    await f.runtime.start(f.session.id, { content: 'fixture' }); await f.done();
    const saved = f.get();
    assert.equal(calls, 1); assert.equal(saved.run.status, 'failed'); assert.equal(saved.approvals.length, 0);
    assert.equal(saved.run.steps.length, 1); assert.equal(saved.run.steps[0].type, 'model');
    assert.deepEqual(await fs.readdir(f.workspace), []); assert.equal(saved.messages.filter(value => value.role === 'assistant').length, 0);
    assert.equal(saved.run.error.code, complete ? 'INVALID_PROVIDER_RESPONSE' : type === 'openai' ? 'MODEL_OUTPUT_LIMIT' : 'MODEL_RESPONSE_INCOMPLETE');
    if (complete) assert.equal(saved.run.output, null);
    else {
      assert.equal(saved.run.output.content, 'received body'); assert.equal(saved.run.output.publicReasoning, 'public explanation'); assert.equal(saved.run.output.status, 'interrupted');
      assert.equal(saved.run.steps[0].publicReasoning, 'public explanation');
      assert.equal(f.store.getRunHistory(f.session.id, saved.run.id).run.output.content, 'received body');
    }
    assert.doesNotMatch(JSON.stringify(saved), /opaque-not-displayed/);
  });
}
