// SPDX-License-Identifier: Apache-2.0
// AppImage mounts are temporary. Relaunch the verified outer image, never a
// pathname inside a previous mount. This module does not launch any process.
import nodeFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

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
