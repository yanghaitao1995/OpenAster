// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const fail = message => Object.assign(new Error(message), { code: 'UNSAFE_SMOKE_STAGING' });
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (parent, child) => { const relative = path.relative(key(parent), key(child)); return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function ordinary(location, kind) {
  const value = await fs.lstat(location, { bigint: true });
  if (value.isSymbolicLink() || !(kind === 'directory' ? value.isDirectory() : value.isFile())) throw fail(`Expected an ordinary ${kind}: ${location}`);
  return value;
}
async function ownerDirectory(directory, owner, expected) {
  if (typeof owner !== 'string' || !/^[a-f0-9]{64}$/.test(owner) || !path.isAbsolute(directory)) throw fail('Invalid smoke staging ownership.');
  const temporaryRoot = await fs.realpath(tmpdir());
  const current = await ordinary(directory, 'directory'), canonical = await fs.realpath(directory);
  if (key(canonical) !== key(path.resolve(directory)) || key(path.dirname(canonical)) !== key(temporaryRoot) || !/^openaster-binary-[a-zA-Z0-9]+$/.test(path.basename(canonical)) || (expected && !sameFile(current, expected))) throw fail('Staging must remain the owned direct temporary child.');
  const marker = path.join(canonical, '.smoke-owner'), info = await ordinary(marker, 'file');
  if (info.nlink !== 1n || info.size !== 64n || await fs.readFile(marker, 'utf8') !== owner) throw fail('Smoke staging owner marker does not match.');
  return { canonical, identity: current };
}

async function layout(executable, platform) {
  if (!['win32', 'linux', 'darwin'].includes(platform) || typeof executable !== 'string' || !path.isAbsolute(executable)) throw fail('Unsupported smoke staging platform or executable.');
  await ordinary(executable, 'file');
  const requested = path.resolve(executable);
  if (platform !== 'darwin') {
    const source = await fs.realpath(path.dirname(requested));
    if (key(await fs.realpath(requested)) !== key(path.join(source, path.basename(requested)))) throw fail('Executable resolves outside its distribution directory.');
    return { source, relativeExecutable: path.basename(requested), bundleName: null };
  }
  const macOS = path.dirname(requested), contents = path.dirname(macOS), bundle = path.dirname(contents);
  if (path.basename(macOS) !== 'MacOS' || path.basename(contents) !== 'Contents' || !/^.+\.app$/.test(path.basename(bundle))) throw fail('macOS staging requires a .app/Contents/MacOS executable.');
  const source = await fs.realpath(bundle), relativeExecutable = path.join('Contents', 'MacOS', path.basename(requested));
  await ordinary(bundle, 'directory');
  for (const component of ['Contents', 'Contents/MacOS', 'Contents/Frameworks', 'Contents/Resources']) await ordinary(path.join(source, component), 'directory');
  await ordinary(path.join(source, 'Contents', 'Info.plist'), 'file');
  if (key(await fs.realpath(requested)) !== key(path.join(source, relativeExecutable))) throw fail('macOS executable resolves outside the expected bundle layout.');
  return { source, relativeExecutable, bundleName: path.basename(bundle) };
}

/** Inventory links without following them during traversal. Closed relative
 * links are safe to reproduce verbatim; absolute/escaping/dangling links would
 * bind a staged application back to the source or outside the owned copy.
 */
async function inventory(root) {
  const entries = new Map();
  async function visit(directory) {
    for (const name of await fs.readdir(directory)) {
      const location = path.join(directory, name), relative = path.relative(root, location);
      const info = await fs.lstat(location);
      if (info.isSymbolicLink()) {
        const target = await fs.readlink(location);
        if (path.isAbsolute(target) || path.win32.isAbsolute(target) || !inside(root, path.resolve(directory, target))) throw fail(`Application link must stay relative to its copied tree: ${relative}`);
        let canonical;
        try { canonical = await fs.realpath(location); } catch { throw fail(`Application link is dangling or cyclic: ${relative}`); }
        if (!inside(root, canonical)) throw fail(`Application link resolves outside its copied tree: ${relative}`);
        entries.set(relative, { type: 'link', target });
      } else if (info.isDirectory()) {
        entries.set(relative, { type: 'directory' }); await visit(location);
      } else if (info.isFile()) entries.set(relative, { type: 'file', size: info.size });
      else throw fail(`Unsupported application entry: ${relative}`);
    }
  }
  await visit(root); return entries;
}
function equalInventory(expected, actual) {
  return expected.size === actual.size && [...expected].every(([name, value]) => JSON.stringify(value) === JSON.stringify(actual.get(name)));
}

/** Copies only into a caller-created, owner-marked temporary directory. It never
 * launches applications or removes files; runner cleanup retains that ownership.
 */
export async function stageDesktopExecutable({ executable, directory, owner, platform = process.platform }) {
  const owned = await ownerDirectory(directory, owner);
  if ((await fs.readdir(owned.canonical)).some(name => name !== '.smoke-owner')) throw fail('Smoke staging directory is not empty.');
  const source = await layout(executable, platform);
  if (inside(source.source, owned.canonical) || inside(owned.canonical, source.source)) throw fail('Application source and staging directory overlap.');
  const original = await inventory(source.source);
  const appDirectory = path.join(owned.canonical, 'app');
  const destination = source.bundleName ? path.join(appDirectory, source.bundleName) : appDirectory;
  await ownerDirectory(directory, owner, owned.identity);
  await fs.mkdir(appDirectory);
  const appIdentity = await ordinary(appDirectory, 'directory');
  if (source.bundleName) await fs.mkdir(destination);
  const destinationIdentity = await ordinary(destination, 'directory');
  // Node fs.cp otherwise resolves relative symlinks into source-absolute paths.
  // https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisescpsrc-dest-options
  for (const name of await fs.readdir(source.source)) {
    await ownerDirectory(directory, owner, owned.identity);
    if (!sameFile(await ordinary(appDirectory, 'directory'), appIdentity) || !sameFile(await ordinary(destination, 'directory'), destinationIdentity)) throw fail('Staging destination directories were replaced.');
    await fs.cp(path.join(source.source, name), path.join(destination, name), { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
  }
  await ownerDirectory(directory, owner, owned.identity);
  if (!sameFile(await ordinary(appDirectory, 'directory'), appIdentity) || !sameFile(await ordinary(destination, 'directory'), destinationIdentity)) throw fail('Staging destination directories were replaced.');
  if (!equalInventory(original, await inventory(source.source)) || !equalInventory(original, await inventory(destination))) throw fail('Application layout or relative links changed while staging.');
  if ((await fs.readdir(owned.canonical)).some(name => !['.smoke-owner', 'app'].includes(name))) throw fail('Unknown files appeared in the staging directory.');
  const stagedExecutable = path.join(destination, source.relativeExecutable);
  await ordinary(stagedExecutable, 'file');
  return { executable: stagedExecutable, sourceDirectory: source.source, stagedDirectory: destination, layout: source.bundleName ? 'macos-bundle' : 'directory' };
}
