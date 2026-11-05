// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { CoreError } from './errors.mjs';
import { validateRelativePath } from './workspace.mjs';

// Syntax only. A syntactically valid absolute path does not grant access.
export function validateOperationPath(value, { empty = false } = {}) {
  if (empty && value === '') return '';
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 4096 || /[\0-\x1f\x7f]/u.test(value)) throw new CoreError('INVALID_PATH', '文件路径无效。');
  if (!path.isAbsolute(value)) return validateRelativePath(value);
  if (value.split(/[\\/]/u).includes('..')) throw new CoreError('INVALID_PATH', '绝对路径不能包含上级目录跳转。');
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/u.test(value) || /[:<>"|?*]/u.test(value.slice(2))) throw new CoreError('INVALID_PATH', '仅支持本机磁盘上的普通绝对路径。');
    const parts = value.slice(3).split(/[\\/]/u).filter(Boolean);
    if (parts.some(part => /[ .]$/u.test(part) || /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part))) throw new CoreError('INVALID_PATH', '路径包含系统保留名称。');
  }
  return path.resolve(value);
}

export function pathWithin(parent, child) {
  const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(key(parent), key(child));
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
