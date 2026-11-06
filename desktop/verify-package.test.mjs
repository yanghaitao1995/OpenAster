// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sharedBuildInfo } from '../scripts/lib/build-info.mjs';
import { verifyDesktopArchive } from './verify-package.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve('electron-builder/package.json'));
const packaging = createRequire(builder.resolve('app-builder-lib/package.json'));
const asar = packaging('@electron/asar');
const { createTransformer } = packaging('./out/fileTransformer.js');

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'openaster-package-check-'));
  const identity = await fs.lstat(directory, { bigint: true });
  t.after(async () => {
    const current = await fs.lstat(directory, { bigint: true });
    assert.equal(path.dirname(await fs.realpath(directory)), parent);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && identity.dev === current.dev && identity.ino === current.ino);
    await fs.rm(directory, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const stage = path.join(directory, 'source'); await fs.mkdir(stage);
  const config = JSON.parse(await fs.readFile(path.join(root, 'desktop/electron-builder.json'), 'utf8'));
  for (const relative of config.files) {
    const file = relative.replace('/**/*', ''), source = path.join(root, file), target = path.join(stage, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
  }
  const sourcePackage = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const distributedPackage = { ...Object.fromEntries(['name', 'version', 'description', 'author', 'homepage', 'license', 'engines'].map(key => [key, sourcePackage[key]])),
    type: 'module', main: 'desktop/main.mjs', scripts: { start: 'node server/index.mjs', backup: 'node scripts/backup.mjs' } };
  const packagePath = path.join(stage, 'package.json');
  await fs.writeFile(packagePath, JSON.stringify(distributedPackage));
  // Use the installed builder's real package transformer, including script removal.
  await fs.writeFile(packagePath, await createTransformer(stage, config, config.extraMetadata, null)(packagePath));
  const info = { ...await sharedBuildInfo(root), mode: 'desktop-web' };
  await fs.writeFile(path.join(stage, 'public/build-info.json'), JSON.stringify(info));
  const archive = path.join(directory, 'app.asar');
  await asar.createPackageWithOptions(stage, archive, { unpack: '**/skills/**/*' });
  return { directory, stage, archive, info };
}

test('actual archive verification checks source identity and physical unpacked skills', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const verified = await verifyDesktopArchive(f.archive);
  assert.deepEqual(verified.buildInfo, f.info);
  assert.ok(verified.sourceMatches > 100);
  assert.match(verified.headerSha256, /^[a-f0-9]{64}$/u);
  await fs.writeFile(path.join(f.archive + '.unpacked', 'skills/code/SKILL.md'), 'substituted skill');
  await assert.rejects(verifyDesktopArchive(f.archive), /ASAR size mismatch|ASAR file hash mismatch/u);
});

test('a self-consistent archive with altered runtime or missing unpacked skills is rejected', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.stage, 'core/skills.mjs'), '\n// substituted runtime\n');
  const changed = path.join(f.directory, 'changed.asar');
  await asar.createPackageWithOptions(f.stage, changed, { unpack: '**/skills/**/*' });
  await assert.rejects(verifyDesktopArchive(changed), /Bundled source differs from source/u);
  await fs.copyFile(path.join(root, 'core/skills.mjs'), path.join(f.stage, 'core/skills.mjs'));
  const packed = path.join(f.directory, 'packed.asar');
  await asar.createPackage(f.stage, packed);
  await assert.rejects(verifyDesktopArchive(packed), /Skill resource must be a physical unpacked file/u);
  await fs.link(f.archive, path.join(f.directory, 'linked.asar'));
  await assert.rejects(verifyDesktopArchive(f.archive), /ordinary unredirected/u);
});

test('complete archive manifest rejects missing legal documents, missing runtime and extra files', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const missing = ['LICENSE', 'NOTICE', 'docs/THIRD_PARTY.md', 'docs/sbom.cdx.json', 'core/errors.mjs'];
  for (const [index, relative] of missing.entries()) {
    const filename = path.join(f.stage, relative), content = await fs.readFile(filename);
    await fs.unlink(filename);
    const archive = path.join(f.directory, 'missing-' + index + '.asar');
    await asar.createPackageWithOptions(f.stage, archive, { unpack: '**/skills/**/*' });
    await assert.rejects(verifyDesktopArchive(archive), error => error.message.includes('Missing expected bundled file ' + relative));
    await fs.writeFile(filename, content);
  }
  await fs.writeFile(path.join(f.stage, 'core/unreviewed.mjs'), 'export const injected = true;');
  const extra = path.join(f.directory, 'extra.asar');
  await asar.createPackageWithOptions(f.stage, extra, { unpack: '**/skills/**/*' });
  await assert.rejects(verifyDesktopArchive(extra), /Unexpected bundled file core\/unreviewed.mjs/u);
});

test('legal content and generated package metadata cannot change inside a self-consistent archive', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  for (const [index, relative] of ['LICENSE', 'NOTICE', 'docs/THIRD_PARTY.md', 'docs/sbom.cdx.json'].entries()) {
    const filename = path.join(f.stage, relative), content = await fs.readFile(filename);
    await fs.writeFile(filename, Buffer.concat([content, Buffer.from('\nsubstituted content')]));
    const archive = path.join(f.directory, 'legal-' + index + '.asar');
    await asar.createPackageWithOptions(f.stage, archive, { unpack: '**/skills/**/*' });
    await assert.rejects(verifyDesktopArchive(archive), error => error.message.includes('Bundled source differs from source ' + relative));
    await fs.writeFile(filename, content);
  }
  const filename = path.join(f.stage, 'package.json'), info = JSON.parse(await fs.readFile(filename, 'utf8'));
  await fs.writeFile(filename, JSON.stringify({ ...info, private: true }));
  const changed = path.join(f.directory, 'metadata.asar');
  await asar.createPackageWithOptions(f.stage, changed, { unpack: '**/skills/**/*' });
  await assert.rejects(verifyDesktopArchive(changed), /Generated package metadata differs/u);
});
