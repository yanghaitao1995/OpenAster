// SPDX-License-Identifier: Apache-2.0
import { CoreError } from '../core/errors.mjs';
import { validateSearchQuery } from '../core/workspace-search.mjs';
import { validateRelativePath } from '../core/workspace.mjs';

export function validateWorkspaceSearch(value) {
  const invalid = () => new CoreError('INVALID_WORKSPACE_SEARCH', '内容搜索仅接受 query、path、includeGenerated、includeIgnored 和 caseSensitive；选项必须使用正确的文本或布尔类型。');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['query', 'path', 'includeGenerated', 'includeIgnored', 'caseSensitive'].includes(key))) throw invalid();
  validateSearchQuery(value.query);
  const scope = value.path ?? '';
  if (Object.hasOwn(value, 'path') && typeof value.path !== 'string') throw invalid();
  if (scope) validateRelativePath(scope);
  for (const key of ['includeGenerated', 'includeIgnored', 'caseSensitive']) if (Object.hasOwn(value, key) && typeof value[key] !== 'boolean') throw invalid();
  return { query: value.query, path: scope, includeGenerated: value.includeGenerated ?? false, includeIgnored: value.includeIgnored ?? false, caseSensitive: value.caseSensitive ?? false };
}

// A single scan owns the slot until it actually stops. Aborting an HTTP client
// must not release the slot while its filesystem work is still in flight.
export function createWorkspaceSearch(workspace, { timeoutMs = 30000 } = {}) {
  let active = null;
  let closed = false;
  return {
    async run(value, { signal } = {}) {
      const { query, ...options } = validateWorkspaceSearch(value);
      if (closed) throw new CoreError('SHUTTING_DOWN', '服务正在停止。', 503);
      if (active) throw new CoreError('WORKSPACE_SEARCH_BUSY', '另一次内容搜索正在结束，请稍后重试。', 429);
      const controller = new AbortController();
      const cancel = () => controller.abort(new CoreError('CANCELLED', '内容搜索已取消。', 409));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      let settled;
      const done = new Promise(resolve => { settled = resolve; });
      active = { controller, done };
      const timeout = setTimeout(() => controller.abort(new CoreError('WORKSPACE_SEARCH_TIMEOUT', '内容搜索超过 30 秒，请缩小目录范围后重试。', 408)), timeoutMs);
      timeout.unref?.();
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        const result = await workspace.search(query, { ...options, signal: controller.signal });
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
