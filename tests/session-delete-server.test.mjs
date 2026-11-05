// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { planSummaryDraft, createSummaryDraft, generateSummaryDraft } from '../core/summary-draft.mjs';

const time = '2026-11-02T00:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const provider = { id: 'fixture-provider', name: 'Never contacted', type: 'openai', model: 'fixture', baseUrl: 'http://127.0.0.1:9/v1', enabled: true, toolMode: 'workspace', streaming: true };
const usage = totalTokens => ({ inputTokens: totalTokens, outputTokens: 0, totalTokens, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null });
const tables = ['sessions', 'run_history', 'tool_artifacts', 'summary_jobs', 'usage_runs', 'usage_meta', 'audit'];
const snapshot = db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const counts = value => Object.fromEntries(Object.entries(value).map(([table, rows]) => [table, rows.length]));

async function fixture(t, { auditRows = 0 } = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-session-delete-'));
  const identity = await fs.lstat(root, { bigint: true }), owner = randomUUID();
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  let store = new Store(root), app, db, stream, streamDone;
  t.after(async () => {
    await app?.close();
    await streamDone;
    db?.close(); store?.close();
    const actual = await fs.lstat(root, { bigint: true });
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), parent);
    assert.ok(actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === identity.dev && actual.ino === identity.ino);
    assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner);
    await fs.rm(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
  });
  store.putProvider(provider);
  const session = store.createSession({ title: '删除失败必须保留的任务', providerId: provider.id });
  session.messages = [{ id: randomUUID(), role: 'user', content: 'original request', createdAt: time }];
  const runId = randomUUID(), artifactId = randomUUID();
  const content = JSON.stringify({ untrusted_data: true, result: { path: 'note.txt', content: 'retained artifact' } });
  const artifact = { id: artifactId, sessionId: session.id, runId, stepId: artifactId, callId: 'read-call', name: 'read_file', path: 'note.txt', isError: false, createdAt: time, bytes: Buffer.byteLength(content), sha256: hash(content), content };
  session.run = { id: runId, status: 'completed', startedAt: time, finishedAt: time,
    requestMessageId: session.messages[0].id, requestPreview: 'original request',
    connection: { providerId: provider.id, name: provider.name, type: provider.type, model: provider.model, toolMode: provider.toolMode },
    steps: [
      { id: randomUUID(), type: 'model', title: 'Model', detail: '', status: 'completed', createdAt: time, usage: usage(7) },
      { id: artifactId, type: 'tool', title: 'Read', detail: 'note.txt', status: 'completed', createdAt: time,
        toolResultRef: { artifactId, name: artifact.name, path: artifact.path, isError: false, bytes: artifact.bytes, sha256: artifact.sha256 } },
    ] };
  store.putSession(session, { artifacts: [artifact] });
  const plan = planSummaryDraft(session, provider);
  const draft = createSummaryDraft(plan, { requestId: randomUUID(), providerId: provider.id, expectedSourceHash: plan.preview.source.hash, expectedPlanHash: plan.preview.planHash });
  store.putSummaryDraft(draft, { createOnly: true });
  await generateSummaryDraft(plan, provider, { draft, checkpoint: value => store.putSummaryDraft(value),
    providerCall: async () => ({ content: 'saved summary', toolCalls: [], usage: usage(10) }) });
  const other = store.createSession({ title: '另一任务不受影响' });
  other.run = { id: randomUUID(), status: 'completed', steps: [], startedAt: time, finishedAt: time };
  store.putSession(other);
  if (auditRows) store.db.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<?)
    INSERT INTO audit(time,action,detail,session_id) SELECT ?,'fixture.seed','original audit',NULL FROM n`).run(auditRows, time);
  store.close(); store = null;
  app = await startServer({ dataDir: root });
  db = new DatabaseSync(path.join(root, 'openaster.sqlite'));
  const boot = await fetch(app.url + '/api/bootstrap', { signal: AbortSignal.timeout(10000) });
  const cookie = boot.headers.get('set-cookie').split(';')[0], { csrfToken } = await boot.json();
  async function request(route, { method = 'GET', auth = true, csrf = true } = {}) {
    const response = await fetch(app.url + route, { method, signal: AbortSignal.timeout(10000),
      headers: { ...(auth ? { cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrfToken } : {}) } });
    return { status: response.status, body: await response.json() };
  }
  async function events() {
    const response = await fetch(app.url + '/api/events', { headers: { cookie } });
    assert.equal(response.status, 200);
    stream = response.body.getReader();
    let output = new TextDecoder().decode((await stream.read()).value);
    assert.match(output, /event: state/);
    streamDone = (async () => { while (true) { const next = await stream.read(); if (next.done) break; output += new TextDecoder().decode(next.value); } })();
    return async () => { await app.close(); await streamDone; return output.match(/^event: state$/gm)?.length ?? 0; };
  }
  return { root, db, session, other, request, events, close: () => app.close() };
}

for (const stage of ['insert', 'prune']) test(`session DELETE rolls back all retained records and usage when audit ${stage} fails`, async t => {
  const f = await fixture(t, { auditRows: stage === 'prune' ? 10000 : 1 });
  const before = snapshot(f.db), overview = await f.request('/api/usage'), exported = (await f.request('/api/export')).body;
  const stateEvents = await f.events();
  f.db.exec(stage === 'insert'
    ? "CREATE TRIGGER fail_delete_audit BEFORE INSERT ON audit WHEN NEW.action='session.deleted' BEGIN SELECT RAISE(ABORT,'fixture audit insert failure'); END;"
    : "CREATE TRIGGER fail_delete_audit BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'fixture audit prune failure'); END;");
  const deleted = await f.request(`/api/sessions/${f.session.id}`, { method: 'DELETE' });
  const current = await f.request(`/api/sessions/${f.session.id}`), after = snapshot(f.db);
  t.diagnostic(JSON.stringify({ stage, deleteStatus: deleted.status, deleteCode: deleted.body.error?.code,
    taskStatusAfterFailure: current.status, before: counts(before), after: counts(after),
    usageRevisionBefore: before.usage_meta[0].revision, usageRevisionAfter: after.usage_meta[0].revision }));
  assert.equal(deleted.status, 500); assert.equal(deleted.body.error.code, 'INTERNAL_ERROR');
  assert.equal(current.status, 200, 'failed deletion must leave the task available');
  assert.deepEqual(current.body.session, { ...f.session, queuedInputs: [] });
  assert.deepEqual(after, before, 'task/history/artifact/summary/usage/revision/audit rollback together');
  const usageAfter = await f.request('/api/usage');
  const { generatedAt: beforeGeneratedAt, ...beforeUsage } = overview.body;
  const { generatedAt: afterGeneratedAt, ...afterUsage } = usageAfter.body;
  assert.equal(usageAfter.status, overview.status);
  assert.deepEqual(afterUsage, beforeUsage, 'the server usage cache also reflects the rollback');
  assert.ok(Date.parse(afterGeneratedAt) >= Date.parse(beforeGeneratedAt), 'cache recomputation may advance its generation time without changing the usage snapshot');
  const exportAfter = (await f.request('/api/export')).body;
  for (const key of ['sessions', 'runHistory', 'toolArtifacts', 'summaryJobs', 'audit']) assert.deepEqual(exportAfter[key], exported[key]);
  assert.equal(await stateEvents(), 1, 'failed deletion must not publish a successful state event');
  f.db.exec('DROP TRIGGER fail_delete_audit');
});

test('authenticated session DELETE commits cascade, usage revision and audit pruning once', async t => {
  const f = await fixture(t, { auditRows: 10000 }), before = snapshot(f.db), stateEvents = await f.events();
  assert.equal((await f.request(`/api/sessions/${f.session.id}`, { method: 'DELETE', auth: false })).status, 401);
  assert.equal((await f.request(`/api/sessions/${f.session.id}`, { method: 'DELETE', csrf: false })).status, 403);
  assert.deepEqual(snapshot(f.db), before);
  assert.deepEqual(await f.request(`/api/sessions/${f.session.id}`, { method: 'DELETE' }), { status: 200, body: { ok: true } });
  assert.equal((await f.request(`/api/sessions/${f.session.id}`)).status, 404);
  assert.equal((await f.request(`/api/sessions/${f.session.id}`, { method: 'DELETE' })).status, 404);
  const after = snapshot(f.db);
  assert.deepEqual(after.sessions, before.sessions.filter(row => row.id === f.other.id));
  for (const table of ['run_history', 'tool_artifacts', 'summary_jobs', 'usage_runs']) assert.deepEqual(after[table], before[table].filter(row => row.session_id === f.other.id));
  assert.equal(BigInt(after.usage_meta[0].revision), BigInt(before.usage_meta[0].revision) + 1n);
  assert.equal(after.audit.length, 10000); assert.equal(after.audit[0].id, before.audit[0].id + 1);
  const deleted = after.audit.filter(row => row.action === 'session.deleted');
  assert.equal(deleted.length, 1); assert.equal(deleted[0].session_id, f.session.id); assert.equal(deleted[0].detail, f.session.title);
  assert.equal((await f.request('/api/usage')).body.summary.runs.total, 1);
  assert.equal(await stateEvents(), 2, 'only the committed deletion publishes a state event');
});

test('ordinary Store.deleteSession without audit retains its original semantics', async t => {
  const f = await fixture(t); await f.close();
  const store = new Store(f.root);
  try {
    const before = store.listAudit();
    store.deleteSession(f.session.id); store.deleteSession(f.session.id);
    assert.equal(store.getSession(f.session.id), null); assert.deepEqual(store.listRunHistory(f.session.id), { runs: [], nextCursor: null });
    assert.deepEqual(store.listSummaryDrafts(f.session.id), { drafts: [], nextCursor: null });
    assert.equal(store.getUsageOverview().summary.runs.total, 1); assert.deepEqual(store.listAudit(), before);
  } finally { store.close(); }
});
