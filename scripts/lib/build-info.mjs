// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Hash the shared UI inputs before any platform-specific HTML transformation. */
export async function sharedBuildInfo(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const directory = path.join(root, 'public');
  const files = [];
  async function visit(relative = '') {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      const file = relative ? relative + '/' + name : name;
      if (file === 'build-info.json') continue;
      const full = path.join(directory, file), stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error('Linked shared asset');
      if (stat.isDirectory()) await visit(file);
      else if (stat.isFile()) files.push({ file, sha256: createHash('sha256').update(await readFile(full)).digest('hex') });
      else throw new Error('Nonregular shared asset');
    }
  }
  await visit();
  return { schemaVersion: 1, name: 'OpenAster', version: pkg.version,
    sharedAssetsSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), sharedAssets: files.length };
}
