// SPDX-License-Identifier: Apache-2.0
// Exercises app.relaunch with owned test data. Never installs the application.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSmokeRecord, isSmokeProcessAlive } from '../desktop/relaunch-smoke-state.mjs';
import { stageDesktopExecutable } from './desktop-smoke-staging.mjs';
import { validateSmokeFailure, parseSmokeStageDiagnostic } from '../desktop/smoke-diagnostics.mjs';
import { validateDraftRelaunchProofs, parseDraftUiDiagnostic } from '../desktop/draft-relaunch-proof.mjs';
import { readAppImageFile, sameAppImageFile, sameAppImageProgram } from '../desktop/appimage-relaunch.mjs';

const root = path.resolve(import.meta.dirname, '..'), args = process.argv.slice(2);
const defaults = { win32: 'release/win-unpacked/OpenAster.exe', darwin: 'release/mac/OpenAster.app/Contents/MacOS/OpenAster', linux: 'release/linux-unpacked/openaster' };
assert.ok(defaults[process.platform], 'Unsupported desktop platform');
assert.ok(args.filter(value => !value.startsWith('--')).length <= 1);
assert.ok(args.filter(value => value.startsWith('--')).every(value => ['--source', '--stage', '--software-rendering'].includes(value)));
const originalExecutable = path.resolve(args.find(value => !value.startsWith('--')) || path.join(root, defaults[process.platform]));
const temporaryRoot = await realpath(tmpdir()), directory = await mkdtemp(path.join(temporaryRoot, 'openaster-smoke-'));
const identity = await lstat(directory, { bigint: true }), owner = randomBytes(32).toString('hex');
await writeFile(path.join(directory, '.smoke-owner'), owner, { flag: 'wx', mode: 0o600 });
let executable = originalExecutable, binaryDirectory, binaryIdentity, first, firstExit, firstClosed = false, output = '', completed = false, result, finalReport;
let expectedAppImage = null;
const entries = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => readSmokeRecord({ directory, owner, name });
async function observe() {
  for (let phase = 0; phase <= 4; phase++) {
    if (entries.has(phase)) continue;
    try {
      const value = record('.relaunch-entry-' + phase + '.json');
      if (expectedAppImage !== null) {
        assert.equal(value.version, 2); assert.equal(value.executable, expectedAppImage.canonical);
        assert.equal(sameAppImageFile(value.appImage.image, expectedAppImage), true);
        if (phase > 0) assert.equal(sameAppImageProgram(entries.get(0).appImage, value.appImage), true);
      } else assert.equal(value.version, 1);
      entries.set(phase, value);
    }
    catch (error) { if (!['ENOENT', 'RELAUNCH_SMOKE_INCOMPLETE'].includes(error.code)) throw error; }
  }
}
async function stopped() {
  if (firstExit === undefined || !firstClosed) return false;
  for (const entry of entries.values()) if (isSmokeProcessAlive(entry.pid)) return false;
  return true;
}
try {
  if (args.includes('--stage')) {
    binaryDirectory = await mkdtemp(path.join(temporaryRoot, 'openaster-binary-')); binaryIdentity = await lstat(binaryDirectory, { bigint: true });
    await writeFile(path.join(binaryDirectory, '.smoke-owner'), owner, { flag: 'wx', mode: 0o600 });
    ({ executable } = await stageDesktopExecutable({ executable: originalExecutable, directory: binaryDirectory, owner }));
  }
  const env = { ...process.env, OPENASTER_SMOKE_DATA_DIR: directory, OPENASTER_SMOKE_OWNER: owner };
  if (process.platform === 'linux' && /\.appimage$/iu.test(executable)) {
    assert.equal(args.includes('--source') || args.includes('--stage'), false);
    expectedAppImage = readAppImageFile(executable);
  }
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const launch = [...(args.includes('--source') ? [path.join(root, 'desktop/main.mjs')] : []), '--smoke-test', '--relaunch-smoke-test', '--smoke-phase=0', ...(args.includes('--software-rendering') ? ['--disable-gpu'] : [])];
  first = spawn(executable, launch, { cwd: path.dirname(executable), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const receive = chunk => { output = (output + chunk).slice(-65536); };
  first.stdout.on('data', receive); first.stderr.on('data', receive);
  first.once('exit', code => { firstExit = code; });
  first.once('close', () => { firstClosed = true; });
  let spawnError; first.once('error', error => { spawnError = error; firstExit = -1; });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    await observe();
    try { result = record('.relaunch-result.json'); break; } catch (error) { if (!['ENOENT', 'RELAUNCH_SMOKE_INCOMPLETE'].includes(error.code)) throw error; }
    if (firstExit !== undefined && firstExit !== 0) throw new Error(expectedAppImage === null
      ? 'Initial Electron process failed: ' + firstExit + '\n' + output.slice(-3000) : 'Initial AppImage process failed');
    await pause(100);
  }
  if (!result && expectedAppImage !== null) {
    console.error('OPENASTER_APPIMAGE_RELAUNCH_DIAGNOSTIC ' + JSON.stringify({ version: 1, code: 'APPIMAGE_RELAUNCH_RESULT_TIMEOUT',
      observedPhases: [...entries.keys()], initialExitObserved: firstExit !== undefined, initialExitSucceeded: firstExit === 0, initialPipesClosed: firstClosed }));
    for (const line of output.split(/\r?\n/u)) {
      const stage = parseSmokeStageDiagnostic(line);
      if (stage) console.error('OPENASTER_SMOKE_STAGE_DIAGNOSTIC ' + JSON.stringify(stage));
    }
  }
  assert.ok(result, 'Relaunch smoke timed out; owned directories are retained until termination is confirmed');
  if (!result.result.ok) {
    // Report the already validated, fixed-field failure before waiting for exit.
    // A written record alone is never permission to clean up running processes.
    const failure = validateSmokeFailure(result.result, { phase: result.phase });
    console.error('OPENASTER_RELAUNCH_FAILURE ' + JSON.stringify(failure));
  }
  await observe();
  const exitDeadline = Date.now() + 20000;
  while (!await stopped() && Date.now() < exitDeadline) await pause(100);
  assert.equal(await stopped(), true, 'A recorded test process is still alive; retaining test files');
  // Read the bounded projection only after the initial child's pipes close.
  // The protocol result can become visible before its final stderr is drained.
  if (!result.result.ok) {
    // Child output is untrusted and may contain raw errors; forward only the
    // bounded draft-stage projection accepted by the strict parser.
    for (const line of output.split(/\r?\n/u)) {
      const diagnostic = parseDraftUiDiagnostic(line);
      if (diagnostic) console.error('OPENASTER_DRAFT_UI_DIAGNOSTIC ' + JSON.stringify(diagnostic));
      const stage = parseSmokeStageDiagnostic(line);
      if (stage) console.error('OPENASTER_SMOKE_STAGE_DIAGNOSTIC ' + JSON.stringify(stage));
    }
  }
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  assert.equal(firstExit, 0); assert.equal(entries.size, 5);
  if (expectedAppImage !== null) {
    assert.equal(result.version, 2); assert.equal(sameAppImageProgram(entries.get(0).appImage, result.appImage), true);
    assert.equal(sameAppImageFile(readAppImageFile(executable), expectedAppImage), true);
  }
  const pids = [...entries.values()].map(entry => entry.pid);
  assert.equal(new Set(pids).size, 5); assert.equal(pids[0], first.pid); assert.deepEqual(result.pids, pids);
  const scenario = result.result.processRelaunch;
  assert.equal(scenario.realProcessRelaunches, 4); assert.equal(scenario.backupVersion, 9);
  assert.equal(scenario.sessions, 2); assert.equal(scenario.runHistories, 3);
  assert.ok(Array.isArray(scenario.demoReadPaths) && scenario.demoReadPaths.includes('relaunch-note.txt') && scenario.demoReadPaths.length <= 3);
  assert.equal(new Set(scenario.demoReadPaths).size, scenario.demoReadPaths.length);
  assert.equal(scenario.toolArtifacts, 1 + scenario.demoReadPaths.length);
  assert.deepEqual(result.proofs.map(entry => entry.proof.toolArtifacts), Array(5).fill(scenario.toolArtifacts));
  assert.notEqual(scenario.sourceSessionId, scenario.branchSessionId); assert.equal(scenario.branchCreatedViaApi, true);
  assert.equal(result.proofs.length, 5);
  for (const key of ['sourceAndBranchPreserved', 'branchMetadataPreserved', 'historicalAttachmentPreserved', 'executionNotReplayed']) {
    assert.equal(scenario[key], true);
    assert.ok(result.proofs.every(entry => entry.proof[key] === true), 'Missing per-process proof: ' + key);
  }
  assert.ok(result.proofs.every(entry => entry.proof.taskVisible && entry.proof.branchTaskVisible && entry.proof.sandboxed));
  for (const entry of result.proofs.slice(0, 4)) {
    const readiness = entry.proof.rendererReadiness;
    assert.equal(readiness?.version, 1); assert.equal(readiness.policy, 'pause-new-background-requests-before-transition');
    assert.equal(readiness.allAdmittedRequestsSettled, true); assert.equal(readiness.allStartedHandlersSettled, true);
    assert.equal(readiness.handlersStarted, readiness.handlersSettled);
  }
  assert.equal(result.proofs[4].proof.rendererReadiness, undefined);
  assert.equal(result.proofs[0].proof.newBranchIdentifiers, true);
  assert.deepEqual(result.proofs.map(entry => entry.proof.workspaceId), ['default', 'default', scenario.restoredProfileId, 'default', scenario.restoredProfileId]);
  const draftRecovery = validateDraftRelaunchProofs(result.proofs, scenario);
  completed = true;
  finalReport = { executable, ok: true, actualProcessRelaunches: 4, processCount: 5, processIds: pids, firstExitCode: firstExit,
    ...(expectedAppImage === null ? {} : { appImage: { originalEntryVerified: true, imageSha256: expectedAppImage.sha256,
      sameImageAndPayloadAcrossFiveProcesses: true, launcherPidIsFirstProcess: pids[0] === first.pid } }),
    allRecordedProcessesExited: true, draftRecovery, phaseProofs: result.proofs, result: result.result };
} finally {
  // A pending OS relaunch can start after an earlier PID exits. Clean only after
  // a final protocol result and all recorded processes are confirmed stopped.
  if (completed) {
    const canonical = await realpath(directory), current = await lstat(directory, { bigint: true });
    assert.equal(path.dirname(canonical), temporaryRoot); assert.match(path.basename(canonical), /^openaster-smoke-[a-zA-Z0-9]+$/);
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(await readFile(path.join(canonical, '.smoke-owner'), 'utf8'), owner);
    await rm(canonical, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
    if (binaryDirectory) {
      const canonicalBinary = await realpath(binaryDirectory), currentBinary = await lstat(binaryDirectory, { bigint: true });
      assert.equal(path.dirname(canonicalBinary), temporaryRoot); assert.match(path.basename(canonicalBinary), /^openaster-binary-[a-zA-Z0-9]+$/);
      assert.equal(currentBinary.dev, binaryIdentity.dev); assert.equal(currentBinary.ino, binaryIdentity.ino); assert.ok(!currentBinary.isSymbolicLink());
      assert.equal(await readFile(path.join(canonicalBinary, '.smoke-owner'), 'utf8'), owner);
      await rm(canonicalBinary, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
    }
  } else console.error('Smoke data retained for inspection: ' + directory + (binaryDirectory ? '; binary copy: ' + binaryDirectory : ''));
}
console.log(JSON.stringify({ ...finalReport, temporaryResourcesCleaned: true }));

