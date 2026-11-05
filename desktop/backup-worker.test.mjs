// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { Store } from '../server/store.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { planSummaryDraft, createSummaryDraft, generateSummaryDraft } from '../core/summary-draft.mjs';
import { runBackupJob } from './backup-worker-client.mjs';

test('fixed worker performs a real SQLite backup and restore and returns only after releasing locks', async t => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'openaster-worker-'));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace'), output = path.join(root, 'backup.json');
  await fs.mkdir(workspace, { recursive: true });
  const store = new Store(dataDir), original = store.createSession({ title: 'worker round trip' });
  const now = new Date().toISOString(), provider = { id: 'worker-provider', name: 'Uncalled local fixture', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', enabled: true };
  original.messages.push({ id: randomUUID(), role: 'user', content: 'Source retained without replay', createdAt: now });
  store.putProvider(provider); store.putSession(original);
  const plan = planSummaryDraft(original, provider);
  const makeDraft = () => createSummaryDraft(plan, { requestId: randomUUID(), providerId: provider.id, expectedSourceHash: plan.preview.source.hash, expectedPlanHash: plan.preview.planHash });
  const draft = makeDraft(); store.putSummaryDraft(draft);
  const completed = await generateSummaryDraft(plan, provider, { draft, checkpoint: value => store.putSummaryDraft(value),
    providerCall: async () => ({ content: '\ufeff已完成草稿\r\n', toolCalls: [], usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null } }) });
  const active = makeDraft(); store.putSummaryDraft(active); store.close();
  await fs.writeFile(path.join(workspace, '正文.txt'), '\ufeff精确字节🙂\r\n');
  const expectedDataIdentity = await createWorkspace(dataDir, { createRoot: false }).getIdentity();
  const expectedWorkspaceIdentity = await createWorkspace(workspace, { createRoot: false }).getIdentity();
  const result = await runBackupJob('backup', { dataDir, workspace, output, expectedDataIdentity, expectedWorkspaceIdentity, denySensitivePaths: true });
  assert.equal(result.sessions, 1); assert.equal(result.path, output); assert.equal(result.summaryJobs, 2);
  assert.equal(result.sha256, createHash('sha256').update(await fs.readFile(output)).digest('hex'));
  const archive = JSON.parse(await fs.readFile(output, 'utf8')); assert.equal(archive.version, 8); assert.equal(archive.payload.summaryJobs.length, 2);
  assert.deepEqual(archive.payload.summaryJobs.find(value => value.id === completed.id), completed);
  assert.deepEqual(archive.payload.summaryJobs.find(value => value.id === active.id), active);
  const restored = path.join(root, 'restored');
  const summary = await runBackupJob('restore', { input: output, dataDir: restored });
  assert.equal(summary.sessions, 1); assert.equal(summary.summaryJobs, 2);
  const reopened = new Store(restored);
  assert.deepEqual(reopened.getSession(original.id), original);
  assert.deepEqual(reopened.getSummaryDraft(original.id, completed.id), completed);
  assert.equal(reopened.getSummaryDraft(original.id, active.id).status, 'cancelled');
  assert.equal(reopened.getProvider(provider.id).enabled, false);
  assert.equal(reopened.getUsageOverview().summary.runs.total, 2);
  assert.equal(reopened.getUsageOverview().summary.tokens.totalTokens.knownSum, '5'); reopened.close();
  assert.deepEqual(await fs.readFile(path.join(restored, 'workspace', '正文.txt')), await fs.readFile(path.join(workspace, '正文.txt')));
  await assert.rejects(runBackupJob('restore', { input: output, dataDir: restored }), { code: 'RESTORE_EXISTS' });
  await assert.rejects(runBackupJob('backup', { dataDir, output }), { code: 'BACKUP_EXISTS' });
});
test('client rejects unknown jobs, untrusted descriptors and malformed optional policy without running getters', async () => {
  let invoked = 0;
  const base = { dataDir: path.resolve('not-read'), output: path.resolve('not-created') };
  for (const [operation, args] of [
    ['run', base], ['backup', { ...base, module: 'anything' }], ['backup', { ...base, dataDir: '../outside' }],
    ['backup', { ...base, denySensitivePaths: 'true' }], ['backup', { ...base, expectedDataIdentity: null }],
    ['backup', Object.defineProperty({ ...base }, 'workspace', { enumerable: true, get() { invoked++; return base.dataDir; } })],
    ['backup', new Proxy(base, { ownKeys() { invoked++; return []; } })],
  ]) await assert.rejects(runBackupJob(operation, args), { code: 'INVALID_BACKUP_JOB' });
  assert.equal(invoked, 0);
});
test('worker independently rejects a malformed envelope and exits normally after one bounded error reply', async () => {
  const messages = [];
  const exit = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), { workerData: { version: 1, operation: 'execute', args: {} }, execArgv: [] });
    worker.on('message', value => messages.push(value)); worker.on('error', reject); worker.once('exit', resolve);
  });
  assert.equal(exit, 0); assert.equal(messages.length, 1); assert.equal(messages[0].ok, false); assert.equal(messages[0].error.code, 'INVALID_BACKUP_JOB');
});

test('worker client requires summaryJobs counts and still rejects unknown or malformed success fields', async () => {
  const builtin = createRequire(import.meta.url)('node:worker_threads'), originalWorker = builtin.Worker;
  const common = { path: path.resolve('not-created'), sessions: 1, runHistory: 0, toolArtifacts: 0, summaryJobs: 1, audit: 0, workspaceEntries: 0 };
  try {
    for (const operation of ['backup', 'restore']) {
      const base = operation === 'backup' ? { ...common, sha256: 'a'.repeat(64), payloadSha256: 'b'.repeat(64), bytes: 1 } : { ...common, disabledProviders: 0 };
      for (const change of [value => delete value.summaryJobs, value => value.summaryJobs = -1, value => value.summaryJobs = 1.5,
        value => value.summaryJobs = Number.MAX_SAFE_INTEGER + 1, value => value.summaryJobs = '1', value => value.extra = 'untrusted']) {
        const result = structuredClone(base); change(result);
        builtin.Worker = class extends EventEmitter { constructor() { super(); queueMicrotask(() => { this.emit('message', { version: 1, ok: true, result }); this.emit('exit', 0); }); } };
        syncBuiltinESMExports();
        const args = operation === 'backup' ? { dataDir: path.resolve('not-read'), output: path.resolve('not-created') } : { input: path.resolve('not-read'), dataDir: path.resolve('not-created') };
        await assert.rejects(runBackupJob(operation, args), { code: 'BACKUP_WORKER_PROTOCOL' });
      }
    }
  } finally { builtin.Worker = originalWorker; syncBuiltinESMExports(); }
});
