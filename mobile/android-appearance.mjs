// SPDX-License-Identifier: Apache-2.0
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const java = 'app/src/main/java/org/openaster/preview/';
const templateTargets = [
  ['MainActivity.java', java + 'MainActivity.java'],
  ['AppearanceTheme.java', java + 'AppearanceTheme.java'],
  ['AppearanceController.java', java + 'AppearanceController.java'],
  ['OpenAsterAppearance.java', java + 'OpenAsterAppearance.java'],
  ['openaster_appearance.xml', 'app/src/main/res/values/openaster_appearance.xml'],
];
const originalMain = 'package org.openaster.preview;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n';
const normalized = source => source.replaceAll('\r\n', '\n').trim();

async function targetPath(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Android appearance target must not contain symbolic links');
    if (current !== path.join(root, relative) && !stat.isDirectory()) throw new Error('Android appearance parent must be a directory');
    if (current === path.join(root, relative) && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Android appearance target must be a regular single-link file');
  }
  return current;
}

/** Sync our reviewed, color-only native bridge; never overwrite unknown native code. */
export async function synchronizeAndroidAppearance(projectDirectory) {
  const root = path.resolve(projectDirectory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) throw new Error('Android appearance project must be a canonical directory');
  const planned = [];
  for (const [template, relative] of templateTargets) {
    const content = await readFile(path.join(directory, 'android-appearance', template), 'utf8');
    const target = await targetPath(root, relative);
    let previous = null;
    try { previous = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous === null && template === 'MainActivity.java') throw new Error('Expected the generated MainActivity before appearance synchronization');
    if (previous !== null && normalized(previous) !== normalized(content)
      && !(template === 'MainActivity.java' && normalized(previous) === normalized(originalMain))) {
      throw new Error(`Unknown Android ${template} template; review before overwriting`);
    }
    planned.push({ target, relative, content, previous });
  }
  // Validate the entire set before creating directories or writing any file.
  for (const item of planned) {
    if (item.previous === item.content) continue;
    await targetPath(root, item.relative);
    await mkdir(path.dirname(item.target), { recursive: true });
    await targetPath(root, item.relative);
    const handle = await open(item.target, item.previous === null ? 'wx' : 'r+');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Android appearance target changed before synchronization');
      if (item.previous !== null && await handle.readFile('utf8') !== item.previous) throw new Error('Android appearance target changed before synchronization');
      const buffer = Buffer.from(item.content);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
        if (bytesWritten === 0) throw new Error('Android appearance write made no progress');
        offset += bytesWritten;
      }
      await handle.truncate(buffer.length);
    } finally { await handle.close(); }
  }
  return { plugin: 'OpenAsterAppearance', method: 'setTheme', themes: ['light', 'dark'], files: planned.map(item => item.relative) };
}
