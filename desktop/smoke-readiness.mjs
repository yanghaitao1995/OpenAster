// SPDX-License-Identifier: Apache-2.0
// Controlled-idle fixture only: pause NEW background requests before a native
// transition, then drain admitted network requests AND original HTTP handlers.
// This is not evidence of naturally idle UI startup and never changes close().
const failure = code => Object.assign(new Error('Smoke request readiness could not be verified.'), { code });
const invalid = () => failure('SMOKE_READINESS_FAILED');

export function createSmokeReadiness({ server, origin, timeoutMs = 30000, maxRequests = 2048, maxActive = 256, onFailure = () => {} }) {
  if (!server || typeof server.rawListeners !== 'function' || typeof origin !== 'string'
    || new URL(origin).origin !== origin || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
    || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 2048
    || !Number.isInteger(maxActive) || maxActive < 1 || maxActive > 256 || typeof onFailure !== 'function') throw invalid();
  const listeners = server.rawListeners('request');
  if (listeners.length !== 1 || server.listeners('request')[0] !== listeners[0]) throw invalid();
  const original = listeners[0], requests = new Map(), activeHandlers = new Set(), waiters = new Set();
  let sealed = false, disposed = false, ending = false, firstFailure = null, sealPromise = null, timer, ready = false;
  let handlersStarted = 0, handlersSettled = 0, admittedRequests = 0, completedRequests = 0, eventStreamsReady = 0, pausedRequests = 0;
  const wake = () => { for (const accept of waiters) accept(); waiters.clear(); };
  function fail(code = 'SMOKE_READINESS_FAILED') {
    if (!firstFailure) {
      firstFailure = failure(code);
      // Report a fixed code even after seal's Promise resolved, so a late
      // failure can latch the smoke controller before ticket/relaunch work.
      try { onFailure(failure(code)); } catch { /* never expose callback errors */ }
    }
    wake();
  }
  function invoke(entry, cancel) {
    const callback = entry.callback; entry.callback = null;
    try { callback?.({ cancel }); } catch { fail(); }
  }
  function observedRequest(...args) {
    if (disposed) throw invalid();
    let pending;
    try { pending = Reflect.apply(original, this, args); }
    catch (error) { fail(); throw error; }
    // The application's sole request listener is async. Do not turn a missing
    // completion contract into an apparent drain or replace its return value.
    if (!(pending instanceof Promise)) { fail(); return pending; }
    handlersStarted++; activeHandlers.add(pending);
    void pending.then(() => {
      activeHandlers.delete(pending); handlersSettled++; wake();
    }, () => {
      activeHandlers.delete(pending); handlersSettled++; fail();
    });
    return pending;
  }
  server.removeListener('request', original); server.on('request', observedRequest);
  const unchanged = () => {
    const current = server.rawListeners('request');
    if (current.length !== 1 || current[0] !== observedRequest) { fail(); return false; }
    return true;
  };
  function beforeRequest(details, callback) {
    let url;
    try { url = new URL(details.url); } catch { callback({ cancel: true }); fail(); return; }
    // Defense in depth: main's existing origin check runs BEFORE this hook.
    if (url.origin !== origin) { callback({ cancel: true }); return; }
    if (typeof callback !== 'function' || !Number.isSafeInteger(details.id) || details.id < 0 || requests.has(details.id)) {
      callback?.({ cancel: true }); fail(); return;
    }
    if (disposed || ending || firstFailure) { callback({ cancel: true }); return; }
    const active = [...requests.values()].filter(item => item.state === 'pending' || item.state === 'paused').length;
    if (requests.size >= maxRequests || active >= maxActive) { callback({ cancel: true }); fail('SMOKE_READINESS_LIMIT'); return; }
    const entry = { state: sealed ? 'paused' : 'pending', stream: details.method === 'GET' && url.pathname === '/api/events' && !url.search, callback };
    requests.set(details.id, entry); // Register BEFORE allowing network admission.
    if (sealed) { pausedRequests++; return; }
    admittedRequests++; invoke(entry, false);
  }
  function responseStarted(details) {
    const entry = requests.get(details.id);
    if (!entry || entry.state !== 'pending' || !entry.stream || ending || disposed) return;
    const types = Object.entries(details.responseHeaders ?? {}).filter(([key]) => key.toLowerCase() === 'content-type').flatMap(([, value]) => value);
    if (details.statusCode !== 200 || types.length !== 1 || typeof types[0] !== 'string' || !/^text\/event-stream(?:\s*;|\s*$)/i.test(types[0])) { fail(); return; }
    // This application's SSE handler writes the initial event and returns with
    // no intervening await. Its actual Promise is nevertheless drained below.
    entry.state = 'stream-ready'; eventStreamsReady++; wake();
  }
  function completed(details) {
    const entry = requests.get(details.id);
    if (!entry || ending || disposed || !['pending', 'stream-ready'].includes(entry.state)) return;
    if (!(Number.isInteger(details.statusCode) && ((details.statusCode >= 200 && details.statusCode < 300) || details.statusCode === 304))) { fail(); return; }
    if (entry.state === 'pending' && entry.stream) { fail(); return; }
    entry.state = 'completed'; completedRequests++; wake();
  }
  function errored(details) {
    const entry = requests.get(details.id);
    if (!entry || ending || disposed || entry.state === 'paused' || entry.state === 'completed') return;
    entry.state = 'error'; fail(); // Never equate a disconnect with server drain.
  }
  async function waitFor(predicate) {
    while (!predicate()) { if (firstFailure) throw firstFailure; await new Promise(resolve => waiters.add(resolve)); }
    if (firstFailure) throw firstFailure;
  }
  function seal() {
    if (sealPromise) return sealPromise;
    sealed = true; // Synchronous gate, including Service Worker requests.
    if (disposed || ending) fail();
    unchanged();
    timer = setTimeout(() => fail('SMOKE_READINESS_TIMEOUT'), timeoutMs);
    sealPromise = (async () => {
      try {
        await waitFor(() => ![...requests.values()].some(entry => entry.state === 'pending'));
        // Network completion alone is insufficient after cancellation or a
        // response emitted before an async handler's final work has settled.
        await waitFor(() => activeHandlers.size === 0);
        unchanged(); if (firstFailure) throw firstFailure;
        ready = true;
        return { version: 1, policy: 'pause-new-background-requests-before-transition',
          admittedRequests, completedRequests, eventStreamsReady, pausedRequests,
          handlersStarted, handlersSettled, allAdmittedRequestsSettled: true, allStartedHandlersSettled: true };
      } finally { clearTimeout(timer); }
    })();
    return sealPromise;
  }
  function beginClosing() {
    ending = true; sealed = true; clearTimeout(timer);
    if (sealPromise && !ready) fail();
    // These requests were never admitted to the server. Release their network
    // callbacks as cancelled before shutdown; this is not an I/O drain claim.
    for (const entry of requests.values()) if (entry.state === 'paused') invoke(entry, true);
  }
  function dispose() {
    beginClosing();
    if (activeHandlers.size || !unchanged()) throw invalid();
    server.removeListener('request', observedRequest); server.on('request', original);
    disposed = true; requests.clear(); wake();
  }
  return Object.freeze({ beforeRequest, responseStarted, completed, errored, seal, beginClosing, dispose });
}
