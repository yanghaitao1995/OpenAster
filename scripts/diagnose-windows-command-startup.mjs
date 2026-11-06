// SPDX-License-Identifier: Apache-2.0
// Isolated timing evidence only. This does not change production command deadlines.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE_COMMIT = '3a4ee6915312dcafd9e56ea5c40440c9b39c5985';
export const HOST_HASH = 'e54cbbb7a8783d55990750408566110bc9ba7d94d1c8fc696faf84a9577e5b71';
const MAX_MS = 120000;
const outerNames = ['BOOTSTRAP_ENTER', 'SOURCE_READ', 'ADD_TYPE_BEGIN', 'ADD_TYPE_END', 'RUN_ENTER', 'READY'];
const innerNames = ['INNER_ENTER', 'MANAGEMENT_IMPORT_BEGIN', 'MANAGEMENT_IMPORTED', 'GET_LOCATION_DONE', 'INNER_DONE'];
const encode = value => Buffer.from(value, 'utf8').toString('base64');
const encodedCommand = value => Buffer.from(value, 'utf16le').toString('base64');
const invalid = () => new Error('DIAGNOSTIC_PROTOCOL_INVALID');

// Only fixed stage labels and bounded numeric timings may reach the evidence file.
export function parseInnerTimings(stdout, startedAtMs) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 2048 || !Number.isSafeInteger(startedAtMs)) throw invalid();
  const lines = stdout.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > innerNames.length) throw invalid();
  const stages = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^INNER\t([A-Z_]+)\t(\d{1,6})\t(\d{13})$/u.exec(lines[i]);
    if (!match || match[1] !== innerNames[i]) throw invalid();
    const elapsedMs = Number(match[2]), unixMs = Number(match[3]);
    if (elapsedMs > MAX_MS + 5000 || unixMs < startedAtMs - 5000 || unixMs > startedAtMs + MAX_MS + 5000 || elapsedMs < (stages.at(-1)?.elapsedMs ?? 0)) throw invalid();
    stages.push({ stage: match[1], elapsedMs, unixMs });
  }
  return stages;
}

export function parseOuterLine(line, expectedStage) {
  if (typeof line !== 'string' || line.length > 6000) throw invalid();
  if (line === 'HOST_ERROR') return { type: 'host-error' };
  if (expectedStage < outerNames.length) {
    const expected = outerNames[expectedStage];
    if (line !== (expected === 'READY' ? 'READY' : `DIAG\t${expected}`)) throw invalid();
    return { type: 'stage', stage: expected };
  }
  const parts = line.split('\t');
  if (parts.length !== 5 || parts[0] !== 'RESULT' || !/^-?\d{1,11}$/u.test(parts[1]) || !/^[01]$/u.test(parts[2]) || parts.slice(3).some(part => !/^[A-Za-z0-9+/]*={0,2}$/u.test(part))) throw invalid();
  const stdout = Buffer.from(parts[3], 'base64'), stderr = Buffer.from(parts[4], 'base64');
  if (stdout.length > 2048 || stderr.length > 2048 || parts[2] !== '0') throw invalid();
  return { type: 'result', exitCode: Number(parts[1]), stdout: stdout.toString('utf8'), stdoutBytes: stdout.length, stderrBytes: stderr.length };
}

const bootstrap = `$ErrorActionPreference='Stop'; function Mark([string]$stage) { [Console]::Out.WriteLine('DIAG'+[char]9+$stage); [Console]::Out.Flush() }; try { Mark 'BOOTSTRAP_ENTER'; $s=[Console]::ReadLine(); Mark 'SOURCE_READ'; Mark 'ADD_TYPE_BEGIN'; Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))) -ErrorAction Stop; Mark 'ADD_TYPE_END'; Mark 'RUN_ENTER'; exit [OpenAster.CommandHost]::Run() } catch { [Console]::Out.WriteLine('HOST_ERROR'); [Console]::Out.Flush(); exit 1 }`;
const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding;
$clock=[Diagnostics.Stopwatch]::StartNew();
function MarkInner([string]$stage) { [Console]::Out.WriteLine('INNER'+[char]9+$stage+[char]9+$clock.ElapsedMilliseconds+[char]9+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); [Console]::Out.Flush() };
MarkInner 'INNER_ENTER'; MarkInner 'MANAGEMENT_IMPORT_BEGIN';
Import-Module Microsoft.PowerShell.Management -ErrorAction Stop;
MarkInner 'MANAGEMENT_IMPORTED'; $null=(Get-Location).Path; MarkInner 'GET_LOCATION_DONE'; MarkInner 'INNER_DONE'; exit 0`;

export async function measureStartup({ source, shell, cwd, env }) {
  const startedAtMs = Date.now(), started = performance.now();
  const receipt = { purpose: 'startup-phase-measurement-only', acceptance: false, measurementLimitMs: MAX_MS, startedAtMs, outerStages: [], innerStages: [], timedOut: false, cleanup: 'pending', hostStderrBytes: 0 };
  return await new Promise(resolve => {
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(bootstrap)], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', result, stopping = false, closed = false, killTimer;
    const stamp = stage => ({ stage, elapsedMs: Math.round(performance.now() - started), unixMs: Date.now() });
    function stop() {
      if (stopping || closed) return; stopping = true;
      child.stdin.end(); // Preserve the existing EOF lifeline and owned Job Object cleanup.
      killTimer = setTimeout(() => child.kill(), 2000);
    }
    function fail(code) { receipt.errorCode ??= code; stop(); }
    const timer = setTimeout(() => { receipt.timedOut = true; stop(); }, MAX_MS);
    child.stdin.on('error', () => { if (!stopping) fail('HOST_STDIN_ERROR'); });
    child.stderr.on('data', chunk => { receipt.hostStderrBytes += chunk.length; });
    child.on('error', () => fail('HOST_PROCESS_ERROR'));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 12000) return fail('DIAGNOSTIC_PROTOCOL_INVALID');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/u, ''); buffer = buffer.slice(index + 1);
        try {
          if (result) throw invalid();
          const entry = parseOuterLine(line, receipt.outerStages.length);
          if (entry.type === 'host-error') { fail('HOST_ERROR'); continue; }
          if (entry.type === 'stage') {
            receipt.outerStages.push(stamp(entry.stage));
            if (entry.stage === 'READY' && !stopping) { receipt.goSent = stamp('GO_SENT'); child.stdin.write('GO\n'); }
          } else {
            result = entry;
            receipt.innerStages = parseInnerTimings(result.stdout, startedAtMs);
            receipt.resultObserved = stamp('RESULT_OBSERVED');
            receipt.commandExitCode = result.exitCode;
            receipt.stdoutBytes = result.stdoutBytes; receipt.stderrBytes = result.stderrBytes;
          }
        } catch { fail('DIAGNOSTIC_PROTOCOL_INVALID'); }
      }
    });
    child.on('close', (code, signal) => {
      closed = true; clearTimeout(timer); clearTimeout(killTimer);
      receipt.hostExitCode = code; receipt.hostSignal = signal === 'SIGTERM' ? 'SIGTERM' : signal ? 'OTHER' : null;
      receipt.durationMs = Math.round(performance.now() - started);
      receipt.cleanup = 'host-closed-original-job-lifetime-retained';
      if (buffer.trim() || (!receipt.timedOut && (code !== 0 || !result))) receipt.errorCode ??= 'HOST_INCOMPLETE';
      receipt.measurementComplete = !receipt.timedOut && !receipt.errorCode && result?.exitCode === 0 && result.stderrBytes === 0 && receipt.innerStages.length === innerNames.length;
      // Outer deltas use a monotonic parent clock. Inner shell entry uses the same host's wall clock.
      const stage = name => receipt.outerStages.find(item => item.stage === name)?.elapsedMs;
      receipt.durations = {
        outerShellStartupMs: stage('BOOTSTRAP_ENTER') ?? null,
        addTypeMs: stage('ADD_TYPE_END') === undefined ? null : stage('ADD_TYPE_END') - stage('ADD_TYPE_BEGIN'),
        hostSetupMs: stage('READY') === undefined ? null : stage('READY') - stage('RUN_ENTER'),
        innerShellEntryWallClockMs: receipt.goSent && receipt.innerStages[0] ? receipt.innerStages[0].unixMs - receipt.goSent.unixMs : null,
        managementImportMs: receipt.innerStages.length >= 3 ? receipt.innerStages[2].elapsedMs - receipt.innerStages[1].elapsedMs : null,
      };
      resolve(receipt);
    });
    if (!stopping) child.stdin.write([encode(source), encode(shell), encode(cwd), encode(encodedCommand(command))].join('\n') + '\n');
  });
}

async function main() {
  const evidence = path.resolve('../command-evidence/startup-phases.json');
  let fixture, fixtureRoot;
  let receipt = { purpose: 'startup-phase-measurement-only', acceptance: false, realModelCalls: 0, measurementComplete: false };
  try {
    if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('HOSTED_WINDOWS_REQUIRED');
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    if (revision.status !== 0 || revision.stdout.trim() !== SOURCE_COMMIT) throw new Error('FIXED_SOURCE_REQUIRED');
    const source = await readFile('core/windows-command-host.cs', 'utf8');
    const hostHash = createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex');
    if (hostHash !== HOST_HASH) throw new Error('FIXED_HOST_HASH_REQUIRED');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot', 'windir', 'path', 'temp', 'tmp', 'pathext'].includes(key.toLowerCase())));
    const systemRoot = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('SYSTEM_SHELL_UNAVAILABLE');
    fixtureRoot = await realpath(os.tmpdir());
    fixture = await mkdtemp(path.join(fixtureRoot, 'openaster-command-diagnosis-'));
    const measured = await measureStartup({ source, shell: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), cwd: fixture, env });
    receipt = { ...receipt, sourceCommit: SOURCE_COMMIT, hostSha256Lf: hostHash, ...measured };
  } catch (error) {
    const allowed = new Set(['HOSTED_WINDOWS_REQUIRED', 'FIXED_SOURCE_REQUIRED', 'FIXED_HOST_HASH_REQUIRED', 'SYSTEM_SHELL_UNAVAILABLE']);
    receipt.errorCode = allowed.has(error.message) ? error.message : 'DIAGNOSTIC_SETUP_FAILED';
  } finally {
    if (fixture) {
      try {
        if (!path.isAbsolute(fixture) || path.dirname(fixture) !== fixtureRoot || !path.basename(fixture).startsWith('openaster-command-diagnosis-')) throw invalid();
        await rm(fixture, { recursive: true, force: true }); receipt.fixtureRemoved = true;
      }
      catch { receipt.fixtureRemoved = false; receipt.errorCode ??= 'FIXTURE_CLEANUP_FAILED'; }
    }
  }
  await writeFile(evidence, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ purpose: receipt.purpose, acceptance: false, measurementComplete: receipt.measurementComplete, errorCode: receipt.errorCode ?? null, durations: receipt.durations ?? null, realModelCalls: 0 }));
  if (!receipt.measurementComplete || receipt.errorCode) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); }
  catch { console.error('DIAGNOSTIC_EVIDENCE_WRITE_FAILED'); process.exitCode = 1; }
}
