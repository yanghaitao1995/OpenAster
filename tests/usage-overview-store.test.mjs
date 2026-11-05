// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { createUsageProjection, emptyUsageStats, mergeUsageStats, parseUsageStats, USAGE_COUNTERS, USAGE_OVERVIEW_LIMITS } from '../core/usage-overview.mjs';

const time = '2026-10-28T00:00:00.000Z';
const connection = { providerId: 'historic-provider', name: '原连接', type: 'openai', model: 'model-one', toolMode: 'workspace' };
const usage = value => Object.fromEntries(USAGE_COUNTERS.map(key => [key, value[key] ?? null]));
const model = value => ({ type: 'model', usage: value === null ? null : usage(value) });
const run = (id, extra = {}) => ({ id, status: 'completed', connection, startedAt: time, ...extra });
const record = (sessionId, value) => ({ sessionId, run: value, approvals: [] });
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-usage-overview-'));
  let store = new Store(root);
  t.after(async () => { store?.close(); const canonical = await fs.realpath(root); assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-usage-overview-[a-zA-Z0-9]+$/); await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, get store() { return store; }, close() { store?.close(); store = null; }, open() { store = new Store(root); return store; } };
}

test('usage projection distinguishes unknown, zero, partial parents and unclassified legacy steps', () => {
  const value = createUsageProjection('session', run('run', { status: 'failed', steps: [
    model({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), model({ inputTokens: 5, cachedInputTokens: 3 }),
    model({ outputTokens: 7, reasoningOutputTokens: 2 }), model(null), { type: 'tool', usage: usage({ totalTokens: 999 }) }, {},
  ] }));
  const stats = value.stats;
  assert.equal(stats.modelSteps, 4); assert.equal(stats.stepsWithAnyUsage, 3); assert.equal(stats.stepsWithCompleteUsage, 1); assert.equal(stats.stepsWithoutUsage, 1);
  assert.equal(stats.unclassifiedSteps, 1); assert.deepEqual(stats.tokens.totalTokens, { knownSum: '0', reportedSteps: 1, missingSteps: 3 });
  assert.deepEqual(stats.tokens.inputTokens, { knownSum: '5', reportedSteps: 2, missingSteps: 2 });
  assert.equal(stats.tokens.cachedInputTokens.knownSum, '3'); assert.equal(stats.tokens.reasoningOutputTokens.knownSum, '2');
  assert.deepEqual(parseUsageStats(JSON.stringify(stats)), stats);
  const legacy = createUsageProjection('session', { id: 'old', status: 'cancelled' });
  assert.equal(legacy.connection, null); assert.equal(legacy.groupKey, 'unknown'); assert.equal(legacy.stats.unattributedRuns, 1); assert.equal(legacy.stats.runsWithoutStepData, 1);
  assert.equal(legacy.stats.tokens.totalTokens.knownSum, null); assert.equal(legacy.stats.modelSteps, 0);
  const demo = createUsageProjection('session', run('demo', { connection: { ...connection, type: 'demo' }, steps: [{ type: 'tool' }] }));
  assert.equal(demo.stats.demoRuns, 1); assert.equal(demo.stats.modelSteps, 0); assert.equal(demo.stats.runsWithoutStepData, 0);
  assert.throws(() => createUsageProjection('s', { status: 'completed' }), { code: 'INVALID_USAGE_PROJECTION' });
  assert.throws(() => parseUsageStats(JSON.stringify({ ...stats, modelSteps: -1 })), { code: 'INVALID_USAGE_PROJECTION' });
  for (const mutate of [
    value => { value.stepsWithAnyUsage = 0; value.stepsWithoutUsage = value.modelSteps; },
    value => { value.stepsWithCompleteUsage = 2; },
    value => { value.runsWithoutStepData = 1; },
    value => { value.unattributedRuns = 1; value.demoRuns = 1; },
  ]) { const broken = structuredClone(stats); mutate(broken); assert.throws(() => parseUsageStats(JSON.stringify(broken)), { code: 'INVALID_USAGE_PROJECTION' }); }
});

test('empty workspace has no invented zero token total and a stable snapshot', async t => {
  const f = await fixture(t), first = f.store.getUsageOverview();
  assert.deepEqual(first.summary, emptyUsageStats()); assert.deepEqual(first.groups, []); assert.equal(first.nextCursor, null);
  assert.equal(first.scope, 'retained-workspace-runs'); assert.deepEqual(f.store.getUsageOverview(), first);
});

test('current and terminal history share one run identity, including failures without reported usage', async t => {
  const f = await fixture(t), session = f.store.createSession();
  session.run = run('first', { status: 'running', steps: [model({ inputTokens: 9, outputTokens: 3, totalTokens: 12 }), model(null)] });
  f.store.putSession(session);
  assert.equal(f.store.getUsageOverview().summary.runs.running, 1);
  session.run.status = 'awaiting_approval'; f.store.putSession(session);
  assert.equal(f.store.getUsageOverview().summary.runs.awaitingApproval, 1);
  session.run.status = 'failed'; f.store.putSession(session); f.store.putSession(session);
  let stats = f.store.getUsageOverview().summary;
  assert.equal(stats.runs.total, 1); assert.equal(stats.runs.failed, 1); assert.equal(stats.modelSteps, 2); assert.equal(stats.stepsWithoutUsage, 1); assert.equal(stats.tokens.totalTokens.knownSum, '12');
  session.run = run('second', { status: 'running', steps: [model({ totalTokens: 0 })] }); f.store.putSession(session);
  stats = f.store.getUsageOverview().summary; assert.equal(stats.runs.total, 2); assert.equal(stats.tokens.totalTokens.reportedSteps, 2);
  session.run = run('replacement', { status: 'running', steps: [] }); f.store.putSession(session);
  assert.equal(f.store.getUsageOverview().summary.runs.total, 2, 'orphaned nonhistory current projection is removed');
  session.run = null; f.store.putSession(session);
  assert.equal(f.store.getUsageOverview().summary.runs.total, 1, 'historical run remains after clearing current run');
});

test('full immutable connection tuple groups renamed/model-switched runs and survives provider deletion', async t => {
  const f = await fixture(t), session = f.store.createSession();
  for (const [id, snapshot] of [['one', connection], ['two', { ...connection, name: '新名字' }], ['three', { ...connection, model: 'new-model' }], ['four', { ...connection, toolMode: 'none' }]]) f.store.putRunHistory(record(session.id, run(id, { connection: snapshot, steps: [model({ totalTokens: 1 })] })));
  f.store.putRunHistory(record(session.id, { id: 'legacy', status: 'completed', steps: [{}] }));
  const before = f.store.getUsageOverview(); assert.equal(before.groups.length, 5); assert.equal(before.summary.unattributedRuns, 1);
  f.store.putProvider({ ...connection, id: connection.providerId, name: '当前名字' }); f.store.deleteProvider(connection.providerId); f.store.reassignProvider(connection.providerId, 'demo');
  assert.deepEqual(f.store.getUsageOverview(), before);
  assert.ok(before.groups.some(group => group.connection?.name === '原连接')); assert.ok(!JSON.stringify(before).includes('当前名字'));
  f.store.deleteSession(session.id);
  const after = f.store.getUsageOverview(); assert.equal(after.summary.runs.total, 0); assert.notEqual(after.snapshotId, before.snapshotId);
});

test('stream output and unrelated session edits do not rewrite projection or advance revision; reads never load bodies', async t => {
  const f = await fixture(t), session = f.store.createSession();
  session.run = run('active', { status: 'running', steps: [{ id: 'm', ...model(null), detail: 'PRIVATE_BODY'.repeat(20000) }], output: { stepId: 'm', content: 'first', status: 'streaming' } });
  f.store.putSession(session); const first = f.store.getUsageOverview();
  session.run.output.content = 'second'; session.title = 'renamed'; f.store.putSession(session);
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => { if (/\b(?:sessions|run_history|tool_artifacts)\b/iu.test(sql)) throw new Error('overview must use only compact projections'); return prepare(sql); };
  try { assert.deepEqual(f.store.getUsageOverview(), first); assert.ok(!JSON.stringify(first).includes('PRIVATE_BODY')); }
  finally { f.store.db.prepare = prepare; }
});

test('group pagination is exact, rejects foreign/stale/noncanonical cursors and returns defensive copies', async t => {
  const f = await fixture(t), other = await fixture(t), session = f.store.createSession();
  for (let n = 0; n < 7; n++) f.store.putRunHistory(record(session.id, run('r' + n, { connection: { ...connection, model: 'model-' + n }, steps: [model({ totalTokens: n })] })));
  const first = f.store.getUsageOverview({ limit: 2 }); assert.equal(first.groups.length, 2); assert.ok(first.nextCursor);
  const keys = first.groups.map(group => group.key); let cursor = first.nextCursor;
  while (cursor) { const page = f.store.getUsageOverview({ limit: 2, cursor }); assert.deepEqual(page.summary, first.summary); keys.push(...page.groups.map(group => group.key)); cursor = page.nextCursor; }
  assert.equal(keys.length, 7); assert.equal(new Set(keys).size, 7); assert.equal(first.summary.tokens.totalTokens.knownSum, '21');
  assert.throws(() => other.store.getUsageOverview({ cursor: first.nextCursor }), { code: 'INVALID_USAGE_CURSOR' });
  for (const invalid of ['', 'a', 'x'.repeat(1025), first.nextCursor + '=', Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(first.nextCursor, 'base64url')), extra: true })).toString('base64url')]) assert.throws(() => f.store.getUsageOverview({ cursor: invalid }), { code: 'INVALID_USAGE_CURSOR' });
  first.summary.runs.total = 999; assert.equal(f.store.getUsageOverview().summary.runs.total, 7);
  f.store.putRunHistory(record(session.id, run('new')));
  assert.throws(() => f.store.getUsageOverview({ cursor: first.nextCursor }), { code: 'USAGE_SNAPSHOT_CHANGED', status: 409 });
});

for (const version of [2, 3]) test(`schema ${version} migration backfills all history and absent-current fallback, then remains idempotent`, async t => {
  const f = await fixture(t), session = f.store.createSession();
  f.store.putRunHistory(record(session.id, run('history', { steps: [model({ inputTokens: 5 })] })));
  session.run = run('legacy-current', { steps: [model(null)] }); f.store.putSession(session);
  f.store.db.prepare('DELETE FROM run_history WHERE run_id=?').run('legacy-current');
  f.store.db.exec(`DROP TABLE usage_runs; DROP TABLE usage_meta; PRAGMA user_version=${version};`); f.close();
  const upgraded = f.open(); assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 7);
  const before = upgraded.getUsageOverview(); assert.equal(before.summary.runs.total, 2); assert.equal(before.summary.modelSteps, 2);
  assert.equal(before.summary.tokens.inputTokens.knownSum, '5'); f.close();
  assert.deepEqual(f.open().getUsageOverview().summary, before.summary);
});

test('restart cancels current active run without losing known counters or doubling its history', async t => {
  const f = await fixture(t), session = f.store.createSession();
  session.run = run('active', { status: 'running', steps: [model({ totalTokens: 11 }), { ...model(null), status: 'running' }] });
  f.store.putSession(session); f.close();
  let stats = f.open().getUsageOverview().summary;
  assert.equal(stats.runs.total, 1); assert.equal(stats.runs.cancelled, 1); assert.equal(stats.modelSteps, 2); assert.equal(stats.tokens.totalTokens.knownSum, '11'); f.close();
  stats = f.open().getUsageOverview().summary; assert.equal(stats.runs.total, 1);
});

test('failed projection writes roll back session/history and failed migration preserves canonical data/version', async t => {
  const f = await fixture(t), session = f.store.createSession(), before = f.store.getUsageOverview();
  f.store.db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON usage_runs BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
  session.run = run('failed-insert', { steps: [model({ totalTokens: 9 })] });
  assert.throws(() => f.store.putSession(session), /fixture rollback/u);
  assert.equal(f.store.getSession(session.id).run, null); assert.equal(f.store.getRunHistory(session.id, session.run.id), null); assert.deepEqual(f.store.getUsageOverview(), before);
  f.store.db.exec('DROP TRIGGER fail_usage; DROP TABLE usage_runs; DROP TABLE usage_meta; PRAGMA user_version=3;');
  const bad = JSON.stringify({ ...session, run: { id: 'bad', status: 'completed', connection: null } });
  f.store.db.prepare('UPDATE sessions SET value=? WHERE id=?').run(bad, session.id); f.close();
  assert.throws(() => f.open(), { code: 'INVALID_USAGE_PROJECTION' });
  const db = new DatabaseSync(path.join(f.root, 'openaster.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3); assert.equal(db.prepare('SELECT value FROM sessions WHERE id=?').get(session.id).value, bad); assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='usage_runs'").get(), undefined); }
  finally { db.close(); }
});

test('overview limits reject the entire read before parsing and never prevent canonical writes', async t => {
  const f = await fixture(t), session = f.store.createSession();
  f.store.db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
    INSERT INTO usage_runs(session_id,run_id,source,group_key,connection_json,stats_json) SELECT ?,CAST(x AS TEXT),'history','unknown','null','{}' FROM n`).run(USAGE_OVERVIEW_LIMITS.runs + 1, session.id);
  assert.throws(() => f.store.getUsageOverview(), { code: 'USAGE_OVERVIEW_LIMIT', status: 413 });
  f.store.putRunHistory(record(session.id, run('still-writable', { steps: [model({ totalTokens: 1 })] })));
  assert.ok(f.store.getRunHistory(session.id, 'still-writable'));
  f.store.db.exec('DELETE FROM usage_runs;');
  f.store.db.prepare('INSERT INTO usage_runs VALUES(?,?,?,?,?,?)').run(session.id, 'large', 'history', 'unknown', 'null', 'x'.repeat(USAGE_OVERVIEW_LIMITS.rowBytes + 1));
  assert.throws(() => f.store.getUsageOverview(), { code: 'USAGE_OVERVIEW_LIMIT', status: 413 });
});

test('SQLite overview aggregation remains exact beyond JavaScript safe integers and signed int64', async t => {
  const f = await fixture(t);
  const stats = createUsageProjection('session', run('r', { steps: Array.from({ length: 64 }, () => model({ inputTokens: 1e12 })) })).stats;
  const count = 150000;
  const result = f.store.db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
    SELECT openaster_usage_stats(?) AS stats FROM n`).get(count, JSON.stringify(stats));
  assert.equal(JSON.parse(result.stats).tokens.inputTokens.knownSum, (64000000000000n * BigInt(count)).toString());
  const merged = mergeUsageStats(emptyUsageStats(), JSON.parse(result.stats));
  assert.equal(merged.tokens.inputTokens.knownSum, '9600000000000000000'); assert.equal(merged.tokens.totalTokens.knownSum, null);
});
