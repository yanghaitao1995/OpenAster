// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsCommandBudget, WINDOWS_HOST_PREPARATION_MS } from '../core/windows-command-budget.mjs';

function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(callback, delay) { const token = ++id; timers.set(token, { at: time + delay, callback }); return token; },
    cancel(token) { timers.delete(token); },
    advance(milliseconds, dispatch = true) {
      const target = time + milliseconds;
      if (dispatch) for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        time = Math.max(time, next[1].at); timers.delete(next[0]); next[1].callback();
      }
      time = target;
    },
    pending: () => timers.size,
  };
}

test('cold Windows host preparation preserves the original complete execution budget', () => {
  const time = clock(), expired = [], budget = createWindowsCommandBudget(15000, phase => expired.push(phase), time);
  time.advance(29000); assert.equal(budget.phase, 'preparing');
  time.advance(2000); // Durable checkpoint remains inside preparation.
  assert.equal(budget.beginExecution(), true);
  time.advance(14999); assert.deepEqual(expired, []);
  time.advance(1); assert.deepEqual(expired, ['executing']); assert.equal(budget.phase, 'stopped');
  assert.equal(budget.beginExecution(), false); assert.equal(time.pending(), 0);
});

test('preparation deadline closes the gate before a late checkpoint can release GO', async () => {
  const time = clock(), expired = [], budget = createWindowsCommandBudget(30000, phase => expired.push(phase), time);
  let release, go = 0, drained = false;
  const checkpoint = new Promise(resolve => { release = resolve; }).then(() => { drained = true; if (budget.beginExecution()) go++; });
  time.advance(WINDOWS_HOST_PREPARATION_MS);
  assert.deepEqual(expired, ['preparing']); assert.equal(drained, false); assert.equal(go, 0);
  release(); await checkpoint;
  assert.equal(drained, true); assert.equal(go, 0); assert.equal(time.pending(), 0);
});

test('preparation cancellation never starts execution even after bounded callback drainage', async () => {
  const time = clock(), budget = createWindowsCommandBudget(30000, () => assert.fail('cancelled timer fired'), time);
  let release, go = 0;
  const checkpoint = new Promise(resolve => { release = resolve; }).then(() => { if (budget.beginExecution()) go++; });
  time.advance(100); budget.stop(); release(); await checkpoint; time.advance(90000);
  assert.equal(go, 0); assert.equal(time.pending(), 0);
});

test('a delayed timer dispatch cannot open an expired preparation gate', () => {
  const time = clock(), expired = [], budget = createWindowsCommandBudget(1000, phase => expired.push(phase), time);
  time.advance(WINDOWS_HOST_PREPARATION_MS, false);
  assert.equal(budget.beginExecution(), false); assert.deepEqual(expired, ['preparing']);
  time.advance(100000); assert.deepEqual(expired, ['preparing']); assert.equal(time.pending(), 0);
});

test('successful completion cancels both phases without duplicate expiry', () => {
  const time = clock(), budget = createWindowsCommandBudget(1000, () => assert.fail('completed timer fired'), time);
  assert.equal(budget.beginExecution(), true); assert.equal(budget.beginExecution(), false);
  time.advance(500); budget.stop(); budget.stop(); time.advance(100000);
  assert.equal(time.pending(), 0);
});
