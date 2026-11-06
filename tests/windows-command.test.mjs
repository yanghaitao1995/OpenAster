// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWindowsCommand } from '../core/windows-command.mjs';
import { WINDOWS_HOST_PREPARATION_MS, WINDOWS_HOST_CLEANUP_MS } from '../core/windows-command-budget.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot','windir','path','temp','tmp','pathext'].includes(key.toLowerCase())));
const options = { skip: process.platform !== 'win32', timeout: WINDOWS_HOST_PREPARATION_MS + 15000 + WINDOWS_HOST_CLEANUP_MS + 5000 };
const quoted = value => "'" + value.replaceAll("'", "''") + "'";
const diagnosticCodes = new Set(['COMMAND_HOST_FAILED', 'ABORTED', 'ENOENT', 'EACCES', 'EPERM', 'EPIPE']);
function observeCommand(t, input) {
  const startedAt = performance.now(), facts = { state: 'pending', readyCount: 0, readyElapsedMs: null };
  const snapshot = () => ({ ...facts, elapsedMs: Math.round(performance.now() - startedAt) });
  const promise = runWindowsCommand({ ...input, onStarted: async () => {
    facts.readyCount++; facts.readyElapsedMs = Math.round(performance.now() - startedAt);
    await input.onStarted?.();
  } }).then(result => {
    Object.assign(facts, { state: 'resolved', exitCode: result.exitCode, signal: result.signal === 'SIGTERM' ? 'SIGTERM' : null,
      timedOut: result.timedOut, cancelled: result.cancelled, durationMs: result.durationMs,
      stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), truncated: result.truncated });
    t.diagnostic(JSON.stringify(snapshot())); return result;
  }, error => {
    Object.assign(facts, { state: 'rejected', errorCode: diagnosticCodes.has(error?.code) ? error.code : 'OTHER' });
    t.diagnostic(JSON.stringify(snapshot())); throw error;
  });
  return { promise, snapshot };
}
async function fixture(fn) {
  const cwd=await mkdtemp(path.join(await realpath(os.tmpdir()),'openaster-job-test-'));
  try { await fn(cwd); } finally { await rm(cwd,{recursive:true,force:true}); }
}
test('Windows command captures UTF-8 output, exit code, cwd and isolated environment', options, async t=>fixture(async cwd=>{
  let started=0;
  const result=await observeCommand(t,{command:"[Console]::WriteLine('你好'); [Console]::Error.WriteLine('error'); [Console]::WriteLine((Get-Location).Path); [Console]::WriteLine($env:OPENASTER_TEST_SECRET); exit 7",cwd,env,timeoutMs:15000,onStarted:()=>{started++;}}).promise;
  assert.equal(started,1); assert.equal(result.exitCode,7); assert.equal(result.timedOut,false);
  assert.match(result.stdout,/你好/);
  const reportedCwd = result.stdout.split(/\r?\n/u)[1];
  assert.ok(path.isAbsolute(reportedCwd), 'shell reports an absolute working directory');
  assert.equal((await realpath(reportedCwd)).toLowerCase(), (await realpath(cwd)).toLowerCase(), 'shell actually runs in the selected directory');
  assert.equal(result.stderr.trim(),'error'); assert.doesNotMatch(result.stdout,/do-not-inherit/);
}));
test('Windows approval persistence failure prevents any command execution', options, async t=>fixture(async cwd=>{
  const file=path.join(cwd,'must-not-exist'); const error=new Error('durability failed');
  await assert.rejects(observeCommand(t,{command:`[IO.File]::WriteAllText(${quoted(file)},'bad')`,cwd,env,timeoutMs:15000,onStarted:()=>{throw error;}}).promise,value=>value===error);
  await assert.rejects(access(file),{code:'ENOENT'});
}));
test('Windows output stays bounded while both streams are drained', options, async t=>fixture(async cwd=>{
  const result=await observeCommand(t,{command:"[Console]::Out.Write('x'*300000); [Console]::Error.Write('y'*300000)",cwd,env,timeoutMs:15000}).promise;
  assert.equal(result.exitCode,0); assert.equal(result.truncated,true); assert.equal(result.stdout.length,262144); assert.equal(result.stderr.length,262144);
}));
test('Windows cancellation terminates owned descendants; normal exit also cleans background descendants', {...options,timeout:2*(WINDOWS_HOST_PREPARATION_MS+20000+WINDOWS_HOST_CLEANUP_MS+5000)}, async t=>fixture(async cwd=>{
  for(const cancel of [true,false]) {
    const marker=path.join(cwd,cancel?'cancel-child.pid':'exit-child.pid');
    const shell=path.join(env.SystemRoot||env.SYSTEMROOT||env.windir||env.WINDIR,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const inner=Buffer.from('Start-Sleep -Seconds 120','utf16le').toString('base64');
    const command=`$p=Start-Process -FilePath ${quoted(shell)} -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${inner}' -PassThru -WindowStyle Hidden; [IO.File]::WriteAllText(${quoted(marker)},[string]$p.Id); ${cancel?'Start-Sleep -Seconds 120':''}`;
    const controller=new AbortController();
    const observed=observeCommand(t,{command,cwd,env,timeoutMs:20000,signal:controller.signal}), promise=observed.promise;
    // The host can reject while the marker is still being polled.
    promise.catch(()=>{});
    try {
      const readyDeadline=performance.now()+WINDOWS_HOST_PREPARATION_MS+WINDOWS_HOST_CLEANUP_MS;
      while(!observed.snapshot().readyCount && observed.snapshot().state==='pending' && performance.now()<readyDeadline) await new Promise(resolve=>setTimeout(resolve,50));
      assert.equal(observed.snapshot().readyCount,1,'host reached its durable-start gate');
      let pid;
      for(let i=0;i<100;i++){try{pid=Number(await readFile(marker,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,100));}
      assert.ok(Number.isSafeInteger(pid)&&pid>0,'child actually started');
      if(cancel)controller.abort();
      const result=await promise; assert.equal(result.cancelled,cancel);
      let alive=true;for(let i=0;i<40;i++){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH'){alive=false;break;}throw error;}await new Promise(resolve=>setTimeout(resolve,50));}
      assert.equal(alive,false,'owned child process does not survive');
    } finally {
      t.diagnostic(JSON.stringify({ stage: 'before-cleanup', cancelRequested: cancel, ...observed.snapshot() }));
      // Even a failed marker assertion must finish this owned host before the
      // fixture removes its working directory or the next iteration starts.
      controller.abort();
      await Promise.allSettled([promise]);
    }
  }
}));

test('Windows cancellation keeps a pending checkpoint drained and never releases late command code', options, async t=>fixture(async cwd=>{
  const marker=path.join(cwd,'late-checkpoint-must-not-run'), controller=new AbortController();
  let enter, release, completed=false, drained=false;
  const entered=new Promise(resolve=>{enter=resolve;}), checkpoint=new Promise(resolve=>{release=resolve;});
  const observed=observeCommand(t,{command:`[IO.File]::WriteAllText(${quoted(marker)},'forbidden')`,cwd,env,timeoutMs:15000,signal:controller.signal,
    onStarted:async()=>{enter();await checkpoint;drained=true;}});
  const promise=observed.promise.then(result=>{completed=true;return result;});
  promise.catch(()=>{});
  try {
    await Promise.race([entered,promise.then(()=>{throw new Error('Host completed before reaching its checkpoint');})]); controller.abort();
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.equal(completed,false,'task completion still waits for the already-started durable callback');
    await assert.rejects(access(marker),{code:'ENOENT'});
    release(); const result=await promise;
    assert.equal(drained,true); assert.equal(result.cancelled,true); assert.equal(result.timedOut,false);
    await assert.rejects(access(marker),{code:'ENOENT'});
  } finally { controller.abort();release();await Promise.allSettled([promise]); }
}));
