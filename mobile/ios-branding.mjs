// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const supportedCapacitor = '8.5.3';
const catalogRelative = 'App/App/Assets.xcassets/AppIcon.appiconset';
const iconFilename = 'AppIcon-512@2x.png';
// Both unmodified Capacitor 8.5.3 iOS templates contain these exact public assets.
const templateIconSha256 = '29e4777e319de3ee5a52c3a8004ec19d0568414004257e36d7c94a077d71c93b';
const templateCatalogSha256 = '5c09bec6eede599b14fa9e4c44b03e7febebc930615a0cd70f02981c09dfe48a';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

async function directoryChain(directory) {
  const root = path.parse(directory).root;
  let current = root;
  const result = [];
  for (const component of ['', ...path.relative(root, directory).split(path.sep)]) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('iOS icon parents must be real directories without links');
    result.push({ filename: current, stat });
  }
  if (!samePath(await realpath(directory), directory)) throw new Error('iOS icon directory must be canonical');
  return result;
}

async function checkDirectories(directories) {
  for (const { filename, stat } of directories) {
    const current = await lstat(filename);
    if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(current, stat)) {
      throw new Error('iOS icon parent identity changed');
    }
  }
}

async function checkFile(filename, handle, previous) {
  const [named, opened] = await Promise.all([lstat(filename), handle.stat()]);
  if (named.isSymbolicLink() || !named.isFile() || !opened.isFile() || named.nlink !== 1 || opened.nlink !== 1
    || !sameIdentity(named, opened) || (previous && !sameIdentity(previous, opened))) {
    throw new Error('iOS icon inputs must be regular single-link files with unchanged identity');
  }
  return opened;
}

async function readHandle(handle) {
  const stat = await handle.stat();
  if (stat.size < 1 || stat.size > 5 * 1024 * 1024) throw new Error('Unexpected iOS icon input size');
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) throw new Error('iOS icon input changed during reading');
    offset += bytesRead;
  }
  if ((await handle.stat()).size !== bytes.length) throw new Error('iOS icon input size changed');
  return bytes;
}

async function readInput(filename) {
  const directories = await directoryChain(path.dirname(filename));
  const handle = await open(filename, 'r');
  try {
    const stat = await checkFile(filename, handle);
    const bytes = await readHandle(handle);
    await checkDirectories(directories);
    await checkFile(filename, handle, stat);
    return bytes;
  } finally { await handle.close(); }
}

/** Validate the checked-in raster and its source provenance before touching a native project. */
export function validateIOSBrandingAsset({ manifest, source, asset, capacitorVersion, iosVersion }) {
  if (capacitorVersion !== supportedCapacitor || iosVersion !== supportedCapacitor) {
    throw new Error('Revalidate iOS branding for the installed Capacitor version');
  }
  if (manifest?.version !== 1 || manifest.source?.file !== 'public/icon.svg'
    || manifest.asset?.file !== 'mobile/resources/ios-icon-1024.png'
    || manifest.source.sha256 !== digest(source) || manifest.asset.sha256 !== digest(asset)
    || manifest.asset.bytes !== asset.length || manifest.asset.width !== 1024 || manifest.asset.height !== 1024
    || manifest.asset.colorType !== 2) throw new Error('iOS icon provenance does not match the current source and raster');
  if (asset.length < 33 || !asset.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || asset.readUInt32BE(8) !== 13 || asset.toString('ascii', 12, 16) !== 'IHDR'
    || asset.readUInt32BE(16) !== 1024 || asset.readUInt32BE(20) !== 1024
    || asset[24] !== 8 || asset[25] !== 2 || asset[26] !== 0 || asset[27] !== 0 || asset[28] !== 0) {
    throw new Error('iOS app icon must be a non-interlaced 1024 by 1024 RGB PNG');
  }
  // RGB PNGs can still declare transparency via tRNS; app icons must remain opaque.
  let offset = 8, imageData = false, ended = false;
  while (offset + 12 <= asset.length) {
    const length = asset.readUInt32BE(offset);
    const type = asset.toString('ascii', offset + 4, offset + 8);
    if (offset + 12 + length > asset.length || type === 'tRNS') throw new Error('iOS app icon has invalid or transparent PNG chunks');
    if (type === 'IDAT') imageData = true;
    offset += 12 + length;
    if (type === 'IEND') { ended = length === 0 && offset === asset.length; break; }
  }
  if (!imageData || !ended) throw new Error('iOS app icon has incomplete PNG image data');
  return { sourceSha256: manifest.source.sha256, assetSha256: manifest.asset.sha256 };
}

/** Replace only the pinned template icon, preserving the exact native asset catalog. */
export async function synchronizeIOSBranding(projectDirectory) {
  if (typeof projectDirectory !== 'string' || !path.isAbsolute(projectDirectory)) throw new Error('iOS project directory must be absolute');
  const root = path.resolve(projectDirectory);
  if ([path.parse(root).root, homedir(), repository, path.join(repository, 'mobile')].some(unsafe => samePath(root, path.resolve(unsafe)))) {
    throw new Error('Unsafe iOS project root');
  }
  const [manifestBytes, source, asset, cliPackage, iosPackage] = await Promise.all([
    readInput(path.join(repository, 'mobile/resources/ios-icon.json')),
    readInput(path.join(repository, 'public/icon.svg')),
    readInput(path.join(repository, 'mobile/resources/ios-icon-1024.png')),
    // Package-manager metadata may legitimately be hard-linked; it is read only.
    realpath(require.resolve('@capacitor/cli/package.json')).then(filename => readFile(filename)),
    realpath(require.resolve('@capacitor/ios/package.json')).then(filename => readFile(filename)),
  ]);
  const provenance = validateIOSBrandingAsset({ manifest: JSON.parse(manifestBytes), source, asset,
    capacitorVersion: JSON.parse(cliPackage).version, iosVersion: JSON.parse(iosPackage).version });
  const catalog = path.join(root, catalogRelative);
  const directories = await directoryChain(catalog);
  const expectedMembers = ['Contents.json', iconFilename].sort();
  const checkMembers = async () => {
    if (JSON.stringify((await readdir(catalog)).sort()) !== JSON.stringify(expectedMembers)) {
      throw new Error('Unknown iOS app icon catalog members; review native customizations');
    }
  };
  await checkMembers();
  const contentsPath = path.join(catalog, 'Contents.json');
  const iconPath = path.join(catalog, iconFilename);
  const contentsHandle = await open(contentsPath, 'r');
  let iconHandle;
  try {
    const contentsStat = await checkFile(contentsPath, contentsHandle);
    const contents = await readHandle(contentsHandle);
    if (digest(contents) !== templateCatalogSha256) throw new Error('Unknown iOS app icon catalog; review native customizations');
    iconHandle = await open(iconPath, 'r+');
    const iconStat = await checkFile(iconPath, iconHandle);
    const previous = await readHandle(iconHandle);
    if (digest(previous) !== templateIconSha256 && !previous.equals(asset)) {
      throw new Error('Unknown iOS app icon; review native customizations');
    }
    await checkDirectories(directories);
    await checkMembers();
    await checkFile(contentsPath, contentsHandle, contentsStat);
    await checkFile(iconPath, iconHandle, iconStat);
    if (!(await readHandle(contentsHandle)).equals(contents) || !(await readHandle(iconHandle)).equals(previous)) {
      throw new Error('iOS app icon inputs changed before replacement');
    }
    const changed = !previous.equals(asset);
    if (changed) {
      let offset = 0;
      while (offset < asset.length) {
        const { bytesWritten } = await iconHandle.write(asset, offset, asset.length - offset, offset);
        if (!bytesWritten) throw new Error('Incomplete iOS app icon write');
        offset += bytesWritten;
      }
      await iconHandle.truncate(asset.length);
      await iconHandle.sync();
      await checkDirectories(directories);
      await checkFile(iconPath, iconHandle, iconStat);
      if (!(await readHandle(iconHandle)).equals(asset)) throw new Error('iOS app icon verification failed');
    }
    return { changed, file: `${catalogRelative}/${iconFilename}`, ...provenance };
  } finally {
    await iconHandle?.close();
    await contentsHandle.close();
  }
}
