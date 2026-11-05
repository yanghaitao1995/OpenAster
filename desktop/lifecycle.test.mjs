// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopLifecycle } from './lifecycle.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const calls = [];
  const lifecycle = createDesktopLifecycle({ closeService: async options => calls.push(options?.ifIdle ? 'stop-idle' : 'close'),
    relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit'),
    reportError: async (error, meta) => calls.push([error.code, meta.operation, meta.restartRequired]), ...overrides });
  return { lifecycle, calls };
}
test('the lifecycle locks synchronously, allows cancellation without stopping, and restarts once after disk work', async () => {
  const f = fixture(), choice = deferred();
  const first = f.lifecycle.run('backup', async context => { await choice.promise; return context.active; });
  assert.equal(f.lifecycle.busy, true);
  assert.equal(await f.lifecycle.run('restore', () => assert.fail('second action entered')), false);
  choice.resolve(); assert.equal(await first, true); assert.deepEqual(f.calls, []);
  await f.lifecycle.run('backup', async context => { assert.equal(await context.stopService(), true); f.calls.push('write'); });
  assert.deepEqual(f.calls, ['stop-idle', 'write', 'relaunch', 'quit']);
  assert.equal(await f.lifecycle.run('backup', () => assert.fail('action entered after restart')), false);
});
test('busy rejection preserves the running service and does not restart or write', async () => {
  const f = fixture({ closeService: async () => { throw Object.assign(new Error(), { code: 'WORKSPACE_BUSY' }); } });
  assert.equal(await f.lifecycle.run('restore', async context => { await context.stopService(); assert.fail('disk write after busy'); }), false);
  assert.deepEqual(f.calls, [['WORKSPACE_BUSY', 'restore', false]]);
});
test('quit invalidates an outstanding picker and waits for its harmless late result', async () => {
  const f = fixture(), choice = deferred(); let signal;
  const work = f.lifecycle.run('restore', async context => { signal = context.signal; await choice.promise; assert.equal(context.active, false); assert.equal(await context.stopService(), false); });
  await Promise.resolve();
  const quit = f.lifecycle.requestQuit(); assert.equal(signal.aborted, true);
  assert.equal(f.lifecycle.requestQuit(), quit);
  assert.deepEqual(f.calls, []);
  choice.resolve(); await Promise.all([work, quit]);
  assert.deepEqual(f.calls, ['close', 'quit']);
});
test('quit during a write waits through commit and suppresses relaunch', async () => {
  const f = fixture(), entered = deferred(), disk = deferred();
  const work = f.lifecycle.run('restore', async context => {
    assert.equal(await context.stopService(), true); entered.resolve(); await disk.promise; f.calls.push('commit');
    assert.equal(context.active, false);
  });
  await entered.promise; const quit = f.lifecycle.requestQuit();
  assert.deepEqual(f.calls, ['stop-idle']); disk.resolve(); await Promise.all([work, quit]);
  assert.deepEqual(f.calls, ['stop-idle', 'commit', 'close', 'quit']);
});
test('quit arriving during idle shutdown prevents the offline operation', async () => {
  const stopping = deferred(), entered = deferred();
  const f = fixture({ closeService: async options => { if (options) { entered.resolve(); await stopping.promise; } } });
  const work = f.lifecycle.run('backup', async context => { if (await context.stopService()) assert.fail('late disk work'); });
  await entered.promise; const quit = f.lifecycle.requestQuit(); stopping.resolve(); await Promise.all([work, quit]);
  assert.deepEqual(f.calls, ['quit']);
});
test('partial shutdown and dialog failures still restart; relaunch failure still exits once', async () => {
  const f = fixture({ closeService: async () => { throw Object.assign(new Error(), { code: 'IO_ERROR' }); }, reportError: async () => { throw new Error('dialog failed'); } });
  await assert.rejects(f.lifecycle.run('backup', context => context.stopService()), /dialog failed/);
  assert.deepEqual(f.calls, ['relaunch', 'quit']);
  const g = fixture({ relaunch: () => { throw new Error('relaunch failed'); } });
  await assert.rejects(g.lifecycle.run('backup', context => context.stopService()), /relaunch failed/);
  assert.deepEqual(g.calls, ['stop-idle', 'quit']);
});
