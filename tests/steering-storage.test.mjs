// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { validateSteeringPayload, validateSteeringRecord, STEERING_LIMITS } from '../core/steering-input.mjs';

const now = '2026-11-05T00:00:00.000Z';
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-steering-store-'));
  const identity = await fs.lstat(root, { bigint: true }), owner = randomUUID(), open = new Set();
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace'); await fs.mkdir(workspace, { recursive: true });
  t.after(async () => {
    for (const store of open) store.close();
    const actual = await fs.lstat(root, { bigint: true }); assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), parent);
    assert.equal(actual.isSymbolicLink(), false); assert.equal(actual.ino, identity.ino); assert.equal(actual.dev, identity.dev);
    assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const track = directory => { const store = new Store(directory); open.add(store); return store; };
  const close = store => { store.close(); open.delete(store); };
  const store = track(dataDir), session = store.createSession({ title: 'Isolated input test' });
  session.messages = [{ id: randomUUID(), role: 'user', content: 'Initial', createdAt: now }];
  session.run = { id: randomUUID(), status: 'running', steps: [], startedAt: now, finishedAt: null, error: null, requestMessageId: session.messages[0].id };
  store.putSession(session);
  const source = (content = 'Additional', options = {}) => ({ version: 1, sessionId: session.id, requestId: randomUUID(), expectedRunId: session.run.id,
    mode: 'queue', content, images: [], files: [], contextFiles: [], providerId: 'demo', skillId: null, createdAt: now, ...options });
  function nextRun(inputs) {
    const before = store.getSession(session.id); before.run.status = 'cancelled'; before.run.finishedAt = now; store.putSession(before);
    return { ...before, messages: [...before.messages, ...inputs.map(value => ({ id: value.requestId, role: 'user', content: value.content, createdAt: value.createdAt,
      ...(value.images.length ? { images: value.images } : {}), ...(value.contextFiles.length ? { contextFiles: value.contextFiles } : {}) }))],
      run: { id: randomUUID(), status: 'running', steps: [], startedAt: now, finishedAt: null, error: null, requestMessageId: inputs.at(-1).requestId } };
  }
  return { root, dataDir, workspace, store, session, source, nextRun, track, close };
}

test('steering payload rejects unbound modes, forged provider overrides and invalid snapshots', () => {
  const request = { requestId: randomUUID(), expectedRunId: randomUUID(), mode: 'queue', content: '补充' };
  assert.deepEqual(validateSteeringPayload(request), { ...request, files: [], images: [] });
  for (const patch of [{ mode: 'always' }, { providerId: 'other' }, { expectedRunId: 'stale' }, { content: '' }, { images: null }]) assert.throws(() => validateSteeringPayload({ ...request, ...patch }));
});

test('inbox deduplicates exact requests, rejects conflicts and survives stale runtime session saves', async t => {
  const f = await fixture(t), original = f.store.getSession(f.session.id), source = f.source();
  const first = f.store.steeringInbox.enqueue(f.session.id, source);
  assert.equal(first.duplicate, false); assert.equal(first.input.sequence, 1);
  assert.equal(f.store.steeringInbox.enqueue(f.session.id, { ...source, createdAt: new Date().toISOString() }).duplicate, true);
  assert.throws(() => f.store.steeringInbox.enqueue(f.session.id, { ...source, content: 'different' }), { code: 'STEERING_ID_CONFLICT' });
  assert.throws(() => f.store.steeringInbox.enqueue(f.session.id, f.source('stale', { expectedRunId: randomUUID() })), { code: 'STEERING_RUN_CHANGED' });
  f.store.putSession({ ...original, queuedInputs: [] });
  assert.deepEqual(f.store.steeringInbox.list(f.session.id), [first.input]);
  assert.equal(Object.hasOwn(f.store.getSession(f.session.id), 'queuedInputs'), false);
  assert.equal(f.store.exportSessionsWithHistory().steeringInputs.length, 1);
});

test('batch consume commits all messages and receipts together and rejects mismatched content', async t => {
  const f = await fixture(t), a = f.store.steeringInbox.enqueue(f.session.id, f.source('one')).input, b = f.store.steeringInbox.enqueue(f.session.id, f.source('two')).input;
  const next = f.nextRun([a, b]), options = { consumeInputs: { requestIds: [a.requestId, b.requestId], runId: next.run.id } };
  const corrupted = structuredClone(next); corrupted.messages.at(-1).content = 'wrong';
  assert.throws(() => f.store.putSession(corrupted, options), { code: 'STEERING_CONSUME_CONFLICT' });
  assert.equal(f.store.getSession(f.session.id).run.id, f.session.run.id);
  assert.deepEqual(f.store.steeringInbox.list(f.session.id).map(value => value.status), ['pending', 'pending']);
  f.store.putSession(next, options); f.store.putSession(next, options);
  assert.deepEqual(f.store.steeringInbox.list(f.session.id).map(value => [value.status, value.runId]), [['consumed', next.run.id], ['consumed', next.run.id]]);
  assert.equal(f.store.getSession(f.session.id).messages.length, 3);
});

test('a SQLite write fault rolls back the new run and every consumed input', async t => {
  const f = await fixture(t), input = f.store.steeringInbox.enqueue(f.session.id, f.source()).input, next = f.nextRun([input]);
  f.store.db.exec("CREATE TRIGGER fail_steering BEFORE UPDATE ON steering_inputs WHEN NEW.status='consumed' BEGIN SELECT RAISE(ABORT,'isolated fault'); END;");
  assert.throws(() => f.store.putSession(next, { consumeInputs: { requestIds: [input.requestId], runId: next.run.id } }));
  assert.equal(f.store.getSession(f.session.id).messages.length, 1); assert.equal(f.store.steeringInbox.get(f.session.id, input.requestId).status, 'pending');
});

test('restart preserves input content as explicitly failed and session deletion cascades receipts', async t => {
  const f = await fixture(t), input = f.store.steeringInbox.enqueue(f.session.id, f.source()).input;
  f.close(f.store); const reopened = f.track(f.dataDir), result = reopened.steeringInbox.get(f.session.id, input.requestId);
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'SERVICE_RESTARTED'); assert.equal(result.content, input.content);
  assert.equal(reopened.getSession(f.session.id).run.status, 'cancelled');
  reopened.deleteSession(f.session.id); assert.deepEqual(reopened.steeringInbox.list(f.session.id), []);
});

test('queue capacity rejects excess without dropping accepted inputs and malformed image records fail', async t => {
  const f = await fixture(t);
  for (let n = 0; n < STEERING_LIMITS.pending; n++) f.store.steeringInbox.enqueue(f.session.id, f.source(String(n)));
  assert.throws(() => f.store.steeringInbox.enqueue(f.session.id, f.source('overflow')), { code: 'STEERING_LIMIT' });
  assert.equal(f.store.steeringInbox.list(f.session.id).length, STEERING_LIMITS.pending);
  assert.throws(() => validateSteeringRecord({ ...f.store.steeringInbox.list(f.session.id)[0], images: null }), { code: 'INVALID_STEERING_INPUT' });
});

test('version 6 migrates without rewriting canonical sessions and unknown newer databases remain rejected', async t => {
  const f = await fixture(t), before = f.store.db.prepare('SELECT value FROM sessions').get().value;
  f.store.db.exec('DROP TABLE steering_inputs; PRAGMA user_version=6;'); f.close(f.store);
  const upgraded = f.track(f.dataDir); assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 7);
  // The existing active-run restart rule remains in force; unrelated message bytes survive.
  assert.deepEqual(upgraded.getSession(f.session.id).messages, JSON.parse(before).messages); f.close(upgraded);
  const db = new DatabaseSync(path.join(f.dataDir, 'openaster.sqlite')); db.exec('PRAGMA user_version=8;'); db.close();
  assert.throws(() => new Store(f.dataDir), { code: 'UNSUPPORTED_DATABASE_VERSION' });
});

test('backup v9 preserves consumed inputs and converts pending input to explicit unprocessed state; v8 restores', async t => {
  const f = await fixture(t), first = f.store.steeringInbox.enqueue(f.session.id, f.source('consumed')).input, next = f.nextRun([first]);
  f.store.putSession(next, { consumeInputs: { requestIds: [first.requestId], runId: next.run.id } });
  const pending = f.store.steeringInbox.enqueue(f.session.id, f.source('pending', { expectedRunId: next.run.id })).input;
  f.close(f.store); const output = path.join(f.root, 'archive.json'); await createBackup({ dataDir: f.dataDir, workspace: f.workspace, output });
  const archive = JSON.parse(await fs.readFile(output, 'utf8')); assert.equal(archive.version, 9); assert.equal(archive.payload.steeringInputs.length, 2);
  const restoredPath = path.join(f.root, 'restored'); await restoreBackup({ input: output, dataDir: restoredPath });
  const restored = f.track(restoredPath); assert.equal(restored.steeringInbox.get(f.session.id, first.requestId).status, 'consumed');
  assert.equal(restored.steeringInbox.get(f.session.id, pending.requestId).error.code, 'BACKUP_RESTORED');
  delete archive.payload.steeringInputs; archive.version = 8; archive.sha256 = createHash('sha256').update(JSON.stringify(archive.payload)).digest('hex');
  const legacy = path.join(f.root, 'legacy.json'); await fs.writeFile(legacy, JSON.stringify(archive));
  const legacyPath = path.join(f.root, 'legacy'); await restoreBackup({ input: legacy, dataDir: legacyPath }); assert.deepEqual(f.track(legacyPath).steeringInbox.list(f.session.id), []);
});
