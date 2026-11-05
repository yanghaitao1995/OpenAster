// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';

const time = '2026-10-28T00:00:00.000Z';
const hash = content => createHash('sha256').update(content).digest('hex');
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-artifacts-backup-'));
  const owner = randomUUID(); await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), parent); assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const dataDir = path.join(root, 'source'), output = path.join(root, 'backup.json'), restored = path.join(root, 'restored');
  await fs.mkdir(path.join(dataDir, 'workspace'), { recursive: true }); await fs.writeFile(path.join(dataDir, 'workspace', 'note.txt'), 'CURRENT FILE');
  const store = new Store(dataDir), session = store.createSession();
  store.putProvider({ id: 'external', name: 'local fixture', type: 'openai', model: 'mock', baseUrl: 'https://example.test/v1', enabled: true, toolMode: 'none' }); session.providerId = 'external';
  session.messages = [{ id: 'message-one', role: 'user', content: '历史资料', createdAt: time, contextFiles: [{ path: 'note.txt', content: 'SELECTED SNAPSHOT', sha256: hash('SELECTED SNAPSHOT') }] }];
  const artifacts = [];
  for (const [index, status] of [[1, 'completed'], [2, 'running']]) {
    const id = `tool-${index}`, content = JSON.stringify({ untrusted_data: true, result: { path: 'note.txt', content: `\ufeffOLD TOOL ${index} 中文🙂\r\n` } });
    const artifact = { id, sessionId: session.id, runId: `run-${index}`, stepId: id, callId: `call-${index}`, name: 'read_file', path: 'note.txt', isError: false, createdAt: time, bytes: Buffer.byteLength(content), sha256: hash(content), content };
    session.run = { id: artifact.runId, status, startedAt: time, finishedAt: status === 'completed' ? time : null, error: null, output: null,
      steps: [{ id, type: 'tool', title: '读取文件', detail: 'note.txt', status: 'completed', createdAt: time,
        toolResultRef: { artifactId: id, name: artifact.name, path: artifact.path, isError: false, bytes: artifact.bytes, sha256: artifact.sha256 } },
      { id: `model-${index}`, type: 'model', title: '模型', detail: 'mock', status: status === 'completed' ? 'completed' : 'running', createdAt: time, usage: null,
        contextPlan: { version: 1, policy: 'preserve-messages-reference-tools', requestBytes: 500, requestByteLimit: 2097152, requestSha256: 'a'.repeat(64), preservedMessages: 1,
          toolResults: [{ artifactId: id, mode: 'full', sourceBytes: artifact.bytes, sentBytes: artifact.bytes, ranges: [{ start: 0, end: artifact.bytes }] }] } }] };
    store.putSession(session, { artifacts: [artifact] }); artifacts.push(artifact);
  }
  session.approvals = [{ id: 'pending-write', sessionId: session.id, runId: session.run.id, tool: 'write_file', args: { path: 'never-created.txt', content: 'DO NOT WRITE' }, status: 'pending', createdAt: time }];
  store.putSession(session); store.close();
  return { root, dataDir, output, restored, session, artifacts };
}
async function archive(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function rewrite(file, value) { value.sha256 = hash(JSON.stringify(value.payload)); await fs.writeFile(file, JSON.stringify(value)); }
async function absent(file) { await assert.rejects(fs.stat(file), { code: 'ENOENT' }); }

test('v7 restores exact independent tool bodies, refs and plans without replay or file replacement', async t => {
  const f = await fixture(t); const before = await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'));
  const made = await createBackup(f); assert.equal(made.toolArtifacts, 2);
  const value = await archive(f.output); assert.equal(value.version, 9); assert.deepEqual(value.payload.toolArtifacts, f.artifacts);
  const result = await restoreBackup({ input: f.output, dataDir: f.restored }); assert.equal(result.toolArtifacts, 2);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')), before);
  const store = new Store(f.restored);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 7);
    for (const artifact of f.artifacts) assert.deepEqual(store.getToolArtifact(artifact.sessionId, artifact.runId, artifact.id), artifact);
    const session = store.getSession(f.session.id); assert.equal(session.run.status, 'cancelled'); assert.equal(session.approvals[0].status, 'denied'); assert.equal(session.approvals[0].revoked, true);
    assert.equal(store.getProvider('external').enabled, false); assert.equal(store.listRunHistory(session.id).runs.length, 2);
    assert.deepEqual(session.messages, f.session.messages);
    assert.deepEqual(store.getRunHistory(session.id, 'run-1').run.steps[1].contextPlan, value.payload.runHistory[0].run.steps[1].contextPlan);
  } finally { store.close(); }
  assert.equal(await fs.readFile(path.join(f.restored, 'workspace', 'note.txt'), 'utf8'), 'CURRENT FILE');
  await absent(path.join(f.restored, 'workspace', 'never-created.txt'));
});

test('legacy v1/v2/v3 restore without artifacts and refuse new fields in either current or archived runs', async t => {
  const f = await fixture(t); await createBackup(f); const original = await archive(f.output);
  for (const version of [1, 2, 3]) {
    const value = structuredClone(original); value.version = version; delete value.payload.summaryJobs; delete value.payload.steeringInputs; delete value.payload.toolArtifacts;
    for (const session of value.payload.sessions) {
      if (version < 3) for (const message of session.messages) delete message.contextFiles;
      for (const step of session.run.steps) { delete step.toolResultRef; delete step.contextPlan; }
    }
    for (const record of value.payload.runHistory) for (const step of record.run.steps) { delete step.toolResultRef; delete step.contextPlan; }
    if (version === 1) delete value.payload.runHistory;
    const file = path.join(f.root, `v${version}.json`); await rewrite(file, value);
    const dataDir = path.join(f.root, `v${version}`); await restoreBackup({ input: file, dataDir });
    const store = new Store(dataDir); try { assert.equal(store.db.prepare('SELECT count(*) AS n FROM tool_artifacts').get().n, 0); } finally { store.close(); }
    for (const field of ['toolResultRef', 'contextPlan']) {
      const bad = structuredClone(value), source = field === 'toolResultRef' ? 0 : 1;
      bad.payload.sessions[0].run.steps[source][field] = original.payload.sessions[0].run.steps[source][field];
      const input = path.join(f.root, `v${version}-${field}.json`), target = path.join(f.root, `v${version}-${field}`); await rewrite(input, bad);
      await assert.rejects(restoreBackup({ input, dataDir: target }), { code: 'INVALID_BACKUP' }); await absent(target);
      if (version >= 2) {
        const historical = structuredClone(value); historical.payload.runHistory[0].run.steps[source][field] = original.payload.runHistory[0].run.steps[source][field];
        await rewrite(input, historical); await assert.rejects(restoreBackup({ input, dataDir: target }), { code: 'INVALID_BACKUP' });
      }
    }
  }
});

test('v7 rejects recomputed-checksum tampering, orphan bodies and invalid UTF8 range links before creation', async t => {
  const f = await fixture(t); await createBackup(f); const original = await archive(f.output);
  const mutations = [
    p => delete p.toolArtifacts, p => p.toolArtifacts.push(structuredClone(p.toolArtifacts[0])),
    p => p.toolArtifacts[0].content += ' ', p => p.toolArtifacts[0].bytes++, p => p.toolArtifacts[0].sha256 = 'b'.repeat(64),
    p => p.toolArtifacts[0].sessionId = 'missing-session', p => p.toolArtifacts[0].runId = 'missing-run', p => p.toolArtifacts[0].stepId = 'different-step',
    p => p.toolArtifacts[0].extra = 'unknown', p => p.toolArtifacts[0].path = '../escape', p => p.toolArtifacts[0].isError = true,
    p => p.runHistory[0].run.steps[0].toolResultRef.name = 'write_file',
    p => p.runHistory[0].run.steps[1].contextPlan.toolResults[0].artifactId = 'tool-2',
    p => p.runHistory[0].run.steps.reverse(), p => p.runHistory[0].run.steps[1].contextPlan.requestBytes = 2097153,
    p => { const a = p.toolArtifacts[0]; const offset = Buffer.byteLength(a.content.slice(0, a.content.indexOf('中'))); Object.assign(p.runHistory[0].run.steps[1].contextPlan.toolResults[0], { mode: 'excerpt', ranges: [{ start: offset + 1, end: offset + 3 }] }); },
    p => delete p.runHistory[0].run.steps[0].toolResultRef,
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = structuredClone(original); mutate(value.payload);
    const input = path.join(f.root, `bad-${index}.json`), dataDir = path.join(f.root, `bad-${index}`); await rewrite(input, value); const before = await fs.readFile(input);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' }, String(index)); await absent(dataDir); assert.deepEqual(await fs.readFile(input), before);
  }
});

test('artifact insert failure rolls restore back and cleans only its newly created output', async t => {
  const f = await fixture(t); await createBackup(f); const source = await fs.readFile(f.output);
  const original = Store.prototype.putRunHistory;
  const mock = t.mock.method(Store.prototype, 'putRunHistory', function(record, options) {
    if (record.run.id === 'run-1') throw Error('fixture artifact restore failure');
    return original.call(this, record, options);
  });
  await assert.rejects(restoreBackup({ input: f.output, dataDir: f.restored }), /fixture artifact restore failure/);
  mock.mock.restore(); await absent(f.restored); assert.deepEqual(await fs.readFile(f.output), source);
});

test('source schema 6 malformed artifact hash, schema and size fail export without modifying source', async t => {
  for (const kind of ['hash', 'schema', 'oversized', 'future']) {
    const f = await fixture(t), db = new DatabaseSync(path.join(f.dataDir, 'openaster.sqlite'));
    if (kind === 'hash') db.exec("UPDATE tool_artifacts SET sha256=printf('%064d',0)");
    if (kind === 'schema') db.exec('ALTER TABLE tool_artifacts ADD COLUMN unknown TEXT');
    if (kind === 'oversized') db.exec('UPDATE tool_artifacts SET content=zeroblob(2097153)');
    if (kind === 'future') db.exec('PRAGMA user_version=8');
    db.close(); const before = await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'));
    await assert.rejects(createBackup(f), { code: 'INVALID_BACKUP' }, kind); await absent(f.output); assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')), before);
  }
});
