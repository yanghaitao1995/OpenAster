// SPDX-License-Identifier: Apache-2.0
// Install the unchanged public APK in a fresh hosted-runner emulator. This is
// offline companion-client acceptance, not proof of a working HTTPS gateway.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedBuildInfo } from './lib/build-info.mjs';

export const APK = Object.freeze({ file: 'OpenAster-0.2.2-android-vc12-debug.apk', bytes: 4124497,
  sha256: '595b42481262d856c799a3c0186dcb2f4c113c291e7df94c9f21aa4b76b18e44',
  version: '0.2.2', versionCode: 12, package: 'org.openaster.preview',
  sharedAssetsSha256: 'e94a961b65abc4993a71fa409c2e9f7df95c9c3f8b52929653d4e127fad879ff' });
const IMAGE = 'system-images;android-36;default;x86_64';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const requireFact = (value, message) => { if (!value) throw new Error(message); };
const digest = async file => { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); };
const within = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const clean = value => String(value ?? '').replace(/\bhttps?:\/\/[^\s<>"']+/giu, '[URL]')
  .replace(/\b(?:gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|sk-[\w-]{12,})\b/gu, '[credential]')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(-6000);

export function assertHostedAndroid(env, platform, arch) {
  requireFact(platform === 'linux' && arch === 'x64' && env.GITHUB_ACTIONS === 'true'
    && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.GITHUB_REPOSITORY === 'yanghaitao1995/OpenAster',
  'Android acceptance requires this repository on an ephemeral Linux x64 GitHub-hosted runner');
}
export function assertKvmProcessIdentity(identity, expected) {
  const validId = value => Number.isInteger(value) && value > 0 && value < 0xffffffff;
  requireFact(validId(expected.uid) && validId(expected.gid)
    && identity.uid === expected.uid && identity.euid === expected.uid
    && identity.gid === expected.gid && identity.egid === expected.gid,
  'KVM acceptance must retain the original non-root runner UID and use the existing KVM real/effective GID');
  return { ...identity, scope: 'process-tree-primary-group', accountMembershipChanged: false };
}
export function assertKvmPrivilegeStatus(status, expected) {
  requireFact(typeof status === 'string' && Buffer.byteLength(status) <= 64 * 1024, 'Invalid bounded Linux process status');
  const field = name => {
    const matches = [...status.matchAll(new RegExp(`^${name}:[\\t ]+([^\\r\\n]+)$`, 'gmu'))];
    requireFact(matches.length === 1, `Missing or repeated process status field: ${name}`);
    return matches[0][1].trim();
  };
  const ids = name => {
    const value = field(name);
    requireFact(/^\d+(?:[\t ]+\d+){3}$/u.test(value), `Invalid process ${name} fields`);
    return value.split(/[\t ]+/u).map(Number);
  };
  const uids = ids('Uid'), gids = ids('Gid');
  assertKvmProcessIdentity({ uid: uids[0], euid: uids[1], gid: gids[0], egid: gids[1] }, expected);
  requireFact(uids.every(id => id === expected.uid) && gids.every(id => id === expected.gid),
    'Real, effective, saved and filesystem IDs must retain the non-root KVM context');
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
    requireFact(/^0{16}$/u.test(field(name)), 'KVM acceptance must have no retained Linux capabilities');
  }
  requireFact(field('NoNewPrivs') === '1', 'KVM acceptance must prohibit new privileges');
  return { uids, gids, allCapabilitiesCleared: true, noNewPrivileges: true };
}
export function kvmDeviceIdentity(stat) {
  requireFact(stat.isCharacterDevice() && !stat.isSymbolicLink() && stat.uid === 0,
    'KVM must be an existing root-owned character device without links');
  requireFact(typeof stat.rdev === 'bigint' || Number.isSafeInteger(stat.rdev), 'Invalid KVM device number');
  const device = BigInt(stat.rdev);
  requireFact(device >= 0n && device <= 0xffffffffffffffffn, 'Invalid KVM device number');
  // Linux/glibc dev_t encoding, matching GNU stat's portable %t:%T fields.
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
  return `${stat.dev}:${stat.ino}:${major.toString(16)}:${minor.toString(16)}:${stat.uid}:${stat.gid}:${(stat.mode & 0o7777).toString(8)}`;
}
export async function prepareOfficialAndroidSdk(sdk, command) {
  const bin = path.join(sdk, 'cmdline-tools', 'latest', 'bin'), emulator = path.join(sdk, 'emulator', 'emulator');
  await command('sdk-licenses', path.join(bin, 'sdkmanager'), ['--licenses'], { timeout: 120000, stdin: 'y\n'.repeat(64) });
  await command('sdk-image', path.join(bin, 'sdkmanager'), ['platform-tools', 'emulator', IMAGE], { timeout: 600000, stdin: 'y\n'.repeat(16) });
  await command('emulator-version', emulator, ['-version']);
  await command('adb-version', path.join(sdk, 'platform-tools', 'adb'), ['version']);
  // Fresh hosted images may not contain emulator until sdkmanager completes.
  const result = await command('hardware-acceleration', emulator, ['-accel-check']);
  requireFact(/KVM[^\n]*(installed|usable)|KVM.*version/iu.test(result.text), 'Emulator did not confirm usable KVM');
  return { image: IMAGE, officialComponents: ['platform-tools', 'emulator', IMAGE], kvmUsable: true };
}
export function acceptanceMode(args) {
  requireFact(Array.isArray(args) && (args.length === 0 || args.length === 1 && args[0] === '--candidate'),
    'Usage: verify-published-android.mjs [--candidate]');
  return args.length ? 'candidate' : 'published';
}
export function assertCandidateCheckout(env, actualCommit) {
  assertHostedAndroid(env, 'linux', 'x64');
  requireFact(/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? '') && actualCommit === env.GITHUB_SHA,
    'Candidate checkout must exactly match this workflow commit');
}
export async function verifyCandidateBytes(file, expected) {
  const before = await fs.lstat(file);
  requireFact(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
    && before.size >= 1024 && before.size <= 64 * 1024 * 1024, 'Candidate APK must be an ordinary bounded file');
  const sha256 = await digest(file), after = await fs.lstat(file);
  requireFact(before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && !after.isSymbolicLink() && after.nlink === 1, 'Candidate APK changed while hashing');
  requireFact(!expected || expected.bytes === after.size && expected.sha256 === sha256,
    'Candidate APK bytes changed; refusing installation');
  return { bytes: after.size, sha256 };
}
async function ordinaryCandidatePath(root, relative, { directory = false } = {}) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part); const stat = await fs.lstat(current);
    requireFact(!stat.isSymbolicLink() && (current === path.join(root, relative) && !directory ? stat.isFile() : stat.isDirectory()),
      'Candidate input path must not contain links or unexpected file types');
  }
  return current;
}
export async function readCandidateArtifact(workspace) {
  const root = await fs.realpath(workspace);
  const json = async relative => {
    const file = await ordinaryCandidatePath(root, relative), stat = await fs.lstat(file);
    requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 1024 * 1024,
      'Candidate version input must be an ordinary bounded file');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  };
  const pkg = await json('package.json'), mobile = await json('mobile/package.json'), version = await json('mobile/android-version.json');
  requireFact(pkg.version === '0.2.4' && mobile.version === pkg.version && version.versionCode === 14
    && Object.keys(version).length === 1, 'Candidate must use the reviewed 0.2.4 version and Android code 14');
  const relative = 'mobile/android/app/build/outputs/apk/debug/app-debug.apk';
  const current = await ordinaryCandidatePath(root, relative);
  const identity = await verifyCandidateBytes(current), build = await sharedBuildInfo(root);
  requireFact(build.version === pkg.version, 'Candidate shared UI version differs from the checkout');
  return { sourceFile: current, artifact: { file: `OpenAster-${pkg.version}-android-vc${version.versionCode}-debug.apk`,
    ...identity, version: pkg.version, versionCode: version.versionCode, package: APK.package,
    sharedAssetsSha256: build.sharedAssetsSha256, sharedAssets: build.sharedAssets } };
}
export async function collectCandidateWebFiles(workspace) {
  const root = await fs.realpath(workspace), generated = await ordinaryCandidatePath(root, 'mobile/www', { directory: true });
  const files = []; let totalBytes = 0, visitedEntries = 0;
  const add = async (relative, source) => {
    const file = await ordinaryCandidatePath(root, source), before = await fs.lstat(file);
    requireFact(before.nlink === 1 && before.size <= 8 * 1024 * 1024, 'Candidate web asset exceeds the ordinary-file limit');
    totalBytes += before.size; requireFact(totalBytes <= 32 * 1024 * 1024 && files.length < 256, 'Candidate web asset tree exceeds its limit');
    const sha256 = await digest(file), after = await fs.lstat(file);
    requireFact(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeMs === after.mtimeMs && !after.isSymbolicLink() && after.nlink === 1, 'Candidate web asset changed while hashing');
    files.push({ file: relative, source, bytes: before.size, sha256 });
  };
  const visit = async (relative = '') => {
    requireFact(relative.split('/').length <= 12, 'Candidate web asset directories are too deep');
    for (const entry of (await fs.readdir(path.join(generated, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      requireFact(++visitedEntries <= 512, 'Candidate web directory inventory exceeds its limit');
      requireFact(/^[A-Za-z0-9_.-]+$/u.test(entry.name) && !['.', '..'].includes(entry.name) && !entry.isSymbolicLink(), 'Unsafe candidate web asset name or link');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await ordinaryCandidatePath(root, `mobile/www/${name}`, { directory: true }); await visit(name); }
      else { requireFact(entry.isFile(), 'Candidate web asset is not a file'); await add(name, `mobile/www/${name}`); }
    }
  };
  await visit(); requireFact(files.length > 0, 'Candidate generated web tree is empty');
  // Capacitor adds these two bridge shims while syncing native assets. Every
  // other APK public asset must originate in mobile/www without extra files.
  for (const shim of ['cordova.js', 'cordova_plugins.js']) {
    requireFact(!files.some(file => file.file === shim), 'Unexpected Cordova shim in the generated web tree');
    await add(shim, `mobile/android/app/src/main/assets/public/${shim}`);
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
export function assertCandidateWebEntries(text, files) {
  const entries = text.split(/\r?\n/u).filter(Boolean);
  requireFact(entries.length > 0 && entries.length <= 8192 && Buffer.byteLength(text) <= 2 * 1024 * 1024,
    'APK entry inventory exceeds its limit');
  const seen = new Set(), archiveFiles = new Set(), expected = new Set(files.map(file => `assets/public/${file.file}`));
  for (const entry of entries) {
    const canonical = entry.replace(/\/$/u, '');
    requireFact(entry.length <= 512 && !/[\\\u0000-\u001f\u007f:]/u.test(entry)
      && !canonical.startsWith('/') && canonical.split('/').every(part => part && part !== '.' && part !== '..')
      && !seen.has(canonical), 'APK contains duplicate or unsafe entry names');
    seen.add(canonical);
    if (!entry.endsWith('/')) archiveFiles.add(entry);
    if (entry.startsWith('assets/public/') && !entry.endsWith('/')) requireFact(expected.has(entry), 'APK contains an unexpected public web asset');
    if (entry.startsWith('assets/public/') && entry.endsWith('/')) requireFact([...expected].some(name => name.startsWith(entry)), 'APK contains an unexpected public web directory');
  }
  requireFact([...expected].every(entry => archiveFiles.has(entry)), 'APK is missing a generated web asset');
  return { archiveEntries: entries.length, webFiles: expected.size };
}
export function assertCandidateWebBytes(bytes, file) {
  requireFact(bytes.length === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256,
    `Packaged candidate web bytes differ: ${file.file}`);
}
export function assertNativeApkVersion(text, artifact) {
  const lines = text.split(/\r?\n/u).filter(line => line.startsWith('package: '));
  requireFact(lines.length === 1, 'APK must declare one package identity');
  const attribute = name => {
    const matches = [...lines[0].matchAll(new RegExp(`\\b${name}='([^']*)'`, 'gu'))];
    requireFact(matches.length === 1, 'APK package metadata contains a missing or repeated field'); return matches[0][1];
  };
  requireFact(attribute('name') === artifact.package && attribute('versionName') === artifact.version
    && attribute('versionCode') === String(artifact.versionCode), 'APK native version or package differs from this candidate');
  return { package: artifact.package, version: artifact.version, versionCode: artifact.versionCode };
}
export function signatureEvidence(text) {
  const certificates = [...text.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})\s*$/gimu)].map(match => match[1].toLowerCase());
  requireFact(certificates.length > 0 && certificates.length <= 4 && /Verified using v2 scheme[^\n]*: true/iu.test(text),
    'APK signature verification did not provide bounded signer fingerprints and a valid v2 signature');
  return { certificateSha256: certificates, v2Verified: true, distribution: 'debug; no upgrade or production signing trust claimed' };
}
export function assertPackagedConfiguration(config, build, artifact = APK) {
  requireFact(config?.appId === APK.package && config.server?.hostname === 'localhost'
    && config.server?.androidScheme === 'https' && config.server?.cleartext === false
    && config.android?.allowMixedContent === false && config.android?.webContentsDebuggingEnabled === false,
  'Published APK does not retain the expected HTTPS and WebView isolation configuration');
  requireFact(build?.version === artifact.version && build.mode === 'companion' && build.sharedAssets === (artifact.sharedAssets ?? 27)
    && build.sharedAssetsSha256 === artifact.sharedAssetsSha256, 'APK shared UI does not match the expected source baseline');
}
function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_match, entity) => {
    if (entity[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    requireFact(Number.isInteger(number) && number >= 0 && number <= 0x10ffff, 'Invalid XML character');
    return String.fromCodePoint(number);
  });
}
export function parseHierarchy(xml) {
  requireFact(typeof xml === 'string' && Buffer.byteLength(xml) <= 2 * 1024 * 1024
    && !/<!DOCTYPE|<!ENTITY/iu.test(xml) && /<hierarchy\b/u.test(xml), 'Invalid bounded UI hierarchy');
  const nodes = [];
  for (const match of xml.matchAll(/<node\b([^>]*)\/?>/gu)) {
    const node = Object.create(null);
    for (const item of match[1].matchAll(/([a-z-]+)="([^"]*)"/gu)) {
      requireFact(!Object.hasOwn(node, item[1]), 'Duplicate UI attribute'); node[item[1]] = decodeXml(item[2]);
    }
    nodes.push(node); requireFact(nodes.length <= 5000, 'UI hierarchy exceeds node limit');
  }
  requireFact(nodes.length > 0, 'UI hierarchy contains no nodes'); return nodes;
}
export function visibleBounds(node, width = 720, height = 1280) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(node.bounds ?? '');
  if (!match) return null;
  const [x1, y1, x2, y2] = match.slice(1).map(Number);
  return x1 < x2 && y1 < y2 && x1 >= 0 && y1 >= 0 && x2 <= width && y2 <= height
    ? { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) } : null;
}
export function selectControl(nodes, predicate) {
  const matches = nodes.filter(node => node.package === APK.package && node.enabled === 'true'
    && node.clickable === 'true' && visibleBounds(node) && predicate(node));
  requireFact(matches.length === 1, `Expected exactly one visible application control; found ${matches.length}`);
  return { node: matches[0], ...visibleBounds(matches[0]) };
}

async function download(file) {
  let url = new URL(`https://github.com/yanghaitao1995/OpenAster/releases/download/v0.2.2/${APK.file}`);
  const signal = AbortSignal.timeout(120000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    requireFact(url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname), 'Unapproved APK download origin');
    const response = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'OpenAster-Android-installer-acceptance', 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers.get('location'); await response.body?.cancel();
      requireFact(target && redirects < 5, 'APK redirect limit exceeded'); url = new URL(target, url); continue;
    }
    requireFact(response.status === 200 && response.body, `APK download returned HTTP ${response.status}`);
    const handle = await fs.open(file, 'wx', 0o600); let bytes = 0;
    try { for await (const chunk of response.body) { bytes += chunk.length; requireFact(bytes <= APK.bytes, 'APK exceeds fixed size'); await handle.writeFile(chunk); } }
    finally { await handle.close(); }
    requireFact(bytes === APK.bytes && await digest(file) === APK.sha256, 'APK hash or size differs; refusing installation');
    return { bytes, sha256: APK.sha256 };
  }
  throw new Error('APK download did not complete');
}

export async function main(args = process.argv.slice(2)) {
  const mode = acceptanceMode(args), candidate = mode === 'candidate';
  assertHostedAndroid(process.env, process.platform, process.arch);
  const workspace = await fs.realpath(process.env.GITHUB_WORKSPACE);
  const evidence = path.join(workspace, 'android-installer-evidence'); await fs.mkdir(evidence, { recursive: true });
  requireFact(await fs.realpath(evidence) === evidence, 'Evidence path must not resolve through a link');
  let artifact = candidate ? null : APK;
  const receipt = { format: candidate ? 'openaster-candidate-android-acceptance-v1' : 'openaster-published-android-acceptance-v1', mode, startedAt: new Date().toISOString(),
    status: 'running', artifact, verificationCommit: process.env.GITHUB_SHA, sourceCommit: candidate ? process.env.GITHUB_SHA : '3a4ee6915312dcafd9e56ea5c40440c9b39c5985',
    image: IMAGE, realModelCalls: 0, gatewayTested: false, appModified: false, securitySettingsChanged: false,
    observations: { artifactVerified: false, packagedWebBytesVerified: false, apkSignatureVerified: false,
      emulatorBooted: false, apkInstalled: false, offlineUiRendered: false },
    scope: `${candidate ? 'Same-checkout candidate' : 'Published'} APK install, launch, offline UI, settings, packaged notices, cleartext gateway refusal and cold relaunch on one API36 x86_64 emulator. Not physical-device, upgrade, signing trust or HTTPS gateway/model acceptance.`,
    steps: [], commands: [], services: [], screenshots: [] };
  const save = () => fs.writeFile(path.join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  let sequence = 0, temporary, env, adbPath, emulatorPath, serial = 'emulator-5554', avdName, adbService, emulatorService;
  let booted = false, installed = false, lastNodes = [];
  const step = async (name, action) => {
    const entry = { name, startedAt: new Date().toISOString(), status: 'running' }; receipt.steps.push(entry); await save();
    try { const result = await action(); entry.status = 'passed'; entry.result = result; return result; }
    catch (error) { entry.status = 'failed'; entry.error = clean(error.message); throw error; }
    finally { entry.finishedAt = new Date().toISOString(); await save(); }
  };
  async function command(name, executable, args, { timeout = 30000, stdin, binary = false, allowedFailure = false } = {}) {
    const prefix = `${String(++sequence).padStart(3, '0')}-${name}`;
    const record = { name, executable: path.basename(executable), args, startedAt: new Date().toISOString(),
      stdout: `${prefix}.${binary ? 'png' : 'stdout.log'}`, stderr: `${prefix}.stderr.log`, timedOut: false };
    receipt.commands.push(record); const out = [], err = []; let outBytes = 0, errBytes = 0, overflow = false;
    const child = spawn(executable, args, { cwd: temporary, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') record.cleanupError = error.code; } } };
    child.stdout.on('data', bytes => { outBytes += bytes.length; if (outBytes <= 16 * 1024 * 1024) out.push(bytes); else { overflow = true; stop(); } });
    child.stderr.on('data', bytes => { errBytes += bytes.length; if (errBytes <= 2 * 1024 * 1024) err.push(bytes); else { overflow = true; stop(); } });
    child.on('error', error => { record.spawnError = error.code; }); child.stdin.on('error', () => {});
    const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
    child.stdin.end(stdin ?? '');
    const timer = setTimeout(() => { record.timedOut = true; stop(); }, timeout);
    Object.assign(record, await exited); clearTimeout(timer); record.finishedAt = new Date().toISOString();
    const output = Buffer.concat(out), errors = Buffer.concat(err);
    await fs.writeFile(path.join(evidence, record.stdout), output); await fs.writeFile(path.join(evidence, record.stderr), errors); await save();
    requireFact(!overflow && !record.timedOut && !record.spawnError && (allowedFailure || record.code === 0),
      `${name} failed (exit ${record.code}, timeout ${record.timedOut}, spawn ${record.spawnError ?? 'none'}); ${clean(errors.toString('utf8'))}`);
    return { ...record, output, text: output.toString('utf8') };
  }
  async function startService(name, executable, args) {
    const stdoutFile = path.join(evidence, `${name}.stdout.log`), stderrFile = path.join(evidence, `${name}.stderr.log`);
    const stdout = await fs.open(stdoutFile, 'wx'), stderr = await fs.open(stderrFile, 'wx');
    const child = spawn(executable, args, { cwd: temporary, env, detached: true, stdio: ['ignore', stdout.fd, stderr.fd] });
    const record = { name, pid: child.pid, closed: false }; receipt.services.push(record);
    child.on('error', error => { record.error = error.code; });
    const closed = new Promise(resolve => child.on('close', (code, signal) => { Object.assign(record, { closed: true, code, signal }); resolve(); }));
    await stdout.close(); await stderr.close(); await save(); return { child, record, closed };
  }
  const adb = async (name, args, options) => {
    requireFact(adbService && !adbService.record.closed && !adbService.record.error, 'Owned ADB server is not live; refusing restart');
    return command(name, adbPath, ['-H', '127.0.0.1', '-P', '5038', '-s', serial, ...args], options);
  };
  async function ownedDevice() {
    requireFact(emulatorService && !emulatorService.record.closed && !emulatorService.record.error, 'Owned emulator is not live');
    const result = await adb('verify-owned-avd', ['emu', 'avd', 'name']);
    requireFact(result.text.split(/\r?\n/u).includes(avdName), 'ADB target is not the owned AVD');
  }
  async function capture(name) {
    await ownedDevice();
    const remote = '/data/local/tmp/openaster-acceptance.xml';
    await adb(`${name}-dump`, ['shell', 'uiautomator', 'dump', remote]);
    const xml = await adb(`${name}-hierarchy`, ['exec-out', 'cat', remote]); lastNodes = parseHierarchy(xml.text);
    const png = await adb(`${name}-screen`, ['exec-out', 'screencap', '-p'], { binary: true });
    requireFact(png.output.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid screenshot');
    receipt.screenshots.push(png.stdout); return lastNodes;
  }
  const nodeText = node => `${node.text ?? ''} ${node['content-desc'] ?? ''}`.trim();
  const hasText = pattern => lastNodes.some(node => node.package === APK.package && pattern.test(nodeText(node)));
  async function waitForText(name, pattern) {
    // am start -W confirms the Activity, not completion of the first WebView
    // render. Observe that render instead of treating a fixed sleep as proof.
    for (let attempt = 0; attempt < 6; attempt++) {
      await capture(`${name}-${attempt}`); if (hasText(pattern)) return; await wait(500);
    }
    throw new Error(`Expected application text did not appear: ${name}`);
  }
  async function click(name, pattern, { scroll = false } = {}) {
    for (let attempt = 0; attempt < (scroll ? 7 : 4); attempt++) {
      await capture(`${name}-locate-${attempt}`);
      const candidates = lastNodes.filter(node => node.package === APK.package && node.enabled === 'true' && node.clickable === 'true' && visibleBounds(node) && pattern.test(nodeText(node)));
      if (candidates.length) {
        const selected = selectControl(lastNodes, node => pattern.test(nodeText(node)));
        await adb(name, ['shell', 'input', 'tap', String(selected.x), String(selected.y)]); await wait(400); return;
      }
      if (!scroll) { await wait(400); continue; }
      // A swipe stays inside the previously captured application viewport.
      requireFact(hasText(/模型与连接|Android 开源许可/u), 'Refusing to scroll outside the expected settings view');
      await adb(`${name}-scroll`, ['shell', 'input', 'swipe', '360', '1040', '360', '440', '400']);
    }
    throw new Error(`Visible control was not found: ${name}`);
  }
  async function foreground(name) {
    const activity = await adb(name, ['shell', 'dumpsys', 'activity', 'activities']);
    requireFact(/(?:topResumedActivity|mResumedActivity)[^\n]*org\.openaster\.preview\/\.MainActivity/u.test(activity.text), 'The foreground activity is not OpenAster');
  }
  async function stopService(service) {
    if (!service || !service.child.pid) return;
    const alive = () => { try { process.kill(-service.child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    const kill = signal => { try { process.kill(-service.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    if (alive()) {
      kill('SIGTERM'); const graceful = Date.now() + 5000;
      while (alive() && Date.now() < graceful) await wait(100);
      if (alive()) { kill('SIGKILL'); const forced = Date.now() + 5000; while (alive() && Date.now() < forced) await wait(100); }
    }
    await Promise.race([service.closed, wait(1000)]); service.record.processGroupGone = !alive();
    requireFact(service.record.closed && service.record.processGroupGone, 'Owned service cleanup did not complete');
  }
  try {
    if (candidate) await step('non-root-kvm-process-context', async () => {
      try {
        const identity = { uid: process.getuid(), euid: process.geteuid(), gid: process.getgid(), egid: process.getegid() };
        const expected = { uid: Number(process.env.OPENASTER_KVM_RUNNER_UID), gid: Number(process.env.OPENASTER_KVM_GID) };
        const processIdentity = assertKvmProcessIdentity(identity, expected);
        const privileges = assertKvmPrivilegeStatus(await fs.readFile('/proc/self/status', 'utf8'), expected);
        receipt.kvmAccessContext = { ...processIdentity, ...privileges };
        return receipt.kvmAccessContext;
      } catch (error) { receipt.environmentBlocked = true; throw error; }
    });
    await step('isolated-runner-environment', async () => {
      const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP); temporary = await fs.mkdtemp(path.join(runnerTemp, 'openaster-android-'));
      requireFact(within(runnerTemp, temporary), 'Invalid temporary directory');
      const sdk = await fs.realpath(process.env.ANDROID_HOME), java = await fs.realpath(process.env.JAVA_HOME);
      const home = path.join(temporary, 'home'), avds = path.join(temporary, 'avds'); await fs.mkdir(home); await fs.mkdir(avds);
      env = { PATH: process.env.PATH, HOME: home, TMPDIR: temporary, LANG: 'C.UTF-8', JAVA_HOME: java,
        ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_USER_HOME: path.join(home, '.android'), ANDROID_AVD_HOME: avds,
        ANDROID_EMULATOR_HOME: path.join(home, '.android'), ANDROID_ADB_SERVER_PORT: '5038',
        ADB_SERVER_SOCKET: 'tcp:127.0.0.1:5038', ADB_USB: '0', ADB_MDNS: '0', ADB_MDNS_AUTO_CONNECT: '0' };
      adbPath = path.join(sdk, 'platform-tools', 'adb'); emulatorPath = path.join(sdk, 'emulator', 'emulator');
      avdName = `openaster-acceptance-${randomBytes(8).toString('hex')}`;
      receipt.temporaryDirectory = temporary; return { sdk, java, isolatedHome: true };
    });
    let apkFile;
    if (candidate) {
      await step('candidate-source-and-artifact-identity', async () => {
        const revision = await command('candidate-checkout-commit', 'git', ['-C', workspace, 'rev-parse', 'HEAD']);
        assertCandidateCheckout(process.env, revision.text.trim());
        // Capacitor's three generated trees may differ. Version manifests and
        // every other tracked source must still match the dispatched commit.
        const changes = await command('candidate-tracked-source-changes', 'git', ['-C', workspace, 'diff', '--name-only', 'HEAD', '--', '.',
          ':(exclude)mobile/android', ':(exclude)mobile/ios', ':(exclude)mobile/www']);
        requireFact(changes.text.trim() === '', `Candidate tracked sources differ from the checkout: ${clean(changes.text)}`);
        const input = await readCandidateArtifact(workspace); artifact = input.artifact; receipt.artifact = artifact;
        apkFile = path.join(temporary, artifact.file);
        await fs.copyFile(input.sourceFile, apkFile, constants.COPYFILE_EXCL);
        await verifyCandidateBytes(apkFile, artifact);
        receipt.observations.artifactVerified = true;
        return { sourceCommit: process.env.GITHUB_SHA, sourceFile: 'mobile/android/app/build/outputs/apk/debug/app-debug.apk',
          sourceUnchanged: true, generatedExclusions: ['mobile/android', 'mobile/ios', 'mobile/www'], ...artifact };
      });
    }
    const checkKvmDevice = () => step('kvm-device-precondition', async () => {
      try {
        requireFact(process.getuid() > 0 && process.getuid() === process.geteuid(), 'Android acceptance must run as a non-root runner');
        if (candidate) {
          const device = await fs.lstat('/dev/kvm');
          requireFact(device.gid === receipt.kvmAccessContext.gid && kvmDeviceIdentity(device) === process.env.OPENASTER_KVM_DEVICE,
            'KVM device identity, owner, group or mode changed before acceptance');
          receipt.kvmAccessContext.device = process.env.OPENASTER_KVM_DEVICE;
        }
        await fs.access('/dev/kvm', constants.R_OK | constants.W_OK);
        return { deviceReadableWritable: true };
      } catch (error) {
        receipt.environmentBlocked = true;
        throw new Error(`KVM precondition failed. No permissions or security settings were changed. ${error.code ?? clean(error.message)}`);
      }
    });
    if (!candidate) {
      await checkKvmDevice();
      apkFile = path.join(temporary, APK.file);
      await step('download-published-apk', () => download(apkFile));
      receipt.observations.artifactVerified = true;
    }
    await step('packaged-web-identity-and-policy', async () => {
      const config = await command('packaged-capacitor-config', 'unzip', ['-p', apkFile, 'assets/capacitor.config.json']);
      const build = await command('packaged-shared-ui', 'unzip', ['-p', apkFile, 'assets/public/build-info.json']);
      assertPackagedConfiguration(JSON.parse(config.text), JSON.parse(build.text), artifact);
      return { version: artifact.version, sharedAssetsSha256: artifact.sharedAssetsSha256, httpsRequired: true, webViewDebugging: false };
    });
    if (candidate) await step('candidate-native-version-and-signature', async () => {
      let tools;
      for (const version of ['36.0.0', '35.0.0']) {
        const directory = path.join(env.ANDROID_HOME, 'build-tools', version);
        try { await fs.access(path.join(directory, 'aapt2'), constants.X_OK); await fs.access(path.join(directory, 'apksigner'), constants.X_OK); tools = directory; break; }
        catch { /* Only these official SDK tool versions are accepted. */ }
      }
      requireFact(tools, 'Official Android build-tools 36.0.0 or 35.0.0 are required to inspect the built APK');
      const native = await command('candidate-apk-version', path.join(tools, 'aapt2'), ['dump', 'badging', apkFile]);
      const identity = assertNativeApkVersion(native.text, artifact);
      const signature = await command('candidate-apk-signature', path.join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', apkFile]);
      const signing = signatureEvidence(signature.text); receipt.observations.apkSignatureVerified = true;
      return { ...identity, ...signing };
    });
    if (candidate) await step('candidate-packaged-web-bytes', async () => {
      const files = await collectCandidateWebFiles(workspace);
      const inventory = await command('candidate-apk-entry-list', 'unzip', ['-Z1', apkFile]);
      const counts = assertCandidateWebEntries(inventory.text, files);
      for (const [index, file] of files.entries()) {
        const content = await command(`candidate-web-${String(index + 1).padStart(3, '0')}`, 'unzip', ['-p', apkFile, `assets/public/${file.file}`]);
        assertCandidateWebBytes(content.output, file);
      }
      requireFact(JSON.stringify(await collectCandidateWebFiles(workspace)) === JSON.stringify(files), 'Generated web assets changed during APK verification');
      await verifyCandidateBytes(apkFile, artifact);
      receipt.observations.packagedWebBytesVerified = true;
      return { ...counts, bytes: files.reduce((sum, file) => sum + file.bytes, 0), files,
        nativeBridgeShims: ['cordova.js', 'cordova_plugins.js'], generatedWebBytesMatch: true };
    });
    // Preserve static version/signature/UI identity evidence even when this
    // runner cannot grant access to KVM. Never count that evidence as a boot.
    if (candidate) await checkKvmDevice();
    await step('official-sdk-and-hardware-acceleration', () => prepareOfficialAndroidSdk(env.ANDROID_HOME, command));
    await step('fresh-isolated-avd', async () => {
      const bin = path.join(env.ANDROID_HOME, 'cmdline-tools', 'latest', 'bin');
      await command('create-fresh-avd', path.join(bin, 'avdmanager'), ['create', 'avd', '-n', avdName, '-k', IMAGE, '-p', path.join(temporary, 'avds', `${avdName}.avd`)], { timeout: 90000, stdin: 'no\n' });
      const configFile = path.join(temporary, 'avds', `${avdName}.avd`, 'config.ini');
      const values = new Map((await fs.readFile(configFile, 'utf8')).split(/\r?\n/u).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      for (const [key, value] of Object.entries({ 'hw.ramSize': '3072', 'hw.cpu.ncore': '2', 'hw.lcd.width': '720', 'hw.lcd.height': '1280', 'hw.lcd.density': '320', 'hw.keyboard': 'yes', 'hw.camera.back': 'none', 'hw.camera.front': 'none', 'showDeviceFrame': 'no' })) values.set(key, value);
      await fs.writeFile(configFile, [...values].map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
      return { image: IMAGE, avd: avdName, ramMiB: 3072, device: '720x1280', hardwareAccelerationRequired: true };
    });
    await step('boot-isolated-emulator', async () => {
      for (const port of [5038, 5554, 5555, 8554]) {
        const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); }); await new Promise(resolve => probe.close(resolve));
      }
      // ADB accepts literal localhost for its loopback listener, not 127.0.0.1.
      // Keep numeric client addresses above so clients cannot auto-start a replacement server.
      adbService = await startService('adb-server', adbPath, ['-L', 'tcp:localhost:5038', '--one-device', 'openaster-no-usb', 'server', 'nodaemon']); await wait(1000);
      requireFact(!adbService.record.closed && !adbService.record.error, 'Owned ADB did not start');
      emulatorService = await startService('emulator', emulatorPath, ['-avd', avdName, '-port', '5554', '-accel', 'on', '-gpu', 'swiftshader', '-memory', '3072', '-cores', '2', '-no-window', '-no-audio', '-no-snapshot', '-no-boot-anim', '-camera-back', 'none', '-camera-front', 'none', '-no-metrics', '-no-direct-adb', '-adb-path', adbPath, '-grpc', '8554', '-grpc-use-jwt']);
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        requireFact(!emulatorService.record.closed && !emulatorService.record.error, 'Emulator exited before boot');
        const check = await adb('boot-progress', ['shell', 'getprop', 'sys.boot_completed'], { allowedFailure: true, timeout: 10000 });
        if (check.code === 0 && check.text.trim() === '1') { booted = true; receipt.observations.emulatorBooted = true; break; } await wait(2000);
      }
      requireFact(booted, 'Android did not boot within four minutes'); await ownedDevice();
      const selinux = await adb('guest-security', ['shell', 'getenforce']); requireFact(selinux.text.trim() === 'Enforcing', 'Guest SELinux is not enforcing');
      const resolution = await adb('guest-resolution', ['shell', 'wm', 'size']); requireFact(/Physical size: 720x1280/u.test(resolution.text), 'Unexpected guest dimensions');
      const api = await adb('guest-api', ['shell', 'getprop', 'ro.build.version.sdk']); requireFact(api.text.trim() === '36', 'Unexpected Android API');
      await adb('guest-webview', ['shell', 'dumpsys', 'webviewupdate']); return { bootCompleted: true, api: 36, selinux: 'Enforcing' };
    });
    await step('install-and-launch-fixed-apk', async () => {
      await ownedDevice();
      if (candidate) await verifyCandidateBytes(apkFile, artifact);
      else requireFact(await digest(apkFile) === APK.sha256, 'APK changed before install');
      const install = await adb(candidate ? 'install-candidate-apk' : 'install-published-apk', ['install', '--no-streaming', apkFile], { timeout: 90000 }); requireFact(/\bSuccess\b/u.test(install.text), 'APK installation was not confirmed'); installed = true;
      receipt.observations.apkInstalled = true;
      const info = await adb('installed-version', ['shell', 'dumpsys', 'package', APK.package]);
      requireFact(info.text.match(/\bversionCode=(\d+)(?:\s|$)/u)?.[1] === String(artifact.versionCode)
        && info.text.match(/\bversionName=(\S+)/u)?.[1] === artifact.version, 'Installed package version differs');
      const result = await adb(candidate ? 'launch-candidate-apk' : 'launch-published-apk', ['shell', 'am', 'start', '-W', '-n', `${APK.package}/.MainActivity`], { timeout: 45000 });
      requireFact(/Status: ok/u.test(result.text), 'Activity launch was not confirmed'); await waitForText('first-launch', /请先配置 HTTPS 网关/u);
      await foreground('first-launch-foreground');
      receipt.observations.offlineUiRendered = true;
      return { version: artifact.version, versionCode: artifact.versionCode, offlinePageRendered: true };
    });
    await step('cleartext-gateway-refusal', async () => {
      await click('open-gateway', /^配置网关$/u); await capture('gateway-dialog'); requireFact(hasText(/连接你的工作台/u), 'Gateway dialog did not open');
      const field = selectControl(lastNodes, node => node.class === 'android.widget.EditText' && node.password === 'false');
      await adb('focus-gateway-url', ['shell', 'input', 'tap', String(field.x), String(field.y)]);
      await adb('enter-cleartext-fixture', ['shell', 'input', 'text', 'http://127.0.0.1:9']);
      const keyboard = await adb('keyboard-state', ['shell', 'dumpsys', 'input_method']);
      // Back can leave the Activity when a hardware keyboard is active. Send
      // it only after Android confirms that the software input view is shown.
      if (/\b(?:mInputShown|inputShown|isInputViewShown)=true\b/u.test(keyboard.text)) await adb('dismiss-keyboard', ['shell', 'input', 'keyevent', '4']);
      await click('submit-cleartext-gateway', /^连接并验证$/u); await capture('cleartext-refused');
      requireFact(hasText(/网关必须使用 HTTPS/u), 'The UI did not reject a cleartext gateway'); await foreground('gateway-refusal-foreground');
      await click('close-gateway', /^(取消|关闭)$/u); return { cleartextRefused: true, syntheticInputOnly: true, accessTokenEntered: false };
    });
    await step('offline-settings-and-license-navigation', async () => {
      await click('open-navigation', /^打开导航$/u); await click('open-settings', /^设置(?:\s|$)/u); await capture('settings');
      requireFact(hasText(/模型与连接/u), 'Settings did not render');
      await click('open-packaged-notices', /^查看开源许可$/u, { scroll: true }); await capture('packaged-notices');
      requireFact(hasText(/^Android 开源许可$/u) && hasText(/Apache-2\.0/u), 'Bundled license inventory did not render');
      await click('expand-apache-license', /^Apache-2\.0(?:\s|·)/u); await capture('license-full-text');
      requireFact(hasText(/Apache License|Version 2\.0/u), 'Apache license full text did not render'); await foreground('license-navigation-foreground');
      await click('close-notices', /^关闭$/u); await click('reopen-navigation', /^打开导航$/u); await click('return-to-task', /^新建任务(?:\s|$)/u); await capture('returned-to-task');
      requireFact(hasText(/请先配置 HTTPS 网关/u), 'Return to offline task page failed'); await foreground('returned-to-task-foreground');
      return { settingsOpened: true, bundledLicenseOpened: true, licenseTextVisible: true, returnedToTask: true, foregroundAppConfirmedAfterLicenseExpansion: true };
    });
    await step('cold-relaunch', async () => {
      await adb('stop-owned-app', ['shell', 'am', 'force-stop', APK.package]);
      const result = await adb('cold-relaunch', ['shell', 'am', 'start', '-W', '-n', `${APK.package}/.MainActivity`], { timeout: 45000 });
      requireFact(/Status: ok/u.test(result.text), 'Cold relaunch was not confirmed'); await waitForText('cold-relaunch', /请先配置 HTTPS 网关/u);
      await foreground('cold-relaunch-foreground'); return { relaunched: true };
    });
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = receipt.environmentBlocked ? 'blocked' : 'failed'; receipt.error = clean(error.message); process.exitCode = 1;
  } finally {
    if (booted && installed && adbService && !adbService.record.closed && emulatorService && !emulatorService.record.closed) {
      try {
        const pid = await adb('app-process', ['shell', 'pidof', APK.package], { allowedFailure: true });
        if (/^\d+$/u.test(pid.text.trim())) {
          const errors = await adb('app-error-logcat', ['logcat', '--pid', pid.text.trim(), '-d', '-v', 'threadtime', '*:E']);
          if (/FATAL EXCEPTION|Fatal signal \d+/u.test(errors.text)) { receipt.status = 'failed'; receipt.error = 'Fatal app error was recorded in logcat'; process.exitCode = 1; }
        }
      } catch (error) { receipt.diagnosticError = clean(error.message); }
    }
    for (const service of [emulatorService, adbService]) {
      try { await stopService(service); }
      catch (error) { receipt.status = 'failed'; receipt.cleanupError = clean(error.message); process.exitCode = 1; }
    }
    receipt.finishedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ status: receipt.status, error: receipt.error, observations: receipt.observations,
      steps: receipt.steps.map(({ name, status, error }) => ({ name, status, error })), evidence }));
    if (receipt.status !== 'passed') {
      for (const file of ['emulator.stderr.log', 'adb-server.stderr.log']) {
        try { const bytes = await fs.readFile(path.join(evidence, file)); console.log(JSON.stringify({ log: file, tail: clean(bytes.subarray(-8000).toString('utf8')) })); } catch { /* A precondition may fail before service creation. */ }
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
