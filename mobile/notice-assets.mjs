// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const digest = text => createHash('sha256').update(text).digest('hex');
const invalid = message => { throw new Error('Android notice asset: ' + message); };
export function validateAndroidNoticeAsset(bytes, packageInfo) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 2 * 1024 * 1024) invalid('expected bounded UTF-8 JSON');
  let asset;
  try { asset = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid('invalid UTF-8 JSON'); }
  if (asset?.schemaVersion !== 1 || asset.platform !== 'android' || !Array.isArray(asset.licenses) || !asset.licenses.length || !Array.isArray(asset.components) || !asset.components.length) invalid('missing platform, components or licenses');
  const ids = new Set();
  for (const license of asset.licenses) {
    if (typeof license.id !== 'string' || !license.id || ids.has(license.id) || typeof license.text !== 'string' || !license.text.trim() || digest(license.text) !== license.sha256) invalid('invalid or changed license text');
    ids.add(license.id);
  }
  const components = new Set();
  for (const component of asset.components) {
    if (typeof component.id !== 'string' || components.has(component.id) || typeof component.name !== 'string' || !component.name || typeof component.version !== 'string' || !component.version || !Array.isArray(component.licenseIds) || !component.licenseIds.length || component.licenseIds.some(id => !ids.has(id))) invalid('invalid component or license reference');
    components.add(component.id);
    if (!Array.isArray(component.notices)) invalid('missing component notice list');
    for (const notice of component.notices) if (typeof notice.text !== 'string' || !notice.text.trim() || digest(notice.text) !== notice.sha256) invalid('invalid or changed notice text');
  }
  for (const name of ['@capacitor/android', '@capacitor/core']) {
    const entries = asset.components.filter(component => component.kind === 'npm' && component.name === name);
    if (entries.length !== 1 || entries[0].version !== packageInfo?.devDependencies?.[name]) invalid('regenerate notices for configured ' + name + ' version');
  }
  if (asset.counts?.components !== asset.components.length) invalid('component count mismatch');
  return asset;
}
export async function readAndroidNoticeAsset(assetFile, packageFile) {
  const [bytes, packageBytes] = await Promise.all([readFile(assetFile), readFile(packageFile, 'utf8')]);
  validateAndroidNoticeAsset(bytes, JSON.parse(packageBytes));
  return bytes;
}
