// SPDX-License-Identifier: Apache-2.0
// A watchdog for transport inactivity, not an overall generation deadline.
export function providerActivityTimeout({ connectionTimeoutMs = 120000, idleTimeoutMs = 120000 } = {}) {
  for (const value of [connectionTimeoutMs, idleTimeoutMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new TypeError('Invalid provider inactivity timeout');
  const controller = new AbortController();
  let timer, closed = false;
  const arm = ms => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), ms); };
  arm(connectionTimeoutMs);
  return {
    signal: controller.signal,
    activity() { if (!closed && !controller.signal.aborted) arm(idleTimeoutMs); },
    close() { closed = true; clearTimeout(timer); },
  };
}
