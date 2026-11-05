// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { Store } from '../server/store.mjs';

const answer = (toolCalls = []) => ({ content: toolCalls.length ? '' : 'Done.', toolCalls });
const call = (command, extra = {}) => ({ id: randomUUID(), name: 'run_command', args: { command, ...extra } });
async function until(fn) {
  const end = Date.now() + 40000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Command policy fixture timed out');
}
async function fixture(t, options = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-policy-runtime-'));
  const original = await fs.lstat(root, { bigint: true }), directory = path.join(root, 'workspace'); await fs.mkdir(directory);
  const savedPath = process.env.PATH; process.env.PATH = path.dirname(process.execPath) + path.delimiter + savedPath;
  const store = new Store(path.join(root, 'data')), audits = [];
  store.putProvider({ id: 'fixture', name: 'Fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true, streaming: false });
  const session = store.createSession({ providerId: 'fixture' }), workspace = createWorkspace(directory);
  let calls = 0, directoryCalls = 0;
  const runtime = createRuntime({ workspace: { ...workspace, commandDirectory: async (...args) => { await options.beforeDirectory?.(++directoryCalls); return workspace.commandDirectory(...args); } },
    providers: async id => store.getProvider(id), getSession: async id => store.getSession(id), saveSession: async (...args) => { await options.beforeSave?.(...args); return store.putSession(...args); },
    providerCall: async (...args) => options.providerCall(++calls, ...args), audit: async entry => { await options.beforeAudit?.(entry); audits.push(entry); }, limits: { maxRunMs: 60000 } });
  await fs.writeFile(path.join(directory, 'marker.cjs'), "const f=require('node:fs');let n=0;try{n=Number(f.readFileSync('count.txt','utf8'))}catch{}f.writeFileSync('count.txt',String(n+1));if(process.argv[2]==='fail')process.exit(9);\n");
  t.after(async () => { await runtime.shutdown(); store.close(); process.env.PATH = savedPath; const current = await fs.lstat(root, { bigint: true }); assert.equal(path.dirname(await fs.realpath(root)), parent); assert.equal(current.dev, original.dev); assert.equal(current.ino, original.ino); await fs.rm(root, { recursive: true }); });
  return { root, directory, runtime, store, session, audits,
    start: () => runtime.start(session.id, { content: 'Local deterministic command-policy test.' }),
    get: () => store.getSession(session.id),
    pending: () => until(() => store.getSession(session.id).approvals.find(value => value.status === 'pending')),
    done: () => until(() => !runtime.isActive(session.id) && store.getSession(session.id).run),
    count: async () => { try { return Number(await fs.readFile(path.join(directory, 'count.txt'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } },
  };
}

test('smart executes a fixed read-only plan and stores a distinguishable approved history fact', { timeout: 45000 }, async t => {
  const f = await fixture(t, { providerCall: n => answer(n === 1 ? [call(process.platform === 'win32' ? 'Get-Location' : 'pwd')] : []) });
  await f.start(); await f.done();
  assert.equal(f.get().run.status, 'completed');
  assert.equal(f.get().approvals.length, 1); assert.equal(f.get().approvals[0].status, 'approved');
  assert.match(f.get().approvals[0].description, /智能审批/u);
  assert.equal(f.audits.filter(value => value.action === 'approval.requested').length, 0);
  assert.equal(f.audits.filter(value => value.action === 'approval.automatic').length, 1);
  const history = f.store.getRunHistory(f.session.id, f.get().run.id);
  assert.equal(history.approvals[0].status, 'approved'); assert.ok(history.approvals[0].command.sha256);
  assert.equal((await f.runtime.getCommandPolicy(f.session.id)).mode, 'smart');
});

test('ask keeps even fixed read-only commands pending and cancellation never runs them', async t => {
  const f = await fixture(t, { providerCall: n => answer(n === 1 ? [call(process.platform === 'win32' ? 'Get-Location' : 'pwd')] : []) });
  await f.runtime.setCommandPolicy(f.session.id, { mode: 'ask' }); await f.start();
  const pending = await f.pending(), policy = await f.runtime.getCommandPolicy(f.session.id);
  assert.equal(policy.pending[0].approvalId, pending.id); assert.equal(policy.pending[0].sessionEligible, true);
  f.runtime.cancel(f.session.id); await f.done(); assert.equal(f.get().approvals[0].startedAt, undefined);
});

test('explicit trusted task executes sequential project scripts, then expires before the next run', { timeout: 60000 }, async t => {
  const f = await fixture(t, { providerCall: n => answer([1, 2, 4].includes(n) ? [call('node marker.cjs')] : []) });
  await assert.rejects(f.runtime.setCommandPolicy(f.session.id, { mode: 'trusted' }), { code: 'COMMAND_POLICY_CONFIRMATION_REQUIRED' });
  await f.runtime.setCommandPolicy(f.session.id, { mode: 'trusted', confirmRisk: true });
  await f.start(); await f.done(); assert.equal(await f.count(), 2);
  assert.equal(f.get().approvals.filter(value => value.status === 'approved').length, 2);
  assert.ok(f.get().approvals.every(value => /本轮任务授权/u.test(value.description)));
  assert.equal((await f.runtime.getCommandPolicy(f.session.id)).mode, 'smart');
  await f.start(); await f.pending(); assert.equal(await f.count(), 2);
  f.runtime.cancel(f.session.id); await f.done();
});

test('approve-and-authorize requires confirmation, allows the next script, and never accepts that scope for danger', { timeout: 60000 }, async t => {
  const f = await fixture(t, { providerCall: n => answer(n < 3 ? [call('node marker.cjs')] : n === 3 ? [call('node -e process.exit()')] : []) });
  await f.start(); const first = await f.pending();
  await assert.rejects(f.runtime.decide(first.id, 'approve', { scope: 'session' }), { code: 'COMMAND_POLICY_CONFIRMATION_REQUIRED' });
  await f.runtime.decide(first.id, 'approve', { scope: 'session', confirmRisk: true });
  const dangerous = await until(() => f.get().approvals.find(value => value.status === 'pending' && value.id !== first.id));
  assert.equal(await f.count(), 2);
  assert.equal((await f.runtime.getCommandPolicy(f.session.id)).pending[0].sessionEligible, false);
  await assert.rejects(f.runtime.decide(dangerous.id, 'approve', { scope: 'session', confirmRisk: true }), { code: 'COMMAND_SINGLE_APPROVAL_REQUIRED' });
  await f.runtime.decide(dangerous.id, 'deny'); await f.done();
  assert.equal(await f.count(), 2); assert.equal((await f.runtime.getCommandPolicy(f.session.id)).mode, 'smart');
});

test('revoking task permission while execution directory validation is queued prevents process code', async t => {
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), blocked = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { beforeDirectory: async n => { if (n === 2) { entered(); await gate; } }, providerCall: n => answer(n === 1 ? [call('node marker.cjs')] : []) });
  try {
    await f.runtime.setCommandPolicy(f.session.id, { mode: 'trusted', confirmRisk: true }); await f.start(); await blocked;
    await f.runtime.setCommandPolicy(f.session.id, { mode: 'smart' }); release(); await f.done();
    assert.equal(await f.count(), 0); assert.equal(f.audits.filter(value => value.action === 'command.started').length, 0);
    const ref = f.get().run.steps.find(step => step.toolResultRef?.isError).toolResultRef;
    assert.equal(JSON.parse(f.store.getToolArtifact(f.session.id, f.get().run.id, ref.artifactId).content).error.code, 'COMMAND_AUTHORIZATION_REVOKED');
  } finally { release(); }
});

test('revocation during the durable start gate prevents a suspended command from executing', { timeout: 60000 }, async t => {
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), blocked = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { beforeAudit: async entry => { if (entry.action === 'command.started') { entered(); await gate; } }, providerCall: n => answer(n === 1 ? [call('node marker.cjs')] : []) });
  try {
    await f.runtime.setCommandPolicy(f.session.id, { mode: 'trusted', confirmRisk: true }); await f.start(); await blocked;
    await f.runtime.setCommandPolicy(f.session.id, { mode: 'smart' }); release(); await f.done();
    assert.equal(await f.count(), 0); assert.equal((await f.runtime.getCommandPolicy(f.session.id)).mode, 'smart');
  } finally { release(); }
});

test('a failed command cannot silently replay under a retained task grant', { timeout: 60000 }, async t => {
  const f = await fixture(t, { providerCall: n => answer(n < 3 ? [call('node marker.cjs fail')] : []) });
  await f.runtime.setCommandPolicy(f.session.id, { mode: 'trusted', confirmRisk: true }); await f.start();
  const pending = await f.pending(); assert.equal(await f.count(), 1);
  const policy = await f.runtime.getCommandPolicy(f.session.id);
  assert.equal(policy.mode, 'smart'); assert.equal(policy.pending[0].sessionEligible, false);
  await f.runtime.decide(pending.id, 'deny'); await f.done(); assert.equal(await f.count(), 1);
});

test('grants do not cross sessions and cannot be granted through tool arguments or a failed audit', async t => {
  const f = await fixture(t, { beforeAudit: entry => { if (entry.action === 'command-policy.changed' && entry.detail.to === 'trusted') throw new Error('fixture audit failure'); }, providerCall: n => answer(n === 1 ? [call('node marker.cjs', { mode: 'trusted', confirmRisk: true })] : []) });
  await assert.rejects(f.runtime.setCommandPolicy(f.session.id, { mode: 'trusted', confirmRisk: true }), { code: 'AUDIT_UNAVAILABLE' });
  assert.equal((await f.runtime.getCommandPolicy(f.session.id)).mode, 'smart');
  const second = f.store.createSession({ providerId: 'fixture' });
  assert.equal((await f.runtime.getCommandPolicy(second.id)).mode, 'smart');
  await f.start(); await f.done(); assert.equal(await f.count(), 0); assert.equal(f.get().approvals.length, 0);
  const ref = f.get().run.steps.find(step => step.toolResultRef?.isError).toolResultRef;
  assert.equal(JSON.parse(f.store.getToolArtifact(f.session.id, f.get().run.id, ref.artifactId).content).error.code, 'INVALID_TOOL_ARGUMENTS');
});
