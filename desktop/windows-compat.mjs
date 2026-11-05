// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { configureStaticUninstaller } from './nsis-static.mjs';

const require = createRequire(import.meta.url);
const installedBuilderVersion = require('electron-builder/package.json').version;
const wrapped = Symbol('openaster-preserve-runtime-identity');

/** Preserve Electron's two binary identity fields while keeping branding and signing enabled. */
export function preserveWindowsRuntimeIdentity(packager) {
  if (packager[wrapped]) return;
  const original = packager.signAndEditResources;
  if (typeof original !== 'function' || original.length !== 5) {
    throw new Error('Unsupported Windows resource editor contract; review desktop/windows-compat.mjs before packaging');
  }
  packager.signAndEditResources = function (file, arch, outDir, _internalName, requestedExecutionLevel) {
    // electron-builder 26.18's null branch leaves InternalName and OriginalFilename intact.
    // Product name, file description, versions, icon, ASAR integrity, fuses and signing stay enabled.
    return original.call(this, file, arch, outDir, null, requestedExecutionLevel);
  };
  packager[wrapped] = true;
}

export default async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  if (installedBuilderVersion !== '26.18.0') {
    throw new Error(`Revalidate the Windows resource compatibility hook for electron-builder ${installedBuilderVersion}`);
  }
  preserveWindowsRuntimeIdentity(context.packager);
  for (const target of context.targets || []) configureStaticUninstaller(target);
}
