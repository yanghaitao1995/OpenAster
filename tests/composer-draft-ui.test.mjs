// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createComposerDraftUI, createDesktopDraftAdapter } from '../public/composer-draft-ui.mjs';
import { validateDraftList, validateDraftSnapshot } from '../public/composer-drafts.mjs';

const origin = 'http://127.0.0.1:4317';
const copy = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const failure = code => Object.assign(new Error('fixture storage failure'), { code });
const draft = (slot, text, extra = {}) => ({ slot, text, files: [], providerId: 'demo', skillId: '', updatedAt: new Date().toISOString(), revision: randomUUID(), uncertain: false, ...extra });
const snapshot = (drafts = []) => ({ version: 1, revision: drafts.length ? randomUUID() : '0', drafts });

function memoryRepository(initial = snapshot()) {
  let value = validateDraftSnapshot(initial), readGate, writeGate, readError, writeError;
  const calls = [];
  return {
    calls,
    value: () => copy(value),
    readGate: gate => { readGate = gate; }, writeGate: gate => { writeGate = gate; },
    readError: code => { readError = code; }, writeError: code => { writeError = code; },
    replace: next => { value = validateDraftSnapshot(next); },
    async read(scope) {
      calls.push({ operation: 'read', scope });
      const captured = copy(value), gate = readGate; readGate = null;
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      if (readError) throw failure(readError);
      return captured;
    },
    async compareAndSwap(scope, expectedRevision, drafts) {
      const checked = validateDraftList(drafts);
      calls.push({ operation: 'cas', scope, expectedRevision, drafts: copy(checked) });
      const gate = writeGate; writeGate = null;
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      if (writeError) throw failure(writeError);
      if (expectedRevision !== value.revision) throw failure('DRAFT_CONFLICT');
      value = { version: 1, revision: randomUUID(), drafts: checked }; return copy(value);
    },
  };
}
const gate = () => ({ entered: deferred(), release: deferred() });
function harness(t, { repository = memoryRepository(), factory } = {}) {
  let view = { text: '', files: [], providerId: 'demo', skillId: '' };
  const writes = [], statuses = [];
  const ui = createComposerDraftUI({ desktop: true, desktopRepository: factory ?? (() => repository),
    read: () => copy(view),
    write: value => { view = { text: value.text, files: copy(value.files), providerId: value.providerId, skillId: value.skillId }; writes.push(copy(value)); },
    status: value => statuses.push(copy(value)),
  });
  t.after(() => ui.detach());
  return { ui, repository, writes, statuses, view: () => copy(view), lastStatus: () => statuses.at(-1),
    type: (text, extra = {}) => { view = { ...view, text, ...copy(extra) }; return ui.changed(); },
    bind: (storageId = randomUUID(), gatewayOrigin = origin, deviceDrafts = 1) => { ui.bind({ origin: gatewayOrigin, storageId, deviceDrafts }); return storageId; } };
}

test('typing before a delayed initial read preserves local text and exposes the unseen same-slot conflict', async t => {
  const saved = draft('new', 'previously saved'), repository = memoryRepository(snapshot([saved])), held = gate(); repository.readGate(held);
  const f = harness(t, { repository }); f.type('\ufeff  typed before identity\r\n'); f.bind();
  await held.entered.promise;
  assert.equal(f.view().text, '\ufeff  typed before identity\r\n');
  held.release.resolve(); await f.ui.ready();
  assert.equal(f.view().text, '\ufeff  typed before identity\r\n');
  assert.equal(f.ui.conflicts().length, 1);
  assert.equal(f.ui.conflicts()[0].remote.text, 'previously saved');
  await assert.rejects(f.ui.flush(), { code: 'DRAFT_CONFLICT' });
  assert.equal(repository.value().drafts[0].text, 'previously saved');
});

test('late initial history does not restore the wrong task after a slot switch', async t => {
  const repository = memoryRepository(snapshot([draft('task-b', 'saved B')])), held = gate(); repository.readGate(held);
  const f = harness(t, { repository }); f.bind(); await held.entered.promise;
  f.ui.switchSlot('task-a', 'demo'); f.type('local A');
  f.ui.switchSlot('task-b', 'demo');
  held.release.resolve(); await f.ui.ready();
  assert.equal(f.view().text, 'saved B'); assert.equal(f.ui.currentSlot(), 'task-b');
  await f.ui.flush();
  assert.equal(repository.value().drafts.find(item => item.slot === 'task-a').text, 'local A');
  f.ui.switchSlot('task-a'); assert.equal(f.view().text, 'local A');
});

test('new-to-created migration retains typing after send and clears only the captured revision', async t => {
  const f = harness(t); f.bind(); await f.ui.ready();
  f.type('submitted text'); const token = await f.ui.beginSend();
  f.type('typed while POST is pending');
  f.ui.moveCreated(token, 'created-task', true);
  f.ui.finishSend(token, { accepted: true }); await f.ui.flush();
  assert.equal(f.ui.currentSlot(), 'created-task');
  assert.equal(f.view().text, 'typed while POST is pending'); assert.equal(f.ui.uncertain(), false);
  assert.deepEqual(f.repository.value().drafts.map(item => [item.slot, item.text]), [['created-task', 'typed while POST is pending']]);
  const next = await f.ui.beginSend(); f.ui.finishSend(next, { accepted: true }); await f.ui.flush();
  assert.equal(f.view().text, ''); assert.deepEqual(f.repository.value().drafts, []);
});

test('a full twenty-draft bundle can move the new-task slot without eviction or a temporary twenty-first draft', async t => {
  const originals = [draft('new', 'outgoing'), ...Array.from({ length: 19 }, (_, index) => draft(`task-${index}`, `retained ${index}`))];
  const repository = memoryRepository(snapshot(originals)), f = harness(t, { repository }); f.bind(); await f.ui.ready();
  const token = await f.ui.beginSend(); f.type('late local text'); f.ui.moveCreated(token, 'created-task', true);
  assert.equal(f.ui.currentSlot(), 'created-task'); assert.equal(f.view().text, 'late local text');
  f.ui.finishSend(token, { accepted: true }); await f.ui.flush();
  const saved = repository.value().drafts; assert.equal(saved.length, 20); assert.equal(saved.some(item => item.slot === 'new'), false);
  assert.equal(saved.find(item => item.slot === 'created-task').text, 'late local text');
  for (const original of originals.slice(1)) assert.deepEqual(saved.find(item => item.slot === original.slot), original);
});

test('acceptance of an old task send cannot clear or navigate the currently edited task', async t => {
  const f = harness(t); f.bind(); await f.ui.ready();
  f.ui.switchSlot('task-a'); f.type('A outgoing'); const token = await f.ui.beginSend();
  f.ui.switchSlot('task-b'); f.type('B local'); const writeCount = f.writes.length;
  f.ui.finishSend(token, { accepted: true }); await f.ui.flush();
  assert.equal(f.ui.currentSlot(), 'task-b'); assert.equal(f.view().text, 'B local'); assert.equal(f.writes.length, writeCount);
  assert.deepEqual(f.repository.value().drafts.map(item => item.slot), ['task-b']);
});

test('unknown send outcome persists its warning; a definite failure preserves text and clears uncertainty', async t => {
  const f = harness(t); f.bind(); await f.ui.ready();
  f.type('do not replay'); let token = await f.ui.beginSend(); f.ui.finishSend(token); await f.ui.flush();
  assert.equal(f.ui.uncertain(), true); assert.equal(f.repository.value().drafts[0].uncertain, true);
  assert.equal(f.view().text, 'do not replay');
  f.ui.acknowledge(); token = await f.ui.beginSend(); f.ui.finishSend(token, { definite: true }); await f.ui.flush();
  assert.equal(f.ui.uncertain(), false); assert.equal(f.view().text, 'do not replay');
  assert.ok(f.repository.calls.every(call => call.operation === 'read' || call.operation === 'cas'), 'repository operations must never send a model request');
});

test('late acceptance without following a newly created task leaves the new draft and current task independent', async t => {
  const f = harness(t); f.bind(); await f.ui.ready(); f.type('outgoing'); const token = await f.ui.beginSend();
  f.ui.switchSlot('existing-task'); f.type('current task');
  f.ui.moveCreated(token, 'created-task', false); f.ui.finishSend(token, { accepted: true }); await f.ui.flush();
  assert.equal(f.ui.currentSlot(), 'existing-task'); assert.equal(f.view().text, 'current task');
  assert.deepEqual(f.repository.value().drafts.map(item => item.slot), ['existing-task']);
});

test('failed storage retains edited text, attachments, pending state and the old durable snapshot', async t => {
  const repository = memoryRepository(snapshot([draft('new', 'old')])), f = harness(t, { repository }); f.bind(); await f.ui.ready();
  const files = [{ path: 'src/ file.txt', sha256: 'b'.repeat(64), bytes: 99 }];
  f.type('\ufeff  unsaved\r\n', { files, skillId: 'review' }); repository.writeError('DRAFT_STORAGE_QUOTA');
  await assert.rejects(f.ui.flush(), { code: 'DRAFT_STORAGE_QUOTA' });
  assert.equal(f.view().text, '\ufeff  unsaved\r\n'); assert.deepEqual(f.view().files, files);
  assert.equal(f.ui.pending(), true); assert.equal(f.lastStatus().error.code, 'DRAFT_STORAGE_QUOTA');
  assert.equal(repository.value().drafts[0].text, 'old');
  repository.writeError(null); await f.ui.flush(); assert.equal(repository.value().drafts[0].text, '\ufeff  unsaved\r\n');
});

test('beginSend waits for a durable uncertain marker and retains edits made during that write', async t => {
  const f = harness(t); f.bind(); await f.ui.ready(); f.type('captured outgoing text');
  const held = gate(); f.repository.writeGate(held);
  let resolved = false; const starting = f.ui.beginSend().then(value => { resolved = true; return value; });
  await held.entered.promise;
  assert.equal(resolved, false); assert.deepEqual(f.repository.value().drafts, []);
  f.type('newer while durable intent is pending');
  held.release.resolve(); const token = await starting;
  assert.equal(resolved, true); assert.ok(token);
  assert.equal(f.repository.value().drafts[0].text, 'captured outgoing text'); assert.equal(f.repository.value().drafts[0].uncertain, true);
  assert.equal(f.view().text, 'newer while durable intent is pending');
  f.ui.finishSend(token, { accepted: true }); await f.ui.flush();
  assert.equal(f.repository.value().drafts[0].text, 'newer while durable intent is pending'); assert.equal(f.repository.value().drafts[0].uncertain, false);
});

test('beginSend storage failure rejects before permission to post and keeps the draft marked as not sent', async t => {
  const f = harness(t); f.bind(); await f.ui.ready(); f.type('must remain local');
  f.repository.writeError('DRAFT_STORAGE_QUOTA');
  await assert.rejects(f.ui.beginSend(), { code: 'DRAFT_STORAGE_QUOTA' });
  assert.equal(f.view().text, 'must remain local'); assert.equal(f.ui.uncertain(), false);
  assert.deepEqual(f.repository.value().drafts, []); assert.equal(f.ui.pending(), true);
  f.repository.writeError(null); await f.ui.flush();
  assert.equal(f.repository.value().drafts[0].text, 'must remain local'); assert.equal(f.repository.value().drafts[0].uncertain, false);
});

test('local text above the storage limit remains visible across task switches rather than being silently truncated', async t => {
  const f = harness(t); f.bind(); await f.ui.ready();
  const large = 'x'.repeat(16001); f.type(large);
  assert.equal(f.lastStatus().error.code, 'DRAFT_LIMIT'); assert.equal(f.ui.pending(), true);
  f.ui.switchSlot('other'); f.type('other draft'); f.ui.switchSlot('new');
  assert.equal(f.view().text, large); assert.equal(f.view().text.length, 16001);
  assert.equal(f.repository.value().drafts.length, 0);
});

test('a delayed write cannot erase text typed after its captured snapshot', async t => {
  const f = harness(t); f.bind(); await f.ui.ready(); f.type('first');
  const held = gate(); f.repository.writeGate(held); const saving = f.ui.flush(); await held.entered.promise;
  f.type('newer'); held.release.resolve(); await saving;
  assert.equal(f.view().text, 'newer'); assert.equal(f.ui.pending(), true); assert.equal(f.repository.value().drafts[0].text, 'first');
  await f.ui.flush(); assert.equal(f.repository.value().drafts[0].text, 'newer');
});

test('workspace and gateway rebinding isolate delayed reads and preserve each context independently', async t => {
  const a = randomUUID(), b = randomUUID(), first = memoryRepository(snapshot([draft('new', 'A saved')])), second = memoryRepository(snapshot([draft('new', 'B saved')]));
  const held = gate(); first.readGate(held);
  const bindings = [], f = harness(t, { factory: (id, gatewayOrigin) => { bindings.push([id, gatewayOrigin]); return id === a ? first : second; } });
  f.bind(a); await held.entered.promise;
  f.ui.detach(); f.bind(b, 'https://gateway.example'); await f.ui.ready(); assert.equal(f.view().text, 'B saved');
  const before = f.writes.length; held.release.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.view().text, 'B saved'); assert.equal(f.writes.length, before);
  f.type('B edited'); await f.ui.flush(); f.ui.detach(); f.bind(a); await f.ui.ready();
  assert.equal(f.view().text, 'A saved'); assert.equal(second.value().drafts[0].text, 'B edited');
  assert.deepEqual(bindings, [[a, origin], [b, 'https://gateway.example']]);
});

test('failure to create the next workspace repository cannot leave the previous workspace selected for writes', async t => {
  const a = randomUUID(), b = randomUUID(), previous = memoryRepository();
  const f = harness(t, { factory: id => { if (id === b) throw failure('DRAFT_STORAGE_UNAVAILABLE'); return previous; } });
  f.bind(a); await f.ui.ready(); f.type('A draft'); await f.ui.flush();
  f.bind(b); f.type('B must not overwrite A'); await f.ui.flush();
  assert.ok(f.lastStatus().unavailable); assert.equal(previous.value().drafts[0].text, 'A draft');
});

test('unavailable identity retains initial input as pending page-only data without claiming a durable save', async t => {
  const f = harness(t), text = '\ufeff  before bootstrap\r\n';
  f.type(text); assert.equal(f.ui.pending(), true);
  f.bind(null); assert.ok(f.lastStatus().unavailable); assert.equal(f.view().text, text);
  await f.ui.flush(); assert.equal(await f.ui.beginSend(), null);
  assert.equal(f.ui.pending(), true); assert.equal(f.repository.calls.length, 0);
  assert.deepEqual(f.ui.list(), [], 'page-only data is not advertised as a saved repository snapshot');
});

test('page-only task slots preserve independent text and references without accessing another workspace repository', async t => {
  const f = harness(t); f.bind(null);
  const files = [{ path: 'src/ exact.txt', sha256: 'c'.repeat(64), bytes: 37 }];
  f.type('new task draft', { files });
  f.ui.switchSlot('task-a'); assert.equal(f.view().text, ''); assert.deepEqual(f.view().files, []);
  f.type('task A', { skillId: 'review' }); f.ui.switchSlot('task-b'); f.type('task B');
  f.ui.switchSlot('new'); assert.equal(f.view().text, 'new task draft'); assert.deepEqual(f.view().files, files);
  f.ui.switchSlot('task-a'); assert.equal(f.view().text, 'task A'); assert.equal(f.view().skillId, 'review');
  assert.equal(f.ui.pending(), true); assert.equal(f.repository.calls.length, 0);
});

test('page-only creation follows the new task once and clears its pending state only after explicit input clearing', async t => {
  const f = harness(t); f.bind(null); f.type('submitted');
  const token = await f.ui.beginSend(); assert.equal(token, null);
  f.type('late local typing');
  f.ui.moveCreated(token, 'created-task', false); assert.equal(f.ui.currentSlot(), 'new');
  f.ui.moveCreated(token, 'created-task', true);
  assert.equal(f.ui.currentSlot(), 'created-task'); assert.equal(f.view().text, 'late local typing');
  f.ui.finishSend(token, { accepted: true }); assert.equal(f.view().text, 'late local typing'); assert.equal(f.ui.pending(), true);
  f.ui.switchSlot('new'); assert.equal(f.view().text, '');
  f.ui.switchSlot('created-task'); assert.equal(f.view().text, 'late local typing');
  f.type(''); assert.equal(f.ui.pending(), false);
  f.ui.switchSlot('new'); f.ui.switchSlot('created-task'); assert.equal(f.view().text, '');
  assert.equal(f.repository.calls.length, 0);
});

test('an invalid local draft in another slot cannot prevent restoring a valid task after the initial read', async t => {
  const saved = draft('saved-task', 'valid durable task'), repository = memoryRepository(snapshot([saved]));
  const held = gate(); repository.readGate(held); const f = harness(t, { repository }); f.bind(); await held.entered.promise;
  const oversized = 'x'.repeat(16001); f.type(oversized);
  assert.equal(f.lastStatus().error.code, 'DRAFT_LIMIT');
  f.ui.switchSlot('saved-task'); held.release.resolve(); await f.ui.ready();
  assert.equal(f.view().text, 'valid durable task'); assert.equal(f.lastStatus().error, null);
  assert.equal(f.ui.pending(), true, 'the other unsaved slot still requires an unload warning');
  assert.deepEqual(repository.value().drafts, [saved]);
  f.ui.switchSlot('new'); assert.equal(f.view().text, oversized);
});

test('aggregate byte overflow still moves late input to the created task but cannot partially overwrite durable drafts', async t => {
  const originals = [draft('new', 'outgoing'), ...Array.from({ length: 19 }, (_, index) => draft('task-' + index, '中'.repeat(8500)))];
  const repository = memoryRepository(snapshot(originals)), f = harness(t, { repository }); f.bind(); await f.ui.ready();
  const token = await f.ui.beginSend(), savedIntent = repository.value(), late = '文'.repeat(16000);
  f.type(late); f.ui.moveCreated(token, 'created-task', true);
  assert.equal(f.ui.currentSlot(), 'created-task'); assert.equal(f.view().text, late);
  assert.equal(f.ui.list().length, 20); assert.equal(f.ui.list().some(item => item.slot === 'new'), false);
  f.ui.finishSend(token, { accepted: true });
  await assert.rejects(f.ui.flush(), { code: 'DRAFT_LIMIT' });
  assert.equal(f.ui.pending(), true); assert.deepEqual(repository.value(), savedIntent);
  const removed = originals[1]; assert.equal(await f.ui.discard(removed.slot, removed.revision), true);
  await f.ui.flush(); const stored = repository.value().drafts;
  assert.equal(stored.length, 19); assert.equal(stored.find(item => item.slot === 'created-task').text, late);
  assert.equal(stored.some(item => item.slot === 'new'), false);
  for (const original of originals.slice(2)) assert.deepEqual(stored.find(item => item.slot === original.slot), original);
});

test('desktop adapter binds identity in header and body, rejects invalid results and requires a current context', async () => {
  const storageId = randomUUID(), calls = [], value = snapshot([draft('new', 'saved')]); let current = true;
  let response = { storageId, snapshot: value };
  const adapter = createDesktopDraftAdapter({ storageId, isCurrent: () => current, request: async (route, options) => { calls.push({ route, ...copy(options) }); return copy(response); } });
  assert.deepEqual(await adapter.read(storageId), value);
  assert.deepEqual(calls[0], { route: '/api/device-drafts', method: 'GET', headers: { 'X-OpenAster-Storage-Id': storageId } });
  await adapter.compareAndSwap(storageId, '0', value.drafts);
  assert.deepEqual(calls[1].body, { storageId, expectedRevision: '0', drafts: value.drafts });
  current = false; await assert.rejects(adapter.read(storageId), { code: 'DRAFT_CONTEXT_CHANGED' }); assert.equal(calls.length, 2);
  current = true; response = { storageId: randomUUID(), snapshot: value };
  await assert.rejects(adapter.read(storageId), { code: 'DRAFT_CONTEXT_CHANGED' });
  response = { storageId, snapshot: { ...value, arbitrary: 'not accepted' } };
  await assert.rejects(adapter.read(storageId), { code: 'INVALID_DRAFT_SNAPSHOT' });
});

test('desktop adapter does not expose a late response after its context is no longer current', async () => {
  const storageId = randomUUID(), held = deferred(); let current = true, started = false;
  const adapter = createDesktopDraftAdapter({ storageId, isCurrent: () => current, request: async () => { started = true; await held.promise; return { storageId, snapshot: snapshot() }; } });
  const pending = adapter.read(storageId); assert.equal(started, true); current = false; held.resolve();
  await assert.rejects(pending, { code: 'DRAFT_CONTEXT_CHANGED' });
});

test('desktop adapter without a current-context guard must not make any request', async () => {
  let calls = 0;
  try {
    const adapter = createDesktopDraftAdapter({ storageId: randomUUID(), request: async () => { calls++; return {}; } });
    await assert.rejects(adapter.read());
  } catch (error) { assert.ok(error instanceof Error); }
  assert.equal(calls, 0);
});
