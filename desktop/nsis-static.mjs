// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const packagingRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const { UninstallerReader, nsisTemplatesDir } = packagingRequire('./out/targets/nsis/nsisUtil.js');
const configured = Symbol('openaster-static-nsis-uninstaller');

/** Use the builder's binary parser to generate the uninstaller without launching the build stub. */
export function configureStaticUninstaller(target, { read = readFile, extract = UninstallerReader.exec } = {}) {
  if (target.name !== 'nsis' || target[configured]) return;
  if (typeof target.computeScriptAndSignUninstaller !== 'function' || target.computeScriptAndSignUninstaller.length !== 5) {
    throw new Error('Unsupported NSIS contract; revalidate the static uninstaller adapter');
  }
  target.computeScriptAndSignUninstaller = async function (defines, commands, installerPath, sharedHeader, architectures) {
    if (await this.packager.getResource(this.options.script, 'installer.nsi')) {
      throw new Error('Static uninstaller extraction requires the standard NSIS template');
    }
    const outputDirectory = path.resolve(this.outDir);
    if (path.dirname(path.resolve(installerPath)) !== outputDirectory || path.extname(installerPath).toLowerCase() !== '.exe') {
      throw new Error('Refusing an NSIS output outside the build directory');
    }
    const script = await read(path.join(nsisTemplatesDir, 'installer.nsi'), 'utf8');
    const uninstaller = path.join(outputDirectory, `${path.basename(installerPath, 'exe')}__uninstaller.exe`);
    defines.BUILD_UNINSTALLER = null;
    defines.UNINSTALLER_OUT_FILE = uninstaller;
    try {
      await this.executeMakensis(defines, commands, sharedHeader + await this.computeFinalScript(script, false, architectures));
      await extract(installerPath, uninstaller);
      await this.packager.signIf(uninstaller);
      return { script, isCustomScript: false };
    } finally {
      delete defines.BUILD_UNINSTALLER;
    }
  };
  target[configured] = true;
}
