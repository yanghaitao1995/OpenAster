// SPDX-License-Identifier: Apache-2.0
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMobile } from './prepare.mjs';
import { hardenAndroidProject } from './harden-android.mjs';
import { readAndroidVersion } from './android-version.mjs';
import { synchronizeAndroidAppearance } from './android-appearance.mjs';
import { synchronizeIOSBranding } from './ios-branding.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const platform = process.argv[2];
if (!['android', 'ios'].includes(platform)) throw new Error('Usage: node mobile/native.mjs android|ios [--open]');
if (platform === 'ios' && process.platform !== 'darwin') throw new Error('Native iOS generation requires macOS and Xcode. Mobile web assets can be prepared on any platform.');
// Reject missing/invalid configuration and known downgrades before prepare/sync writes.
const androidVersion = platform === 'android' ? await readAndroidVersion() : null;
await prepareMobile();
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@capacitor/cli/package.json')), 'bin', 'capacitor');
async function run(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: directory, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Capacitor ${args[0]} failed (${code})`)));
  });
}
let exists = true;
try { await access(path.join(directory, platform)); } catch { exists = false; }
if (!exists) await run(['add', platform]);
await run(['sync', platform]);
if (platform === 'android') {
  const current = await readAndroidVersion();
  if (JSON.stringify(current.sourceInputs) !== JSON.stringify(androidVersion.sourceInputs)
    || JSON.stringify(current.previousBuild) !== JSON.stringify(androidVersion.previousBuild)) throw new Error('Android version inputs changed during synchronization');
  await hardenAndroidProject({ projectDirectory: path.join(directory, 'android'), version: current.versionName, versionCode: current.versionCode });
  await synchronizeAndroidAppearance(path.join(directory, 'android'));
} else {
  await synchronizeIOSBranding(path.join(directory, 'ios'));
}
if (process.argv.includes('--open')) await run(['open', platform]);
console.log(`${platform} project is ready. Compile and sign it using the platform SDK; generation is not an installation test.`);
