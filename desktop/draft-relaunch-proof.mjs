// SPDX-License-Identifier: Apache-2.0

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INTERACTION = 'webContents.insertText + DOM click/change; not physical keyboard';
const LABEL = '草稿已保存';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const DIAGNOSTIC_PREFIX = 'OPENASTER_DRAFT_UI_DIAGNOSTIC ';
const DIAGNOSTIC_STAGES = new Set([
  'validate-arguments', 'initial-ui-ready', 'initial-snapshot-read', 'initial-snapshot-compare',
  'install-input-observer', 'read-input-observer', 'activate-slot', 'wait-slot-ready',
  'initial-slot-observation', 'select-provider-and-focus', 'select-provider', 'focus-input', 'insert-text', 'wait-ui-saved',
  'saved-snapshot-read', 'saved-snapshot-compare', 'record-slot-observation', 'verify-input-events',
  'final-snapshot-read', 'final-snapshot-compare', 'complete',
]);
const DIAGNOSTIC_SLOTS = new Set(['new', 'task', 'none', 'other']);
const DIAGNOSTIC_LABELS = new Set(['empty-ready', 'saved', 'loading', 'saving', 'conflict', 'unsaved', 'page-only', 'uncertain', 'unknown']);

function requireValue(value) { if (!value) throw new Error('Invalid proof'); }
function object(value) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  return value;
}
function own(value, key) {
  object(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
  return descriptor.value;
}
function shape(value, keys) {
  object(value);
  const actual = Reflect.ownKeys(value);
  requireValue(actual.length === keys.length && actual.every(key => keys.includes(key)));
  return Object.fromEntries(keys.map(key => [key, own(value, key)]));
}
function array(value, maximum) {
  requireValue(Array.isArray(value));
  const size = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  requireValue(Number.isInteger(size) && size >= 0 && size <= maximum);
  requireValue(Reflect.ownKeys(value).length === size + 1);
  return Array.from({ length: size }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    return descriptor.value;
  });
}
function identifier(value) { requireValue(typeof value === 'string' && ID.test(value)); return value; }
function uuid(value) { requireValue(typeof value === 'string' && UUID.test(value)); return value; }
function equal(left, right) { requireValue(JSON.stringify(left) === JSON.stringify(right)); }
function fields(value, empty = false) {
  requireValue(Number.isSafeInteger(value.textLength) && value.textLength >= (empty ? 0 : 1) && value.textLength <= 16000);
  requireValue(Number.isSafeInteger(value.textBytes) && value.textBytes >= value.textLength && value.textBytes <= value.textLength * 3);
  requireValue(typeof value.textSha256 === 'string' && SHA256.test(value.textSha256));
  identifier(value.providerId);
  requireValue(value.skillId === '');
  requireValue(array(value.files, 0).length === 0);
  if (empty) requireValue(value.textLength === 0 && value.textBytes === 0 && value.textSha256 === EMPTY_SHA256);
}
function bySlot(values, slots) {
  requireValue(values.length === slots.length);
  requireValue(new Set(values.map(value => value.slot)).size === slots.length);
  requireValue(values.every(value => slots.includes(value.slot)));
  return slots.map(slot => values.find(value => value.slot === slot));
}
function snapshot(value, slots, empty = false) {
  const clean = shape(value, ['version', 'revision', 'drafts']);
  requireValue(clean.version === 1);
  const drafts = array(clean.drafts, 2).map(draft => {
    const item = shape(draft, ['slot', 'revision', 'updatedAt', 'textLength', 'textBytes', 'textSha256', 'providerId', 'skillId', 'uncertain', 'files']);
    identifier(item.slot); uuid(item.revision); fields(item);
    requireValue(typeof item.updatedAt === 'string' && item.updatedAt.length === 24 && new Date(item.updatedAt).toISOString() === item.updatedAt);
    requireValue(item.uncertain === false);
    return { ...item, files: [] };
  });
  if (empty) {
    requireValue(clean.revision === '0' && drafts.length === 0);
    return { version: 1, revision: '0', drafts: [] };
  }
  uuid(clean.revision);
  return { version: 1, revision: clean.revision, drafts: bySlot(drafts, slots) };
}
function phaseProof(value, slots, seed) {
  const clean = shape(value, ['version', 'storageId', 'mode', 'initialSnapshot', 'snapshot', 'initialObservations', 'observations', 'inputEvents', 'interaction']);
  requireValue(clean.version === 1 && clean.mode === (seed ? 'seed' : 'restore') && clean.interaction === INTERACTION);
  uuid(clean.storageId);
  const initialSnapshot = snapshot(clean.initialSnapshot, slots, seed);
  const saved = snapshot(clean.snapshot, slots);
  for (const [name, empty] of [['initialObservations', seed], ['observations', false]]) {
    const observations = bySlot(array(clean[name], 2).map(observation => {
      const item = shape(observation, ['slot', 'textLength', 'textBytes', 'textSha256', 'providerId', 'skillId', 'files', 'savedLabel', 'storage']);
      identifier(item.slot); fields(item, empty);
      requireValue(item.savedLabel === (empty ? '本机草稿' : LABEL) && item.storage === 'system-encrypted');
      return { ...item, files: [] };
    }), slots);
    if (!empty) for (let i = 0; i < slots.length; i++) {
      for (const key of ['textLength', 'textBytes', 'textSha256', 'providerId', 'skillId', 'files']) equal(observations[i][key], saved.drafts[i][key]);
    }
  }
  bySlot(array(clean.inputEvents, 2).map(event => {
    const item = shape(event, ['slot', 'count', 'inputTypes', 'trusted']);
    identifier(item.slot);
    requireValue(Number.isSafeInteger(item.count) && item.count >= 0 && item.count <= 1000 && typeof item.trusted === 'boolean');
    const types = array(item.inputTypes, 16);
    requireValue(types.every(type => typeof type === 'string' && /^[A-Za-z]{0,64}$/u.test(type)) && new Set(types).size === types.length);
    requireValue(seed ? item.count > 0 && types.length > 0 && types.length <= item.count : item.count === 0 && types.length === 0);
    return item;
  }), slots);
  if (!seed) equal(initialSnapshot, saved);
  return { storageId: clean.storageId, initialSnapshot, snapshot: saved };
}

/** Verify recorded five-process UI observations against the two original saves.
 * The caller still owns process exit, owner, executable and file identity checks.
 * Metadata contains hashes, never draft text or credentials. */
export function validateDraftRelaunchProofs(proofs, scenario) {
  try {
    const sourceId = identifier(own(scenario, 'sourceSessionId'));
    requireValue(sourceId !== 'new');
    const restoredId = uuid(own(scenario, 'restoredProfileId'));
    const slots = ['new', sourceId].sort();
    const entries = array(proofs, 5);
    requireValue(entries.length === 5);
    const pids = new Set();
    const values = entries.map((entry, index) => {
      const clean = shape(entry, ['phase', 'pid', 'proof']);
      requireValue(clean.phase === index && Number.isSafeInteger(clean.pid) && clean.pid > 0 && !pids.has(clean.pid));
      pids.add(clean.pid);
      requireValue(own(clean.proof, 'workspaceId') === (index === 2 || index === 4 ? restoredId : 'default'));
      return phaseProof(own(clean.proof, 'deviceDrafts'), slots, index === 0 || index === 2);
    });
    requireValue(values[0].storageId !== values[2].storageId);
    for (const [phase, seed] of [[1, 0], [3, 0], [4, 2]]) {
      requireValue(values[phase].storageId === values[seed].storageId);
      equal(values[phase].initialSnapshot, values[seed].snapshot);
      equal(values[phase].snapshot, values[seed].snapshot);
    }
    for (let i = 0; i < slots.length; i++) requireValue(values[0].snapshot.drafts[i].textSha256 !== values[2].snapshot.drafts[i].textSha256);
    return { version: 1, profiles: 2, draftsPerProfile: 2, seedPhases: [0, 2], restorePhases: [1, 3, 4], interaction: INTERACTION };
  } catch {
    const error = new Error('Desktop draft relaunch evidence is incomplete or inconsistent.');
    error.code = 'INVALID_DRAFT_RELAUNCH_PROOF';
    throw error;
  }
}

/** Parse only the bounded, fixed-field diagnostic emitted by the UI smoke.
 * Never forwards the original line, error, arbitrary property or identifier. */
export function parseDraftUiDiagnostic(line) {
  try {
    if (typeof line !== 'string' || line.length > 2048 || Buffer.byteLength(line, 'utf8') > 2048
      || /[\r\n]/u.test(line) || !line.startsWith(DIAGNOSTIC_PREFIX)) return null;
    const clean = shape(JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length)), ['stage', 'code', 'mode', 'view', 'inputEvents']);
    requireValue(DIAGNOSTIC_STAGES.has(clean.stage) && clean.code === 'NATIVE_DRAFT_CHECK_FAILED');
    requireValue(['unknown', 'seed', 'restore'].includes(clean.mode));
    let view = null, inputEvents = null;
    if (clean.view !== null) {
      view = shape(clean.view, ['connected', 'visible', 'slot', 'label', 'encrypted', 'attention', 'historyReady', 'dialogOpen',
        'providerDisabled', 'providerMatched', 'filesEmpty', 'skillEmpty', 'textLength', 'textSha256']);
      for (const key of ['connected', 'visible', 'encrypted', 'attention', 'historyReady', 'dialogOpen', 'providerDisabled', 'filesEmpty', 'skillEmpty']) requireValue(typeof view[key] === 'boolean');
      requireValue(DIAGNOSTIC_SLOTS.has(view.slot) && DIAGNOSTIC_LABELS.has(view.label));
      requireValue(view.providerMatched === null || typeof view.providerMatched === 'boolean');
      requireValue(view.textLength === null || (Number.isSafeInteger(view.textLength) && view.textLength >= 0 && view.textLength <= 16000));
      requireValue(view.textSha256 === null || (typeof view.textSha256 === 'string' && SHA256.test(view.textSha256)));
      requireValue((view.textLength === null) === (view.textSha256 === null));
      if (view.textLength === 0) requireValue(view.textSha256 === EMPTY_SHA256);
    }
    if (clean.inputEvents !== null) {
      inputEvents = shape(clean.inputEvents, ['slot', 'count', 'expired']);
      requireValue(DIAGNOSTIC_SLOTS.has(inputEvents.slot) && typeof inputEvents.expired === 'boolean');
      requireValue(inputEvents.count === null || (Number.isSafeInteger(inputEvents.count) && inputEvents.count >= 0 && inputEvents.count <= 1000));
    }
    return { stage: clean.stage, code: clean.code, mode: clean.mode, view, inputEvents };
  } catch { return null; }
}
