// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acceptanceMode, assertCandidateCheckout, readCandidateArtifact, verifyCandidateBytes,
  assertNativeApkVersion, signatureEvidence, assertPackagedConfiguration, collectCandidateWebFiles,
  assertCandidateWebEntries, assertCandidateWebBytes } from './verify-published-android.mjs';

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-apk-candidate-test-'));
  const identity = await fs.lstat(root, { bigint: true });
  t.after(async () => {
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
    await fs.rm(root, { recursive: true });
  });
  const put = async (relative, value) => {
    const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
  };
  await put('package.json', { version: '0.2.4' }); await put('mobile/package.json', { version: '0.2.4' });
  await put('mobile/android-version.json', { versionCode: 14 }); await put('public/app.mjs', 'export const fixture = true;');
  const apk = 'mobile/android/app/build/outputs/apk/debug/app-debug.apk';
  await put(apk, Buffer.alloc(2048, 1));
  return { root, put, apk: path.join(root, apk) };
}

test('candidate mode has no arbitrary path, URL, version or revision command-line inputs', () => {
  assert.equal(acceptanceMode([]), 'published'); assert.equal(acceptanceMode(['--candidate']), 'candidate');
  for (const args of [null, ['other'], ['--candidate', '/tmp/app.apk'], ['--url=https://example.invalid/a.apk'], ['--candidate=0.2.4']]) assert.throws(() => acceptanceMode(args));
});

test('candidate source must be this hosted repository and the exact dispatched commit', () => {
  const sha = 'a'.repeat(40), env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'yanghaitao1995/OpenAster', GITHUB_SHA: sha };
  assert.doesNotThrow(() => assertCandidateCheckout(env, sha));
  assert.throws(() => assertCandidateCheckout(env, 'b'.repeat(40)));
  for (const patch of [{ GITHUB_SHA: 'main' }, { GITHUB_SHA: undefined }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'other/repository' }]) assert.throws(() => assertCandidateCheckout({ ...env, ...patch }, sha));
});

test('candidate identity uses fixed local APK, controlled versions, source UI hash and immutable copied bytes', async t => {
  const f = await fixture(t), result = await readCandidateArtifact(f.root);
  assert.equal(result.sourceFile, f.apk); assert.equal(result.artifact.version, '0.2.4'); assert.equal(result.artifact.versionCode, 14);
  assert.equal(result.artifact.bytes, 2048); assert.equal(result.artifact.sharedAssets, 1);
  assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/u); assert.match(result.artifact.sharedAssetsSha256, /^[a-f0-9]{64}$/u);
  const copy = path.join(f.root, 'copied.apk'); await fs.copyFile(f.apk, copy);
  assert.deepEqual(await verifyCandidateBytes(copy, result.artifact), { bytes: 2048, sha256: result.artifact.sha256 });
  await fs.writeFile(copy, Buffer.alloc(2048, 2));
  await assert.rejects(verifyCandidateBytes(copy, result.artifact), /changed/u);
  await fs.writeFile(copy, Buffer.alloc(12)); await assert.rejects(verifyCandidateBytes(copy), /bounded/u);
  await f.put('public/app.mjs', 'export const changed = true;');
  assert.notEqual((await readCandidateArtifact(f.root)).artifact.sharedAssetsSha256, result.artifact.sharedAssetsSha256);
});

test('candidate rejects stale or inconsistent machine versions', async t => {
  const f = await fixture(t);
  for (const [file, wrong, original] of [
    ['package.json', { version: '0.2.2' }, { version: '0.2.4' }],
    ['mobile/package.json', { version: '0.2.2' }, { version: '0.2.4' }],
    ['mobile/android-version.json', { versionCode: 12 }, { versionCode: 14 }],
    ['mobile/android-version.json', { versionCode: 14, other: true }, { versionCode: 14 }],
  ]) {
    await f.put(file, wrong); await assert.rejects(readCandidateArtifact(f.root), /reviewed 0.2.4/u); await f.put(file, original);
  }
});

test('candidate refuses linked APK ancestors and multiply linked executable bytes', async t => {
  const f = await fixture(t), original = path.join(f.root, 'mobile/android'), moved = path.join(f.root, 'mobile/android-owned');
  await fs.rename(original, moved); await fs.symlink(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readCandidateArtifact(f.root), /links/u);
  await fs.unlink(original); await fs.rename(moved, original);
  await fs.link(f.apk, path.join(f.root, 'hardlink.apk'));
  await assert.rejects(verifyCandidateBytes(f.apk), /ordinary/u);
});

test('candidate native APK metadata and certificate evidence reject substitutions', () => {
  const artifact = { package: 'org.openaster.preview', version: '0.2.4', versionCode: 14 };
  const line = "package: name='org.openaster.preview' versionCode='14' versionName='0.2.4' compileSdkVersion='36'\n";
  assert.deepEqual(assertNativeApkVersion(line, artifact), artifact);
  for (const text of [line.replace("'14'", "'12'"), line.replace('0.2.4', '0.2.2'), line.replace('org.openaster.preview', 'other.package'), line + line, line.replace("versionCode='14'", "versionCode='14' versionCode='14'")]) assert.throws(() => assertNativeApkVersion(text, artifact));
  const signature = `Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: ${'c'.repeat(64)}\n`;
  assert.deepEqual(signatureEvidence(signature).certificateSha256, ['c'.repeat(64)]);
  assert.throws(() => signatureEvidence(signature.replace(': true', ': false')));
  assert.throws(() => signatureEvidence(signature.replace('c'.repeat(64), 'not-a-certificate-fingerprint')));
});

test('candidate packaged UI must match its checkout, not the earlier release', () => {
  const artifact = { version: '0.2.4', sharedAssets: 1, sharedAssetsSha256: 'd'.repeat(64) };
  const config = { appId: 'org.openaster.preview', server: { hostname: 'localhost', androidScheme: 'https', cleartext: false }, android: { allowMixedContent: false, webContentsDebuggingEnabled: false } };
  const build = { ...artifact, mode: 'companion' };
  assert.doesNotThrow(() => assertPackagedConfiguration(config, build, artifact));
  assert.throws(() => assertPackagedConfiguration(config, build));
  for (const patch of [{ version: '0.2.2' }, { sharedAssets: 2 }, { sharedAssetsSha256: 'e'.repeat(64) }, { mode: 'desktop-web' }]) assert.throws(() => assertPackagedConfiguration(config, { ...build, ...patch }, artifact));
});

test('APK public tree must exactly contain generated assets and the two fixed native shims', async t => {
  const f = await fixture(t);
  await f.put('mobile/www/index.html', '<html>transformed fixture</html>');
  await f.put('mobile/www/assets/app.mjs', 'export const fixture = true;');
  for (const name of ['cordova.js', 'cordova_plugins.js']) await f.put(`mobile/android/app/src/main/assets/public/${name}`, '');
  const files = await collectCandidateWebFiles(f.root);
  assert.deepEqual(files.map(file => file.file), ['assets/app.mjs', 'cordova_plugins.js', 'cordova.js', 'index.html'].sort((a, b) => a.localeCompare(b)));
  const names = files.map(file => `assets/public/${file.file}`);
  const inventory = ['AndroidManifest.xml', 'assets/public/', 'assets/public/assets/', ...names].join('\n');
  assert.equal(assertCandidateWebEntries(inventory, files).webFiles, 4);
  for (const bad of [inventory + '\n' + names[0], inventory + '\nassets/public/extra.js', inventory.replace(names[0], 'assets/public/missing.js'), inventory + '\n../escape', inventory + '\nassets\\public\\app.mjs', inventory.replace('assets/public/index.html', 'assets/public/index.html/')]) assert.throws(() => assertCandidateWebEntries(bad, files));
  const index = files.find(file => file.file === 'index.html'), bytes = await fs.readFile(path.join(f.root, index.source));
  assert.doesNotThrow(() => assertCandidateWebBytes(bytes, index));
  assert.throws(() => assertCandidateWebBytes(Buffer.alloc(bytes.length), index), /bytes differ/u);
  assert.throws(() => assertCandidateWebBytes(bytes.subarray(1), index), /bytes differ/u);
  await f.put('mobile/www/cordova.js', 'unexpected override');
  await assert.rejects(collectCandidateWebFiles(f.root), /Unexpected Cordova/u);
});

test('candidate web inventory refuses links and bounded file-count overflow', async t => {
  const f = await fixture(t);
  await f.put('mobile/www/index.html', 'fixture');
  for (const name of ['cordova.js', 'cordova_plugins.js']) await f.put(`mobile/android/app/src/main/assets/public/${name}`, '');
  const source = path.join(f.root, 'mobile/www/index.html'), linked = path.join(f.root, 'mobile/www/duplicate.html');
  await fs.link(source, linked); await assert.rejects(collectCandidateWebFiles(f.root), /ordinary-file/u); await fs.unlink(linked);
  await f.put('mobile/www/unsafe[glob].js', 'fixture'); await assert.rejects(collectCandidateWebFiles(f.root), /Unsafe/u);
  await fs.unlink(path.join(f.root, 'mobile/www/unsafe[glob].js'));
  for (let index = 0; index < 256; index++) await f.put(`mobile/www/file-${index}.js`, '');
  await assert.rejects(collectCandidateWebFiles(f.root), /limit/u);
});
