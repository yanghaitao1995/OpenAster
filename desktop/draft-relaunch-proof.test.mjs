// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { validateDraftSnapshot } from '../public/composer-drafts.mjs';
import { validateDraftRelaunchProofs, parseDraftUiDiagnostic } from './draft-relaunch-proof.mjs';

const INTERACTION = 'webContents.insertText + DOM click/change; not physical keyboard';
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const empty = () => ({ version: 1, revision: '0', drafts: [] });
function saved(profile, sourceId) {
  const actual = validateDraftSnapshot({ version: 1, revision: randomUUID(), drafts: ['new', sourceId].map(slot => ({
    slot, text: '\ufeff' + profile + ' / ' + slot + '\n未发送的草稿🙂', files: [], providerId: 'demo', skillId: '',
    updatedAt: '2026-10-30T10:00:00.000Z', revision: randomUUID(), uncertain: false,
  })) });
  return { version: actual.version, revision: actual.revision, drafts: actual.drafts.map(({ text, ...draft }) => ({
    slot: draft.slot, revision: draft.revision, updatedAt: draft.updatedAt, textLength: text.length,
    textBytes: Buffer.byteLength(text), textSha256: hash(text), providerId: draft.providerId,
    skillId: draft.skillId, uncertain: draft.uncertain, files: draft.files,
  })).sort((a, b) => a.slot.localeCompare(b.slot)) };
}
function device(storageId, snapshot, seed) {
  const observations = snapshot.drafts.map(draft => ({
      slot: draft.slot, textLength: draft.textLength, textBytes: draft.textBytes, textSha256: draft.textSha256,
      providerId: draft.providerId, skillId: draft.skillId, files: [], savedLabel: '草稿已保存', storage: 'system-encrypted',
    }));
  const initialObservations = observations.map(value => seed ? { ...value, textLength: 0, textBytes: 0, textSha256: hash(''), savedLabel: '本机草稿' } : clone(value));
  return { version: 1, storageId, mode: seed ? 'seed' : 'restore', initialSnapshot: seed ? empty() : clone(snapshot),
    snapshot: clone(snapshot), initialObservations, observations, inputEvents: snapshot.drafts.map(draft => ({ slot: draft.slot, count: seed ? 1 : 0,
      inputTypes: seed ? ['insertText'] : [], trusted: seed })), interaction: INTERACTION };
}
function fixture() {
  const scenario = { sourceSessionId: 'task-source', restoredProfileId: randomUUID() };
  const original = saved('default', scenario.sourceSessionId), restored = saved('restored', scenario.sourceSessionId);
  const firstId = randomUUID(), secondId = randomUUID();
  const proofs = [0, 1, 2, 3, 4].map(phase => {
    const isRestored = phase === 2 || phase === 4;
    return { phase, pid: 700001 + phase, proof: {
      workspaceId: isRestored ? scenario.restoredProfileId : 'default', sandboxed: true,
      deviceDrafts: device(isRestored ? secondId : firstId, isRestored ? restored : original, phase === 0 || phase === 2),
    } };
  });
  return { proofs, scenario };
}
function invalid(change) {
  const { proofs, scenario } = fixture(); change(proofs, scenario);
  assert.throws(() => validateDraftRelaunchProofs(proofs, scenario), { code: 'INVALID_DRAFT_RELAUNCH_PROOF' });
}

test('two independently saved profiles survive three later process observations without copying plaintext into evidence', () => {
  const { proofs, scenario } = fixture(), before = clone(proofs);
  assert.deepEqual(validateDraftRelaunchProofs(proofs, scenario), {
    version: 1, profiles: 2, draftsPerProfile: 2, seedPhases: [0, 2], restorePhases: [1, 3, 4], interaction: INTERACTION,
  });
  assert.deepEqual(proofs, before);
  assert.equal(JSON.stringify(proofs).includes('未发送的草稿'), false);
  assert.equal(JSON.stringify(proofs).includes('text"'), false);
});

test('an empty restored workspace or a generic success flag is not restoration evidence', () => {
  invalid(proofs => { proofs[4].proof.deviceDrafts.initialSnapshot = empty(); proofs[4].proof.deviceDrafts.snapshot = empty(); });
  invalid(proofs => { proofs[4].proof.deviceDrafts = { restored: true, empty: true }; });
  invalid(proofs => { proofs[2].proof.deviceDrafts.initialSnapshot = clone(proofs[0].proof.deviceDrafts.snapshot); });
  invalid(proofs => { proofs[0].proof.deviceDrafts.initialSnapshot.revision = randomUUID(); });
  invalid(proofs => { proofs[4].proof.deviceDrafts.observations[0].savedLabel = '本机草稿'; });
  invalid(proofs => { proofs[2].proof.deviceDrafts.initialObservations = clone(proofs[0].proof.deviceDrafts.observations); });
  invalid(proofs => { proofs[2].proof.deviceDrafts.initialObservations[0].textSha256 = hash('stale text'); });
});

test('phase order, distinct processes and workspace mapping must all describe the same five-stage chain', () => {
  invalid(proofs => proofs.pop());
  invalid(proofs => { [proofs[1], proofs[2]] = [proofs[2], proofs[1]]; });
  invalid(proofs => { proofs[4].pid = proofs[2].pid; });
  invalid(proofs => { proofs[1].pid = 0; });
  invalid(proofs => { proofs[3].proof.workspaceId = proofs[2].proof.workspaceId; });
  invalid((_, scenario) => { scenario.sourceSessionId = 'new'; });
  invalid((_, scenario) => { scenario.restoredProfileId = 'default'; });
});

test('profile storage identity cannot drift or alias the source after a logical restore', () => {
  invalid(proofs => { proofs[1].proof.deviceDrafts.storageId = randomUUID(); });
  invalid(proofs => { proofs[4].proof.deviceDrafts.storageId = proofs[0].proof.deviceDrafts.storageId; });
  invalid(proofs => {
    for (const phase of [2, 4]) proofs[phase].proof.deviceDrafts.storageId = proofs[0].proof.deviceDrafts.storageId;
  });
  invalid(proofs => {
    for (const phase of [2, 4]) proofs[phase].proof.deviceDrafts = device(proofs[phase].proof.deviceDrafts.storageId, proofs[0].proof.deviceDrafts.snapshot, phase === 2);
  });
});

test('both task slots are independently required and the selected task cannot be silently substituted', () => {
  invalid(proofs => { proofs[1].proof.deviceDrafts.snapshot.drafts.pop(); });
  invalid(proofs => { proofs[0].proof.deviceDrafts.snapshot.drafts[1].slot = 'new'; });
  invalid(proofs => { proofs[0].proof.deviceDrafts.observations[1].slot = 'foreign-task'; });
  invalid(proofs => { proofs[0].proof.deviceDrafts.inputEvents[1].slot = 'new'; });
  invalid(proofs => { proofs[3].proof.deviceDrafts = device(proofs[3].proof.deviceDrafts.storageId, proofs[2].proof.deviceDrafts.snapshot, false); });
});

test('restoration must preserve the complete saved revision and metadata, not just matching text', () => {
  for (const field of ['revision', 'updatedAt', 'providerId', 'uncertain']) {
    invalid(proofs => {
      const value = proofs[1].proof.deviceDrafts;
      const replacement = field === 'revision' ? randomUUID() : field === 'updatedAt' ? '2026-10-30T10:00:01.000Z' : field === 'providerId' ? 'different-provider' : true;
      for (const snapshot of [value.initialSnapshot, value.snapshot]) snapshot.drafts[0][field] = replacement;
      if (field === 'providerId') value.observations[0].providerId = replacement;
    });
  }
  invalid(proofs => {
    const value = proofs[4].proof.deviceDrafts;
    value.initialSnapshot.revision = value.snapshot.revision = randomUUID();
  });
  invalid(proofs => { proofs[4].proof.deviceDrafts.initialSnapshot.drafts[0].revision = randomUUID(); });
});

test('actual DOM text and selected provider must agree with the persisted snapshot in each process', () => {
  for (const [field, replacement] of [['textSha256', hash('stale DOM')], ['textBytes', 1], ['textLength', 1], ['providerId', 'foreign-provider'], ['skillId', 'summary']]) {
    invalid(proofs => { proofs[3].proof.deviceDrafts.observations[0][field] = replacement; });
  }
  invalid(proofs => { proofs[4].proof.deviceDrafts.observations[1] = clone(proofs[4].proof.deviceDrafts.observations[0]); });
  invalid(proofs => { proofs[4].proof.deviceDrafts.initialObservations[0].textSha256 = hash('stale initial DOM'); });
  invalid(proofs => { proofs[1].proof.deviceDrafts.initialObservations[0].storage = 'browser-local'; });
  invalid(proofs => { proofs[1].proof.deviceDrafts.observations[0].storage = 'browser-local'; });
});

test('a restore phase cannot seed again and seed phases must observe real input events', () => {
  invalid(proofs => { proofs[1].proof.deviceDrafts.mode = 'seed'; });
  invalid(proofs => { proofs[2].proof.deviceDrafts.inputEvents[0].count = 0; });
  invalid(proofs => { proofs[3].proof.deviceDrafts.inputEvents[0].count = 1; proofs[3].proof.deviceDrafts.inputEvents[0].inputTypes = ['insertText']; });
  invalid(proofs => { proofs[4].proof.deviceDrafts.inputEvents[0].inputTypes = ['insertText']; });
  invalid(proofs => { proofs[0].proof.deviceDrafts.inputEvents[0].inputTypes = []; });
  invalid(proofs => { proofs[0].proof.deviceDrafts.interaction = 'physical keyboard tested'; });
  const { proofs, scenario } = fixture();
  for (const proof of proofs) for (const event of proof.proof.deviceDrafts.inputEvents) event.trusted = false;
  assert.equal(validateDraftRelaunchProofs(proofs, scenario).profiles, 2);
});

test('bounded metadata rejects invalid dates, hashes, plaintext, files and impossible byte lengths', () => {
  for (const change of [
    draft => { draft.textLength = 0; }, draft => { draft.textLength = 16001; },
    draft => { draft.textBytes = draft.textLength * 3 + 1; }, draft => { draft.textBytes = 0; },
    draft => { draft.updatedAt = 'invalid'; }, draft => { draft.updatedAt = '2026-02-30T10:00:00.000Z'; },
    draft => { draft.textSha256 = 'A'.repeat(64); }, draft => { draft.revision = '0'; },
    draft => { draft.files.push({ path: 'private.txt', sha256: hash('private'), bytes: 7 }); },
    draft => { draft.text = 'must never enter this evidence'; }, draft => { draft.providerId = ''; },
  ]) invalid(proofs => change(proofs[0].proof.deviceDrafts.snapshot.drafts[0]));
});

test('accessors, sparse arrays and unknown fields fail closed without running a supplied getter', () => {
  let called = false;
  invalid(proofs => { Object.defineProperty(proofs[0].proof.deviceDrafts, 'snapshot', { enumerable: true, get() { called = true; throw new Error('raw secret'); } }); });
  invalid(proofs => { Object.defineProperty(proofs[1], 'proof', { enumerable: true, get() { called = true; return {}; } }); });
  assert.equal(called, false);
  invalid(proofs => { delete proofs[1].proof.deviceDrafts.observations[0]; });
  invalid(proofs => { proofs[0].proof.deviceDrafts.inputEvents.extra = 'unknown'; });
  invalid(proofs => { proofs[4].proof.deviceDrafts.secret = 'not permitted'; });
  invalid(proofs => { proofs[4].proof.deviceDrafts.snapshot.drafts[0][Symbol('hidden')] = true; });
  const { proofs, scenario } = fixture();
  const proxy = Proxy.revocable({}, {}); proxy.revoke(); proofs[0].proof.deviceDrafts = proxy.proxy;
  assert.throws(() => validateDraftRelaunchProofs(proofs, scenario), error => error.code === 'INVALID_DRAFT_RELAUNCH_PROOF' && !error.message.includes('secret'));
});

test('different enumeration and slot ordering do not rewrite immutable evidence or misidentify a task', () => {
  const { proofs, scenario } = fixture();
  for (const { proof } of proofs) {
    proof.deviceDrafts.snapshot.drafts.reverse(); proof.deviceDrafts.initialSnapshot.drafts.reverse();
    proof.deviceDrafts.initialObservations.reverse(); proof.deviceDrafts.observations.reverse(); proof.deviceDrafts.inputEvents.reverse();
  }
  const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
  deepFreeze(proofs); deepFreeze(scenario);
  assert.equal(validateDraftRelaunchProofs(proofs, scenario).draftsPerProfile, 2);
});

const diagnosticLine = value => 'OPENASTER_DRAFT_UI_DIAGNOSTIC ' + JSON.stringify(value);
function diagnostic() {
  return { stage: 'wait-ui-saved', code: 'NATIVE_DRAFT_CHECK_FAILED', mode: 'seed',
    view: { connected: true, visible: true, slot: 'task', label: 'saving', encrypted: true, attention: false,
      historyReady: true, dialogOpen: false, providerDisabled: false, providerMatched: true,
      filesEmpty: true, skillEmpty: true, textLength: 12, textSha256: hash('owned fixture text') },
    inputEvents: { slot: 'task', count: 1, expired: false } };
}

test('failure diagnostics preserve only known bounded state, including initial and nullable observations', () => {
  const value = diagnostic(), parsed = parseDraftUiDiagnostic(diagnosticLine(value));
  assert.deepEqual(parsed, value); assert.notEqual(parsed, value); assert.notEqual(parsed.view, value.view);
  for (const stage of ['select-provider-and-focus', 'select-provider', 'focus-input']) {
    assert.equal(parseDraftUiDiagnostic(diagnosticLine({ ...value, stage })).stage, stage);
  }
  parsed.view.label = 'changed'; assert.equal(value.view.label, 'saving');
  assert.deepEqual(parseDraftUiDiagnostic(diagnosticLine({ stage: 'validate-arguments', code: 'NATIVE_DRAFT_CHECK_FAILED', mode: 'unknown', view: null, inputEvents: null })),
    { stage: 'validate-arguments', code: 'NATIVE_DRAFT_CHECK_FAILED', mode: 'unknown', view: null, inputEvents: null });
  value.mode = 'restore'; value.view.providerMatched = null; value.view.textLength = null; value.view.textSha256 = null;
  value.inputEvents.count = null; value.inputEvents.expired = true;
  assert.deepEqual(parseDraftUiDiagnostic(diagnosticLine(value)), value);
  value.view.textLength = 0; value.view.textSha256 = hash(''); value.inputEvents.count = 0;
  assert.deepEqual(parseDraftUiDiagnostic(diagnosticLine(value)), value);
});

test('diagnostic parser rejects raw errors, identities, paths, URLs and unknown fields at every level', () => {
  for (const change of [
    value => { value.message = 'secret message'; }, value => { value.error = { stack: 'private stack' }; },
    value => { value.storageId = randomUUID(); }, value => { value.view.providerId = 'private-provider'; },
    value => { value.view.url = 'https://private.example/key'; }, value => { value.view.path = 'private/file'; },
    value => { value.view.text = 'actual draft body'; }, value => { value.inputEvents.raw = 'private payload'; },
    value => { value.view.slot = randomUUID(); }, value => { value.inputEvents.slot = 'task-source'; },
    value => { value.view.label = '草稿已保存'; }, value => { value.view.providerMatched = 'provider-id'; },
    value => { value.stage = 'request https://private.example'; }, value => { value.code = 'raw backend error'; },
    value => { value.mode = 'customer-workspace'; },
  ]) { const value = diagnostic(); change(value); assert.equal(parseDraftUiDiagnostic(diagnosticLine(value)), null); }
  assert.equal(parseDraftUiDiagnostic('OPENASTER_DRAFT_UI_DIAGNOSTIC {"__proto__":{"secret":true}}'), null);
});

test('diagnostic values and the entire line have hard limits without coercion or multiline forwarding', () => {
  for (const change of [
    value => { value.view.connected = 1; }, value => { value.view = []; },
    value => { value.view.textLength = -1; }, value => { value.view.textLength = 16001; },
    value => { value.view.textLength = 1.5; }, value => { value.view.textSha256 = 'A'.repeat(64); },
    value => { value.view.textSha256 = null; }, value => { value.view.textLength = 0; },
    value => { value.inputEvents.count = 1001; }, value => { value.inputEvents.count = -1; },
    value => { value.inputEvents.count = 0.5; }, value => { value.inputEvents.expired = 'false'; },
  ]) { const value = diagnostic(); change(value); assert.equal(parseDraftUiDiagnostic(diagnosticLine(value)), null); }
  const line = diagnosticLine(diagnostic());
  assert.equal(parseDraftUiDiagnostic(line + ' '.repeat(2049)), null);
  assert.equal(parseDraftUiDiagnostic(line + '\nprivate error'), null);
  assert.equal(parseDraftUiDiagnostic(line + '\r'), null);
  assert.equal(parseDraftUiDiagnostic('prefix ' + line), null);
  assert.equal(parseDraftUiDiagnostic(line + '{}'), null);
  assert.equal(parseDraftUiDiagnostic('OPENASTER_DRAFT_UI_DIAGNOSTIC {'), null);
  assert.equal(parseDraftUiDiagnostic('OPENASTER_DRAFT_UI_DIAGNOSTIC null'), null);
  let coerced = false;
  assert.equal(parseDraftUiDiagnostic({ toString() { coerced = true; throw new Error('private'); } }), null);
  assert.equal(coerced, false);
});
