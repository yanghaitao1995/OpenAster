// SPDX-License-Identifier: Apache-2.0
import { cp, mkdir, lstat, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureMobileHtml } from './security.mjs';
import { readAndroidNoticeAsset } from './notice-assets.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
export async function prepareMobile() {
  // Validate public license assets before replacing an existing mobile output.
  const notices = await readAndroidNoticeAsset(path.join(directory, 'notices/android-notices.json'), path.join(directory, '../package.json'));
  const target = path.join(directory, 'www');
  if (path.dirname(target) !== directory || path.basename(target) !== 'www') throw new Error('Unsafe mobile output');
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Mobile output must not be a symbolic link');
    await rm(target, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(target, { recursive: true });
  await cp(path.join(directory, '..', 'public'), target, { recursive: true });
  await writeFile(path.join(target, 'android-notices.json'), notices, { flag: 'wx' });
  const index = path.join(target, 'index.html');
  await writeFile(index, secureMobileHtml(await readFile(index, 'utf8')));
  // An embedded local web app is shipped with the native bundle. Remote executable code is never loaded.
  const config = JSON.parse(await readFile(path.join(directory, 'capacitor.config.json'), 'utf8'));
  if (config.server.url || config.server.cleartext || config.server.allowNavigation?.length) throw new Error('Remote navigation and plaintext mobile transport are forbidden');
  const version = JSON.parse(await readFile(path.join(directory, '..', 'package.json'), 'utf8')).version;
  await writeFile(path.join(target, 'build-info.json'), `${JSON.stringify({ name: 'OpenAster', version, mode: 'companion' })}\n`);
  return target;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareMobile();
  console.log('Mobile assets prepared. Configure a trusted HTTPS gateway in the app.');
}
