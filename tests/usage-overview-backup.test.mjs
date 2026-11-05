// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { createBackup, restoreBackup, BACKUP_LIMITS } from '../server/backup.mjs';

const time = '2026-10-28T00:00:00.000Z';
const connection = { providerId: 'historic-provider', name: '已删除的历史连接', type: 'openai', model: 'historic-model', toolMode: 'none' };
const usage = { inputTokens: 13, outputTokens: 4, totalTokens: 17, cachedInputTokens: 3, cacheWriteInputTokens: null, reasoningOutputTokens: 2 };
const step = (id, value = usage) => ({ id, type: 'model', status: 'completed', title: '模型处理', detail: '', createdAt: time, usage: value });
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-usage-archive-'));
  t.after(async () => { const canonical = await fs.realpath(root); assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-usage-archive-[a-zA-Z0-9]+$/); await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace'); await fs.mkdir(workspace, { recursive: true });
  const store = new Store(dataDir), session = store.createSession();
  session.run = { id: 'current', status: 'completed', connection, steps: [step('m')] }; store.putSession(session);
  store.putRunHistory({ sessionId: session.id, run: { id: 'old', status: 'failed', steps: [step('missing', null), {}] }, approvals: [] });
  const expected = store.getUsageOverview().summary; store.close();
  return { root, dataDir, workspace, session, expected, output: path.join(root, 'archive.json'), restored: path.join(root, 'restored') };
}
function overview(dataDir) { const store = new Store(dataDir); try { return store.getUsageOverview(); } finally { store.close(); } }

test('schema6 backup excludes derived cache and rebuilds exact usage from canonical records on restore', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(path.join(f.dataDir, 'openaster.sqlite'));
  db.exec("UPDATE usage_runs SET stats_json='POISONED_DERIVED_CACHE';"); db.close();
  const before = await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'));
  await createBackup(f); assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')), before);
  const text = await fs.readFile(f.output, 'utf8'), archive = JSON.parse(text);
  assert.equal(archive.version, 9); assert.ok(!text.includes('POISONED_DERIVED_CACHE')); assert.ok(!text.includes('usage_runs')); assert.ok(!text.includes('usage_meta'));
  await restoreBackup({ input: f.output, dataDir: f.restored });
  assert.deepEqual(overview(f.restored).summary, f.expected);
  const restored = new DatabaseSync(path.join(f.restored, 'openaster.sqlite'), { readOnly: true });
  try { assert.equal(restored.prepare('PRAGMA user_version').get().user_version, 7); assert.equal(restored.prepare('SELECT count(*) AS n FROM usage_runs').get().n, 2); }
  finally { restored.close(); }
});

for (const version of [1, 2, 3, 4, 5]) test(`backup format v${version} restores usage projections without trusting a cache or fabricating sparse history`, async t => {
  const f = await fixture(t); await createBackup(f);
  const archive = JSON.parse(await fs.readFile(f.output, 'utf8')); archive.version = version; delete archive.payload.summaryJobs; delete archive.payload.steeringInputs;
  if (version < 4) delete archive.payload.toolArtifacts;
  if (version === 1) delete archive.payload.runHistory;
  archive.sha256 = createHash('sha256').update(JSON.stringify(archive.payload)).digest('hex'); await fs.writeFile(f.output, JSON.stringify(archive));
  await restoreBackup({ input: f.output, dataDir: f.restored });
  const stats = overview(f.restored).summary;
  assert.equal(stats.runs.total, version === 1 ? 1 : 2); assert.equal(stats.tokens.totalTokens.knownSum, '17');
  assert.equal(stats.stepsWithoutUsage, version === 1 ? 0 : 1); assert.equal(stats.unattributedRuns, version === 1 ? 0 : 1);
});

test('restoring active current records changes state to cancelled once and preserves missing-step coverage', async t => {
  const f = await fixture(t), store = new Store(f.dataDir), session = store.getSession(f.session.id);
  session.run = { id: 'active', status: 'running', connection, steps: [step('known'), { ...step('in-flight', null), status: 'running' }] };
  store.putSession(session); store.close();
  await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const stats = overview(f.restored).summary;
  assert.equal(stats.runs.total, 3); assert.equal(stats.runs.cancelled, 1); assert.equal(stats.runs.running, 0);
  assert.equal(stats.tokens.totalTokens.knownSum, '34'); assert.equal(stats.stepsWithoutUsage, 2);
  assert.deepEqual(overview(f.restored).summary, stats);
});

test('a physically large schema6 derived cache does not reduce the independent canonical backup budget', async t => {
  const f = await fixture(t), file = path.join(f.dataDir, 'openaster.sqlite');
  const db = new DatabaseSync(file);
  // A derived cache is intentionally not trusted. Allocate its storage inside
  // SQLite, not a giant JavaScript string or a full-database file read.
  db.prepare("UPDATE usage_runs SET stats_json=CAST(zeroblob(?) AS TEXT) WHERE run_id='current'").run(BACKUP_LIMITS.archiveBytes + 1024 * 1024);
  db.close();
  const size = (await fs.stat(file)).size; assert.ok(size > BACKUP_LIMITS.archiveBytes); assert.ok(size < BACKUP_LIMITS.sourceDatabaseBytes);
  const digest = async () => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
  const before = await digest();
  await createBackup(f); assert.equal(await digest(), before);
  assert.ok((await fs.stat(f.output)).size < 16384, 'only canonical logical records enter the archive');
  await restoreBackup({ input: f.output, dataDir: f.restored });
  assert.deepEqual(overview(f.restored).summary, f.expected);
});

test('each source database/sidecar above 512MiB is rejected before logical reads, while archive limit remains 128MiB', async t => {
  assert.equal(BACKUP_LIMITS.archiveBytes, 128 * 1024 * 1024); assert.equal(BACKUP_LIMITS.logicalBytes, 64 * 1024 * 1024);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = await fixture(t), file = path.join(f.dataDir, 'openaster.sqlite' + suffix);
    const handle = await fs.open(file, suffix ? 'wx' : 'r+');
    try { await handle.truncate(BACKUP_LIMITS.sourceDatabaseBytes + 1); } finally { await handle.close(); }
    await assert.rejects(createBackup(f), { code: 'BACKUP_LIMIT' }, suffix || 'main');
    await assert.rejects(fs.access(f.output), { code: 'ENOENT' });
  }
});
