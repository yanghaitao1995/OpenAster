// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sharedBuildInfo } from './lib/build-info.mjs';
import { ARTIFACTS, CANDIDATE_ARTIFACTS, CANDIDATE_VERSION, assertCandidatePolicy, assertCandidateCheckout,
  candidateArtifactSnapshot, candidateBuildIdentity, verifyArtifactFile, validateCandidateScenario, verifyMacCandidateSignature } from './verify-release-installers.mjs';

const commit = '1'.repeat(40);
const environment = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'yanghaitao1995/OpenAster',
  RUNNER_TEMP: path.resolve(os.tmpdir()), GITHUB_WORKSPACE: path.resolve(os.tmpdir(), 'candidate-source-fixture'), GITHUB_SHA: commit });
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'openaster-candidate-test-'));
  const identity = await fs.lstat(directory, { bigint: true });
  t.after(async () => {
    const current = await fs.lstat(directory, { bigint: true });
    assert.equal(path.dirname(await fs.realpath(directory)), parent);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
    await fs.rm(directory, { recursive: true });
  });
  const source = path.join(directory, 'source'); await fs.mkdir(source);
  await fs.mkdir(path.join(source, 'release'));
  return { directory, source };
}

test('candidate inputs are four fixed local 0.2.4 filenames; published 0.2.2 pins remain unchanged', () => {
  assert.equal(CANDIDATE_VERSION, '0.2.4');
  assert.deepEqual(Object.keys(CANDIDATE_ARTIFACTS), ['windows', 'macos', 'deb', 'appimage']);
  for (const [kind, artifact] of Object.entries(CANDIDATE_ARTIFACTS)) {
    assert.equal(artifact.file, ARTIFACTS[kind].file.replace('0.2.2', '0.2.4'));
    assert.equal(path.basename(artifact.file), artifact.file);
    assert.ok(Object.isFrozen(artifact));
    assert.match(ARTIFACTS[kind].sha256, /^[a-f0-9]{64}$/u);
    assert.ok(ARTIFACTS[kind].bytes > 100000000);
  }
});

test('candidate policy refuses paths, URLs, unbound commits and non-hosted environments', () => {
  const env = environment();
  assert.equal(assertCandidatePolicy(env, 'win32', 'x64', 'windows'), CANDIDATE_ARTIFACTS.windows);
  for (const kind of ['../windows', 'https://example.invalid/installer', 'constructor', 'toString', '']) assert.throws(() => assertCandidatePolicy(env, 'win32', 'x64', kind));
  for (const patch of [{ GITHUB_SHA: '' }, { GITHUB_SHA: '../main' }, { GITHUB_SHA: commit + '\n' }, { GITHUB_WORKSPACE: 'relative' }, { OPENASTER_ACCEPTANCE_SOURCE: '/other' },
    { OPENASTER_ACCEPTANCE_OUTPUT: '/other' }, { GITHUB_REPOSITORY: 'other/repo' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_ACTIONS: 'false' }]) {
    assert.throws(() => assertCandidatePolicy({ ...env, ...patch }, 'win32', 'x64', 'windows'));
  }
  assert.throws(() => assertCandidatePolicy(env, 'darwin', 'x64', 'macos'));
});

test('candidate identity binds verifier, build, git HEAD and version to one checkout', () => {
  const env = environment(), source = env.GITHUB_WORKSPACE;
  assert.doesNotThrow(() => assertCandidateCheckout(env, source, source, commit, '0.2.4'));
  for (const [actualSource, tools, head, version] of [[source, source, '2'.repeat(40), '0.2.4'], [source, source, commit, '0.2.2'],
    [path.join(source, 'child'), source, commit, '0.2.4'], [source, path.join(source, 'child'), commit, '0.2.4']]) {
    assert.throws(() => assertCandidateCheckout(env, actualSource, tools, head, version));
  }
});

test('candidate measures fixed original bytes and rejects substitution before execution', async t => {
  const f = await fixture(t), file = path.join(f.source, 'release', CANDIDATE_ARTIFACTS.windows.file);
  const bytes = Buffer.from('fixture content only; this is never executed');
  await fs.writeFile(file, bytes);
  const snapshot = await candidateArtifactSnapshot(f.source, 'windows');
  assert.equal(snapshot.bytes, bytes.length);
  assert.deepEqual(await verifyArtifactFile(file, snapshot), { bytes: snapshot.bytes, sha256: snapshot.sha256 });
  await fs.writeFile(file, Buffer.alloc(bytes.length, 1));
  await assert.rejects(verifyArtifactFile(file, snapshot), /SHA-256/u);
  await fs.writeFile(file, bytes.subarray(1));
  await assert.rejects(verifyArtifactFile(file, snapshot), /size/u);
  await assert.rejects(candidateArtifactSnapshot(f.source, '../windows'), /Unknown fixed/u);
});

test('candidate does not accept hardlinks or redirected release directories', async t => {
  const f = await fixture(t), file = path.join(f.source, 'release', CANDIDATE_ARTIFACTS.windows.file);
  await fs.writeFile(file, 'fixture bytes, never executed');
  await fs.link(file, path.join(f.directory, 'hardlink'));
  await assert.rejects(candidateArtifactSnapshot(f.source, 'windows'), /single-link/u);
  const actual = path.join(f.source, 'original-release');
  await fs.rename(path.join(f.source, 'release'), actual);
  try { await fs.symlink(actual, path.join(f.source, 'release'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('Directory link creation unavailable; hardlink refusal was verified'); return; } throw error; }
  await assert.rejects(candidateArtifactSnapshot(f.source, 'windows'), /ordinary checkout directory/u);
});

test('candidate generated UI identity must match the current source and package version', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'package.json'), JSON.stringify({ version: '0.2.4' }));
  await fs.mkdir(path.join(f.source, 'public')); await fs.writeFile(path.join(f.source, 'public/index.html'), '<p>fixture</p>');
  await fs.mkdir(path.join(f.source, 'dist/public'), { recursive: true });
  const expected = { ...await sharedBuildInfo(f.source), mode: 'desktop-web' }, file = path.join(f.source, 'dist/public/build-info.json');
  await fs.writeFile(file, JSON.stringify(expected));
  assert.deepEqual(await candidateBuildIdentity(f.source), expected);
  await fs.writeFile(file, JSON.stringify({ ...expected, sharedAssetsSha256: '0'.repeat(64) }));
  await assert.rejects(candidateBuildIdentity(f.source), /differs/u);
  await fs.writeFile(file, JSON.stringify(expected)); await fs.writeFile(path.join(f.source, 'public/index.html'), '<p>changed</p>');
  await assert.rejects(candidateBuildIdentity(f.source), /differs/u);
});

test('candidate entry rejects URL or file arguments without running acceptance', () => {
  const entry = fileURLToPath(new URL('./verify-candidate-installers.mjs', import.meta.url));
  for (const arg of ['https://example.invalid/file', '/tmp/installer']) {
    const result = spawnSync(process.execPath, [entry, arg], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /takes no command-line arguments/u);
  }
});

test('candidate extended scenarios reject basic-only and unavailable keyring success', () => {
  const basic = { executable: '/fixture', ok: true, connected: true, sandboxed: true, secretStorage: { available: false } };
  const result = value => JSON.stringify(value);
  assert.deepEqual(validateCandidateScenario(result(basic), 'basic'), basic);
  assert.throws(() => validateCandidateScenario(result(basic), 'backup'), /keyring/u);
  assert.throws(() => validateCandidateScenario(result(basic), 'relaunch'), /five-process/u);
  const backup = { ...basic, secretStorage: { available: true }, deviceDraftStorage: { available: true }, backupLifecycle: { tasks: 2, toolArtifacts: 2,
    realMenuCallbacks: true, workerBackup: true, workerRestore: true, restoredProfileReopened: true, artifactBytesPreserved: true,
    originalWorkspacePreserved: true, handoffSnapshotRestored: true, handoffHistoryNotReplayed: true, summaryDraftRestored: true,
    rendererReadiness: { version: 1, policy: 'pause-new-background-requests-before-transition', admittedRequests: 2, completedRequests: 1, eventStreamsReady: 1,
      pausedRequests: 1, handlersStarted: 8, handlersSettled: 8, allAdmittedRequestsSettled: true, allStartedHandlersSettled: true },
    transitionReadiness: 'fixture paused new renderer and service worker requests before backup; not naturally idle startup' } };
  assert.deepEqual(validateCandidateScenario(result(backup), 'backup'), backup);
  assert.throws(() => validateCandidateScenario(result({ ...backup, backupLifecycle: { ...backup.backupLifecycle, workerRestore: false } }), 'backup'), /preserved mock task/u);
  for (const patch of [{ rendererReadiness: undefined }, { transitionReadiness: 'naturally idle' },
    ...[{ handlersSettled: 7 }, { handlersStarted: 0, handlersSettled: 0 }, { allStartedHandlersSettled: false }, { allAdmittedRequestsSettled: false },
      { completedRequests: 3 }, { admittedRequests: -1 }, { policy: 'force-close' }].map(patch => ({ rendererReadiness: { ...backup.backupLifecycle.rendererReadiness, ...patch } }))]) {
    assert.throws(() => validateCandidateScenario(result({ ...backup, backupLifecycle: { ...backup.backupLifecycle, ...patch } }), 'backup'), /controlled-idle/u);
  }
  const relaunch = { executable: '/fixture', ok: true, actualProcessRelaunches: 4, processCount: 5, allRecordedProcessesExited: true,
    temporaryResourcesCleaned: true, draftRecovery: { profiles: 2, draftsPerProfile: 2 }, phaseProofs: Array(5).fill({}) };
  assert.deepEqual(validateCandidateScenario(result(relaunch), 'relaunch'), relaunch);
  for (const patch of [{ processCount: 4 }, { allRecordedProcessesExited: false }, { temporaryResourcesCleaned: false }, { draftRecovery: { profiles: 1 } }]) {
    assert.throws(() => validateCandidateScenario(result({ ...relaunch, ...patch }), 'relaunch'));
  }
  assert.throws(() => validateCandidateScenario(result(basic) + '\n' + result(basic), 'basic'), /exactly one/u);
  assert.throws(() => validateCandidateScenario(result({ ...basic, sandboxed: false }), 'basic'), /sandbox/u);
});

const macBundle = location => path.resolve(os.tmpdir(), 'openaster-mac-signature-fixture', location, 'OpenAster.app');
const macSignatureOutput = bundle => [
  `Executable=${path.join(bundle, 'Contents', 'MacOS', 'OpenAster')}`,
  'Identifier=org.openaster.preview',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=500 flags=0x10002(adhoc,runtime) hashes=12+7 location=embedded',
  'Signature=adhoc', 'TeamIdentifier=not set', `CDHash=${'a'.repeat(40)}`,
  'designated => identifier "org.openaster.preview"', '',
].join('\n');

test('macOS candidate verifies entire DMG and copied bundle and binds their ad hoc identities', async () => {
  const calls = [], command = async (name, executable, args) => {
    calls.push({ name, executable, args });
    return { outputText: args[0] === '--display' ? macSignatureOutput(args.at(-1)) : '' };
  };
  const mounted = macBundle('mounted'), installed = macBundle('installed');
  const identity = await verifyMacCandidateSignature(mounted, 'dmg', command);
  assert.deepEqual(await verifyMacCandidateSignature(installed, 'installed', command, identity), identity);
  assert.equal(identity.hardenedRuntime, true);
  assert.equal(identity.developerId, false);
  assert.equal(identity.notarizationVerified, false);
  assert.deepEqual(calls, [
    { name: 'dmg-code-signature-verify', executable: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', mounted] },
    { name: 'dmg-code-signature-identity', executable: '/usr/bin/codesign', args: ['--display', '--verbose=4', '--requirements=-', mounted] },
    { name: 'installed-code-signature-verify', executable: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', installed] },
    { name: 'installed-code-signature-identity', executable: '/usr/bin/codesign', args: ['--display', '--verbose=4', '--requirements=-', installed] },
  ]);
});

test('macOS candidate never reads identity after failed complete-code verification', async () => {
  const calls = [], command = async (...args) => { calls.push(args); throw new Error('codesign reported an invalid nested signature'); };
  await assert.rejects(verifyMacCandidateSignature(macBundle('mounted'), 'dmg', command), /invalid nested signature/u);
  assert.equal(calls.length, 1);
  for (const [bundle, stage] of [['relative/OpenAster.app', 'dmg'], [macBundle('mounted'), 'unknown'], [macBundle('mounted') + '\n', 'dmg']]) {
    await assert.rejects(verifyMacCandidateSignature(bundle, stage, command), /Invalid fixed/u);
  }
  assert.equal(calls.length, 1);
});

test('macOS candidate refuses incomplete, ambiguous or inappropriate signature identities', async () => {
  const bundle = macBundle('mounted'), valid = macSignatureOutput(bundle);
  const invalid = [
    valid.replace('Identifier=org.openaster.preview', 'Identifier=other.app'),
    valid.replace('Identifier=org.openaster.preview\n', ''),
    valid + 'Identifier=org.openaster.preview\n',
    valid.replace(`Executable=${path.join(bundle, 'Contents', 'MacOS', 'OpenAster')}`, 'Executable=/other/app'),
    valid.replace('Signature=adhoc', 'Signature=Developer ID'),
    valid.replace('TeamIdentifier=not set', 'TeamIdentifier=EXAMPLETEAM'),
    valid.replace('flags=0x10002(adhoc,runtime)', 'flags=0x2(adhoc)'),
    valid.replace('flags=0x10002(adhoc,runtime)', 'flags=0x10000(runtime)'),
    valid.replace(`CDHash=${'a'.repeat(40)}`, 'CDHash=invalid'),
    valid.replace('designated => identifier "org.openaster.preview"\n', ''),
    valid + 'designated => another requirement\n',
    valid.replace('designated => identifier "org.openaster.preview"', 'designated => ' + 'x'.repeat(8193)),
    valid + '\0', valid + 'x'.repeat(65536), undefined,
  ];
  for (const output of invalid) {
    const command = async (_name, _executable, args) => ({ outputText: args[0] === '--display' ? output : '' });
    await assert.rejects(verifyMacCandidateSignature(bundle, 'dmg', command), /macOS/u);
  }
});

test('macOS candidate rejects changed code or designated requirement after metadata-preserving copy', async () => {
  const mounted = macBundle('mounted'), installed = macBundle('installed');
  const identity = await verifyMacCandidateSignature(mounted, 'dmg', async () => ({ outputText: macSignatureOutput(mounted) }));
  for (const output of [macSignatureOutput(installed).replace('a'.repeat(40), 'b'.repeat(40)),
    macSignatureOutput(installed).replace('designated => identifier "org.openaster.preview"', 'designated => cdhash H"' + 'a'.repeat(40) + '"')]) {
    await assert.rejects(verifyMacCandidateSignature(installed, 'installed', async () => ({ outputText: output }), identity), /differs from the read-only DMG/u);
  }
});
