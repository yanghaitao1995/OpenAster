// SPDX-License-Identifier: Apache-2.0
// AppImage mounts are temporary. Relaunch the verified outer image, never a
// pathname inside a previous mount. The successor cannot open a workspace until
// its verified predecessor has exited; no shell or detached process is used.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';

// Hash the physical archive without changing Electron's global ASAR setting.
const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;

const fail = () => Object.assign(new Error('AppImage relaunch identity could not be verified.'), { code: 'RELAUNCH_SMOKE_UNSAFE' });
const requireValue = condition => { if (!condition) throw fail(); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digits = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const absolute = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && path.isAbsolute(value) && path.resolve(value) === value;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fileKeys = ['canonical', 'dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'gid', 'mode', 'sha256'];
const statKeys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'gid', 'mode'];
const sameStat = (a, b) => statKeys.every(key => a[key] === b[key]);

function canonical(value, directory = false) {
  requireValue(absolute(value));
  const parsed = path.parse(value); let current = parsed.root;
  const components = path.relative(parsed.root, value).split(path.sep).filter(Boolean);
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    const info = fs.lstatSync(current);
    requireValue(!info.isSymbolicLink() && (current === value && !directory ? info.isFile() : info.isDirectory()));
  }
  const real = fs.realpathSync(value); requireValue(samePath(real, value)); return real;
}

function fileSnapshot(file, { image = false } = {}) {
  const resolved = canonical(file), before = fs.lstatSync(resolved, { bigint: true });
  requireValue(before.isFile() && before.nlink === 1n && before.ino !== 0n && before.size > 0n && before.size <= 4n * 1024n ** 3n);
  if (image && process.platform === 'linux') {
    requireValue((before.uid === BigInt(process.getuid()) || before.uid === 0n) && (before.mode & 0o022n) === 0n);
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true }); requireValue(sameStat(before, opened) && opened.nlink === 1n);
    const buffer = Buffer.alloc(1024 * 1024), hash = createHash('sha256'); let total = 0n, header;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
      if (header === undefined) header = Buffer.from(buffer.subarray(0, Math.min(12, count)));
      total += BigInt(count); requireValue(total <= before.size); hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(resolved, { bigint: true });
    requireValue(total === before.size && sameStat(before, after) && sameStat(after, named)
      && named.isFile() && !named.isSymbolicLink() && named.nlink === 1n && samePath(canonical(file), resolved));
    if (image) requireValue(header?.length === 12 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      && header[8] === 0x41 && header[9] === 0x49 && header[10] === 2);
    return { canonical: resolved, ...Object.fromEntries(statKeys.map(key => [key, after[key].toString()])), sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}

export function validateAppImageFile(value) {
  requireValue(exact(value, fileKeys) && absolute(value.canonical) && statKeys.every(key => digits(value[key]))
    && value.ino !== '0' && value.size !== '0' && digest(value.sha256));
  return value;
}
export function readAppImageFile(file) { return fileSnapshot(file, { image: true }); }

function payload(value, relative) {
  requireValue(exact(value, ['relative', 'size', 'sha256']) && value.relative === relative && digits(value.size) && value.size !== '0' && digest(value.sha256));
}

// Historical observations deliberately do not dereference their old mount.
// The live mount is inspected afresh at entry and immediately before relaunch.
export function validateAppImageObservation(value) {
  requireValue(exact(value, ['version', 'image', 'payload', 'mount']) && value.version === 1 && absolute(value.mount));
  validateAppImageFile(value.image);
  requireValue(exact(value.payload, ['executable', 'archive']));
  payload(value.payload.executable, 'openaster'); payload(value.payload.archive, 'resources/app.asar');
  return value;
}

export function sameAppImageFile(a, b) {
  validateAppImageFile(a); validateAppImageFile(b); return fileKeys.every(key => a[key] === b[key]);
}
export function sameAppImageProgram(a, b) {
  validateAppImageObservation(a); validateAppImageObservation(b);
  return sameAppImageFile(a.image, b.image) && ['executable', 'archive'].every(key =>
    a.payload[key].size === b.payload[key].size && a.payload[key].sha256 === b.payload[key].sha256);
}

export function readAppImageRuntime({ platform = process.platform, isPackaged, env = process.env, executable = process.execPath } = {}) {
  // Initial pairing trusts the official AppImage runtime's launch environment.
  // This is not a boundary against the same user forging that environment
  // before launch. Subsequent tickets and relaunches bind exact file identities.
  if (platform !== 'linux' || isPackaged !== true || (!env.APPIMAGE && !env.APPDIR)) return null;
  requireValue(Boolean(env.APPIMAGE) && Boolean(env.APPDIR));
  const mount = canonical(env.APPDIR, true), actual = canonical(executable);
  requireValue(actual === path.join(mount, 'openaster'));
  const image = readAppImageFile(env.APPIMAGE);
  requireValue(!image.canonical.startsWith(mount + path.sep));
  const executableFile = fileSnapshot(actual), archive = fileSnapshot(path.join(mount, 'resources', 'app.asar'));
  return validateAppImageObservation({ version: 1, image, mount, payload: {
    executable: { relative: 'openaster', size: executableFile.size, sha256: executableFile.sha256 },
    archive: { relative: 'resources/app.asar', size: archive.size, sha256: archive.sha256 },
  } });
}

export function appImageRelaunchOptions(observation, { args = process.argv.slice(1), ...runtime } = {}) {
  validateAppImageObservation(observation);
  const current = readAppImageRuntime(runtime);
  requireValue(current !== null && sameAppImageProgram(observation, current) && current.mount === observation.mount);
  requireValue(Array.isArray(args) && args.every(value => typeof value === 'string' && !value.includes('\0')));
  // Electron's execPath override does not automatically preserve argv.
  return { execPath: current.image.canonical, args: [...args] };
}

const HANDOFF = 'OPENASTER_APPIMAGE_HANDOFF';
const HANDOFF_MS = 10000, MESSAGE_BYTES = 16384;
const handoffError = () => Object.assign(new Error('AppImage restart handoff did not complete.'), { code: 'APPIMAGE_HANDOFF_FAILED' });
const ensureHandoff = condition => { if (!condition) throw handoffError(); };
const processId = value => Number.isSafeInteger(value) && value > 1;
const identityValid = value => exact(value, ['pid', 'uid', 'started']) && processId(value.pid)
  && Number.isSafeInteger(value.uid) && value.uid >= 0 && digits(value.started) && value.started !== '0';

export function readAppImageProcessIdentity(pid) {
  ensureHandoff(processId(pid) && process.platform === 'linux');
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  ensureHandoff(stat.length <= 8192 && stat.startsWith(`${pid} (`));
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  const value = { pid, uid: fs.statSync(`/proc/${pid}`).uid, started: fields[19] };
  ensureHandoff(identityValid(value)); return value;
}

export function readAppImageNoNewPrivileges() {
  try {
    if (process.platform !== 'linux') return null;
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    if (status.length > 65536) return null;
    const match = /^NoNewPrivs:\s*([01])\s*$/mu.exec(status);
    return match ? match[1] === '1' : null;
  } catch { return null; }
}

// ESRCH is required, not pipe EOF or a changed /proc identity. A reused PID or
// an unreadable live process must never release the workspace gate.
export async function waitForAppImageParentExit(parent, { readIdentity = readAppImageProcessIdentity,
  signal = (pid, value) => process.kill(pid, value), now = () => performance.now(),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  ensureHandoff(identityValid(parent));
  const deadline = now() + HANDOFF_MS;
  while (now() < deadline) {
    try { signal(parent.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw handoffError(); }
    try {
      const current = readIdentity(parent.pid);
      ensureHandoff(identityValid(current) && current.uid === parent.uid && current.started === parent.started);
    } catch (error) {
      // /proc can disappear between kill(0) and read. Confirm ESRCH separately.
      if (error.code !== 'ENOENT') throw handoffError();
      try { signal(parent.pid, 0); } catch (again) { if (again.code === 'ESRCH') return; }
      throw handoffError();
    }
    await pause(50);
  }
  throw handoffError();
}

function readMessage(channel) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const finish = (error, value) => {
      clearTimeout(timer); channel.off('data', receive); channel.off('end', failed); channel.off('close', failed); channel.off('error', failed);
      if (error) reject(handoffError()); else resolve(value);
    };
    const failed = () => finish(true);
    const receive = chunk => {
      if (bytes.length + chunk.length > MESSAGE_BYTES) return finish(true);
      bytes = Buffer.concat([bytes, chunk]);
      if (!bytes.includes(10)) return;
      try {
        ensureHandoff(bytes.indexOf(10) === bytes.length - 1);
        finish(false, JSON.parse(bytes.subarray(0, -1).toString('utf8')));
      } catch { finish(true); }
    };
    const timer = setTimeout(failed, HANDOFF_MS);
    channel.on('data', receive); channel.once('end', failed); channel.once('close', failed); channel.once('error', failed);
  });
}

// Exported for a real duplex-channel regression; all messages are bounded and
// nonce-bound. Paths and nonce travel only on the inherited private pipe.
export async function sendAppImageHandoff(channel, { observation, parent, childPid }) {
  validateAppImageObservation(observation); ensureHandoff(identityValid(parent) && processId(childPid));
  const nonce = randomBytes(32).toString('hex');
  const pending = readMessage(channel);
  channel.write(JSON.stringify({ version: 1, nonce, parent, observation }) + '\n');
  const ack = await pending;
  ensureHandoff(exact(ack, ['version', 'nonce', 'pid', 'ready', 'noNewPrivileges']) && ack.version === 1
    && ack.nonce === nonce && ack.pid === childPid && ack.ready === true
    && (ack.noNewPrivileges === null || typeof ack.noNewPrivileges === 'boolean'));
  return ack.noNewPrivileges;
}

export async function receiveAppImageHandoff(channel, { observation, pid = process.pid, parentPid = process.ppid,
  uid = process.getuid?.(), readIdentity = readAppImageProcessIdentity, waitForExit = waitForAppImageParentExit,
  verifyCurrent = () => readAppImageRuntime({ isPackaged: true }), noNewPrivileges = readAppImageNoNewPrivileges(),
  report = () => {} }) {
  const message = await readMessage(channel);
  ensureHandoff(exact(message, ['version', 'nonce', 'parent', 'observation']) && message.version === 1
    && digest(message.nonce) && identityValid(message.parent) && message.parent.pid === parentPid && message.parent.uid === uid);
  const parent = readIdentity(parentPid);
  ensureHandoff(identityValid(parent) && parent.started === message.parent.started && parent.uid === uid);
  ensureHandoff(observation !== null && sameAppImageProgram(message.observation, observation));
  await new Promise((resolve, reject) => channel.write(JSON.stringify({ version: 1, nonce: message.nonce, pid, ready: true,
    noNewPrivileges }) + '\n', error => error ? reject(handoffError()) : resolve()));
  channel.destroy();
  report('successor-ready', noNewPrivileges);
  await waitForExit(parent);
  const current = verifyCurrent();
  ensureHandoff(current !== null && sameAppImageProgram(observation, current) && current.mount === observation.mount);
  report('predecessor-exited', noNewPrivileges);
}

export async function acceptAppImageRelaunch(observation, { env = process.env, report = () => {} } = {}) {
  if (env[HANDOFF] === undefined) return false;
  const requested = env[HANDOFF]; delete env[HANDOFF];
  ensureHandoff(requested === '1' && process.platform === 'linux' && observation !== null);
  const info = fs.fstatSync(3); ensureHandoff(info.isSocket() || info.isFIFO());
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  channel.on('error', () => {}); // Errors are converted to a fixed failure below.
  try { await receiveAppImageHandoff(channel, { observation, report }); return true; }
  catch { throw handoffError(); }
  finally { channel.destroy(); }
}

export async function spawnAppImageRelaunch(observation, { report = () => {}, ...runtime } = {}) {
  ensureHandoff(process.platform === 'linux');
  const options = appImageRelaunchOptions(observation, runtime), parent = readAppImageProcessIdentity(process.pid);
  const env = { ...process.env, [HANDOFF]: '1' };
  // AppImage's normal FUSE runtime execs AppRun, which execs this application:
  // both keep the spawned PID and inherited FD3. Extract-and-run is unsupported.
  ensureHandoff(env.APPIMAGE_EXTRACT_AND_RUN === undefined && env.TARGET_APPIMAGE === undefined);
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  report('parent-spawn', readAppImageNoNewPrivileges());
  const child = spawn(options.execPath, options.args, { env, cwd: path.dirname(options.execPath),
    shell: false, detached: false, stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
  const channel = child.stdio[3];
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.on('error', () => { channel?.destroy(); });
  channel?.on('error', () => {});
  try {
    ensureHandoff(channel && processId(child.pid));
    const noNewPrivileges = await sendAppImageHandoff(channel, { observation, parent, childPid: child.pid });
    ensureHandoff(!exited);
    report('parent-accepted', noNewPrivileges);
  } catch {
    // ChildProcess refers only to this just-spawned child, never a discovered PID.
    if (!exited && child.pid) child.kill('SIGTERM');
    throw handoffError();
  } finally {
    channel?.destroy(); child.unref();
  }
}
