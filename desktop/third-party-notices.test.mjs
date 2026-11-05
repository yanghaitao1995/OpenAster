// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import afterPack, {
  ELECTRON_LICENSE_SHA256, THIRD_PARTY_NOTICES_FILENAME, renderThirdPartyNotices,
  validateElectronLicense, verifyThirdPartyNotices,
} from './third-party-notices.mjs';

const require = createRequire(import.meta.url);
const electronDirectory = path.dirname(require.resolve('electron/package.json'));
const electronLicense = await readFile(path.join(electronDirectory, 'LICENSE'));
const electronVersion = JSON.parse(await readFile(path.join(electronDirectory, 'package.json'), 'utf8')).version;
const chromiumFixture = '<!doctype html><html><head><title>Fixture credits</title></head><body>Fixture public notices</body></html>\n';
const context = directory => ({ electronPlatformName: 'win32', appOutDir: directory, packager: { info: { framework: { version: electronVersion } } } });

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openaster-public-notices-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'LICENSE.electron.txt'), electronLicense);
  await writeFile(path.join(directory, 'LICENSES.chromium.html'), chromiumFixture);
  return directory;
}

test('Public Electron notice has pinned provenance and round-trips through escaped static HTML', () => {
  const license = validateElectronLicense(electronLicense, electronVersion);
  assert.equal(license.sha256, ELECTRON_LICENSE_SHA256);
  const html = renderThirdPartyNotices(electronLicense, electronVersion);
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.match(html, /href="LICENSES\.chromium\.html"/);
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script\b|<form\b|(?:src|href)="(?:https?:|\/\/)/i);
  const pre = html.match(/<pre>([\s\S]*?)<\/pre>/)[1];
  assert.match(pre, /&quot;Software&quot;/);
  const decoded = pre.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  })[entity]);
  assert.equal(decoded, electronLicense.toString('utf8'));
});

test('Public Electron notice rejects protected, changed, invalid and unreviewed inputs', () => {
  assert.throws(() => validateElectronLicense(Buffer.from('%TSD-Header-###%data'), electronVersion), /readable public text/);
  assert.throws(() => validateElectronLicense(Buffer.from([0xff]), electronVersion), /encoded data/);
  assert.throws(() => validateElectronLicense(Buffer.from('MIT License'), electronVersion), /pinned public upstream/);
  assert.throws(() => renderThirdPartyNotices(Buffer.from('<script>alert(1)</script>'), electronVersion), /pinned public upstream/);
  assert.throws(() => validateElectronLicense(electronLicense, '45.0.1'), /Revalidate/);
});

test('Windows afterPack adds one static page and leaves both upstream files intact', async t => {
  const directory = await fixture(t);
  await afterPack(context(directory));
  assert.deepEqual((await readdir(directory)).sort(), ['LICENSE.electron.txt', 'LICENSES.chromium.html', THIRD_PARTY_NOTICES_FILENAME].sort());
  assert.deepEqual(await readFile(path.join(directory, 'LICENSE.electron.txt')), electronLicense);
  assert.equal(await readFile(path.join(directory, 'LICENSES.chromium.html'), 'utf8'), chromiumFixture);
  const verified = await verifyThirdPartyNotices(directory);
  assert.equal(verified.expectedElectronSha256, ELECTRON_LICENSE_SHA256);
  assert.equal(verified.noticeHtmlSha256, createHash('sha256').update(renderThirdPartyNotices(electronLicense, electronVersion)).digest('hex'));
  assert.equal(verified.chromiumSha256, createHash('sha256').update(chromiumFixture).digest('hex'));
  await assert.rejects(afterPack(context(directory)), { code: 'EEXIST' });
  await writeFile(path.join(directory, THIRD_PARTY_NOTICES_FILENAME), '<!doctype html>altered');
  await assert.rejects(verifyThirdPartyNotices(directory), /differs from its expected/);
});

test('Windows afterPack rejects mismatched runtime versions and protected Chromium text before writing', async t => {
  const directory = await fixture(t);
  const wrongVersion = context(directory);
  wrongVersion.packager.info.framework.version = '45.0.1';
  await assert.rejects(afterPack(wrongVersion), /runtime version differs/);
  await writeFile(path.join(directory, 'LICENSES.chromium.html'), '%TSD-Header-###%data');
  await assert.rejects(afterPack(context(directory)), /readable HTML/);
  assert.ok(!(await readdir(directory)).includes(THIRD_PARTY_NOTICES_FILENAME));
});

test('Notice generation rejects symbolic output directories and never overwrites existing targets', async t => {
  const directory = await fixture(t);
  const alias = `${directory}-link`;
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(alias, { force: true, recursive: true }));
  await assert.rejects(afterPack(context(alias)), /real directory/);
  const target = path.join(directory, THIRD_PARTY_NOTICES_FILENAME);
  await writeFile(target, 'existing file');
  await assert.rejects(afterPack(context(directory)), { code: 'EEXIST' });
  assert.equal(await readFile(target, 'utf8'), 'existing file');
});

test('Other desktop platforms remain untouched', async () => {
  await afterPack({ electronPlatformName: 'darwin' });
  await afterPack({ electronPlatformName: 'linux' });
});
