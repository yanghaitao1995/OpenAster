// SPDX-License-Identifier: Apache-2.0
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { brandAndroidProject } from './android-branding.mjs';
import { validateAndroidVersionCode, validateAndroidVersionName, readGradleAndroidVersion, assertAndroidVersionNotOlder } from './android-version.mjs';

function oneMatch(text, pattern, label) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Expected one ${label}; review the generated Android template`);
  return matches[0];
}

/** A narrowly scoped transformation of the checked Capacitor Android template. */
export function hardenAndroidManifest(source) {
  const uncommented = source.replace(/<!--[\s\S]*?-->/g, '');
  const permissionTags = uncommented.match(/<uses-permission(?:-sdk-\d+)?\b[^>]*>/g) || [];
  const permissions = permissionTags.map(tag => {
    const match = tag.match(/\bandroid:name\s*=\s*(["'])([^"']+)\1/);
    if (!match) throw new Error('Malformed Android permission declaration');
    return match[2];
  });
  if (permissions.length !== 1 || permissions[0] !== 'android.permission.INTERNET') {
    throw new Error('The companion must declare only android.permission.INTERNET; review added permissions');
  }
  const application = oneMatch(source, /<application\b[^>]*>/g, 'application element');
  if (/\bandroid:networkSecurityConfig\s*=/.test(application[0])) throw new Error('Custom network security configuration requires explicit review');
  let tag = application[0];
  for (const name of ['allowBackup', 'usesCleartextTraffic', 'fullBackupContent']) {
    const pattern = new RegExp(`\\bandroid:${name}\\s*=\\s*(["'])[^"']*\\1`, 'g');
    const matches = [...tag.matchAll(pattern)];
    if (matches.length > 1) throw new Error(`Duplicate Android ${name} attribute`);
    tag = matches.length ? tag.replace(pattern, `android:${name}="false"`) : tag.replace(/>$/, `\n        android:${name}="false">`);
  }
  const extractionPattern = /\bandroid:dataExtractionRules\s*=\s*(["'])([^"']*)\1/g;
  const extractionAttributes = [...tag.matchAll(extractionPattern)];
  if (extractionAttributes.length > 1 || extractionAttributes.some(match => match[2] !== '@xml/openaster_data_extraction_rules')) {
    throw new Error('Unknown Android data extraction policy requires explicit review');
  }
  if (!extractionAttributes.length) tag = tag.replace(/>$/, '\n        android:dataExtractionRules="@xml/openaster_data_extraction_rules">');
  let output = source.slice(0, application.index) + tag + source.slice(application.index + application[0].length);
  const permission = oneMatch(output, /<uses-permission(?:-sdk-\d+)?\b[^>]*>/g, 'permission element');
  if (permission.index > application.index) {
    output = output.slice(0, permission.index) + output.slice(permission.index + permission[0].length);
    output = output.slice(0, application.index) + permission[0] + '\n\n    ' + output.slice(application.index);
  }
  return output;
}

// Explicitly opt out of both cloud and device migration on Android 12+.
// Android's allowBackup=false alone can leave OEM device-to-device transfers enabled.
// Schema: https://developer.android.com/identity/data/autobackup#xml-config-syntax
export function androidDataExtractionRules() {
  const domains = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'];
  const exclusions = domains.map(domain => `        <exclude domain="${domain}" path="." />`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n    <cloud-backup disableIfNoEncryptionCapabilities="true">\n${exclusions}\n    </cloud-backup>\n    <device-transfer>\n${exclusions}\n    </device-transfer>\n</data-extraction-rules>\n`;
}

export function synchronizeAndroidVersion(source, version, versionCode) {
  validateAndroidVersionName(version);
  validateAndroidVersionCode(versionCode);
  assertAndroidVersionNotOlder({ versionName: version, versionCode }, readGradleAndroidVersion(source), 'the generated Android project');
  const namePattern = /^([ \t]*)versionName[ \t]+(["'])[^"'\r\n]+\2[ \t]*(\r?)$/gm;
  const codePattern = /^([ \t]*)versionCode[ \t]+\d+[ \t]*(\r?)$/gm;
  oneMatch(source, namePattern, 'versionName');
  oneMatch(source, codePattern, 'versionCode');
  return source.replace(namePattern, (_all, indent, _quote, carriage) => `${indent}versionName "${version}"${carriage}`)
    .replace(codePattern, (_all, indent, carriage) => `${indent}versionCode ${versionCode}${carriage}`);
}

/** Reject unknown sharing rules instead of silently retaining a broad storage grant. */
export function hardenAndroidFilePaths(source) {
  if (typeof source !== 'string') throw new Error('Android FileProvider paths must be XML text');
  const uncommented = source.replace(/<!--[\s\S]*?-->/g, '').trim();
  // Only the generated Capacitor template and our previous output are accepted.
  // Restricting the whole document also rejects extra roots, entities and attributes.
  const knownTemplate = /^(?:<\?xml version="1\.0" encoding="utf-8"\?>\s*)?<paths xmlns:android="http:\/\/schemas\.android\.com\/apk\/res\/android">\s*(?:<external-path name="my_images" path="\."\s*\/\s*>\s*)?<cache-path name="my_cache_images" path="(?:\.|shared\/)"\s*\/\s*>\s*<\/paths>$/;
  if (!knownTemplate.test(uncommented)) throw new Error('Unknown Android FileProvider paths template; review all sharing roots before continuing');
  return '<?xml version="1.0" encoding="utf-8"?>\n<paths xmlns:android="http://schemas.android.com/apk/res/android">\n    <cache-path name="my_cache_images" path="shared/" />\n</paths>\n';
}

async function requireRegularPath(root, relative, { allowMissing = false } = {}) {
  let current = path.resolve(root);
  if ((await lstat(current)).isSymbolicLink()) throw new Error('Android project must not be a symbolic link');
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) {
      if (allowMissing && index === parts.length - 1 && error.code === 'ENOENT') return current;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error('Android generated files must not contain symbolic links');
  }
  if (!(await lstat(current)).isFile()) throw new Error('Android generated target must be a regular file');
  return current;
}

export async function hardenAndroidProject({ projectDirectory, version, versionCode }) {
  validateAndroidVersionName(version);
  validateAndroidVersionCode(versionCode);
  const manifestFile = await requireRegularPath(projectDirectory, 'app/src/main/AndroidManifest.xml');
  const gradleFile = await requireRegularPath(projectDirectory, 'app/build.gradle');
  const filePathsFile = await requireRegularPath(projectDirectory, 'app/src/main/res/xml/file_paths.xml');
  const extractionFile = await requireRegularPath(projectDirectory, 'app/src/main/res/xml/openaster_data_extraction_rules.xml', { allowMissing: true });
  // Validate every transformation before changing any generated file.
  const manifest = hardenAndroidManifest(await readFile(manifestFile, 'utf8'));
  const gradle = synchronizeAndroidVersion(await readFile(gradleFile, 'utf8'), version, versionCode);
  const filePaths = hardenAndroidFilePaths(await readFile(filePathsFile, 'utf8'));
  const extraction = androidDataExtractionRules();
  let existingExtraction;
  try { existingExtraction = await readFile(extractionFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existingExtraction !== undefined && existingExtraction.replaceAll('\r\n', '\n').trim() !== extraction.trim()) {
    throw new Error('Unknown Android data extraction rules template; review before overwriting');
  }
  // Install the referenced policy before pointing the manifest at it.
  await writeFile(extractionFile, extraction);
  await writeFile(manifestFile, manifest);
  await writeFile(gradleFile, gradle);
  await writeFile(filePathsFile, filePaths);
  const branding = await brandAndroidProject(projectDirectory);
  return { allowBackup: false, usesCleartextTraffic: false, fullBackupContent: false, dataExtractionRules: '@xml/openaster_data_extraction_rules', versionName: version, versionCode, permissions: ['android.permission.INTERNET'], fileProviderCachePath: 'shared/', branding };
}
