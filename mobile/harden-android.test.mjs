import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { hardenAndroidManifest, hardenAndroidFilePaths, androidDataExtractionRules, synchronizeAndroidVersion, hardenAndroidProject } from './harden-android.mjs';

const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n<application android:allowBackup="true" android:label="OpenAster"><activity android:name=".MainActivity" /></application>\n<uses-permission android:name="android.permission.INTERNET" />\n</manifest>';
const gradle = 'android {\n    defaultConfig {\n        versionCode 1\n        versionName "1.0"\n    }\n}\n';
const filePaths = '<?xml version="1.0" encoding="utf-8"?>\n<paths xmlns:android="http://schemas.android.com/apk/res/android">\n    <external-path name="my_images" path="." />\n    <cache-path name="my_cache_images" path="." />\n</paths>\n';

test('Android hardening disables backup and plaintext without adding permissions, and is idempotent', () => {
  const hardened = hardenAndroidManifest(manifest);
  assert.match(hardened, /android:allowBackup="false"/);
  assert.match(hardened, /android:usesCleartextTraffic="false"/);
  assert.match(hardened, /android:fullBackupContent="false"/);
  assert.match(hardened, /android:dataExtractionRules="@xml\/openaster_data_extraction_rules"/);
  assert.ok(hardened.indexOf('<uses-permission') < hardened.indexOf('<application'));
  assert.equal((hardened.match(/uses-permission /g) || []).length, 1);
  assert.equal(hardenAndroidManifest(hardened), hardened);
  assert.match(hardenAndroidManifest(manifest.replace('android:allowBackup="true"', '')), /android:allowBackup="false"/);
});

test('Android hardening refuses dangerous permissions or a bypass network configuration', () => {
  for (const permission of ['CAMERA', 'RECORD_AUDIO', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'MANAGE_EXTERNAL_STORAGE']) {
    assert.throws(() => hardenAndroidManifest(manifest.replace('</manifest>', `<uses-permission android:name="android.permission.${permission}" /></manifest>`)), /only android.permission.INTERNET/);
  }
  assert.throws(() => hardenAndroidManifest(manifest.replace('<application ', '<application android:networkSecurityConfig="@xml/network_security_config" ')), /explicit review/);
  assert.throws(() => hardenAndroidManifest(manifest.replace('<application ', '<application android:dataExtractionRules="@xml/other" ')), /explicit review/);
  assert.throws(() => hardenAndroidManifest(manifest.replace('android.permission.INTERNET', 'android.permission.CAMERA')));
});

test('Android data extraction excludes every supported storage domain for cloud backup and device migration', () => {
  const rules = androidDataExtractionRules();
  for (const type of ['cloud-backup', 'device-transfer']) {
    const section = rules.match(new RegExp(`<${type}[^>]*>([\\s\\S]*?)</${type}>`))?.[1];
    assert.ok(section);
    for (const domain of ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref']) {
      assert.ok(section.includes(`<exclude domain="${domain}" path="." />`), `${type} must exclude ${domain}`);
    }
    assert.doesNotMatch(section, /<include\b/);
  }
});

test('Android version follows explicit code and package version, and rejects rollback or Gradle injection', () => {
  const updated = synchronizeAndroidVersion(gradle, '0.1.0', 2);
  assert.match(updated, /versionName "0.1.0"/);
  assert.match(updated, /versionCode 2/);
  assert.equal(synchronizeAndroidVersion(updated, '0.1.0', 2), updated);
  assert.throws(() => synchronizeAndroidVersion(updated, '0.1.0', 1), /rollback refused/);
  assert.throws(() => synchronizeAndroidVersion(updated, '0.2.0', 2), /without increasing versionCode/);
  assert.throws(() => synchronizeAndroidVersion(gradle, '0.1.0'), /versionCode/);
  assert.throws(() => synchronizeAndroidVersion(gradle, '0.1.0";exec("bad")', 2));
  assert.throws(() => synchronizeAndroidVersion(`${gradle}\nversionName "other"`, '0.1.0', 2), /one literal Android versionName/);
  assert.equal(synchronizeAndroidVersion(gradle.replaceAll('\n', '\r\n'), '0.1.0', 2), updated.replaceAll('\n', '\r\n'));
});

test('Android FileProvider exposes only the shared cache subdirectory across repeated sync', () => {
  const hardened = hardenAndroidFilePaths(filePaths);
  assert.doesNotMatch(hardened, /external-path|path="\."/);
  assert.match(hardened, /<cache-path name="my_cache_images" path="shared\/" \/>/);
  assert.equal(hardenAndroidFilePaths(hardened), hardened);
  assert.equal(hardenAndroidFilePaths(filePaths), hardened);
});

test('Android FileProvider refuses unknown roots, duplicates, malformed XML and path escapes', () => {
  const unsafeTemplates = [
    filePaths.replace('</paths>', '<root-path name="all" path="." /></paths>'),
    filePaths.replace('</paths>', '<cache-path name="another" path="." /></paths>'),
    filePaths.replace('path="."', 'path="../"'),
    filePaths.replace('name="my_images"', 'name="my_images" other="unsafe"'),
    '<!DOCTYPE paths [<!ENTITY root "..">]>' + filePaths,
    filePaths + '<paths />',
    filePaths.replace('</paths>', ''),
  ];
  for (const source of unsafeTemplates) assert.throws(() => hardenAndroidFilePaths(source), /Unknown Android FileProvider/);
});

test('Android postprocessing validates every generated file before writing and hardens repeated sync', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openaster-android-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestFile = path.join(directory, 'app/src/main/AndroidManifest.xml');
  const gradleFile = path.join(directory, 'app/build.gradle');
  const filePathsFile = path.join(directory, 'app/src/main/res/xml/file_paths.xml');
  const extractionFile = path.join(directory, 'app/src/main/res/xml/openaster_data_extraction_rules.xml');
  await mkdir(path.dirname(filePathsFile), { recursive: true });
  await writeFile(manifestFile, manifest);
  await writeFile(gradleFile, gradle);
  await writeFile(filePathsFile, filePaths);
  const result = await hardenAndroidProject({ projectDirectory: directory, version: '0.1.0', versionCode: 2 });
  assert.deepEqual(result.permissions, ['android.permission.INTERNET']);
  assert.match(await readFile(manifestFile, 'utf8'), /usesCleartextTraffic="false"/);
  assert.match(await readFile(gradleFile, 'utf8'), /versionName "0.1.0"/);
  assert.match(await readFile(gradleFile, 'utf8'), /versionCode 2/);
  assert.equal(result.versionCode, 2);
  const expectedFilePaths = hardenAndroidFilePaths(filePaths);
  assert.equal(await readFile(filePathsFile, 'utf8'), expectedFilePaths);
  assert.equal(result.fileProviderCachePath, 'shared/');
  assert.equal(await readFile(extractionFile, 'utf8'), androidDataExtractionRules());
  await writeFile(filePathsFile, filePaths); // Capacitor synchronization regenerates its template.
  await hardenAndroidProject({ projectDirectory: directory, version: '0.1.0', versionCode: 2 });
  assert.equal(await readFile(filePathsFile, 'utf8'), expectedFilePaths);
  const beforeRejectedVersion = await Promise.all([manifestFile, gradleFile, filePathsFile, extractionFile].map(file => readFile(file, 'utf8')));
  for (const versionCode of [undefined, 0, 1, '2', 2.5, 2_100_000_001]) {
    await assert.rejects(hardenAndroidProject({ projectDirectory: directory, version: '0.1.0', versionCode }), /versionCode/);
    assert.deepEqual(await Promise.all([manifestFile, gradleFile, filePathsFile, extractionFile].map(file => readFile(file, 'utf8'))), beforeRejectedVersion);
  }
  await writeFile(manifestFile, manifest);
  await writeFile(gradleFile, 'unknown template');
  await assert.rejects(hardenAndroidProject({ projectDirectory: directory, version: '0.1.0', versionCode: 2 }), /versionCode/);
  assert.equal(await readFile(manifestFile, 'utf8'), manifest);
  await writeFile(gradleFile, gradle);
  await writeFile(filePathsFile, filePaths.replace('external-path', 'root-path'));
  await assert.rejects(hardenAndroidProject({ projectDirectory: directory, version: '0.1.0', versionCode: 2 }), /Unknown Android FileProvider/);
  assert.equal(await readFile(manifestFile, 'utf8'), manifest);
  assert.equal(await readFile(gradleFile, 'utf8'), gradle);
  await writeFile(filePathsFile, filePaths);
  await writeFile(extractionFile, '<data-extraction-rules><device-transfer /></data-extraction-rules>');
  await assert.rejects(hardenAndroidProject({ projectDirectory: directory, version: '0.1.0', versionCode: 2 }), /Unknown Android data extraction rules/);
  assert.equal(await readFile(manifestFile, 'utf8'), manifest);
  assert.equal(await readFile(gradleFile, 'utf8'), gradle);
});
