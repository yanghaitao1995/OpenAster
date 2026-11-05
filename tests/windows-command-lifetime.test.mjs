// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runWindowsCommand } from '../core/windows-command.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot','windir','path','temp','tmp','pathext'].includes(key.toLowerCase())));
const systemRoot = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
const shell = systemRoot ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
const quoted = value => "'" + value.replaceAll("'", "''") + "'";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = { skip: process.platform !== 'win32', timeout: 70000 };

function launch(executable, args, cwd) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { spawnError = error.message; });
  const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, spawnError })));
  return { child, done, output: () => stdout };
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
function ownedCommand(marker) {
  const inner = Buffer.from('Start-Sleep -Seconds 120', 'utf16le').toString('base64');
  return `$ErrorActionPreference='Stop'
$descendant=Start-Process -FilePath ${quoted(shell)} -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${inner}' -WindowStyle Hidden -PassThru
$self=Get-CimInstance Win32_Process -Filter ("ProcessId="+$PID)
$items=@(
  @{role='supervisor';process=[Diagnostics.Process]::GetProcessById([int]$self.ParentProcessId)},
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
  const command = ownedCommand(marker);
  const controller = new AbortController();
  let operation, parent, observer, passed = false;
  try {
    if (killParent) {
      const script = path.join(cwd, 'owner.mjs');
      await writeFile(script, `import { runWindowsCommand } from ${JSON.stringify(new URL('../core/windows-command.mjs', import.meta.url).href)};
const result=await runWindowsCommand(${JSON.stringify({ command, cwd, env, timeoutMs: 120000 })});
console.log(JSON.stringify(result));
`, { flag: 'wx' });
      parent = launch(process.execPath, [script], cwd);
    } else {
      operation = runWindowsCommand({ command, cwd, env, timeoutMs: 20000, signal: controller.signal });
      // Attach rejection handling immediately, even if setup fails before the await.
      operation.catch(() => {});
    }
    await waitUntil(() => markerReady(marker), 'all owned command processes must actually start');
    observer = observe(marker, cwd);
    await waitUntil(() => observer.output().startsWith('READY\r\n') || observer.output().startsWith('READY\n'), 'observer must bind exact live process handles');
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
    const observed = await observer.done;
    assert.equal(observed.spawnError, undefined);
    assert.equal(observed.code, 0, observed.stderr);
    const evidence = JSON.parse(observed.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(evidence.map(item => item.role), ['supervisor','shell','descendant']);
    assert.ok(evidence.every(item => item.exited === true));
    t.diagnostic(JSON.stringify({ trigger: killParent ? 'test-owned-node-parent-termination' : 'command-timeout', heldProcessHandles: evidence }));
    passed = true;
  } finally {
    // Never select a process by name or terminate a PID read from a marker.
    controller.abort();
    if (parent && parent.child.exitCode === null && parent.child.signalCode === null) parent.child.kill();
    await Promise.allSettled([operation, parent?.done, observer?.done]);
    if (passed) {
      const current = await lstat(cwd);
      assert.equal(await realpath(cwd), cwd);
      assert.equal(path.dirname(cwd), tempRoot);
      assert.ok(!current.isSymbolicLink() && current.isDirectory());
      assert.equal(current.dev, original.dev); assert.equal(current.ino, original.ino);
      await rm(cwd, { recursive: true, force: false });
    } else {
      t.diagnostic('Preserved owned failure fixture: ' + cwd);
    }
  }
}
test('Windows command timeout closes its owned supervisor, shell and descendant handles', options, t => scenario(t, false));
test('Windows command parent EOF closes supervisor and descendants after the test-owned Node parent exits', options, t => scenario(t, true));
