// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const electronPackagePath = require.resolve('electron/package.json');
const electronDirectory = path.dirname(electronPackagePath);
export const THIRD_PARTY_NOTICES_FILENAME = 'THIRD-PARTY-NOTICES.html';
export const ELECTRON_LICENSE_SHA256 = '5154e165bd6c2cc0cfbcd8916498c7abab0497923bafcd5cb07673fe8480087d';
const supportedElectronVersion = '45.0.0';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Public upstream source: https://github.com/electron/electron/blob/v45.0.0/LICENSE
// The exact UTF-8 source (including its final LF) is pinned, not a generic MIT template.
export function validateElectronLicense(bytes, electronVersion) {
  if (electronVersion !== supportedElectronVersion) {
    throw new Error(`Revalidate Electron's public license for version ${electronVersion}`);
  }
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Electron license must be UTF-8 bytes');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.startsWith('%TSD-Header-') || text.includes('\0')) {
    throw new Error('Electron license must be readable public text');
  }
  const digest = sha256(bytes);
  if (digest !== ELECTRON_LICENSE_SHA256) {
    throw new Error('Electron license differs from the pinned public upstream text');
  }
  return { electronVersion, text, sha256: digest };
}

const escapeHtml = text => text.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

/** Render only validated, public license text; no scripts, forms, or network resources. */
export function renderThirdPartyNotices(bytes, electronVersion) {
  const license = validateElectronLicense(bytes, electronVersion);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">
<title>OpenAster third-party notices</title>
</head>
<body>
<h1>OpenAster third-party notices</h1>
<p>The desktop runtime includes Electron ${escapeHtml(license.electronVersion)} and its third-party components. They retain their own licenses.</p>
<h2>Electron — MIT License</h2>
<pre>${escapeHtml(license.text)}</pre>
<h2>Chromium and bundled third-party notices</h2>
<p><a href="LICENSES.chromium.html">Read the complete notices supplied with this Electron runtime.</a></p>
<p>This page preserves the Electron notice and links to the bundled notice document. It is not a complete software bill of materials.</p>
</body>
</html>
`;
}

async function checkedOutputDirectory(appOutDir) {
  if (typeof appOutDir !== 'string' || !path.isAbsolute(appOutDir)) {
    throw new Error('The packaged app output directory must be absolute');
  }
  const directory = path.resolve(appOutDir);
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The packaged app output must be a real directory');
  const resolved = await realpath(directory);
  const samePath = process.platform === 'win32'
    ? resolved.toLowerCase() === directory.toLowerCase()
    : resolved === directory;
  if (!samePath) throw new Error('The packaged app output must not traverse a symbolic link');
  return directory;
}

async function readRegularFile(filename) {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Notice must be a regular file: ${path.basename(filename)}`);
  return readFile(filename);
}

async function noticeInputs(appOutDir) {
  const directory = await checkedOutputDirectory(appOutDir);
  const installedElectron = JSON.parse(await readFile(electronPackagePath, 'utf8'));
  const upstream = await readRegularFile(path.join(electronDirectory, 'LICENSE'));
  validateElectronLicense(upstream, installedElectron.version);
  const electron = await readRegularFile(path.join(directory, 'LICENSE.electron.txt'));
  validateElectronLicense(electron, installedElectron.version);
  if (!electron.equals(upstream)) throw new Error('Packaged Electron license differs from the installed public license');
  const chromium = await readRegularFile(path.join(directory, 'LICENSES.chromium.html'));
  const chromiumText = new TextDecoder('utf-8', { fatal: true }).decode(chromium);
  if (!/^\s*(?:<!--[\s\S]*?-->\s*)?<!doctype html>/i.test(chromiumText)) {
    throw new Error('Chromium notices must be a readable HTML document');
  }
  return { directory, electron, chromium, electronVersion: installedElectron.version };
}

/** Verify the generated directory artifact; installer payload bytes require a separate check. */
export async function verifyThirdPartyNotices(appOutDir) {
  const input = await noticeInputs(appOutDir);
  const actual = await readRegularFile(path.join(input.directory, THIRD_PARTY_NOTICES_FILENAME));
  const expected = Buffer.from(renderThirdPartyNotices(input.electron, input.electronVersion), 'utf8');
  if (!actual.equals(expected)) throw new Error('Packaged third-party notice page differs from its expected public text');
  return {
    electronVersion: input.electronVersion,
    expectedElectronSha256: ELECTRON_LICENSE_SHA256,
    noticeHtmlSha256: sha256(actual),
    chromiumSha256: sha256(input.chromium),
    noticeHtmlBytes: actual.length,
    chromiumBytes: input.chromium.length,
  };
}

/** Add a public notice page before signing and archive creation, preserving upstream files. */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const input = await noticeInputs(context.appOutDir);
  if (context.packager?.info?.framework?.version !== input.electronVersion) {
    throw new Error('The packaged Electron runtime version differs from the verified installed version');
  }
  const destination = path.join(input.directory, THIRD_PARTY_NOTICES_FILENAME);
  // Exclusive creation never overwrites an existing file or follows a destination symlink.
  await writeFile(destination, renderThirdPartyNotices(input.electron, input.electronVersion), { encoding: 'utf8', flag: 'wx' });
  await verifyThirdPartyNotices(input.directory);
}
