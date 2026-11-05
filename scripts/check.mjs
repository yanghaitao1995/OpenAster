// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['node_modules', '.git', 'dist', 'release', '.openaster', '.toolchains', '.gradle-cache', '.diagnostics', 'www', 'android', 'ios', 'test-results', 'coverage']);
const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory() && !excluded.has(entry.name)) await collect(location);
    if (entry.isFile() && /\.(?:mjs|cjs|js|json)$/.test(entry.name)) files.push(location);
  }
}
await collect(root);
let checked = 0;
for (const file of files) {
  if (file.endsWith('.json')) { JSON.parse(await readFile(file, 'utf8')); continue; }
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  checked++;
}
console.log(`Syntax checked ${checked} JavaScript modules and all project JSON files.`);
