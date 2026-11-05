// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { stageDesktopExecutable } from '../scripts/desktop-smoke-staging.mjs';

async function fixture(t) {
  const temporaryRoot = await fs.realpath(tmpdir());
  const source = await fs.mkdtemp(path.join(temporaryRoot, 'openaster-stage-source-'));
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'openaster-binary-'));
  const owner = randomBytes(32).toString('hex');
  await fs.writeFile(path.join(directory, '.smoke-owner'), owner, { flag: 'wx' });
  const roots = [source, directory];
  t.after(async () => {
    for (const root of roots) {
      assert.equal(path.dirname(await fs.realpath(root)), temporaryRoot);
      assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  return { source, directory, owner, options: { directory, owner } };
}
async function file(root, relative, value = relative) {
  const location = path.join(root, relative); await fs.mkdir(path.dirname(location), { recursive: true }); await fs.writeFile(location, value); return location;
}
async function bundle(f) {
  const app = path.join(f.source, 'Open Aster.app');
  const executable = await file(app, 'Contents/MacOS/Open Aster', 'synthetic Mach-O placeholder; never executed');
  await file(app, 'Contents/Info.plist', '<plist><dict/></plist>');
  await file(app, 'Contents/Resources/app.asar', 'synthetic archive');
  await file(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'framework payload');
  await file(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/resource.pak', 'framework resource');
  await file(app, 'Contents/Frameworks/Open Aster Helper.app/Contents/MacOS/Open Aster Helper', 'helper payload');
  return { app, executable, framework: path.join(app, 'Contents/Frameworks/Electron Framework.framework') };
}
const missing = location => assert.rejects(fs.lstat(location), { code: 'ENOENT' });

test('macOS stages the whole synthetic app bundle and keeps its executable relative path', async t => {
  const f = await fixture(t), original = await bundle(f);
  await file(f.source, 'unrelated.txt', 'do not copy parent siblings');
  const staged = await stageDesktopExecutable({ ...f.options, executable: original.executable, platform: 'darwin' });
  assert.equal(staged.layout, 'macos-bundle');
  assert.equal(staged.stagedDirectory, path.join(f.directory, 'app', 'Open Aster.app'));
  assert.equal(staged.executable, path.join(staged.stagedDirectory, 'Contents/MacOS/Open Aster'));
  for (const relative of ['Contents/MacOS/Open Aster', 'Contents/Info.plist', 'Contents/Resources/app.asar', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/resource.pak', 'Contents/Frameworks/Open Aster Helper.app/Contents/MacOS/Open Aster Helper']) {
    assert.deepEqual(await fs.readFile(path.join(staged.stagedDirectory, relative)), await fs.readFile(path.join(original.app, relative)));
  }
  await missing(path.join(f.directory, 'app', 'unrelated.txt'));
  assert.equal(await fs.readFile(path.join(f.source, 'unrelated.txt'), 'utf8'), 'do not copy parent siblings');
});

for (const platform of ['win32', 'linux']) test(`${platform} keeps the executable-directory staging layout`, async t => {
  const f = await fixture(t), executable = await file(f.source, platform === 'win32' ? 'OpenAster.exe' : 'openaster', 'binary placeholder');
  await file(f.source, 'resources/app.asar', 'application'); await file(f.source, 'locales/zh-CN.pak', 'locale');
  const staged = await stageDesktopExecutable({ ...f.options, executable, platform });
  assert.equal(staged.layout, 'directory'); assert.equal(staged.executable, path.join(f.directory, 'app', path.basename(executable)));
  assert.equal(await fs.readFile(path.join(f.directory, 'app/resources/app.asar'), 'utf8'), 'application');
  assert.equal(await fs.readFile(path.join(f.directory, 'app/locales/zh-CN.pak'), 'utf8'), 'locale');
});

test('copy contract disables link dereferencing and preserves relative link text verbatim', async t => {
  const f = await fixture(t), original = await bundle(f), copy = fs.cp;
  const observed = [];
  const mock = t.mock.method(fs, 'cp', async (source, destination, options) => { observed.push({ source, destination, options }); return copy(source, destination, options); });
  await stageDesktopExecutable({ ...f.options, executable: original.executable, platform: 'darwin' }); mock.mock.restore();
  assert.equal(observed.length, 1); assert.equal(observed[0].source, path.join(original.app, 'Contents')); assert.equal(observed[0].destination, path.join(f.directory, 'app/Open Aster.app/Contents'));
  assert.deepEqual(observed[0].options, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
});

test('synthetic framework relative links remain relative and resolve wholly inside the copied app', async t => {
  const f = await fixture(t), original = await bundle(f);
  const links = [['Versions/Current', 'A', 'dir'], ['Electron Framework', 'Versions/Current/Electron Framework', 'file'], ['Resources', 'Versions/Current/Resources', 'dir']];
  try { for (const [name, target, type] of links) await fs.symlink(target, path.join(original.framework, name), type); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('Windows account cannot create relative file/directory symlinks; the separately executed cp-option contract and full synthetic bundle copy remain covered. No policy or ACL changes.'); return;
    }
    throw error;
  }
  const staged = await stageDesktopExecutable({ ...f.options, executable: original.executable, platform: 'darwin' });
  const destination = path.join(staged.stagedDirectory, 'Contents/Frameworks/Electron Framework.framework');
  for (const [name, target] of links) {
    const link = path.join(destination, name);
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true); assert.equal(await fs.readlink(link), target);
    assert.equal(path.isAbsolute(await fs.readlink(link)), false);
    assert.ok((await fs.realpath(link)).startsWith(staged.stagedDirectory + path.sep));
    assert.equal(await fs.readlink(path.join(original.framework, name)), target);
  }
  assert.equal(await fs.readFile(path.join(destination, 'Resources/resource.pak'), 'utf8'), 'framework resource');
});

test('macOS rejects incomplete bundles and executables outside the canonical app layout before copying', async t => {
  const f = await fixture(t), original = await bundle(f);
  const incomplete = path.join(f.source, 'Resources.saved'); await fs.rename(path.join(original.app, 'Contents/Resources'), incomplete);
  await assert.rejects(stageDesktopExecutable({ ...f.options, executable: original.executable, platform: 'darwin' }), { code: 'ENOENT' });
  await missing(path.join(f.directory, 'app'));
  await fs.rename(incomplete, path.join(original.app, 'Contents/Resources'));
  const arbitrary = await file(f.source, 'MacOS/OpenAster', 'not a bundle');
  await assert.rejects(stageDesktopExecutable({ ...f.options, executable: arbitrary, platform: 'darwin' }), { code: 'UNSAFE_SMOKE_STAGING' });
  await missing(path.join(f.directory, 'app'));
});

test('staging refuses non-owned, populated, or linked temporary destinations without touching their contents', async t => {
  const f = await fixture(t), executable = await file(f.source, 'openaster', 'source');
  await assert.rejects(stageDesktopExecutable({ ...f.options, executable, owner: 'f'.repeat(64), platform: 'linux' }), { code: 'UNSAFE_SMOKE_STAGING' });
  await fs.writeFile(path.join(f.directory, 'unknown.txt'), 'keep');
  await assert.rejects(stageDesktopExecutable({ ...f.options, executable, platform: 'linux' }), { code: 'UNSAFE_SMOKE_STAGING' });
  assert.equal(await fs.readFile(path.join(f.directory, 'unknown.txt'), 'utf8'), 'keep');
  await fs.unlink(path.join(f.directory, 'unknown.txt'));
  const alias = path.join(f.source, 'alias'); await fs.symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageDesktopExecutable({ executable, directory: alias, owner: f.owner, platform: 'linux' }), { code: 'UNSAFE_SMOKE_STAGING' });
  await missing(path.join(f.directory, 'app'));
});

test('staging rejects source/destination overlap and marker hardlinks', async t => {
  const f = await fixture(t), executable = await file(f.source, 'openaster', 'source');
  const marker = path.join(f.directory, '.smoke-owner'), alias = path.join(f.source, 'owner-alias'); await fs.link(marker, alias);
  await assert.rejects(stageDesktopExecutable({ ...f.options, executable, platform: 'linux' }), { code: 'UNSAFE_SMOKE_STAGING' });
  await fs.unlink(alias);
  // The owner marker itself is an ordinary file, but its parent may never be
  // used as the source distribution for a recursive self-copy.
  await assert.rejects(stageDesktopExecutable({ ...f.options, executable: marker, platform: 'linux' }), { code: 'UNSAFE_SMOKE_STAGING' });
  await missing(path.join(f.directory, 'app'));
});

test('absolute or escaping links cannot make the staged app depend on the original tree', async t => {
  const f = await fixture(t), original = await bundle(f);
  const linked = path.join(original.framework, 'absolute-link');
  await fs.symlink(path.join(original.framework, 'Versions/A'), linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageDesktopExecutable({ ...f.options, executable: original.executable, platform: 'darwin' }), { code: 'UNSAFE_SMOKE_STAGING' });
  await missing(path.join(f.directory, 'app'));
  assert.equal(await fs.readFile(path.join(original.framework, 'Versions/A/Electron Framework'), 'utf8'), 'framework payload');
});

test('a changed owner during copying fails closed and preserves all output for the owning runner', async t => {
  const f = await fixture(t), executable = await file(f.source, 'openaster', 'source'), copy = fs.cp;
  const mock = t.mock.method(fs, 'cp', async (...args) => { await copy(...args); await fs.writeFile(path.join(f.directory, '.smoke-owner'), 'e'.repeat(64)); });
  await assert.rejects(stageDesktopExecutable({ ...f.options, executable, platform: 'linux' }), { code: 'UNSAFE_SMOKE_STAGING' }); mock.mock.restore();
  assert.equal(await fs.readFile(path.join(f.directory, 'app/openaster'), 'utf8'), 'source');
  assert.equal(await fs.readFile(executable, 'utf8'), 'source');
});

test('post-copy validation rejects a link rewritten back into the original bundle', async t => {
  const f = await fixture(t), original = await bundle(f), copy = fs.cp;
  const mock = t.mock.method(fs, 'cp', async (source, destination, options) => {
    await copy(source, destination, options);
    await fs.symlink(original.framework, path.join(destination, 'Frameworks', 'source-reference'), process.platform === 'win32' ? 'junction' : 'dir');
  });
  await assert.rejects(stageDesktopExecutable({ ...f.options, executable: original.executable, platform: 'darwin' }), { code: 'UNSAFE_SMOKE_STAGING' });
  mock.mock.restore();
  assert.equal(await fs.readFile(path.join(original.framework, 'Versions/A/Electron Framework'), 'utf8'), 'framework payload');
  assert.equal((await fs.lstat(path.join(f.directory, 'app/Open Aster.app/Contents/Frameworks/source-reference'))).isSymbolicLink(), true);
});

test('both runners invoke the shared staging helper instead of copying MacOS alone', async () => {
  for (const name of ['desktop-smoke.mjs', 'desktop-relaunch-smoke.mjs']) {
    const source = await fs.readFile(new URL('../scripts/' + name, import.meta.url), 'utf8');
    assert.match(source, /stageDesktopExecutable\(\{ executable: originalExecutable, directory: binaryDirectory, owner \}\)/);
    assert.doesNotMatch(source, /cp\(path\.dirname\(originalExecutable\)/);
  }
});
