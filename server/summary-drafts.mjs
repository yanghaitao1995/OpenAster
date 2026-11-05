// SPDX-License-Identifier: Apache-2.0
import { CoreError } from '../core/errors.mjs';

/** Own background work until it settles, including credential reads and saves. */
export function createSummaryDraftRunner({ timeoutMs = 10 * 60_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) throw new TypeError('Invalid summary draft timeout');
  let active = null, closed = false;
  return {
    get active() { return active !== null; },
    isActive(id) { return active?.id === id; },
    start(id, operation) {
      if (closed) throw new CoreError('SHUTTING_DOWN', '服务正在停止。', 503);
      if (active) throw new CoreError('SUMMARY_DRAFT_BUSY', '另一次摘要生成尚未结束，请停止或等待完成。', 429);
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(id) || typeof operation !== 'function') throw new TypeError('Invalid summary draft operation');
      const controller = new AbortController();
      let settle;
      const done = new Promise(resolve => { settle = resolve; });
      const entry = { id, controller, done };
      active = entry;
      const timeout = setTimeout(() => controller.abort(new CoreError('SUMMARY_TIMEOUT', '摘要生成超过总时限，已请求停止；已发出的模型请求仍可能计费。', 504)), timeoutMs);
      timeout.unref?.();
      // Start synchronously so the caller can reserve source/provider ownership
      // before returning the accepted operation. Every rejection is observed.
      let result;
      try { result = operation(controller.signal); }
      catch (cause) { result = Promise.reject(cause); }
      const finish = result => {
        clearTimeout(timeout);
        if (active === entry) active = null;
        settle(result);
      };
      Promise.resolve(result).then(
        value => finish({ ok: true, value }),
        error => finish({ ok: false, error }),
      );
      return done;
    },
    cancel(id) {
      if (active?.id !== id) return false;
      active.controller.abort(new CoreError('CANCELLED', '已请求停止摘要生成；已发出的模型请求仍可能计费。', 409));
      return true;
    },
    close() {
      closed = true;
      active?.controller.abort(new CoreError('SHUTTING_DOWN', '服务正在停止，摘要生成已取消。', 503));
      return active?.done ?? Promise.resolve();
    },
  };
}
