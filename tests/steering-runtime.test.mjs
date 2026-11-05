// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { CoreError } from '../core/errors.mjs';
import { Store } from '../server/store.mjs';

const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const reply = (content = 'Finished.', toolCalls = []) => ({ content, toolCalls });
const tool = (name, args) => ({ id: randomUUID(), name, args });
async function until(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Steering fixture deadline');
}
async function fixture(t, options = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-steering-runtime-'));
  const identity = await fs.lstat(root, { bigint: true }), directory = path.join(root, 'workspace'); await fs.mkdir(directory);
  const store = new Store(path.join(root, 'data'));
  store.putProvider({ id: 'fixture', name: 'Fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true });
  const session = store.createSession({ providerId: 'fixture' }), workspace = createWorkspace(directory);
  let calls = 0;
  const runtime = createRuntime({ workspace: { ...workspace, ...options.workspace?.(workspace) },
    steeringInbox: store.steeringInbox, providers: async id => store.getProvider(id), getSession: async id => store.getSession(id),
    saveSession: async (...args) => { await options.beforeSave?.(...args); return store.putSession(...args); },
    providerCall: async (provider, value) => options.providerCall(++calls, value), limits: { maxRunMs: 15000, streamCheckpointMs: 5, providerRetryBaseMs: 5, providerRetryMaxMs: 10, ...options.limits } });
  t.after(async () => { await runtime.shutdown(); store.close(); const current = await fs.lstat(root, { bigint: true }); assert.equal(path.dirname(await fs.realpath(root)), parent); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); await fs.rm(root, { recursive: true }); });
  return { runtime, store, session, directory, calls: () => calls, get: () => store.getSession(session.id),
    inputs: () => store.steeringInbox.list(session.id),
    start: () => runtime.start(session.id, { content: 'Initial request.' }),
    send: (runId, content, mode = 'queue', extra = {}) => runtime.steer(session.id, { mode, requestId: randomUUID(), expectedRunId: runId, content, ...extra }),
    done: () => until(() => !runtime.isActive(session.id) && store.getSession(session.id).run),
  };
}

test('queued messages persist in order, wait for generation, and never execute its obsolete tool batch', { timeout: 15000 }, async t => {
  const first = gate(), entered = gate(); let oldSignal, secondMessages;
  const f = await fixture(t, { providerCall: async (n, value) => {
    if (n === 1) { oldSignal = value.signal; await value.onText('Already received.'); entered.release(); await first.promise; return reply('Already received.', [tool('write_file', { path: 'obsolete.txt', content: 'never' })]); }
    secondMessages = value.messages; return reply();
  } });
  try {
    const { runId } = await f.start(); await entered.promise;
    const [a, b] = await Promise.all([f.send(runId, '  Addition one.  '), f.send(runId, 'Addition two.')]);
    assert.equal(a.input.status, 'pending'); assert.equal(b.input.status, 'pending'); assert.equal(oldSignal.aborted, false);
    assert.deepEqual(f.inputs().map(input => input.sequence), [1, 2]);
    await assert.rejects(f.runtime.start(f.session.id, { content: 'Cannot start in parallel.' }), { code: 'RUN_ACTIVE' });
    first.release(); await f.done();
    assert.equal(f.calls(), 2); assert.equal(f.get().run.status, 'completed'); assert.equal(f.get().approvals.length, 0);
    assert.deepEqual(f.get().messages.filter(message => message.role === 'user').map(message => message.content), ['Initial request.', '  Addition one.  ', 'Addition two.']);
    assert.ok(secondMessages.every(message => message.role !== 'tool' && !message.toolCalls));
    assert.ok(f.inputs().every(input => input.status === 'consumed' && input.runId === f.get().run.id));
    const history = f.store.getRunHistory(f.session.id, runId);
    assert.equal(history.run.status, 'cancelled'); assert.equal(history.run.error.code, 'RUN_SUPERSEDED'); assert.equal(history.run.output.content, 'Already received.');
    await assert.rejects(fs.access(path.join(f.directory, 'obsolete.txt')), { code: 'ENOENT' });
  } finally { first.release(); }
});

test('interrupt aborts generation, preserves partial text and public explanation, then starts exactly one run', { timeout: 15000 }, async t => {
  const entered = gate(); let aborted = false;
  const f = await fixture(t, { providerCall: async (n, value) => {
    if (n > 1) { assert.equal(aborted, true); return reply(); }
    await value.onText('Partial answer.'); await value.onPublicReasoning('Visible explanation.'); entered.release();
    await new Promise((resolve, reject) => value.signal.addEventListener('abort', () => { aborted = true; reject(new CoreError('CANCELLED', 'Fixture cancelled.', 409)); }, { once: true }));
  } });
  const { runId } = await f.start(); await entered.promise; const accepted = await f.send(runId, 'Change direction.', 'interrupt'); await f.done();
  assert.equal(accepted.accepted, true); assert.equal(f.calls(), 2);
  const history = f.store.getRunHistory(f.session.id, runId);
  assert.equal(history.run.output.content, 'Partial answer.'); assert.equal(history.run.output.publicReasoning, 'Visible explanation.');
  assert.equal(history.run.status, 'cancelled'); assert.equal(f.inputs()[0].status, 'consumed');
});

test('a correction fences old write approval before asynchronous attachment snapshot finishes', { timeout: 15000 }, async t => {
  const reading = gate(), release = gate();
  const f = await fixture(t, { providerCall: n => n === 1 ? reply('', [tool('write_file', { path: 'old.txt', content: 'Do not write.' })]) : reply(),
    workspace: workspace => ({ read: async (...args) => { reading.release(); await release.promise; return workspace.read(...args); } }) });
  await fs.writeFile(path.join(f.directory, 'note.txt'), 'Context.');
  try {
    const { runId } = await f.start(); const approval = await until(() => f.get().approvals.find(value => value.status === 'pending'));
    const submit = f.send(runId, 'Do not write.', 'queue', { files: [{ path: 'note.txt', sha256: createHash('sha256').update('Context.').digest('hex') }] });
    await reading.promise;
    await assert.rejects(f.runtime.decide(approval.id, 'approve'), { code: 'APPROVAL_NOT_PENDING' });
    release.release(); await submit; await f.done();
    assert.equal(f.calls(), 2); assert.equal(f.inputs()[0].status, 'consumed');
    assert.equal(f.get().messages.find(message => message.content === 'Do not write.').contextFiles[0].content, 'Context.');
    await assert.rejects(fs.access(path.join(f.directory, 'old.txt')), { code: 'ENOENT' });
    const history = f.store.getRunHistory(f.session.id, runId); assert.equal(history.approvals[0].status, 'revoked');
  } finally { release.release(); }
});

test('queue lets an in-flight read finish and archive, then skips every remaining obsolete tool', { timeout: 15000 }, async t => {
  const entered = gate(), release = gate(); let signal;
  const f = await fixture(t, { providerCall: n => n === 1 ? reply('', [tool('read_file', { path: 'note.txt' }), tool('write_file', { path: 'old.txt', content: 'never' })]) : reply(),
    workspace: workspace => ({ read: async (file, options) => { signal = options.signal; entered.release(); await release.promise; return workspace.read(file, options); } }) });
  await fs.writeFile(path.join(f.directory, 'note.txt'), 'Once.');
  try {
    const { runId } = await f.start(); await entered.promise; await f.send(runId, 'Use a different plan.');
    assert.equal(signal.aborted, false); release.release(); await f.done();
    const history = f.store.getRunHistory(f.session.id, runId), tools = history.run.steps.filter(step => step.type === 'tool');
    assert.equal(tools.length, 1); assert.equal(tools[0].status, 'completed'); assert.ok(tools[0].toolResultRef);
    assert.equal(f.get().approvals.length, 0); assert.equal(f.calls(), 2);
  } finally { release.release(); }
});

test('request identity is durable after consumption and file changes; conflicting or stale submissions cannot execute', { timeout: 15000 }, async t => {
  const entered = gate(), release = gate(); let reads = 0;
  const f = await fixture(t, { providerCall: async n => { if (n === 1) { entered.release(); await release.promise; } return reply(); },
    workspace: workspace => ({ read: async (...args) => { reads++; return workspace.read(...args); } }) });
  await fs.writeFile(path.join(f.directory, 'note.txt'), 'Snapshot.');
  try {
    const { runId } = await f.start(); await entered.promise;
    const payload = { requestId: randomUUID(), expectedRunId: runId, mode: 'queue', content: 'Preserve snapshot.', files: [{ path: 'note.txt', sha256: createHash('sha256').update('Snapshot.').digest('hex') }] };
    const accepted = await f.runtime.steer(f.session.id, payload); const duplicate = await f.runtime.steer(f.session.id, payload);
    assert.equal(accepted.duplicate, false); assert.equal(duplicate.duplicate, true); assert.equal(reads, 1);
    await assert.rejects(f.runtime.steer(f.session.id, { ...payload, content: 'Different.' }), { code: 'STEERING_ID_CONFLICT' });
    release.release(); await f.done(); await fs.writeFile(path.join(f.directory, 'note.txt'), 'Changed.');
    const oldReceipt = await f.runtime.steer(f.session.id, payload); await f.done();
    assert.equal(oldReceipt.input.status, 'consumed'); assert.equal(reads, 1); assert.equal(f.calls(), 2);
    await assert.rejects(f.send(runId, 'Old execution.'), { code: 'STEERING_RUN_CHANGED' });
    assert.equal(f.calls(), 2);
  } finally { release.release(); }
});

test('Stop cancels pending additions instead of automatically starting them', { timeout: 15000 }, async t => {
  const entered = gate();
  const f = await fixture(t, { providerCall: async (n, value) => { entered.release(); await new Promise((resolve, reject) => value.signal.addEventListener('abort', () => reject(new CoreError('CANCELLED', 'Fixture stopped.', 409)), { once: true })); } });
  const { runId } = await f.start(); await entered.promise; await f.send(runId, 'Never run after Stop.');
  f.runtime.cancel(f.session.id); await f.done();
  assert.equal(f.calls(), 1); assert.equal(f.inputs()[0].status, 'failed'); assert.equal(f.inputs()[0].error.code, 'USER_CANCELLED');
  assert.equal(f.get().messages.length, 1);
});

test('completion during acceptance still drains the same expected run; concurrent acceptance blocks ordinary start', { timeout: 15000 }, async t => {
  const entered = gate(), release = gate();
  const f = await fixture(t, { providerCall: () => reply(), workspace: workspace => ({ read: async (...args) => { entered.release(); await release.promise; return workspace.read(...args); } }) });
  await fs.writeFile(path.join(f.directory, 'note.txt'), 'Late.');
  try {
    const { runId } = await f.start(); await f.done();
    const submission = f.send(runId, 'Late input.', 'queue', { files: [{ path: 'note.txt', sha256: createHash('sha256').update('Late.').digest('hex') }] });
    await entered.promise;
    await assert.rejects(f.runtime.start(f.session.id, { content: 'Racing start.' }), { code: 'RUN_ACTIVE' });
    release.release(); await submission; await f.done();
    assert.equal(f.calls(), 2); assert.equal(f.inputs()[0].status, 'consumed'); assert.equal(f.get().messages.length, 4);
  } finally { release.release(); }
});

test('atomic consume failure retains a failed inbox receipt and never sends or appends its input', { timeout: 15000 }, async t => {
  const entered = gate(), release = gate();
  const f = await fixture(t, { providerCall: async () => { entered.release(); await release.promise; return reply(); },
    beforeSave: (session, metadata) => { if (metadata?.consumeInputs) throw new CoreError('STORAGE_TEST_FAILURE', 'Injected atomic save failure.', 503); } });
  try {
    const { runId } = await f.start(); await entered.promise; await f.send(runId, 'Persist before send.'); release.release(); await f.done();
    assert.equal(f.calls(), 1); assert.equal(f.inputs()[0].status, 'failed'); assert.equal(f.inputs()[0].error.code, 'STORAGE_TEST_FAILURE');
    assert.deepEqual(f.get().messages.map(message => message.content), ['Initial request.']);
  } finally { release.release(); }
});

test('steering cannot inherit a previous run command grant or accept provider and permission overrides', { timeout: 15000 }, async t => {
  const entered = gate(), release = gate();
  const f = await fixture(t, { providerCall: async n => { if (n === 1) { entered.release(); await release.promise; return reply(); } return reply('', [tool('run_command', { command: 'node local-script.cjs' })]); } });
  try {
    await f.runtime.setCommandPolicy(f.session.id, { mode: 'trusted', confirmRisk: true });
    const { runId } = await f.start(); await entered.promise;
    await assert.rejects(f.send(runId, 'Invalid override.', 'queue', { providerId: 'other' }), { code: 'INVALID_STEERING_INPUT' });
    await f.send(runId, 'New plan.'); release.release();
    await until(() => f.get().run.id !== runId && f.get().approvals.some(value => value.status === 'pending'));
    assert.equal((await f.runtime.getCommandPolicy(f.session.id)).mode, 'smart');
    assert.ok(f.get().approvals.every(value => !value.startedAt)); f.runtime.cancel(f.session.id); await f.done();
  } finally { release.release(); }
});

test('queue during transient retry cancels backoff and does not replay the obsolete request', { timeout: 15000 }, async t => {
  const f = await fixture(t, { limits: { providerRetryBaseMs: 1000, providerRetryMaxMs: 1000 }, providerCall: n => { if (n === 1) throw new CoreError('PROVIDER_UNAVAILABLE', 'Fixture transport failure.', 503); return reply(); } });
  const { runId } = await f.start();
  // Synchronize with the durable retry event, not a guessed delay.
  await until(() => f.get().run.steps[0]?.phase === 'retrying');
  await f.send(runId, 'New request after connection failure.', 'queue'); await f.done();
  assert.equal(f.calls(), 2); assert.equal(f.inputs()[0].status, 'consumed');
});

test('failed terminal persistence blocks automatic continuation and marks the pending input visibly failed', { timeout: 15000 }, async t => {
  const entered = gate(), release = gate(); let fail = false;
  const f = await fixture(t, { providerCall: async () => { entered.release(); await release.promise; return reply(); },
    beforeSave: session => { if (fail && session.run?.finishedAt) throw new CoreError('STORAGE_TEST_FAILURE', 'Injected terminal save failure.', 503); } });
  try {
    const { runId } = await f.start(); await entered.promise; await f.send(runId, 'Do not proceed without history.');
    fail = true; release.release(); await f.done();
    assert.equal(f.calls(), 1); assert.equal(f.inputs()[0].status, 'failed'); assert.equal(f.inputs()[0].error.code, 'STEERING_PREVIOUS_SAVE_FAILED');
  } finally { fail = false; release.release(); }
});

test('shutdown cancels generation without launching pending model work', { timeout: 15000 }, async t => {
  const entered = gate();
  const f = await fixture(t, { providerCall: async (n, value) => { entered.release(); await new Promise((resolve, reject) => value.signal.addEventListener('abort', () => reject(new CoreError('CANCELLED', 'Fixture shutdown.', 409)), { once: true })); } });
  const { runId } = await f.start(); await entered.promise; await f.send(runId, 'Pending on shutdown.');
  await f.runtime.shutdown();
  assert.equal(f.calls(), 1); assert.equal(f.inputs()[0].status, 'pending'); assert.equal(f.get().run.status, 'cancelled');
  await assert.rejects(f.send(runId, 'After shutdown.'), { code: 'RUNTIME_STOPPED' });
});

test('interrupt waits for an actually running owned command to stop before the next model request', { timeout: 45000 }, async t => {
  const command = process.platform === 'win32'
    ? '[IO.File]::WriteAllText("started.txt","yes"); Start-Sleep -Seconds 20; [IO.File]::WriteAllText("finished.txt","never")'
    : 'printf yes > started.txt; sleep 20; printf never > finished.txt';
  let oldRunId;
  const f = await fixture(t, { limits: { maxRunMs: 40000 }, providerCall: async n => {
    if (n === 1) return reply('', [tool('run_command', { command, timeoutMs: 30000 })]);
    const old = f.store.getRunHistory(f.session.id, oldRunId);
    assert.equal(old.run.status, 'cancelled');
    const ref = old.run.steps.find(step => step.toolResultRef?.name === 'run_command').toolResultRef;
    const result = JSON.parse(f.store.getToolArtifact(f.session.id, oldRunId, ref.artifactId).content).result;
    assert.equal(result.cancelled, true); // The runner has joined/closed its owned process tree.
    return reply();
  } });
  const { runId } = await f.start(); oldRunId = runId;
  const pending = await until(() => f.get().approvals.find(value => value.status === 'pending'));
  await f.runtime.decide(pending.id, 'approve');
  await until(async () => { try { return await fs.readFile(path.join(f.directory, 'started.txt'), 'utf8') === 'yes'; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } });
  await f.send(runId, 'Stop the process and replan.', 'interrupt'); await f.done();
  assert.equal(f.calls(), 2); assert.equal(f.get().run.status, 'completed');
  await assert.rejects(fs.access(path.join(f.directory, 'finished.txt')), { code: 'ENOENT' });
});
