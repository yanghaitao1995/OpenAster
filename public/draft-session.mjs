// SPDX-License-Identifier: Apache-2.0
import { validateDraft, validateDraftList, validateDraftSnapshot } from './composer-drafts.mjs';

const SLOT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CODES = new Set(['INVALID_DRAFT', 'INVALID_DRAFT_SNAPSHOT', 'INVALID_DRAFT_SCOPE', 'INVALID_DRAFT_REVISION',
  'INVALID_DRAFT_RESOLUTION', 'DRAFT_LIMIT', 'DRAFT_CONFLICT', 'DRAFT_CONTEXT_CHANGED', 'DRAFT_SESSION_CLOSED',
  'DRAFT_STORAGE_UNAVAILABLE', 'DRAFT_STORAGE_CORRUPT', 'DRAFT_STORAGE_QUOTA', 'DRAFT_STORAGE_ERROR', 'DRAFT_STORAGE_CLOSED']);
const emptySnapshot = () => ({ version: 1, revision: '0', drafts: [] });
const copy = draft => draft === null ? null : validateDraft(draft);
const token = draft => draft === null ? null : JSON.stringify(draft);
function problem(code) {
  const error = new Error(code === 'DRAFT_CONFLICT' ? '草稿已发生变化，请重新核对双方内容。'
    : code === 'DRAFT_LIMIT' ? '草稿超过本机保存限制，未自动删除任何内容。'
      : code === 'DRAFT_SESSION_CLOSED' ? '此草稿会话已关闭。' : '未能完成草稿操作；尚未提交的内容已保留。');
  error.code = code; return error;
}
function safeError(error) {
  let code; try { code = Object.getOwnPropertyDescriptor(error, 'code')?.value; } catch {}
  return problem(CODES.has(code) ? code : 'DRAFT_STORAGE_ERROR');
}
function checkSlot(slot) { if (typeof slot !== 'string' || !SLOT.test(slot)) throw problem('INVALID_DRAFT'); }

/**
 * A DOM-free editor over a whole-scope CAS repository. Local changes are keyed
 * by slot; reads and writes are serialized, while typing never waits for I/O.
 * No timers, remote requests, implicit eviction, or automatic send are used.
 */
export function createDraftSession({ repository, scope, onChange } = {}) {
  if (!repository || typeof repository.read !== 'function' || typeof repository.compareAndSwap !== 'function'
    || typeof scope !== 'string' || !scope || scope.length > 4096
    || (onChange !== undefined && typeof onChange !== 'function')) throw problem('INVALID_DRAFT_SCOPE');
  let snapshot = emptySnapshot(), remote = new Map(), loaded = false, closed = false, saving = false;
  let lastError = null, sequence = 0, tail = Promise.resolve(), loading = null, writingCapture = null;
  const changes = new Map();
  const remoteDraft = slot => remote.get(slot) ?? null;
  function open() { if (closed) throw problem('DRAFT_SESSION_CLOSED'); }
  function localDraft(slot) { return changes.has(slot) ? changes.get(slot).draft : remoteDraft(slot); }
  function candidates() {
    const result = new Map(remote);
    for (const [slot, change] of changes) { if (change.draft === null) result.delete(slot); else result.set(slot, change.draft); }
    return [...result.values()];
  }
  function status() {
    return { ready: loaded, pending: changes.size > 0, saving,
      conflicts: [...changes].filter(([, change]) => change.conflict).map(([slot, change]) => ({ slot, local: copy(change.draft), remote: copy(remoteDraft(slot)) })),
      error: lastError ? { code: lastError } : null };
  }
  function notify() {
    if (closed || !onChange) return;
    // Observer failures must not turn a committed storage transaction into a retry.
    try { onChange(status()); } catch {}
  }
  function capacity() {
    try { validateDraftList(candidates()); if (lastError === 'DRAFT_LIMIT') lastError = null; }
    catch (error) { lastError = safeError(error).code; }
  }
  function accept(next, committed = null) {
    const nextRemote = new Map(next.drafts.map(draft => [draft.slot, draft]));
    for (const [slot, change] of changes) {
      const incoming = nextRemote.get(slot) ?? null, incomingToken = token(incoming);
      const captured = committed?.get(slot);
      if (captured) {
        if (captured.sequence === change.sequence) { changes.delete(slot); continue; }
        // A newer edit is based on our just-committed value, not the old bundle.
        change.baseKnown = true; change.base = incomingToken;
      }
      if (token(change.draft) === incomingToken) { changes.delete(slot); continue; }
      change.conflict = !change.baseKnown ? incoming !== null : change.base !== incomingToken;
      if (!change.baseKnown && incoming === null) { change.baseKnown = true; change.base = null; }
    }
    snapshot = next; remote = nextRemote; loaded = true; lastError = null; capacity(); notify();
  }
  async function readRemote() {
    const value = await repository.read(scope);
    let next; try { next = validateDraftSnapshot(value); } catch { throw problem('DRAFT_STORAGE_CORRUPT'); }
    accept(next); return validateDraftSnapshot(snapshot);
  }
  function enqueue(work) {
    open();
    const pending = tail.then(work).catch(error => {
      const safe = safeError(error); lastError = safe.code; notify(); throw safe;
    });
    tail = pending.then(() => {}, () => {});
    return pending;
  }
  function ready() {
    try { open(); } catch (error) { return Promise.reject(error); }
    if (loaded) return Promise.resolve(validateDraftSnapshot(snapshot));
    if (loading) return loading;
    const pending = enqueue(readRemote); loading = pending;
    void pending.then(() => { if (loading === pending) loading = null; }, () => { if (loading === pending) loading = null; });
    return pending;
  }
  function upsert(value) {
    open();
    let draft;
    try {
      draft = validateDraft(value);
    } catch (error) { const safe = safeError(error); lastError = safe.code; notify(); throw safe; }
    if (token(localDraft(draft.slot)) === token(draft)) return copy(draft);
    const existing = changes.get(draft.slot), base = remoteDraft(draft.slot);
    if (loaded && token(base) === token(draft) && !writingCapture?.has(draft.slot)) changes.delete(draft.slot);
    else changes.set(draft.slot, { draft, sequence: ++sequence, baseKnown: existing?.baseKnown ?? loaded,
      base: existing ? existing.base : token(base), conflict: existing?.conflict ?? false });
    capacity(); notify(); return copy(draft);
  }
  function removeIfRevision(slot, revision) {
    open(); checkSlot(slot);
    if (typeof revision !== 'string' || !REVISION.test(revision)) throw problem('INVALID_DRAFT_REVISION');
    const current = localDraft(slot); if (!current || current.revision !== revision) return false;
    const existing = changes.get(slot), base = remoteDraft(slot);
    // Removing a never-committed draft cancels its local edit. It must not delete
    // an unseen remote draft discovered later by the initial read.
    if (!writingCapture?.has(slot) && ((!loaded && existing && !existing.baseKnown) || (loaded && base === null))) changes.delete(slot);
    else changes.set(slot, { draft: null, sequence: ++sequence, baseKnown: existing?.baseKnown ?? loaded,
      base: existing ? existing.base : token(base), conflict: existing?.conflict ?? false });
    capacity(); notify(); return true;
  }
  function moveIfRevision(from, to, revision) {
    open(); checkSlot(from); checkSlot(to);
    if (typeof revision !== 'string' || !REVISION.test(revision)) throw problem('INVALID_DRAFT_REVISION');
    const source = localDraft(from);
    if (!source || source.revision !== revision || localDraft(to) !== null) return false;
    const moved = validateDraft({ ...source, slot: to });
    // Like typing, a local move must retain valid text even when the bundle is
    // over its persistence budget. capacity() reports this; flush cannot write
    // either the source deletion or destination until the whole bundle fits.
    const oldSource = changes.get(from), sourceBase = remoteDraft(from);
    const oldTarget = changes.get(to), targetBase = remoteDraft(to);
    if (!writingCapture?.has(from) && ((!loaded && oldSource && !oldSource.baseKnown) || (loaded && sourceBase === null))) changes.delete(from);
    else changes.set(from, { draft: null, sequence: ++sequence, baseKnown: oldSource?.baseKnown ?? loaded,
      base: oldSource ? oldSource.base : token(sourceBase), conflict: oldSource?.conflict ?? false });
    changes.set(to, { draft: moved, sequence: ++sequence, baseKnown: oldTarget?.baseKnown ?? loaded,
      base: oldTarget ? oldTarget.base : token(targetBase), conflict: oldTarget?.conflict ?? false });
    capacity(); notify(); return true;
  }
  async function flushInternal() {
    saving = true; notify();
    try {
      if (!loaded) await readRemote();
      // At most three CAS attempts per explicit flush. Different-slot changes
      // can merge; same-slot conflicts require a separate human choice.
      for (let attempt = 0; attempt < 3; attempt++) {
        // Keep a move's deletion and insertion in the same successful bundle.
        // A conflicting target must not allow its source to disappear first.
        if ([...changes.values()].some(change => change.conflict)) throw problem('DRAFT_CONFLICT');
        const captured = new Map([...changes].filter(([, change]) => !change.conflict).map(([slot, change]) => [slot, { ...change }]));
        if (!captured.size) {
          if (changes.size) throw problem('DRAFT_CONFLICT');
          return validateDraftSnapshot(snapshot);
        }
        const next = new Map(remote);
        for (const [slot, change] of captured) { if (change.draft === null) next.delete(slot); else next.set(slot, change.draft); }
        const drafts = validateDraftList([...next.values()]), expectedRevision = snapshot.revision;
        let value;
        writingCapture = captured;
        try { value = await repository.compareAndSwap(scope, expectedRevision, drafts); }
        catch (error) {
          if (safeError(error).code !== 'DRAFT_CONFLICT') throw error;
          await readRemote();
          if (attempt === 2) throw problem('DRAFT_CONFLICT');
          continue;
        } finally { writingCapture = null; }
        let committed;
        try { committed = validateDraftSnapshot(value); } catch { throw problem('DRAFT_STORAGE_CORRUPT'); }
        if (committed.revision === expectedRevision || committed.revision === '0'
          || JSON.stringify(committed.drafts) !== JSON.stringify(drafts)) throw problem('DRAFT_STORAGE_CORRUPT');
        accept(committed, captured);
        if ([...changes.values()].some(change => change.conflict)) throw problem('DRAFT_CONFLICT');
        return validateDraftSnapshot(snapshot);
      }
      throw problem('DRAFT_CONFLICT');
    } finally { saving = false; notify(); }
  }
  function flush() {
    try { return enqueue(flushInternal); } catch (error) { return Promise.reject(error); }
  }
  function refresh() {
    try { return enqueue(readRemote); } catch (error) { return Promise.reject(error); }
  }
  function resolve(slot, expectedRemoteDraftOrNull, choice) {
    try {
      open(); checkSlot(slot);
      if (choice !== 'local' && choice !== 'remote') throw problem('INVALID_DRAFT_RESOLUTION');
      const expected = expectedRemoteDraftOrNull === null ? null : validateDraft(expectedRemoteDraftOrNull);
      if (expected && expected.slot !== slot) throw problem('INVALID_DRAFT_RESOLUTION');
      const localSequence = changes.get(slot)?.sequence;
      return enqueue(async () => {
        await readRemote();
        if (token(remoteDraft(slot)) !== token(expected)
          || (changes.get(slot)?.sequence !== localSequence && changes.has(slot))) throw problem('DRAFT_CONFLICT');
        const change = changes.get(slot);
        if (!change) return copy(remoteDraft(slot));
        if (choice === 'remote') { changes.delete(slot); lastError = null; capacity(); notify(); return copy(remoteDraft(slot)); }
        change.baseKnown = true; change.base = token(remoteDraft(slot)); change.conflict = false; lastError = null; notify();
        await flushInternal(); return copy(localDraft(slot));
      });
    } catch (error) { return Promise.reject(safeError(error)); }
  }
  return Object.freeze({
    ready,
    get(slot) { checkSlot(slot); return copy(localDraft(slot)); },
    // A concurrent remote merge can temporarily exceed capacity. Preserve both
    // sides for inspection/removal; persistence still strictly rejects limits.
    list() { return candidates().map(copy); },
    status,
    upsert,
    removeIfRevision,
    moveIfRevision,
    flush,
    refresh,
    resolve,
    close() { closed = true; return tail; },
  });
}
