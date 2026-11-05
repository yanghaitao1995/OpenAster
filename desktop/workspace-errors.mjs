// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';

const STAGES = Object.freeze({
  'read-registry': '读取注册配置',
  'verify-before': '核对原配置',
  'open-temporary': '创建暂存配置',
  'inspect-temporary': '核对暂存配置身份',
  'write-temporary': '写入暂存配置',
  'sync-temporary': '同步暂存配置',
  'close-temporary': '关闭暂存配置',
  'verify-before-commit': '提交前核对原配置',
  'inspect-before-commit': '提交前核对暂存配置',
  'link-registry': '首次登记配置',
  'remove-installed-temporary': '清理已登记配置的暂存链接',
  'rename-registry': '替换注册配置',
  'readback-registry': '重新读取已提交配置',
  'validate-readback': '验证已提交配置',
  'prepare-profile': '准备工作区数据目录',
});
const CLEANUP_STAGES = Object.freeze({
  'close-registry': '关闭注册配置',
  'close-temporary': '关闭暂存配置',
  'remove-temporary': '清理暂存配置',
  'remove-profile': '清理新工作区数据目录',
});
const SYSTEM_CODES = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EDQUOT', 'EROFS', 'EIO',
  'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR', 'ENOTEMPTY', 'EBUSY', 'EXDEV',
  'EINVAL', 'EBADF', 'ELOOP', 'ENAMETOOLONG', 'ENOTSUP', 'EOPNOTSUPP',
  'ESTALE', 'ENOSYS', 'EAGAIN', 'ECANCELED', 'ETXTBSY', 'UNKNOWN',
]);
const SYSCALLS = new Set([
  'open', 'read', 'readv', 'write', 'writev', 'fsync', 'fdatasync', 'close',
  'stat', 'fstat', 'lstat', 'realpath', 'link', 'rename', 'unlink', 'mkdir',
  'rmdir', 'access', 'scandir', 'opendir', 'readlink', 'chmod', 'fchmod',
]);
const MAX_CAUSES = 6;
const MAX_CLEANUP = 6;

// Never invoke error getters, toJSON, or arbitrary string conversion. A Proxy
// may reject reflection; that only removes optional diagnostic information.
function own(value, name) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, name)?.value; }
  catch { return undefined; }
}
function array(value) { try { return Array.isArray(value); } catch { return false; } }
function fields(value, required, optional = []) {
  if (value === null || typeof value !== 'object') return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    return keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))
      && required.every(key => keys.includes(key));
  } catch { return false; }
}
function enumValue(values, value) { return typeof value === 'string' && values.has(value) ? value : undefined; }
function nativeFields(value) {
  const systemCode = enumValue(SYSTEM_CODES, own(value, 'code'));
  const syscall = enumValue(SYSCALLS, own(value, 'syscall'));
  return { ...(systemCode ? { systemCode } : {}), ...(syscall ? { syscall } : {}) };
}
function safeNative(value) {
  const result = {};
  for (const [name, allowed] of [['systemCode', SYSTEM_CODES], ['syscall', SYSCALLS]]) {
    const entry = own(value, name);
    if (entry !== undefined) {
      if (!enumValue(allowed, entry)) return null;
      result[name] = entry;
    }
  }
  return result;
}
function safeDiagnostic(value) {
  if (!fields(value, ['version', 'stage', 'committed'], ['systemCode', 'syscall', 'cleanup'])
    || own(value, 'version') !== 1 || typeof own(value, 'stage') !== 'string' || !Object.hasOwn(STAGES, own(value, 'stage'))
    || typeof own(value, 'committed') !== 'boolean') return null;
  const native = safeNative(value);
  if (!native) return null;
  const result = { version: 1, stage: own(value, 'stage'), committed: own(value, 'committed'), ...native };
  const entries = own(value, 'cleanup');
  if (entries !== undefined) {
    if (!array(entries) || !Number.isSafeInteger(own(entries, 'length')) || own(entries, 'length') > MAX_CLEANUP) return null;
    const cleanup = [];
    for (let index = 0; index < own(entries, 'length'); index++) {
      const entry = own(entries, String(index));
      if (!fields(entry, ['stage'], ['systemCode', 'syscall']) || typeof own(entry, 'stage') !== 'string' || !Object.hasOwn(CLEANUP_STAGES, own(entry, 'stage'))) return null;
      const detail = safeNative(entry);
      if (!detail) return null;
      cleanup.push({ stage: own(entry, 'stage'), ...detail });
    }
    if (cleanup.length) result.cleanup = cleanup;
  }
  return result;
}
function inspectCauses(cause) {
  let native = {}, diagnostic;
  const seen = new Set();
  for (let index = 0; index < MAX_CAUSES && cause && !seen.has(cause); index++) {
    seen.add(cause);
    diagnostic ??= safeDiagnostic(own(cause, 'registryDiagnostic'));
    const current = nativeFields(cause);
    native = { ...current, ...native };
    cause = own(cause, 'cause');
  }
  return { native, diagnostic };
}

/** Enumerable, bounded facts only; raw errors remain on the caller's cause. */
export function createRegistryDiagnostic({ stage, committed = false, cause, cleanup = [] }) {
  if (typeof stage !== 'string' || !Object.hasOwn(STAGES, stage) || typeof committed !== 'boolean'
    || !Array.isArray(cleanup) || cleanup.length > 3) throw new TypeError('Invalid registry diagnostic options');
  const previous = inspectCauses(cause);
  const result = previous.diagnostic
    ? { ...previous.diagnostic, committed: committed || previous.diagnostic.committed }
    : { version: 1, stage, committed, ...previous.native };
  const entries = [...(result.cleanup ?? [])];
  for (let index = 0; index < cleanup.length; index++) {
    const entry = own(cleanup, String(index)), cleanupStage = own(entry, 'stage');
    if (typeof cleanupStage !== 'string' || !Object.hasOwn(CLEANUP_STAGES, cleanupStage)) throw new TypeError('Invalid registry cleanup stage');
    const detail = { stage: cleanupStage, ...inspectCauses(own(entry, 'cause')).native };
    if (!entries.some(value => value.stage === detail.stage && value.systemCode === detail.systemCode && value.syscall === detail.syscall)) entries.push(detail);
  }
  if (entries.length) result.cleanup = entries.slice(0, MAX_CLEANUP);
  else delete result.cleanup;
  return result;
}

function diagnosticFor(value) { return safeDiagnostic(value) ?? inspectCauses(value).diagnostic; }
export function formatRegistryDiagnostic(errorOrDiagnostic) {
  const diagnostic = diagnosticFor(errorOrDiagnostic);
  if (!diagnostic) return '';
  const native = value => [value.systemCode, value.syscall].filter(Boolean).join(' / ');
  return [
    `诊断阶段：${STAGES[diagnostic.stage]}（${diagnostic.stage}）`,
    `提交状态：${diagnostic.committed ? '已提交，保存结果待确认' : '未确认提交'}`,
    native(diagnostic) ? `系统诊断：${native(diagnostic)}` : '',
    ...(diagnostic.cleanup ?? []).map(value => `另有清理问题：${CLEANUP_STAGES[value.stage]}${native(value) ? `（${native(value)}）` : ''}`),
  ].filter(Boolean).join('\n');
}

function retainedLocations(error, { restoring = false } = {}) {
  const locations = [];
  const orphan = own(error, 'orphanPath');
  const add = value => {
    if (locations.length >= 3 || typeof value !== 'string' || value.length > 4096 || !value.isWellFormed()
      || /[\0-\x1f\x7f]/u.test(value) || !path.isAbsolute(value) || value.split(/[\\/]/u).includes('..')
      || (process.platform === 'win32' && (!/^[a-zA-Z]:[\\/]/u.test(value) || /[:<>"|?*]/u.test(value.slice(2))))) return;
    if (restoring && typeof orphan === 'string' && (process.platform === 'win32' ? orphan.toLowerCase() === value.toLowerCase() : orphan === value)) return;
    if (!locations.includes(value)) locations.push(value);
  };
  if (!restoring) add(orphan);
  const supplied = own(error, 'retainedPaths');
  const length = own(supplied, 'length');
  if (array(supplied) && Number.isSafeInteger(length)) for (let index = 0; index < Math.min(3, length); index++) add(own(supplied, String(index)));
  return locations.length ? `${restoring ? '另外保留的暂存位置' : '以下本机位置已保留，尚未确认可安全清理'}：\n${locations.join('\n')}` : '';
}

const MESSAGES = Object.freeze({
  WORKSPACE_REGISTRY_READ_FAILED: ['工作区配置读取失败', '无法读取或关闭工作区注册文件。请保留原文件，核查访问权限和系统诊断。'],
  WORKSPACE_REGISTRY_WRITE_FAILED: ['工作区配置未保存', '无法保存工作区选择。请检查应用数据目录权限和可用磁盘空间。'],
  WORKSPACE_CLEANUP_INCOMPLETE: ['工作区操作未完成', '部分暂存文件或新建目录未能安全清理。请保留现场，不要删除身份尚未确认的文件。'],
  WORKSPACE_REGISTRY_CHANGED: ['工作区配置已变化', '工作区注册文件在操作期间发生变化。应用没有继续覆盖它，请重新打开并核对工作区选择。'],
  WORKSPACE_REGISTRY_UNSAFE: ['工作区配置未通过检查', '工作区注册文件不是受支持的普通单链接文件，或超过容量限制。请保留原文件并检查应用数据目录。'],
  WORKSPACE_REGISTRY_INVALID: ['工作区配置格式无效', '工作区注册文件未通过格式检查。请保留原文件；重新选择文件夹不会修复该配置。'],
});

/** Return null for unrelated errors so existing operation-specific UI applies. */
export function describeWorkspaceFailure(error, { operation = 'switch', restartRequired = false } = {}) {
  if (!['switch', 'restore', 'startup'].includes(operation)) throw new TypeError('Invalid workspace error operation');
  const code = own(error, 'code'), diagnostic = diagnosticFor(error);
  const committed = code === 'WORKSPACE_REGISTRY_COMMIT_UNCERTAIN' || own(error, 'committed') === true || diagnostic?.committed === true;
  let title, message, guidance;
  if (committed) {
    title = '工作区保存结果待确认';
    message = '工作区配置已经提交，但未能确认最终保存结果。当前选择可能已经改变。';
    guidance = diagnostic?.stage === 'remove-installed-temporary'
      ? '首次登记后的暂存链接未能清理，重新启动不一定能解决此问题。请保留注册文件和暂存文件，不要自行删除；需要先核对文件身份与链接状态。'
      : '请在重新打开后核对工作区名称和路径。应用不会按“原选择未变”继续运行；若再次失败，请保留原配置并检查诊断信息。';
  } else if (typeof code === 'string' && Object.hasOwn(MESSAGES, code)) {
    [title, message] = MESSAGES[code];
    guidance = code === 'WORKSPACE_REGISTRY_WRITE_FAILED' ? '此次操作没有确认提交新的工作区选择。原任务和文件不会搬移。' : '';
  } else return null;
  const safeCode = code === 'WORKSPACE_REGISTRY_COMMIT_UNCERTAIN' || (typeof code === 'string' && Object.hasOwn(MESSAGES, code)) ? code : null;
  const restart = restartRequired ? '本地服务已停止，应用将尝试重新打开并读取磁盘上保存的选择。' : '';
  return { title, message, detail: [guidance, restart, retainedLocations(error, { restoring: operation === 'restore' }), safeCode ? `诊断代码：${safeCode}` : '', formatRegistryDiagnostic(error)].filter(Boolean).join('\n\n') };
}
