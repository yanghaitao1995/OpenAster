// SPDX-License-Identifier: Apache-2.0
import { CoreError } from '../core/errors.mjs';

export function validateProviderDiagnosticsRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) {
    throw new CoreError('INVALID_PROVIDER_DIAGNOSTICS', '兼容性诊断仅接受空 JSON 对象，不接受提示词或自定义测试参数。');
  }
}

// Both connection checks share this slot. Cancellation requests stop the work,
// but ownership ends only when it really settles, including credential reads.
export function createProviderDiagnostics({ timeoutMs = 125000, testTimeoutMs = 60000 } = {}) {
  for (const [value, maximum] of [[timeoutMs, 125000], [testTimeoutMs, 60000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError('Invalid provider diagnostic timeout');
  }
  let active = null;
  let closed = false;
  return {
    async run(operation, { kind = 'diagnostics', signal } = {}) {
      if (!['diagnostics', 'test'].includes(kind) || typeof operation !== 'function') throw new TypeError('Invalid provider diagnostic operation');
      if (closed) throw new CoreError('SHUTTING_DOWN', '服务正在停止。', 503);
      if (active) throw new CoreError('PROVIDER_DIAGNOSTICS_BUSY', '另一次模型连接检查尚未结束，请稍后重试。', 429);
      const controller = new AbortController();
      const cancel = () => controller.abort(new CoreError('CANCELLED', '模型连接检查已取消。', 409));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      let settled;
      const done = new Promise(resolve => { settled = resolve; });
      active = { controller, done };
      const timeout = setTimeout(() => controller.abort(new CoreError(
        kind === 'test' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_DIAGNOSTICS_TIMEOUT',
        kind === 'test' ? '模型响应超时，请稍后重试。' : '模型兼容性诊断超时，请稍后重试。',
        504,
      )), kind === 'test' ? testTimeoutMs : timeoutMs);
      timeout.unref?.();
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        const result = await operation(controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        return result;
      } catch (cause) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw cause;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        active = null;
        settled();
      }
    },
    close() {
      closed = true;
      active?.controller.abort(new CoreError('SHUTTING_DOWN', '服务正在停止。', 503));
      return active?.done ?? Promise.resolve();
    },
  };
}
