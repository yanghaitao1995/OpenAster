// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, SUMMARY_STORAGE_LIMITS } from '../server/store.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { planSummaryDraft, createSummaryDraft, generateSummaryDraft, interruptSummaryDraft, validateSummaryDraft } from '../core/summary-draft.mjs';

const time = '2026-10-29T08:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const provider = { id: 'remote', name: 'Uncalled local fixture', type: 'openai', model: 'fixture', baseUrl: 'http://127.0.0.1:9/v1', enabled: true, toolMode: 'workspace', streaming: true };
const usage = { inputTokens: 10, outputTokens: 0, totalTokens: 10, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null };
const absent = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
const source = (id = randomUUID()) => ({ id, title: '独立摘要来源', providerId: provider.id, createdAt: time, updatedAt: time, run: null, approvals: [], messages: [
  { id: randomUUID(), role: 'user', content: 'PRIVATE_SOURCE_TEXT_not_a_job_field', createdAt: time },
  { id: randomUUID(), role: 'assistant', content: 'Original reply remains in source only.', createdAt: time },
] });
function initial(session, id = randomUUID()) {
  const plan = planSummaryDraft(session, { ...provider, apiKey: 'PRIVATE_PROVIDER_KEY' });
  return { plan, draft: createSummaryDraft(plan, { requestId: id, providerId: provider.id, expectedSourceHash: plan.preview.source.hash, expectedPlanHash: plan.preview.planHash }, { now: () => time }) };
}
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-summary-storage-'));
  const identity = await fs.lstat(root, { bigint: true }), stores = new Set();
  const f = { root, dataDir: path.join(root, 'data'), output: path.join(root, 'backup.json'), restored: path.join(root, 'restored'), session: source() };
  f.open = (directory = f.dataDir) => { const store = new Store(directory); stores.add(store); return store; };
  f.close = store => { store.close(); stores.delete(store); };
  await fs.mkdir(path.join(f.dataDir, 'workspace'), { recursive: true });
  await fs.writeFile(path.join(f.dataDir, 'workspace', 'note.txt'), 'original file\r\n');
  f.store = f.open(); f.store.putProvider(provider); f.store.putSession(f.session);
  t.after(async () => {
    for (const store of stores) store.close();
    const canonical = await fs.realpath(root), actual = await fs.lstat(root, { bigint: true });
    assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-summary-storage-[A-Za-z0-9]+$/u);
    assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
    await fs.rm(canonical, { recursive: true, force: true });
  });
  return f;
}
async function complete(f, session = f.session, id = randomUUID()) {
  const { plan, draft } = initial(session, id); f.store.putSummaryDraft(draft, { createOnly: true });
  return generateSummaryDraft(plan, provider, { draft, checkpoint: value => f.store.putSummaryDraft(value), providerCall: async () => ({ content: '\ufeff摘要\r\n保持原格式。', toolCalls: [], usage }) });
}
const readArchive = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function rewrite(file, value) { value.sha256 = hash(JSON.stringify(value.payload)); await fs.writeFile(file, JSON.stringify(value)); }

test('schema5 migrates transactionally to schema6 without rewriting task/history/usage records', async t => {
  const f = await fixture(t), before = f.store.exportSessionsWithHistory();
  f.store.db.exec('DROP TABLE summary_jobs; PRAGMA user_version=5;'); f.close(f.store);
  const reopened = f.open(); assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual(reopened.exportSessionsWithHistory(), before); assert.equal(reopened.getUsageOverview().summary.runs.total, 0);
  assert.equal(reopened.db.prepare("PRAGMA foreign_key_list('summary_jobs')").get().on_delete, 'CASCADE');
});

test('future schema7 and missing schema6 job table refuse before writable database changes', async t => {
  for (const kind of ['future', 'missing', 'shape']) {
    const f = await fixture(t); f.close(f.store); const file = path.join(f.dataDir, 'openaster.sqlite'), db = new DatabaseSync(file);
    if (kind === 'future') db.exec('PRAGMA user_version=8;');
    if (kind === 'missing') db.exec('DROP TABLE summary_jobs;');
    if (kind === 'shape') db.exec('ALTER TABLE summary_jobs ADD COLUMN unexpected TEXT;');
    db.close(); const before = await fs.readFile(file);
    assert.throws(() => f.open(), { code: kind === 'future' ? 'UNSUPPORTED_DATABASE_VERSION' : 'INVALID_SUMMARY_JOBS' });
    assert.deepEqual(await fs.readFile(file), before);
  }
});

test('job checkpoints persist independently and usage is counted once without source text or credentials', async t => {
  const f = await fixture(t), before = f.store.getSession(f.session.id), completed = await complete(f);
  assert.deepEqual(f.store.getSession(f.session.id), before); assert.equal(f.store.listRunHistory(f.session.id).runs.length, 0);
  const persisted = f.store.getSummaryDraft(f.session.id, completed.id); assert.deepEqual(persisted, completed);
  assert.equal(JSON.stringify(persisted).includes('PRIVATE_SOURCE_TEXT'), false); assert.equal(JSON.stringify(persisted).includes('PRIVATE_PROVIDER_KEY'), false);
  f.store.putSummaryDraft(persisted);
  const stats = f.store.getUsageOverview().summary; assert.equal(stats.runs.total, 1); assert.equal(stats.runs.completed, 1);
  assert.equal(stats.modelSteps, 1); assert.equal(stats.tokens.outputTokens.knownSum, '0'); assert.equal(stats.tokens.totalTokens.knownSum, '10');
  assert.equal(f.store.db.prepare('SELECT source FROM usage_runs WHERE run_id=?').get(completed.id).source, 'summary');
  persisted.summary = 'caller changed its copy'; assert.equal(f.store.getSummaryDraft(f.session.id, completed.id).summary, completed.summary);
});

test('terminal jobs, immutable planning fields and completed steps cannot be rewritten or retried', async t => {
  const f = await fixture(t), completed = await complete(f), prior = f.store.exportSessionsWithHistory();
  assert.throws(() => f.store.putSummaryDraft(initial(f.session, completed.id).draft, { createOnly: true }), { code: 'SUMMARY_JOB_ID_CONFLICT' });
  assert.throws(() => f.store.putSummaryDraft(initial(f.session, completed.id).draft), { code: 'SUMMARY_JOB_IMMUTABLE' });
  const changed = structuredClone(completed); changed.summary += 'changed'; changed.summaryHash = hash(changed.summary); changed.steps[0].output = changed.summary; changed.steps[0].outputHash = changed.summaryHash;
  assert.throws(() => f.store.putSummaryDraft(changed), { code: 'SUMMARY_JOB_IMMUTABLE' });
  const { draft } = initial(f.session); f.store.putSummaryDraft(draft);
  const newer = initial({ ...f.session, title: 'Changed source title' }, draft.id).draft;
  assert.throws(() => f.store.putSummaryDraft(newer), { code: 'SUMMARY_JOB_IMMUTABLE' });
  assert.deepEqual(f.store.getSummaryDraft(f.session.id, completed.id), prior.summaryJobs[0]);
});

test('completed part output and usage survive failure and cannot be changed by later checkpoints', async t => {
  const f = await fixture(t), large = structuredClone(f.session); large.messages[0].content = 'a'.repeat(200000); large.messages[1].content = 'b'.repeat(200000);
  f.store.putSession(large); const { plan, draft } = initial(large); f.store.putSummaryDraft(draft); let calls = 0, partCheckpoint;
  const failed = await generateSummaryDraft(plan, provider, { draft, checkpoint: value => { f.store.putSummaryDraft(value); if (value.status === 'running' && value.steps[0]?.status === 'completed') partCheckpoint = structuredClone(value); },
    providerCall: async () => { if (++calls === 2) throw Error('private upstream failure'); return { content: 'first part', toolCalls: [], usage }; } });
  assert.equal(failed.status, 'failed'); assert.equal(failed.steps[0].output, 'first part'); assert.deepEqual(failed.steps[0].usage, usage); assert.equal(failed.steps[1].usage, null);
  assert.equal(f.store.getUsageOverview().summary.tokens.totalTokens.knownSum, '10'); assert.equal(f.store.getUsageOverview().summary.stepsWithoutUsage, 1);
  assert.ok(partCheckpoint); const another = initial(large); another.draft.steps = structuredClone(partCheckpoint.steps); f.store.putSummaryDraft(another.draft);
  const changed = structuredClone(another.draft); changed.steps[0].output += ' changed'; changed.steps[0].outputHash = hash(changed.steps[0].output);
  assert.throws(() => f.store.putSummaryDraft(changed), { code: 'SUMMARY_JOB_IMMUTABLE' });
});

test('restart cancels in-flight requests without replay and preserves received usage and terminal jobs', async t => {
  const f = await fixture(t), completed = await complete(f), { plan, draft } = initial(f.session); f.store.putSummaryDraft(draft);
  const active = structuredClone(draft), part = plan.preview.parts[0];
  active.steps.push({ id: randomUUID(), type: 'model', stage: 'final', partIndex: null, status: 'running', startedAt: time, finishedAt: null, requestBytes: part.requestBytes, requestSha256: part.requestSha256, usage, output: null, outputHash: null, error: null });
  f.store.putSummaryDraft(active); f.close(f.store);
  const reopened = f.open(), stopped = reopened.getSummaryDraft(f.session.id, active.id);
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.steps[0].status, 'cancelled'); assert.deepEqual(stopped.steps[0].usage, usage);
  assert.equal(stopped.error.code, 'SERVICE_RESTARTED'); assert.deepEqual(reopened.getSummaryDraft(f.session.id, completed.id), completed);
  assert.equal(reopened.getUsageOverview().summary.runs.total, 2); assert.equal(reopened.getUsageOverview().summary.tokens.totalTokens.knownSum, '20');
  f.close(reopened); const again = f.open(); assert.deepEqual(again.getSummaryDraft(f.session.id, active.id), stopped);
});

test('job ids reject collisions with current and historical runs in both directions', async t => {
  const f = await fixture(t), { draft } = initial(f.session, 'same-id'); f.store.putSummaryDraft(draft);
  for (const status of ['running', 'completed']) {
    const candidate = structuredClone(f.session); candidate.run = { id: draft.id, status, steps: [] };
    assert.throws(() => f.store.putSession(candidate), { code: 'SUMMARY_JOB_ID_CONFLICT' });
  }
  assert.throws(() => f.store.putRunHistory({ sessionId: f.session.id, run: { id: draft.id, status: 'failed' }, approvals: [] }), { code: 'SUMMARY_JOB_ID_CONFLICT' });
  const other = source(); f.store.putSession(other); const current = { ...other, run: { id: 'current-id', status: 'running', steps: [] } }; f.store.putSession(current);
  assert.throws(() => f.store.putSummaryDraft(initial(other, 'current-id').draft), { code: 'SUMMARY_JOB_ID_CONFLICT' });
  f.store.putRunHistory({ sessionId: other.id, run: { id: 'history-id', status: 'completed' }, approvals: [] });
  assert.throws(() => f.store.putSummaryDraft(initial(other, 'history-id').draft), { code: 'SUMMARY_JOB_ID_CONFLICT' });
  f.store.putSummaryDraft(initial(other, draft.id).draft); assert.ok(f.store.getSummaryDraft(other.id, draft.id), 'ids are scoped to the source task');
});

test('job plus usage writes are atomic inside nested transactions and persistence failure prevents dispatch', async t => {
  const f = await fixture(t), { plan, draft } = initial(f.session); f.store.putSummaryDraft(draft);
  const before = f.store.getUsageOverview().summary;
  f.store.db.exec("CREATE TRIGGER reject_summary_usage BEFORE UPDATE ON usage_runs WHEN NEW.source='summary' BEGIN SELECT RAISE(ABORT,'fixture usage failure'); END;");
  let calls = 0;
  await assert.rejects(generateSummaryDraft(plan, provider, { draft, checkpoint: value => f.store.putSummaryDraft(value), providerCall: async () => { calls++; throw Error('should not call'); } }), { code: 'SUMMARY_SAVE_FAILED' });
  assert.equal(calls, 0); assert.deepEqual(f.store.getSummaryDraft(f.session.id, draft.id), draft); assert.deepEqual(f.store.getUsageOverview().summary, before);
  f.store.db.exec('DROP TRIGGER reject_summary_usage;');
  const terminal = interruptSummaryDraft(draft);
  assert.throws(() => f.store.transaction(() => { f.store.putSummaryDraft(terminal); throw Error('outer rollback'); }), /outer rollback/);
  assert.deepEqual(f.store.getSummaryDraft(f.session.id, draft.id), draft); assert.deepEqual(f.store.getUsageOverview().summary, before);
});

test('running jobs reserve complete-record capacity before calls and terminal completion releases it', async t => {
  const f = await fixture(t), jobs = [];
  f.store.transaction(() => { for (let i = 0; i < SUMMARY_STORAGE_LIMITS.bytes / SUMMARY_STORAGE_LIMITS.jobBytes; i++) { const job = initial(f.session, `reserved-${i}`).draft; f.store.putSummaryDraft(job); jobs.push(job); } });
  const extra = initial(f.session, 'reserved-overflow').draft;
  assert.throws(() => f.store.putSummaryDraft(extra), { code: 'SUMMARY_JOB_LIMIT', status: 413 });
  f.store.putSummaryDraft(interruptSummaryDraft(jobs[0]));
  assert.throws(() => f.store.putSummaryDraft(extra), { code: 'SUMMARY_JOB_LIMIT' }, 'the terminal receipt still occupies its actual bytes');
  f.store.putSummaryDraft(interruptSummaryDraft(jobs[1])); f.store.putSummaryDraft(extra); assert.ok(f.store.getSummaryDraft(f.session.id, extra.id));
});

test('per-source and workspace job count caps reject whole inserts rather than dropping receipts', async t => {
  const f = await fixture(t);
  f.store.transaction(() => { for (let i = 0; i < 100; i++) f.store.putSummaryDraft(interruptSummaryDraft(initial(f.session, `count-${i}`).draft)); });
  assert.throws(() => f.store.putSummaryDraft(initial(f.session, 'too-many').draft), { code: 'SUMMARY_JOB_LIMIT' });
  f.store.transaction(() => { for (let group = 1; group < 10; group++) { const session = source(`source-${group}`); f.store.putSession(session); for (let i = 0; i < 100; i++) f.store.putSummaryDraft(interruptSummaryDraft(initial(session, `count-${i}`).draft)); } });
  const another = source('overflow-source'); f.store.putSession(another);
  assert.throws(() => f.store.putSummaryDraft(initial(another).draft), { code: 'SUMMARY_JOB_LIMIT' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM summary_jobs').get().n, 1000);
});

test('job pagination is source-bound and source deletion cascades receipts and their usage only', async t => {
  const f = await fixture(t); for (const id of ['a', 'b', 'c']) f.store.putSummaryDraft(interruptSummaryDraft(initial(f.session, id).draft));
  const other = source(); f.store.putSession(other); await complete(f, other);
  const first = f.store.listSummaryDrafts(f.session.id, { limit: 2 }); assert.deepEqual(first.drafts.map(job => job.id), ['c', 'b']);
  assert.deepEqual(f.store.listSummaryDrafts(f.session.id, { limit: 2, cursor: first.nextCursor }).drafts.map(job => job.id), ['a']);
  assert.throws(() => f.store.listSummaryDrafts(other.id, { cursor: first.nextCursor }), { code: 'INVALID_CURSOR' });
  f.store.deleteSession(f.session.id); assert.deepEqual(f.store.listSummaryDrafts(f.session.id), { drafts: [], nextCursor: null });
  assert.equal(f.store.getUsageOverview().summary.runs.total, 1); assert.equal(f.store.listSummaryDrafts(other.id).drafts.length, 1);
});

test('online export counts summary bytes and returns every job without duplicating run history', async t => {
  const f = await fixture(t), completed = await complete(f), exported = f.store.exportSessionsWithHistory();
  assert.deepEqual(exported.summaryJobs, [completed]); assert.deepEqual(exported.runHistory, []);
  const byteCount = Buffer.byteLength(JSON.stringify(f.session)) + Buffer.byteLength(JSON.stringify(completed));
  assert.deepEqual(f.store.exportSessionsWithHistory({ maxBytes: byteCount }), exported);
  assert.throws(() => f.store.exportSessionsWithHistory({ maxBytes: byteCount - 1 }), { code: 'EXPORT_TOO_LARGE' });
});

test('source edits and provider removal preserve descriptive job snapshots without changing model usage', async t => {
  const f = await fixture(t), completed = await complete(f), sourceAfter = structuredClone(f.session);
  sourceAfter.title = 'Source renamed later'; sourceAfter.messages.push({ id: randomUUID(), role: 'user', content: 'Later source message', createdAt: time });
  sourceAfter.providerId = 'demo'; f.store.putSession(sourceAfter); f.store.deleteProvider(provider.id);
  assert.deepEqual(f.store.getSummaryDraft(f.session.id, completed.id), completed); assert.equal(f.store.getUsageOverview().summary.tokens.totalTokens.knownSum, '10');
  f.close(f.store); await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const restored = f.open(f.restored); assert.deepEqual(restored.getSummaryDraft(f.session.id, completed.id), completed);
  assert.deepEqual(restored.getSession(f.session.id), sourceAfter); assert.equal(restored.getProvider(provider.id), null);
});

test('startup rejects oversized and excessive SQL job records before any recovery rewrite', async t => {
  for (const kind of ['bytes', 'per-source', 'reserved']) {
    const f = await fixture(t), { draft } = initial(f.session); f.store.putSummaryDraft(draft); f.close(f.store);
    const file = path.join(f.dataDir, 'openaster.sqlite'), db = new DatabaseSync(file);
    if (kind === 'bytes') db.exec(`UPDATE summary_jobs SET value=zeroblob(${SUMMARY_STORAGE_LIMITS.jobBytes + 1});`);
    else {
      const count = kind === 'per-source' ? 101 : 65; db.exec('DELETE FROM summary_jobs;');
      const insert = db.prepare('INSERT INTO summary_jobs(session_id,id,created_at,status,value) VALUES(?,?,?,?,?)');
      db.exec('BEGIN;'); for (let i = 0; i < count; i++) insert.run(f.session.id, `injected-${i}`, time, kind === 'reserved' ? 'running' : 'completed', '{}'); db.exec('COMMIT;');
    }
    db.close(); const before = await fs.readFile(file);
    assert.throws(() => f.open(), { code: 'INVALID_SUMMARY_JOBS' }); assert.deepEqual(await fs.readFile(file), before);
  }
});

test('v8 backup preserves terminal drafts and cancels active ones while rebuilding usage without network or replay', async t => {
  const f = await fixture(t), completed = await complete(f), { draft } = initial(f.session); f.store.putSummaryDraft(draft); f.close(f.store);
  const before = await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')); const backup = await createBackup(f), archive = await readArchive(f.output);
  assert.equal(archive.version, 9); assert.equal(backup.summaryJobs, 2); assert.equal(archive.payload.summaryJobs.length, 2);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')), before);
  const result = await restoreBackup({ input: f.output, dataDir: f.restored }); assert.equal(result.summaryJobs, 2);
  const restored = f.open(f.restored); assert.deepEqual(restored.getSummaryDraft(f.session.id, completed.id), completed);
  const cancelled = restored.getSummaryDraft(f.session.id, draft.id); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error.code, 'BACKUP_RESTORED');
  assert.equal(restored.getProvider(provider.id).enabled, false); assert.deepEqual(restored.getSession(f.session.id), f.session);
  assert.deepEqual(restored.listRunHistory(f.session.id).runs, []); assert.equal(restored.getUsageOverview().summary.runs.total, 2);
  assert.equal(restored.getUsageOverview().summary.tokens.totalTokens.knownSum, '10'); assert.equal(await fs.readFile(path.join(f.restored, 'workspace', 'note.txt'), 'utf8'), 'original file\r\n');
});

test('v1 through v6 archives remain compatible but strictly reject a smuggled summaryJobs field', async t => {
  const f = await fixture(t); f.close(f.store); await createBackup(f); const original = await readArchive(f.output);
  for (let version = 1; version <= 6; version++) {
    const archive = structuredClone(original); archive.version = version; delete archive.payload.summaryJobs; delete archive.payload.steeringInputs;
    if (version < 2) delete archive.payload.runHistory; if (version < 4) delete archive.payload.toolArtifacts;
    const input = path.join(f.root, `legacy-${version}.json`), target = path.join(f.root, `legacy-${version}`);
    await rewrite(input, archive); await restoreBackup({ input, dataDir: target }); const restored = f.open(target); assert.deepEqual(restored.listSummaryDrafts(f.session.id).drafts, []); f.close(restored);
    archive.payload.summaryJobs = []; await rewrite(input, archive); const bad = path.join(f.root, `smuggle-${version}`);
    await assert.rejects(restoreBackup({ input, dataDir: bad }), { code: 'INVALID_BACKUP' }); await absent(bad);
  }
});

test('tampered summary shapes, usage, source links and job/run collisions fail before target creation', async t => {
  const f = await fixture(t); await complete(f); f.close(f.store); await createBackup(f); const original = await readArchive(f.output);
  const changes = [
    p => p.summaryJobs[0].apiKey = 'never accepted', p => p.summaryJobs[0].summaryHash = '0'.repeat(64), p => p.summaryJobs[0].requestHash = '0'.repeat(64),
    p => p.summaryJobs[0].steps[0].usage.totalTokens = 999, p => p.summaryJobs[0].steps[0].usage = { inputTokens: 1 },
    p => p.summaryJobs[0].preview.parts[0].offset = 1, p => p.summaryJobs.push(structuredClone(p.summaryJobs[0])),
    p => { const job = p.summaryJobs[0]; p.sessions[0].run = { id: job.id, status: 'completed' }; },
    p => p.runHistory.push({ sessionId: p.sessions[0].id, run: { id: p.summaryJobs[0].id, status: 'completed' }, approvals: [] }),
    p => { const job = p.summaryJobs[0]; const missingSource = source('deleted-source'); p.summaryJobs[0] = interruptSummaryDraft(initial(missingSource, job.id).draft); },
    p => p.summaryJobs = null,
  ];
  for (const [index, change] of changes.entries()) {
    const archive = structuredClone(original); change(archive.payload); const input = path.join(f.root, `bad-${index}.json`), target = path.join(f.root, `bad-${index}`);
    await rewrite(input, archive); await assert.rejects(restoreBackup({ input, dataDir: target }), { code: 'INVALID_BACKUP' }, `mutation ${index}`); await absent(target);
  }
});

test('malformed SQL job metadata, oversized rows and missing schema fail readonly export without changing source', async t => {
  for (const kind of ['metadata', 'shape', 'json', 'size', 'missing']) {
    const f = await fixture(t); await complete(f); f.close(f.store); const file = path.join(f.dataDir, 'openaster.sqlite'), db = new DatabaseSync(file);
    if (kind === 'metadata') db.exec("UPDATE summary_jobs SET status='failed';");
    if (kind === 'shape') db.exec('ALTER TABLE summary_jobs ADD COLUMN untrusted TEXT;');
    if (kind === 'json') db.exec("UPDATE summary_jobs SET value='{\"steps\":null}';");
    if (kind === 'size') db.exec(`UPDATE summary_jobs SET value=zeroblob(${SUMMARY_STORAGE_LIMITS.jobBytes + 1000});`);
    if (kind === 'missing') db.exec('DROP TABLE summary_jobs;'); db.close(); const before = await fs.readFile(file);
    await assert.rejects(createBackup(f), { code: 'INVALID_BACKUP' }); await absent(f.output); assert.deepEqual(await fs.readFile(file), before);
  }
});

test('summary restore failure rolls back all imported data and removes only its owned new target', async t => {
  const f = await fixture(t); await complete(f); f.close(f.store); await createBackup(f); const before = await fs.readFile(f.output);
  const original = Store.prototype.putSummaryDraft; t.mock.method(Store.prototype, 'putSummaryDraft', function(value, options) { original.call(this, value, options); throw Error('fixture summary import failure'); });
  await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), /fixture summary import failure/); await absent(f.restored); assert.deepEqual(await fs.readFile(f.output), before);
});
