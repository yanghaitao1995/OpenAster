// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSmokeFailure, validateSmokeFailure, createSmokeController, assertSmokeTransition, createSmokeStageDiagnostic, parseSmokeStageDiagnostic,
  createAppImageHandoffDiagnostic, parseAppImageHandoffDiagnostic } from './smoke-diagnostics.mjs';
import { createDesktopLifecycle } from './lifecycle.mjs';
import { openRelaunchSmokeState, readSmokeRecord } from './relaunch-smoke-state.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const native = code => Object.assign(new Error('secret/raw/path must not escape'), { code, stack: 'secret-stack', orphanPath: 'C:/secret/path', token: 'secret-token' });

test('stage diagnostics only retain fixed stage names and reject arbitrary output', () => {
  const prefix = 'OPENASTER_SMOKE_STAGE_DIAGNOSTIC ';
  for (const stage of ['page', 'workspace-menu', 'keychain', 'draft', 'relaunch', 'fixture', 'handoff', 'summary-draft', 'cancel', 'backup', 'reopen-original', 'restore', 'reopen-restored']) {
    const value = { version: 1, stage, code: 'SMOKE_CHECK_FAILED' };
    assert.deepEqual(createSmokeStageDiagnostic(stage), value);
    assert.deepEqual(parseSmokeStageDiagnostic(prefix + JSON.stringify(value)), value);
  }
  const unknown = { version: 1, stage: 'unknown', code: 'SMOKE_CHECK_FAILED' };
  assert.deepEqual(createSmokeStageDiagnostic('C:/private/path'), unknown);
  assert.deepEqual(createSmokeStageDiagnostic(native('EPERM')), unknown);
  for (const line of [prefix + '{', prefix + JSON.stringify({ ...unknown, path: 'secret' }),
    prefix + JSON.stringify({ ...unknown, stage: 'secret' }), prefix + JSON.stringify({ ...unknown, code: 'EPERM' }),
    prefix + JSON.stringify(unknown) + '\n', 'secret ' + prefix + JSON.stringify(unknown), prefix + ' '.repeat(257)]) {
    assert.equal(parseSmokeStageDiagnostic(line), null);
  }
});
function fixture(options = {}) {
  const events = [], records = [], outputs = [];
  const controller = createSmokeController({ phase: 2,
    record: value => { events.push('record'); records.push(structuredClone(value)); },
    close: async () => { events.push('close'); },
    output: value => { events.push('output'); outputs.push(structuredClone(value)); },
    exit: code => events.push('exit:' + code), recordFailure: () => events.push('record-failed'), ...options });
  return { controller, events, records, outputs };
}

test('failure diagnostics copy only allowlisted own codes without invoking hostile properties', () => {
  let getters = 0;
  const hostile = Object.create({ code: 'EPERM' });
  for (const key of ['code', 'message', 'stack', 'toJSON', 'orphanPath']) Object.defineProperty(hostile, key, { get() { getters++; throw new Error('secret'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const samples = [hostile, revoked.proxy, new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('secret'); } }),
    Object.create({ code: 'EPERM' }), { code: 'SECRET_TOKEN' }, { code: ['EPERM'] }, null, undefined];
  for (const sample of samples) {
    const result = createSmokeFailure(sample, { phase: 2, action: 'switch-default' });
    assert.equal(result.diagnostic.code, 'SMOKE_OPERATION_FAILED'); assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  const result = createSmokeFailure(native('WORKSPACE_BUSY'), { phase: 2, action: 'switch-default' });
  assert.deepEqual(result, { ok: false, error: 'native-menu-failed', diagnostic: { version: 1, phase: 2, action: 'switch-default', code: 'WORKSPACE_BUSY' } });
  assert.equal(getters, 0);
});

test('persistent failure schema rejects unknown keys, enums, phases and accessors', () => {
  const valid = createSmokeFailure(native('EPERM'), { phase: 2, action: 'switch-default' });
  const mutations = [v => { v.message = 'secret'; }, v => { v.ok = true; }, v => { v.error = 'secret'; }, v => { delete v.diagnostic; },
    v => { v.diagnostic.extra = 'secret'; }, v => { v.diagnostic.phase = 3; }, v => { v.diagnostic.phase = 2.5; },
    v => { v.diagnostic.version = 2; }, v => { v.diagnostic.code = 'SECRET'; }, v => { v.diagnostic.action = 'C:/path'; },
    v => { Object.defineProperty(v.diagnostic, 'code', { get() { assert.fail('getter invoked'); } }); }];
  for (const mutate of mutations) { const value = structuredClone(valid); mutate(value); assert.throws(() => validateSmokeFailure(value, { phase: 2 }), { code: 'RELAUNCH_SMOKE_INVALID' }); }
  const copied = validateSmokeFailure(valid, { phase: 2 }); copied.diagnostic.code = 'EIO'; assert.equal(valid.diagnostic.code, 'EPERM');
});

for (const action of ['create-project', 'reveal-workspace', 'copy-workspace-path']) {
  test(`${action} reaches its native callback and preserves bounded failure attribution`, async () => {
    const successful = fixture(); let calls = 0;
    assert.equal(await successful.controller.runMenu(action, async () => { calls++; return true; }), true);
    assert.equal(calls, 1); assert.equal(successful.controller.action, action); assert.deepEqual(successful.events, []);
    const failed = fixture();
    assert.equal(await failed.controller.runMenu(action, async () => { throw native('EPERM'); }), false);
    assert.equal(failed.records.length, 1); assert.equal(failed.outputs[0].diagnostic.action, action);
    assert.equal(failed.outputs[0].diagnostic.code, 'EPERM');
    assert.deepEqual(validateSmokeFailure(failed.outputs[0], { phase: 2 }), failed.outputs[0]);
    assert.deepEqual(failed.events, ['record', 'close', 'output', 'exit:1']);
    assert.equal(JSON.stringify(failed.outputs).includes('secret'), false);
  });
}

test('adding project menu actions does not admit arbitrary diagnostic actions', () => {
  const f = fixture();
  assert.throws(() => f.controller.runMenu('arbitrary-command', () => assert.fail('must not execute')), { code: 'RELAUNCH_SMOKE_INVALID' });
  assert.deepEqual(f.events, []);
});

for (const synchronous of [true, false]) test(`${synchronous ? 'synchronous throw' : 'async rejection'} records once before close and drains before exit`, async () => {
  const close = gate(), entered = gate();
  const f = fixture({ close: async () => { f.events.push('close'); entered.resolve(); await close.promise; } });
  let settled = false;
  const result = f.controller.runMenu('switch-default', synchronous ? () => { throw native('WORKSPACE_BUSY'); } : async () => { throw native('WORKSPACE_BUSY'); });
  void result.then(() => { settled = true; }); await entered.promise;
  assert.deepEqual(f.events, ['record', 'close']); assert.equal(settled, false);
  assert.equal(f.records[0].diagnostic.code, 'WORKSPACE_BUSY');
  f.controller.capture(native('SMOKE_TIMEOUT'), { reason: 'timeout' });
  const first = f.controller.finish(); assert.equal(first, f.controller.finish());
  close.resolve(); assert.equal(await result, false); await first;
  assert.deepEqual(f.events, ['record', 'close', 'output', 'exit:1']); assert.equal(f.outputs[0].diagnostic.code, 'WORKSPACE_BUSY');
  assert.equal(JSON.stringify(f.outputs).includes('secret'), false);
});

test('phase two busy failure is durable while closing is gated and cannot create its next ticket', async t => {
  const parent = fs.realpathSync(tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'openaster-relaunch-protocol-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), parent); fs.rmSync(directory, { recursive: true, force: true }); });
  const owner = randomBytes(32).toString('hex'); fs.writeFileSync(path.join(directory, '.smoke-owner'), owner, { flag: 'wx' });
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
  let state;
  for (let phase = 0; phase <= 2; phase++) {
    state = openRelaunchSmokeState({ directory, owner, phase, pid: 810001 + phase });
    if (!phase) state.setFixture({ ready: true });
    state.record({ checked: true });
    if (phase < 2) state.prepareNext({ expectedProfileId: phase ? randomUUID() : 'default' });
  }
  const stopped = gate(), closing = gate(); let relaunches = 0;
  const f = fixture({ record: result => state.finish(result), close: async () => { closing.resolve(); await stopped.promise; } });
  const lifecycle = createDesktopLifecycle({ closeService: async () => { throw native('WORKSPACE_BUSY'); },
    reportError: async error => { f.controller.capture(error); throw error; }, relaunch: async () => { relaunches++; }, quit: () => assert.fail('busy action must not quit through lifecycle') });
  const pending = f.controller.runMenu('switch-default', () => lifecycle.run('switch', context => context.stopService()));
  await closing.promise;
  const record = readSmokeRecord({ directory, owner, name: '.relaunch-result.json' });
  assert.equal(record.phase, 2); assert.equal(record.result.diagnostic.action, 'switch-default'); assert.equal(record.result.diagnostic.code, 'WORKSPACE_BUSY');
  assert.equal(fs.existsSync(path.join(directory, '.relaunch-ticket-3.json')), false);
  assert.throws(() => state.prepareNext({ expectedProfileId: 'default' }), { code: 'RELAUNCH_SMOKE_INVALID' });
  assert.equal(relaunches, 0); assert.deepEqual(f.outputs, []); stopped.resolve(); assert.equal(await pending, false);
});

test('post-stop lifecycle finally preserves the first failure and never relaunches or quits before the failure finisher', async () => {
  const f = fixture(); let select = 0, prepare = 0, launch = 0, normalQuit = 0;
  const lifecycle = createDesktopLifecycle({ closeService: async () => {}, reportError: async error => { f.controller.capture(error); throw error; },
    relaunch: () => f.controller.relaunch({ select: async () => { select++; }, prepare: () => { prepare++; }, launch: () => { launch++; } }),
    quit: () => { if (!f.controller.failed) normalQuit++; } });
  assert.equal(await f.controller.runMenu('switch-default', () => lifecycle.run('switch', async context => { await context.stopService(); throw native('WORKSPACE_REGISTRY_WRITE_FAILED'); })), false);
  assert.equal(select + prepare + launch + normalQuit, 0); assert.equal(f.records.length, 1);
  assert.equal(f.outputs[0].diagnostic.code, 'WORKSPACE_REGISTRY_WRITE_FAILED'); assert.equal(f.outputs[0].diagnostic.action, 'switch-default');
});

for (const recordThrows of [false, true]) test(`late failure during awaited profile selection blocks prepare and launch even when record ${recordThrows ? 'fails' : 'succeeds'}`, async () => {
  const selection = gate(), entered = gate(); let prepares = 0, launches = 0, records = 0;
  const f = fixture({ record: () => { records++; if (recordThrows) throw new Error('secret write error'); } });
  const pending = f.controller.relaunch({ select: async () => { entered.resolve(); return selection.promise; }, prepare: () => { prepares++; }, launch: () => { launches++; } });
  await entered.promise; f.controller.capture(native('SMOKE_TIMEOUT'), { reason: 'timeout' }); selection.resolve({ id: 'default' });
  assert.equal(await pending, false); assert.equal(prepares + launches, 0); assert.equal(records, 1);
  assert.equal(f.outputs[0].diagnostic.code, 'SMOKE_TIMEOUT');
});

test('successful shutdown records only after close and late failure cannot overwrite the terminal success', async () => {
  const closing = gate(), f = fixture({ close: () => { f.events.push('close'); return closing.promise; } });
  const pending = f.controller.finish({ ok: true, sandboxed: true }); assert.deepEqual(f.events, ['close']);
  closing.resolve(); await pending; assert.deepEqual(f.events, ['close', 'record', 'output', 'exit:0']);
  f.controller.capture(native('SMOKE_TIMEOUT'), { reason: 'timeout' }); await f.controller.finish();
  assert.deepEqual(f.events, ['close', 'record', 'output', 'exit:0']); assert.equal(f.controller.failed, false);
});

test('failure during pending successful close wins before success commit and close errors cannot overwrite it', async () => {
  const closing = gate(), f = fixture({ close: async () => { await closing.promise; throw native('EIO'); } });
  const pending = f.controller.finish({ ok: true }); f.controller.capture(native('SMOKE_TIMEOUT'), { reason: 'timeout' });
  assert.equal(f.records[0].diagnostic.code, 'SMOKE_TIMEOUT'); closing.resolve(); await pending;
  assert.equal(f.outputs[0].diagnostic.code, 'SMOKE_TIMEOUT'); assert.equal(f.records.length, 1);
});

test('close failure turns a prospective success into a bounded shutdown failure', async () => {
  const f = fixture({ close: async () => { throw native('EIO'); } }); await f.controller.finish({ ok: true });
  assert.equal(f.records[0].diagnostic.action, 'shutdown'); assert.equal(f.outputs[0].diagnostic.code, 'EIO'); assert.equal(f.outputs[0].ok, false);
});

test('an exclusive record write failure is never retried or converted to success', async () => {
  let writes = 0; const f = fixture({ record: () => { writes++; throw new Error('secret'); } });
  await f.controller.finish({ ok: true }); assert.equal(writes, 1); assert.equal(f.outputs[0].diagnostic.code, 'SMOKE_RECORD_FAILED');
  assert.equal(f.outputs[0].error, 'record-failed'); await f.controller.finish(); assert.equal(writes, 1);
});

test('expected cancellation is allowed, but required false or unprepared transitions retain their menu action', async () => {
  const f = fixture(); assert.equal(await f.controller.runMenu('backup', async () => false), false); assert.deepEqual(f.events, []);
  for (const [result, prepared] of [[false, true], [null, true], [undefined, true], [true, false], [{ completed: true }, false]]) assert.throws(() => assertSmokeTransition(result, prepared), { code: 'SMOKE_TRANSITION_NOT_STARTED' });
  assert.doesNotThrow(() => assertSmokeTransition(true, true)); assert.doesNotThrow(() => assertSmokeTransition({ completed: true }, true));
  await f.controller.runMenu('switch-default', async () => false);
  try { assertSmokeTransition(false, false); } catch (error) { f.controller.capturePageError(error); }
  assert.equal(f.records[0].diagnostic.action, 'switch-default'); assert.equal(f.records[0].error, 'menu-transition-not-started');
  assert.equal(f.records[0].diagnostic.code, 'SMOKE_TRANSITION_NOT_STARTED');
});

test('ordinary page errors do not inherit a menu action or invoke a code accessor', async () => {
  const f = fixture(); await f.controller.runMenu('backup', () => false);
  f.controller.capturePageError({ get code() { assert.fail('code getter executed'); } });
  assert.equal(f.records[0].diagnostic.action, 'page-check'); assert.equal(f.records[0].diagnostic.code, 'SMOKE_OPERATION_FAILED');
});

test('a false page summary without an Error is classified as a page check failure', async () => {
  const f = fixture(); f.controller.capturePageError(undefined); await f.controller.finish();
  assert.equal(f.records[0].diagnostic.action, 'page-check'); assert.equal(f.records[0].error, 'page-check-failed');
  assert.equal(f.outputs[0].ok, false);
});

test('a captured failure cancels already queued menu entry and returned diagnostics cannot mutate the latch', async () => {
  const f = fixture(); let calls = 0; const queued = f.controller.runMenu('backup', () => { calls++; });
  const copy = f.controller.capture(native('WORKSPACE_BUSY')); copy.diagnostic.code = 'EPERM';
  assert.equal(await queued, false); assert.equal(calls, 0); assert.equal(f.controller.failure.diagnostic.code, 'WORKSPACE_BUSY');
});

test('normal relaunch preserves selection/prepare/launch order without creating a failure or finishing', async () => {
  const f = fixture(), calls = [];
  assert.equal(await f.controller.relaunch({ select: async () => { calls.push('select'); return 'default'; }, prepare: id => { assert.equal(id, 'default'); calls.push('prepare'); return { nextPhase: 3 }; }, launch: next => { assert.equal(next.nextPhase, 3); calls.push('launch'); } }), true);
  assert.deepEqual(calls, ['select', 'prepare', 'launch']); assert.deepEqual(f.events, []); assert.equal(f.controller.failed, false);
});

test('asynchronous relaunch ACK must settle before lifecycle quits, and rejection retains the failure', async () => {
  for (const rejected of [false, true]) {
    const accepted = gate(), entered = gate(), f = fixture(); let quit = false;
    const lifecycle = createDesktopLifecycle({ closeService: async () => {}, reportError: async () => {},
      relaunch: () => f.controller.relaunch({ select: async () => 'default', prepare: () => ({}),
        launch: async () => { entered.resolve(); await accepted.promise; if (rejected) throw native('APPIMAGE_HANDOFF_FAILED'); } }),
      quit: () => { if (!f.controller.failed) quit = true; } });
    const pending = lifecycle.run('backup', context => context.stopService());
    await entered.promise; assert.equal(quit, false); assert.deepEqual(f.outputs, []);
    accepted.resolve(); await pending; assert.equal(quit, !rejected);
    if (rejected) { assert.equal(f.outputs[0].diagnostic.code, 'APPIMAGE_HANDOFF_FAILED'); assert.equal(f.outputs[0].error, 'relaunch-failed'); }
  }
});

test('AppImage handoff diagnostics contain only fixed stages and the measured privilege boolean', () => {
  const prefix = 'OPENASTER_APPIMAGE_HANDOFF_DIAGNOSTIC ';
  for (const stage of ['parent-spawn', 'parent-accepted', 'successor-ready', 'predecessor-exited', 'handoff-failed']) {
    for (const noNewPrivileges of [null, true, false]) {
      const value = createAppImageHandoffDiagnostic(stage, noNewPrivileges);
      assert.deepEqual(parseAppImageHandoffDiagnostic(prefix + JSON.stringify(value)), value);
    }
  }
  for (const value of [{ version: 1, stage: 'private/path', noNewPrivileges: false },
    { version: 1, stage: 'parent-spawn', noNewPrivileges: 'secret' },
    { version: 1, stage: 'parent-spawn', noNewPrivileges: false, nonce: 'private' }]) {
    assert.equal(parseAppImageHandoffDiagnostic(prefix + JSON.stringify(value)), null);
  }
  assert.equal(parseAppImageHandoffDiagnostic(prefix + 'x'.repeat(257)), null);
});
