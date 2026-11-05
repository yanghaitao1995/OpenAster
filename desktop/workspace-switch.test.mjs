import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceSwitcher } from './workspace-switch.mjs';

const target = { id: 'other', kind: 'external' };
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
function fixture(overrides = {}) {
  const calls = [];
  const switcher = createWorkspaceSwitcher({
    currentId: 'default', confirm: async () => { calls.push('confirm'); return true; },
    closeService: async options => { assert.equal(options.ifIdle, true); calls.push('close'); },
    profiles: { activate: async () => { calls.push('activate'); } },
    restart: async () => { calls.push('restart'); },
    reportError: async (error, options) => { calls.push([error.code, options.restartRequired]); },
    ...overrides,
  });
  return { calls, switcher };
}
test('workspace switch closes the old service before committing selection and restarting', async () => {
  const { calls, switcher } = fixture();
  assert.equal(await switcher.switchTo(target), true);
  assert.deepEqual(calls, ['confirm', 'close', 'activate', 'restart']);
  assert.equal(switcher.busy, false);
});
test('cancel and already selected workspace leave service and registry untouched', async () => {
  const f = fixture({ confirm: async () => false });
  assert.equal(await f.switcher.switchTo(target), false);
  assert.equal(await f.switcher.switchTo({ id: 'default' }), false);
  assert.deepEqual(f.calls, []);
});
test('an active task or pending request prevents selection and restart', async () => {
  const f = fixture({ closeService: async () => { throw Object.assign(new Error(), { code: 'WORKSPACE_BUSY' }); } });
  assert.equal(await f.switcher.switchTo(target), false);
  assert.deepEqual(f.calls, ['confirm', ['WORKSPACE_BUSY', false]]);
});
test('registry failure after shutdown restarts the last committed selection', async () => {
  const f = fixture({ profiles: { activate: async () => { throw Object.assign(new Error(), { code: 'WORKSPACE_REGISTRY_WRITE_FAILED' }); } } });
  assert.equal(await f.switcher.switchTo(target), false);
  assert.deepEqual(f.calls, ['confirm', 'close', ['WORKSPACE_REGISTRY_WRITE_FAILED', true], 'restart']);
});
test('shutdown failures and failed error dialogs cannot leave a stopped UI running', async () => {
  const f = fixture({ closeService: async () => { throw Object.assign(new Error(), { code: 'DISK_FAILURE' }); }, reportError: async () => { throw new Error('dialog unavailable'); } });
  await assert.rejects(f.switcher.switchTo(target), /dialog unavailable/);
  assert.deepEqual(f.calls, ['confirm', 'restart']);
  assert.equal(f.switcher.busy, false);
});
test('concurrent menu activations cannot commit two different selections', async () => {
  let confirm;
  const f = fixture({ confirm: () => new Promise(resolve => { confirm = resolve; }) });
  const first = f.switcher.switchTo(target);
  assert.equal(f.switcher.busy, true);
  assert.equal(await f.switcher.switchTo({ id: 'third', kind: 'external' }), false);
  confirm(true);
  assert.equal(await first, true);
  assert.deepEqual(f.calls, ['close', 'activate', 'restart']);
});

test('each busy retry requires its own explicit decision and repeats only the atomic close', { timeout: 10000 }, async () => {
  const decisions = [], failures = [0, 1].map(() => Object.assign(new Error('busy'), { code: 'WORKSPACE_BUSY' }));
  const prompted = [deferred(), deferred()];
  let attempts = 0;
  const f = fixture({
    closeService: async options => { assert.deepEqual(options, { ifIdle: true }); f.calls.push('close'); if (attempts++ < 2) throw failures[attempts - 1]; },
    retryBusy: (selected, error) => {
      assert.equal(selected, target); assert.equal(error, failures[decisions.length]);
      return new Promise(resolve => { decisions.push(resolve); prompted[decisions.length - 1].resolve(); });
    },
  });
  const work = f.switcher.switchTo(target);
  await prompted[0].promise;
  assert.equal(await f.switcher.switchTo({ id: 'third', kind: 'external' }), false);
  assert.deepEqual(f.calls, ['confirm', 'close']);
  decisions[0](true);
  await prompted[1].promise;
  assert.deepEqual(f.calls, ['confirm', 'close', 'close']);
  decisions[1](true);
  assert.equal(await work, true);
  assert.deepEqual(f.calls, ['confirm', 'close', 'close', 'close', 'activate', 'restart']);
});

test('declining a busy retry or invalidating its intent does not activate, report another error or restart', async () => {
  for (const response of [false, 'yes', true]) {
    let allowed = true;
    const f = fixture({
      canContinue: () => allowed,
      closeService: async () => { f.calls.push('close'); throw Object.assign(new Error(), { code: 'WORKSPACE_BUSY' }); },
      retryBusy: async () => { if (response === true) allowed = false; return response; },
    });
    assert.equal(await f.switcher.switchTo(target), false);
    assert.deepEqual(f.calls, ['confirm', 'close']);
  }
});

test('an explicit false from close cancels both initial and retried switching', async () => {
  for (const retry of [false, true]) {
    let attempts = 0;
    const f = fixture({
      closeService: async () => { f.calls.push('close'); if (retry && attempts++ === 0) throw Object.assign(new Error(), { code: 'WORKSPACE_BUSY' }); return false; },
      retryBusy: async () => true,
    });
    assert.equal(await f.switcher.switchTo(target), false);
    assert.deepEqual(f.calls, ['confirm', 'close', ...(retry ? ['close'] : [])]);
  }
});

test('a retry decision or target validation failure remains a pre-shutdown failure with its original cause', async () => {
  const cause = new Error('original cause'), failure = Object.assign(new Error('target changed', { cause }), { code: 'WORKSPACE_CHANGED' });
  const f = fixture({
    closeService: async () => { throw Object.assign(new Error(), { code: 'WORKSPACE_BUSY' }); },
    retryBusy: async () => { throw failure; },
    reportError: async (error, metadata) => { assert.equal(error, failure); assert.equal(error.cause, cause); assert.deepEqual(metadata, { restartRequired: false }); f.calls.push('reported'); },
  });
  assert.equal(await f.switcher.switchTo(target), false);
  assert.deepEqual(f.calls, ['confirm', 'reported']);
});

test('unknown shutdown errors never prompt a retry and preserve restart classification after an earlier busy decision', async () => {
  for (const firstBusy of [false, true]) {
    const cause = new Error('native cause'), failure = Object.assign(new Error('shutdown failure', { cause }), { code: 'IO_ERROR' });
    let attempts = 0, decisions = 0;
    const f = fixture({
      closeService: async () => { f.calls.push('close'); if (firstBusy && attempts++ === 0) throw Object.assign(new Error(), { code: 'WORKSPACE_BUSY' }); throw failure; },
      retryBusy: async () => { decisions++; return true; },
      reportError: async (error, metadata) => { assert.equal(error, failure); assert.equal(error.cause, cause); assert.deepEqual(metadata, { restartRequired: true }); f.calls.push('reported'); },
    });
    assert.equal(await f.switcher.switchTo(target), false);
    assert.equal(decisions, firstBusy ? 1 : 0);
    assert.deepEqual(f.calls, ['confirm', 'close', ...(firstBusy ? ['close'] : []), 'reported', 'restart']);
  }
});
