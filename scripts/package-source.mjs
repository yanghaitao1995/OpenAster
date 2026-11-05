// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReleaseFiles, loadReleasePolicy } from './lib/release-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const target = path.resolve(root, process.argv[2] || `release/source-${pkg.version}`);
const release = path.join(root, 'release');
if (!target.startsWith(release + path.sep)) throw new Error('Source output must be a new directory under release/');
try { if ((await lstat(release)).isSymbolicLink()) throw new Error('Linked release directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(release, { recursive: true });
// Do not overwrite an existing export or traverse an unreviewed nested parent.
if (path.dirname(target) !== release) throw new Error('Choose a direct child of release/');
const files = await collectReleaseFiles(root, await loadReleasePolicy(root));
await mkdir(target);
const manifest = [];
for (const file of files) {
  const bytes = await readFile(path.join(root, file));
  if (bytes.subarray(0, 128).includes(Buffer.from('%TSD-Header-'))) throw new Error(`Wrapped input requires an authorized export: ${file}`);
  const destination = path.join(target, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx' });
  const copied = await readFile(destination);
  if (!bytes.equals(copied)) throw new Error(`Source changed during export: ${file}`);
  manifest.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(path.join(target, 'SOURCE-MANIFEST.json'), JSON.stringify({ schemaVersion: 1, name: pkg.name, version: pkg.version, files: manifest }, null, 2) + '\n', { flag: 'wx' });
console.log(`Prepared ${files.length} source files for OpenAster ${pkg.version}. Verify the export with an independent ordinary file reader before publishing.`);
