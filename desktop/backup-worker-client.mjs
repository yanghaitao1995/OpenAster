// SPDX-License-Identifier: Apache-2.0
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { types } from 'node:util';

const workerModule = new URL('./backup-worker.mjs', import.meta.url);
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const invalid = () => fail('INVALID_BACKUP_JOB', '备份或恢复参数不符合要求。', { status: 400 });
const has = (value, key) => Object.hasOwn(value, key);

function record(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || !allowed.includes(key)) || required.some(key => !has(descriptors, key))) throw invalid();
  const output = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!has(descriptor, 'value') || !descriptor.enumerable) throw invalid();
    output[key] = descriptor.value;
  }
  return output;
}
function absolute(value) {
  if (typeof value !== 'string' || !value || value.length > 32768 || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value) || !path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw invalid();
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(':'))) throw invalid();
  return value;
}
function identity(value) {
  const result = record(value, ['canonical', 'dev', 'ino']);
  absolute(result.canonical);
  if (typeof result.dev !== 'string' || !/^(?:0|[1-9][0-9]{0,39})$/.test(result.dev) || typeof result.ino !== 'string' || !/^[1-9][0-9]{0,39}$/.test(result.ino)) throw invalid();
  return result;
}
function job(operation, args) {
  if (!['backup', 'restore'].includes(operation)) throw invalid();
  const required = operation === 'backup' ? ['dataDir', 'output'] : ['input', 'dataDir'];
  const allowed = operation === 'backup' ? [...required, 'workspace', 'expectedWorkspaceIdentity', 'expectedDataIdentity', 'denySensitivePaths'] : required;
  const result = record(args, allowed, required);
  for (const key of ['dataDir', 'output', 'workspace', 'input']) if (has(result, key)) result[key] = absolute(result[key]);
  for (const key of ['expectedWorkspaceIdentity', 'expectedDataIdentity']) if (has(result, key)) result[key] = identity(result[key]);
  if (has(result, 'denySensitivePaths') && typeof result.denySensitivePaths !== 'boolean') throw invalid();
  return { version: 1, operation, args: result };
}

function reply(value, operation) {
  const envelope = record(value, ['version', 'ok', 'result', 'error'], ['version', 'ok']);
  if (envelope.version !== 1 || typeof envelope.ok !== 'boolean') throw invalid();
  if (!envelope.ok) {
    if (has(envelope, 'result') || !has(envelope, 'error')) throw invalid();
    const error = record(envelope.error, ['code', 'message', 'status', 'orphanPath'], ['code', 'message']);
    if (typeof error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) || typeof error.message !== 'string' || !error.message || error.message.length > 8192) throw invalid();
    if (has(error, 'status') && (!Number.isInteger(error.status) || error.status < 100 || error.status > 599)) throw invalid();
    if (has(error, 'orphanPath')) absolute(error.orphanPath);
    return { error: fail(error.code, error.message, Object.fromEntries(['status', 'orphanPath'].filter(key => has(error, key)).map(key => [key, error[key]]))) };
  }
  if (has(envelope, 'error') || !has(envelope, 'result')) throw invalid();
  const common = ['path', 'sessions', 'runHistory', 'toolArtifacts', 'summaryJobs', 'steeringInputs', 'audit', 'workspaceEntries'];
  const fields = operation === 'backup' ? [...common, 'sha256', 'payloadSha256', 'bytes'] : [...common, 'disabledProviders'];
  const result = record(envelope.result, fields);
  absolute(result.path);
  for (const [key, item] of Object.entries(result)) {
    if (key === 'path') continue;
    if (key === 'sha256' || key === 'payloadSha256') { if (typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)) throw invalid(); }
    else if (!Number.isSafeInteger(item) || item < 0) throw invalid();
  }
  return { result };
}

/** Resolves only after the fixed worker has finished and exited normally. No cancellation interrupts disk writes. */
export async function runBackupJob(operation, args) {
  const workerData = job(operation, args);
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(workerModule, { workerData, execArgv: [], name: `openaster-${operation}` }); }
    catch { reject(fail('BACKUP_WORKER_START', '无法启动备份工作线程。')); return; }
    let received = false, result, failure, settled = false;
    const protocolFailure = () => { failure ??= fail('BACKUP_WORKER_PROTOCOL', '备份工作线程返回了无法验证的结果。'); };
    const onMessage = value => {
      if (received) { protocolFailure(); return; }
      received = true;
      try { const response = reply(value, operation); result = response.result; failure ??= response.error; }
      catch { protocolFailure(); }
    };
    const onError = error => {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : 'BACKUP_WORKER_ERROR';
      failure ??= fail(code, '备份工作线程异常结束，操作结果未确认。');
    };
    const onExit = exitCode => {
      if (settled) return;
      settled = true;
      worker.off('message', onMessage); worker.off('messageerror', protocolFailure); worker.off('error', onError); worker.off('exit', onExit);
      if (exitCode !== 0) failure ??= fail('BACKUP_WORKER_EXIT', '备份工作线程未正常退出，操作结果未确认。');
      if (failure && exitCode !== 0) failure.exitCode = exitCode;
      if (!received && !failure) protocolFailure();
      if (failure) reject(failure); else resolve(result);
    };
    worker.on('message', onMessage); worker.on('messageerror', protocolFailure); worker.on('error', onError); worker.once('exit', onExit);
  });
}
