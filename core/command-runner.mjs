// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { CoreError, checkAbort } from './errors.mjs';
import { COMMAND_LIMITS, validateCommand } from './command-schema.mjs';
import { prepareReadOnlyCommand, isReadOnlyCandidate } from './read-only-command.mjs';

// Explicit environment projection: provider/gateway credentials and arbitrary
// inherited shell configuration are not passed to the child. This is not an OS
// sandbox: an approved command runs with the current account's filesystem rights.
export function commandEnvironment(source = process.env, platform = process.platform) {
  const names = platform === 'win32'
    ? ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'];
  const env = {};
  for (const name of names) {
    const key = Object.keys(source).find(key => platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name);
    if (key && typeof source[key] === 'string' && !source[key].includes('\0')) env[name] = source[key];
  }
  return env;
}

// Bound both displayed UTF-8 and its archived JSON representation. Control
// characters and invalid UTF-8 replacements must not overflow the artifact cap.
export function boundCommandOutput(value) {
  let bytes = 0, encoded = 0, end = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character), json = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + next > COMMAND_LIMITS.outputBytes || encoded + json > COMMAND_LIMITS.outputBytes) break;
    bytes += next; encoded += json; end += character.length;
  }
  return { text: value.slice(0, end), truncated: end !== value.length };
}

// Darwin can return EPERM from killpg while an exiting group contains only
// zombies. It is not proof of exit. After pipes and the checkpoint drain, only
// ESRCH can clear that error; never send another signal to a possibly reused ID.
export async function confirmDarwinCommandGroupGone(pid, error, { deadline, platform = process.platform,
  probe = (target, signal) => process.kill(target, signal), now = () => performance.now(),
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (platform !== 'darwin' || error?.code !== 'EPERM' || !Number.isSafeInteger(pid) || pid <= 1 || !Number.isFinite(deadline)) return false;
  const end = Math.min(deadline, now() + 1000);
  for (;;) {
    try { probe(-pid, 0); }
    catch (failure) {
      if (failure.code === 'ESRCH') return true;
      if (failure.code !== 'EPERM') return false;
    }
    const remaining = end - now();
    if (remaining <= 0) return false;
    await pause(Math.min(25, remaining));
  }
}

async function runPosixCommand({ command, cwd, env, timeoutMs, signal, onStarted }) {
  checkAbort(signal);
  const started = performance.now();
  // The fixed parent shell waits for our gate before executing the approved
  // command. No shell profile or inherited ENV/BASH_ENV hook is loaded.
  const child = spawn('/bin/sh', ['-c', 'IFS= read -r gate; [ "$gate" = openaster-start ] || exit 125; exec /bin/sh -c "$1"', 'openaster-command', command],
    { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const buffers = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
  let truncated = false, timedOut = false, cancelled = false, startError, spawnError, killError, callback;
  const terminate = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) {
      // An unrelated signal error must not later become a recoverable EPERM.
      if (error.code !== 'ESRCH' && (!killError || killError.code === 'EPERM')) killError = error;
    }
  };
  for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => {
    const remaining = COMMAND_LIMITS.outputBytes - sizes[name];
    if (bytes.length > remaining) truncated = true;
    if (remaining > 0) { const part = bytes.subarray(0, remaining); buffers[name].push(part); sizes[name] += part.length; }
  });
  child.stdin.on('error', error => { if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) { startError ??= error; terminate(); } });
  const abort = () => { cancelled = true; terminate(); };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  child.once('error', error => { spawnError = error; });
  child.once('spawn', () => {
    callback = (async () => {
      try {
        checkAbort(signal);
        if (timedOut) return;
        await onStarted?.();
        checkAbort(signal);
        if (!timedOut) child.stdin.end('openaster-start\n');
      } catch (error) { startError = error; terminate(); }
    })();
  });
  // Even on a normal shell exit, stop descendants still holding the group/pipes.
  child.once('exit', terminate);
  const result = await new Promise(resolve => child.once('close', (exitCode, exitSignal) => resolve({ exitCode, signal: exitSignal })));
  clearTimeout(timer); signal?.removeEventListener('abort', abort);
  await callback;
  if (killError && !await confirmDarwinCommandGroupGone(child.pid, killError, { deadline: started + timeoutMs })) {
    throw new CoreError('COMMAND_CLEANUP_FAILED', '命令进程组无法确认已停止；任务已停止，请检查本机进程。', 503);
  }
  if (spawnError) throw new CoreError('COMMAND_START_FAILED', '系统 shell 无法启动；命令未执行。', 503);
  if (startError && !signal?.aborted && !timedOut) throw startError;
  const text = name => Buffer.concat(buffers[name]).toString('utf8');
  return { ...result, stdout: text('stdout'), stderr: text('stderr'), truncated, timedOut, cancelled, durationMs: Math.round(performance.now() - started) };
}

export function createCommandRunner({ workspace }) {
  if (typeof workspace?.commandDirectory !== 'function') throw new TypeError('Command runner requires a workspace directory verifier');
  const proposals = new WeakMap();
  const shell = process.platform === 'win32' ? 'powershell' : 'sh';
  return Object.freeze({
    async prepare(args, { signal } = {}) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Reflect.ownKeys(args).some(key => !['command', 'cwd', 'timeoutMs'].includes(key))) throw new CoreError('INVALID_COMMAND', '命令参数无效。');
      const values = {};
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(args))) {
        if (!Object.hasOwn(descriptor, 'value')) throw new CoreError('INVALID_COMMAND', '命令参数无效。');
        values[key] = descriptor.value;
      }
      const value = validateCommand({ command: values.command, cwd: Object.hasOwn(values, 'cwd') ? values.cwd : '', timeoutMs: Object.hasOwn(values, 'timeoutMs') ? values.timeoutMs : COMMAND_LIMITS.defaultTimeoutMs, shell });
      checkAbort(signal);
      const directory = await workspace.commandDirectory(value.cwd, { signal });
      checkAbort(signal);
      const readOnly = await prepareReadOnlyCommand(value, { root: workspace.root, directory, signal });
      const proposal = Object.freeze(value); proposals.set(proposal, { directory, readOnly }); return proposal;
    },
    describe(proposal) {
      const value = proposals.get(proposal);
      if (!value) throw new CoreError('INVALID_COMMAND_PROPOSAL', '命令提案不存在、已使用或已撤销。', 409);
      return { root: workspace.root, directory: { ...value.directory }, readOnly: Boolean(value.readOnly), readOnlyCandidate: isReadOnlyCandidate(proposal) };
    },
    async execute(proposal, { signal, onStarted, authorize, readOnly = false } = {}) {
      const prepared = proposals.get(proposal);
      if (!prepared) throw new CoreError('INVALID_COMMAND_PROPOSAL', '命令提案不存在、已使用或已撤销。', 409);
      proposals.delete(proposal);
      checkAbort(signal);
      const directory = await workspace.commandDirectory(proposal.cwd, { signal });
      if (JSON.stringify(prepared.directory) !== JSON.stringify(directory)) throw new CoreError('COMMAND_DIRECTORY_CHANGED', '批准前后的命令工作目录已变化；命令未执行。', 409);
      const plan = readOnly ? prepared.readOnly : null;
      if (readOnly && !plan) throw new CoreError('COMMAND_READ_ONLY_CHANGED', '命令没有有效只读执行计划。', 409);
      if (plan) await plan.verify();
      await authorize?.();
      checkAbort(signal);
      const run = process.platform === 'win32' ? (await import('./windows-command.mjs')).runWindowsCommand : runPosixCommand;
      const result = await run({ command: plan?.command ?? proposal.command, cwd: directory.canonical, env: { ...commandEnvironment(), ...(plan?.environment ?? {}) }, timeoutMs: proposal.timeoutMs, signal, onStarted: async () => {
        await onStarted?.();
        // The gate remains closed across durable approval/audit writes. Revoke
        // and re-check immediately before the supervisor releases command code.
        if (plan) await plan.verify();
        await authorize?.();
        checkAbort(signal);
      } });
      const stdout = boundCommandOutput(result.stdout), stderr = boundCommandOutput(result.stderr);
      return { shell: proposal.shell, cwd: proposal.cwd, ...result, stdout: stdout.text, stderr: stderr.text, truncated: result.truncated || stdout.truncated || stderr.truncated };
    },
    discard(proposal) { proposals.delete(proposal); },
  });
}
