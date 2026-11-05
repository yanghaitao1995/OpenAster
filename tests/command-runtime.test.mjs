// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { validateRunHistoryRecord } from '../core/run-history.mjs';

const windows = process.platform === 'win32', sha = value => createHash('sha256').update(value).digest('hex');
const answer = (toolCalls = []) => ({ content: toolCalls.length ? '' : 'Finished.', toolCalls });
const commandCall = args => ({ id: randomUUID(), name: 'run_command', args });
async function until(fn) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { const value = fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Command fixture timed out');
}
async function fixture(t, options = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-command-runtime-'));
  const identity = await fs.lstat(root, { bigint: true }), dataDir = path.join(root, 'data'), workspacePath = path.join(dataDir, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const store = new Store(dataDir);
  store.putProvider({ id: 'fixture', name: 'Fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true, streaming: false, toolMode: options.toolMode ?? 'workspace' });
  const session = store.createSession({ providerId: 'fixture' }), audits = [], artifacts = [], reads = [];
  const workspace = createWorkspace(workspacePath);
  let calls = 0, closed = false;
  const runtime = createRuntime({ workspace: { ...workspace,
    read: async (...args) => { reads.push(args[0]); return workspace.read(...args); },
    commandDirectory: async (...args) => { await options.beforeCommandDirectory?.(...args); return workspace.commandDirectory(...args); },
  }, providers: async id => store.getProvider(id), getSession: async id => store.getSession(id),
    saveSession: async (value, metadata) => {
      if (options.failArtifacts && metadata?.artifacts?.length) throw new Error('Injected artifact save failure');
      await options.beforeSave?.(value, metadata);
      store.putSession(value, metadata); artifacts.push(...metadata?.artifacts ?? []);
    },
    audit: async entry => { if (entry.action === options.failAudit) throw new Error('Injected audit failure'); audits.push(entry); store.audit(entry); },
    providerCall: async (...args) => { calls++; return options.providerCall(...args); }, limits: { maxRunMs: 60000 } });
  async function close() { if (!closed) { await runtime.shutdown(); store.close(); closed = true; } }
  t.after(async () => {
    await close(); const current = await fs.lstat(root, { bigint: true });
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
    await fs.rm(root, { recursive: true });
  });
  return { root, dataDir, workspace: workspacePath, store, session, runtime, audits, artifacts, reads, close, calls: () => calls,
    get: () => store.getSession(session.id), start: () => runtime.start(session.id, { content: 'Execute only the explicitly approved fixture command.' }),
    pending: () => until(() => store.getSession(session.id).approvals.find(value => value.status === 'pending')),
    done: () => until(() => !runtime.isActive(session.id) && store.getSession(session.id).run) };
}

test('command approval becomes running before process startup and remains cancellable without command side effects', { timeout: 10000 }, async t => {
  let release, entered, directoryChecks = 0;
  const gate = new Promise(resolve => { release = resolve; }), blocked = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, {
    beforeCommandDirectory: async () => { if (++directoryChecks === 2) { entered(); await gate; } },
    providerCall: async () => answer([commandCall({ command: windows ? 'Set-Content must-not-start.txt forbidden' : 'printf forbidden > must-not-start.txt' })]),
  });
  try {
    await f.start(); const pending = await f.pending();
    assert.equal(f.get().run.status, 'awaiting_approval');
    await f.runtime.decide(pending.id, 'approve'); await blocked;
    const approved = f.get();
    assert.equal(approved.run.status, 'running'); assert.equal(approved.approvals[0].status, 'approved');
    assert.equal(approved.approvals[0].startedAt, undefined); assert.equal(f.runtime.isActive(f.session.id), true);
    assert.equal(f.audits.filter(entry => entry.action === 'approval.approved').length, 1);
    assert.equal(f.audits.filter(entry => entry.action === 'command.started').length, 0);
    await assert.rejects(fs.stat(path.join(f.workspace, 'must-not-start.txt')), { code: 'ENOENT' });
    f.runtime.cancel(f.session.id); release(); await f.done();
    assert.equal(f.get().run.status, 'cancelled'); assert.equal(f.get().approvals[0].startedAt, undefined);
    assert.equal(directoryChecks, 2); assert.equal(f.calls(), 1);
    assert.equal(f.audits.filter(entry => entry.action === 'command.started').length, 0);
    await assert.rejects(fs.stat(path.join(f.workspace, 'must-not-start.txt')), { code: 'ENOENT' });
  } finally { f.runtime.cancel(f.session.id); release(); }
});

test('failed command approval decision persistence never starts the command', { timeout: 10000 }, async t => {
  const failure = new Error('Injected approval decision save failure');
  let rejectDecision = true, directoryChecks = 0;
  const f = await fixture(t, {
    beforeCommandDirectory: async () => { assert.equal(++directoryChecks, 1, 'failed decision must never reach execution directory validation'); },
    beforeSave: async value => {
      if (rejectDecision && value.approvals.some(approval => approval.tool === 'run_command' && approval.status === 'approved')) {
        rejectDecision = false; throw failure;
      }
    },
    providerCall: async () => f.calls() === 1
      ? answer([commandCall({ command: windows ? 'Set-Content must-not-start.txt forbidden' : 'printf forbidden > must-not-start.txt' })]) : answer(),
  });
  await f.start(); const pending = await f.pending();
  await assert.rejects(f.runtime.decide(pending.id, 'approve'), error => error === failure); await f.done();
  assert.equal(rejectDecision, false); assert.equal(directoryChecks, 1);
  assert.equal(f.get().approvals[0].startedAt, undefined);
  assert.equal(f.audits.filter(entry => entry.action === 'command.started').length, 0);
  await assert.rejects(fs.stat(path.join(f.workspace, 'must-not-start.txt')), { code: 'ENOENT' });
});

test('exact command waits for approval, ignores later argument mutation, and persists output plus non-executable history', { timeout: 60000 }, async t => {
  const raw = windows ? '[Console]::Out.WriteLine("approved 中文")' : 'printf "approved 中文\\n"';
  const args = { command: raw }; let received;
  const f = await fixture(t, { providerCall: async (_provider, request) => {
    if (!f.calls() || f.calls() === 1) return answer([commandCall(args)]);
    received = JSON.parse(request.messages.at(-1).content); return answer();
  } });
  await f.start(); const pending = await f.pending();
  assert.deepEqual(pending.command, { command: raw, cwd: '', shell: windows ? 'powershell' : 'sh', timeoutMs: 30000 });
  assert.equal(pending.startedAt, undefined); assert.equal(f.artifacts.length, 0);
  args.command = windows ? 'Set-Content not-approved.txt BAD' : 'printf BAD > not-approved.txt';
  await f.runtime.decide(pending.id, 'approve'); await f.done();
  assert.equal(f.get().run.status, 'completed'); assert.equal(f.calls(), 2); assert.match(received.result.stdout, /approved 中文/);
  await assert.rejects(fs.stat(path.join(f.workspace, 'not-approved.txt')), { code: 'ENOENT' });
  const history = f.store.getRunHistory(f.session.id, f.get().run.id);
  assert.equal(history.approvals[0].command.sha256, sha(raw)); assert.ok(history.approvals[0].startedAt);
  assert.ok(!JSON.stringify(history).includes(raw)); assert.ok(!JSON.stringify(f.audits).includes(raw));
  assert.equal(f.artifacts.length, 1); assert.equal(f.artifacts[0].name, 'run_command');
  await assert.rejects(f.runtime.decide(pending.id, 'approve'), { code: 'APPROVAL_NOT_PENDING' });
  const expectedApproval = f.get().approvals[0], runId = f.get().run.id, output = path.join(f.root, 'approved-backup.json');
  await f.close(); await createBackup({ dataDir: f.dataDir, workspace: f.workspace, output });
  const restoredDir = path.join(f.root, 'approved-restored'); await restoreBackup({ input: output, dataDir: restoredDir });
  const restored = new Store(restoredDir);
  try {
    assert.deepEqual(restored.getSession(f.session.id).approvals[0], expectedApproval);
    assert.deepEqual(restored.getRunHistory(f.session.id, runId).approvals, history.approvals);
    assert.ok(!JSON.stringify(restored.getRunHistory(f.session.id, runId)).includes(raw));
  } finally { restored.close(); }
});

test('denial blocks disguised new shell proposals throughout this run without a process start', async t => {
  const f = await fixture(t, { providerCall: async (_provider, request) => {
    if (f.calls() === 1) return answer([commandCall({ command: 'echo denied' })]);
    assert.equal(JSON.parse(request.messages.at(-1).content).error.code, 'APPROVAL_DENIED');
    return f.calls() === 2 ? answer([commandCall({ command: '  echo disguised', timeoutMs: 4000 })]) : answer();
  } });
  await f.start(); await f.runtime.decide((await f.pending()).id, 'deny'); await f.done();
  assert.equal(f.get().approvals.length, 1); assert.equal(f.get().approvals[0].startedAt, undefined);
  assert.equal(f.calls(), 3); assert.equal(f.audits.filter(item => item.action === 'command.started').length, 0);
});

test('nonzero exit archives the complete error result, lets the model explain it, and survives history and backup', { timeout: 60000 }, async t => {
  const call = commandCall({ command: windows
    ? '[Console]::Out.WriteLine("before failure 中文"); [Console]::Error.WriteLine("failure details"); exit 9'
    : 'printf "before failure 中文\\n"; printf "failure details\\n" >&2; exit 9' });
  let received;
  const f = await fixture(t, { providerCall: async (_provider, request) => {
    if (f.calls() === 1) return answer([call]);
    received = request.messages.at(-1);
    return { content: 'The command exited with code 9; the recorded stderr explains the failure.', toolCalls: [] };
  } });
  await f.start(); await f.runtime.decide((await f.pending()).id, 'approve'); await f.done();
  assert.equal(f.get().run.status, 'completed'); assert.equal(f.get().run.error, null); assert.equal(f.calls(), 2);
  assert.match(f.get().messages.at(-1).content, /exited with code 9/);
  assert.equal(received.role, 'tool'); assert.equal(received.callId, call.id); assert.equal(received.isError, true);
  const artifact = f.artifacts[0], value = JSON.parse(artifact.content), result = value.error.result;
  assert.equal(f.artifacts.length, 1); assert.equal(artifact.isError, true); assert.equal(received.content, artifact.content);
  assert.equal(value.untrusted_data, true); assert.equal(value.error.code, 'COMMAND_FAILED'); assert.ok(value.error.message);
  assert.equal(value.result, undefined);
  assert.equal(result.exitCode, 9); assert.match(result.stdout, /before failure 中文/); assert.match(result.stderr, /failure details/);
  assert.equal(result.shell, windows ? 'powershell' : 'sh'); assert.equal(result.cwd, ''); assert.equal(result.signal, null);
  assert.equal(result.timedOut, false); assert.equal(result.cancelled, false); assert.equal(result.truncated, false);
  assert.ok(Number.isSafeInteger(result.durationMs) && result.durationMs >= 0);
  const tool = f.get().run.steps.find(step => step.id === artifact.stepId);
  assert.equal(tool.status, 'failed'); assert.equal(tool.toolResultRef.isError, true);
  assert.ok(f.get().approvals[0].startedAt); assert.equal(f.audits.filter(item => item.action === 'command.finished').length, 1);
  const runId = f.get().run.id, history = f.store.getRunHistory(f.session.id, runId);
  assert.equal(history.run.status, 'completed'); assert.equal(history.run.steps.find(step => step.id === tool.id).status, 'failed');
  assert.deepEqual(f.store.getToolArtifact(f.session.id, runId, artifact.id), artifact);
  const output = path.join(f.root, 'failed-command-backup.json'); await f.close();
  await createBackup({ dataDir: f.dataDir, workspace: f.workspace, output });
  const restoredDir = path.join(f.root, 'failed-command-restored'); await restoreBackup({ input: output, dataDir: restoredDir });
  const restored = new Store(restoredDir);
  try {
    assert.equal(restored.getSession(f.session.id).run.status, 'completed');
    assert.deepEqual(restored.getRunHistory(f.session.id, runId), history);
    assert.deepEqual(restored.getToolArtifact(f.session.id, runId, artifact.id), artifact);
  } finally { restored.close(); }
});

test('nonzero exit skips every remaining batch call, and a replanned command requires fresh approval before denial', { timeout: 60000 }, async t => {
  const failed = commandCall({ command: 'exit 9' }), read = { id: randomUUID(), name: 'read_file', args: { path: 'batch-note.txt' } };
  const marker = windows ? 'Set-Content batch-marker.txt forbidden' : 'printf forbidden > batch-marker.txt';
  const skipped = commandCall({ command: marker }), replanned = commandCall({ command: marker });
  const f = await fixture(t, { providerCall: async (_provider, request) => {
    if (f.calls() === 1) return answer([failed, read, skipped]);
    const outputs = request.messages.filter(message => message.role === 'tool');
    assert.deepEqual(outputs.slice(0, 3).map(message => message.callId), [failed.id, read.id, skipped.id]);
    assert.deepEqual(outputs.slice(0, 3).map(message => JSON.parse(message.content).error.code), ['COMMAND_FAILED', 'COMMAND_BATCH_SKIPPED', 'COMMAND_BATCH_SKIPPED']);
    assert.ok(outputs.every(message => message.isError));
    if (f.calls() === 2) return answer([replanned]);
    assert.equal(outputs.at(-1).callId, replanned.id); assert.equal(JSON.parse(outputs.at(-1).content).error.code, 'APPROVAL_DENIED');
    return answer();
  } });
  await fs.writeFile(path.join(f.workspace, 'batch-note.txt'), 'This read must wait for replanning.');
  await f.start(); const first = await f.pending(); await f.runtime.decide(first.id, 'approve');
  const next = await f.pending();
  assert.notEqual(next.id, first.id); assert.equal(next.command.command, marker); assert.equal(next.startedAt, undefined);
  assert.equal(f.get().run.status, 'awaiting_approval'); assert.equal(f.get().approvals.length, 2); assert.equal(f.calls(), 2);
  assert.deepEqual(f.reads, []); assert.equal(f.artifacts.length, 3);
  assert.deepEqual(f.artifacts.map(artifact => artifact.callId), [failed.id, read.id, skipped.id]);
  assert.ok(f.artifacts.every(artifact => artifact.isError));
  assert.ok(f.get().run.steps.filter(step => step.toolResultRef).every(step => step.status === 'failed'));
  await assert.rejects(fs.stat(path.join(f.workspace, 'batch-marker.txt')), { code: 'ENOENT' });
  await f.runtime.decide(next.id, 'deny'); await f.done();
  assert.equal(f.get().run.status, 'completed'); assert.equal(f.calls(), 3); assert.deepEqual(f.reads, []);
  assert.equal(f.get().approvals[1].status, 'denied'); assert.equal(f.get().approvals[1].startedAt, undefined);
  assert.equal(f.audits.filter(item => item.action === 'command.started').length, 1);
  await assert.rejects(fs.stat(path.join(f.workspace, 'batch-marker.txt')), { code: 'ENOENT' });
});

test('failure to archive a nonzero command result remains fatal and never reaches the model again', { timeout: 60000 }, async t => {
  const f = await fixture(t, { failArtifacts: true, providerCall: async () => answer([commandCall({ command: 'exit 9' })]) });
  await f.start(); await f.runtime.decide((await f.pending()).id, 'approve'); await f.done();
  assert.equal(f.get().run.status, 'failed'); assert.equal(f.get().run.error.code, 'POST_COMMAND_ARTIFACT_FAILED');
  assert.equal(f.calls(), 1); assert.equal(f.artifacts.length, 0); assert.ok(f.get().approvals[0].startedAt);
  assert.equal(f.audits.filter(item => item.action === 'command.started').length, 1);
});

test('post-command audit failure retains the output artifact and never repeats the command', { timeout: 60000 }, async t => {
  const f = await fixture(t, { failAudit: 'command.finished', providerCall: async () => answer([commandCall({ command: 'echo retained' })]) });
  await f.start(); await f.runtime.decide((await f.pending()).id, 'approve'); await f.done();
  assert.equal(f.get().run.error.code, 'POST_COMMAND_AUDIT_FAILED'); assert.equal(f.calls(), 1);
  assert.match(JSON.parse(f.artifacts[0].content).result.stdout, /retained/);
});

test('a command deadline remains fatal instead of returning a recoverable nonzero error to the model', { timeout: 60000 }, async t => {
  const f = await fixture(t, { providerCall: async () => answer([commandCall({ command: windows ? 'Start-Sleep -Seconds 30' : 'sleep 30', timeoutMs: 5000 })]) });
  await f.start(); await f.runtime.decide((await f.pending()).id, 'approve'); await f.done();
  assert.equal(f.get().run.status, 'failed'); assert.equal(f.get().run.error.code, 'COMMAND_TIMEOUT'); assert.equal(f.calls(), 1);
  const result = JSON.parse(f.artifacts[0].content).result;
  assert.equal(result.timedOut, true); assert.equal(result.cancelled, false);
  assert.ok(f.get().approvals[0].startedAt); assert.equal(f.audits.filter(item => item.action === 'command.finished').length, 1);
});

test('cancellation during an approved command waits for termination and archives the cancelled result', { timeout: 60000 }, async t => {
  const f = await fixture(t, { providerCall: async () => answer([commandCall({ command: windows ? 'Start-Sleep -Seconds 30' : 'sleep 30' })]) });
  await f.start(); await f.runtime.decide((await f.pending()).id, 'approve');
  await until(() => f.get().approvals[0].startedAt); f.runtime.cancel(f.session.id); await f.done();
  assert.equal(f.calls(), 1); assert.equal(f.get().run.status, 'cancelled');
  assert.equal(JSON.parse(f.artifacts[0].content).result.cancelled, true);
  assert.ok(f.get().approvals[0].startedAt); assert.equal(f.get().approvals[0].status, 'approved');
});

test('shutdown while waiting revokes the command and backup restore cannot replay it', async t => {
  const f = await fixture(t, { providerCall: async () => answer([commandCall({ command: 'echo never-run' })]) });
  await f.start(); const pending = await f.pending();
  await f.runtime.shutdown();
  assert.equal(f.get().run.status, 'cancelled'); assert.equal(f.get().approvals[0].revoked, true); assert.equal(f.get().approvals[0].startedAt, undefined);
  await assert.rejects(f.runtime.decide(pending.id, 'approve'), { code: 'APPROVAL_NOT_PENDING' });
  const output = path.join(f.root, 'backup.json'); await f.close();
  await createBackup({ dataDir: f.dataDir, workspace: f.workspace, output });
  const envelope = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(envelope.version, 9); assert.equal(envelope.payload.sessions[0].approvals[0].command.command, 'echo never-run');
  assert.equal(envelope.payload.runHistory[0].approvals[0].command.sha256, sha('echo never-run'));
  const restoredDir = path.join(f.root, 'restored'); await restoreBackup({ input: output, dataDir: restoredDir });
  const restored = new Store(restoredDir);
  try { const value = restored.getSession(f.session.id); assert.equal(value.approvals[0].status, 'denied'); assert.equal(value.run.status, 'cancelled'); }
  finally { restored.close(); }
  const invalid = structuredClone(envelope.payload.runHistory[0]); invalid.approvals[0].command.command = 'do not execute';
  assert.throws(() => validateRunHistoryRecord(invalid), { code: 'INVALID_RUN_HISTORY' });
  envelope.payload.sessions[0].approvals[0].startedAt = new Date().toISOString();
  envelope.sha256 = sha(JSON.stringify(envelope.payload)); await fs.writeFile(output, JSON.stringify(envelope));
  await assert.rejects(restoreBackup({ input: output, dataDir: path.join(f.root, 'invalid') }), { code: 'INVALID_BACKUP' });
});
