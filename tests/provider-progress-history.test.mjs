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
import { createComputerWorkspace } from '../core/computer-workspace.mjs';
import { validateRunHistoryRecord } from '../core/run-history.mjs';
import { validateProviderConnection } from '../core/provider-retry.mjs';
import { CoreError } from '../core/errors.mjs';

async function until(check) { for (let index = 0; index < 1000; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Progress history fixture timed out'); }

test('retry metadata, public model explanation and an absolute write record survive backup without replaying external files', async t => {
  const tempRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tempRoot, 'openaster-progress-history-'));
  const dataDir = path.join(root, 'data'), workspacePath = path.join(dataDir, 'workspace'), external = path.join(root, 'outside');
  await fs.mkdir(workspacePath, { recursive: true }); await fs.mkdir(external);
  let store = new Store(dataDir), runtime;
  t.after(async () => { await runtime?.shutdown(); store?.close(); assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  store.putProvider({ id: 'fixture', name: 'Fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true });
  const session = store.createSession({ providerId: 'fixture' }), file = path.join(external, 'one.txt');
  const workspace = createComputerWorkspace({ workspace: createWorkspace(workspacePath), getFileAccess: () => 'computer' });
  let calls = 0;
  runtime = createRuntime({ workspace, providers: async id => store.getProvider(id), getSession: async id => store.getSession(id), saveSession: async (value, metadata) => store.putSession(value, metadata),
    limits: { providerRetryBaseMs: 1, providerRetryMaxMs: 1 }, providerCall: async () => {
      if (++calls === 1) throw new CoreError('PROVIDER_UNAVAILABLE', 'unavailable', 502);
      if (calls === 2) return { content: '我将创建这一份文件。', toolCalls: [{ id: 'write1', name: 'write_file', args: { path: file, content: 'approved' } }], wire: { type: 'openai', message: { reasoning_content: 'opaque private reasoning' } } };
      return { content: '已完成', toolCalls: [] };
    } });
  await runtime.start(session.id, { content: 'Create the fixture file' });
  await until(() => {
    const current = store.getSession(session.id);
    if (current.approvals.length === 1) return true;
    assert.ok(runtime.isActive(session.id), `Run ended without the expected approval: ${JSON.stringify({ status: current.run?.status, error: current.run?.error, failedSteps: current.run?.steps.filter(step => step.status === 'failed').map(step => ({ title: step.title, detail: step.detail })) })}`);
    return false;
  });
  await runtime.decide(store.getSession(session.id).approvals[0].id, 'approve');
  await until(() => !runtime.isActive(session.id));
  const saved = store.getSession(session.id); assert.equal(saved.run.status, 'completed');
  assert.equal(await fs.readFile(file, 'utf8'), 'approved');
  const history = store.getRunHistory(session.id, saved.run.id);
  assert.equal(history.run.steps[0].connection.retryCount, 1);
  assert.equal(history.run.steps[0].publicSummary, '我将创建这一份文件。');
  assert.ok(history.run.steps.every(step => step.finishedAt));
  assert.equal(history.approvals[0].path, file);
  assert.doesNotMatch(JSON.stringify(history), /opaque private reasoning/);
  assert.deepEqual(validateRunHistoryRecord(history), history);
  await runtime.shutdown(); store.close(); store = null;
  const backup = path.join(root, 'backup.json');
  await createBackup({ dataDir, workspace: workspacePath, output: backup });
  await fs.writeFile(file, 'changed after backup');
  const restoredDir = path.join(root, 'restored');
  await restoreBackup({ input: backup, dataDir: restoredDir });
  const restored = new Store(restoredDir);
  try { assert.deepEqual(restored.getRunHistory(session.id, saved.run.id), history); assert.deepEqual(restored.getSession(session.id).run.steps, saved.run.steps); }
  finally { restored.close(); }
  assert.equal(await fs.readFile(file, 'utf8'), 'changed after backup');
});

test('progress imports reject unknown fields, invalid counters and oversized disclosure', () => {
  const valid = { attempt: 2, retryCount: 1, startedAt: '2026-01-01T00:00:00.000Z', elapsedMs: 10, nextRetryAt: null };
  assert.deepEqual(validateProviderConnection(valid), valid);
  for (const corrupt of [{ ...valid, apiKey: 'not allowed' }, { ...valid, retryCount: 4 }, { ...valid, elapsedMs: -1 }, { ...valid, nextRetryAt: 'invalid' }, { ...valid, lastError: { code: 'INTERNAL_ERROR', message: 'not transport' } }, { ...valid, delayMs: 300001 }]) assert.throws(() => validateProviderConnection(corrupt), { code: 'INVALID_PROVIDER_PROGRESS' });
});
