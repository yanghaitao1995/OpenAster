// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const usage = values => ({ inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null, ...values });
const reported = usage({ inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: 3, cacheWriteInputTokens: 2, reasoningOutputTokens: 4 });
const now = '2026-10-27T00:00:00.000Z';
const modelStep = (id, extra = {}) => ({ id, type: 'model', title: '模型处理', detail: 'fixture', status: 'completed', createdAt: now, ...extra });
async function until(predicate) {
  for (let n = 0; n < 500; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Backup usage test timed out');
}
async function fixture(t) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-usage-backup-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent); assert.match(path.basename(resolved), /^openaster-usage-backup-[a-zA-Z0-9]+$/);
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const store = new Store(dataDir);
  store.putProvider({ id: 'fixture', name: 'Fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true });
  const session = store.createSession({ providerId: 'fixture' });
  session.run = { id: 'fixture-run', status: 'completed', steps: [modelStep('fixture-step', { usage: reported })], startedAt: now, finishedAt: now, output: null, error: null };
  store.putSession(session); store.close();
  return { root, dataDir, workspace, session, output: path.join(root, 'backup.json'), restored: path.join(root, 'restored') };
}
function readSession(dataDir, id) { const store = new Store(dataDir); try { return store.getSession(id); } finally { store.close(); } }
function updateSession(f, update) { const store = new Store(f.dataDir); try { const session = store.getSession(f.session.id); update(session); store.putSession(session); } finally { store.close(); } }

test('real runtime multi-turn usage roundtrips through offline backup without changing messages or source bytes', async t => {
  const f = await fixture(t), store = new Store(f.dataDir);
  let calls = 0;
  const runtime = createRuntime({
    workspace: f.workspace, providers: async id => store.getProvider(id), getSession: async id => store.getSession(id),
    saveSession: async (value, metadata) => store.putSession(value, metadata), audit: async value => store.audit(value),
    providerCall: async () => ++calls === 1 ? { content: '', toolCalls: [{ id: 'list1', name: 'list_workspace', args: {} }], usage: reported } : { content: '完成', toolCalls: [], usage: { outputTokens: 12, reasoningOutputTokens: 3 } },
    limits: { maxRunMs: 5000 }
  });
  let source;
  try { await runtime.start(f.session.id, { content: '读取目录' }); await until(() => !runtime.isActive(f.session.id)); source = store.getSession(f.session.id); }
  finally { await runtime.shutdown(); store.close(); }
  assert.equal(source.run.status, 'completed'); assert.equal(calls, 2);
  const before = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
  await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const restored = readSession(f.restored, f.session.id);
  assert.deepEqual(restored.run.steps, source.run.steps); assert.deepEqual(restored.messages, source.messages);
  assert.deepEqual(restored.run.steps.filter(step => step.type === 'model').map(step => step.usage), [reported, usage({ outputTokens: 12, reasoningOutputTokens: 3 })]);
  assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), before);
});

test('old missing usage, explicit unknown, partial counts and boundary values survive restore without becoming zero', async t => {
  const f = await fixture(t);
  updateSession(f, session => {
    session.run.id = 'active-fixture-run'; session.run.status = 'running'; session.run.finishedAt = null;
    session.run.steps = [modelStep('old'), modelStep('unknown', { usage: null, status: 'running' }), modelStep('partial', { usage: usage({ cachedInputTokens: 5 }) }), modelStep('boundary', { usage: usage({ inputTokens: 1e12, cachedInputTokens: 1e12, cacheWriteInputTokens: 1e12 }) }), { ...modelStep('tool', { usage: null }), type: 'tool' }];
  });
  await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const steps = readSession(f.restored, f.session.id).run.steps;
  assert.equal(Object.hasOwn(steps[0], 'usage'), false); assert.equal(steps[1].usage, null); assert.equal(steps[1].status, 'cancelled');
  assert.deepEqual(steps[2].usage, usage({ cachedInputTokens: 5 }));
  assert.deepEqual(steps[3].usage, usage({ inputTokens: 1e12, cachedInputTokens: 1e12, cacheWriteInputTokens: 1e12 }));
  assert.equal(steps[4].usage, null);
});

test('restore rejects malformed usage and inconsistent relationships even after the attacker recomputes checksum', async t => {
  const f = await fixture(t); await createBackup(f);
  const original = JSON.parse(await fs.readFile(f.output, 'utf8'));
  const invalid = [
    ['array', step => { step.usage = []; }],
    ['number', step => { step.usage = 1; }],
    ['string', step => { step.usage = 'unknown'; }],
    ['empty', step => { step.usage = {}; }],
    ['all-null', step => { step.usage = usage({}); }],
    ['missing-field', step => { delete step.usage.cachedInputTokens; }],
    ['extra-field', step => { step.usage.cost = 3; }],
    ['negative', step => { step.usage.inputTokens = -1; }],
    ['fraction', step => { step.usage.outputTokens = 0.5; }],
    ['numeric-string', step => { step.usage.inputTokens = '10'; }],
    ['boolean', step => { step.usage.cachedInputTokens = false; }],
    ['over-budget', step => { step.usage.inputTokens = 1e12 + 1; }],
    ['unsafe-integer', step => { step.usage.totalTokens = Number.MAX_SAFE_INTEGER + 1; }],
    ['total-smaller', step => { step.usage.totalTokens = 16; }],
    ['total-larger', step => { step.usage.totalTokens = 18; }],
    ['partial-total-smaller', step => { step.usage.outputTokens = null; step.usage.totalTokens = 9; }],
    ['cache-read-over-input', step => { step.usage.cachedInputTokens = 11; }],
    ['cache-write-over-input', step => { step.usage.cacheWriteInputTokens = 11; }],
    ['reasoning-over-output', step => { step.usage.reasoningOutputTokens = 8; }],
    ['total-under-cache-child', step => { step.usage = usage({ totalTokens: 0, cachedInputTokens: 1 }); }],
    ['total-under-cache-write-child', step => { step.usage = usage({ totalTokens: 0, cacheWriteInputTokens: 1 }); }],
    ['total-under-reasoning-child', step => { step.usage = usage({ totalTokens: 0, reasoningOutputTokens: 1 }); }],
    ['total-under-input-and-reasoning', step => { step.usage = usage({ inputTokens: 5, totalTokens: 6, reasoningOutputTokens: 4 }); }],
    ['total-under-output-and-cache', step => { step.usage = usage({ outputTokens: 5, totalTokens: 6, cachedInputTokens: 4 }); }],
    ['total-under-two-unknown-parents', step => { step.usage = usage({ totalTokens: 5, cachedInputTokens: 4, reasoningOutputTokens: 4 }); }],
    ['tool-with-usage', step => { step.type = 'tool'; }],
    ['unknown-step-field', step => { step.unapprovedField = true; }]
  ];
  const sourceBefore = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
  for (const [label, change] of invalid) {
    const envelope = structuredClone(original); change(envelope.payload.sessions[0].run.steps[0]);
    envelope.sha256 = hash(JSON.stringify(envelope.payload));
    const input = path.join(f.root, `${label}.json`), dataDir = path.join(f.root, `restore-${label}`);
    await fs.writeFile(input, JSON.stringify(envelope));
    const inputBefore = await fs.readFile(input);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' }, label);
    await assert.rejects(fs.lstat(dataDir), { code: 'ENOENT' }, label);
    assert.deepEqual(await fs.readFile(input), inputBefore, label);
  }
  assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), sourceBefore);
});

test('backup creation fails closed on invalid stored usage instead of silently dropping or repairing it', async t => {
  const f = await fixture(t);
  updateSession(f, session => { session.run.steps[0].usage = { ...reported, totalTokens: 999 }; });
  const before = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
  await assert.rejects(createBackup(f), { code: 'INVALID_BACKUP' });
  await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), before);
});
