// SPDX-License-Identifier: Apache-2.0
// Runs only on an ephemeral GitHub-hosted runner. No application source is built
// or modified. Default downloads are pinned to v0.2.2; the separate candidate
// entry accepts only fixed local build files from this same checkout.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedBuildInfo } from './lib/build-info.mjs';

export const RELEASE_COMMIT = '3a4ee6915312dcafd9e56ea5c40440c9b39c5985';
export const ARTIFACTS = Object.freeze({
  windows: Object.freeze({ platform: 'win32', arch: 'x64', file: 'OpenAster-0.2.2-win-x64.exe', bytes: 121664546, sha256: '6dd5dc1fb2006c4ef9e1c9ad0aec547febe9133d0172ba65513d4ee46af53f46' }),
  macos: Object.freeze({ platform: 'darwin', arch: 'arm64', file: 'OpenAster-0.2.2-mac-arm64.dmg', bytes: 120904092, sha256: '3f799a5ff9d5c57fd93d43c9570bdca4b711ec5787d2af48736e731209a71710' }),
  deb: Object.freeze({ platform: 'linux', arch: 'x64', file: 'OpenAster-0.2.2-linux-amd64.deb', bytes: 102126448, sha256: '7e494162f1f7f8ddb463c76681845a00d35d91d4fdf19a681b5421a3dd677b70' }),
  appimage: Object.freeze({ platform: 'linux', arch: 'x64', file: 'OpenAster-0.2.2-linux-x86_64.AppImage', bytes: 126116425, sha256: '9a2022e4181d188b22c8f8362acd1b5d72e8057ec95073b65a4f7a8caed97538' }),
});
export const CANDIDATE_VERSION = '0.2.4';
export const CANDIDATE_ARTIFACTS = Object.freeze(Object.fromEntries(Object.entries(ARTIFACTS).map(([kind, artifact]) => [kind,
  Object.freeze({ platform: artifact.platform, arch: artifact.arch, file: artifact.file.replace('0.2.2', CANDIDATE_VERSION) })])));
const fail = message => { throw new Error(message); };
const samePath = (left, right) => process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const revision = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
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
  const actual = await artifactSnapshot(file);
  if (actual.bytes !== expected.bytes) fail('Release asset size differs from the pinned artifact');
  if (actual.sha256 !== expected.sha256) fail('Release asset SHA-256 differs from the pinned artifact; refusing execution');
  return actual;
}
async function artifactSnapshot(file) {
  const installed = await fs.lstat(file, { bigint: true });
  if (!installed.isFile() || installed.isSymbolicLink() || installed.nlink !== 1n || installed.size <= 0n || installed.size > 1024n * 1024n * 1024n
    || !samePath(await fs.realpath(file), file)) fail('Installer must be a bounded ordinary single-link file without redirected parents');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (revision(before) !== revision(installed) || !before.isFile() || before.nlink !== 1n) fail('Installer changed before reading');
    const hash = createHash('sha256');
    let count = 0;
    for await (const bytes of handle.createReadStream({ autoClose: false })) {
      count += bytes.length;
      if (BigInt(count) > before.size) fail('Installer grew during verification');
      hash.update(bytes);
    }
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true });
    if (revision(before) !== revision(after) || revision(before) !== revision(current) || current.nlink !== 1n || current.isSymbolicLink()
      || BigInt(count) !== before.size || !samePath(await fs.realpath(file), file)) fail('Installer changed during verification');
    return { bytes: count, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}
export function assertCandidatePolicy(env, platform, arch, kind) {
  const artifact = Object.hasOwn(CANDIDATE_ARTIFACTS, kind ?? '') ? CANDIDATE_ARTIFACTS[kind] : null;
  if (!artifact) fail('Unknown fixed candidate artifact');
  assertHostedRunner(env, platform, arch, artifact);
  if (env.GITHUB_SHA?.length !== 40 || !/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? '') || !env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE)) fail('Candidate requires the current checkout SHA and an absolute GitHub workspace');
  if (env.OPENASTER_ACCEPTANCE_SOURCE || env.OPENASTER_ACCEPTANCE_OUTPUT) fail('Candidate verification does not accept source or output path overrides');
  return artifact;
}
export function assertCandidateCheckout(env, source, toolSource, head, version) {
  if (!samePath(source, env.GITHUB_WORKSPACE) || !samePath(source, toolSource) || head !== env.GITHUB_SHA || version !== CANDIDATE_VERSION) fail('Candidate must come from this exact checkout, commit and package version');
}
export async function candidateArtifactSnapshot(source, kind) {
  const artifact = Object.hasOwn(CANDIDATE_ARTIFACTS, kind ?? '') ? CANDIDATE_ARTIFACTS[kind] : null;
  if (!artifact) fail('Unknown fixed candidate artifact');
  const directory = path.join(source, 'release'), stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) fail('Candidate release directory must be an ordinary checkout directory');
  return Object.freeze({ ...artifact, ...await artifactSnapshot(path.join(directory, artifact.file)) });
}
export async function candidateBuildIdentity(source) {
  const expected = { ...await sharedBuildInfo(source), mode: 'desktop-web' };
  const file = path.join(source, 'dist', 'public', 'build-info.json'), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384 || !samePath(await fs.realpath(file), file)) fail('Candidate build identity must be an ordinary generated file');
  const actual = JSON.parse(await fs.readFile(file, 'utf8'));
  if (expected.version !== CANDIDATE_VERSION || JSON.stringify(actual) !== JSON.stringify(expected)) fail('Candidate generated UI identity differs from this source checkout');
  return expected;
}
export function validateCandidateScenario(output, scenario) {
  if (!['basic', 'backup', 'relaunch'].includes(scenario)) fail('Unknown fixed candidate scenario');
  const lines = String(output).split(/\r?\n/u).filter(value => value.startsWith('{"executable":'));
  if (lines.length !== 1) fail('Native smoke must return exactly one result');
  const facts = JSON.parse(lines[0]);
  if (facts.ok !== true) fail('Native smoke did not confirm success');
  if (scenario === 'relaunch') {
    if (facts.actualProcessRelaunches !== 4 || facts.processCount !== 5 || facts.allRecordedProcessesExited !== true || facts.temporaryResourcesCleaned !== true
      || facts.draftRecovery?.profiles !== 2 || facts.draftRecovery?.draftsPerProfile !== 2 || facts.phaseProofs?.length !== 5) fail('Relaunch smoke did not confirm five-process task, workspace and draft recovery');
  } else {
    if (facts.sandboxed !== true || facts.connected !== true) fail('Native smoke did not confirm renderer sandbox and local service connection');
    if (scenario === 'backup') {
      if (facts.secretStorage?.available !== true || facts.deviceDraftStorage?.available !== true) fail('OS protected keyring/draft storage is unavailable; extended acceptance is not satisfied');
      const proof = facts.backupLifecycle;
      if (!proof || proof.tasks !== 2 || proof.toolArtifacts < 2 || ['realMenuCallbacks', 'workerBackup', 'workerRestore', 'restoredProfileReopened',
        'artifactBytesPreserved', 'originalWorkspacePreserved', 'handoffSnapshotRestored', 'handoffHistoryNotReplayed', 'summaryDraftRestored'].some(key => proof[key] !== true)) fail('Native backup smoke did not confirm backup, restore and preserved mock task history');
      const readiness = proof.rendererReadiness;
      if (!readiness || readiness.version !== 1 || readiness.policy !== 'pause-new-background-requests-before-transition'
        || readiness.allAdmittedRequestsSettled !== true || readiness.allStartedHandlersSettled !== true
        || ['admittedRequests', 'completedRequests', 'eventStreamsReady', 'pausedRequests', 'handlersStarted', 'handlersSettled'].some(key => !Number.isSafeInteger(readiness[key]) || readiness[key] < 0)
        || readiness.handlersStarted === 0 || readiness.handlersStarted !== readiness.handlersSettled
        || readiness.completedRequests > readiness.admittedRequests || readiness.eventStreamsReady > readiness.admittedRequests
        || proof.transitionReadiness !== 'fixture paused new renderer and service worker requests before backup; not naturally idle startup') fail('Native backup smoke did not confirm its controlled-idle request and handler drain');
    }
  }
  return facts;
}

export async function verifyMacCandidateSignature(bundle, stage, command, expected) {
  if (!path.isAbsolute(bundle) || path.basename(bundle) !== 'OpenAster.app' || /[\x00-\x1f\x7f]/u.test(bundle)
    || !['dmg', 'installed'].includes(stage) || typeof command !== 'function') fail('Invalid fixed macOS signature verification target');
  // Verify the complete bundle, including nested code, before reading identity.
  // These commands never sign code or change Gatekeeper, Keychain or quarantine.
  await command(stage + '-code-signature-verify', '/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const displayed = await command(stage + '-code-signature-identity', '/usr/bin/codesign', ['--display', '--verbose=4', '--requirements=-', bundle]);
  const output = displayed?.outputText;
  if (typeof output !== 'string' || output.length > 65536 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(output)) fail('Invalid macOS signature identity output');
  const lines = output.split(/\r?\n/u);
  const field = prefix => {
    const matches = lines.filter(line => line.startsWith(prefix));
    if (matches.length !== 1 || !matches[0].slice(prefix.length).trim()) fail('Missing or ambiguous macOS signature identity field');
    return matches[0].slice(prefix.length);
  };
  const executable = field('Executable='), identifier = field('Identifier='), signature = field('Signature='), teamIdentifier = field('TeamIdentifier=');
  // codesign prefixes its implicit (synthesized) designated requirement with
  // "# ". Retain that form when comparing the mounted and copied identities.
  const requirements = lines.filter(line => /^(?:# )?designated => /u.test(line));
  if (requirements.length !== 1 || !requirements[0].replace(/^(?:# )?designated => /u, '').trim()) fail('Missing or ambiguous macOS designated requirement');
  const cdHash = field('CDHash='), designatedRequirement = requirements[0], directory = field('CodeDirectory ');
  const flagMatch = /(?:^| )flags=0x([a-f0-9]{1,8})\([^\r\n]*?\)(?: |$)/iu.exec(directory);
  const flags = flagMatch ? Number.parseInt(flagMatch[1], 16) : 0;
  if (executable !== path.join(bundle, 'Contents', 'MacOS', 'OpenAster') || identifier !== 'org.openaster.preview'
    || signature !== 'adhoc' || teamIdentifier !== 'not set' || (flags & 0x10002) !== 0x10002
    || !/^[a-f0-9]{40}$/iu.test(cdHash) || designatedRequirement.length > 8192) fail('Candidate macOS bundle lacks the expected ad hoc hardened-runtime identity');
  const identity = { identifier, signature, teamIdentifier, cdHash: cdHash.toLowerCase(), designatedRequirement, flags,
    hardenedRuntime: true, developerId: false, notarizationVerified: false };
  if (expected && ['identifier', 'signature', 'teamIdentifier', 'cdHash', 'designatedRequirement', 'flags'].some(key => identity[key] !== expected[key])) {
    fail('Copied macOS bundle signature identity differs from the read-only DMG');
  }
  return identity;
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
    'display', 'xauthority', 'xdg_runtime_dir', 'xdg_config_home', 'xdg_data_home', 'xdg_current_desktop', 'dbus_session_bus_address']);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => names.has(key.toLowerCase()) && typeof value === 'string' && !value.includes('\0')));
}

export async function confirmOwnedUnixGroupStopped(pid, { signal = process.kill, now = Date.now,
  pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) fail('Invalid owned command process group');
  const deadline = now() + 2000;
  while (true) {
    try { signal(-pid, 0); }
    catch (error) { return { confirmed: error.code === 'ESRCH', ...(error.code !== 'ESRCH' ? { errorCode: error.code ?? 'UNKNOWN' } : {}) }; }
    if (now() >= deadline) return { confirmed: false };
    await pause(50);
  }
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

export async function main({ candidate = false } = {}) {
  if (typeof candidate !== 'boolean') fail('Invalid acceptance mode');
  const kind = process.env.OPENASTER_ACCEPTANCE_KIND, definitions = candidate ? CANDIDATE_ARTIFACTS : ARTIFACTS;
  let artifact = Object.hasOwn(definitions, kind ?? '') ? definitions[kind] : null;
  if (!artifact) fail('Unknown fixed release artifact');
  assertRunnerIdentity(process.env);
  const workspace = await fs.realpath(process.env.GITHUB_WORKSPACE);
  if (candidate && (!samePath(workspace, process.env.GITHUB_WORKSPACE) || !samePath(workspace, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')))) fail('Candidate tools and build must share the exact GitHub workspace checkout');
  // Keep even bad checkout/output configuration in the one fixed evidence path.
  // No caller-supplied output directory is ever written.
  let output = workspace;
  for (const name of candidate ? ['candidate-evidence', kind] : ['installer-evidence']) {
    output = path.join(output, name);
    try { await fs.mkdir(output); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(output);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(output), output)) fail('Evidence directory must not resolve through a link');
  }
  const version = candidate ? CANDIDATE_VERSION : '0.2.2';
  const receipt = { format: candidate ? 'openaster-candidate-installer-acceptance-v1' : 'openaster-published-installer-acceptance-v1', version, sourceCommit: candidate ? process.env.GITHUB_SHA : RELEASE_COMMIT,
    verificationCommit: process.env.GITHUB_SHA, kind, artifact, runner: { os: process.platform, arch: process.arch, image: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null },
    startedAt: new Date().toISOString(), status: 'running', steps: [], realModelCalls: 0, securitySettingsChanged: false,
    scope: candidate ? 'Local candidate content verification, installation, basic, native backup and five-process relaunch smoke; not all functionality, signature trust, upgrade or every OS/CPU.' : 'Fixed published asset installation and native smoke; not all functionality, signature trust, upgrade or every OS/CPU.',
    downloadTrustScope: candidate ? 'No installer network download. Fixed local build from this checkout, measured before use and reverified before execution; not a Gatekeeper or SmartScreen first-download acceptance test.' : 'Anonymous HTTPS plus pinned hash. A command-line download may lack browser quarantine metadata; this is not a Gatekeeper or SmartScreen first-download acceptance test.',
    smokeCoverage: candidate ? 'Installed entry point, renderer isolation, local mock tasks, native backup/restore, branch and historical attachment preservation, five-process relaunch, workspace and OS-encrypted key/draft isolation. No live model calls. Missing protected keyring fails extended acceptance.' : 'Page loads, local service connects, renderer isolation, workspace menus, and OS secret/draft storage (Linux may correctly refuse unavailable keyring). No live model or user project.' };
  if (candidate) receipt.scenarios = Object.fromEntries(['basic', 'backup', 'relaunch'].map(name => [name, { status: 'not-run', reason: 'Installation, content checks and basic startup must pass first' }]));
  const save = () => fs.writeFile(path.join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  const step = async (name, action) => {
    const entry = { name, startedAt: new Date().toISOString(), status: 'running' }; receipt.steps.push(entry); await save();
    try { const facts = await action(); entry.status = 'passed'; entry.facts = facts; return facts; }
    catch (error) { entry.status = 'failed'; entry.error = String(error?.message ?? 'Step failed').slice(0, 4000); throw error; }
    finally { entry.finishedAt = new Date().toISOString(); await save(); }
  };
  let sequence = 0, source, originalCandidate;
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
      // Fixture descendants may outlive a failed direct child. Linux keyring
      // scenarios also require teardown after success. Only the detached PGID
      // created by this invocation is signalled, from its surviving owner.
      const linuxKeyringSmoke = candidate && process.platform === 'linux' && /^installed-(?:basic|backup|relaunch)-smoke$/u.test(name);
      if (process.platform !== 'win32' && child.pid && (result.code !== 0 || timedOut || spawnError || linuxKeyringSmoke)) {
        if (!termination.requested) stopOwned();
        const stopped = await confirmOwnedUnixGroupStopped(child.pid);
        termination.groupExitConfirmed = stopped.confirmed;
        if (!stopped.confirmed) { termination.cleanupUnconfirmed = true; if (stopped.errorCode) termination.errorCode = stopped.errorCode; }
      }
      await fs.writeFile(path.join(output, log), outputText);
      const facts = { executable: path.basename(executable), args, log, ...result, timedOut, durationMs: Date.now() - started, ...(spawnError ? { spawnError } : {}), ...(termination.requested ? { termination } : {}) };
      receipt.steps.at(-1).command = facts;
      if (termination.cleanupUnconfirmed) fail(`${name} owned process group cleanup was not confirmed; see ${log}`);
      if (result.code !== 0 || timedOut || spawnError) fail(`${name} failed (${spawnError ?? result.code ?? result.signal}); see ${log}`);
      return { ...facts, outputText };
    });
  }
  let mountpoint, mounted = false;
  try {
    await save();
    await step('runner-and-architecture-policy', async () => {
      if (candidate) assertCandidatePolicy(process.env, process.platform, process.arch, kind);
      else assertHostedRunner(process.env, process.platform, process.arch, artifact);
      return { hostedRunner: true, platform: process.platform, architecture: process.arch };
    });
    await step('checkout-and-evidence-path-policy', async () => {
      if (candidate) {
        source = workspace;
        if (!samePath(source, process.env.GITHUB_WORKSPACE) || !samePath(source, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))) fail('Candidate tools and build must share the exact GitHub workspace checkout');
        return { checkout: source, evidence: output };
      }
      if (!process.env.OPENASTER_ACCEPTANCE_OUTPUT || path.resolve(process.env.OPENASTER_ACCEPTANCE_OUTPUT) !== output) fail('Evidence directory must be the expected workspace child');
      if (!process.env.OPENASTER_ACCEPTANCE_SOURCE) fail('Missing published source checkout path');
      source = await fs.realpath(process.env.OPENASTER_ACCEPTANCE_SOURCE);
      if (!inside(workspace, source)) fail('Published source checkout must be inside the runner workspace');
      return { checkout: source, evidence: output };
    });
    const git = await command('source-commit', 'git', ['rev-parse', 'HEAD']);
    await step(candidate ? 'candidate-source-identity' : 'published-source-identity', async () => {
      const packageInfo = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
      if (candidate) {
        assertCandidateCheckout(process.env, source, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), git.outputText.trim(), packageInfo.version);
        return { commit: git.outputText.trim(), version: packageInfo.version };
      }
      if (git.outputText.trim() !== RELEASE_COMMIT) fail('Smoke source is not the fixed published commit');
      if (packageInfo.version !== '0.2.2') fail('Published source package version differs');
      return { commit: RELEASE_COMMIT, version: packageInfo.version };
    });
    if (candidate) {
      await command('source-unmodified', 'git', ['diff', '--quiet', '--no-ext-diff', 'HEAD', '--']);
      receipt.sourceBuildInfo = await step('candidate-source-and-generated-ui-identity', () => candidateBuildIdentity(source));
      artifact = await step('candidate-original-integrity', () => candidateArtifactSnapshot(source, kind));
      receipt.artifact = artifact;
      originalCandidate = path.join(source, 'release', artifact.file);
    }
    const runnerTemp = await fs.realpath(process.env.RUNNER_TEMP);
    const temporary = await fs.mkdtemp(path.join(runnerTemp, 'openaster-release-'));
    if (!inside(runnerTemp, temporary)) fail('Invalid runner installation directory');
    receipt.temporaryDirectory = temporary;
    const asset = path.join(temporary, artifact.file);
    if (candidate) {
      await step('copy-and-verify-local-candidate', async () => {
        await fs.copyFile(originalCandidate, asset, constants.COPYFILE_EXCL);
        await verifyArtifactFile(originalCandidate, artifact);
        return await verifyArtifactFile(asset, artifact);
      });
    } else await step('download-and-verify', () => download(asset, artifact));
    const verifyBeforeExecution = () => step('installer-integrity-before-execution', () => verifyArtifactFile(asset, artifact));
    const smoke = path.join(source, 'scripts', 'desktop-smoke.mjs');
    let executable;
    if (kind === 'windows') {
      const target = path.join(temporary, 'installed');
      // NSIS /D must be the last unquoted argument; hosted runner paths have no spaces.
      if (/\s|["\r\n]/u.test(target)) fail('NSIS acceptance requires a runner path without whitespace');
      await verifyBeforeExecution();
      await command('nsis-install-current-user', asset, ['/S', '/currentuser', `/D=${target}`], { cwd: temporary, timeoutMs: 180000 });
      executable = path.join(target, 'OpenAster.exe');
    } else if (kind === 'macos') {
      mountpoint = path.join(temporary, 'mounted'); await fs.mkdir(mountpoint);
      // A failed/partial attach is still detached in finally; no force unmount.
      mounted = true;
      await verifyBeforeExecution();
      await command('dmg-mount-readonly', '/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, asset], { timeoutMs: 90000 });
      const mountedApp = path.join(mountpoint, 'OpenAster.app'), destination = path.join(temporary, 'OpenAster.app');
      const dmgSignature = candidate ? await verifyMacCandidateSignature(mountedApp, 'dmg', command) : null;
      await command('copy-app-preserve-metadata', '/usr/bin/ditto', ['--rsrc', '--extattr', mountedApp, destination]);
      if (candidate) receipt.macCodeSignature = {
        dmg: dmgSignature, installed: await verifyMacCandidateSignature(destination, 'installed', command, dmgSignature), identitiesMatch: true,
        scope: 'Complete ad hoc bundle code integrity with hardened runtime; no Apple Developer ID or notarization claim.',
      };
      await command('dmg-detach', '/usr/bin/hdiutil', ['detach', mountpoint], { timeoutMs: 30000 }); mounted = false;
      executable = path.join(destination, 'Contents', 'MacOS', 'OpenAster');
    } else {
      await command('apt-metadata', 'sudo', ['-n', 'apt-get', 'update'], { timeoutMs: 180000 });
      await command('linux-runtime-dependencies', 'sudo', ['-n', 'apt-get', 'install', '-y', '--no-install-recommends', 'xvfb', 'xauth', 'libgtk-3-0', 'libnss3', 'libasound2', 'libgbm1', 'libxss1', 'libfuse2'], { timeoutMs: 180000, env: { ...executionEnvironment(process.env), DEBIAN_FRONTEND: 'noninteractive' } });
      if (kind === 'deb') {
        await verifyBeforeExecution();
        await command('deb-install', 'sudo', ['-n', 'apt-get', 'install', '-y', '--no-install-recommends', asset], { timeoutMs: 180000, env: { ...executionEnvironment(process.env), DEBIAN_FRONTEND: 'noninteractive' } });
        const installed = await command('deb-version', 'dpkg-query', ['-W', '-f=${Version}\n${Architecture}\n', 'openaster']);
        await step('installed-deb-identity', async () => {
          if (installed.outputText.trim() !== `${version}\namd64`) fail('Installed DEB version or architecture differs');
          return { version, architecture: 'amd64' };
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
    if (candidate) {
      const verifier = await import('../desktop/verify-package.mjs');
      let archive, runtimeExecutable = executable;
      if (kind === 'appimage') {
        const inspection = path.join(temporary, 'content-inspection'); await fs.mkdir(inspection);
        await verifyBeforeExecution();
        // Extraction is solely for reading exact candidate payload bytes. All
        // launches below still execute the original AppImage/FUSE entry point.
        await command('appimage-extract-for-content-check', asset, ['--appimage-extract'], { cwd: inspection, timeoutMs: 120000 });
        runtimeExecutable = path.join(inspection, 'squashfs-root', 'openaster');
        archive = path.join(inspection, 'squashfs-root', 'resources', 'app.asar');
      } else archive = kind === 'macos' ? path.join(path.dirname(executable), '..', 'Resources', 'app.asar') : path.join(path.dirname(executable), 'resources', 'app.asar');
      receipt.installedContent = await step('installed-candidate-content', async () => kind === 'windows'
        ? verifier.verifyWindowsPackage(executable)
        : { asar: await verifier.verifyDesktopArchive(archive), fuses: await verifier.verifyDesktopFuses(runtimeExecutable) });
      const installedIdentity = await step('installed-executable-integrity', () => artifactSnapshot(executable));
      const launch = async (scenario, script, extraArgs, timeoutMs) => {
        receipt.scenarios[scenario] = { status: 'running' }; await save();
        try {
          await step(scenario + '-executable-integrity', () => verifyArtifactFile(executable, installedIdentity));
          if (kind === 'appimage') await verifyBeforeExecution();
          const args = [path.join(source, 'scripts', script), executable, '--software-rendering', ...extraArgs];
          const result = process.platform === 'linux'
            ? await command('installed-' + scenario + '-smoke', 'xvfb-run', ['-a', '--server-args=-screen 0 1280x800x24', process.execPath,
              path.join(source, 'scripts', 'linux-keyring-session.mjs'), scenario, executable], { timeoutMs,
              env: { ...executionEnvironment(process.env), GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
                RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT, GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY, RUNNER_TEMP: process.env.RUNNER_TEMP } })
            : await command('installed-' + scenario + '-smoke', process.execPath, args, { timeoutMs });
          const facts = await step('validate-' + scenario + '-result', async () => validateCandidateScenario(result.outputText, scenario));
          receipt.scenarios[scenario] = { status: 'passed', facts };
          return facts;
        } catch (error) {
          receipt.scenarios[scenario] = { status: 'failed', error: String(error?.message ?? 'Smoke failed').slice(0, 4000) };
          throw error;
        } finally { await save(); }
      };
      receipt.smoke = await launch('basic', 'desktop-smoke.mjs', [], 90000);
      if (receipt.smoke.secretStorage?.available !== true) receipt.environmentLimitations = ['Basic startup refused unavailable OS-protected storage. This does not satisfy backup or encrypted-draft relaunch acceptance.'];
      const failures = [];
      for (const [scenario, script, extraArgs, timeoutMs] of [
        ['backup', 'desktop-smoke.mjs', ['--backup'], 120000],
        ['relaunch', 'desktop-relaunch-smoke.mjs', [], 250000],
      ]) {
        try { await launch(scenario, script, extraArgs, timeoutMs); } catch { failures.push(scenario); }
      }
      if (failures.length) fail('Candidate extended smoke failed: ' + failures.join(', '));
    } else {
      // Never supply --no-sandbox, relax AppArmor/sysctl, or alter Gatekeeper/quarantine.
      const args = [smoke, executable, '--software-rendering'];
      if (kind === 'appimage') await verifyBeforeExecution();
      const smokeResult = process.platform === 'linux'
        ? await command('installed-smoke', 'xvfb-run', ['-a', '--server-args=-screen 0 1280x800x24', process.execPath, ...args], { timeoutMs: 90000 })
        : await command('installed-smoke', process.execPath, args, { timeoutMs: 90000 });
      receipt.smoke = await step('validate-smoke-result', async () => {
        const line = smokeResult.outputText.split(/\r?\n/u).find(value => value.startsWith('{"executable":'));
        const facts = line ? JSON.parse(line) : null;
        if (!facts?.ok || !facts.sandboxed || !facts.connected) fail('Native smoke did not confirm success, renderer sandbox and local service connection');
        return facts;
      });
      }
    receipt.status = 'passed';
  } catch (error) {
    receipt.status = 'failed'; receipt.error = String(error?.message ?? 'Acceptance failed').slice(0, 4000);
    process.exitCode = 1;
  } finally {
    if (mounted) {
      try { await command('dmg-detach-cleanup', '/usr/bin/hdiutil', ['detach', mountpoint], { timeoutMs: 30000 }); }
      catch { receipt.status = 'failed'; receipt.cleanupFailed = true; process.exitCode = 1; }
    }
    if (originalCandidate) {
      try { await step('candidate-original-retained', () => verifyArtifactFile(originalCandidate, artifact)); }
      catch { receipt.status = 'failed'; receipt.originalArtifactChanged = true; process.exitCode = 1; }
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
