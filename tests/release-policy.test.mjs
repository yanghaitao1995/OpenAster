// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectReleaseFiles } from '../scripts/lib/release-files.mjs';
import { sharedBuildInfo } from '../scripts/lib/build-info.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'openaster-release-'));
  t.after(async () => { assert.equal(path.dirname(root), tmpdir()); assert.ok(path.basename(root).startsWith('openaster-release-')); await rm(root, { recursive: true, force: true }); });
  const put = async (name, contents = '') => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), contents); };
  const policy = { rootFiles: ['package.json'], sourceDirectories: ['public', 'mobile'], documents: ['docs/README.md'], mediaDirectory: 'docs/assets',
    mediaExtensions: ['.png'], sourceExtensions: ['.mjs', '.json'], excludedDirectories: ['node_modules'], excludedPaths: ['mobile/android'] };
  await put('package.json', JSON.stringify({ version: '0.2.0' })); await put('public/app.mjs', 'export const value = 1;'); await put('mobile/native.mjs'); await put('docs/README.md');
  return { root, put, policy };
}
test('public release enumeration excludes generated projects, local reports and dependency trees', async t => {
  const { root, put, policy } = await fixture(t);
  await put('mobile/android/key.env'); await put('public/node_modules/local.key'); await put('docs/private-log.md'); await put('docs/assets/example.png');
  assert.deepEqual(await collectReleaseFiles(root, policy), ['docs/README.md', 'docs/assets/example.png', 'mobile/native.mjs', 'package.json', 'public/app.mjs']);
});
test('release enumeration rejects traversal, credential-like files and unreviewed extensions', async t => {
  const { root, put, policy } = await fixture(t);
  await assert.rejects(collectReleaseFiles(root, { ...policy, rootFiles: ['../outside'] }), /Invalid release path/);
  await put('public/.env'); await assert.rejects(collectReleaseFiles(root, policy), /Unsafe release input/);
  await rm(path.join(root, 'public/.env'));
  await put('public/unreviewed.bin'); await assert.rejects(collectReleaseFiles(root, policy), /Unreviewed/);
});
test('shared asset identity changes with source bytes and ignores generated metadata', async t => {
  const { root, put } = await fixture(t);
  const before = await sharedBuildInfo(root);
  await put('public/build-info.json', 'previous generated value');
  assert.deepEqual(await sharedBuildInfo(root), before);
  await put('public/app.mjs', 'export const value = 2;');
  const after = await sharedBuildInfo(root);
  assert.notEqual(after.sharedAssetsSha256, before.sharedAssetsSha256);
  assert.equal(after.version, '0.2.0'); assert.equal(after.sharedAssets, 1);
});
