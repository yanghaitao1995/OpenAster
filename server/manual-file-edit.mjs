// SPDX-License-Identifier: Apache-2.0
import { CoreError } from '../core/errors.mjs';
import { MAX_FILE_BYTES } from '../core/workspace.mjs';

export const FILE_EDIT_BODY_BYTES = 6 * MAX_FILE_BYTES + 4096;
const STORAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function validateManualFileEdit(value, storageId) {
  const keys = ['storageId', 'path', 'expectedHash', 'content'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).some(key => !keys.includes(key))
    || keys.some(key => (key !== 'storageId' || Object.hasOwn(value, key)) && (!Object.getOwnPropertyDescriptor(value, key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))) {
    throw new CoreError('INVALID_FILE_EDIT', '保存仅接受工作区身份、文件路径、原文件哈希及完整文本。');
  }
  const copy = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(value, key)?.value]));
  if (typeof copy.storageId !== 'string' || !STORAGE_ID.test(copy.storageId) || copy.storageId !== storageId) {
    throw new CoreError('FILE_EDIT_WORKSPACE_CHANGED', '工作区数据身份已改变；未保存文件，请保留编辑内容并重新打开工作区。', 409);
  }
  return copy;
}

/** Slots remain owned until the actual filesystem and audit work settles. */
export function createManualFileEditor({ workspace, storageId, audit, onSaved = () => {} }, { timeoutMs = 30000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid manual file save timeout');
  const active = new Set();
  let closed = false;
  const stop = signal => { if (signal.aborted) throw signal.reason; };
  async function record(entry, applied) {
    try { await audit(entry); }
    catch {
      throw new CoreError(applied ? 'POST_WRITE_AUDIT_FAILED' : 'AUDIT_UNAVAILABLE', applied
        ? '文件已写入，但保存结果的审计记录失败；请保留编辑内容并重新读取核对，勿自动重试。'
        : '审计记录无法保存，文件尚未写入；请保留编辑内容。', 503);
    }
  }
  async function notify() { try { await onSaved(); } catch { /* A notification cannot undo a committed write. */ } }
  return Object.freeze({
    async run(value, { signal } = {}) {
      if (closed) throw new CoreError('SHUTTING_DOWN', '服务正在停止，未开始保存文件。', 503);
      const input = validateManualFileEdit(value, storageId());
      if (active.size >= 2) throw new CoreError('FILE_EDIT_BUSY', '另一些文件保存仍在进行或结束，请稍后再次保存。', 429);
      const controller = new AbortController();
      const cancel = () => controller.abort(new CoreError('CANCELLED', '保存请求已取消；若连接中断，请重新读取文件确认结果。', 409));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      let settled;
      const done = new Promise(resolve => { settled = resolve; });
      const operation = { controller, done };
      active.add(operation);
      const timer = setTimeout(() => controller.abort(new CoreError('FILE_EDIT_TIMEOUT', '保存文件超过 30 秒；请保留编辑内容并重新读取核对，勿自动重试。', 504)), timeoutMs);
      timer.unref?.();
      let proposal;
      try {
        stop(controller.signal);
        proposal = await workspace.prepareReplace(input, { signal: controller.signal });
        stop(controller.signal);
        const result = { version: 1, storageId: input.storageId, path: proposal.path, bytes: proposal.bytes, sha256: proposal.newHash, changed: proposal.originalHash !== proposal.newHash };
        if (!result.changed) return result;
        const detail = { path: proposal.path, originalHash: proposal.originalHash, sha256: proposal.newHash, bytes: proposal.bytes };
        await record({ action: 'workspace.manual-save.requested', detail }, false);
        stop(controller.signal);
        try { await workspace.commitWrite(proposal, { signal: controller.signal }); }
        catch (cause) {
          if (cause.code === 'POST_WRITE_CLEANUP_FAILED') {
            try { await record({ action: 'workspace.manual-saved', detail: { ...detail, cleanupPending: true } }, true); }
            finally { await notify(); }
          }
          throw cause;
        }
        // rename/link has succeeded. Do not reinterpret a late abort as no write.
        try { await record({ action: 'workspace.manual-saved', detail }, true); }
        finally { await notify(); }
        return result;
      } catch (cause) {
        if (cause.code === 'CANCELLED' && controller.signal.aborted) throw controller.signal.reason;
        throw cause;
      } finally {
        workspace.discardWrite(proposal);
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        active.delete(operation);
        settled();
      }
    },
    close() {
      closed = true;
      const operations = [...active];
      for (const operation of operations) operation.controller.abort(new CoreError('SHUTTING_DOWN', '服务正在停止，保存文件已取消；请重新读取核对结果。', 503));
      return Promise.all(operations.map(operation => operation.done));
    },
  });
}
