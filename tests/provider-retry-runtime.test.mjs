// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { CoreError } from '../core/errors.mjs';

const reply = (content = 'OK', toolCalls = []) => ({ content, toolCalls });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let index = 0; index < 3000; index++) { if (check()) return; await delay(5); } throw new Error('Retry runtime did not reach expected state'); }
async function fixture(t, { providerCall, save, limits = {} }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openaster-retry-'));
  const sessions = new Map([['s', { id: 's', title: '新任务', messages: [], approvals: [] }]]), events = [], snapshots = [];
  const runtime = createRuntime({ workspace: createWorkspace(directory), providers: async () => ({ id: 'p', type: 'openai', model: 'fixture', baseUrl: 'https://example.test/v1' }),
    getSession: async id => structuredClone(sessions.get(id)), saveSession: async value => { await save?.(value); const copy = structuredClone(value); sessions.set(value.id, copy); snapshots.push(copy); }, emit: event => events.push(event), providerCall,
    limits: { providerRetryBaseMs: 1, providerRetryMaxMs: 1, providerAttemptTimeoutMs: 200, streamCheckpointMs: 1, ...limits } });
  t.after(async () => { await runtime.shutdown(); assert.equal(path.dirname(directory), os.tmpdir()); await fs.rm(directory, { recursive: true, force: true }); });
  return { runtime, get: () => sessions.get('s'), done: () => until(() => !runtime.isActive('s')), directory, snapshots, events };
}

test('partial response is isolated per attempt and retry state is durable before reconnecting', async t => {
  let calls = 0, secondHistory;
  const f = await fixture(t, { providerCall: async (_provider, { onText, messages }) => {
    if (++calls === 1) { await onText('UNFINISHED'); throw new CoreError('MODEL_RESPONSE_INCOMPLETE', 'incomplete', 502); }
    secondHistory = structuredClone(messages); await onText('OK'); return reply();
  } });
  await f.runtime.start('s', { content: 'Say OK' }); await f.done();
  assert.equal(calls, 2); assert.equal(f.get().run.status, 'completed'); assert.equal(f.get().run.steps.length, 1);
  const step = f.get().run.steps[0]; assert.equal(step.connection.attempt, 2); assert.equal(step.connection.retryCount, 1); assert.ok(step.finishedAt);
  assert.ok(f.snapshots.some(value => value.run?.steps[0]?.phase === 'retrying' && value.run.output?.status === 'interrupted'));
  assert.ok(f.events.some(value => value.type === 'provider.retry'));
  assert.doesNotMatch(JSON.stringify(secondHistory), /UNFINISHED/); assert.equal(f.get().messages.at(-1).content, 'OK');
});

test('network retries after a committed write never execute the write or approval twice', async t => {
  let calls = 0, receivedResult;
  const f = await fixture(t, { providerCall: async (_provider, { messages }) => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'write1', name: 'write_file', args: { path: 'one.txt', content: 'one' } }]);
    receivedResult = messages.at(-1);
    if (calls < 5) throw new CoreError('PROVIDER_UNAVAILABLE', 'connection failed', 502);
    return reply('Saved once');
  } });
  await f.runtime.start('s', { content: 'Write one file' }); await until(() => f.get().approvals.length === 1);
  await f.runtime.decide(f.get().approvals[0].id, 'approve'); await f.done();
  assert.equal(f.get().run.status, 'completed'); assert.equal(calls, 5); assert.equal(f.get().approvals.length, 1);
  assert.equal(f.get().run.steps.filter(value => value.type === 'tool').length, 1); assert.equal(await fs.readFile(path.join(f.directory, 'one.txt'), 'utf8'), 'one');
  assert.equal(receivedResult.name, 'write_file'); assert.equal(JSON.parse(receivedResult.content).result.path, 'one.txt');
});

test('model waiting excludes execution time, remains cancellable, and counts every request', async t => {
  let calls = 0;
  const f = await fixture(t, { limits: { maxRunMs: 15, maxModelCalls: 4, providerAttemptTimeoutMs: 20 }, providerCall: async () => { calls++; return new Promise(() => {}); } });
  await f.runtime.start('s', { content: 'Wait' }); await until(() => calls >= 3);
  assert.equal(f.get().run.status, 'running'); f.runtime.cancel('s'); await f.done();
  assert.equal(f.get().run.status, 'cancelled'); assert.equal(f.get().run.steps[0].status, 'cancelled'); assert.ok(f.get().run.steps[0].finishedAt);
});

test('backoff cancel retains interrupted draft and never invokes another model request', async t => {
  let calls = 0;
  const f = await fixture(t, { limits: { providerRetryBaseMs: 30000, providerRetryMaxMs: 30000 }, providerCall: async (_provider, { onText }) => { calls++; await onText('partial'); throw new CoreError('MODEL_RESPONSE_INCOMPLETE', 'incomplete', 502); } });
  await f.runtime.start('s', { content: 'Wait' }); await until(() => f.get().run?.steps[0]?.phase === 'retrying'); f.runtime.cancel('s'); await f.done();
  assert.equal(calls, 1); assert.equal(f.get().run.status, 'cancelled'); assert.equal(f.get().run.output.content, 'partial'); assert.equal(f.get().run.output.status, 'interrupted');
});

test('checkpoint failure aborts the run without entering retry', async t => {
  let calls = 0;
  const f = await fixture(t, { save: async value => { if (value.run?.output) throw new Error('storage failed'); }, providerCall: async (_provider, { onText, signal }) => { calls++; await onText('partial'); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new CoreError('CANCELLED', 'cancelled'); } });
  await f.runtime.start('s', { content: 'Wait' }); await f.done();
  assert.equal(calls, 1); assert.ok(!f.events.some(value => value.type === 'provider.retry'));
});

test('reconnecting after a completed approved shell command never reruns its side effect', async t => {
  let calls = 0;
  const f = await fixture(t, { providerCall: async (_provider, { messages }) => {
    calls++;
    if (calls === 1) return reply('', [{ id: 'command1', name: 'run_command', args: { command: process.platform === 'win32' ? 'Add-Content -LiteralPath once.txt -Value x' : 'printf x >> once.txt' } }]);
    assert.equal(messages.at(-1).name, 'run_command');
    if (calls < 4) throw new CoreError('PROVIDER_TIMEOUT', 'timeout', 504);
    return reply('Executed once');
  } });
  await f.runtime.start('s', { content: 'Run one command' }); await until(() => f.get().approvals.length === 1);
  await f.runtime.decide(f.get().approvals[0].id, 'approve'); await f.done();
  assert.equal(f.get().run.status, 'completed'); assert.equal(calls, 4); assert.equal(f.get().approvals.length, 1);
  assert.equal((await fs.readFile(path.join(f.directory, 'once.txt'), 'utf8')).trim(), 'x');
  assert.equal(f.get().run.steps.filter(value => value.type === 'tool').length, 1);
});
