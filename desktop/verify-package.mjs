// SPDX-License-Identifier: Apache-2.0
// Read-only release verification. This script never executes an installer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyThirdPartyNotices } from './third-party-notices.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const packagingRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const asar = packagingRequire('@electron/asar');
const resedit = packagingRequire('resedit');
const { getCurrentFuseWire, FuseV1Options } = packagingRequire('@electron/fuses');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Only the reviewed built-in skill assets belong in a distributable archive.
// Custom project skills, private resources and arbitrary files are not allowed.
export const BUNDLED_SKILL_FILES = Object.freeze([
  'skills/README.md',
  'skills/general/SKILL.md',
  'skills/research/SKILL.md',
  'skills/writing/SKILL.md',
  'skills/code/SKILL.md',
  'skills/planning/SKILL.md',
  'skills/translation/SKILL.md',
  'skills/code/references/verification.md',
]);

export async function verifyBundledSkillResource(relative, bytes) {
  assert.ok(BUNDLED_SKILL_FILES.includes(relative), 'Unexpected bundled skill resource ' + relative);
  assert.equal(sha256(await readFile(path.join(root, relative))), sha256(bytes), 'Bundled skill differs from source ' + relative);
}


export async function verifyWindowsPackage(executable) {
  const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(path.join(root, 'desktop/electron-builder.json'), 'utf8'));
  const binary = await readFile(executable);
  const resources = resedit.NtExecutableResource.from(resedit.NtExecutable.from(binary));
  const info = resedit.Resource.VersionInfo.fromEntries(resources.entries)[0];
  assert.ok(info, 'Windows version resource is missing');
  const metadata = info.getStringValues(info.getAllLanguagesForStringValues()[0]);
  assert.equal(metadata.ProductName, config.productName);
  assert.equal(metadata.FileDescription, config.productName);
  assert.equal(metadata.FileVersion, packageInfo.version);
  assert.equal(metadata.ProductVersion, `${packageInfo.version}.0`);
  assert.equal(metadata.InternalName, 'electron.exe', 'Windows runtime identity must be preserved');
  assert.equal(metadata.OriginalFilename, 'electron.exe', 'Windows runtime identity must be preserved');
  const iconGroups = resedit.Resource.IconGroupEntry.fromEntries(resources.entries);
  assert.ok(iconGroups.length, 'Windows app icon is missing');
  const expectedIcon = resedit.Data.IconFile.from(await readFile(path.join(root, 'desktop/resources/icon.ico')));
  const iconHash = item => sha256(Buffer.from(item.isRaw() ? item.bin : item.generate()));
  assert.deepEqual(iconGroups[0].getIconItemsFromEntries(resources.entries).map(iconHash), expectedIcon.icons.map(item => iconHash(item.data)), 'Windows executable icon differs from source');

  const fuseWire = await getCurrentFuseWire(executable);
  assert.equal(fuseWire.version, '1');
  const checkedFuses = {};
  for (const [name, enabled] of Object.entries(config.electronFuses)) {
    const enumName = name[0].toUpperCase() + name.slice(1);
    assert.ok(Object.hasOwn(FuseV1Options, enumName), `Unsupported fuse ${name}`);
    assert.equal(fuseWire[FuseV1Options[enumName]], enabled ? 49 : 48, `Unexpected fuse ${name}`);
    checkedFuses[name] = enabled;
  }

  const archivePath = path.join(path.dirname(executable), 'resources', 'app.asar');
  const raw = asar.getRawHeader(archivePath);
  const integrityResource = resources.entries.find(entry => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR');
  assert.ok(integrityResource, 'Embedded ASAR integrity resource is missing');
  const integrity = JSON.parse(Buffer.from(integrityResource.bin).toString('utf8'));
  assert.equal(integrity.length, 1);
  assert.equal(integrity[0].file.replaceAll('\\', '/'), 'resources/app.asar');
  assert.equal(integrity[0].alg, 'SHA256');
  const headerSha256 = sha256(raw.headerString);
  assert.equal(integrity[0].value, headerSha256, 'ASAR header does not match executable resource');

  let files = 0;
  let sourceMatches = 0;
  let totalBytes = 0;
  const packagedFiles = new Set();
  async function inspect(entries, prefix = '') {
    for (const [name, entry] of Object.entries(entries)) {
      assert.ok(!name.includes('/') && !name.includes('\\') && name !== '..' && name !== '.', 'Unsafe ASAR entry');
      const relative = prefix ? `${prefix}/${name}` : name;
      if (entry.files) { await inspect(entry.files, relative); continue; }
      assert.ok(!entry.link && !entry.unpacked, `Unexpected external ASAR entry ${relative}`);
      assert.equal(entry.integrity?.algorithm, 'SHA256', `Missing file integrity ${relative}`);
      const bytes = asar.extractFile(archivePath, path.normalize(relative));
      assert.equal(bytes.length, entry.size, `ASAR size mismatch ${relative}`);
      assert.equal(sha256(bytes), entry.integrity.hash, `ASAR file hash mismatch ${relative}`);
      const blockSize = entry.integrity.blockSize;
      assert.ok(Number.isSafeInteger(blockSize) && blockSize > 0);
      const blocks = [];
      for (let offset = 0; offset < bytes.length; offset += blockSize) blocks.push(sha256(bytes.subarray(offset, offset + blockSize)));
      // ASAR represents an empty file with the hash of its empty block.
      if (bytes.length === 0) blocks.push(sha256(bytes));
      assert.deepEqual(entry.integrity.blocks, blocks, `ASAR block hash mismatch ${relative}`);
      assert.ok(BUNDLED_SKILL_FILES.includes(relative) || /^(core|server|public)\//.test(relative) || ['desktop/main.mjs', 'desktop/secret-store.mjs', 'desktop/composer-drafts.mjs', 'desktop/workspace-profiles.mjs', 'desktop/workspace-errors.mjs', 'desktop/workspace-switch.mjs', 'desktop/workspace-actions.mjs', 'desktop/workspace-navigation.mjs', 'desktop/lifecycle.mjs', 'desktop/native-leave.mjs', 'desktop/backup-worker.mjs', 'desktop/backup-worker-client.mjs', 'desktop/relaunch-smoke.mjs', 'desktop/draft-relaunch-ui.mjs', 'desktop/draft-relaunch-proof.mjs', 'desktop/relaunch-smoke-state.mjs', 'desktop/smoke-diagnostics.mjs', 'desktop/smoke-readiness.mjs', 'desktop/resources/icon.png', 'package.json', 'LICENSE', 'NOTICE', 'docs/THIRD_PARTY.md', 'docs/sbom.cdx.json'].includes(relative), `Unexpected bundled file ${relative}`);
      if (/^(core|server|public|desktop)\//.test(relative)) {
        assert.equal(sha256(await readFile(path.join(root, relative))), sha256(bytes), `Bundled runtime differs from source ${relative}`);
        sourceMatches++;
      } else if (BUNDLED_SKILL_FILES.includes(relative)) {
        await verifyBundledSkillResource(relative, bytes);
        sourceMatches++;
      }
      packagedFiles.add(relative);
      files++;
      totalBytes += bytes.length;
    }
  }
  await inspect(raw.header.files);
  for (const required of [...BUNDLED_SKILL_FILES, 'server/manual-file-edit.mjs', 'public/file-editor-ui.mjs', 'public/file-editor-text.mjs', 'core/windows-command.mjs', 'core/windows-command-host.cs', 'core/command-runner.mjs', 'core/command-schema.mjs']) {
    assert.ok(packagedFiles.has(required), 'Missing required runtime module ' + required);
  }
  const packagedInfo = JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8'));
  assert.equal(packagedInfo.version, packageInfo.version);
  assert.equal(packagedInfo.main, 'desktop/main.mjs');
  const thirdPartyNotices = await verifyThirdPartyNotices(path.dirname(executable));
  return { ok: true, thirdPartyNotices, executable: path.resolve(executable), metadata, iconFramesMatched: expectedIcon.icons.length, fuses: checkedFuses, asar: { headerSha256, files, sourceMatches, totalBytes }, executableSha256: sha256(binary) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = path.resolve(process.argv[2] || path.join(root, 'release/win-unpacked/OpenAster.exe'));
  console.log(JSON.stringify(await verifyWindowsPackage(executable), null, 2));
}
