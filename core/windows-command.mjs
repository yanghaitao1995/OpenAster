// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { CoreError, checkAbort } from './errors.mjs';

const bootstrap = "$ErrorActionPreference='Stop'; try { $s=[Console]::ReadLine(); Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))) -ErrorAction Stop; exit [OpenAster.CommandHost]::Run() } catch { [Console]::Out.WriteLine('HOST_ERROR'); exit 1 }";
const unavailable = () => new CoreError('COMMAND_HOST_FAILED', '命令监督进程未正常完成，已停止其进程组；不会自动重试。');
const encode = value => Buffer.from(value, 'utf8').toString('base64');

/** Windows 10+ Job Object lifetime control; this is explicitly NOT an OS sandbox. */
export async function runWindowsCommand({ command, cwd, env, timeoutMs, signal, onStarted }) {
  checkAbort(signal);
  const source = await readFile(new URL('./windows-command-host.cs', import.meta.url), 'utf8');
  checkAbort(signal);
  const root = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1];
  if (!root || !path.isAbsolute(root)) throw unavailable();
  const shell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // The original command is sent only on stdin, never interpolated into a launcher command.
  const script = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding;\n" + command;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    let buffer = '', result, failure, timer, killTimer, timedOut = false, cancelled = false, ready = false, stopping = false, closed = false, pending;
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    function stop() {
      if (stopping || closed) return; stopping = true;
      child.stdin.end(); // Parent lifeline EOF: close only this command's Job Object.
      killTimer = setTimeout(() => child.kill(), 2000);
    }
    function fail(error) { failure ??= error; stop(); }
    function abort() { cancelled = true; stop(); }
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on('error', () => { if (!stopping) fail(unavailable()); });
    child.stderr.on('data', () => {}); // Never surface compiler/host diagnostics or inherited metadata.
    child.on('error', () => fail(unavailable()));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 800000) return fail(unavailable());
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (line === 'READY' && !ready) {
          ready = true;
          pending = Promise.resolve().then(() => { if (!stopping) return onStarted?.(); }).then(() => {
            if (!stopping) child.stdin.write('GO\n');
          }).catch(fail);
        } else if (line.startsWith('RESULT\t') && ready && !result) {
          const parts = line.split('\t');
          if (parts.length !== 5 || !/^-?\d{1,11}$/.test(parts[1]) || !/^[01]$/.test(parts[2]) || parts.slice(3).some(value => !/^[A-Za-z0-9+/]*={0,2}$/.test(value))) { fail(unavailable()); continue; }
          const output = parts.slice(3).map(value => Buffer.from(value, 'base64'));
          if (output.some(value => value.length > 262144)) { fail(unavailable()); continue; }
          result = { exitCode: Number(parts[1]), stdout: output[0].toString('utf8'), stderr: output[1].toString('utf8'), truncated: parts[2] === '1' };
        } else fail(unavailable());
      }
    });
    child.on('close', async code => {
      closed = true;
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      await pending;
      if (failure) return reject(failure);
      if (!timedOut && !cancelled && (code !== 0 || !result || buffer.trim())) return reject(unavailable());
      resolve({ ...(result ?? { exitCode: null, stdout: '', stderr: '', truncated: false }), signal: timedOut || cancelled ? 'SIGTERM' : null, timedOut, cancelled, durationMs: Math.round(performance.now() - started) });
    });
    if (!stopping) child.stdin.write([encode(source), encode(shell), encode(cwd), encode(encoded)].join('\n') + '\n');
  });
}
