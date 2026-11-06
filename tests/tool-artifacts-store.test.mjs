// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { TOOL_ARTIFACT_LIMITS } from '../core/tool-artifacts.mjs';

const time = '2026-10-28T00:00:00.000Z';
const hash = content => createHash('sha256').update(content).digest('hex');
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-artifacts-store-'));
  const owner = randomUUID(); await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  const store = new Store(root); let closed = false;
  t.after(async () => {
    if (!closed) store.close();
    assert.equal(path.dirname(await fs.realpath(root)), parent); assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const session = store.createSession(); session.run = { id: 'run-one', status: 'running', steps: [], startedAt: time };
  store.putSession(session);
  return { root, store, session, close() { store.close(); closed = true; } };
}
function artifact(session, id = 'tool-one', text = '\ufeff中文🙂\r\n') {
  const content = JSON.stringify({ untrusted_data: true, result: { path: 'src/file.txt', content: text } });
  return { id, sessionId: session.id, runId: session.run.id, stepId: id, callId: `call-${id}`, name: 'read_file', path: 'src/file.txt', isError: false, createdAt: time, bytes: Buffer.byteLength(content), sha256: hash(content), content };
}
function addStep(session, value) {
  session.run.steps.push({ id: value.id, type: 'tool', title: '读取文本', detail: value.path, status: 'completed', createdAt: time,
    toolResultRef: { artifactId: value.id, name: value.name, path: value.path, isError: value.isError, bytes: value.bytes, sha256: value.sha256 } });
}
function plan(value, ranges = [{ start: 0, end: value.bytes }], mode = 'full') {
  return { version: 1, policy: 'preserve-messages-reference-tools', requestBytes: 1000, requestByteLimit: 2097152,
    requestSha256: 'a'.repeat(64), preservedMessages: 2,
    toolResults: [{ artifactId: value.id, mode, sourceBytes: value.bytes, sentBytes: value.bytes, ranges }] };
}

test('artifact, reference and terminal history commit together and bodies stay out of session projections', async t => {
  const f = await fixture(t), value = artifact(f.session);
  const reservation = f.store.reserveArtifact({ sessionId: f.session.id, runId: f.session.run.id, id: value.id });
  addStep(f.session, value); f.session.run.status = 'completed'; f.session.run.finishedAt = time;
  f.store.putSession(f.session, { artifacts: [value], reservation });
  f.store.releaseArtifact(reservation); f.store.releaseArtifact(reservation);
  assert.deepEqual(f.store.getToolArtifact(f.session.id, value.runId, value.id), value);
  assert.deepEqual(f.store.getRunHistory(f.session.id, value.runId).run.steps[0].toolResultRef, f.session.run.steps[0].toolResultRef);
  assert.ok(!JSON.stringify(f.store.getSession(f.session.id)).includes('中文'));
  assert.ok(!JSON.stringify(f.store.getSessionOutput(f.session.id)).includes('中文'));
  assert.ok(!JSON.stringify(f.store.listRunHistory(f.session.id)).includes('中文'));
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual(f.store.exportSessionsWithHistory().toolArtifacts, [value]);
  f.close(); const reopened = new Store(f.root);
  try { assert.deepEqual(reopened.getToolArtifact(f.session.id, value.runId, value.id), value); reopened.deleteSession(f.session.id); assert.equal(reopened.getToolArtifact(f.session.id, value.runId, value.id), null); }
  finally { reopened.close(); }
});

test('failed history persistence rolls back inserted artifact and session; reservation can be retried', async t => {
  const f = await fixture(t), value = artifact(f.session), before = f.store.getSession(f.session.id);
  const reservation = f.store.reserveArtifact({ sessionId: f.session.id, runId: value.runId, id: value.id });
  addStep(f.session, value); f.session.run.status = 'completed';
  f.store.db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON run_history BEGIN SELECT RAISE(ABORT,'fixture archive failure'); END;");
  assert.throws(() => f.store.putSession(f.session, { artifacts: [value], reservation }), /fixture archive failure/);
  assert.deepEqual(f.store.getSession(f.session.id), before); assert.equal(f.store.getToolArtifact(f.session.id, value.runId, value.id), null);
  f.store.db.exec('DROP TRIGGER fail_history'); f.store.putSession(f.session, { artifacts: [value], reservation });
  assert.throws(() => f.store.putSession(f.session, { artifacts: [value], reservation }), { code: 'INVALID_TOOL_ARTIFACT' });
});

test('immutable artifacts allow exact retry but reject changed content and removed references', async t => {
  const f = await fixture(t), value = artifact(f.session); addStep(f.session, value); f.store.putSession(f.session, { artifacts: [value] });
  f.store.db.exec("CREATE TRIGGER immutable BEFORE UPDATE ON tool_artifacts BEGIN SELECT RAISE(ABORT,'artifact rewritten'); END;");
  f.store.putSession(f.session, { artifacts: [structuredClone(value)] });
  const changed = artifact(f.session, value.id, 'replaced');
  const mutated = structuredClone(f.session); mutated.run.steps = []; addStep(mutated, changed);
  assert.throws(() => f.store.putSession(mutated, { artifacts: [changed] }), { code: 'INVALID_TOOL_ARTIFACT' });
  const missing = structuredClone(f.session); delete missing.run.steps[0].toolResultRef;
  assert.throws(() => f.store.putSession(missing), { code: 'INVALID_TOOL_ARTIFACT' });
  assert.deepEqual(f.store.getToolArtifact(f.session.id, value.runId, value.id), value);
});

test('reservations account for concurrent runs and release is scoped and idempotent', async t => {
  const f = await fixture(t), tokens = [];
  for (let i = 0; i < 8; i++) tokens.push(f.store.reserveArtifact({ sessionId: f.session.id, runId: f.session.run.id, id: `tool-${i}` }));
  assert.throws(() => f.store.reserveArtifact({ sessionId: f.session.id, runId: f.session.run.id, id: 'too-many-bytes' }), { code: 'TOOL_ARTIFACT_LIMIT' });
  assert.throws(() => f.store.reserveArtifact({ sessionId: f.session.id, runId: f.session.run.id, id: 'tool-0' }), { code: 'INVALID_TOOL_ARTIFACT' });
  f.store.releaseArtifact(tokens.pop()); f.store.releaseArtifact({});
  const token = f.store.reserveArtifact({ sessionId: f.session.id, runId: f.session.run.id, id: 'replacement' });
  const value = artifact(f.session, 'wrong-id'); addStep(f.session, value);
  assert.throws(() => f.store.putSession(f.session, { artifacts: [value], reservation: token }), { code: 'INVALID_TOOL_ARTIFACT' });
  f.store.deleteSession(f.session.id);
  for (const held of [...tokens, token]) f.store.releaseArtifact(held);
  const other = f.store.createSession(); other.run = { id: 'other-run', status: 'running', steps: [] }; f.store.putSession(other);
  assert.ok(f.store.reserveArtifact({ sessionId: other.id, runId: other.run.id, id: 'available' }));
});

test('store-wide reservations cannot oversell 128 MiB across distinct runs', async t => {
  const f = await fixture(t), tokens = [];
  for (let run = 0; run < 8; run++) {
    const session = run ? f.store.createSession() : f.session;
    session.run = { id: `run-${run}`, status: 'running', steps: [] }; f.store.putSession(session);
    for (let i = 0; i < 8; i++) tokens.push(f.store.reserveArtifact({ sessionId: session.id, runId: session.run.id, id: `step-${i}` }));
  }
  const extra = f.store.createSession(); extra.run = { id: 'over', status: 'running', steps: [] }; f.store.putSession(extra);
  assert.throws(() => f.store.reserveArtifact({ sessionId: extra.id, runId: 'over', id: 'no-space' }), { code: 'TOOL_ARTIFACT_LIMIT' });
  f.store.releaseArtifact(tokens.pop()); assert.ok(f.store.reserveArtifact({ sessionId: extra.id, runId: 'over', id: 'space' }));
});

test('context plans require earlier same-run references and exact UTF8 boundaries; checkpoints never load bodies', async t => {
  const f = await fixture(t), value = artifact(f.session); addStep(f.session, value); f.store.putSession(f.session, { artifacts: [value] });
  const model = { id: 'model-two', type: 'model', title: 'model', detail: '', status: 'running', createdAt: time, contextPlan: plan(value) };
  f.session.run.steps.push(model);
  const original = f.store.getToolArtifact; f.store.getToolArtifact = () => { throw Error('Full body loaded during checkpoint'); };
  f.store.putSession(f.session); f.store.getToolArtifact = original;
  const unicodeOffset = Buffer.byteLength(value.content.slice(0, value.content.indexOf('中')));
  model.contextPlan = plan(value, [{ start: unicodeOffset + 1, end: unicodeOffset + 3 }], 'excerpt');
  assert.throws(() => f.store.putSession(f.session), { code: 'INVALID_RUN_HISTORY' });
  model.contextPlan = plan(value); f.session.run.steps.reverse();
  assert.throws(() => f.store.putSession(f.session), { code: 'INVALID_RUN_HISTORY' });
});

test('artifact count limit and mismatched associations fail atomically', async t => {
  assert.equal(TOOL_ARTIFACT_LIMITS.maxPerRun, 2048);
  const f = await fixture(t), artifacts = Array.from({ length: TOOL_ARTIFACT_LIMITS.maxPerRun }, (_, i) => artifact(f.session, `tool-${i}`, 'small'));
  artifacts.forEach(value => addStep(f.session, value)); f.store.putSession(f.session, { artifacts });
  const before = f.store.getSession(f.session.id);
  const value = artifact(f.session, `tool-${TOOL_ARTIFACT_LIMITS.maxPerRun}`); addStep(f.session, value);
  assert.throws(() => f.store.putSession(f.session, { artifacts: [value] }), { code: 'TOOL_ARTIFACT_LIMIT' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM tool_artifacts').get().n, TOOL_ARTIFACT_LIMITS.maxPerRun);
  assert.equal(f.store.getToolArtifact(f.session.id, value.runId, value.id), null);
  assert.deepEqual(f.store.getSession(f.session.id), before);
  const other = { ...value, sessionId: 'another-session' };
  assert.throws(() => f.store.putSession(f.session, { artifacts: [other] }), { code: 'INVALID_TOOL_ARTIFACT' });
  assert.deepEqual(f.store.getSession(f.session.id), before);
});

test('actual archived bytes and reservations share the exact 16 MiB per-run limit', async t => {
  const f = await fixture(t), empty = JSON.stringify({ untrusted_data: true, result: '' });
  const content = JSON.stringify({ untrusted_data: true, result: 'x'.repeat(TOOL_ARTIFACT_LIMITS.maxBytes - Buffer.byteLength(empty)) });
  const artifacts = Array.from({ length: 8 }, (_, i) => ({ ...artifact(f.session, `large-${i}`), content, bytes: Buffer.byteLength(content), sha256: hash(content) }));
  assert.equal(artifacts[0].bytes, TOOL_ARTIFACT_LIMITS.maxBytes);
  artifacts.slice(0, 7).forEach(value => addStep(f.session, value)); f.store.putSession(f.session, { artifacts: artifacts.slice(0, 7) });
  const reservation = f.store.reserveArtifact({ sessionId: f.session.id, runId: f.session.run.id, id: artifacts[7].id });
  assert.throws(() => f.store.reserveArtifact({ sessionId: f.session.id, runId: f.session.run.id, id: 'over' }), { code: 'TOOL_ARTIFACT_LIMIT' });
  addStep(f.session, artifacts[7]); f.store.putSession(f.session, { artifacts: [artifacts[7]], reservation });
  assert.equal(f.store.db.prepare('SELECT sum(length(CAST(content AS BLOB))) AS n FROM tool_artifacts').get().n, TOOL_ARTIFACT_LIMITS.runBytes);
  const small = artifact(f.session, 'small'); addStep(f.session, small);
  assert.throws(() => f.store.putSession(f.session, { artifacts: [small] }), { code: 'TOOL_ARTIFACT_LIMIT' });
  assert.equal(f.store.getToolArtifact(f.session.id, small.runId, small.id), null);
});

test('plans cover all earlier tool refs in order and cannot fabricate completeness over legacy gaps', async t => {
  const f = await fixture(t), a = artifact(f.session, 'tool-a'), b = artifact(f.session, 'tool-b');
  addStep(f.session, a); addStep(f.session, b); f.store.putSession(f.session, { artifacts: [a, b] });
  const canonical = plan(a); canonical.toolResults.push(plan(b).toolResults[0]);
  const model = { id: 'model-next', type: 'model', contextPlan: canonical };
  f.session.run.steps.push(model); f.store.putSession(f.session);
  for (const tools of [canonical.toolResults.slice(1), [...canonical.toolResults].reverse(), [canonical.toolResults[0], canonical.toolResults[0]]]) {
    const value = structuredClone(f.session); value.run.steps.at(-1).contextPlan.toolResults = tools;
    assert.throws(() => f.store.putSession(value), { code: 'INVALID_RUN_HISTORY' });
  }
  const legacyGap = structuredClone(f.session); legacyGap.run.steps.unshift({ id: 'old-tool', type: 'tool', detail: 'legacy no result' });
  assert.throws(() => f.store.putSession(legacyGap), { code: 'INVALID_RUN_HISTORY' });
  const pureLegacy = f.store.createSession(); pureLegacy.run = { id: 'legacy-run', status: 'completed', steps: [{ detail: 'sparse legacy' }] };
  assert.doesNotThrow(() => f.store.putSession(pureLegacy));
});

test('explicit summary evidence persists compacted tool plans through checkpoints, archive, export and reopen', async t => {
  const f = await fixture(t), a = artifact(f.session, 'tool-old'), b = artifact(f.session, 'tool-retained');
  addStep(f.session, a); addStep(f.session, b); f.store.putSession(f.session, { artifacts: [a, b] });
  f.session.run.steps.push({ id: 'summary', type: 'model', purpose: 'compaction', status: 'completed', createdAt: time });
  const compacted = { ...plan(b), compaction: { summaryStepId: 'summary', artifactIds: [a.id] } };
  f.session.run.steps.push({ id: 'response', type: 'model', purpose: 'response', status: 'completed', contextPlan: compacted });
  const original = f.store.getToolArtifact; f.store.getToolArtifact = () => { throw Error('Full body loaded during checkpoint'); };
  try { f.store.putSession(f.session); } finally { f.store.getToolArtifact = original; }
  assert.deepEqual(f.store.getSession(f.session.id).run.steps.at(-1).contextPlan, compacted);
  f.session.run.status = 'completed'; f.session.run.finishedAt = time; f.store.putSession(f.session);
  assert.deepEqual(f.store.getRunHistory(f.session.id, f.session.run.id).run.steps.at(-1).contextPlan, compacted);
  const exported = f.store.exportSessionsWithHistory();
  assert.deepEqual(exported.runHistory[0].run.steps.at(-1).contextPlan, compacted);
  assert.deepEqual(exported.toolArtifacts.map(item => item.sha256).sort(), [a.sha256, b.sha256].sort());
  f.close(); const reopened = new Store(f.root);
  try {
    assert.deepEqual(reopened.getRunHistory(f.session.id, f.session.run.id).run.steps.at(-1).contextPlan, compacted);
    assert.deepEqual(reopened.getToolArtifact(f.session.id, f.session.run.id, a.id), a);
    assert.deepEqual(reopened.getToolArtifact(f.session.id, f.session.run.id, b.id), b);
  } finally { reopened.close(); }
});

test('export budgets include serialized artifact content and reject before loading records', async t => {
  const f = await fixture(t), value = artifact(f.session, 'tool-one', '\\'.repeat(3000)); addStep(f.session, value); f.store.putSession(f.session, { artifacts: [value] });
  const without = f.store.db.prepare('SELECT length(CAST(value AS BLOB)) AS bytes FROM sessions').get().bytes;
  assert.throws(() => f.store.exportSessionsWithHistory({ maxBytes: without + value.bytes + 100 }), { code: 'EXPORT_TOO_LARGE' });
  assert.equal(f.store.exportSessionsWithHistory().toolArtifacts[0].sha256, value.sha256);
});

test('schema 2 adds an empty artifact table without replacing explicit history', async t => {
  const f = await fixture(t); f.session.run.status = 'completed'; f.store.putSession(f.session);
  const record = f.store.getRunHistory(f.session.id, f.session.run.id); record.run.requestPreview = 'explicit older archive'; f.store.putRunHistory(record);
  f.store.db.exec('DROP TABLE tool_artifacts; PRAGMA user_version=2;'); f.close();
  const upgraded = new Store(f.root);
  try { assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 7); assert.deepEqual(upgraded.getRunHistory(f.session.id, record.run.id), record); assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM tool_artifacts').get().n, 0); }
  finally { upgraded.close(); }
});
