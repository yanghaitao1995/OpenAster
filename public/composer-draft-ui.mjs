// SPDX-License-Identifier: Apache-2.0
import { createBrowserDraftRepository, draftScopeKey, validateDraftSnapshot } from './composer-drafts.mjs';
import { createDraftSession } from './draft-session.mjs';

// The view owns focus and navigation. This adapter owns only unsent, device-local data.
export function createComposerDraftUI({ read, write, status, desktop = false, desktopRepository }) {
  const contexts = new Map(), pageSlots = new Map();
  const meaningful = value => Boolean(value.text || value.files.length || value.skillId);
  let browserRepository, current = null, slot = 'new', sequence = 0, timer, unavailable = '';
  let fallbackProvider = '', earlyEdit = false;
  const content = value => JSON.stringify([value.text, value.files, value.providerId, value.skillId, value.uncertain]);
  const empty = () => ({ text: '', files: [], providerId: fallbackProvider, skillId: '' });
  const viewDraft = () => current?.session.get(slot) || null;
  function notify() {
    const value = current?.session.status();
    status({ ...(value || { ready: false, pending: false, saving: false, conflicts: [], error: null }),
      slot, draft: viewDraft(), unavailable, error: current?.error || value?.error || null,
      count: current?.session.list().length || 0, encrypted: Boolean(current?.encrypted) });
  }
  function schedule() {
    clearTimeout(timer);
    const context = current;
    timer = setTimeout(() => { if (context) void context.session.flush().catch(() => {}).finally(notify); }, 600);
  }
  function changed({ uncertain } = {}) {
    earlyEdit = true;
    if (!current) { const value = read(); if (meaningful(value)) pageSlots.set(slot, { ...value, files: value.files.map(file => ({ ...file })) }); else pageSlots.delete(slot); notify(); return null; }
    const previous = viewDraft(), value = read();
    const next = { slot, text: value.text, files: value.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
      providerId: value.providerId, skillId: value.skillId, uncertain: uncertain ?? previous?.uncertain ?? false };
    try {
      if (!next.text && !next.files.length && !next.skillId && !next.uncertain) {
        if (previous) current.session.removeIfRevision(slot, previous.revision);
        current.error = null; current.volatile.delete(slot); schedule(); notify(); return null;
      }
      if (previous && content(previous) === content(next)) { current.error = null; current.volatile.delete(slot); return previous; }
      const draft = { ...next, updatedAt: new Date().toISOString(), revision: crypto.randomUUID() };
      current.session.upsert(draft); current.error = null; current.volatile.delete(slot); schedule(); notify(); return draft;
    } catch (error) { current.error = { code: error.code || 'DRAFT_STORAGE_ERROR' }; current.volatile.set(slot, { ...value, files: value.files.map(file => ({ ...file })) }); notify(); return null; }
  }
  function apply() {
    const draft = viewDraft();
    write(current?.volatile.get(slot) || draft || (!current && pageSlots.get(slot)) || empty());
    if (current) current.error = current.volatile.has(slot) ? { code: 'INVALID_DRAFT' } : null;
    earlyEdit = false; notify();
  }
  function restoreAfterRead(context, ticket) {
    void context.session.ready().then(() => {
      if (current !== context || sequence !== ticket) return;
      // Typing while the initial read was pending is already held in the session.
      // On an invalid local input, keep the actual textarea rather than replacing it.
      if (!context.volatile.has(slot)) apply(); else notify();
    }).catch(() => { if (current === context) notify(); });
  }
  function bind({ origin, storageId, deviceDrafts }) {
    let key;
    try { key = draftScopeKey({ origin, storageId }); }
    catch { if (current) detach(); unavailable = '当前工作台未提供草稿存储身份；内容暂存于本页。'; notify(); return; }
    if (current?.key === key) { unavailable = ''; notify(); return; }
    const initial = !current && earlyEdit ? read() : null;
    if (current) changed();
    current = null; ++sequence; earlyEdit = false;
    let context = contexts.get(key);
    if (!context) {
      try {
        const encrypted = desktop && deviceDrafts === 1;
        if (desktop && !encrypted) throw new Error('desktop draft storage unavailable');
        const repository = encrypted ? desktopRepository(storageId, origin) : (browserRepository ||= createBrowserDraftRepository());
        context = { key, encrypted, error: null, volatile: new Map(), session: null };
        context.session = createDraftSession({ repository, scope: encrypted ? storageId : key,
          onChange: () => { if (current === context) notify(); } });
        contexts.set(key, context);
      } catch { unavailable = '本机草稿存储暂不可用；内容暂存于本页。'; notify(); return; }
    }
    current = context; pageSlots.clear(); unavailable = ''; const ticket = ++sequence;
    if (initial) { write(initial); changed(); }
    if (context.session.status().ready) apply();
    else restoreAfterRead(context, ticket);
    notify();
  }
  function detach() {
    if (current) { changed(); void current.session.flush().catch(() => {}); }
    current = null; pageSlots.clear(); slot = 'new'; fallbackProvider = ''; earlyEdit = false; ++sequence;
    clearTimeout(timer); unavailable = ''; notify();
  }
  function switchSlot(next, provider = '') {
    fallbackProvider = provider;
    if (next === slot) return;
    changed();
    slot = next; ++sequence; earlyEdit = false;
    apply();
    if (current && !current.session.status().ready) restoreAfterRead(current, sequence);
  }
  async function beginSend() {
    if (!current) return null;
    const context = current, which = slot, draft = changed({ uncertain: true });
    if (!draft) throw Object.assign(new Error('草稿尚未保存，本次未发送。请检查本机草稿状态。'), { code: 'DRAFT_STORAGE_ERROR' });
    const token = { context, slot: which, revision: draft.revision };
    try { await context.session.flush(); return token; }
    catch (error) {
      const latest = context.session.get(which);
      if (latest) context.session.upsert({ ...latest, uncertain: false, revision: crypto.randomUUID(), updatedAt: new Date().toISOString() });
      notify();
      throw Object.assign(new Error('草稿尚未保存，本次未发送。请打开本机草稿处理保存问题。'), { code: error.code || 'DRAFT_STORAGE_ERROR' });
    }
  }
  function moveCreated(token, next, follow) {
    if (!token) { if (follow && !current) { pageSlots.delete(slot); slot = next; changed(); ++sequence; } return; }
    if (!follow || current !== token.context || slot !== token.slot) return;
    const draft = current.session.get(slot);
    if (!draft) return;
    try {
      if (!current.session.moveIfRevision(slot, next, draft.revision)) throw Object.assign(new Error('草稿已变化。'), { code: 'DRAFT_CONFLICT' });
      slot = next; token.slot = next; ++sequence; schedule(); notify();
    } catch (error) { current.error = { code: error.code || 'DRAFT_STORAGE_ERROR' }; notify(); }
  }
  function finishSend(token, { accepted = false, definite = false } = {}) {
    if (!token) return;
    const context = token.context, latest = context.session.get(token.slot);
    if (!latest) return;
    if (accepted && latest.revision === token.revision) {
      context.session.removeIfRevision(token.slot, token.revision);
      if (current === context && slot === token.slot) apply();
    } else if (accepted || definite) {
      context.session.upsert({ ...latest, uncertain: false, revision: crypto.randomUUID(), updatedAt: new Date().toISOString() });
      if (current === context && slot === token.slot) notify();
    }
    void context.session.flush().catch(() => {}).finally(notify);
  }
  return Object.freeze({
    bind, detach, switchSlot, changed, beginSend, moveCreated, finishSend,
    uncertain: () => Boolean(viewDraft()?.uncertain),
    pending: () => (!current && ([...pageSlots.values()].some(meaningful) || (earlyEdit && meaningful(read())))) || [...contexts.values()].some(context => Boolean(context.volatile.size || context.error || context.session.status().pending)),
    list: () => current?.session.list() || [],
    conflicts: () => current?.session.status().conflicts || [],
    currentSlot: () => slot,
    async ready() { if (current) await current.session.ready(); },
    async flush() { clearTimeout(timer); if (current) { changed(); await current.session.flush(); } notify(); },
    async refresh() {
      const context = current, ticket = sequence;
      if (!context) return;
      await context.session.refresh();
      if (current === context && ticket === sequence && !context.error) apply();
    },
    async resolve(which, expected, choice) {
      const context = current; if (!context) return;
      await context.session.resolve(which, expected, choice);
      if (current === context && slot === which) apply();
      notify();
    },
    async discard(which, revision) {
      const context = current; if (!context) return false;
      const removed = context.session.removeIfRevision(which, revision);
      if (removed && current === context && slot === which) apply();
      await context.session.flush(); notify(); return removed;
    },
    acknowledge() { changed({ uncertain: false }); },
  });
}

// Only the authenticated loopback desktop service may supply this adapter.
// Browser and mobile gateway clients always use their own IndexedDB instead.
export function createDesktopDraftAdapter({ storageId, request, isCurrent }) {
  async function operation(method, body) {
    if (!isCurrent()) throw Object.assign(new Error('草稿工作区已切换。'), { code: 'DRAFT_CONTEXT_CHANGED' });
    const result = await request('/api/device-drafts', { method,
      headers: { 'X-OpenAster-Storage-Id': storageId }, ...(body ? { body } : {}) });
    if (!isCurrent() || result.storageId !== storageId) throw Object.assign(new Error('草稿工作区已切换。'), { code: 'DRAFT_CONTEXT_CHANGED' });
    return validateDraftSnapshot(result.snapshot);
  }
  return Object.freeze({
    read: () => operation('GET'),
    compareAndSwap: (_scope, expectedRevision, drafts) => operation('POST', { storageId, expectedRevision, drafts }),
  });
}
