// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readAppImageFile, readAppImageRuntime, validateAppImageObservation, sameAppImageFile,
  sameAppImageProgram, appImageRelaunchOptions } from './appimage-relaunch.mjs';

function fixture(t) {
  const parent = fs.realpathSync(tmpdir()), root = fs.mkdtempSync(path.join(parent, 'openaster-image-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const image = path.join(root, 'OpenAster.AppImage'), bytes = Buffer.alloc(128, 1);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes); bytes[8] = 0x41; bytes[9] = 0x49; bytes[10] = 2;
  fs.writeFileSync(image, bytes, { mode: 0o700 });
  function mount(name = 'mount-0') {
    const directory = path.join(root, name); fs.mkdirSync(path.join(directory, 'resources'), { recursive: true });
    const executable = path.join(directory, 'openaster'); fs.writeFileSync(executable, 'executable');
    fs.writeFileSync(path.join(directory, 'resources', 'app.asar'), 'archive');
    const options = { platform: 'linux', isPackaged: true, env: { APPIMAGE: image, APPDIR: directory }, executable };
    return { directory, executable, options, observe: () => readAppImageRuntime(options) };
  }
  return { root, image, bytes, mount };
}
const unsafe = { code: 'RELAUNCH_SMOKE_UNSAFE' };

test('ordinary Windows, macOS, DEB and source launches retain their original path selection', () => {
  for (const platform of ['win32', 'darwin']) assert.equal(readAppImageRuntime({ platform, isPackaged: true, env: { APPIMAGE: 'invalid' } }), null);
  assert.equal(readAppImageRuntime({ platform: 'linux', isPackaged: true, env: {} }), null);
  assert.equal(readAppImageRuntime({ platform: 'linux', isPackaged: false, env: { APPIMAGE: 'invalid' } }), null);
});

test('relaunch chooses the original outer image with an exact argument copy', t => {
  const f = fixture(t), runtime = f.mount(), observation = runtime.observe(), args = ['--smoke-phase=1', 'with spaces'];
  assert.deepEqual(appImageRelaunchOptions(observation, { ...runtime.options, args }), { execPath: f.image, args });
  assert.deepEqual(appImageRelaunchOptions(observation, runtime.options), { execPath: f.image, args: process.argv.slice(1) });
  assert.equal(sameAppImageFile(readAppImageFile(f.image), observation.image), true);
  assert.throws(() => appImageRelaunchOptions(observation, { ...runtime.options, args: ['bad\0arg'] }), unsafe);
});

test('new mount names with identical payload and original image preserve program identity; old observations need no old mount', t => {
  const f = fixture(t), first = f.mount(), observed = first.observe();
  const second = f.mount('mount-1'), current = second.observe();
  assert.notEqual(current.mount, observed.mount); assert.equal(sameAppImageProgram(observed, current), true);
  fs.rmSync(first.directory, { recursive: true });
  assert.equal(validateAppImageObservation(observed), observed);
  assert.equal(sameAppImageProgram(observed, current), true);
  assert.throws(() => appImageRelaunchOptions(observed, second.options), unsafe);
});

test('original image replacement, changed bytes and different images cannot inherit a launch identity', t => {
  const f = fixture(t), runtime = f.mount(), original = runtime.observe();
  const renamed = f.image + '.old'; fs.renameSync(f.image, renamed); fs.writeFileSync(f.image, f.bytes, { mode: 0o700 });
  assert.equal(sameAppImageFile(readAppImageFile(f.image), original.image), false);
  assert.throws(() => appImageRelaunchOptions(original, runtime.options), unsafe);
  const replaced = runtime.observe(), changed = Buffer.from(f.bytes); changed[40] ^= 1; fs.writeFileSync(f.image, changed);
  assert.throws(() => appImageRelaunchOptions(replaced, runtime.options), unsafe);
  const other = path.join(f.root, 'Other.AppImage'); fs.writeFileSync(other, changed, { mode: 0o700 });
  assert.equal(sameAppImageProgram(runtime.observe(), readAppImageRuntime({ ...runtime.options, env: { ...runtime.options.env, APPIMAGE: other } })), false);
});

test('current executable and archive content are both verified before a relaunch', t => {
  const f = fixture(t), runtime = f.mount(), original = runtime.observe();
  fs.writeFileSync(runtime.executable, 'modified executable');
  assert.throws(() => appImageRelaunchOptions(original, runtime.options), unsafe);
  fs.writeFileSync(runtime.executable, 'executable'); fs.writeFileSync(path.join(runtime.directory, 'resources', 'app.asar'), 'modified archive');
  assert.throws(() => appImageRelaunchOptions(original, runtime.options), unsafe);
  assert.throws(() => readAppImageRuntime({ ...runtime.options, executable: f.image }), unsafe);
});

test('image and payload aliases, unsafe ancestors, malformed type and incomplete environments are refused', t => {
  const f = fixture(t), runtime = f.mount();
  for (const env of [{ APPIMAGE: f.image }, { APPDIR: runtime.directory }]) assert.throws(() => readAppImageRuntime({ ...runtime.options, env }), unsafe);
  assert.throws(() => readAppImageFile('relative.AppImage'), unsafe);
  const alias = path.join(f.root, 'alias'); fs.linkSync(f.image, alias);
  assert.throws(() => runtime.observe(), unsafe); fs.unlinkSync(alias);
  fs.linkSync(runtime.executable, alias); assert.throws(() => runtime.observe(), unsafe); fs.unlinkSync(alias);
  fs.symlinkSync(runtime.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readAppImageRuntime({ ...runtime.options, env: { APPIMAGE: f.image, APPDIR: alias }, executable: path.join(alias, 'openaster') }), unsafe);
  fs.unlinkSync(alias); fs.writeFileSync(f.image, 'not an AppImage'); assert.throws(() => readAppImageFile(f.image), unsafe);
});

test('image mutation during the hash read is rejected and no unbounded second read occurs', t => {
  const f = fixture(t), original = fs.readSync; let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = original(...args);
    if (!changed) { changed = true; fs.appendFileSync(f.image, 'extra'); }
    return count;
  });
  assert.throws(() => readAppImageFile(f.image), unsafe);
});

test('Linux writable-by-others images cannot become relaunch targets', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t); fs.chmodSync(f.image, 0o777); assert.throws(() => readAppImageFile(f.image), unsafe);
});
