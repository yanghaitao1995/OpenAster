// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { createRunHistoryRecord, validateRunHistoryRecord, summarizeRunHistory, RUN_HISTORY_MAX_BYTES } from '../core/run-history.mjs';

const time = '2026-10-28T00:00:00.000Z';
const later = '2026-10-28T00:01:00.000Z';
const connection = { providerId: 'provider-one', name: '测试连接', type: 'openai', model: 'fixture-model', toolMode: 'workspace' };
const usage = { inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: 3, cacheWriteInputTokens: null, reasoningOutputTokens: 2 };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const record = (sessionId, id = 'run-one', extra = {}) => ({ sessionId, run: { id, status: 'completed', startedAt: time, ...extra }, approvals: [] });

test('long task metadata preserves estimates, compaction and continuations without relaxing shape or byte limits', () => {
  const contextUsage = { estimatedInputTokens: 150000, contextWindowTokens: 131072, reservedOutputTokens: 16384, thresholdTokens: 91750 };
  const budget = { maxModelCalls: 512, maxTools: 2048, maxRunMs: 14400000, modelCalls: 512, toolCalls: 2048 };
  const value = record('long-session', 'long-run', { budget, steps: Array.from({ length: 2560 }, (_, index) => ({ id: `step-${index}`, type: index < 512 ? 'model' : 'tool', status: 'completed', ...(index < 512 ? { purpose: index === 0 ? 'compaction' : 'continuation', contextUsage } : {}) })), output: { stepId: 'step-0', status: 'interrupted', content: 'x'.repeat(1024 * 1024) } });
  assert.deepEqual(validateRunHistoryRecord(value), value);
  for (const mutate of [
    item => item.run.budget.modelCalls++, item => item.run.budget.maxRunMs++, item => item.run.budget.toolCalls = -1,
    item => item.run.budget.apiKey = 'must-not-be-kept', item => item.run.steps[0].purpose = 'execute',
    item => item.run.steps[512].purpose = 'compaction', item => item.run.steps[0].contextUsage.contextWindowTokens = 8191,
    item => item.run.steps[0].contextUsage.estimatedInputTokens = 1.5, item => item.run.steps[0].contextUsage.fullRequest = 'private',
    item => item.run.output.content += 'x',
  ]) { const candidate = structuredClone(value); mutate(candidate); assert.throws(() => validateRunHistoryRecord(candidate), { code: 'INVALID_RUN_HISTORY' }); }
});

test('per-request output budgets preserve the configured ceiling and reject inconsistent metadata', () => {
  const contextUsage = { estimatedInputTokens: 5000, contextWindowTokens: 8192, reservedOutputTokens: 2900,
    configuredOutputTokens: 131072, thresholdTokens: 6963 };
  const value = record('output-budget-session', 'output-budget-run', { steps: [{ id: 'model', type: 'model', status: 'completed', contextUsage }] });
  assert.deepEqual(validateRunHistoryRecord(value), value);
  for (const configuredOutputTokens of [127, 131073, 1.5, '131072', null, 2899]) {
    const invalid = structuredClone(value); invalid.run.steps[0].contextUsage.configuredOutputTokens = configuredOutputTokens;
    assert.throws(() => validateRunHistoryRecord(invalid), { code: 'INVALID_RUN_HISTORY' });
  }
  const legacy = structuredClone(value); delete legacy.run.steps[0].contextUsage.configuredOutputTokens;
  assert.deepEqual(validateRunHistoryRecord(legacy), legacy);
});

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'openaster-history-'));
  t.after(async () => {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('openaster-history-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}
async function fixture(t) {
  const root = await directory(t), store = new Store(root);
  return { root, store, session: store.createSession() };
}
function seedLegacy(root, version, sessions) {
  const db = new DatabaseSync(path.join(root, 'openaster.sqlite'));
  try {
    db.exec(`CREATE TABLE providers(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,updated_at TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,session_id TEXT);
      PRAGMA user_version=${version};`);
    db.prepare('INSERT INTO providers VALUES(?,?)').run('demo', JSON.stringify({ id: 'demo', type: 'demo' }));
    for (const session of sessions) db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(session.id, session.updatedAt, JSON.stringify(session));
  } finally { db.close(); }
}

test('projection archives one terminal run, normalized model usage and read-only consent facts', () => {
  const session = { id: 'session-one', providerId: 'not-the-original-provider', run: {
    id: 'run-one', status: 'failed', startedAt: time, finishedAt: later,
    connection: { ...connection, apiKey: 'connection-secret', baseUrl: 'private-url', envKey: 'PRIVATE_KEY' },
    requestMessageId: 'message-one', requestPreview: '处理这个文件', secret: 'unrecognized-run-secret',
    steps: [{ id: 'model-one', type: 'model', status: 'completed', usage: { ...usage, providerRaw: 'raw-secret' } },
      { id: 'tool-one', type: 'tool', status: 'failed', detail: '工具结果', usage }, { content: 'unknown-old-field' }],
    output: { stepId: 'model-one', content: '中断正文', status: 'interrupted', secret: 'output-secret' },
    error: { code: 'MOCK_FAILURE', message: '请求失败', stack: 'private-stack' },
  }, approvals: [
    { id: 'approved-one', runId: 'run-one', tool: 'edit_file', status: 'approved', createdAt: time, resolvedAt: later, appliedAt: later,
      args: { path: 'source/file.txt', oldText: 'OLD PRIVATE', newText: 'NEW PRIVATE' },
      preview: { before: 'OLD PRIVATE', after: 'NEW PRIVATE', originalHash: 'a'.repeat(64), newHash: 'b'.repeat(64) } },
    { id: 'pending-one', runId: 'run-one', status: 'pending' },
    { id: 'denied-one', runId: 'run-one', status: 'denied' },
    { id: 'revoked-one', runId: 'run-one', status: 'denied', revoked: true },
    { id: 'other-run', runId: 'run-other', status: 'approved', args: { content: 'OTHER PRIVATE' } },
  ] };
  const archived = createRunHistoryRecord(session);
  assert.deepEqual(archived.run.connection, connection);
  assert.deepEqual(archived.run.steps[0].usage, usage);
  assert.equal(Object.hasOwn(archived.run.steps[1], 'usage'), false);
  assert.deepEqual(archived.run.steps[2], {});
  assert.deepEqual(archived.approvals.map(item => item.status), ['approved', 'revoked', 'denied', 'revoked']);
  assert.equal(archived.approvals[0].path, 'source/file.txt');
  assert.equal(archived.approvals[0].originalHash, 'a'.repeat(64));
  assert.equal(archived.approvals[0].proposedHash, 'b'.repeat(64));
  assert.equal(archived.approvals[1].path, null);
  for (const secret of ['connection-secret', 'private-url', 'PRIVATE_KEY', 'unrecognized-run-secret', 'raw-secret', 'OLD PRIVATE', 'NEW PRIVATE', 'OTHER PRIVATE', 'output-secret', 'private-stack', 'unknown-old-field']) assert.ok(!JSON.stringify(archived).includes(secret), secret);
  archived.run.steps[0].usage.inputTokens = 999;
  assert.equal(session.run.steps[0].usage.inputTokens, 10);
  assert.equal(session.approvals[1].status, 'pending');
  assert.equal(createRunHistoryRecord({ ...session, run: { id: 'active', status: 'running' } }), null);
  assert.equal(createRunHistoryRecord({ ...session, run: { id: 'waiting', status: 'awaiting_approval' } }), null);
});

test('sparse legacy run fields stay sparse and large old details remain intact', () => {
  const value = createRunHistoryRecord({ id: 'legacy-session', providerId: 'current-provider', run: {
    id: 'legacy-run', status: 'completed', steps: [{ detail: 'x'.repeat(200 * 1024) }, { status: 'running' }],
  }, approvals: [{ id: 'compact', runId: 'legacy-run', tool: 'write_file', status: 'approved', args: { path: '.env.example' }, hashes: { original: null, proposed: 'c'.repeat(64) } }] });
  assert.equal(value.run.steps[0].detail.length, 200 * 1024);
  assert.equal(value.run.steps[1].status, 'running');
  assert.equal(Object.hasOwn(value.run, 'connection'), false);
  assert.equal(Object.hasOwn(value.run, 'startedAt'), false);
  assert.equal(value.approvals[0].proposedHash, 'c'.repeat(64));
  assert.deepEqual(summarizeRunHistory(value), { id: 'legacy-run', status: 'completed', startedAt: null, finishedAt: null, connection: null, requestPreview: null, stepCount: 2, approvalCount: 1 });
});

test('history import strictly validates metadata, consent shape, usage and bounded collections', () => {
  const base = record('session-one', 'run-one', { connection, requestMessageId: 'message-one', requestPreview: '预览' });
  const invalid = [
    value => value.extra = 'unknown', value => value.run.extra = 'unknown', value => value.run.status = 'running',
    value => value.run.connection = null, value => value.run.connection.name = 'x'.repeat(101),
    value => value.run.connection.model = 'x'.repeat(201), value => value.run.connection.apiKey = 'secret',
    value => value.run.connection.name = '   ', value => value.run.connection.model = '',
    value => value.run.connection.type = 'unknown', value => value.run.connection.toolMode = 'unknown',
    value => value.run.connection = { ...connection, type: 'demo', toolMode: 'none' },
    value => value.run.requestPreview = 'x'.repeat(241), value => value.run.requestPreview = null,
    value => value.run.requestMessageId = null, value => value.run.startedAt = 'not-a-date',
    value => value.run.steps = Array.from({ length: 2561 }, () => ({})),
    value => value.run.steps = [{ id: 'duplicate' }, { id: 'duplicate' }],
    value => value.run.steps = [{ type: 'tool', usage }], value => value.run.steps = [{ type: 'model', usage: { ...usage, totalTokens: 0 } }],
    value => value.run.steps = [{ type: 'model', usage: { ...usage, secret: 'extra' } }],
    value => value.run.steps = [{ type: 'invented' }], value => value.run.steps = [{ detail: '\ud800' }],
    value => value.approvals = Array.from({ length: 2069 }, (_, i) => ({ id: `approval-${i}` })),
    value => value.approvals = [{ id: 'approval-one', status: 'pending' }],
  ];
  for (const mutate of invalid) {
    const value = structuredClone(base); mutate(value);
    assert.throws(() => validateRunHistoryRecord(value), { code: 'INVALID_RUN_HISTORY' });
  }
  const accepted = validateRunHistoryRecord(base);
  assert.deepEqual(accepted, base); assert.notEqual(accepted, base);
  assert.throws(() => validateRunHistoryRecord(record('session-one', 'huge', { steps: [{ detail: 'x'.repeat(RUN_HISTORY_MAX_BYTES) }] })), { code: 'RUN_HISTORY_LIMIT', status: 413 });
});

for (const version of [0, 1]) test(`schema ${version} migrates atomically to 7 and backfills sparse terminal history`, async t => {
  const root = await directory(t);
  const terminal = { id: 'legacy-session', providerId: 'unknown-old-provider', updatedAt: time, run: { id: 'legacy-run', status: 'completed', steps: [{ status: 'running' }] }, approvals: [] };
  seedLegacy(root, version, [terminal]);
  const store = new Store(root);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
    const archived = store.getRunHistory(terminal.id, terminal.run.id);
    assert.deepEqual(archived, createRunHistoryRecord(terminal));
    assert.deepEqual(store.getSession(terminal.id), terminal);
    assert.equal(store.db.prepare('SELECT started_at FROM run_history').get().started_at, '');
    assert.equal(archived.run.steps[0].status, 'running');
    assert.equal(Object.hasOwn(archived.run, 'connection'), false);
  } finally { store.close(); }
});

test('future schema is refused without modifying the database bytes or creating tables', async t => {
  const root = await directory(t);
  seedLegacy(root, 8, []);
  const file = path.join(root, 'openaster.sqlite'), before = await readFile(file);
  assert.throws(() => new Store(root), { code: 'UNSUPPORTED_DATABASE_VERSION', status: 503 });
  assert.deepEqual(await readFile(file), before);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='run_history'").get(), undefined);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  } finally { db.close(); }
});

test('failed migration rolls back table creation, backfill and schema version', async t => {
  const root = await directory(t);
  seedLegacy(root, 1, [
    { id: 'good', updatedAt: time, run: { id: 'good-run', status: 'completed' } },
    { id: 'bad', updatedAt: time, run: { id: '../invalid', status: 'completed' } },
  ]);
  assert.throws(() => new Store(root), { code: 'INVALID_RUN_HISTORY' });
  const db = new DatabaseSync(path.join(root, 'openaster.sqlite'));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='run_history'").get(), undefined);
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 2);
  } finally { db.close(); }
});

test('restart cancels active steps, retains interrupted output and archives revoked approvals once', async t => {
  const { root, store, session } = await fixture(t);
  session.run = { id: 'interrupted-run', status: 'awaiting_approval', startedAt: time, finishedAt: null,
    steps: [{ id: 'model-one', type: 'model', status: 'completed', usage }, { id: 'tool-one', type: 'tool', status: 'running' }],
    output: { stepId: 'model-one', content: '保留部分结果', status: 'processing' } };
  session.approvals = [
    { id: 'pending', runId: session.run.id, status: 'pending', tool: 'write_file', args: { path: 'new.txt', content: 'NEVER EXECUTE' }, preview: { after: 'NEVER EXECUTE', originalHash: null, newHash: 'd'.repeat(64) } },
    { id: 'denied', runId: session.run.id, status: 'denied' },
  ];
  store.putSession(session);
  assert.deepEqual(store.listRunHistory(session.id), { runs: [], nextCursor: null });
  store.close();
  const restarted = new Store(root);
  let archived;
  try {
    const current = restarted.getSession(session.id);
    assert.equal(current.run.status, 'cancelled');
    assert.equal(current.run.steps[1].status, 'cancelled');
    assert.equal(current.run.steps[0].status, 'completed');
    assert.equal(current.run.output.content, '保留部分结果'); assert.equal(current.run.output.status, 'interrupted');
    assert.equal(current.updatedAt, current.run.finishedAt);
    assert.equal(current.approvals[0].status, 'denied'); assert.equal(current.approvals[0].revoked, true);
    assert.equal(current.approvals[0].resolvedAt, current.run.finishedAt);
    archived = restarted.getRunHistory(session.id, session.run.id);
    assert.deepEqual(archived.approvals.map(item => item.status), ['revoked', 'denied']);
    assert.ok(!JSON.stringify(archived).includes('NEVER EXECUTE'));
    assert.equal(restarted.listRunHistory(session.id).runs.length, 1);
  } finally { restarted.close(); }
  const again = new Store(root);
  try { assert.deepEqual(again.getRunHistory(session.id, session.run.id), archived); } finally { again.close(); }
});

test('terminal session and its history commit together; archive failure rolls both back', async t => {
  const { store, session } = await fixture(t);
  try {
    session.run = { id: 'run-one', status: 'running' }; store.putSession(session);
    store.db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON run_history BEGIN SELECT RAISE(ABORT,'fixture archive failure'); END;");
    session.run.status = 'completed'; session.title = 'should-not-save';
    assert.throws(() => store.putSession(session), /fixture archive failure/u);
    assert.equal(store.getSession(session.id).run.status, 'running');
    assert.notEqual(store.getSession(session.id).title, 'should-not-save');
    assert.equal(store.getRunHistory(session.id, 'run-one'), null);
    store.db.exec('DROP TRIGGER fail_archive');
    store.putSession(session);
    assert.equal(store.getSession(session.id).title, 'should-not-save');
    assert.equal(store.getRunHistory(session.id, 'run-one').run.status, 'completed');
  } finally { store.close(); }
});

test('SAVEPOINT allows an outer restore transaction to roll back session and imported history', async t => {
  const { store, session } = await fixture(t);
  try {
    store.db.exec('BEGIN');
    session.run = { id: 'restored-run', status: 'completed' }; store.putSession(session);
    store.putRunHistory(record(session.id, 'restored-run', { connection }));
    assert.deepEqual(store.getRunHistory(session.id, 'restored-run').run.connection, connection);
    store.db.exec('ROLLBACK');
    assert.equal(store.getSession(session.id).run, null);
    assert.equal(store.getRunHistory(session.id, 'restored-run'), null);
  } finally { store.close(); }
});

test('idempotent terminal upsert avoids rewrites and active streaming does not touch history', async t => {
  const { store, session } = await fixture(t);
  try {
    session.run = { id: 'completed-run', status: 'completed' }; store.putSession(session);
    store.db.exec("CREATE TRIGGER forbid_rewrite BEFORE UPDATE ON run_history BEGIN SELECT RAISE(ABORT,'history rewritten'); END;");
    store.putSession(session); // Identical terminal snapshot: no UPDATE.
    store.db.exec("CREATE TRIGGER forbid_new_archive BEFORE INSERT ON run_history WHEN NEW.run_id<>'completed-run' BEGIN SELECT RAISE(ABORT,'active archived'); END;");
    session.run = { id: 'streaming-run', status: 'running', output: { stepId: 'model-one', content: 'a', status: 'streaming' } };
    for (const content of ['a', 'ab', 'abc']) { session.run.output.content = content; store.putSession(session); }
    assert.equal(store.listRunHistory(session.id).runs.length, 1);
    assert.equal(store.getRunHistory(session.id, 'streaming-run'), null);
  } finally { store.close(); }
});

test('imported connection snapshot survives provider deletion, reassignment and schema 6 restart', async t => {
  const { root, store, session } = await fixture(t);
  session.providerId = connection.providerId; session.run = { id: 'old-run', status: 'completed' }; store.putSession(session);
  const imported = record(session.id, 'old-run', { connection, requestPreview: 'original request' });
  store.putProvider({ id: connection.providerId, type: 'openai' }); store.putRunHistory(imported);
  store.deleteProvider(connection.providerId); store.reassignProvider(connection.providerId, 'demo');
  assert.deepEqual(store.getRunHistory(session.id, 'old-run'), imported);
  assert.equal(store.getSession(session.id).providerId, 'demo');
  store.close();
  const reopened = new Store(root);
  try {
    assert.deepEqual(reopened.getRunHistory(session.id, 'old-run'), imported);
    reopened.deleteSession(session.id);
    assert.equal(reopened.getRunHistory(session.id, 'old-run'), null);
    assert.deepEqual(reopened.listRunHistory(session.id), { runs: [], nextCursor: null });
    assert.throws(() => reopened.putRunHistory(imported), /FOREIGN KEY/u);
  } finally { reopened.close(); }
});

test('history pagination uses descending dates and IDs, stable keysets and compact SQL only', async t => {
  const { store, session } = await fixture(t);
  try {
    for (const [id, startedAt] of [['z', time], ['a', later], ['b', later], ['legacy', undefined]]) {
      const value = record(session.id, id, { steps: [{ detail: 'x'.repeat(200 * 1024) }] });
      if (startedAt === undefined) delete value.run.startedAt; else value.run.startedAt = startedAt;
      store.putRunHistory(value);
    }
    // A broken full JSON value proves the list and hasSession never parse it.
    store.db.prepare('UPDATE run_history SET value=? WHERE run_id=?').run('invalid full JSON', 'b');
    store.db.prepare('UPDATE sessions SET value=? WHERE id=?').run('invalid session JSON', session.id);
    assert.equal(store.hasSession(session.id), true); assert.equal(store.hasSession('missing'), false);
    const first = store.listRunHistory(session.id, { limit: 2 });
    assert.deepEqual(first.runs.map(run => run.id), ['b', 'a']);
    assert.equal(first.runs[0].stepCount, 1);
    assert.ok(JSON.stringify(first).length < 1000);
    assert.deepEqual(JSON.parse(Buffer.from(first.nextCursor, 'base64url')), { sessionId: session.id, startedAt: later, id: 'a' });
    // Insert ahead of the cursor: it cannot duplicate an already visited row.
    store.putRunHistory(record(session.id, 'new', { startedAt: '2026-10-29T00:00:00.000Z' }));
    const next = store.listRunHistory(session.id, { limit: 2, cursor: first.nextCursor });
    assert.deepEqual(next.runs.map(run => run.id), ['z', 'legacy']); assert.equal(next.nextCursor, null);
    assert.equal(store.listRunHistory(session.id, { limit: 50 }).runs.length, 5);
    assert.throws(() => store.getRunHistory(session.id, 'b'), SyntaxError);
    assert.equal(store.getRunHistory(session.id, 'z').run.steps[0].detail.length, 200 * 1024);
    assert.equal(store.getRunHistory(session.id, 'absent'), null);
  } finally { store.close(); }
});

test('pagination rejects noncanonical, foreign, stale or missing cursors and invalid limits', async t => {
  const { store, session } = await fixture(t);
  try {
    store.putRunHistory(record(session.id, 'a')); store.putRunHistory(record(session.id, 'b'));
    const cursor = store.listRunHistory(session.id, { limit: 1 }).nextCursor;
    const payload = JSON.parse(Buffer.from(cursor, 'base64url'));
    for (const bad of ['', '!', 'x'.repeat(1025), cursor + '=', 123,
      encode({ ...payload, sessionId: 'foreign' }), encode({ ...payload, id: 'missing' }),
      encode({ ...payload, startedAt: later }), encode({ id: payload.id, startedAt: payload.startedAt, sessionId: payload.sessionId }),
      encode({ ...payload, extra: true }), Buffer.from(JSON.stringify(payload, null, 2)).toString('base64url')]) {
      assert.throws(() => store.listRunHistory(session.id, { cursor: bad }), { code: 'INVALID_CURSOR', status: 400 });
    }
    for (const limit of [0, -1, 51, 1.1, '2', null, NaN]) assert.throws(() => store.listRunHistory(session.id, { limit }), { code: 'INVALID_LIMIT' });
    store.db.prepare('DELETE FROM run_history WHERE run_id=?').run(payload.id);
    assert.throws(() => store.listRunHistory(session.id, { cursor }), { code: 'INVALID_CURSOR' });
  } finally { store.close(); }
});

test('record size failures preserve existing history and prevent partial session updates', async t => {
  const { store, session } = await fixture(t);
  try {
    const original = record(session.id); store.putRunHistory(original);
    assert.throws(() => store.putRunHistory(record(session.id, 'run-one', { steps: [{ detail: 'x'.repeat(RUN_HISTORY_MAX_BYTES) }] })), { code: 'RUN_HISTORY_LIMIT' });
    assert.deepEqual(store.getRunHistory(session.id, 'run-one'), original);
    session.run = { id: 'invalid-run', status: 'completed', connection: null };
    assert.throws(() => store.putSession(session), { code: 'INVALID_RUN_HISTORY' });
    assert.equal(store.getSession(session.id).run, null);
    assert.equal(store.getRunHistory(session.id, 'invalid-run'), null);
  } finally { store.close(); }
});

test('full export includes every history record and checks the combined exact byte budget first', async t => {
  const { store, session } = await fixture(t);
  try {
    for (let index = 0; index < 61; index++) store.putRunHistory(record(session.id, `run-${index}`, { steps: [{ detail: '正文' }] }));
    const bytes = store.db.prepare(`SELECT (SELECT SUM(length(CAST(value AS BLOB))) FROM sessions)
      +(SELECT SUM(length(CAST(value AS BLOB))) FROM run_history) AS n`).get().n;
    const exported = store.exportSessionsWithHistory({ maxBytes: bytes });
    assert.equal(exported.sessions.length, 1); assert.equal(exported.runHistory.length, 61);
    assert.throws(() => store.exportSessionsWithHistory({ maxBytes: bytes - 1 }), { code: 'EXPORT_TOO_LARGE', status: 413 });
    store.db.prepare('UPDATE run_history SET value=? WHERE run_id=?').run('not JSON', 'run-0');
    // Budget rejection precedes any complete JSON read/parse.
    assert.throws(() => store.exportSessionsWithHistory({ maxBytes: 0 }), { code: 'EXPORT_TOO_LARGE' });
    assert.equal(store.listSessions().length, 1);
  } finally { store.close(); }
});

test('default export rejects more than 32 MiB without materializing invalid full JSON', async t => {
  const { store, session } = await fixture(t);
  try {
    store.putRunHistory(record(session.id));
    store.db.prepare('UPDATE run_history SET value=CAST(zeroblob(?) AS TEXT)').run(32 * 1024 * 1024);
    assert.throws(() => store.exportSessionsWithHistory(), { code: 'EXPORT_TOO_LARGE', status: 413 });
  } finally { store.close(); }
});

test('export count limit refuses 200001 records before parsing and never truncates silently', async t => {
  const { store, session } = await fixture(t);
  try {
    store.db.prepare(`WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<200001)
      INSERT INTO run_history SELECT ?,printf('run-%d',n),'','{}','invalid' FROM sequence`).run(session.id);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM run_history').get().n, 200001);
    assert.throws(() => store.exportSessionsWithHistory(), { code: 'EXPORT_TOO_LARGE', status: 413 });
  } finally { store.close(); }
});
