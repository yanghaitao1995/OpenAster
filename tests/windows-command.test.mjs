// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runWindowsCommand } from '../core/windows-command.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot','windir','path','temp','tmp','pathext'].includes(key.toLowerCase())));
const options = { skip: process.platform !== 'win32', timeout: 30000 };
const quoted = value => "'" + value.replaceAll("'", "''") + "'";
async function fixture(fn) {
  const cwd=await mkdtemp(path.join(await realpath(os.tmpdir()),'openaster-job-test-'));
  try { await fn(cwd); } finally { await rm(cwd,{recursive:true,force:true}); }
}
test('Windows command captures UTF-8 output, exit code, cwd and isolated environment', options, async()=>fixture(async cwd=>{
  let started=0;
  const result=await runWindowsCommand({command:"[Console]::WriteLine('你好'); [Console]::Error.WriteLine('error'); [Console]::WriteLine((Get-Location).Path); [Console]::WriteLine($env:OPENASTER_TEST_SECRET); exit 7",cwd,env,timeoutMs:15000,onStarted:()=>{started++;}});
  assert.equal(started,1); assert.equal(result.exitCode,7); assert.equal(result.timedOut,false);
  assert.match(result.stdout,/你好/);
  const reportedCwd = result.stdout.split(/\r?\n/u)[1];
  assert.ok(path.isAbsolute(reportedCwd), 'shell reports an absolute working directory');
  assert.equal((await realpath(reportedCwd)).toLowerCase(), (await realpath(cwd)).toLowerCase(), 'shell actually runs in the selected directory');
  assert.equal(result.stderr.trim(),'error'); assert.doesNotMatch(result.stdout,/do-not-inherit/);
}));
test('Windows approval persistence failure prevents any command execution', options, async()=>fixture(async cwd=>{
  const file=path.join(cwd,'must-not-exist'); const error=new Error('durability failed');
  await assert.rejects(runWindowsCommand({command:`[IO.File]::WriteAllText(${quoted(file)},'bad')`,cwd,env,timeoutMs:15000,onStarted:()=>{throw error;}}),value=>value===error);
  await assert.rejects(access(file),{code:'ENOENT'});
}));
test('Windows output stays bounded while both streams are drained', options, async()=>fixture(async cwd=>{
  const result=await runWindowsCommand({command:"[Console]::Out.Write('x'*300000); [Console]::Error.Write('y'*300000)",cwd,env,timeoutMs:15000});
  assert.equal(result.exitCode,0); assert.equal(result.truncated,true); assert.equal(result.stdout.length,262144); assert.equal(result.stderr.length,262144);
}));
test('Windows cancellation terminates owned descendants; normal exit also cleans background descendants', {...options,timeout:45000}, async()=>fixture(async cwd=>{
  for(const cancel of [true,false]) {
    const marker=path.join(cwd,cancel?'cancel-child.pid':'exit-child.pid');
    const shell=path.join(env.SystemRoot||env.SYSTEMROOT||env.windir||env.WINDIR,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const inner=Buffer.from('Start-Sleep -Seconds 120','utf16le').toString('base64');
    const command=`$p=Start-Process -FilePath ${quoted(shell)} -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${inner}' -PassThru -WindowStyle Hidden; [IO.File]::WriteAllText(${quoted(marker)},[string]$p.Id); ${cancel?'Start-Sleep -Seconds 120':''}`;
    const controller=new AbortController();
    const promise=runWindowsCommand({command,cwd,env,timeoutMs:20000,signal:controller.signal});
    // The host can reject while the marker is still being polled.
    promise.catch(()=>{});
    try {
      let pid;
      for(let i=0;i<100;i++){try{pid=Number(await readFile(marker,'utf8'));break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,100));}
      assert.ok(Number.isSafeInteger(pid)&&pid>0,'child actually started');
      if(cancel)controller.abort();
      const result=await promise; assert.equal(result.cancelled,cancel);
      let alive=true;for(let i=0;i<40;i++){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH'){alive=false;break;}throw error;}await new Promise(resolve=>setTimeout(resolve,50));}
      assert.equal(alive,false,'owned child process does not survive');
    } finally {
      // Even a failed marker assertion must finish this owned host before the
      // fixture removes its working directory or the next iteration starts.
      controller.abort();
      await Promise.allSettled([promise]);
    }
  }
}));
