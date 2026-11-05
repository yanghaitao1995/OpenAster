import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDraftSession } from '../public/draft-session.mjs';
import { validateDraftSnapshot } from '../public/composer-drafts.mjs';

const draft = (slot = 'new', overrides = {}) => ({ slot, text: '原样草稿\r\n', files: [], providerId: 'demo', skillId: '', updatedAt: '2026-10-30T08:00:00.000Z', revision: randomUUID(), uncertain: false, ...overrides });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const error = code => Object.assign(new Error('secret failure details must never escape'), { code });
const fails = (promise, code) => assert.rejects(promise, value => value.code === code && !value.message.includes('secret'));
function repository(initial = []) {
  let value = { version: 1, revision: initial.length ? randomUUID() : '0', drafts: initial };
  const calls = { reads: 0, writes: 0, active: 0, peak: 0, closed: 0 };
  const controls = { read: null, write: null, fail: null, loseReply: false };
  const copy = () => validateDraftSnapshot(value);
  return {
    calls, controls,
    current: copy,
    replace(drafts) { value = validateDraftSnapshot({ version: 1, revision: randomUUID(), drafts }); return copy(); },
    async read(scope) { assert.equal(scope, 'owned-scope'); calls.reads++; const held = controls.read; controls.read = null; if (held) { held.started.resolve(); await held.release.promise; } if (controls.fail) { const code = controls.fail; controls.fail = null; throw error(code); } return copy(); },
    async compareAndSwap(scope, revision, drafts) {
      assert.equal(scope, 'owned-scope'); calls.writes++; calls.active++; calls.peak = Math.max(calls.peak, calls.active);
      try {
        const held = controls.write; controls.write = null; if (held) { held.started.resolve(); await held.release.promise; }
        if (controls.fail) { const code = controls.fail; controls.fail = null; throw error(code); }
        if (revision !== value.revision) throw error('DRAFT_CONFLICT');
        value = validateDraftSnapshot({ version: 1, revision: randomUUID(), drafts });
        if (controls.loseReply) { controls.loseReply = false; throw error('DRAFT_STORAGE_UNAVAILABLE'); }
        return copy();
      } finally { calls.active--; }
    },
    close() { calls.closed++; },
  };
}
const session = (repo, onChange) => createDraftSession({ repository: repo, scope: 'owned-scope', onChange });
const hold = (repo, operation) => { const held = { started: gate(), release: gate() }; repo.controls[operation] = held; return held; };

test('draft session exposes detached local state and saves only after explicit flush', async () => {
  const repo = repository(), notifications = [], editor = session(repo, value => notifications.push(value));
  assert.deepEqual(editor.status(), { ready: false, pending: false, saving: false, conflicts: [], error: null });
  const selected = draft(); editor.upsert(selected); assert.equal(repo.calls.reads, 0); assert.equal(repo.calls.writes, 0);
  editor.get('new').text = 'mutated'; editor.list()[0].text = 'mutated'; selected.text = 'mutated'; assert.equal(editor.get('new').text, '原样草稿\r\n');
  const result = await editor.flush(); assert.equal(repo.calls.reads, 1); assert.equal(repo.calls.writes, 1); assert.equal(result.drafts[0].text, '原样草稿\r\n');
  assert.equal(editor.status().pending, false); assert.ok(notifications.some(value => value.saving)); assert.equal(editor.status().saving, false);
  notifications.at(-1).ready = false; assert.equal(editor.status().ready, true);
});

test('draft session merges different-slot edits from two editors without losing either', async () => {
  const repo = repository(), first = session(repo), second = session(repo); await Promise.all([first.ready(), second.ready()]);
  const a = draft('task-a'), b = draft('task-b'); first.upsert(a); second.upsert(b);
  await first.flush(); await second.flush();
  assert.deepEqual(repo.current().drafts, [a, b]); assert.equal(second.status().pending, false); assert.equal(repo.calls.writes, 3);
  await first.refresh(); assert.deepEqual(first.list(), [a, b]);
});

test('draft session preserves same-slot local edits and requires exact remote content for resolution', async () => {
  const original = draft(), repo = repository([original]), first = session(repo), second = session(repo); await Promise.all([first.ready(), second.ready()]);
  const a = draft('new', { text: 'remote revision' }), b = draft('new', { text: 'local pending' }); first.upsert(a); second.upsert(b);
  await first.flush(); await fails(second.flush(), 'DRAFT_CONFLICT');
  assert.deepEqual(second.get('new'), b); assert.deepEqual(second.status().conflicts, [{ slot: 'new', local: b, remote: a }]); assert.deepEqual(repo.current().drafts, [a]);
  await fails(second.resolve('new', { ...a, text: 'same revision but changed full content' }, 'local'), 'DRAFT_CONFLICT');
  assert.deepEqual(repo.current().drafts, [a]); await second.resolve('new', a, 'local'); assert.deepEqual(repo.current().drafts, [b]); assert.equal(second.status().pending, false);
});

test('draft session initial read never overwrites a draft typed while loading', async () => {
  const original = draft(), repo = repository([original]), editor = session(repo), held = hold(repo, 'read');
  const loading = editor.ready(); await held.started.promise;
  const local = draft('new', { text: 'typed before the saved draft arrives' }); editor.upsert(local); held.release.resolve(); await loading;
  assert.deepEqual(editor.get('new'), local); assert.deepEqual(editor.status().conflicts, [{ slot: 'new', local, remote: original }]);
  await fails(editor.flush(), 'DRAFT_CONFLICT'); assert.equal(repo.calls.writes, 0);
  await editor.resolve('new', original, 'remote'); assert.deepEqual(editor.get('new'), original); assert.equal(editor.status().pending, false);
});

test('draft session initial removal cancels an unsaved local edit without deleting an unseen remote draft', async () => {
  const original = draft(), repo = repository([original]), editor = session(repo), held = hold(repo, 'read');
  const loading = editor.ready(); await held.started.promise; const local = draft(); editor.upsert(local);
  assert.equal(editor.removeIfRevision('new', local.revision), true); held.release.resolve(); await loading; await editor.flush();
  assert.deepEqual(editor.get('new'), original); assert.equal(repo.calls.writes, 0);
});

test('draft session late edits survive an in-flight save and a queued flush writes them in order', async () => {
  const repo = repository(), editor = session(repo); await editor.ready(); const first = draft(); editor.upsert(first);
  const held = hold(repo, 'write'), saving = editor.flush(); await held.started.promise;
  const later = draft('new', { text: 'typed during the committed save' }); editor.upsert(later); const next = editor.flush();
  held.release.resolve(); await saving; assert.deepEqual(editor.get('new'), later); await next;
  assert.equal(repo.calls.peak, 1); assert.deepEqual(repo.current().drafts, [later]); assert.equal(editor.status().pending, false);
});

test('draft session conditional deletion protects newer text and persists a tombstone after an in-flight create', async () => {
  const repo = repository(), editor = session(repo); await editor.ready(); const first = draft(); editor.upsert(first);
  assert.equal(editor.removeIfRevision('new', randomUUID()), false); assert.deepEqual(editor.get('new'), first);
  const held = hold(repo, 'write'), saving = editor.flush(); await held.started.promise;
  assert.equal(editor.removeIfRevision('new', first.revision), true); assert.equal(editor.get('new'), null);
  held.release.resolve(); await saving; assert.equal(editor.get('new'), null); assert.equal(editor.status().pending, true);
  await editor.flush(); assert.deepEqual(repo.current().drafts, []); assert.notEqual(repo.current().revision, '0');
  const newer = draft(); editor.upsert(newer); assert.equal(editor.removeIfRevision('new', first.revision), false); assert.deepEqual(editor.get('new'), newer);
});

test('draft session preserves deletion conflicts when another editor updates the same slot', async () => {
  const original = draft(), repo = repository([original]), first = session(repo), second = session(repo); await Promise.all([first.ready(), second.ready()]);
  second.removeIfRevision('new', original.revision); const changed = draft('new', { text: 'new remote content' }); first.upsert(changed); await first.flush();
  await fails(second.flush(), 'DRAFT_CONFLICT'); assert.deepEqual(second.status().conflicts, [{ slot: 'new', local: null, remote: changed }]);
  await second.resolve('new', changed, 'remote'); assert.deepEqual(second.get('new'), changed); assert.equal(second.status().pending, false);
});

test('draft session failed saves retain pending content and redact external exception messages', async () => {
  const repo = repository(), editor = session(repo); await editor.ready(); const local = draft(); editor.upsert(local); repo.controls.fail = 'DRAFT_STORAGE_QUOTA';
  await fails(editor.flush(), 'DRAFT_STORAGE_QUOTA'); assert.deepEqual(editor.status().error, { code: 'DRAFT_STORAGE_QUOTA' }); assert.deepEqual(editor.get('new'), local); assert.equal(editor.status().pending, true); assert.deepEqual(repo.current().drafts, []);
  await editor.flush(); assert.deepEqual(repo.current().drafts, [local]); assert.equal(editor.status().error, null);
  const failing = session({ read: async () => { throw new Error('secret token'); }, compareAndSwap: async () => {} });
  await fails(failing.ready(), 'DRAFT_STORAGE_ERROR'); assert.deepEqual(failing.status().error, { code: 'DRAFT_STORAGE_ERROR' });
});

test('draft session recognizes a committed save with a lost response by reading exact contents, without repeating the write', async () => {
  const repo = repository(), editor = session(repo); await editor.ready(); const local = draft(); editor.upsert(local); repo.controls.loseReply = true;
  await fails(editor.flush(), 'DRAFT_STORAGE_UNAVAILABLE'); assert.equal(editor.status().pending, true); assert.deepEqual(repo.current().drafts, [local]);
  await editor.refresh(); assert.equal(editor.status().pending, false); assert.deepEqual(editor.get('new'), local); await editor.flush(); assert.equal(repo.calls.writes, 1);
});

test('draft session retries CAS merge at most three times and keeps pending content at the bound', async () => {
  const repo = repository(), original = repo.compareAndSwap.bind(repo); let attempts = 0;
  repo.compareAndSwap = async (...args) => { attempts++; repo.replace([draft('other', { text: String(attempts) })]); return original(...args); };
  const editor = session(repo); await editor.ready(); const local = draft(); editor.upsert(local);
  await fails(editor.flush(), 'DRAFT_CONFLICT'); assert.equal(attempts, 3); assert.deepEqual(editor.get('new'), local); assert.equal(editor.status().pending, true); assert.equal(editor.status().conflicts.length, 0);
  repo.compareAndSwap = original; await editor.flush(); assert.deepEqual(repo.current().drafts.find(value => value.slot === 'new'), local);
});

test('draft session refuses silent eviction on local limits and on a larger concurrent merge', async () => {
  const originals = Array.from({ length: 20 }, (_, i) => draft('remote-' + i)), repo = repository(originals), editor = session(repo);
  const local = draft(); editor.upsert(local); await editor.ready();
  assert.equal(editor.list().length, 21); assert.deepEqual(editor.status().error, { code: 'DRAFT_LIMIT' }); await fails(editor.flush(), 'DRAFT_LIMIT'); assert.deepEqual(repo.current().drafts, originals);
  assert.equal(editor.removeIfRevision('remote-0', originals[0].revision), true); await editor.flush(); assert.equal(repo.current().drafts.length, 20); assert.deepEqual(editor.get('new'), local);
  const extra = draft('extra'); editor.upsert(extra); assert.deepEqual(editor.get('extra'), extra); assert.equal(editor.list().length, 21);
  assert.deepEqual(editor.status().error, { code: 'DRAFT_LIMIT' }); const writes = repo.calls.writes;
  await fails(editor.flush(), 'DRAFT_LIMIT'); assert.equal(repo.calls.writes, writes); assert.equal(repo.current().drafts.length, 20);
  assert.equal(editor.removeIfRevision('extra', extra.revision), true); await editor.flush(); assert.equal(editor.status().pending, false);
});

test('draft session aggregate byte limits keep valid new text in memory until an explicit removal makes it persistable', async () => {
  const repo = repository(), editor = session(repo); await editor.ready();
  const drafts = Array.from({ length: 12 }, (_, i) => draft('task-' + i, { text: '汉'.repeat(16000) }));
  for (const value of drafts) editor.upsert(value);
  assert.equal(editor.list().length, 12); assert.deepEqual(editor.get('task-11'), drafts[11]); assert.deepEqual(editor.status().error, { code: 'DRAFT_LIMIT' });
  await fails(editor.flush(), 'DRAFT_LIMIT'); assert.equal(repo.calls.writes, 0);
  editor.removeIfRevision('task-11', drafts[11].revision); editor.removeIfRevision('task-10', drafts[10].revision);
  await editor.flush(); assert.equal(repo.current().drafts.length, 10); assert.equal(editor.status().error, null);
});

test('draft session moves a draft at the 20-slot limit as one local notification and one complete CAS bundle', async () => {
  const originals = Array.from({ length: 20 }, (_, i) => draft(i === 0 ? 'new' : 'task-' + i)), repo = repository(originals), notifications = [], editor = session(repo, value => notifications.push(value));
  await editor.ready(); const before = notifications.length;
  assert.equal(editor.moveIfRevision('new', 'created-task', originals[0].revision), true);
  assert.equal(notifications.length, before + 1); assert.equal(editor.get('new'), null); assert.deepEqual(editor.get('created-task'), { ...originals[0], slot: 'created-task' }); assert.equal(editor.list().length, 20);
  await editor.flush(); assert.equal(repo.current().drafts.length, 20); assert.equal(repo.current().drafts.some(value => value.slot === 'new'), false); assert.deepEqual(repo.current().drafts.find(value => value.slot === 'created-task'), { ...originals[0], slot: 'created-task' });
});

test('draft session move refuses an existing target or late source revision without changing either slot', async () => {
  const original = draft(), target = draft('other'), repo = repository([original, target]), editor = session(repo); await editor.ready();
  assert.equal(editor.moveIfRevision('new', 'other', original.revision), false);
  assert.equal(editor.moveIfRevision('new', 'absent', randomUUID()), false);
  assert.equal(editor.moveIfRevision('new', 'new', original.revision), false);
  assert.deepEqual(editor.list(), [original, target]); assert.equal(editor.status().pending, false); assert.equal(repo.calls.writes, 0);
});

test('draft session moves valid late text over the bundle byte budget without losing it or writing a partial move', async () => {
  const source = draft('new', { text: 'already saved before task creation', uncertain: true });
  const others = Array.from({ length: 10 }, (_, i) => draft('task-' + i, { text: '汉'.repeat(16000) }));
  const originals = [source, ...others], repo = repository(originals), notifications = [], editor = session(repo, value => notifications.push(value));
  await editor.ready();
  const late = draft('new', { text: '后'.repeat(16000), uncertain: true }); editor.upsert(late);
  assert.deepEqual(editor.status().error, { code: 'DRAFT_LIMIT' });
  const before = notifications.length;
  assert.equal(editor.moveIfRevision('new', 'created-task', late.revision), true);
  assert.equal(notifications.length, before + 1);
  assert.equal(editor.get('new'), null); assert.deepEqual(editor.get('created-task'), { ...late, slot: 'created-task' });
  assert.equal(editor.list().length, 11); assert.equal(editor.status().pending, true);
  assert.deepEqual(editor.status().error, { code: 'DRAFT_LIMIT' });
  await fails(editor.flush(), 'DRAFT_LIMIT'); assert.equal(repo.calls.writes, 0); assert.deepEqual(repo.current().drafts, originals);
  assert.equal(editor.removeIfRevision(others[0].slot, others[0].revision), true);
  await editor.flush(); assert.equal(repo.calls.writes, 1);
  assert.equal(repo.current().drafts.some(value => value.slot === 'new'), false);
  assert.deepEqual(repo.current().drafts.find(value => value.slot === 'created-task'), { ...late, slot: 'created-task' });
  assert.equal(editor.status().pending, false); assert.equal(editor.status().error, null);
});

test('draft session move during source creation keeps its tombstone after the late save and does not revive the old slot', async () => {
  const repo = repository(), editor = session(repo); await editor.ready(); const original = draft(); editor.upsert(original);
  const held = hold(repo, 'write'), saving = editor.flush(); await held.started.promise;
  assert.equal(editor.moveIfRevision('new', 'created-task', original.revision), true); held.release.resolve(); await saving;
  assert.equal(editor.get('new'), null); assert.deepEqual(editor.get('created-task'), { ...original, slot: 'created-task' }); assert.equal(editor.status().pending, true);
  await editor.flush(); assert.deepEqual(repo.current().drafts, [{ ...original, slot: 'created-task' }]); assert.equal(editor.status().pending, false);
});

test('draft session move never commits only its source deletion when another editor fills the destination', async () => {
  const original = draft(), repo = repository([original]), first = session(repo), second = session(repo); await Promise.all([first.ready(), second.ready()]);
  first.moveIfRevision('new', 'destination', original.revision); const other = draft('destination', { text: 'another editor owns this target' }); second.upsert(other); await second.flush();
  await fails(first.flush(), 'DRAFT_CONFLICT'); assert.deepEqual(repo.current().drafts, [original, other]); assert.equal(first.get('new'), null); assert.deepEqual(first.get('destination'), { ...original, slot: 'destination' });
  assert.equal(first.status().pending, true); assert.equal(first.status().conflicts[0].slot, 'destination');
});

test('draft session resolving stale remote data or typing during resolution keeps the pending local edit', async () => {
  const original = draft(), repo = repository([original]), editor = session(repo); await editor.ready(); const local = draft(); editor.upsert(local);
  const remote = draft('new', { text: 'remote changed' }); repo.replace([remote]); await editor.refresh();
  const laterRemote = draft('new', { text: 'remote changed again' }); repo.replace([laterRemote]); await fails(editor.resolve('new', remote, 'remote'), 'DRAFT_CONFLICT'); assert.deepEqual(editor.get('new'), local);
  const held = hold(repo, 'read'), resolving = editor.resolve('new', laterRemote, 'remote'); await held.started.promise;
  const typed = draft('new', { text: 'typed during the confirmation read' }); editor.upsert(typed); held.release.resolve(); await fails(resolving, 'DRAFT_CONFLICT'); assert.deepEqual(editor.get('new'), typed); assert.deepEqual(repo.current().drafts, [laterRemote]);
});

test('draft session rejects malformed reads or CAS acknowledgements without discarding pending local content', async () => {
  const local = draft(), badRead = session({ read: async () => ({ version: 99, revision: '0', drafts: [] }), compareAndSwap: async () => {} }); badRead.upsert(local);
  await fails(badRead.ready(), 'DRAFT_STORAGE_CORRUPT'); assert.deepEqual(badRead.get('new'), local); assert.equal(badRead.status().ready, false);
  const repo = repository(), editor = session(repo); await editor.ready(); editor.upsert(local);
  repo.compareAndSwap = async () => ({ version: 1, revision: randomUUID(), drafts: [] });
  await fails(editor.flush(), 'DRAFT_STORAGE_CORRUPT'); assert.deepEqual(editor.get('new'), local); assert.equal(editor.status().pending, true);
});

test('draft session close blocks new work, waits for queued work, and never closes the shared repository', async () => {
  const repo = repository(), seen = [], editor = session(repo, value => seen.push(value)); await editor.ready(); const local = draft(); editor.upsert(local);
  const held = hold(repo, 'write'), saving = editor.flush(); await held.started.promise;
  let closed = false; const closing = editor.close().then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  const notifications = seen.length; assert.throws(() => editor.upsert(draft()), { code: 'DRAFT_SESSION_CLOSED' });
  assert.throws(() => editor.removeIfRevision('new', local.revision), { code: 'DRAFT_SESSION_CLOSED' }); await fails(editor.refresh(), 'DRAFT_SESSION_CLOSED'); await fails(editor.flush(), 'DRAFT_SESSION_CLOSED');
  held.release.resolve(); await saving; await closing; assert.equal(closed, true); assert.equal(repo.calls.closed, 0); assert.deepEqual(repo.current().drafts, [local]); assert.equal(seen.length, notifications);
  const next = session(repo); await next.ready(); assert.deepEqual(next.get('new'), local);
});
