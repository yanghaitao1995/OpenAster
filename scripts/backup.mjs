#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { createBackup, restoreBackup } from '../server/backup.mjs';

const help = `OpenAster 本地离线备份 / 恢复（Node.js 24+）

  node scripts/backup.mjs backup --data-dir ABS --output ABS [--workspace ABS]
  node scripts/backup.mjs restore --input ABS --data-dir ABS
  node scripts/backup.mjs --help

请先关闭使用源数据目录的所有 OpenAster 实例。默认工作区为数据目录下的 workspace。
输出文件必须不存在，恢复目标必须为不存在的新目录；父目录须已存在。
只支持普通 UTF-8 文本和目录，遇链接、二进制、凭据文件或超限内容时整体拒绝。
备份为可能包含敏感会话/文件内容的明文 JSON。密钥、环境变量绑定和凭据库不备份。
恢复不会调用模型：外部模型连接停用，活动任务取消，历史待审核写入全部拒绝。
完整格式、限制和使用说明：docs/BACKUP.md
`;
function parse(args) {
  if (!args.length || args.includes('--help')) return null;
  const [command, ...rest] = args;
  if (!['backup', 'restore'].includes(command)) throw new Error('命令须为 backup 或 restore。');
  const allowed = command === 'backup' ? ['--data-dir', '--output', '--workspace'] : ['--input', '--data-dir'];
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index], value = rest[index + 1];
    if (!allowed.includes(name) || Object.hasOwn(options, name) || !value || value.startsWith('--')) throw new Error('参数无效、重复或缺少值。使用 --help 查看用法。');
    options[name] = value;
  }
  for (const name of command === 'backup' ? ['--data-dir', '--output'] : ['--input', '--data-dir']) if (!options[name]) throw new Error(`缺少 ${name}。`);
  return { command, options };
}
try {
  const parsed = parse(process.argv.slice(2));
  if (!parsed) process.stdout.write(help);
  else {
    const o = parsed.options;
    const result = parsed.command === 'backup'
      ? await createBackup({ dataDir: o['--data-dir'], output: o['--output'], ...(o['--workspace'] ? { workspace: o['--workspace'] } : {}) })
      : await restoreBackup({ input: o['--input'], dataDir: o['--data-dir'] });
    process.stdout.write(JSON.stringify({ ok: true, command: parsed.command, ...result }, null, 2) + '\n');
  }
} catch (error) {
  // Do not expose SQLite/parser contents or native stack traces containing user data.
  const known = ['INVALID_BACKUP', 'BACKUP_LIMIT', 'BACKUP_EXISTS', 'RESTORE_EXISTS', 'UNSAFE_BACKUP_PATH', 'SOURCE_CHANGED', 'UNSUPPORTED_BACKUP_FILE', 'BACKUP_HASH_MISMATCH', 'BACKUP_CLEANUP_INCOMPLETE', 'RESTORE_CLEANUP_INCOMPLETE', 'DATA_LOCKED', 'INVALID_PATH', 'INVALID_PROVIDER', 'INVALID_PROVIDER_URL', 'INVALID_MODEL', 'INVALID_API_KEY'];
  const message = known.includes(error.code) || !error.code && /^(?:命令须|参数无效|缺少 )/.test(error.message) ? error.message : '备份/恢复失败。请检查路径、源数据完整性和权限；现有目标不会被覆盖。';
  process.stderr.write(`${error.code ?? 'BACKUP_FAILED'}: ${message}\n`);
  process.exitCode = 1;
}
