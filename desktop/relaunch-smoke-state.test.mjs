// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { openRelaunchSmokeState, readSmokeRecord, isSmokeProcessAlive } from './relaunch-smoke-state.mjs';
import { createSmokeFailure } from './smoke-diagnostics.mjs';

function fixture(t) {
  const parent = fs.realpathSync(tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'openaster-relaunch-protocol-'));
  const owner = randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(directory, '.smoke-owner'), owner, { flag: 'wx', mode: 0o600 });
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), parent); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, owner, options: { directory, owner }, file: name => path.join(directory, name) };
}
const missing = () => Object.assign(new Error('no such process'), { code: 'ESRCH' });
function allPreviousExited(t) { return t.mock.method(process, 'kill', (_pid, signal) => { assert.equal(signal, 0); throw missing(); }); }
function stage(f, phase, options = {}) { return openRelaunchSmokeState({ ...f.options, phase, pid: 800001 + phase, ...options }); }
function next(state, expectedProfileId = 'default') {
  if (state.fixture === null) state.setFixture({ taskId: 'task', workspace: 'fixture' });
  state.record({ checked: true }); return state.prepareNext({ expectedProfileId });
}
const read = (f, name) => readSmokeRecord({ ...f.options, name });
const failed = (phase = 0) => createSmokeFailure({ code: 'WORKSPACE_BUSY' }, { phase, action: 'switch-default' });
const rewrite = (f, name, value) => fs.writeFileSync(f.file(name), JSON.stringify(value) + '\n');

test('five exclusive stages bind owner/root/executable, carry snapshots, and enumerate all five PIDs', t => {
  const f = fixture(t); allPreviousExited(t); const restored = randomUUID();
  let state = stage(f, 0);
  assert.equal(state.fixture, null); assert.deepEqual(state.proofs, []); assert.equal(state.expectedProfileId, null);
  state.setFixture({ task: { id: 'task' } });
  state.setFixture({ task: { id: 'task' }, backupSha: 'a'.repeat(64) });
  const copied = state.fixture; copied.task.id = 'foreign'; assert.equal(state.fixture.task.id, 'task');
  for (let phase = 0; phase <= 4; phase++) {
    const entry = read(f, `.relaunch-entry-${phase}.json`);
    assert.equal(entry.pid, 800001 + phase); assert.equal(entry.phase, phase);
    assert.equal(entry.owner, f.owner); assert.equal(entry.rootIdentity.canonical, f.directory);
    assert.equal(entry.executable, fs.realpathSync(process.execPath));
    if (phase === 1) state.setFixture({ ...state.fixture, restoredProfileId: restored });
    state.record({ phaseName: `phase-${phase}`, dataChecked: true });
    const proofCopy = state.proofs; proofCopy.at(-1).proof.dataChecked = false;
    assert.equal(state.proofs.at(-1).proof.dataChecked, true);
    if (phase < 4) {
      const expected = phase === 0 || phase === 2 ? 'default' : restored;
      const prepared = state.prepareNext({ expectedProfileId: expected });
      assert.equal(prepared.nextPhase, phase + 1); assert.equal(prepared.ticketPath, f.file(`.relaunch-ticket-${phase + 1}.json`));
      state = stage(f, phase + 1); assert.equal(state.expectedProfileId, expected);
      assert.equal(state.fixture.backupSha, 'a'.repeat(64)); assert.equal(state.proofs.length, phase + 1);
    }
  }
  assert.deepEqual(state.finish({ ok: true, sandboxed: true }), { resultPath: f.file('.relaunch-result.json') });
  const result = read(f, '.relaunch-result.json');
  assert.equal(result.result.ok, true); assert.deepEqual(result.pids, [800001, 800002, 800003, 800004, 800005]);
  assert.equal(result.proofs.length, 5); assert.equal(result.fixture.restoredProfileId, restored);
  assert.throws(() => state.record({}), { code: 'RELAUNCH_SMOKE_INVALID' });
});

test('any phase may report failure, including after a successor ticket has sealed the stage', t => {
  const f = fixture(t); const state = stage(f, 0); next(state);
  assert.throws(() => state.setFixture({ updated: true }), { code: 'RELAUNCH_SMOKE_INVALID' });
  state.finish(failed());
  const result = read(f, '.relaunch-result.json');
  assert.equal(result.phase, 0); assert.equal(result.result.ok, false); assert.deepEqual(result.pids, [800001]);
  assert.equal(result.proofs.length, 1);
  assert.throws(() => stage(f, 1), { code: 'RELAUNCH_SMOKE_FINISHED' });
});

test('failure before any proof or fixture is readable, but early success is rejected', t => {
  const f = fixture(t), state = stage(f, 0);
  assert.throws(() => state.finish({ ok: true }), { code: 'RELAUNCH_SMOKE_INVALID' });
  state.finish(failed());
  const result = read(f, '.relaunch-result.json'); assert.equal(result.fixture, null); assert.deepEqual(result.proofs, []);
});

test('failure records enforce the fixed diagnostic schema both before writing and when read back', t => {
  const f = fixture(t), state = stage(f, 0);
  for (const value of [{ ok: false, error: 'secret' }, failed(1), { ...failed(), stack: 'secret' },
    { ...failed(), diagnostic: { ...failed().diagnostic, code: 'SECRET_TOKEN' } }]) {
    assert.throws(() => state.finish(value), { code: 'RELAUNCH_SMOKE_INVALID' });
    assert.equal(fs.existsSync(f.file('.relaunch-result.json')), false);
  }
  state.finish(failed());
  const valid = read(f, '.relaunch-result.json');
  for (const mutate of [value => { value.result.diagnostic.phase = 1; },
    value => { value.result.diagnostic.code = 'SECRET_TOKEN'; }, value => { value.result.message = 'secret'; }]) {
    const value = structuredClone(valid); mutate(value); rewrite(f, '.relaunch-result.json', value);
    assert.throws(() => read(f, '.relaunch-result.json'), { code: 'RELAUNCH_SMOKE_INVALID' });
  }
  rewrite(f, '.relaunch-result.json', valid); assert.equal(read(f, '.relaunch-result.json').result.diagnostic.code, 'WORKSPACE_BUSY');
});

test('phase zero rejects existing application data and later phases cannot omit a ticket', t => {
  const f = fixture(t); fs.writeFileSync(f.file('openaster.sqlite'), 'existing');
  assert.throws(() => stage(f, 0), { code: 'RELAUNCH_SMOKE_INVALID' });
  assert.equal(fs.readFileSync(f.file('openaster.sqlite'), 'utf8'), 'existing');
  assert.throws(() => stage(f, 1), { code: 'ENOENT' });
  for (const phase of [-1, 5, 1.5, '1', null]) assert.throws(() => stage(f, phase), { code: 'RELAUNCH_SMOKE_INVALID' });
});

test('previous process must be demonstrably exited and PID reuse is rejected', t => {
  const f = fixture(t); next(stage(f, 0));
  const alive = t.mock.method(process, 'kill', (_pid, signal) => { assert.equal(signal, 0); return true; });
  assert.throws(() => stage(f, 1), { code: 'RELAUNCH_SMOKE_PREVIOUS_ALIVE' }); alive.mock.restore();
  const unknown = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
  assert.throws(() => stage(f, 1), { code: 'RELAUNCH_SMOKE_PROCESS_UNKNOWN' }); unknown.mock.restore();
  allPreviousExited(t);
  assert.throws(() => stage(f, 1, { pid: 800001 }), { code: 'RELAUNCH_SMOKE_INVALID' });
  assert.equal(stage(f, 1).phase, 1);
  assert.throws(() => stage(f, 1), { code: 'RELAUNCH_SMOKE_EXISTS' });
});

test('liveness never treats permission errors or invalid PID values as exit', t => {
  assert.equal(isSmokeProcessAlive(process.pid), true);
  for (const pid of [0, -1, 1.5, '12', 0x80000000]) assert.throws(() => isSmokeProcessAlive(pid), { code: 'RELAUNCH_SMOKE_INVALID' });
  const mock = t.mock.method(process, 'kill', () => { throw missing(); }); assert.equal(isSmokeProcessAlive(800001), false); mock.mock.restore();
});

test('fixtures and proofs reject unsafe or oversized JSON without invoking accessors', t => {
  const f = fixture(t), state = stage(f, 0); let accessed = false;
  const getter = {}; Object.defineProperty(getter, 'value', { enumerable: true, get() { accessed = true; return 'bad'; } });
  const cyclic = {}; cyclic.self = cyclic;
  const invalid = [getter, JSON.parse('{"__proto__":{}}'), { constructor: 'bad' }, { value: undefined }, { value: NaN }, { value: 1n }, { value: '\ud800' }, { value: '\0' }, { value: new Date() }, { value: [, 'hole'] }, { value: '中'.repeat(22000) }, cyclic, [], null];
  for (const value of invalid) assert.throws(() => state.setFixture(value), { code: 'RELAUNCH_SMOKE_INVALID' });
  assert.equal(accessed, false); assert.equal(state.fixture, null);
  assert.throws(() => state.record(getter), { code: 'RELAUNCH_SMOKE_INVALID' }); assert.equal(accessed, false);
  state.setFixture({ safe: ['中文', true, null, 0] }); state.record({ safe: true });
  assert.throws(() => state.record({ duplicate: true }), { code: 'RELAUNCH_SMOKE_INVALID' });
});

test('prepare requires a fixture, one proof and a valid exact profile ID', t => {
  const f = fixture(t), state = stage(f, 0);
  assert.throws(() => state.prepareNext({ expectedProfileId: 'default' }), { code: 'RELAUNCH_SMOKE_INVALID' });
  state.setFixture({ ready: true });
  assert.throws(() => state.prepareNext({ expectedProfileId: 'default' }), { code: 'RELAUNCH_SMOKE_INVALID' });
  state.record({ checked: true });
  for (const id of [null, '', '../default', 'DEFAULT', 'not-a-uuid']) assert.throws(() => state.prepareNext({ expectedProfileId: id }), { code: 'RELAUNCH_SMOKE_INVALID' });
  assert.equal(state.prepareNext({ expectedProfileId: 'default' }).nextPhase, 1);
});

test('ticket metadata, proof chain and executable are validated before a stage entry is created', t => {
  const f = fixture(t); allPreviousExited(t); next(stage(f, 0));
  const valid = read(f, '.relaunch-ticket-1.json');
  const mutations = [
    x => { x.owner = 'b'.repeat(64); }, x => { x.rootIdentity.ino = '123'; },
    x => { x.phase = 2; }, x => { x.fromPhase = 1; }, x => { x.pid = 800010; },
    x => { x.extra = true; }, x => { x.fixture = []; }, x => { x.proofs[0].pid = 800010; },
    x => { x.proofs[0].phase = 1; }, x => { x.proofs.push(x.proofs[0]); },
    x => { x.expectedProfileId = '../data'; }, x => { x.executable = f.file('.smoke-owner'); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(valid); mutate(value); rewrite(f, '.relaunch-ticket-1.json', value);
    assert.throws(() => stage(f, 1), { code: 'RELAUNCH_SMOKE_INVALID' });
    assert.equal(fs.existsSync(f.file('.relaunch-entry-1.json')), false);
  }
  rewrite(f, '.relaunch-ticket-1.json', valid); assert.equal(stage(f, 1).phase, 1);
});

test('fixed record names, strict complete JSON and bounded reads prevent arbitrary file access', t => {
  const f = fixture(t); stage(f, 0);
  for (const name of ['../outside', '.smoke-owner', '.relaunch-entry-5.json', '.relaunch-ticket-0.json', 'arbitrary.json']) assert.throws(() => read(f, name), { code: 'RELAUNCH_SMOKE_INVALID' });
  const file = '.relaunch-ticket-1.json';
  for (const content of ['', '{"version":1', '{"version":1}']) {
    fs.writeFileSync(f.file(file), content); assert.throws(() => read(f, file), { code: 'RELAUNCH_SMOKE_INCOMPLETE' });
  }
  for (const content of ['{broken\n', 'null\n', '{}\n']) {
    fs.writeFileSync(f.file(file), content); assert.throws(() => read(f, file), { code: 'RELAUNCH_SMOKE_INVALID' });
  }
  fs.writeFileSync(f.file(file), Buffer.alloc(512 * 1024 + 1)); assert.throws(() => read(f, file), { code: 'RELAUNCH_SMOKE_UNSAFE' });
});

test('records and owner markers reject hardlinks and symbolic links', t => {
  const f = fixture(t); const state = stage(f, 0); next(state);
  const alias = f.file('alias'); fs.linkSync(f.file('.relaunch-ticket-1.json'), alias);
  assert.throws(() => read(f, '.relaunch-ticket-1.json'), { code: 'RELAUNCH_SMOKE_UNSAFE' }); fs.unlinkSync(alias);
  fs.linkSync(f.file('.smoke-owner'), alias);
  assert.throws(() => state.finish(failed()), { code: 'RELAUNCH_SMOKE_UNSAFE' }); fs.unlinkSync(alias);
  const target = f.file('.relaunch-ticket-1.json'); fs.unlinkSync(target);
  // A directory junction also exercises the file type rejection on Windows
  // without requiring the privilege needed for file symbolic links.
  fs.symlinkSync(f.directory, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => read(f, '.relaunch-ticket-1.json'), { code: 'RELAUNCH_SMOKE_UNSAFE' });
});

test('every state operation revalidates root and owner and preserves unknown replacements', t => {
  const f = fixture(t), state = stage(f, 0);
  fs.writeFileSync(f.file('.smoke-owner'), 'c'.repeat(64));
  assert.throws(() => state.setFixture({}), { code: 'RELAUNCH_SMOKE_OWNER' });
  fs.writeFileSync(f.file('.smoke-owner'), f.owner);
  const moved = f.directory + '-moved'; fs.renameSync(f.directory, moved);
  t.after(() => { assert.equal(path.dirname(moved), path.dirname(f.directory)); fs.rmSync(moved, { recursive: true, force: true }); });
  fs.mkdirSync(f.directory); fs.writeFileSync(f.file('.smoke-owner'), f.owner); fs.writeFileSync(f.file('unknown.txt'), 'keep');
  assert.throws(() => state.record({}), { code: 'RELAUNCH_SMOKE_CHANGED' });
  assert.equal(fs.readFileSync(f.file('unknown.txt'), 'utf8'), 'keep');
});

test('a replaced current entry and an occupied ticket/result are never overwritten', t => {
  const f = fixture(t), state = stage(f, 0); state.setFixture({ ready: true }); state.record({ checked: true });
  fs.writeFileSync(f.file('.relaunch-ticket-1.json'), 'foreign');
  assert.throws(() => state.prepareNext({ expectedProfileId: 'default' }), { code: 'RELAUNCH_SMOKE_EXISTS' });
  assert.equal(fs.readFileSync(f.file('.relaunch-ticket-1.json'), 'utf8'), 'foreign');
  fs.writeFileSync(f.file('.relaunch-result.json'), 'foreign-result');
  assert.throws(() => state.finish(failed()), { code: 'RELAUNCH_SMOKE_EXISTS' });
  assert.equal(fs.readFileSync(f.file('.relaunch-result.json'), 'utf8'), 'foreign-result');
  const original = fs.readFileSync(f.file('.relaunch-entry-0.json'));
  fs.renameSync(f.file('.relaunch-entry-0.json'), f.file('old-entry'));
  fs.writeFileSync(f.file('.relaunch-entry-0.json'), original);
  assert.throws(() => state.setFixture({}), { code: 'RELAUNCH_SMOKE_CHANGED' });
});

test('root aliases are refused before any stage writes', t => {
  const f = fixture(t), alias = f.directory + '-alias';
  fs.symlinkSync(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.unlinkSync(alias));
  assert.throws(() => openRelaunchSmokeState({ directory: alias, owner: f.owner, phase: 0 }), { code: 'RELAUNCH_SMOKE_UNSAFE' });
  assert.deepEqual(fs.readdirSync(f.directory), ['.smoke-owner']);
});
