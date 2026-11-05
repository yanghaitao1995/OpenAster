// SPDX-License-Identifier: Apache-2.0
import { cp, mkdir, readFile, readdir, writeFile, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMobile } from '../mobile/prepare.mjs';
import { collectReleaseFiles, loadReleasePolicy } from './lib/release-files.mjs';
import { sharedBuildInfo } from './lib/build-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('Unsafe build target');
try {
  if ((await lstat(output)).isSymbolicLink()) throw new Error('Build output must not be a symbolic link');
  // The resolved absolute target is exactly <project>/dist, never a computed parent directory.
  await rm(output, { recursive: true, force: true });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
// Use the same reviewed input list as source exports; never recursively copy arbitrary local files.
const policy = await loadReleasePolicy(root);
const sourceFiles = await collectReleaseFiles(root, policy);
for (const entry of sourceFiles.filter(file => !file.endsWith('.test.mjs') && (
  /^(?:core|server|public|desktop|skills)\//.test(file)
  || ['LICENSE', 'NOTICE', 'README.md'].includes(file)
  || policy.documents.includes(file) || file.startsWith(policy.mediaDirectory + '/')))) {
  await mkdir(path.dirname(path.join(output, entry)), { recursive: true });
  await cp(path.join(root, entry), path.join(output, entry));
}
const buildInfo = await sharedBuildInfo(root);
await writeFile(path.join(output, 'public/build-info.json'), JSON.stringify({ ...buildInfo, mode: 'desktop-web' }) + '\n');
// Ship the offline data utility explicitly; never include development/test helpers.
await mkdir(path.join(output, 'scripts'));
await cp(path.join(root, 'scripts', 'backup.mjs'), path.join(output, 'scripts', 'backup.mjs'));
const distributedPackage = {
  name: packageInfo.name, version: packageInfo.version, description: packageInfo.description, author: packageInfo.author,
  type: 'module', license: packageInfo.license, engines: packageInfo.engines,
  main: 'desktop/main.mjs', scripts: { start: 'node server/index.mjs', backup: 'node scripts/backup.mjs' },
};
await writeFile(path.join(output, 'package.json'), `${JSON.stringify(distributedPackage, null, 2)}\n`);
const manifest = [];
async function inspect(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const location = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Build output cannot contain symlinks');
    if (entry.isDirectory()) await inspect(location);
    else if (entry.name !== 'checksums.sha256') manifest.push(`${createHash('sha256').update(await readFile(location)).digest('hex')}  ${path.relative(output, location).split(path.sep).join('/')}`);
  }
}
await inspect(output);
await writeFile(path.join(output, 'checksums.sha256'), `${manifest.join('\n')}\n`);
await prepareMobile();
const mobileInfo = JSON.parse(await readFile(path.join(root, 'mobile/www/build-info.json'), 'utf8'));
if (mobileInfo.version !== buildInfo.version || mobileInfo.sharedAssetsSha256 !== buildInfo.sharedAssetsSha256) throw new Error('Shared UI changed during platform preparation; rebuild from stable sources');
console.log(`Built OpenAster ${packageInfo.version}: ${manifest.length} verified files in dist/; companion assets in mobile/www/.`);
