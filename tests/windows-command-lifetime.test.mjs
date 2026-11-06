// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runWindowsCommand } from '../core/windows-command.mjs';
import { WINDOWS_HOST_PREPARATION_MS, WINDOWS_HOST_CLEANUP_MS } from '../core/windows-command-budget.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot','windir','path','temp','tmp','pathext'].includes(key.toLowerCase())));
const systemRoot = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
const shell = systemRoot ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
const quoted = value => "'" + value.replaceAll("'", "''") + "'";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const HELPER_BUILD_MS=45000, MARKER_MS=15000, OBSERVER_EXIT_MS=35000;
// Account separately for fixed helper compilation, host preparation, marker /
// observer setup and the unchanged real process-exit observation bound.
const options = { skip: process.platform !== 'win32', timeout: 2*WINDOWS_HOST_PREPARATION_MS+HELPER_BUILD_MS+2*MARKER_MS+OBSERVER_EXIT_MS+2*WINDOWS_HOST_CLEANUP_MS+5000 };
const diagnosticCodes = new Set(['COMMAND_HOST_FAILED', 'ABORTED', 'ENOENT', 'EACCES', 'EPERM', 'EPIPE']);
const diagnosticCode = error => diagnosticCodes.has(error?.code) ? error.code : 'OTHER';
const outcomeFacts = result => ({ exitCode: result.exitCode, signal: result.signal === 'SIGTERM' ? 'SIGTERM' : null,
  timedOut: result.timedOut, cancelled: result.cancelled, durationMs: result.durationMs,
  stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), truncated: result.truncated });

function launch(executable, args, cwd) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError, outcome;
  const startedAt = performance.now(), facts = { state: 'pending' };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { spawnError = error.message; facts.errorCode = diagnosticCode(error); });
  const done = new Promise(resolve => child.once('close', (code, signal) => {
    Object.assign(facts, { state: 'closed', exitCode: code, signal: ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(signal) ? signal : null });
    outcome = { code, signal, stdout, stderr, spawnError }; resolve(outcome);
  }));
  return { child, done, outcome: () => outcome, output: () => stdout, facts: () => ({ ...facts, elapsedMs: Math.round(performance.now() - startedAt),
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), commandReadyCount: stdout.split(/\r?\n/u).filter(line => line === 'COMMAND_READY').length }) };
}
async function waitUntil(predicate, label, milliseconds = 15000) {
  const deadline = performance.now() + milliseconds;
  do { if (await predicate()) return; await delay(50); } while (performance.now() < deadline);
  throw new Error(label);
}
async function markerReady(file) {
  try { const data = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(data) && data.length === 3; }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
}
// Query only this fixture shell's own process handle. WMI access can be denied
// independently of the command runner; no machine-wide process enumeration is
// needed to discover its direct supervisor. Layout follows Microsoft's
// NtQueryInformationProcess / PROCESS_BASIC_INFORMATION documentation:
// https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntqueryinformationprocess
const parentProbeSource = `using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class OpenAsterFixtureParent {
  [StructLayout(LayoutKind.Sequential)] struct BasicInformation {
    public int ExitStatus;
    public IntPtr PebBaseAddress;
    public UIntPtr AffinityMask;
    public int BasePriority;
    public UIntPtr UniqueProcessId, InheritedFromUniqueProcessId;
  }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int informationClass, out BasicInformation information, int size, out int returned);
  public static int OwnParentId() {
    using (var self = Process.GetCurrentProcess()) {
      BasicInformation information; int returned, size = Marshal.SizeOf(typeof(BasicInformation));
      if (NtQueryInformationProcess(self.Handle, 0, out information, size, out returned) != 0 || returned != size || information.UniqueProcessId.ToUInt64() != (ulong)self.Id)
        throw new InvalidOperationException("Own process identity could not be verified");
      return checked((int)information.InheritedFromUniqueProcessId.ToUInt64());
    }
  }
}`;
async function prepareParentProbe(t,cwd) {
  const file=path.join(cwd,'fixed-parent-probe.dll'), source=Buffer.from(parentProbeSource,'utf8').toString('base64');
  const command=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))) -OutputAssembly ${quoted(file)} -OutputType Library; [Console]::Out.WriteLine('FIXTURE_HELPER_READY')`;
  // Compilation is fixed fixture preparation, outside the marker window. The
  // ordinary production Job supervisor still owns this compiler's lifetime.
  const result=await runWindowsCommand({command,cwd,env,timeoutMs:HELPER_BUILD_MS});
  t.diagnostic(JSON.stringify({phase:'fixed-helper-compilation',...outcomeFacts(result)}));
  assert.equal(result.exitCode,0);assert.equal(result.timedOut,false);assert.match(result.stdout,/^FIXTURE_HELPER_READY\r?\n$/u);
  const stat=await lstat(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size>0&&stat.size<=1024*1024);
  const sha256=createHash('sha256').update(await readFile(file)).digest('hex');
  return {file,sha256};
}
function ownedCommand(marker,probe) {
  const inner = Buffer.from('Start-Sleep -Seconds 120', 'utf16le').toString('base64');
  return `$ErrorActionPreference='Stop'
$probeBytes=[IO.File]::ReadAllBytes(${quoted(probe.file)})
$probeHash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($probeBytes)).Replace('-','').ToLowerInvariant()
if($probeHash -cne '${probe.sha256}') { throw 'fixed fixture helper changed' }
$null=[Reflection.Assembly]::Load($probeBytes)
$supervisorId=[OpenAsterFixtureParent]::OwnParentId()
$descendant=Start-Process -FilePath ${quoted(shell)} -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${inner}' -WindowStyle Hidden -PassThru
$items=@(
  @{role='supervisor';process=[Diagnostics.Process]::GetProcessById($supervisorId)},
  @{role='shell';process=[Diagnostics.Process]::GetCurrentProcess()},
  @{role='descendant';process=$descendant}
)
$records=@($items | ForEach-Object { @{role=$_.role;id=$_.process.Id;started=$_.process.StartTime.ToUniversalTime().Ticks.ToString();executable=$_.process.MainModule.FileName} })
[IO.File]::WriteAllText(${quoted(marker)},(ConvertTo-Json -InputObject $records -Compress))
Start-Sleep -Seconds 120`;
}
function observe(marker, cwd) {
  // Acquire real process handles while all three exact instances are live.
  // A reused PID cannot satisfy WaitForExit on a handle already bound here.
  const script = `$ErrorActionPreference='Stop'
$held=@()
try {
  $records=Get-Content -LiteralPath ${quoted(marker)} -Raw | ConvertFrom-Json
  foreach($record in $records) {
    if($record.role -notin @('supervisor','shell','descendant')) { throw 'unexpected role' }
    if($record.executable -ine ${quoted(shell)}) { throw 'unexpected executable' }
    $process=[Diagnostics.Process]::GetProcessById([int]$record.id)
    $handle=$process.Handle
    if($process.StartTime.ToUniversalTime().Ticks.ToString() -cne $record.started -or $process.MainModule.FileName -ine $record.executable -or $process.HasExited) { throw 'process identity changed' }
    $held+=@{process=$process;role=$record.role;id=$record.id;started=$record.started}
  }
  if($held.Count -ne 3) { throw 'missing owned process' }
  [Console]::WriteLine('READY'); [Console]::Out.Flush()
  $watch=[Diagnostics.Stopwatch]::StartNew()
  foreach($item in $held) {
    $remaining=[Math]::Max(0,35000-[int]$watch.ElapsedMilliseconds)
    if(-not $item.process.WaitForExit($remaining)) { throw ('owned process survived: '+$item.role) }
  }
  $result=@($held | ForEach-Object { @{role=$_.role;id=$_.id;started=$_.started;exited=$_.process.HasExited} })
  [Console]::WriteLine((ConvertTo-Json -InputObject $result -Compress)); exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
finally { foreach($item in $held) { $item.process.Dispose() } }`;
  return launch(shell, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], cwd);
}
async function scenario(t, killParent) {
  const tempRoot = await realpath(os.tmpdir());
  const cwd = await mkdtemp(path.join(tempRoot, 'openaster-job-lifetime-'));
  const original = await lstat(cwd);
  const marker = path.join(cwd, 'owned-processes.json');
  const controller = new AbortController();
  let operation, parent, observer, commandOutcome, passed = false;
  const startedAt = performance.now(), commandFacts = { state: 'not-started', readyCount: 0, readyElapsedMs: null };
  let stage = 'preparing';
  const diagnostic = phase => t.diagnostic(JSON.stringify({ phase, stage, elapsedMs: Math.round(performance.now() - startedAt),
    command: commandFacts, parent: parent?.facts() ?? null, observer: observer?.facts() ?? null }));
  try {
    const probe=await prepareParentProbe(t,cwd), command=ownedCommand(marker,probe);
    if (killParent) {
      const script = path.join(cwd, 'owner.mjs');
      await writeFile(script, `import { runWindowsCommand } from ${JSON.stringify(new URL('../core/windows-command.mjs', import.meta.url).href)};
const result=await runWindowsCommand({...${JSON.stringify({ command, cwd, env, timeoutMs: 120000 })},onStarted:()=>console.log('COMMAND_READY')});
console.log(JSON.stringify(result));
`, { flag: 'wx' });
      parent = launch(process.execPath, [script], cwd);
    } else {
      commandFacts.state = 'pending';
      operation = runWindowsCommand({ command, cwd, env, timeoutMs: 20000, signal: controller.signal,
        onStarted: () => { commandFacts.readyCount++; commandFacts.readyElapsedMs = Math.round(performance.now() - startedAt); },
      }).then(result => { commandOutcome = result; Object.assign(commandFacts, { state: 'resolved', ...outcomeFacts(result) }); return result; },
        error => { Object.assign(commandFacts, { state: 'rejected', errorCode: diagnosticCode(error) }); throw error; });
      // Attach rejection handling immediately, even if setup fails before the await.
      operation.catch(() => {});
    }
    stage = 'waiting-host-ready';
    await waitUntil(()=>{
      if(commandFacts.readyCount===1 || parent?.facts().commandReadyCount===1)return true;
      if(commandFacts.state==='resolved'||commandFacts.state==='rejected'||parent?.outcome())throw new Error('owned command exited before its durable-start gate');
      return false;
    },'owned supervisor must reach READY within its preparation budget',WINDOWS_HOST_PREPARATION_MS+WINDOWS_HOST_CLEANUP_MS);
    // The original 15-second marker allowance begins after READY, not while
    // the outer host or this fixture's fixed helper is being compiled.
    stage = 'waiting-marker';
    await waitUntil(async () => {
      if (await markerReady(marker)) return true;
      if (commandFacts.state === 'resolved' || commandFacts.state === 'rejected' || parent?.outcome()) throw new Error('owned command exited before publishing process identities');
      return false;
    }, 'all owned command processes must actually start',MARKER_MS);
    stage = 'waiting-observer';
    observer = observe(marker, cwd);
    await waitUntil(() => observer.output().startsWith('READY\r\n') || observer.output().startsWith('READY\n'), 'observer must bind exact live process handles');
    stage = 'triggering-exit';
    if (killParent) {
      assert.equal(parent.child.exitCode, null);
      assert.equal(parent.child.kill(), true, 'terminate only the test-created Node ChildProcess handle');
      const ended = await parent.done;
      assert.equal(ended.spawnError, undefined);
      assert.notEqual(ended.code, 0, 'owner was terminated before its command timeout');
    } else {
      const result = await operation;
      assert.equal(result.timedOut, true);
      assert.equal(result.cancelled, false);
      assert.equal(result.signal, 'SIGTERM');
    }
    stage = 'waiting-observer-exit';
    const observed = await observer.done;
    assert.equal(observed.spawnError, undefined);
    assert.equal(observed.code, 0, observed.stderr);
    const evidence = JSON.parse(observed.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(evidence.map(item => item.role), ['supervisor','shell','descendant']);
    assert.ok(evidence.every(item => item.exited === true));
    t.diagnostic(JSON.stringify({ trigger: killParent ? 'test-owned-node-parent-termination' : 'command-timeout', heldProcessHandles: evidence }));
    passed = true;
    stage = 'completed';
  } finally {
    // Only this fixed fixture's own shell output is inspected. Redact its paths
    // before printing bounded diagnostics; no user commands or file bodies run.
    if (!passed) {
      let output = commandOutcome;
      const parentResult = parent?.outcome();
      if (!output && parentResult?.stdout) { try { output = JSON.parse(parentResult.stdout.trim().split(/\r?\n/u).at(-1)); } catch { /* The owner might not have reached a result. */ } }
      const detail = output?.stderr || parentResult?.stderr || '';
      if (detail) t.diagnostic('Owned fixture failure: ' + detail.replaceAll(cwd, '<owned-fixture>').replaceAll(process.execPath, '<node>').replaceAll(shell, '<powershell>').slice(0, 2400));
    }
    diagnostic('before-cleanup');
    // Never select a process by name or terminate a PID read from a marker.
    controller.abort();
    if (parent && parent.child.exitCode === null && parent.child.signalCode === null) parent.child.kill();
    await Promise.allSettled([operation, parent?.done, observer?.done]);
    diagnostic('after-cleanup');
    if (passed) {
      const current = await lstat(cwd);
      assert.equal(await realpath(cwd), cwd);
      assert.equal(path.dirname(cwd), tempRoot);
      assert.ok(!current.isSymbolicLink() && current.isDirectory());
      assert.equal(current.dev, original.dev); assert.equal(current.ino, original.ino);
      await rm(cwd, { recursive: true, force: false });
    } else {
      t.diagnostic('Preserved owned failure fixture (path omitted).');
    }
  }
}
test('Windows command timeout closes its owned supervisor, shell and descendant handles', options, t => scenario(t, false));
test('Windows command parent EOF closes supervisor and descendants after the test-owned Node parent exits', options, t => scenario(t, true));
