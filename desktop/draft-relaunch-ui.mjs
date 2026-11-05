// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateDraftSnapshot } from '../public/composer-drafts.mjs';

const WAIT_MS = 10000;
const OBSERVER_ATTRIBUTE = 'data-openaster-draft-smoke-observer';
const OBSERVER_STOP = 'openaster-draft-smoke-observer-stop';
const INTERACTION = 'webContents.insertText + DOM click/change; not physical keyboard';
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const textMetadata = text => ({ textLength: text.length, textBytes: Buffer.byteLength(text, 'utf8'), textSha256: sha256(text) });
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const timeoutError = () => Object.assign(new Error('Native draft UI did not become ready within its bounded wait.'), { code: 'NATIVE_DRAFT_UI_TIMEOUT' });

async function bounded(promise, milliseconds = WAIT_MS) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), Math.max(1, milliseconds)); })]); }
  finally { clearTimeout(timer); }
}

function metadata(snapshot) {
  return {
    version: snapshot.version, revision: snapshot.revision,
    drafts: snapshot.drafts.map(draft => ({
      slot: draft.slot, revision: draft.revision, updatedAt: draft.updatedAt,
      ...textMetadata(draft.text), providerId: draft.providerId, skillId: draft.skillId,
      uncertain: draft.uncertain, files: draft.files.map(file => ({ ...file })),
    })).sort((left, right) => left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0),
  };
}

/** Operates only the owner-validated smoke window's production DOM. It never
 * calls application internals, writes a repository/API draft, or submits work.
 * Call before the smoke's controlled-idle seal, which pauses new HTTP requests.
 */
export async function verifyDraftWorkspace(options) {
  const diagnostic = { stage: 'validate-arguments', mode: 'unknown', view: null, inputEvents: null };
  try { return await verifyWorkspace(options, diagnostic); }
  catch (error) {
    // This helper is only invoked in the owner-validated native smoke. Do not
    // print the thrown error or arguments: they can contain text or identities.
    try { console.error('OPENASTER_DRAFT_UI_DIAGNOSTIC ' + JSON.stringify({
      stage: diagnostic.stage, code: 'NATIVE_DRAFT_CHECK_FAILED', mode: diagnostic.mode,
      view: diagnostic.view, inputEvents: diagnostic.inputEvents,
    })); } catch { /* Retain the original failure if diagnostics cannot print. */ }
    throw error;
  }
}

async function verifyWorkspace({ window, request, bootstrap, sessionId, expected, seed }, diagnostic) {
  const contents = window?.webContents;
  assert(contents && typeof contents.executeJavaScript === 'function' && typeof contents.insertText === 'function');
  assert.equal(typeof request, 'function');
  assert(typeof sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(sessionId) && sessionId !== 'new');
  const storageId = bootstrap?.workspace?.storageId;
  assert(typeof storageId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(storageId));
  assert.equal(bootstrap.capabilities?.deviceDrafts, 1);
  assert(expected === null || typeof expected === 'object');
  assert(seed === null || (typeof seed === 'object' && Object.keys(seed).sort().join(',') === 'newProviderId,newText,taskProviderId,taskText'));
  diagnostic.mode = seed ? 'seed' : 'restore';
  const previous = expected === null ? null : validateDraftSnapshot(expected);
  const slots = ['new', sessionId];
  let expectedProvider = null;
  const slotKind = slot => slot === 'new' ? 'new' : slot === sessionId ? 'task' : slot == null ? 'none' : 'other';
  function captureView(value) {
    const labels = { '本机草稿': 'empty-ready', '草稿已保存': 'saved', '读取草稿…': 'loading',
      '正在保存…': 'saving', '草稿有冲突': 'conflict', '草稿未保存': 'unsaved',
      '草稿仅在本页': 'page-only', '发送结果待核对': 'uncertain' };
    diagnostic.view = {
      connected: value.connected === true, visible: value.visible === true, slot: slotKind(value.slot),
      label: Object.hasOwn(labels, value.savedLabel) ? labels[value.savedLabel] : 'unknown',
      encrypted: value.encrypted === true, attention: value.attention === true,
      historyReady: value.historyReady === true, dialogOpen: value.dialogOpen === true,
      providerDisabled: value.providerDisabled === true, providerMatched: expectedProvider === null ? null : value.providerId === expectedProvider,
      filesEmpty: value.files.length === 0, skillEmpty: value.skillEmpty === true,
      textLength: typeof value.text === 'string' ? value.text.length : null,
      textSha256: typeof value.text === 'string' ? sha256(value.text) : null,
    };
  }
  function textOnlySnapshot(snapshot) {
    assert(snapshot.drafts.every(draft => slots.includes(draft.slot)), 'Unexpected draft slot in owned smoke workspace');
    for (const draft of snapshot.drafts) {
      assert.equal(draft.files.length, 0, 'This UI scenario covers text drafts only');
      assert.equal(draft.skillId, ''); assert.equal(draft.uncertain, false);
    }
    return snapshot;
  }
  if (previous) textOnlySnapshot(previous);
  if (seed) for (const prefix of ['new', 'task']) {
    const text = seed[prefix + 'Text'], provider = seed[prefix + 'ProviderId'];
    assert(typeof text === 'string' && text.length > 0 && text.length <= 16000 && text.isWellFormed() && !text.includes('\r'), 'Use nonempty well-formed textarea text with LF newlines');
    assert(typeof provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(provider));
    assert(bootstrap.providers?.some(item => item.id === provider && item.enabled !== false), 'Seed provider must be available');
  }
  const execute = code => bounded(contents.executeJavaScript(code));
  async function readSnapshot() {
    const response = await bounded(request('/api/device-drafts'));
    assert.equal(response?.storageId, storageId, 'Draft response belongs to another workspace');
    return textOnlySnapshot(validateDraftSnapshot(response.snapshot));
  }
  async function dom() {
    const value = await execute(`(() => {
      const input = document.querySelector('#prompt-input'), model = document.querySelector('#model-select');
      const label = document.querySelector('#composer-draft-label'), status = document.querySelector('#composer-draft-status');
      const home = document.querySelector('#home-view'), chat = document.querySelector('#chat-view');
      const skill = document.querySelector('#composer-context'), skillLabel = document.querySelector('#skill-label');
      return {
        connected: Boolean(document.querySelector('#connection-indicator.connected')),
        visible: Boolean(input?.getClientRects().length && !input.closest('[inert]')),
        slot: home && !home.classList.contains('hidden') ? 'new' : chat && !chat.classList.contains('hidden') ? sessionStorage.getItem('openaster.current-session') : null,
        text: input?.value ?? null, providerId: model?.value ?? null, providerDisabled: Boolean(model?.disabled),
        providerAvailable: Boolean(model && !model.disabled && [...model.options].some(option => option.value === ${JSON.stringify(expectedProvider)} && !option.disabled)),
        savedLabel: label?.textContent ?? '', encrypted: Boolean(status?.title.startsWith('此设备的草稿使用系统加密存储。')),
        attention: Boolean(status?.classList.contains('draft-attention')),
        files: [...document.querySelectorAll('#draft-file-list .draft-file-chip')].map(node => node.dataset.path),
        skillEmpty: Boolean(skill?.classList.contains('hidden') && skillLabel?.textContent === ''),
        historyReady: document.querySelector('#send-hint')?.textContent === 'Enter 发送',
        dialogOpen: Boolean(document.querySelector('dialog[open]')),
      };
    })()`);
    captureView(value); return value;
  }
  async function waitDOM(predicate) {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      const value = await bounded(dom(), deadline - Date.now());
      if (predicate(value)) return value;
      await pause();
    }
    throw timeoutError();
  }
  const ready = value => value.connected && value.visible && value.encrypted && !value.attention && !value.dialogOpen
    && ['本机草稿', '草稿已保存'].includes(value.savedLabel);
  diagnostic.stage = 'initial-ui-ready';
  await waitDOM(ready);
  diagnostic.stage = 'initial-snapshot-read';
  const initial = await readSnapshot();
  diagnostic.stage = 'initial-snapshot-compare';
  if (previous) assert(JSON.stringify(initial) === JSON.stringify(previous), 'Complete saved draft snapshot changed across processes');
  else assert.equal(initial.drafts.length, 0, 'Expected a new workspace with no saved drafts');

  async function observe(slot, action) {
    // A short-lived DOM observer records actual input events from insertText.
    // No observer handle or business function is exposed on window/globalThis.
    diagnostic.stage = 'install-input-observer';
    await execute(`(() => {
      const input = document.querySelector('#prompt-input');
      const attribute = ${JSON.stringify(OBSERVER_ATTRIBUTE)}, stop = ${JSON.stringify(OBSERVER_STOP)};
      if (!input || input.hasAttribute(attribute)) throw new Error('Draft smoke input observer is unavailable');
      const controller = new AbortController();
      const value = { slot: ${JSON.stringify(slot)}, count: 0, inputTypes: [], trusted: false };
      input.setAttribute(attribute, JSON.stringify(value));
      const timer = setTimeout(() => { controller.abort(); input.setAttribute(attribute, JSON.stringify({ expired: true })); }, ${WAIT_MS});
      input.addEventListener('input', event => {
        value.trusted = value.count === 0 ? event.isTrusted : value.trusted && event.isTrusted;
        value.count++;
        if (typeof event.inputType === 'string' && event.inputType && !value.inputTypes.includes(event.inputType)) value.inputTypes.push(event.inputType);
        input.setAttribute(attribute, JSON.stringify(value));
      }, { signal: controller.signal });
      input.addEventListener(stop, () => { clearTimeout(timer); controller.abort(); }, { once: true, signal: controller.signal });
    })()`);
    let events, failure;
    try { await action(); } catch (error) { failure = error; }
    try {
      if (!failure) diagnostic.stage = 'read-input-observer';
      events = await execute(`(() => {
        const input = document.querySelector('#prompt-input'), attribute = ${JSON.stringify(OBSERVER_ATTRIBUTE)};
        if (!input) throw new Error('Draft smoke input disappeared');
        input.dispatchEvent(new Event(${JSON.stringify(OBSERVER_STOP)}));
        const value = JSON.parse(input.getAttribute(attribute) || 'null'); input.removeAttribute(attribute); return value;
      })()`);
      diagnostic.inputEvents = { slot: slotKind(slot), count: Number.isSafeInteger(events?.count) && events.count >= 0 ? events.count : null,
        expired: events?.expired === true };
    } catch (error) { failure ??= error; }
    if (failure) throw failure;
    assert(events && events.expired !== true && events.slot === slot, 'Draft smoke observer did not finish in time');
    assert(Number.isSafeInteger(events.count) && events.count >= 0 && typeof events.trusted === 'boolean');
    assert(Array.isArray(events.inputTypes) && events.inputTypes.every(value => typeof value === 'string' && value.length > 0));
    return events;
  }
  async function visit(slot) {
    diagnostic.stage = 'activate-slot';
    await execute(`(() => {
      const slot = ${JSON.stringify(slot)};
      const node = slot === 'new' ? document.querySelector('.new-task[data-action="new"]')
        : [...document.querySelectorAll('#session-list [data-action="open-session"]')].find(item => item.dataset.id === slot);
      if (!node || node.disabled || !node.getClientRects().length || node.closest('[inert]')) throw new Error('Draft smoke navigation is unavailable');
      node.click();
    })()`);
    diagnostic.stage = 'wait-slot-ready';
    return waitDOM(value => ready(value) && value.slot === slot && value.historyReady && !value.providerDisabled);
  }
  function matches(value, draft) {
    return value.text === draft.text && value.providerId === draft.providerId && value.files.length === 0 && value.skillEmpty
      && value.savedLabel === '草稿已保存';
  }
  function observation(slot, value) {
    assert.equal(value.files.length, 0); assert.equal(value.skillEmpty, true);
    assert.equal(value.encrypted, true, 'The production UI did not identify system-encrypted draft storage');
    return { slot, ...textMetadata(value.text), providerId: value.providerId, skillId: '', files: [], savedLabel: value.savedLabel, storage: 'system-encrypted' };
  }
  const initialObservations = [], observations = [], inputEvents = [];
  let finalSnapshot = initial;
  for (const slot of slots) {
    let observed;
    expectedProvider = initial.drafts.find(draft => draft.slot === slot)?.providerId ?? null;
    const events = await observe(slot, async () => {
      let value = await visit(slot);
      const old = initial.drafts.find(draft => draft.slot === slot);
      diagnostic.stage = 'initial-slot-observation';
      if (old) value = await waitDOM(current => ready(current) && current.slot === slot && current.historyReady && matches(current, old));
      else { assert.equal(value.text, ''); assert.equal(value.files.length, 0); assert.equal(value.skillEmpty, true); assert.equal(value.savedLabel, '本机草稿'); }
      initialObservations.push(observation(slot, value));
      if (seed) {
        const prefix = slot === 'new' ? 'new' : 'task', text = seed[prefix + 'Text'], providerId = seed[prefix + 'ProviderId'];
        expectedProvider = providerId;
        diagnostic.stage = 'select-provider';
        await waitDOM(current => ready(current) && current.slot === slot && current.historyReady && current.providerAvailable);
        const selection = await execute(`(() => {
          const model = document.querySelector('#model-select'), id = ${JSON.stringify(providerId)};
          const option = [...model.options].find(item => item.value === id);
          if (model.disabled || !option || option.disabled) return 'model-unavailable';
          model.value = id; model.dispatchEvent(new Event('change', { bubbles: true }));
          const input = document.querySelector('#prompt-input'); input.focus(); input.setSelectionRange(0, input.value.length);
          return document.activeElement === input ? 'ready' : 'focus-unavailable';
        })()`);
        assert.notEqual(selection, 'model-unavailable', 'Draft smoke model is unavailable');
        diagnostic.stage = 'focus-input';
        assert.equal(selection, 'ready', 'Draft smoke input was not focused');
        diagnostic.stage = 'insert-text';
        await bounded(contents.insertText(text));
        diagnostic.stage = 'wait-ui-saved';
        value = await waitDOM(current => ready(current) && current.slot === slot && current.historyReady
          && current.text === text && current.providerId === providerId && current.savedLabel === '草稿已保存');
        diagnostic.stage = 'saved-snapshot-read';
        finalSnapshot = await readSnapshot();
        diagnostic.stage = 'saved-snapshot-compare';
        const saved = finalSnapshot.drafts.find(draft => draft.slot === slot);
        assert(saved && saved.text === text && saved.providerId === providerId, 'UI save did not persist the exact selected text and provider');
        assert.equal(saved.files.length, 0); assert.equal(saved.skillId, ''); assert.equal(saved.uncertain, false);
      }
      diagnostic.stage = 'record-slot-observation';
      observed = observation(slot, value);
    });
    diagnostic.stage = 'verify-input-events';
    if (seed) { assert(events.count > 0, 'insertText did not produce a production input event'); assert(events.inputTypes.length > 0); }
    else { assert.equal(events.count, 0, 'Restoring drafts must not synthesize typing'); assert.equal(events.inputTypes.length, 0); }
    observations.push(observed); inputEvents.push(events);
  }
  diagnostic.stage = 'final-snapshot-read';
  const confirmed = await readSnapshot();
  diagnostic.stage = 'final-snapshot-compare';
  assert(JSON.stringify(confirmed) === JSON.stringify(finalSnapshot), 'Draft snapshot changed after the UI verification');
  if (seed) {
    assert.equal(confirmed.drafts.length, 2);
    for (const item of observations) {
      const draft = confirmed.drafts.find(value => value.slot === item.slot);
      assert(draft); assert.equal(item.providerId, draft.providerId); assert.equal(item.savedLabel, '草稿已保存');
      assert.equal(item.textSha256, sha256(draft.text)); assert.equal(item.textLength, draft.text.length);
      assert.equal(item.textBytes, Buffer.byteLength(draft.text, 'utf8'));
    }
  }
  diagnostic.stage = 'complete';
  return { snapshot: confirmed, proof: { version: 1, mode: seed ? 'seed' : 'restore', storageId,
    initialSnapshot: metadata(initial), snapshot: metadata(confirmed), initialObservations, observations, inputEvents, interaction: INTERACTION } };
}
