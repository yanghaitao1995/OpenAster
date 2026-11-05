// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspaceSearch } from '../server/workspace-search.mjs';

function heldScan() {
  let resolve, signal, calls = 0;
  const pending = new Promise(accept => { resolve = accept; });
  const runner = createWorkspaceSearch({ async search(query, options) { calls++; signal = options.signal; return pending; } });
  return { runner, resolve, get signal() { return signal; }, get calls() { return calls; } };
}

test('cancelled scan owns its concurrency slot until filesystem work has stopped', async () => {
  const f = heldScan(), controller = new AbortController();
  const first = f.runner.run({ query: 'needle' }, { signal: controller.signal });
  const cancelled = assert.rejects(first, { code: 'CANCELLED', status: 409 });
  assert.equal(f.calls, 1);
  await assert.rejects(f.runner.run({ query: 'second' }), { code: 'WORKSPACE_SEARCH_BUSY', status: 429 });
  controller.abort(); assert.equal(f.signal.aborted, true);
  await assert.rejects(f.runner.run({ query: 'third' }), { code: 'WORKSPACE_SEARCH_BUSY' });
  f.resolve({ matches: [] }); await cancelled;
  assert.deepEqual(await f.runner.run({ query: 'after' }), { matches: [] });
});

test('search deadline cancels work, rejects late results and releases the slot only on settlement', async () => {
  let release, signal;
  const runner = createWorkspaceSearch({ async search(query, options) { signal = options.signal; return new Promise(resolve => { release = resolve; }); } }, { timeoutMs: 10 });
  const pending = runner.run({ query: 'needle' });
  const timedOut = assert.rejects(pending, { code: 'WORKSPACE_SEARCH_TIMEOUT', status: 408 });
  await delay(30); assert.equal(signal.aborted, true);
  await assert.rejects(runner.run({ query: 'blocked' }), { code: 'WORKSPACE_SEARCH_BUSY' });
  release({ matches: ['late result must not be delivered'] }); await timedOut;
});

test('shutdown aborts a search and rejects future scans; pre-cancelled clients never scan', async () => {
  const f = heldScan(), preCancelled = AbortSignal.abort();
  await assert.rejects(f.runner.run({ query: 'needle' }, { signal: preCancelled }), { code: 'CANCELLED' });
  assert.equal(f.calls, 0);
  const first = f.runner.run({ query: 'needle' });
  const stopped = assert.rejects(first, { code: 'SHUTTING_DOWN', status: 503 });
  let closed = false;
  const closing = f.runner.close().then(() => { closed = true; }); assert.equal(f.signal.aborted, true);
  await Promise.resolve(); assert.equal(closed, false, 'shutdown must wait for filesystem work even after the HTTP client leaves');
  await assert.rejects(f.runner.run({ query: 'next' }), { code: 'SHUTTING_DOWN' });
  f.resolve({ matches: [] }); await stopped; await closing; assert.equal(closed, true);
});

test('failed scans release their slot and invalid input is rejected before starting a scan', async () => {
  let calls = 0;
  const runner = createWorkspaceSearch({ async search() { calls++; if (calls === 1) throw Object.assign(new Error('root changed'), { code: 'WORKSPACE_CHANGED' }); return { matches: [] }; } });
  for (const value of [{ query: 'x', path: null }, { query: 'x', caseSensitive: 'false' }, { query: 'x', limit: 1000 }, { query: 'x', path: '../private' }, { query: '\ud800' }]) await assert.rejects(runner.run(value));
  assert.equal(calls, 0);
  await assert.rejects(runner.run({ query: 'needle' }), { code: 'WORKSPACE_CHANGED' });
  assert.deepEqual(await runner.run({ query: 'needle' }), { matches: [] });
});
