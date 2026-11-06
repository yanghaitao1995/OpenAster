// SPDX-License-Identifier: Apache-2.0
// Runs only on an ephemeral GitHub-hosted runner. No application source is built
// or modified: every executable download is pinned to a published v0.2.2 hash.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_COMMIT = '3a4ee6915312dcafd9e56ea5c40440c9b39c5985';
export const ARTIFACTS = Object.freeze({
  windows: Object.freeze({ platform: 'win32', arch: 'x64', file: 'OpenAster-0.2.2-win-x64.exe', bytes: 121664546, sha256: '6dd5dc1fb2006c4ef9e1c9ad0aec547febe9133d0172ba65513d4ee46af53f46' }),
  macos: Object.freeze({ platform: 'darwin', arch: 'arm64', file: 'OpenAster-0.2.2-mac-arm64.dmg', bytes: 120904092, sha256: '3f799a5ff9d5c57fd93d43c9570bdca4b711ec5787d2af48736e731209a71710' }),
  deb: Object.freeze({ platform: 'linux', arch: 'x64', file: 'OpenAster-0.2.2-linux-amd64.deb', bytes: 102126448, sha256: '7e494162f1f7f8ddb463c76681845a00d35d91d4fdf19a681b5421a3dd677b70' }),
  appimage: Object.freeze({ platform: 'linux', arch: 'x64', file: 'OpenAster-0.2.2-linux-x86_64.AppImage', bytes: 126116425, sha256: '9a2022e4181d188b22c8f8362acd1b5d72e8057ec95073b65a4f7a8caed97538' }),
});
const fail = message => { throw new Error(message); };
const inside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
export function assertDownloadURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) fail('Unapproved release download origin');
  return url;
}
export async function verifyArtifactFile(file, expected) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes) fail('Release asset size or file type differs from the pinned artifact');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  const actual = hash.digest('hex');
  if (actual !== expected.sha256) fail('Release asset SHA-256 differs from the pinned artifact; refusing execution');
  return { bytes: stat.size, sha256: actual };
}
function assertRunnerIdentity(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || env.GITHUB_REPOSITORY !== 'yanghaitao1995/OpenAster') fail('Installer acceptance is restricted to this repository on ephemeral GitHub-hosted runners');
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) fail('Missing absolute runner temporary directory');
}
export function assertHostedRunner(env, platform, arch, artifact) {
  assertRunnerIdentity(env);
  if (platform !== artifact.platform || arch !== artifact.arch) fail('The runner does not match the pinned artifact architecture');
}
export function executionEnvironment(source) {
  // Installed programs need OS paths, not workflow/authentication variables.
  const names = new Set(['path', 'home', 'userprofile', 'appdata', 'localappdata', 'systemroot', 'windir', 'comspec',
    'pathext', 'temp', 'tmp', 'tmpdir', 'programfiles', 'programfiles(x86)', 'programdata', 'lang', 'lc_all', 'lc_ctype',
    'display', 'xauthority', 'xdg_runtime_dir', 'xdg_config_home', 'xdg_data_home', 'dbus_session_bus_address']);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => names.has(key.toLowerCase()) && typeof value === 'string' && !value.includes('\0')));
}

function diagnosticText(value, limit = 1600) {
  // Logs come only from this runner's fixed installation fixture. Still remove
  // URLs, authorization values and terminal controls before publishing a tail.
  return String(value ?? '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*(?:-----END [^-]*PRIVATE KEY-----|$)/gu, '[redacted private key]')
    .replace(/\b(?:https?|ftp):\/\/[^\s<>"'`]+/giu, '[redacted URL]')
    .replace(/\b(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s,;"'}]+/giu, '[redacted credential]')
    .replace(/\bBearer\s+[^\s,;"'}]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|eyJ[\w-]{10,}\.[\w-]+\.[\w-]+)\b/gu, '[redacted token]')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .slice(-limit);
}

export async function acceptanceDiagnostics(receipt, output) {
  // Pick fields explicitly: command arguments and inherited environment are
  // never console diagnostics. JSON serialization keeps log text inert.
  const entries = receipt.steps.slice(0, 40);
  const events = [{ event: 'installer-acceptance', status: receipt.status, kind: receipt.kind,
    version: receipt.version, sourceCommit: receipt.sourceCommit,
    ...(receipt.error ? { error: diagnosticText(receipt.error) } : {}),
    ...(receipt.cleanupFailed ? { cleanupFailed: true } : {}),
    steps: entries.map(entry => ({ name: diagnosticText(entry.name, 100), status: entry.status,
      ...(entry.error ? { error: diagnosticText(entry.error) } : {}),
      ...(entry.command ? { command: { executable: diagnosticText(entry.command.executable, 100),
        code: entry.command.code, signal: entry.command.signal, timedOut: entry.command.timedOut,
        durationMs: entry.command.durationMs, ...(entry.command.spawnError ? { spawnError: diagnosticText(entry.command.spawnError, 100) } : {}),
        ...(entry.command.termination ? { termination: { requested: entry.command.termination.requested,
          exitCode: entry.command.termination.exitCode, cleanupUnconfirmed: entry.command.termination.cleanupUnconfirmed,
          errorCode: diagnosticText(entry.command.termination.errorCode, 100) } } : {}) } } : {}) })) }];
  if (receipt.status !== 'failed') return events;
  // Include failed commands first, then recent prerequisites: a later file or
  // result check can fail after a command returned zero. Only known log names
  // in the fixed evidence directory may be read; never follow a log symlink.
  const candidates = [...entries.filter(entry => entry.status === 'failed').reverse(), ...entries.slice().reverse()];
  const logs = [...new Set(candidates.map(entry => entry.command?.log).filter(name => typeof name === 'string' && /^\d{2}-[a-z0-9-]+\.log$/u.test(name)))].slice(0, 4);
  for (const log of logs) {
    let handle;
    try {
      const file = path.join(output, log), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('Diagnostic log must be an ordinary file');
      handle = await fs.open(file, 'r');
      const buffer = Buffer.alloc(Math.min(stat.size, 16384));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
      events.push({ event: 'installer-log-tail', log, fileBytes: stat.size,
        tail: diagnosticText(buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/u).slice(-80).join('\n'), 8000) });
    } catch (error) {
      events.push({ event: 'installer-log-tail', log, readError: diagnosticText(error?.code ?? error?.message) });
    } finally { await handle?.close(); }
  }
  return events;
}

async function download(file, artifact) {
  let url = assertDownloadURL(`https://github.com/yanghaitao1995/OpenAster/releases/download/v0.2.2/${artifact.file}`);
  const signal = AbortSignal.timeout(300000);
  for (let redirect = 0; redirect <= 5; redirect++) {
    const response = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'OpenAster-published-installer-acceptance', 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirect === 5) fail('Release download redirect limit exceeded');
      url = assertDownloadURL(new URL(location, url)); continue;
    }
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); fail(`Release download returned HTTP ${response.status}`); }
    const handle = await fs.open(file, 'wx', 0o600);
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > artifact.bytes) fail('Release download exceeded the pinned size');
        await handle.writeFile(chunk);
      }
    } finally { await handle.close(); }
    return await verifyArtifactFile(file, artifact);
  }
  fail('Release download failed');
}

export async function main() {
  const kind = process.env.OPENASTER_ACCEPTANCE_KIND, artifact = ARTIFACTS[kind];
  if (!artifact) fail('Unknown fixed release artifact');
  assertRunnerIdentity(process.env);
  const workspace = await fs.realpath(process.env.GITHUB_WORKSPACE);
  // Keep even bad checkout/output configuration in the one fixed evidence path.
  // No caller-supplied output directory is ever written.
  const output = path.join(workspace, 'installer-evidence');
  await fs.mkdir(output, { recursive: true });
  if (await fs.realpath(output) !== output) fail('Evidence directory must not resolve through a link');
  const receipt = { format: 'openaster-published-installer-acceptance-v1', version: '0.2.2', sourceCommit: RELEASE_COMMIT,
    verificationCommit: process.env.GITHUB_SHA, kind, artifact, runner: { os: process.platform, arch: process.arch, image: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null },
    startedAt: new Date().toISOString(), status: 'running', steps: [], realModelCalls: 0, securitySettingsChanged: false,
    scope: 'Fixed published asset installation and native smoke; not all functionality, signature trust, upgrade or every OS/CPU.',
    downloadTrustScope: 'Anonymous HTTPS plus pinned hash. A command-line download may lack browser quarantine metadata; this is not a Gatekeeper or SmartScreen first-download acceptance test.',
    smokeCoverage: 'Page loads, local service connects, renderer isolation, workspace menus, and OS secret/draft storage (Linux may correctly refuse unavailable keyring). No live model or user project.' };
  const save = () => fs.writeFile(path.join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  const step = async (name, action) => {
    const entry = { name, startedAt: new Date().toISOString(), status: 'running' }; receipt.steps.push(entry); await save();
    try { const facts = await action(); entry.status = 'passed'; entry.facts = facts; return facts; }
    catch (error) { entry.status = 'failed'; entry.error = String(error?.message ?? 'Step failed').slice(0, 4000); throw error; }
    finally { entry.finishedAt = new Date().toISOString(); await save(); }
  };
  let sequence = 0, source;
  async function command(name, executable, args, { cwd = source, timeoutMs = 120000, env = executionEnvironment(process.env) } = {}) {
    const log = `${String(++sequence).padStart(2, '0')}-${name}.log`;
    return await step(name, async () => {
      let outputText = '', timedOut = false, spawnError, timer, reapTimer, terminationPromise;
      const termination = { requested: false };
      const started = Date.now();
      const child = spawn(executable, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = bytes => { outputText = `${outputText}${bytes.toString('utf8')}`.slice(-262144); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const stopOwned = () => {
        if (!child.pid) return;
        termination.requested = true; termination.pid = child.pid;
        if (process.platform === 'win32') {
          const killer = spawn(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          terminationPromise = new Promise(resolve => {
            const killDeadline = setTimeout(() => { termination.cleanupUnconfirmed = true; killer.kill(); resolve(); }, 5000);
            killer.on('error', error => { termination.errorCode = error.code; termination.cleanupUnconfirmed = true; });
            killer.on('close', code => { clearTimeout(killDeadline); termination.exitCode = code; if (code !== 0) termination.cleanupUnconfirmed = true; resolve(); });
          });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); termination.signalSent = true; }
          catch (error) { if (error.code === 'ESRCH') termination.groupAlreadyGone = true; else { termination.errorCode = error.code; termination.cleanupUnconfirmed = true; } }
        }
      };
      const result = await new Promise(resolve => {
        child.on('error', error => { spawnError = error.code; });
        child.on('close', (code, signal) => resolve({ code, signal }));
        timer = setTimeout(() => { timedOut = true; stopOwned(); reapTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); resolve({ code: null, signal: 'cleanup-timeout' }); }, 10000); }, timeoutMs);
      });
      clearTimeout(timer); clearTimeout(reapTimer);
      await terminationPromise;
      if (result.signal === 'cleanup-timeout') termination.cleanupUnconfirmed = true;
      await fs.writeFile(path.join(output, log), outputText);
      const facts = { executable: path.basename(executable), args, log, ...result, timedOut, durationMs: Date.now() - started, ...(spawnError ? { spawnError } : {}), ...(termination.requested ? { termination } : {}) };
      receipt.steps.at(-1).command = facts;
      if (result.code !== 0 || timedOut || spawnError) fail(`${name} failed (${spawnError ?? result.code ?? result.signal}); see ${log}`);
      return { ...facts, outputText };
    });
  }
  let mountpoint, mounted = false;
  try {
    await save();
    await step('runner-and-architecture-policy', async () => {
      assertHostedRunner(process.env, process.platform, process.arch, artifact);
      return { hostedRunner: true, platform: process.platform, architecture: process.arch };
    });
    await step('checkout-and-evidence-path-policy', async () => {
      if (!process.env.OPENASTER_ACCEPTANCE_OUTPUT || path.resolve(process.env.OPENASTER_ACCEPTANCE_OUTPUT) !== output) fail('Evidence directory must be the expected workspace child');
      if (!process.env.OPENASTER_ACCEPTANCE_SOURCE) fail('Missing published source checkout path');
      source = await fs.realpath(process.env.OPENASTER_ACCEPTANCE_SOURCE);
      if (!inside(workspace, source)) fail('Published source checkout must be inside the runner workspace');
      return { checkout: source, evidence: output };
    });
    const git = await command('source-commit', 'git', ['rev-parse', 'HEAD']);
    await step('published-source-identity', async () => {
      if (git.outputText.trim() !== RELEASE_COMMIT) fail('Smoke source is not the fixed published commit');
      const packageInfo = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
      if (packageInfo.version !== '0.2.2') fail('Published source package version differs');
      return { commit: RELEASE_COMMIT, version: packageInfo.version };
    });
    const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP);
    const temporary = await fs.mkdtemp(path.join(runnerTemp, 'openaster-release-'));
    if (!inside(runnerTemp, temporary)) fail('Invalid runner installation directory');
    receipt.temporaryDirectory = temporary;
    const asset = path.join(temporary, artifact.file);
    await step('download-and-verify', () => download(asset, artifact));
    const smoke = path.join(source, 'scripts', 'desktop-smoke.mjs');
    let executable;
    if (kind === 'windows') {
      const target = path.join(temporary, 'installed');
      // NSIS /D must be the last unquoted argument; hosted runner paths have no spaces.
      if (/\s|["\r\n]/u.test(target)) fail('NSIS acceptance requires a runner path without whitespace');
      await command('nsis-install-current-user', asset, ['/S', '/currentuser', `/D=${target}`], { cwd: temporary, timeoutMs: 180000 });
      executable = path.join(target, 'OpenAster.exe');
    } else if (kind === 'macos') {
      mountpoint = path.join(temporary, 'mounted'); await fs.mkdir(mountpoint);
      // A failed/partial attach is still detached in finally; no force unmount.
      mounted = true;
      await command('dmg-mount-readonly', '/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, asset], { timeoutMs: 90000 });
      const destination = path.join(temporary, 'OpenAster.app');
      await command('copy-app-preserve-metadata', '/usr/bin/ditto', ['--rsrc', '--extattr', path.join(mountpoint, 'OpenAster.app'), destination]);
      await command('dmg-detach', '/usr/bin/hdiutil', ['detach', mountpoint], { timeoutMs: 30000 }); mounted = false;
      executable = path.join(destination, 'Contents', 'MacOS', 'OpenAster');
    } else {
      await command('apt-metadata', 'sudo', ['-n', 'apt-get', 'update'], { timeoutMs: 180000 });
      await command('linux-runtime-dependencies', 'sudo', ['-n', 'apt-get', 'install', '-y', '--no-install-recommends', 'xvfb', 'xauth', 'libgtk-3-0', 'libnss3', 'libasound2', 'libgbm1', 'libxss1', 'libfuse2'], { timeoutMs: 180000, env: { ...executionEnvironment(process.env), DEBIAN_FRONTEND: 'noninteractive' } });
      if (kind === 'deb') {
        await command('deb-install', 'sudo', ['-n', 'apt-get', 'install', '-y', '--no-install-recommends', asset], { timeoutMs: 180000, env: { ...executionEnvironment(process.env), DEBIAN_FRONTEND: 'noninteractive' } });
        const installed = await command('deb-version', 'dpkg-query', ['-W', '-f=${Version}\n${Architecture}\n', 'openaster']);
        await step('installed-deb-identity', async () => {
          if (installed.outputText.trim() !== '0.2.2\namd64') fail('Installed DEB version or architecture differs');
          return { version: '0.2.2', architecture: 'amd64' };
        });
        executable = '/opt/OpenAster/openaster';
      } else {
        await fs.chmod(asset, 0o700);
        // Test the actual AppImage/FUSE entry point, not an extracted fallback.
        executable = asset;
      }
    }
    await step('installed-executable', async () => {
      const info = await fs.lstat(executable);
      if (!info.isFile() || info.isSymbolicLink()) fail('Expected installed executable is missing or linked');
      return { executable, bytes: info.size };
    });
    // Never supply --no-sandbox, relax AppArmor/sysctl, or alter Gatekeeper/quarantine.
    const args = [smoke, executable, '--software-rendering'];
    const smokeResult = process.platform === 'linux'
      ? await command('installed-smoke', 'xvfb-run', ['-a', '--server-args=-screen 0 1280x800x24', process.execPath, ...args], { timeoutMs: 90000 })
      : await command('installed-smoke', process.execPath, args, { timeoutMs: 90000 });
    receipt.smoke = await step('validate-smoke-result', async () => {
      const line = smokeResult.outputText.split(/\r?\n/u).find(value => value.startsWith('{"executable":'));
      const facts = line ? JSON.parse(line) : null;
      if (!facts?.ok || !facts.sandboxed || !facts.connected) fail('Native smoke did not confirm success, renderer sandbox and local service connection');
      return facts;
    });
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = 'failed'; receipt.error = String(error?.message ?? 'Acceptance failed').slice(0, 4000);
    process.exitCode = 1;
  } finally {
    if (mounted) {
      try { await command('dmg-detach-cleanup', '/usr/bin/hdiutil', ['detach', mountpoint], { timeoutMs: 30000 }); }
      catch { receipt.status = 'failed'; receipt.cleanupFailed = true; process.exitCode = 1; }
    }
    receipt.finishedAt = new Date().toISOString(); await save();
    // The ephemeral runner is discarded; never recursively remove guessed paths.
    try {
      for (const event of await acceptanceDiagnostics(receipt, output)) console.log(JSON.stringify(event));
    } catch (error) {
      // Diagnostic rendering must not replace the original acceptance outcome.
      console.log(JSON.stringify({ event: 'installer-diagnostic-error', status: receipt.status, error: diagnosticText(error?.message) }));
    }
    console.log(JSON.stringify({ status: receipt.status, kind, receipt: path.join(output, 'receipt.json') }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
