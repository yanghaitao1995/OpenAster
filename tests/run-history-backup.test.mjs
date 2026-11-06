// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { createBackup, restoreBackup, BACKUP_LIMITS } from '../server/backup.mjs';

const now = '2026-10-28T00:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const usage = { inputTokens: 12, outputTokens: 5, totalTokens: 17, cachedInputTokens: 3, cacheWriteInputTokens: null, reasoningOutputTokens: 2 };
const missing = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'openaster-history-backup-')));
  const identity = await fs.lstat(root, { bigint: true });
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), await fs.realpath(tmpdir()));
    const current = await fs.lstat(root, { bigint: true });
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
    await fs.rm(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'note.txt'), 'original\r\n');
  const store = new Store(dataDir), session = store.createSession({ title: '执行历史备份' });
  session.messages = [{ id: randomUUID(), role: 'user', content: '修改文件并说明结果', createdAt: now }];
  store.putSession(session); store.close();
  return { root, dataDir, workspace, session, output: path.join(root, 'backup.json'), restored: path.join(root, 'restored') };
}
function record(session, status = 'completed', suffix = status) {
  const runId = `run-${suffix}`, stepId = `step-${suffix}`;
  return {
    sessionId: session.id,
    run: { id: runId, status, startedAt: now, finishedAt: now, error: status === 'failed' ? { code: 'FIXTURE_FAILURE', message: '保留已返回的用量与部分正文' } : null,
      steps: [{ id: stepId, type: 'model', title: '模型响应', detail: '实际已返回用量', status: status === 'completed' ? 'completed' : status, createdAt: now, usage: structuredClone(usage) }],
      output: status === 'completed' ? null : { stepId, status: 'interrupted', content: '已经保存的部分文本' },
      connection: { providerId: 'deleted-connection', name: '执行时的模型连接', type: 'openai', model: 'historic-model', toolMode: 'workspace' },
      requestMessageId: session.messages[0].id, requestPreview: '修改文件并说明结果' },
    approvals: [{ id: `approval-${suffix}`, tool: 'edit_file', path: 'note.txt', status: status === 'completed' ? 'approved' : 'revoked', createdAt: now, resolvedAt: now, appliedAt: status === 'completed' ? now : null, originalHash: hash('original\r\n'), proposedHash: hash('changed\r\n') }],
  };
}
function histories(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'openaster.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT value FROM run_history ORDER BY session_id,run_id').all().map(row => JSON.parse(row.value)); }
  finally { db.close(); }
}
async function archive(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function rewrite(file, envelope) {
  envelope.sha256 = hash(JSON.stringify(envelope.payload)); await fs.writeFile(file, JSON.stringify(envelope));
}
async function populated(t) {
  const f = await fixture(t), store = new Store(f.dataDir), records = ['completed', 'failed', 'cancelled'].map(status => record(f.session, status));
  const external = { id: 'available-connection', name: '恢复后应停用', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true };
  store.putProvider(external);
  f.session.providerId = external.id; f.session.run = structuredClone(records.at(-1).run);
  store.putSession(f.session);
  for (const value of records) store.putRunHistory(value);
  store.close(); return { ...f, records };
}

test('long task provider settings and execution metadata roundtrip while user input keeps its original bound', async t => {
  const f = await fixture(t), store = new Store(f.dataDir), value = record(f.session);
  const settings = { contextWindowTokens: 262144, autoCompact: true, autoContinue: false, maxModelCalls: 180, maxTools: 600, maxRunMinutes: 120, maxTokens: 65536 };
  store.putProvider({ id: 'long-provider', name: '长任务连接', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true, ...settings });
  value.run.budget = { maxModelCalls: 180, maxTools: 600, maxRunMs: 7200000, modelCalls: 90, toolCalls: 100 };
  value.run.steps[0].purpose = 'compaction'; value.run.steps[0].contextUsage = { estimatedInputTokens: 190000, contextWindowTokens: 262144, reservedOutputTokens: 65536, thresholdTokens: 157286 };
  value.run.steps[0].publicSummary = '已保留目标、约束和未完成工作。';
  f.session.messages.push({ id: 'large-assistant', role: 'assistant', content: 'x'.repeat(1024 * 1024), createdAt: now });
  f.session.run = structuredClone(value.run); store.putSession(f.session); store.putRunHistory(value); store.close();
  await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const restored = new Store(f.restored);try { const provider=restored.getProvider('long-provider');for(const [key,item]of Object.entries(settings))assert.equal(provider[key],item);assert.deepEqual(restored.getRunHistory(f.session.id,value.run.id),value);assert.equal(restored.getSession(f.session.id).messages.at(-1).content.length,1024*1024); } finally { restored.close(); }
  const envelope=await archive(f.output);envelope.payload.sessions[0].messages.at(-1).role='user';const input=path.join(f.root,'oversize-user.json');await rewrite(input,envelope);
  await assert.rejects(restoreBackup({input,dataDir:path.join(f.root,'invalid-user')}),{code:'INVALID_BACKUP'});
});

test('v2 roundtrip preserves terminal runs, usage, errors, partial output and non-executable approval metadata exactly once', async t => {
  const f = await populated(t), summary = await createBackup(f), envelope = await archive(f.output);
  assert.equal(envelope.version, 9); assert.equal(summary.runHistory, 3);
  assert.deepEqual(envelope.payload.runHistory, histories(f.dataDir));
  assert.ok(envelope.payload.runHistory.every(value => value.run.connection.providerId === 'deleted-connection'));
  assert.ok(envelope.payload.runHistory.every(value => value.approvals.every(approval => !('args' in approval) && !('preview' in approval))));
  envelope.version = 2; delete envelope.payload.summaryJobs; delete envelope.payload.steeringInputs; delete envelope.payload.toolArtifacts; await rewrite(f.output, envelope);
  const restoredSummary = await restoreBackup({ input: f.output, dataDir: f.restored });
  assert.equal(restoredSummary.runHistory, 3);
  assert.deepEqual(histories(f.restored), histories(f.dataDir));
  for (let index = 0; index < 2; index++) {
    const store = new Store(f.restored);
    assert.equal(store.getProvider('available-connection').enabled, false);
    assert.equal(store.getSession(f.session.id).run.status, 'cancelled'); store.close();
    assert.equal(histories(f.restored).length, 3);
  }
  assert.equal(await fs.readFile(path.join(f.restored, 'workspace', 'note.txt'), 'utf8'), 'original\r\n', 'an approved history entry never replays the edit');
});

test('v2 permits a same run id in different sessions and keeps explicit history over a current-run backfill', async t => {
  const f = await fixture(t), store = new Store(f.dataDir), first = record(f.session);
  f.session.run = structuredClone(first.run); store.putSession(f.session);
  first.approvals[0].resolvedAt = '2026-10-28T00:01:00.000Z'; store.putRunHistory(first);
  const second = store.createSession({ title: '另一任务' }); second.messages = [{ ...f.session.messages[0], id: randomUUID() }];
  const secondRecord = record(second); second.run = structuredClone(secondRecord.run); store.putSession(second); store.putRunHistory(secondRecord); store.close();
  await createBackup(f); const legacy = await archive(f.output); legacy.version = 2; delete legacy.payload.summaryJobs; delete legacy.payload.steeringInputs; delete legacy.payload.toolArtifacts; await rewrite(f.output, legacy);
  await restoreBackup({ input: f.output, dataDir: f.restored });
  const restored = histories(f.restored); assert.equal(restored.length, 2);
  assert.deepEqual(restored.find(value => value.sessionId === f.session.id).approvals, first.approvals);
});

test('an active current run is stopped on restore and pending approval cannot become executable history', async t => {
  const f = await fixture(t), store = new Store(f.dataDir);
  f.session.run = { ...record(f.session, 'cancelled').run, status: 'awaiting_approval', finishedAt: null, error: null };
  f.session.approvals = [{ id: 'pending-edit', sessionId: f.session.id, runId: f.session.run.id, tool: 'edit_file', args: { path: 'note.txt', content: 'must not write' }, preview: { before: 'original\r\n', after: 'must not write', originalHash: hash('original\r\n'), newHash: hash('must not write') }, status: 'pending', createdAt: now }];
  store.putSession(f.session); store.close(); await createBackup(f);
  assert.equal((await archive(f.output)).payload.runHistory.length, 0);
  await restoreBackup({ input: f.output, dataDir: f.restored });
  const reopened = new Store(f.restored), session = reopened.getSession(f.session.id); reopened.close();
  assert.equal(session.run.status, 'cancelled'); assert.equal(session.approvals[0].status, 'denied');
  const restored = histories(f.restored); assert.equal(restored.length, 1); assert.equal(restored[0].approvals[0].status, 'revoked');
  assert.ok(!('args' in restored[0].approvals[0]));
  assert.equal(await fs.readFile(path.join(f.restored, 'workspace', 'note.txt'), 'utf8'), 'original\r\n');
});

test('v1 archives without history still restore sparse terminal runs without inventing connection or usage', async t => {
  const f = await fixture(t); await createBackup(f); const envelope = await archive(f.output);
  envelope.version = 1; delete envelope.payload.summaryJobs; delete envelope.payload.steeringInputs; delete envelope.payload.toolArtifacts; delete envelope.payload.runHistory;
  envelope.payload.sessions[0].run = { id: 'legacy-completed', status: 'completed' };
  await rewrite(f.output, envelope); await restoreBackup({ input: f.output, dataDir: f.restored });
  const values = histories(f.restored); assert.equal(values.length, 1);
  assert.deepEqual(values[0], { sessionId: f.session.id, run: { id: 'legacy-completed', status: 'completed' }, approvals: [] });
  const store = new Store(f.restored); store.close(); assert.equal(histories(f.restored).length, 1);
});

test('offline schema v1 export backfills its latest terminal run while leaving the source database untouched', async t => {
  const f = await fixture(t), store = new Store(f.dataDir);
  f.session.run = { id: 'legacy-run', status: 'completed' }; store.putSession(f.session); store.close();
  const db = new DatabaseSync(path.join(f.dataDir, 'openaster.sqlite'));
  db.exec('DROP TABLE run_history; PRAGMA user_version=1;'); db.close();
  const before = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
  await createBackup(f); const envelope = await archive(f.output);
  assert.equal(envelope.version, 9); assert.equal(envelope.payload.runHistory.length, 1);
  assert.deepEqual(envelope.payload.runHistory[0].run, f.session.run);
  assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), before);
  const reader = new DatabaseSync(path.join(f.dataDir, 'openaster.sqlite'), { readOnly: true });
  assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 1); reader.close();
});

test('v2 history accepts sparse legacy steps and dangling legacy output without fabricating missing facts', async t => {
  const f = await fixture(t), store = new Store(f.dataDir);
  const sparse = { sessionId: f.session.id, run: { id: 'legacy-sparse', status: 'failed', steps: [{ detail: '旧版本仅保存说明' }, {}], output: { stepId: 'unavailable-step', content: '旧部分输出', status: 'interrupted' } }, approvals: [] };
  store.putRunHistory(sparse); store.close(); await createBackup(f);
  const legacy = await archive(f.output); legacy.version = 2; delete legacy.payload.summaryJobs; delete legacy.payload.steeringInputs; delete legacy.payload.toolArtifacts; await rewrite(f.output, legacy);
  await restoreBackup({ input: f.output, dataDir: f.restored });
  assert.deepEqual(histories(f.restored), [sparse]);
});

test('restoring a terminal current run preserves its historical partial-output status and revoked meaning', async t => {
  const f = await fixture(t), store = new Store(f.dataDir), value = record(f.session, 'failed');
  value.run.output.status = 'processing'; f.session.run = structuredClone(value.run);
  f.session.approvals = [{ id: 'revoked-current', runId: value.run.id, status: 'denied', revoked: true, resolvedAt: now }];
  store.putSession(f.session); store.close(); await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  const restored = new Store(f.restored), session = restored.getSession(f.session.id); restored.close();
  assert.equal(session.run.output.status, 'processing'); assert.deepEqual(session.run, value.run);
  assert.equal(histories(f.restored)[0].approvals[0].status, 'revoked');
  const output = path.join(f.root, 'roundtrip.json'); await createBackup({ dataDir: f.restored, output });
  assert.deepEqual((await archive(output)).payload.runHistory, histories(f.restored));
});

test('legacy history text uses the record byte budget while the step and approval arrays stay bounded', async t => {
  const f = await fixture(t), store = new Store(f.dataDir);
  const value = record(f.session, 'failed');
  value.run.steps[0].title = 't'.repeat(1024);
  value.run.steps[0].detail = 'd'.repeat(5000);
  value.run.output.content = 'x'.repeat(300 * 1024);
  value.run.error.message = 'e'.repeat(5000);
  store.putRunHistory(value); store.close(); await createBackup(f); await restoreBackup({ input: f.output, dataDir: f.restored });
  assert.deepEqual(histories(f.restored), [value]);
  const base = await archive(f.output);
  for (const field of ['steps', 'approvals']) {
    const envelope = structuredClone(base), target = field === 'steps' ? envelope.payload.runHistory[0].run : envelope.payload.runHistory[0];
    target[field] = Array.from({ length: field === 'steps' ? 2561 : 2069 }, (_, index) => field === 'steps' ? {} : { ...value.approvals[0], id: `approval-${index}` });
    const input = path.join(f.root, `array-${field}.json`), dataDir = path.join(f.root, `array-${field}`); await rewrite(input, envelope);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' }); await missing(dataDir);
  }
});

test('recomputed checksums cannot admit malformed history fields, associations, usage, duplicates or active runs', async t => {
  const f = await populated(t); await createBackup(f); const valid = await archive(f.output);
  const mutations = [
    ['missing v2 history', p => delete p.runHistory],
    ['unknown record field', p => p.runHistory[0].execute = true],
    ['unknown session', p => p.runHistory[0].sessionId = 'missing-session'],
    ['duplicate record', p => p.runHistory.push(structuredClone(p.runHistory[0]))],
    ['active historical run', p => p.runHistory[0].run.status = 'running'],
    ['awaiting historical run', p => p.runHistory[0].run.status = 'awaiting_approval'],
    ['unknown run field', p => p.runHistory[0].run.nextTool = 'write_file'],
    ['unknown step field', p => p.runHistory[0].run.steps[0].command = 'bad'],
    ['duplicate step id', p => p.runHistory[0].run.steps.push(structuredClone(p.runHistory[0].run.steps[0]))],
    ['unknown step status', p => p.runHistory[0].run.steps[0].status = 'approved'],
    ['bad usage sum', p => p.runHistory[0].run.steps[0].usage.totalTokens = 1],
    ['unknown usage field', p => p.runHistory[0].run.steps[0].usage.cost = 1],
    ['tool with model usage', p => p.runHistory[0].run.steps[0].type = 'tool'],
    ['dangling request', p => p.runHistory[0].run.requestMessageId = 'missing-message'],
    ['assistant request', p => p.sessions[0].messages[0].role = 'assistant'],
    ['long preview', p => p.runHistory[0].run.requestPreview = 'x'.repeat(241)],
    ['credential in connection', p => p.runHistory[0].run.connection.apiKey = 'forbidden'],
    ['unknown connection protocol', p => p.runHistory[0].run.connection.type = 'shell'],
    ['unknown tool mode', p => p.runHistory[0].run.connection.toolMode = 'auto'],
    ['pending approval', p => p.runHistory[0].approvals[0].status = 'pending'],
    ['unknown approval tool', p => p.runHistory[0].approvals[0].tool = 'shell'],
    ['executable approval args', p => p.runHistory[0].approvals[0].args = { path: 'note.txt', content: 'bad' }],
    ['full approval preview', p => p.runHistory[0].approvals[0].preview = { after: 'bad' }],
    ['wrong approval association', p => p.runHistory[0].approvals[0].runId = 'another-run'],
    ['bad approval hash', p => p.runHistory[0].approvals[0].proposedHash = 'not-sha256'],
    ['unsafe approval path', p => p.runHistory[0].approvals[0].path = '../outside'],
    ['duplicate approval', p => p.runHistory[0].approvals.push(structuredClone(p.runHistory[0].approvals[0]))],
    ['active current conflicts with history', p => p.sessions[0].run.status = 'running'],
    ['current invalid metadata', p => p.sessions[0].run.requestMessageId = 'missing-message'],
    ['conflicting current history snapshot', p => p.sessions[0].run.connection.name = 'changed after execution'],
    ['null connection', p => p.runHistory[0].run.connection = null],
    ['null request', p => p.runHistory[0].run.requestMessageId = null],
    ['null request preview', p => p.runHistory[0].run.requestPreview = null],
    ['oversized connection name', p => p.runHistory[0].run.connection.name = 'x'.repeat(101)],
    ['invalid current revoked marker', p => p.sessions[0].approvals = [{ id: 'bad-revoked', status: 'approved', revoked: true }]],
    ['applied current revoked marker', p => p.sessions[0].approvals = [{ id: 'bad-revoked', status: 'denied', revoked: true, appliedAt: now }]],
  ];
  for (const [index, [label, mutate]] of mutations.entries()) {
    const envelope = structuredClone(valid); mutate(envelope.payload);
    const input = path.join(f.root, `bad-${index}.json`), dataDir = path.join(f.root, `bad-target-${index}`); await rewrite(input, envelope);
    await assert.rejects(restoreBackup({ input, dataDir }), undefined, label); await missing(dataDir);
  }
  const fakeV1 = structuredClone(valid); fakeV1.version = 1; delete fakeV1.payload.summaryJobs; delete fakeV1.payload.steeringInputs;
  await rewrite(path.join(f.root, 'v1-smuggling.json'), fakeV1);
  await assert.rejects(restoreBackup({ input: path.join(f.root, 'v1-smuggling.json'), dataDir: f.restored }), { code: 'INVALID_BACKUP' }); await missing(f.restored);
});

test('history byte and count budgets reject the entire import instead of truncating', async t => {
  const f = await populated(t); await createBackup(f); const valid = await archive(f.output);
  for (const kind of ['count', 'row']) {
    const envelope = structuredClone(valid);
    if (kind === 'count') envelope.payload.runHistory = Array.from({ length: BACKUP_LIMITS.runHistory + 1 }, () => null);
    else envelope.payload.runHistory[0].run.error = 'x'.repeat(BACKUP_LIMITS.sessionBytes + 1);
    const input = path.join(f.root, `oversized-${kind}.json`), dataDir = path.join(f.root, `oversized-${kind}`); await rewrite(input, envelope);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' }); await missing(dataDir);
  }
});

test('v1 and v2 refuse contradictory pending approvals with recorded write effects before creating a target', async t => {
  const f = await populated(t); await createBackup(f); const valid = await archive(f.output);
  for (const version of [1, 2]) {
    const envelope = structuredClone(valid); envelope.version = version; delete envelope.payload.summaryJobs; delete envelope.payload.steeringInputs; delete envelope.payload.toolArtifacts;
    if (version === 1) delete envelope.payload.runHistory;
    envelope.payload.sessions[0].approvals = [{ id: 'impossible-pending-write', runId: envelope.payload.sessions[0].run.id, status: 'pending', appliedAt: now }];
    const input = path.join(f.root, `contradictory-v${version}.json`), dataDir = path.join(f.root, `contradictory-v${version}`);
    await rewrite(input, envelope); const original = await fs.readFile(input);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' }); await missing(dataDir);
    assert.deepEqual(await fs.readFile(input), original, 'restore must not erase a recorded side effect to repair an input');
  }
});

test('future database versions and inconsistent history SQL metadata fail read-only export', async t => {
  for (const kind of ['version', 'association', 'sort', 'summary', 'malformed-json', 'null-approvals', 'extra-column', 'view']) {
    const f = await populated(t), db = new DatabaseSync(path.join(f.dataDir, 'openaster.sqlite'));
    if (kind === 'version') db.exec('PRAGMA user_version=8;');
    if (kind === 'association') db.exec("UPDATE run_history SET run_id='wrong-' || run_id;");
    if (kind === 'sort') db.exec("UPDATE run_history SET started_at='1900-01-01T00:00:00.000Z';");
    if (kind === 'summary') db.exec("UPDATE run_history SET summary_json='{}';");
    if (kind === 'malformed-json') db.exec("UPDATE run_history SET value='not json';");
    if (kind === 'null-approvals') db.exec("UPDATE run_history SET value=json_set(value,'$.approvals',NULL);");
    if (kind === 'extra-column') db.exec('ALTER TABLE run_history ADD COLUMN future_feature TEXT;');
    if (kind === 'view') db.exec('ALTER TABLE run_history RENAME TO hidden_history; CREATE VIEW run_history AS SELECT * FROM hidden_history;');
    db.close(); const before = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
    await assert.rejects(createBackup(f), { code: 'INVALID_BACKUP' }, kind); await missing(f.output);
    assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), before, kind);
  }
});

test('history insert failure rolls back restore and cleans only its newly created target', async t => {
  const f = await populated(t); await createBackup(f); const before = await fs.readFile(f.output);
  const original = Store.prototype.putRunHistory;
  Store.prototype.putRunHistory = function (value) {
    if (value.run.id === 'run-completed') throw new Error('injected history insert failure');
    return original.call(this, value);
  };
  try { await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), /injected history insert failure/); }
  finally { Store.prototype.putRunHistory = original; }
  await missing(f.restored); assert.deepEqual(await fs.readFile(f.output), before);
  assert.equal(histories(f.dataDir).length, 3); assert.equal(await fs.readFile(path.join(f.workspace, 'note.txt'), 'utf8'), 'original\r\n');
});

test('database history count, row and aggregate budgets are checked before loading any history details', async t => {
  for (const kind of ['count', 'row', 'aggregate']) {
    const f = await fixture(t), db = new DatabaseSync(path.join(f.dataDir, 'openaster.sqlite'));
    if (kind === 'count') {
      db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?)
        INSERT INTO run_history(session_id,run_id,started_at,summary_json,value)
        SELECT ?, 'count-' || n, '', '{}', '{}' FROM seq`).run(BACKUP_LIMITS.runHistory + 1, f.session.id);
    } else {
      const size = kind === 'row' ? BACKUP_LIMITS.sessionBytes + 4097 : 4 * 1024 * 1024 + 512;
      const value = Buffer.alloc(size, 120), insert = db.prepare('INSERT INTO run_history(session_id,run_id,started_at,summary_json,value) VALUES(?,?,?,?,?)');
      db.exec('BEGIN;');
      for (let index = 0; index < (kind === 'row' ? 1 : 16); index++) insert.run(f.session.id, `large-${index}`, '', '{}', value);
      db.exec('COMMIT;');
    }
    db.close(); const before = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
    const original = DatabaseSync.prototype.prepare; let attemptedDetailRead = false;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
      if (/SELECT session_id,run_id,started_at,CAST\(summary_json/u.test(sql)) { attemptedDetailRead = true; throw new Error('history details were loaded before checking budgets'); }
      return original.call(this, sql);
    });
    try { await assert.rejects(createBackup(f), { code: 'INVALID_BACKUP' }, kind); }
    finally { t.mock.restoreAll(); }
    assert.equal(attemptedDetailRead, false, kind); await missing(f.output);
    assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), before, kind);
  }
});

test('all history records share the same aggregate logical backup budget', async t => {
  const f = await populated(t); await createBackup(f); const envelope = await archive(f.output);
  const largeText = 'x'.repeat(7 * 1024 * 1024);
  envelope.payload.runHistory = Array.from({ length: 10 }, (_, index) => ({ sessionId: f.session.id, run: { id: `large-history-${index}`, status: 'failed', error: largeText }, approvals: [] }));
  const input = path.join(f.root, 'large-history.json'); await rewrite(input, envelope);
  await assert.rejects(restoreBackup({ input, dataDir: f.restored }), { code: 'INVALID_BACKUP' }); await missing(f.restored);
});
