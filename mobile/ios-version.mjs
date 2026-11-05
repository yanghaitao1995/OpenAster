// SPDX-License-Identifier: Apache-2.0
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

export function updateIOSVersion(source, { version, buildNumber }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Number.isSafeInteger(buildNumber) || buildNumber < 1) throw new Error('Invalid iOS version');
  const marketing = [...source.matchAll(/\bMARKETING_VERSION\s*=\s*([\d.]+)\s*;/g)];
  const builds = [...source.matchAll(/\bCURRENT_PROJECT_VERSION\s*=\s*(\d+)\s*;/g)];
  if (marketing.length !== 2 || builds.length !== 2) throw new Error('Review custom iOS build configurations before changing versions');
  if (builds.some(match => Number(match[1]) > buildNumber)) throw new Error('iOS build number cannot decrease');
  return source.replace(/(\bMARKETING_VERSION\s*=\s*)[\d.]+(\s*;)/g, (_, before, after) => before + version + after)
    .replace(/(\bCURRENT_PROJECT_VERSION\s*=\s*)\d+(\s*;)/g, (_, before, after) => before + buildNumber + after);
}

export async function synchronizeIOSVersion(projectDirectory, version) {
  const root = path.resolve(projectDirectory);
  if (!path.isAbsolute(projectDirectory) || root === path.parse(root).root) throw new Error('Invalid iOS project directory');
  const file = path.join(root, 'App', 'App.xcodeproj', 'project.pbxproj');
  for (const directory of [root, path.join(root, 'App'), path.dirname(file)]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked iOS project directory');
  }
  const named = await lstat(file);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1) throw new Error('Invalid iOS project file');
  const handle = await open(file, 'r+');
  try {
    const opened = await handle.stat();
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== 1 || opened.size > 2 * 1024 * 1024) throw new Error('iOS project changed');
    const original = await handle.readFile('utf8');
    const updated = updateIOSVersion(original, version);
    if (updated !== original) {
      const bytes = Buffer.from(updated);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesWritten) throw new Error('iOS version write was incomplete');
        offset += result.bytesWritten;
      }
      await handle.truncate(bytes.length);
      await handle.sync();
    }
  } finally { await handle.close(); }
}
