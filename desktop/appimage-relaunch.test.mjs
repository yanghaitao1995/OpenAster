// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Duplex, PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readAppImageFile, readAppImageRuntime, validateAppImageObservation, sameAppImageFile,
  sameAppImageProgram, appImageRelaunchOptions, sendAppImageHandoff, receiveAppImageHandoff,
  waitForAppImageParentExit, readAppImageProcessIdentity, acceptAppImageRelaunch } from './appimage-relaunch.mjs';

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

const handoffFailed = { code: 'APPIMAGE_HANDOFF_FAILED' };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const parentIdentity = { pid: 810001, uid: 1000, started: '100' };
const noProcess = () => { throw Object.assign(new Error('private'), { code: 'ESRCH' }); };
function channels(t) {
  const one = new PassThrough(), two = new PassThrough();
  const sender = Duplex.from({ readable: one, writable: two }), receiver = Duplex.from({ readable: two, writable: one });
  sender.on('error', () => {}); receiver.on('error', () => {});
  t.after(() => { sender.destroy(); receiver.destroy(); });
  return { sender, receiver };
}

test('handoff ACK releases the predecessor but successor remains gated until exact predecessor exit', async t => {
  const f = fixture(t), runtime = f.mount(), observation = runtime.observe(), exit = gate(), entered = gate(), verified = [];
  const { sender, receiver } = channels(t);
  const receiving = receiveAppImageHandoff(receiver, { observation, pid: 810002, parentPid: parentIdentity.pid, uid: parentIdentity.uid,
    readIdentity: () => parentIdentity, noNewPrivileges: false,
    waitForExit: async value => { assert.deepEqual(value, parentIdentity); entered.resolve(); await exit.promise; },
    verifyCurrent: () => { verified.push('workspace-release'); return runtime.observe(); } });
  assert.equal(await sendAppImageHandoff(sender, { observation, parent: parentIdentity, childPid: 810002 }), false);
  await entered.promise; assert.deepEqual(verified, []);
  exit.resolve(); await receiving; assert.deepEqual(verified, ['workspace-release']);
});

test('successor refuses unrelated parent, replaced parent and different image before ACK', async t => {
  for (const change of ['parent', 'started', 'image', 'extra']) {
    const f = fixture(t), runtime = f.mount(), observation = runtime.observe(), { sender, receiver } = channels(t);
    const message = { version: 1, nonce: 'a'.repeat(64), parent: { ...parentIdentity }, observation };
    if (change === 'parent') message.parent.pid++;
    if (change === 'started') message.parent.started = '101';
    if (change === 'image') message.observation = { ...observation, image: { ...observation.image, sha256: 'f'.repeat(64) } };
    if (change === 'extra') message.secret = 'private';
    let waited = false;
    const receiving = receiveAppImageHandoff(receiver, { observation, pid: 810002, parentPid: parentIdentity.pid, uid: parentIdentity.uid,
      readIdentity: () => parentIdentity, waitForExit: async () => { waited = true; } });
    sender.write(JSON.stringify(message) + '\n');
    await assert.rejects(receiving, handoffFailed); assert.equal(waited, false);
  }
});

test('sender rejects ACK with another nonce or PID, and a closed channel fails without a timeout', async t => {
  for (const change of ['nonce', 'pid', 'closed']) {
    const f = fixture(t), observation = f.mount().observe(), { sender, receiver } = channels(t);
    receiver.once('data', data => {
      const message = JSON.parse(data.toString());
      if (change === 'closed') { receiver.end(); return; }
      receiver.write(JSON.stringify({ version: 1, nonce: change === 'nonce' ? 'b'.repeat(64) : message.nonce,
        pid: change === 'pid' ? 810003 : 810002, ready: true, noNewPrivileges: false }) + '\n');
    });
    await assert.rejects(sendAppImageHandoff(sender, { observation, parent: parentIdentity, childPid: 810002 }), handoffFailed);
  }
});

test('a missing ACK and oversized protocol data fail within the fixed handshake bound', async t => {
  const f = fixture(t), observation = f.mount().observe();
  {
    const { sender } = channels(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const failure = assert.rejects(sendAppImageHandoff(sender, { observation, parent: parentIdentity, childPid: 810002 }), handoffFailed);
    t.mock.timers.tick(10000); await failure; t.mock.timers.reset();
  }
  {
    const { sender, receiver } = channels(t);
    const failure = assert.rejects(receiveAppImageHandoff(receiver, { observation }), handoffFailed);
    sender.write('x'.repeat(16385)); await failure;
  }
});

test('exit gate requires ESRCH; live, reused or inaccessible parent never releases startup', async () => {
  let ticks = 0, waits = 0;
  await waitForAppImageParentExit(parentIdentity, { readIdentity: () => parentIdentity,
    signal: () => { if (waits === 2) noProcess(); }, now: () => ticks, pause: async ms => { ticks += ms; waits++; } });
  assert.equal(waits, 2);
  await assert.rejects(waitForAppImageParentExit(parentIdentity, { readIdentity: () => ({ ...parentIdentity, started: '101' }), signal: () => {} }), handoffFailed);
  await assert.rejects(waitForAppImageParentExit(parentIdentity, { signal: () => { throw Object.assign(new Error('private'), { code: 'EPERM' }); } }), handoffFailed);
  ticks = 0;
  await assert.rejects(waitForAppImageParentExit(parentIdentity, { readIdentity: () => parentIdentity,
    signal: () => {}, now: () => ticks, pause: async () => { ticks += 10000; } }), handoffFailed);
  let probes = 0;
  await waitForAppImageParentExit(parentIdentity, { signal: () => { if (probes++) noProcess(); },
    readIdentity: () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } });
  assert.equal(probes, 2);
});

test('an image changed during parent shutdown cannot release the successor workspace gate', async t => {
  const f = fixture(t), runtime = f.mount(), observation = runtime.observe(), { sender, receiver } = channels(t);
  const receiving = receiveAppImageHandoff(receiver, { observation, pid: 810002, parentPid: parentIdentity.pid, uid: parentIdentity.uid,
    readIdentity: () => parentIdentity, noNewPrivileges: null,
    waitForExit: async () => { const changed = Buffer.from(f.bytes); changed[40] ^= 1; fs.writeFileSync(f.image, changed); },
    verifyCurrent: runtime.observe });
  const failure = assert.rejects(receiving, handoffFailed);
  assert.equal(await sendAppImageHandoff(sender, { observation, parent: parentIdentity, childPid: 810002 }), null);
  await failure;
});

test('ordinary startup does not open a handshake descriptor; forged markers are refused', async () => {
  assert.equal(await acceptAppImageRelaunch(null, { env: {} }), false);
  const env = { OPENASTER_APPIMAGE_HANDOFF: 'not-valid' };
  await assert.rejects(acceptAppImageRelaunch(null, { env }), handoffFailed);
  assert.equal(Object.hasOwn(env, 'OPENASTER_APPIMAGE_HANDOFF'), false);
});

// Node-only owned subprocesses prove the actual FD3 transport and OS exit gate.
// The CI installer test separately proves AppImage/AppRun/Electron preserve FD3.
test('Linux inherited FD3 handshake waits for a real owned parent to exit', { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  let cleanup, completed = false;
  const f = fixture({ after: work => { cleanup = work; } }), runtime = f.mount(), observation = runtime.observe(), proof = path.join(f.root, 'released.json');
  const module = new URL('./appimage-relaunch.mjs', import.meta.url).href;
  const successor = `import fs from 'node:fs'; import { Socket } from 'node:net'; import { receiveAppImageHandoff } from ${JSON.stringify(module)};
    const observation = ${JSON.stringify(observation)};
    await receiveAppImageHandoff(new Socket({fd:3, readable:true, writable:true}), {observation, verifyCurrent:()=>observation});
    fs.writeFileSync(${JSON.stringify(proof)}, JSON.stringify({released:true,pid:process.pid}), {flag:'wx'});`;
  const predecessor = `import {spawn} from 'node:child_process'; import {sendAppImageHandoff,readAppImageProcessIdentity} from ${JSON.stringify(module)};
    const child=spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(successor)}],{stdio:['ignore','inherit','inherit','pipe'],detached:false,shell:false});
    child.on('error',()=>process.exit(3)); child.stdio[3].on('error',()=>{});
    await sendAppImageHandoff(child.stdio[3],{observation:${JSON.stringify(observation)},parent:readAppImageProcessIdentity(process.pid),childPid:child.pid});
    child.stdio[3].destroy(); child.unref(); process.send({ready:true,pid:child.pid}); process.once('message',()=>process.exit(0));`;
  const parent = spawn(process.execPath, ['--input-type=module', '--eval', predecessor], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: false, shell: false });
  let closed = false; const stopped = once(parent, 'close').then(value => { closed = true; return value; });
  t.after(async () => { if (!closed) parent.kill('SIGTERM'); await stopped; if (completed) cleanup(); });
  const [ready] = await once(parent, 'message'); assert.equal(ready.ready, true);
  assert.equal(fs.existsSync(proof), false); assert.equal(readAppImageProcessIdentity(parent.pid).pid, parent.pid);
  parent.send('exit'); assert.equal((await stopped)[0], 0);
  const value = JSON.parse(fs.readFileSync(proof, 'utf8')); assert.equal(value.released, true); assert.equal(value.pid, ready.pid);
  completed = true;
});
