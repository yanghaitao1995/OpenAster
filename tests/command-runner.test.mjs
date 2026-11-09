// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCommandRunner, commandEnvironment, boundCommandOutput, confirmDarwinCommandGroupGone } from '../core/command-runner.mjs';
import { validateCommand, COMMAND_LIMITS } from '../core/command-schema.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { WINDOWS_HOST_PREPARATION_MS, WINDOWS_HOST_CLEANUP_MS } from '../core/windows-command-budget.mjs';

const windows = process.platform === 'win32';
const shellTestTimeout = (windows ? WINDOWS_HOST_PREPARATION_MS : 0) + 30000 + WINDOWS_HOST_CLEANUP_MS + 5000;
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-command-'));
  const identity = await fs.lstat(root, { bigint: true });
  t.after(async () => {
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
    await fs.rm(root, { recursive: true });
  });
  return { root, runner: createCommandRunner({ workspace: createWorkspace(root) }) };
}

test('command validation rejects malformed text, options and cwd; environment does not inherit secrets or profile hooks', async t => {
  const { runner } = await fixture(t);
  for (const args of [{ command: '' }, { command: '\ud800' }, { command: 'a\0b' }, { command: 'x'.repeat(8001) },
    { command: 'echo x', cwd: '../outside' }, { command: 'echo x', cwd: '.env' }, { command: 'echo x', timeoutMs: 0 }, { command: 'echo x', shell: 'other' }]) {
    await assert.rejects(runner.prepare(args));
  }
  const value = { command: 'echo x', cwd: '', shell: 'sh', timeoutMs: 30000 };
  assert.throws(() => validateCommand({ ...value, extra: true }));
  let getter = false;
  assert.throws(() => validateCommand({ ...value, get command() { getter = true; return 'echo bad'; } }));
  assert.equal(getter, false);
  const env = commandEnvironment({ PATH: '/bin', HOME: '/home', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'secret', OPENASTER_GATEWAY_TOKEN: 'secret', ENV: 'hook', BASH_ENV: 'hook', NODE_OPTIONS: '--require hook' });
  for (const key of ['OPENAI_API_KEY', 'OPENASTER_GATEWAY_TOKEN', 'ENV', 'BASH_ENV', 'NODE_OPTIONS']) assert.ok(!Object.hasOwn(env, key));
  assert.equal(env.PATH, '/bin');
});

test('output bounds survive UTF-8 and worst-case JSON control-character expansion', () => {
  for (const text of ['\0'.repeat(262144), '🙂'.repeat(100000), '\ufffd'.repeat(262144)]) {
    const output = boundCommandOutput(text);
    assert.equal(output.truncated, true); assert.ok(output.text.isWellFormed());
    assert.ok(Buffer.byteLength(output.text) <= COMMAND_LIMITS.outputBytes);
    assert.ok(Buffer.byteLength(JSON.stringify(output.text)) <= COMMAND_LIMITS.outputBytes + 2);
  }
  assert.deepEqual(boundCommandOutput('中文\r\n'), { text: '中文\r\n', truncated: false });
});

test('private one-use proposal cannot be forged, reused, or executed after its directory is replaced', async t => {
  const { runner, root } = await fixture(t);
  await fs.mkdir(path.join(root, 'sub'));
  const proposal = await runner.prepare({ command: 'echo approved', cwd: 'sub' });
  await assert.rejects(runner.execute({ ...proposal }), { code: 'INVALID_COMMAND_PROPOSAL' });
  await fs.rename(path.join(root, 'sub'), path.join(root, 'old'));
  await fs.mkdir(path.join(root, 'sub'));
  await assert.rejects(runner.execute(proposal), { code: 'COMMAND_DIRECTORY_CHANGED' });
  await assert.rejects(runner.execute(proposal), { code: 'INVALID_COMMAND_PROPOSAL' });
  const discarded = await runner.prepare({ command: 'echo no' }); runner.discard(discarded);
  await assert.rejects(runner.execute(discarded), { code: 'INVALID_COMMAND_PROPOSAL' });
});

test('real shell starts only after its checkpoint, returns Unicode, cwd, stderr and nonzero exit', { timeout: shellTestTimeout }, async t => {
  const { runner, root } = await fixture(t); await fs.mkdir(path.join(root, 'sub'));
  const command = windows ? '[Console]::Out.WriteLine("中文"); [Console]::Out.WriteLine((Get-Location).Path); [Console]::Error.WriteLine("stderr"); exit 7'
    : 'printf "中文\\n"; pwd; printf stderr >&2; exit 7';
  const proposal = await runner.prepare({ command, cwd: 'sub', timeoutMs: 30000 });
  let started = 0, readyElapsedMs = null, result;
  const executionStarted = performance.now();
  try {
    result = await runner.execute(proposal, { onStarted: async () => { started++; readyElapsedMs = Math.round(performance.now() - executionStarted); } });
  } finally {
    t.diagnostic(JSON.stringify({ event: 'real-shell-checkpoint-timing', started, readyElapsedMs,
      elapsedMs: Math.round(performance.now() - executionStarted),
      ...(result ? { durationMs: result.durationMs, exitCode: result.exitCode, timedOut: result.timedOut,
        cancelled: result.cancelled, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
        unicodeArrived: result.stdout.includes('中文'), selectedDirectoryArrived: result.stdout.includes(path.join(root, 'sub')),
        stderrFixtureArrived: result.stderr.includes('stderr') } : { resultReceived: false }) }));
  }
  assert.equal(started, 1); assert.equal(result.exitCode, 7); assert.equal(result.shell, windows ? 'powershell' : 'sh');
  assert.equal(result.cwd, 'sub'); assert.match(result.stdout, /中文/); assert.ok(result.stdout.includes(path.join(root, 'sub')));
  assert.match(result.stderr, /stderr/); assert.equal(result.cancelled, false); assert.equal(result.timedOut, false);
  await assert.rejects(runner.execute(proposal), { code: 'INVALID_COMMAND_PROPOSAL' });
});

test('failed start checkpoint prevents approved shell body from executing', { timeout: shellTestTimeout }, async t => {
  const { runner, root } = await fixture(t);
  const proposal = await runner.prepare({ command: windows ? 'Set-Content marker.txt forbidden' : 'printf forbidden > marker.txt' });
  await assert.rejects(runner.execute(proposal, { onStarted: () => { throw Object.assign(new Error('checkpoint'), { code: 'FIXTURE_CHECKPOINT' }); } }), { code: 'FIXTURE_CHECKPOINT' });
  await assert.rejects(fs.stat(path.join(root, 'marker.txt')), { code: 'ENOENT' });
});

test('real shell cancellation drains its owned process and preserves bounded result facts', { timeout: shellTestTimeout }, async t => {
  const { runner } = await fixture(t), controller = new AbortController();
  const proposal = await runner.prepare({ command: windows ? '[Console]::Out.WriteLine("started"); Start-Sleep -Seconds 30' : 'printf started; sleep 30', timeoutMs: 30000 });
  let timer, readyAt;
  try {
    const result = await runner.execute(proposal, { signal: controller.signal, onStarted: () => { readyAt=performance.now(); timer = setTimeout(() => controller.abort(), 300); } });
    assert.equal(result.cancelled, true); assert.equal(result.timedOut, false);
    assert.ok(Number.isFinite(readyAt) && performance.now()-readyAt < 30000,'cancellation completes within the original post-checkpoint bound');
    assert.ok(result.durationMs < shellTestTimeout,'preparation and execution remain within their combined test envelope');
  } finally { clearTimeout(timer); }
});

const groupError = code => Object.assign(new Error('private process detail'), { code });
test('Darwin transient group EPERM clears only after ESRCH, with no additional termination signal', async () => {
  let time = 100, reads = 0; const calls = [], waits = [];
  const gone = await confirmDarwinCommandGroupGone(820001, groupError('EPERM'), { platform: 'darwin', deadline: 30100,
    now: () => time, pause: async ms => { waits.push(ms); time += ms; },
    probe: (pid, signal) => { calls.push([pid, signal]); reads++; if (reads === 1) throw groupError('EPERM'); if (reads === 3) throw groupError('ESRCH'); } });
  assert.equal(gone, true); assert.deepEqual(calls, Array(3).fill([-820001, 0])); assert.deepEqual(waits, [25, 25]);
});

test('Darwin cleanup confirmation never treats a live or inaccessible group as drained', async () => {
  for (const persistent of ['alive', 'EPERM', 'EIO']) {
    let time = 0, probes = 0;
    const gone = await confirmDarwinCommandGroupGone(820001, groupError('EPERM'), { platform: 'darwin', deadline: 30000,
      now: () => time, pause: async ms => { time += ms; },
      probe: (pid, signal) => { assert.equal(pid, -820001); assert.equal(signal, 0); probes++; if (persistent !== 'alive') throw groupError(persistent); } });
    assert.equal(gone, false); assert.equal(time, persistent === 'EIO' ? 0 : 1000);
    assert.equal(probes, persistent === 'EIO' ? 1 : 41);
  }
});

test('group observation cannot extend the original command deadline or admit unrelated cleanup errors', async () => {
  let time = 90, waits = [];
  assert.equal(await confirmDarwinCommandGroupGone(820001, groupError('EPERM'), { platform: 'darwin', deadline: 100,
    now: () => time, pause: async ms => { waits.push(ms); time += ms; }, probe: () => {} }), false);
  assert.equal(time, 100); assert.deepEqual(waits, [10]);
  assert.equal(await confirmDarwinCommandGroupGone(820001, groupError('EPERM'), { platform: 'darwin', deadline: 80,
    now: () => time, pause: () => assert.fail('expired budget must not wait'), probe: () => { throw groupError('ESRCH'); } }), true);
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const code of ['EPERM', 'EIO', 'EINVAL']) {
      if (platform === 'darwin' && code === 'EPERM') continue;
      assert.equal(await confirmDarwinCommandGroupGone(820001, groupError(code), { platform, deadline: 100,
        probe: () => assert.fail('unrelated error/platform must keep original failure') }), false);
    }
  }
});

test('Darwin cancellation retains real process drainage after a redundant group kill reports EPERM', { skip: process.platform !== 'darwin', timeout: shellTestTimeout }, async t => {
  const { runner, root } = await fixture(t), controller = new AbortController(), realKill = process.kill.bind(process);
  let group, kills = 0, probes = 0;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid < -1 && signal === 'SIGKILL') {
      group ??= pid; assert.equal(pid, group); kills++;
      if (kills === 2) throw groupError('EPERM');
    }
    if (pid === group && signal === 0) probes++;
    return realKill(pid, signal);
  });
  const proposal = await runner.prepare({ command: 'printf "%s\\n" "$$" > owned.pid; printf started; sleep 30', timeoutMs: 30000 });
  const execution = runner.execute(proposal, { signal: controller.signal }); execution.catch(() => {});
  try {
    let pid;
    const readyDeadline = performance.now() + 5000;
    while (performance.now() < readyDeadline) {
      try { pid = Number((await fs.readFile(path.join(root, 'owned.pid'), 'utf8')).trim()); if (Number.isSafeInteger(pid) && pid > 1) break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(Number.isSafeInteger(pid) && pid > 1, 'approved shell body reached its owned marker');
    controller.abort();
    const result = await execution;
    assert.equal(result.cancelled, true); assert.equal(result.timedOut, false); assert.equal(kills, 2); assert.ok(probes >= 1);
    assert.equal(-pid, group);
    assert.throws(() => realKill(pid, 0), { code: 'ESRCH' });
    assert.throws(() => realKill(group, 0), { code: 'ESRCH' });
  } finally { controller.abort(); await Promise.allSettled([execution]); }
});
