
// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
const CHECK = 'openaster:native-leave-check';
const RELEASE = 'openaster:native-leave-release';
const REASONS = new Set(['pending', 'drafts-pending', 'unknown', null]);
/** Electron may finish an async drain before its original will-quit emission
 * unwinds. Resume quitting in a later turn, preserving beforeunload handling. */
export function createDeferredNativeQuit(quit, schedule = setImmediate) {
  if (typeof quit !== 'function' || typeof schedule !== 'function') throw new TypeError('Invalid deferred quit');
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    schedule(() => { scheduled = false; quit(); });
  };
}
const failure = reason => Object.assign(new Error(reason === 'pending'
  ? '文件仍有未保存或尚待核对的修改。请返回编辑器处理后，再执行此操作。'
  : reason === 'drafts-pending' ? '输入草稿尚未保存完成。请等待保存或处理草稿状态后，再执行此操作。'
    : '当前页面尚未确认可以安全离开。请返回工作台检查未保存内容后重试。'),
{ code: reason === 'pending' ? 'NATIVE_LEAVE_PENDING' : reason === 'drafts-pending' ? 'NATIVE_LEAVE_DRAFTS_PENDING' : 'NATIVE_LEAVE_UNKNOWN' });
function validReply(value, token) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3 && ['allowed','reason','token'].every(key => Object.hasOwn(value,key))
    && typeof value.allowed === 'boolean' && value.token === token && REASONS.has(value.reason)
    && (value.allowed ? value.reason === null : value.reason !== null);
}
function script(event, token) {
  return '(() => { const detail = {version:1,token:'+JSON.stringify(token)+',result:null}; document.dispatchEvent(new CustomEvent('+JSON.stringify(event)+', {cancelable:true,detail})); return detail.result; })()';
}
function bounded(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const stop = (fn, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const abort = () => stop(reject, failure('unknown'));
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(value => stop(resolve,value), () => stop(reject,failure('unknown')));
  });
}
/** Transfers only a random lease token and boolean state, never renderer text. */
export function createNativeLeaveGuard({ getWindow, timeoutMs = 3000, createToken = () => randomBytes(16).toString('hex') }) {
  if (typeof getWindow !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new TypeError('Invalid native leave guard');
  let held;
  return Object.freeze({
    async acquire({ signal } = {}) {
      if (held || signal?.aborted) throw failure('unknown');
      const window = getWindow(), token = createToken();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed() || !/^[a-f0-9]{32}$/u.test(token)) throw failure('unknown');
      const lease = { token, releasePromise: null };
      held = lease;
      const release = () => {
        if (lease.releasePromise) return lease.releasePromise;
        // Queue release even on timeout: a late check may still install this
        // token. Renderer release must never unlock a different token.
        lease.releasePromise = (async () => {
          try {
            if (window.isDestroyed() || window.webContents.isDestroyed()) return true;
            const reply = await bounded(window.webContents.executeJavaScript(script(RELEASE,token)), timeoutMs);
            return Boolean(validReply(reply,token) && reply.allowed);
          } catch { return false; }
          finally { if (held === lease) held = undefined; }
        })();
        return lease.releasePromise;
      };
      let confirmedDenial = false;
      try {
        const reply = await bounded(window.webContents.executeJavaScript(script(CHECK,token)), timeoutMs, signal);
        if (!validReply(reply,token)) throw failure('unknown');
        if (!reply.allowed) { confirmedDenial = true; throw failure(reply.reason); }
        if (signal?.aborted) throw failure('unknown');
        return Object.freeze({ release });
      } catch (error) {
        const released = await release();
        // An explicit denial never installed a lease. An unknown check may
        // have done so, and must not look recoverable until release is known.
        if (!confirmedDenial && !released) throw Object.assign(new Error(
          '未确认页面已解除离开锁定。本次操作已停止，本地服务尚未关闭；请先核对窗口状态和未保存内容。',
          { cause: error },
        ), { code: 'NATIVE_LEAVE_RELEASE_FAILED' });
        throw ['NATIVE_LEAVE_PENDING','NATIVE_LEAVE_DRAFTS_PENDING','NATIVE_LEAVE_UNKNOWN'].includes(error?.code) ? error : failure('unknown');
      }
    },
  });
}
