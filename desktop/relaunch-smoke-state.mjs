// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { validateSmokeFailure } from './smoke-diagnostics.mjs';
import { validateAppImageObservation, readAppImageRuntime, sameAppImageProgram } from './appimage-relaunch.mjs';

const OWNER = /^[a-f0-9]{64}$/;
const PROFILE = /^(?:default|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const MAX_VALUE = 64 * 1024;
const MAX_RECORD = 512 * 1024;
const RESULT = '.relaunch-result.json';
const entryName = phase => `.relaunch-entry-${phase}.json`;
const ticketName = phase => `.relaunch-ticket-${phase}.json`;
const allowedName = name => typeof name === 'string' && (/^\.relaunch-entry-[0-4]\.json$/.test(name) || /^\.relaunch-ticket-[1-4]\.json$/.test(name) || name === RESULT);
const failure = (code, message) => Object.assign(new Error(message), { code: `RELAUNCH_SMOKE_${code}` });
const requireValue = (condition, message = 'Invalid relaunch smoke state.') => { if (!condition) throw failure('INVALID', message); };
const phaseValue = value => Number.isInteger(value) && value >= 0 && value <= 4;
const pidValue = value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameIdentity = (a, b) => a.canonical === b.canonical && a.dev === b.dev && a.ino === b.ino;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const shape = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

// Snapshots are data, never objects with executable accessors or prototype hooks.
function copyJson(value, maxBytes = MAX_VALUE) {
  let nodes = 0;
  function copy(item, depth) {
    requireValue(depth <= 32 && ++nodes <= 20000, 'Smoke JSON nesting or item limit exceeded.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') { requireValue(item.isWellFormed() && !item.includes('\0')); return item; }
    if (typeof item === 'number') { requireValue(Number.isFinite(item)); return item; }
    requireValue(typeof item === 'object' && item !== null);
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    requireValue(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    const keys = Reflect.ownKeys(item);
    if (array) requireValue(keys.length === item.length + 1 && keys.includes('length') && item.length <= 20000);
    const output = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      requireValue(typeof key === 'string' && key.isWellFormed() && !key.includes('\0') && !['__proto__', 'prototype', 'constructor'].includes(key));
      if (array) requireValue(/^(0|[1-9]\d*)$/.test(key) && Number(key) < item.length);
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      requireValue(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      output[key] = copy(descriptor.value, depth + 1);
    }
    return output;
  }
  let result;
  try { result = copy(value, 0); }
  catch (cause) { if (cause?.code?.startsWith('RELAUNCH_SMOKE_')) throw cause; throw failure('INVALID', 'Smoke JSON cannot be inspected safely.'); }
  requireValue(Buffer.byteLength(JSON.stringify(result)) <= maxBytes, 'Smoke JSON byte limit exceeded.');
  return result;
}
function objectValue(value) { const result = copyJson(value); requireValue(result !== null && typeof result === 'object' && !Array.isArray(result)); return result; }

function directoryIdentity(directory) {
  requireValue(typeof directory === 'string' && directory.isWellFormed() && !directory.includes('\0') && path.isAbsolute(directory));
  const resolved = path.resolve(directory), parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of ['', ...path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const info = fs.lstatSync(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('UNSAFE', 'Smoke root and ancestors must be ordinary directories.');
  }
  const before = fs.lstatSync(resolved, { bigint: true }), canonical = fs.realpathSync(resolved);
  const after = fs.lstatSync(canonical, { bigint: true });
  if (!sameFile(before, after) || after.ino === 0n || !samePath(canonical, resolved)) throw failure('CHANGED', 'Smoke directory identity changed.');
  return { canonical, dev: after.dev.toString(), ino: after.ino.toString() };
}
function executablePath(executable) {
  requireValue(typeof executable === 'string' && executable.isWellFormed() && !executable.includes('\0') && path.isAbsolute(executable));
  const canonical = fs.realpathSync(executable);
  requireValue(fs.statSync(canonical).isFile(), 'Smoke executable must be a file.');
  return canonical;
}
function boundedRead(file, limit, transient = false) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) throw failure('UNSAFE', 'Smoke record must be a bounded, ordinary single-link file.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameFile(before, opened) || !opened.isFile() || opened.nlink !== 1n) throw failure('CHANGED', 'Smoke record was replaced while opening.');
    const data = Buffer.alloc(limit + 1); let length = 0;
    while (length < data.length) { const count = fs.readSync(fd, data, length, data.length - length, null); if (!count) break; length += count; }
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    if (length > limit || !sameFile(after, named) || named.isSymbolicLink() || after.nlink !== 1n) throw failure('CHANGED', 'Smoke record changed while reading.');
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw failure(transient ? 'INCOMPLETE' : 'CHANGED', 'Smoke record changed while reading.');
    return { bytes: data.subarray(0, length), stat: after };
  } finally { fs.closeSync(fd); }
}
function verifyBinding(binding) {
  const current = directoryIdentity(binding.directory);
  if (!sameIdentity(current, binding.rootIdentity)) throw failure('CHANGED', 'Smoke root identity no longer matches.');
  const marker = boundedRead(path.join(current.canonical, '.smoke-owner'), 64).bytes;
  if (marker.toString('utf8') !== binding.owner) throw failure('OWNER', 'Smoke ownership marker does not match.');
  if (!sameIdentity(directoryIdentity(binding.directory), binding.rootIdentity)) throw failure('CHANGED', 'Smoke root changed while checking ownership.');
}
function identityValue(value) {
  return shape(value, ['canonical', 'dev', 'ino']) && typeof value.canonical === 'string' && path.isAbsolute(value.canonical)
    && [value.dev, value.ino].every(n => typeof n === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(n)) && value.ino !== '0';
}
function proofsValue(proofs, length) {
  requireValue(Array.isArray(proofs) && proofs.length === length && proofs.length <= 5);
  for (let i = 0; i < proofs.length; i++) {
    const item = proofs[i]; requireValue(shape(item, ['phase', 'pid', 'proof']) && item.phase === i && pidValue(item.pid)); objectValue(item.proof);
  }
  requireValue(new Set(proofs.map(item => item.pid)).size === proofs.length);
}
function validateRecord(record, name, binding) {
  copyJson(record, MAX_RECORD);
  const imageVariant = record?.version === 2;
  const common = ['version', 'type', 'owner', 'rootIdentity', 'executable', 'phase', 'pid', ...(imageVariant ? ['appImage'] : [])];
  requireValue((record?.version === 1 || imageVariant) && record.owner === binding.owner && OWNER.test(record.owner) && identityValue(record.rootIdentity)
    && sameIdentity(record.rootIdentity, binding.rootIdentity) && phaseValue(record.phase) && pidValue(record.pid));
  if (imageVariant) {
    validateAppImageObservation(record.appImage);
    requireValue(record.executable === record.appImage.image.canonical);
  } else requireValue(record.executable === executablePath(record.executable));
  if (name.startsWith('.relaunch-entry-')) {
    requireValue(shape(record, [...common, 'previousPid', 'expectedProfileId']) && record.type === 'entry' && name === entryName(record.phase));
    requireValue(record.phase === 0 ? record.previousPid === null && record.expectedProfileId === null : pidValue(record.previousPid) && PROFILE.test(record.expectedProfileId));
  } else if (name.startsWith('.relaunch-ticket-')) {
    requireValue(shape(record, [...common, 'fromPhase', 'expectedProfileId', 'fixture', 'proofs']) && record.type === 'ticket' && record.phase > 0 && name === ticketName(record.phase));
    requireValue(record.fromPhase === record.phase - 1 && typeof record.expectedProfileId === 'string' && PROFILE.test(record.expectedProfileId));
    objectValue(record.fixture); proofsValue(record.proofs, record.phase);
    requireValue(record.proofs.at(-1).pid === record.pid);
  } else {
    requireValue(name === RESULT && shape(record, [...common, 'fixture', 'proofs', 'pids', 'result']) && record.type === 'result');
    if (record.fixture !== null) objectValue(record.fixture);
    const result = objectValue(record.result); requireValue(typeof result.ok === 'boolean');
    if (!result.ok) validateSmokeFailure(result, { phase: record.phase });
    requireValue(Array.isArray(record.pids) && record.pids.length === record.phase + 1 && record.pids.every(pidValue) && new Set(record.pids).size === record.pids.length && record.pids.at(-1) === record.pid);
    requireValue(Array.isArray(record.proofs) && (record.proofs.length === record.phase || record.proofs.length === record.phase + 1));
    proofsValue(record.proofs, record.proofs.length);
    requireValue(record.proofs.every((proof, i) => proof.pid === record.pids[i]));
    if (result.ok) requireValue(record.phase === 4 && record.proofs.length === 5, 'Only a complete five-stage smoke can succeed.');
  }
  return record;
}
function readRecord(binding, name) {
  requireValue(allowedName(name), 'Only fixed relaunch smoke record names are allowed.'); verifyBinding(binding);
  const read = boundedRead(path.join(binding.directory, name), MAX_RECORD, true);
  if (read.bytes.length === 0 || read.bytes.at(-1) !== 10) throw failure('INCOMPLETE', 'Smoke record has not reached its complete newline-delimited form.');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)); }
  catch { throw failure('INVALID', 'Smoke record is not valid UTF-8 JSON.'); }
  validateRecord(parsed, name, binding); verifyBinding(binding);
  return { value: parsed, stat: read.stat };
}
function writeRecord(binding, name, value) {
  requireValue(allowedName(name)); validateRecord(value, name, binding); verifyBinding(binding);
  const data = Buffer.from(JSON.stringify(value) + '\n'); requireValue(data.length <= MAX_RECORD);
  let fd;
  try { fd = fs.openSync(path.join(binding.directory, name), 'wx', 0o600); }
  catch (cause) { if (cause.code === 'EEXIST') throw failure('EXISTS', 'Smoke record already exists; refusing to overwrite.'); throw cause; }
  let owned;
  try { owned = fs.fstatSync(fd, { bigint: true }); fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const saved = readRecord(binding, name);
  if (!sameFile(owned, saved.stat) || JSON.stringify(saved.value) !== JSON.stringify(value)) throw failure('CHANGED', 'Written smoke record could not be confirmed.');
  return saved.stat;
}
function createBinding(directory, owner) {
  requireValue(typeof owner === 'string' && OWNER.test(owner));
  const rootIdentity = directoryIdentity(directory);
  const binding = { directory: rootIdentity.canonical, owner, rootIdentity }; verifyBinding(binding); return binding;
}

/** Read-only liveness probe. EPERM and other uncertainty are not evidence of exit. */
export function isSmokeProcessAlive(pid) {
  requireValue(pidValue(pid), 'Invalid smoke process ID.');
  try { process.kill(pid, 0); return true; }
  catch (cause) { if (cause.code === 'ESRCH') return false; throw failure('PROCESS_UNKNOWN', 'Cannot verify whether the previous smoke process exited.'); }
}
export function readSmokeRecord({ directory, owner, name }) {
  return readRecord(createBinding(directory, owner), name).value;
}

/** Synchronous, local, single-writer protocol. No launches, kills, or cleanup. */
export function openRelaunchSmokeState({ directory, owner, phase, pid = process.pid, executable = process.execPath, appImage = null }) {
  requireValue(phaseValue(phase) && pidValue(pid));
  const binding = createBinding(directory, owner);
  if (appImage !== null) {
    appImage = copyJson(appImage); validateAppImageObservation(appImage);
    const current = readAppImageRuntime({ platform: 'linux', isPackaged: true, executable,
      env: { APPIMAGE: appImage.image.canonical, APPDIR: appImage.mount } });
    requireValue(current !== null && sameAppImageProgram(current, appImage) && current.mount === appImage.mount);
  }
  const exe = appImage === null ? executablePath(executable) : appImage.image.canonical;
  const matchesProgram = record => record.executable === exe && (appImage === null ? record.version === 1
    : record.version === 2 && sameAppImageProgram(record.appImage, appImage));
  let fixture = null, proofs = [], expectedProfileId = null, previousPid = null, prepared = false, finished = false;
  try { fs.lstatSync(path.join(binding.directory, RESULT)); throw failure('FINISHED', 'This smoke already has a final result.'); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  if (phase === 0) {
    requireValue(fs.readdirSync(binding.directory).length === 1 && fs.readdirSync(binding.directory)[0] === '.smoke-owner', 'Phase zero requires a new owner-only directory.');
  } else {
    const ticket = readRecord(binding, ticketName(phase)).value;
    requireValue(matchesProgram(ticket) && ticket.pid !== pid, 'Relaunch ticket executable or PID does not match.');
    const entries = Array.from({ length: phase }, (_, i) => readRecord(binding, entryName(i)).value);
    requireValue(entries.every((entry, i) => matchesProgram(entry) && entry.pid === ticket.proofs[i].pid && (i === 0 || entry.previousPid === entries[i - 1].pid)) && new Set(entries.map(entry => entry.pid)).size === phase && entries.every(entry => entry.pid !== pid));
    previousPid = ticket.pid; requireValue(entries.at(-1).pid === previousPid);
    if (isSmokeProcessAlive(previousPid)) throw failure('PREVIOUS_ALIVE', 'The previous smoke process must exit before relaunch entry.');
    fixture = ticket.fixture; proofs = ticket.proofs; expectedProfileId = ticket.expectedProfileId;
  }
  const base = { version: appImage === null ? 1 : 2, owner, rootIdentity: binding.rootIdentity, executable: exe, phase, pid,
    ...(appImage === null ? {} : { appImage }) };
  const entry = { ...base, type: 'entry', previousPid, expectedProfileId };
  const entryIdentity = writeRecord(binding, entryName(phase), entry);
  function verify() {
    verifyBinding(binding);
    const current = readRecord(binding, entryName(phase));
    if (!sameFile(current.stat, entryIdentity) || JSON.stringify(current.value) !== JSON.stringify(entry)) throw failure('CHANGED', 'Current smoke entry was replaced.');
    requireValue(!finished, 'This smoke stage already finished.');
  }
  function mutable() { verify(); requireValue(!prepared, 'This smoke stage already prepared its successor.'); }
  return Object.freeze({
    phase, pid, expectedProfileId,
    get fixture() { verify(); return fixture === null ? null : copyJson(fixture); },
    get proofs() { verify(); return copyJson(proofs, MAX_RECORD); },
    setFixture(value) { mutable(); fixture = objectValue(value); return copyJson(fixture); },
    record(proof) {
      mutable(); requireValue(proofs.length === phase, 'Each smoke stage may record exactly one proof.');
      proofs = [...proofs, { phase, pid, proof: objectValue(proof) }]; return copyJson(proofs, MAX_RECORD);
    },
    prepareNext({ expectedProfileId: expected } = {}) {
      mutable(); requireValue(phase < 4 && typeof expected === 'string' && PROFILE.test(expected));
      requireValue(fixture !== null && proofs.length === phase + 1, 'Prepare requires a fixture and the current stage proof.');
      const nextPhase = phase + 1, name = ticketName(nextPhase);
      writeRecord(binding, name, { ...base, type: 'ticket', fromPhase: phase, phase: nextPhase, expectedProfileId: expected, fixture, proofs });
      prepared = true; return { nextPhase, ticketPath: path.join(binding.directory, name) };
    },
    finish(result) {
      verify(); const value = objectValue(result); requireValue(typeof value.ok === 'boolean');
      if (!value.ok) validateSmokeFailure(value, { phase });
      if (value.ok) requireValue(phase === 4 && proofs.length === 5 && !prepared, 'Success requires all five stages.');
      const entries = Array.from({ length: phase + 1 }, (_, i) => readRecord(binding, entryName(i)).value);
      requireValue(entries.every(matchesProgram));
      const record = { ...base, type: 'result', fixture, proofs, pids: entries.map(item => item.pid), result: value };
      writeRecord(binding, RESULT, record); finished = true;
      return { resultPath: path.join(binding.directory, RESULT) };
    },
  });
}
