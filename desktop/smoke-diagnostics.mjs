// SPDX-License-Identifier: Apache-2.0
// Test-process diagnostics only. Never serialize an Error or inspect its text.
const ACTIONS = new Set(['startup', 'page-check', 'shutdown', 'relaunch', 'open-workspace', 'switch-default', 'switch-recent', 'backup', 'restore']);
const REASONS = new Set(['timeout', 'renderer-exited', 'page-check-failed', 'page-load-failed', 'startup-failed', 'native-menu-failed', 'menu-transition-not-started', 'relaunch-failed', 'shutdown-failed', 'record-failed']);
const CODES = new Set([
  'SMOKE_OPERATION_FAILED', 'SMOKE_TRANSITION_NOT_STARTED', 'SMOKE_TIMEOUT', 'SMOKE_RENDERER_EXITED', 'SMOKE_PAGE_LOAD_FAILED', 'SMOKE_RECORD_FAILED',
  'SMOKE_READINESS_FAILED', 'SMOKE_READINESS_TIMEOUT', 'SMOKE_READINESS_LIMIT',
  'ERR_ASSERTION', 'WORKSPACE_BUSY', 'SHUTTING_DOWN', 'CANCELLED', 'DATA_IN_USE',
  'WORKSPACE_REGISTRY_READ_FAILED', 'WORKSPACE_REGISTRY_WRITE_FAILED', 'WORKSPACE_CLEANUP_INCOMPLETE', 'WORKSPACE_REGISTRY_CHANGED',
  'WORKSPACE_REGISTRY_UNSAFE', 'WORKSPACE_REGISTRY_INVALID', 'WORKSPACE_REGISTRY_COMMIT_UNCERTAIN',
  'WORKSPACE_IDENTITY_CHANGED', 'WORKSPACE_ROOT_CHANGED', 'WORKSPACE_UNAVAILABLE', 'UNSAFE_PATH', 'SENSITIVE_PATH',
  'BACKUP_EXISTS', 'SOURCE_CHANGED', 'UNSAFE_BACKUP_PATH', 'UNSUPPORTED_BACKUP_FILE', 'BACKUP_LIMIT', 'INVALID_BACKUP', 'RESTORE_CLEANUP_INCOMPLETE',
  'RELAUNCH_SMOKE_INVALID', 'RELAUNCH_SMOKE_CHANGED', 'RELAUNCH_SMOKE_UNSAFE', 'RELAUNCH_SMOKE_OWNER', 'RELAUNCH_SMOKE_EXISTS',
  'RELAUNCH_SMOKE_FINISHED', 'RELAUNCH_SMOKE_PREVIOUS_ALIVE', 'RELAUNCH_SMOKE_PROCESS_UNKNOWN',
  'EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EROFS', 'EIO', 'EBUSY', 'EBADF',
]);
const invalid = () => Object.assign(new Error('Invalid bounded smoke diagnostic.'), { code: 'RELAUNCH_SMOKE_INVALID' });
const own = (value, key) => { try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; } };
function exact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length && keys.every(key => actual.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
  } catch { return false; }
}
const validPhase = phase => Number.isInteger(phase) && phase >= 0 && phase <= 4;

export function createSmokeFailure(error, { phase, action, reason = 'native-menu-failed' }) {
  if (!validPhase(phase) || !ACTIONS.has(action) || !REASONS.has(reason)) throw invalid();
  const supplied = own(error, 'code'), code = CODES.has(supplied) ? supplied : 'SMOKE_OPERATION_FAILED';
  return { ok: false, error: reason, diagnostic: { version: 1, phase, action, code } };
}

export function validateSmokeFailure(value, { phase } = {}) {
  if (!exact(value, ['ok', 'error', 'diagnostic']) || own(value, 'ok') !== false || !REASONS.has(own(value, 'error'))) throw invalid();
  const detail = own(value, 'diagnostic');
  if (!exact(detail, ['version', 'phase', 'action', 'code']) || own(detail, 'version') !== 1 || !validPhase(own(detail, 'phase'))
    || (phase !== undefined && own(detail, 'phase') !== phase) || !ACTIONS.has(own(detail, 'action')) || !CODES.has(own(detail, 'code'))) throw invalid();
  return { ok: false, error: own(value, 'error'), diagnostic: { version: 1, phase: own(detail, 'phase'), action: own(detail, 'action'), code: own(detail, 'code') } };
}

export function assertSmokeTransition(result, prepared) {
  if (result === false || result == null || prepared !== true) {
    throw Object.assign(new Error('Required smoke transition did not start.'), { code: 'SMOKE_TRANSITION_NOT_STARTED' });
  }
}

/** A failure record is an observation, not proof that shutdown has settled.
 * Callers still await finish and independently verify process exit before cleanup.
 * record is synchronous (the exclusive, owner-checked smoke state writer).
 */
export function createSmokeController({ phase, record, close, output, exit, recordFailure = () => {} }) {
  if (!validPhase(phase) || ![record, close, output, exit, recordFailure].every(value => typeof value === 'function')) throw invalid();
  let failure = null, action = 'startup', completion = null, terminal = false, recordAttempted = false;
  function write(value) {
    if (recordAttempted) return;
    recordAttempted = true;
    try { record(value); }
    catch {
      // A partly written exclusive record must never be overwritten or retried.
      failure ??= createSmokeFailure({ code: 'SMOKE_RECORD_FAILED' }, { phase, action, reason: 'record-failed' });
      try { recordFailure(); } catch { /* fixed callback only; never expose its error */ }
    }
  }
  function capture(error, { action: failedAction = action, reason = 'native-menu-failed' } = {}) {
    if (terminal || failure) return failure && validateSmokeFailure(failure, { phase });
    failure = createSmokeFailure(error, { phase, action: failedAction, reason });
    write(failure);
    return validateSmokeFailure(failure, { phase });
  }
  function finish(result) {
    if (completion) return completion;
    if (result?.ok === false) {
      const safe = validateSmokeFailure(result, { phase });
      capture({ code: safe.diagnostic.code }, { action: safe.diagnostic.action, reason: safe.error });
    } else if (!failure && result?.ok !== true) throw invalid();
    // Install the shared completion before entering any injected callback.
    let resolve, reject;
    completion = new Promise((yes, no) => { resolve = yes; reject = no; });
    void (async () => {
      try { await close(); }
      catch (error) { capture(error, { action: 'shutdown', reason: 'shutdown-failed' }); }
      if (!failure) write(result);
      const final = failure ? validateSmokeFailure(failure, { phase }) : result;
      terminal = true;
      output(final);
      exit(final.ok ? 0 : 1);
      return final;
    })().then(resolve, reject);
    return completion;
  }
  function runMenu(menuAction, work) {
    if (!ACTIONS.has(menuAction) || typeof work !== 'function') throw invalid();
    if (failure || completion) return Promise.resolve(false);
    action = menuAction;
    // Defer entry so a synchronous throw is handled exactly like a rejection.
    return Promise.resolve().then(() => failure || completion ? false : work()).catch(async error => {
      capture(error, { action: menuAction });
      await finish();
      return false;
    });
  }
  function capturePageError(error) {
    return own(error, 'code') === 'SMOKE_TRANSITION_NOT_STARTED'
      ? capture(error, { reason: 'menu-transition-not-started' })
      : capture(error, { action: 'page-check', reason: 'page-check-failed' });
  }
  async function relaunch({ select, prepare, launch }) {
    if (![select, prepare, launch].every(value => typeof value === 'function')) throw invalid();
    try {
      if (failure || completion) { await finish(); return false; }
      const selected = await select();
      // A timeout/error may have been recorded while selection was awaited,
      // including when the exclusive record writer itself failed.
      if (failure || completion) { await finish(); return false; }
      const next = prepare(selected);
      if (failure || completion) { await finish(); return false; }
      launch(next);
      return true;
    } catch (error) {
      capture(error, { action: 'relaunch', reason: 'relaunch-failed' });
      await finish();
      return false;
    }
  }
  return Object.freeze({ capture, capturePageError, finish, runMenu, relaunch,
    get failed() { return failure !== null; },
    get finishing() { return completion !== null; },
    get action() { return action; },
    get failure() { return failure && validateSmokeFailure(failure, { phase }); },
  });
}
