// SPDX-License-Identifier: Apache-2.0
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { types } from 'node:util';
import { createBackup, restoreBackup } from '../server/backup.mjs';

const invalid = () => Object.assign(new Error('备份或恢复参数不符合要求。'), { code: 'INVALID_BACKUP_JOB', status: 400 });
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
function job(value) {
  const envelope = record(value, ['version', 'operation', 'args']);
  if (envelope.version !== 1 || !['backup', 'restore'].includes(envelope.operation)) throw invalid();
  const required = envelope.operation === 'backup' ? ['dataDir', 'output'] : ['input', 'dataDir'];
  const allowed = envelope.operation === 'backup' ? [...required, 'workspace', 'expectedWorkspaceIdentity', 'expectedDataIdentity', 'denySensitivePaths'] : required;
  const args = record(envelope.args, allowed, required);
  for (const key of ['dataDir', 'output', 'workspace', 'input']) if (has(args, key)) args[key] = absolute(args[key]);
  for (const key of ['expectedWorkspaceIdentity', 'expectedDataIdentity']) if (has(args, key)) args[key] = identity(args[key]);
  if (has(args, 'denySensitivePaths') && typeof args.denySensitivePaths !== 'boolean') throw invalid();
  return { operation: envelope.operation, args };
}
function errorInfo(error) {
  const get = key => error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined;
  const code = get('code'), message = get('message'), status = get('status'), orphanPath = get('orphanPath');
  const result = { code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : 'BACKUP_FAILED', message: typeof message === 'string' && message ? message.slice(0, 8192) : '备份或恢复失败。' };
  if (Number.isInteger(status) && status >= 100 && status <= 599) result.status = status;
  if (typeof orphanPath === 'string') { try { result.orphanPath = absolute(orphanPath); } catch { /* Omit malformed optional metadata. */ } }
  return result;
}

if (isMainThread || !parentPort) throw new Error('Backup worker must run in a worker thread.');
try {
  const { operation, args } = job(workerData);
  const result = await (operation === 'backup' ? createBackup(args) : restoreBackup(args));
  parentPort.postMessage({ version: 1, ok: true, result });
} catch (error) {
  parentPort.postMessage({ version: 1, ok: false, error: errorInfo(error) });
} finally {
  parentPort.close();
}
