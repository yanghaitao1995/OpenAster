import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  MAX_ANDROID_VERSION_CODE, validateAndroidVersionConfiguration, validateAndroidVersionName,
  readAndroidVersion, readGradleAndroidVersion, assertApkAndroidVersion, androidVersionCommand,
} from './android-version.mjs';

const gradle = (code = 2, name = '0.1.0') => `android {\n  defaultConfig {\n    versionCode ${code}\n    versionName "${name}"\n  }\n}\n`;
async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'openaster-android-version-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  async function put(file, value) {
    const target = path.join(projectRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
    return target;
  }
  await put('package.json', { version: '0.1.0' });
  await put('mobile/android-version.json', { versionCode: 2 });
  return { projectRoot, put, read: options => readAndroidVersion({ projectRoot, ...options }), command: args => androidVersionCommand(args, { projectRoot }) };
}

test('explicit versionCode rejects missing, coerced, fractional, unsafe and extra configuration', () => {
  for (const versionCode of [undefined, null, '2', 0, -1, 1.5, NaN, Infinity, 2_100_000_001]) {
    assert.throws(() => validateAndroidVersionConfiguration({ versionCode }));
  }
  for (const value of [null, [], {}, { versionCode: 2, extra: true }, Object.create({ versionCode: 2 })]) {
    assert.throws(() => validateAndroidVersionConfiguration(value));
  }
  assert.throws(() => validateAndroidVersionConfiguration({ get versionCode() { throw new Error('must not execute'); } }), /only versionCode/);
  assert.deepEqual(validateAndroidVersionConfiguration({ versionCode: MAX_ANDROID_VERSION_CODE }), { versionCode: MAX_ANDROID_VERSION_CODE });
  for (const value of ['../0.1.0', '0.1.0\n', '0.1.0"', '0.1.0/next', null]) assert.throws(() => validateAndroidVersionName(value));
  assert.equal(validateAndroidVersionName('0.2.0-beta.1+test'), '0.2.0-beta.1+test');
});

test('configuration is required on a clean checkout; preparing versions creates no generated files', async t => {
  const f = await fixture(t);
  const result = await f.read();
  assert.equal(result.versionCode, 2);
  assert.equal(result.generated, null);
  assert.equal(result.previousBuild, null);
  assert.equal(result.artifactName, 'OpenAster-0.1.0-android-vc2-debug.apk');
  await assert.rejects(f.command(['check-build']), { code: 'ENOENT' });
  await rm(path.join(f.projectRoot, 'mobile/android-version.json'));
  await assert.rejects(f.read(), { code: 'ENOENT' });
  await f.put('mobile/android-version.json', '{');
  await assert.rejects(f.read(), /Invalid UTF-8 JSON/);
  await f.put('mobile/android-version.json', { versionCode: 2, unexpected: true });
  await assert.rejects(f.read(), /only versionCode/);
  await f.put('mobile/android-version.json', '{"versionCode":1,"versionCode":2}');
  await assert.rejects(f.read(), /one literal decimal/);
});

test('sync may advance the generated version but build preflight requires an exact match', async t => {
  const f = await fixture(t);
  const target = await f.put('mobile/android/app/build.gradle', gradle(1));
  const before = await readFile(target);
  assert.equal((await f.read()).generated.versionCode, 1);
  await assert.rejects(f.command(['check-build']), /not synchronized/);
  assert.deepEqual(await readFile(target), before);
  await f.put('mobile/android/app/build.gradle', gradle(2));
  const result = await f.command(['check-build']);
  assert.equal(result.generated.versionCode, 2);
  assert.equal(result.sourceInputs.length, 2);
  await f.put('mobile/android/app/build.gradle', gradle(3));
  await assert.rejects(f.read(), /rollback refused/);
  await f.put('mobile/android/app/build.gradle', gradle(2, '0.0.9'));
  await assert.rejects(f.read(), /without increasing versionCode/);
});

test('versioned build receipt blocks rollback after generated project is removed', async t => {
  const f = await fixture(t);
  await f.put('.toolchains/android-build-receipt.json', { versionCode: 3, versionName: '0.2.0' });
  await assert.rejects(f.read(), /previous Android build receipt/);
  await f.put('mobile/android-version.json', { versionCode: 3 });
  await assert.rejects(f.read(), /without increasing versionCode/);
  await f.put('package.json', { version: '0.2.0' });
  const same = await f.read();
  assert.equal(same.artifactName, 'OpenAster-0.2.0-android-vc3-debug.apk');
  assert.equal(same.previousBuild.versionCode, 3);
  await f.put('mobile/android-version.json', { versionCode: 4 });
  assert.equal((await f.read()).versionCode, 4);
});

test('legacy receipt stays explicitly unversioned while malformed or partial new receipt fails', async t => {
  const f = await fixture(t);
  await f.put('.toolchains/android-build-receipt.json', { artifact: 'release/old-debug.apk', bytes: 100, sha256: 'a'.repeat(64) });
  const result = await f.read();
  assert.equal(result.previousBuild.versionCode, null);
  assert.equal(result.previousBuild.versionName, null);
  assert.match(result.previousBuild.sha256, /^[a-f0-9]{64}$/);
  for (const receipt of [null, [], { versionCode: 2 }, { versionName: '0.1.0' }, { versionCode: '2', versionName: '0.1.0' }]) {
    await f.put('.toolchains/android-build-receipt.json', receipt);
    await assert.rejects(f.read());
  }
});

test('generated Gradle version cannot be expressions, duplicate declarations or invalid integer values', () => {
  for (const source of [gradle('getCode()'), gradle(0), gradle('2.5'), gradle(2_100_000_001), gradle() + 'versionCode 2\n', gradle() + 'versionCode fromEnvironment()\n', gradle() + 'versionName "other"\n']) {
    assert.throws(() => readGradleAndroidVersion(source));
  }
  assert.deepEqual(readGradleAndroidVersion(gradle().replaceAll('\n', '\r\n')), { versionCode: 2, versionName: '0.1.0' });
});

test('APK metadata must match both controlled version fields before publication', async t => {
  const f = await fixture(t);
  await f.put('mobile/android/app/build.gradle', gradle());
  const line = "package: name='org.openaster.preview' versionCode='2' versionName='0.1.0' compileSdkVersion='36'\n";
  const target = await f.put('.toolchains/android-apk-version.log', line);
  const result = await f.command(['verify-apk', target]);
  assert.equal(result.versionCode, 2);
  assert.equal(result.versionName, '0.1.0');
  for (const badging of [line.replace("Code='2'", "Code='1'"), line.replace("Name='0.1.0'", "Name='1.0'"), line + line, line.replace("Code='2'", "Code='2.0'"), '']) {
    assert.throws(() => assertApkAndroidVersion(badging, { versionCode: 2, versionName: '0.1.0' }));
    await f.put('.toolchains/android-apk-version.log', badging);
    await assert.rejects(f.command(['verify-apk', target]));
  }
  await assert.rejects(f.command(['verify-apk', path.resolve(f.projectRoot, '..', 'outside.log')]), /inside the project/);
  await assert.rejects(f.command(['unknown']), /Usage/);
});

test('native command refuses an invalid or missing code before touching web assets or resolving Capacitor', async t => {
  const f = await fixture(t);
  for (const name of ['native.mjs', 'android-version.mjs', 'harden-android.mjs', 'prepare.mjs', 'security.mjs', 'android-branding.mjs', 'android-appearance.mjs', 'notice-assets.mjs', 'ios-branding.mjs']) {
    await f.put(`mobile/${name}`, await readFile(new URL(name, import.meta.url), 'utf8'));
  }
  const sentinel = await f.put('mobile/www/index.html', 'existing assets must remain intact');
  for (const configuration of ['{"versionCode":"2"}', null]) {
    if (configuration === null) await rm(path.join(f.projectRoot, 'mobile/android-version.json'));
    else await f.put('mobile/android-version.json', configuration);
    const child = spawnSync(process.execPath, [path.join(f.projectRoot, 'mobile/native.mjs'), 'android'], {
      cwd: f.projectRoot, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stderr, configuration === null ? /ENOENT/ : /versionCode must be an integer/);
    assert.doesNotMatch(child.stderr, /Cannot find module.*capacitor|Mobile output/);
    assert.equal(await readFile(sentinel, 'utf8'), 'existing assets must remain intact');
  }
});
