// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { CoreError } from './errors.mjs';
import { validateOperationPath } from './access-path.mjs';

export const COMMAND_LIMITS = Object.freeze({ characters: 8000, bytes: 32768, defaultTimeoutMs: 30000, minTimeoutMs: 1000, maxTimeoutMs: 120000, outputBytes: 256 * 1024 });
const invalid = () => new CoreError('INVALID_COMMAND', '命令、工作目录或执行期限格式无效。');
function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(descriptors[key] ?? {}, 'value'))) throw invalid();
  return Object.fromEntries(names.map(key => [key, descriptors[key].value]));
}
function metadata(value) {
  if (!['powershell', 'sh'].includes(value.shell) || typeof value.cwd !== 'string'
    || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < COMMAND_LIMITS.minTimeoutMs || value.timeoutMs > COMMAND_LIMITS.maxTimeoutMs) throw invalid();
  if (value.cwd) validateOperationPath(value.cwd);
  return value;
}
export function validateCommand(value) {
  const result = metadata(fields(value, ['command', 'cwd', 'shell', 'timeoutMs']));
  if (typeof result.command !== 'string' || !result.command.trim() || !result.command.isWellFormed() || result.command.includes('\0')
    || result.command.length > COMMAND_LIMITS.characters || Buffer.byteLength(result.command) > COMMAND_LIMITS.bytes) throw invalid();
  return result;
}
export function validateCommandHistory(value) {
  const result = metadata(fields(value, ['sha256', 'cwd', 'shell', 'timeoutMs']));
  if (typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(result.sha256)) throw invalid();
  return result;
}
export function commandHistory(value) {
  const command = validateCommand(value);
  return { sha256: createHash('sha256').update(command.command, 'utf8').digest('hex'), cwd: command.cwd, shell: command.shell, timeoutMs: command.timeoutMs };
}
