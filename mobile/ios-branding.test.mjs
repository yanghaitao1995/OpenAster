// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { synchronizeIOSBranding, validateIOSBrandingAsset } from './ios-branding.mjs';

const require = createRequire(import.meta.url);
const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const managedParent = path.join(repository, 'test-results');
const catalogRelative = 'App/App/Assets.xcassets/AppIcon.appiconset';
const iconFilename = 'AppIcon-512@2x.png';
const templates = ['ios-spm-template.tar.gz', 'ios-pods-template.tar.gz'];
const asset = await readFile(new URL('./resources/ios-icon-1024.png', import.meta.url));
const source = await readFile(new URL('../public/icon.svg', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('./resources/ios-icon.json', import.meta.url), 'utf8'));

async function fixture(t, archive = templates[0]) {
  const bytes = gunzipSync(await readFile(path.join(path.dirname(require.resolve('@capacitor/cli/package.json')), 'assets', archive)));
  const files = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const name = bytes.toString('utf8', offset, offset + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = Number.parseInt(bytes.toString('ascii', offset + 124, offset + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= bytes.length);
    if ([`${catalogRelative}/Contents.json`, `${catalogRelative}/${iconFilename}`].includes(name)) {
      assert.ok([0, 48].includes(bytes[offset + 156]), 'template icon member must be a regular file');
      files.set(path.basename(name), bytes.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(files.size, 2, 'use both real icon files from the installed Capacitor template');
  await mkdir(managedParent, { recursive: true });
  const root = await mkdtemp(path.join(managedParent, 'ios-branding-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), managedParent);
    await rm(root, { recursive: true, force: true });
  });
  const catalog = path.join(root, catalogRelative);
  await mkdir(catalog, { recursive: true });
  for (const [name, content] of files) await writeFile(path.join(catalog, name), content);
  const native = path.join(root, 'App/App/AppDelegate.swift');
  await writeFile(native, '// unrelated native customization\n');
  return { root, catalog, native, icon: path.join(catalog, iconFilename), contents: path.join(catalog, 'Contents.json'), files };
}

test('both installed iOS templates receive the original icon without changing catalog or native code', async t => {
  for (const archive of templates) {
    await t.test(archive, async t => {
      const f = await fixture(t, archive);
      const result = await synchronizeIOSBranding(f.root);
      assert.equal(result.changed, true);
      assert.equal(result.assetSha256, manifest.asset.sha256);
      assert.deepEqual(await readFile(f.icon), asset);
      assert.deepEqual(await readFile(f.contents), f.files.get('Contents.json'));
      assert.equal(await readFile(f.native, 'utf8'), '// unrelated native customization\n');
      const beforeRepeat = await stat(f.icon, { bigint: true });
      assert.equal((await synchronizeIOSBranding(f.root)).changed, false);
      assert.equal((await stat(f.icon, { bigint: true })).mtimeNs, beforeRepeat.mtimeNs);
      assert.deepEqual((await readdir(f.catalog)).sort(), ['Contents.json', iconFilename].sort());
    });
  }
});

test('custom icons, catalogs and additional assets are rejected without replacement', async t => {
  for (const change of ['icon', 'catalog', 'extra']) {
    await t.test(change, async t => {
      const f = await fixture(t);
      if (change === 'icon') await writeFile(f.icon, 'custom icon owned by the user');
      if (change === 'catalog') await writeFile(f.contents, '{"images":[],"info":{"version":1}}\n');
      if (change === 'extra') await writeFile(path.join(f.catalog, 'custom.png'), 'another native asset');
      const before = await Promise.all([readFile(f.icon), readFile(f.contents), readFile(f.native)]);
      await assert.rejects(synchronizeIOSBranding(f.root), /Unknown iOS app icon/);
      assert.deepEqual(await Promise.all([readFile(f.icon), readFile(f.contents), readFile(f.native)]), before);
      if (change === 'extra') assert.equal(await readFile(path.join(f.catalog, 'custom.png'), 'utf8'), 'another native asset');
    });
  }
});

test('shared icon or catalog hard links are refused without modifying their other names', async t => {
  for (const member of ['icon', 'contents']) {
    await t.test(member, async t => {
      const f = await fixture(t);
      const alias = path.join(f.root, 'shared-original');
      await link(f[member], alias);
      const before = await readFile(alias);
      await assert.rejects(synchronizeIOSBranding(f.root), /single-link/);
      assert.deepEqual(await readFile(alias), before);
      assert.deepEqual(await readFile(f.icon), f.files.get(iconFilename));
    });
  }
});

test('linked icon files and directory parents cannot redirect branding writes', async t => {
  await t.test('file symlink', async t => {
    const f = await fixture(t);
    const target = path.join(f.root, 'original-icon.png');
    await rename(f.icon, target);
    try { await symlink(target, f.icon, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('File symlink creation is unavailable on this host');
      throw error;
    }
    await assert.rejects(synchronizeIOSBranding(f.root), /single-link/);
    assert.deepEqual(await readFile(target), f.files.get(iconFilename));
  });
  await t.test('directory link or Windows junction', async t => {
    const f = await fixture(t);
    const target = path.join(f.root, 'original-App');
    await rename(path.join(f.root, 'App'), target);
    try { await symlink(target, path.join(f.root, 'App'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Directory link creation is unavailable on this host');
      throw error;
    }
    await assert.rejects(synchronizeIOSBranding(f.root), /real directories without links/);
    assert.deepEqual(await readFile(path.join(target, 'App/Assets.xcassets/AppIcon.appiconset', iconFilename)), f.files.get(iconFilename));
  });
});

test('asset provenance and Capacitor version changes require explicit revalidation', () => {
  const input = { manifest, source, asset, capacitorVersion: '8.5.3', iosVersion: '8.5.3' };
  assert.equal(validateIOSBrandingAsset(input).assetSha256, manifest.asset.sha256);
  assert.throws(() => validateIOSBrandingAsset({ ...input, capacitorVersion: '8.5.4' }), /Capacitor version/);
  assert.throws(() => validateIOSBrandingAsset({ ...input, iosVersion: '8.5.4' }), /Capacitor version/);
  assert.throws(() => validateIOSBrandingAsset({ ...input, source: Buffer.concat([source, Buffer.from('changed')]) }), /provenance/);
  assert.throws(() => validateIOSBrandingAsset({ ...input, manifest: { ...manifest, version: 2 } }), /provenance/);
  assert.throws(() => validateIOSBrandingAsset({ ...input, asset: Buffer.from('invalid PNG') }), /provenance/);
});

test('relative and broad filesystem roots are rejected', async () => {
  await assert.rejects(synchronizeIOSBranding('mobile/ios'), /must be absolute/);
  await assert.rejects(synchronizeIOSBranding(path.parse(repository).root), /Unsafe iOS project root/);
  await assert.rejects(synchronizeIOSBranding(repository), /Unsafe iOS project root/);
});
