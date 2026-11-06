// SPDX-License-Identifier: Apache-2.0
export const WINDOWS_HOST_PREPARATION_MS = 45000;
export const WINDOWS_HOST_CLEANUP_MS = 2000;

/** Bound the owned process phases; this cannot interrupt a durable JS callback. */
export function createWindowsCommandBudget(timeoutMs, onTimeout, {
  now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || typeof onTimeout !== 'function') throw new TypeError('Invalid command budget');
  let phase = 'preparing', deadline = now() + WINDOWS_HOST_PREPARATION_MS, timer;
  const expire = expected => {
    if (phase !== expected) return;
    phase = 'stopped'; cancel(timer); timer = undefined; onTimeout(expected);
  };
  const arm = () => {
    const expected = phase;
    timer = schedule(() => {
      if (phase !== expected) return;
      if (now() < deadline) { arm(); return; }
      expire(expected);
    }, Math.max(1, deadline - now()));
  };
  arm();
  return Object.freeze({
    beginExecution() {
      if (phase !== 'preparing') return false;
      // A blocked event loop must not release GO merely because its timeout
      // callback has not yet been dispatched.
      if (now() >= deadline) { expire('preparing'); return false; }
      cancel(timer); phase = 'executing'; deadline = now() + timeoutMs; arm(); return true;
    },
    stop() { phase = 'stopped'; cancel(timer); timer = undefined; },
    get phase() { return phase; },
  });
}
