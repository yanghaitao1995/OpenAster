// SPDX-License-Identifier: Apache-2.0
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_ANDROID_VERSION_CODE = 2_100_000_000;

export function validateAndroidVersionCode(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ANDROID_VERSION_CODE) {
    throw new Error(`Android versionCode must be an integer from 1 to ${MAX_ANDROID_VERSION_CODE}`);
  }
  return value;
}

export function validateAndroidVersionName(value) {
  if (typeof value !== 'string' || value.length > 128 || /[\r\n]/.test(value) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error('Invalid application version');
  }
  return value;
}

export function validateAndroidVersionConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, 'versionCode')
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, 'versionCode'), 'value')) {
    throw new Error('Android version configuration must contain only versionCode');
  }
  return { versionCode: validateAndroidVersionCode(value.versionCode) };
}

export function readGradleAndroidVersion(source) {
  const code = [...source.matchAll(/^[ \t]*versionCode[ \t]+([1-9]\d*)[ \t]*\r?$/gm)];
  const name = [...source.matchAll(/^[ \t]*versionName[ \t]+(["'])([^"'\r\n]+)\1[ \t]*\r?$/gm)];
  if (code.length !== 1 || [...source.matchAll(/\bversionCode\b/g)].length !== 1) throw new Error('Expected one literal Android versionCode; review the generated Gradle file');
  if (name.length !== 1 || [...source.matchAll(/\bversionName\b/g)].length !== 1) throw new Error('Expected one literal Android versionName; review the generated Gradle file');
  return { versionCode: validateAndroidVersionCode(Number(code[0][1])), versionName: name[0][2] };
}

export function assertAndroidVersionNotOlder(requested, previous, label) {
  validateAndroidVersionCode(requested.versionCode);
  validateAndroidVersionCode(previous.versionCode);
  if (requested.versionCode < previous.versionCode) {
    throw new Error(`Android versionCode rollback refused: ${requested.versionCode} is below ${label} (${previous.versionCode})`);
  }
  if (requested.versionCode === previous.versionCode && requested.versionName !== previous.versionName) {
    throw new Error(`Android versionName changed without increasing versionCode relative to ${label}`);
  }
}

// Existing generated state/receipts are evidence, not an inferred release ledger.
// A clean checkout cannot prove the highest version ever distributed elsewhere.
async function readInput(projectRoot, relative, { optional = false } = {}) {
  let current = projectRoot;
  const parts = relative.split('/');
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Linked Android version input refused: ${relative}`);
    if (current === path.join(projectRoot, ...parts)) {
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error(`Unsafe Android version input: ${relative}`);
    } else if (!stat.isDirectory()) throw new Error(`Invalid Android version input parent: ${relative}`);
  }
  const bytes = await readFile(current);
  return { bytes, evidence: { file: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}

function json(input, label) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)); }
  catch { throw new Error(`Invalid UTF-8 JSON in ${label}`); }
}

export async function readAndroidVersion({ projectRoot = root, requireSynchronized = false } = {}) {
  projectRoot = path.resolve(projectRoot);
  const configuration = await readInput(projectRoot, 'mobile/android-version.json');
  const packageInput = await readInput(projectRoot, 'package.json');
  const { versionCode } = validateAndroidVersionConfiguration(json(configuration, 'mobile/android-version.json'));
  // This small controlled file has one literal decimal field. Reject duplicate
  // JSON keys (which JSON.parse otherwise silently overwrites) and expressions.
  if (!/^\s*\{\s*"versionCode"\s*:\s*[1-9]\d*\s*\}\s*$/.test(new TextDecoder('utf-8', { fatal: true }).decode(configuration.bytes))) {
    throw new Error('Android version configuration must contain one literal decimal versionCode');
  }
  const versionName = validateAndroidVersionName(json(packageInput, 'package.json')?.version);
  const requested = { versionCode, versionName };
  const generated = await readInput(projectRoot, 'mobile/android/app/build.gradle', { optional: !requireSynchronized });
  let generatedVersion = null;
  if (generated) {
    generatedVersion = readGradleAndroidVersion(new TextDecoder('utf-8', { fatal: true }).decode(generated.bytes));
    assertAndroidVersionNotOlder(requested, generatedVersion, 'the generated Android project');
    if (requireSynchronized && (generatedVersion.versionCode !== versionCode || generatedVersion.versionName !== versionName)) {
      throw new Error('Android version configuration is not synchronized; run mobile/native.mjs android before building');
    }
  }
  const previous = await readInput(projectRoot, '.toolchains/android-build-receipt.json', { optional: true });
  let previousBuild = null;
  if (previous) {
    const receipt = json(previous, 'the previous Android build receipt');
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Invalid previous Android build receipt');
    const hasCode = Object.hasOwn(receipt, 'versionCode');
    const hasName = Object.hasOwn(receipt, 'versionName');
    if (hasCode !== hasName) throw new Error('Incomplete version in previous Android build receipt');
    previousBuild = { ...previous.evidence, versionCode: null, versionName: null };
    if (hasCode) {
      previousBuild.versionCode = validateAndroidVersionCode(receipt.versionCode);
      previousBuild.versionName = validateAndroidVersionName(receipt.versionName);
      assertAndroidVersionNotOlder(requested, previousBuild, 'the previous Android build receipt');
    }
    // Legacy receipts have no version fields. Preserve that fact; never assume code 1.
  }
  const artifactName = `OpenAster-${versionName}-android-vc${versionCode}-debug.apk`;
  return {
    ...requested, artifactName, artifact: `release/${artifactName}`,
    sourceInputs: [packageInput.evidence, configuration.evidence],
    generated: generated ? { ...generated.evidence, ...generatedVersion } : null,
    previousBuild,
  };
}

export function assertApkAndroidVersion(badging, expected) {
  const packages = badging.split(/\r?\n/).filter(line => line.startsWith('package: '));
  if (packages.length !== 1) throw new Error('Expected one APK package declaration');
  const codes = [...packages[0].matchAll(/\bversionCode='([^']*)'/g)];
  const names = [...packages[0].matchAll(/\bversionName='([^']*)'/g)];
  if (codes.length !== 1 || names.length !== 1 || !/^[1-9]\d*$/.test(codes[0][1])) throw new Error('Invalid APK version declaration');
  const actual = { versionCode: validateAndroidVersionCode(Number(codes[0][1])), versionName: names[0][1] };
  if (actual.versionCode !== expected.versionCode || actual.versionName !== expected.versionName) throw new Error('APK version does not match the controlled Android version');
  return actual;
}

export async function androidVersionCommand(args, { projectRoot = root } = {}) {
  if (args.length !== 1 && args.length !== 2) throw new Error('Usage: android-version.mjs check-build | verify-apk <aapt-badging-file>');
  if (args[0] === 'check-build' && args.length === 1) return readAndroidVersion({ projectRoot, requireSynchronized: true });
  if (args[0] === 'verify-apk' && args.length === 2) {
    const expected = await readAndroidVersion({ projectRoot, requireSynchronized: true });
    const relative = path.relative(path.resolve(projectRoot), path.resolve(args[1])).replaceAll('\\', '/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('APK badging evidence must be inside the project');
    const input = await readInput(path.resolve(projectRoot), relative);
    return { ...assertApkAndroidVersion(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes), expected), evidence: input.evidence };
  }
  throw new Error('Usage: android-version.mjs check-build | verify-apk <aapt-badging-file>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await androidVersionCommand(process.argv.slice(2))));
}
