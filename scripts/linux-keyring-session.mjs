// SPDX-License-Identifier: Apache-2.0
// CI-only Linux fixture. The installer verifier owns the enclosing process
// group and its original 90/120/250 second deadline; no child detaches here.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executionEnvironment } from './verify-release-installers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SELF = fileURLToPath(import.meta.url);
const LIMITS = Object.freeze({ basic: 75000, backup: 105000, relaunch: 235000 });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function invocation(args) {
  const inside = args[0] === '--session', values = inside ? args.slice(1) : args;
  assert.equal(values.length, inside ? 3 : 2, 'Expected a fixed smoke scenario and executable');
  const [scenario, executable, directory] = values;
  assert.ok(Object.hasOwn(LIMITS, scenario), 'Unknown smoke scenario');
  assert.ok(path.isAbsolute(executable) && !executable.includes('\0'), 'Absolute executable required');
  if (inside) assert.ok(path.isAbsolute(directory) && !directory.includes('\0'), 'Absolute session directory required');
  return { inside, scenario, executable, directory };
}

export function keyringEnvironment(source, directory, { session = false } = {}) {
  const env = executionEnvironment(source);
  if (!session) delete env.DBUS_SESSION_BUS_ADDRESS;
  return { ...env, HOME: path.join(directory, 'home'), XDG_CONFIG_HOME: path.join(directory, 'config'),
    XDG_DATA_HOME: path.join(directory, 'data'), XDG_RUNTIME_DIR: path.join(directory, 'runtime'),
    XDG_CURRENT_DESKTOP: 'GNOME' };
}

export function servicePid(output) {
  const match = /^\s*uint32 ([1-9][0-9]*)\s*$/mu.exec(output);
  const pid = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(pid) ? pid : null;
}
export function collectionUnlocked(output) {
  return /^\s*variant\s+boolean false\s*$/mu.test(output);
}

// The password has one destination: the daemon's stdin. It is never returned,
// logged, placed in arguments/environment, or written to a password file.
export async function withUnlockedKeyring({ start, ready, run, stop }) {
  const password = Buffer.from(randomBytes(32).toString('hex'), 'ascii');
  let daemon;
  try {
    daemon = start();
    await new Promise((resolve, reject) => {
      daemon.stdin.once('error', reject);
      daemon.stdin.end(password, error => error ? reject(error) : resolve());
    });
    password.fill(0);
    await ready(daemon);
    return await run();
  } finally {
    password.fill(0);
    if (daemon) await stop(daemon);
  }
}

function launch(executable, args, env, stdio) {
  const child = spawn(executable, args, { cwd: ROOT, env, stdio, detached: false });
  child.result = new Promise(resolve => {
    child.once('error', () => resolve({ code: null, error: true }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return child;
}
async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  let timer;
  const exited = await Promise.race([child.result.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
  clearTimeout(timer);
  if (exited) return;
  child.kill('SIGKILL');
  const killed = await Promise.race([child.result.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
  clearTimeout(timer);
  assert.ok(killed, 'Owned fixture process termination unconfirmed; retain temporary data');
}
async function bounded(child, milliseconds, signal) {
  let timer, abort;
  try {
    const interrupted = new Promise(resolve => {
      abort = () => resolve({ code: null, interrupted: true });
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => resolve({ code: null, timedOut: true }), milliseconds);
    });
    const result = await Promise.race([child.result, interrupted]);
    if (result.interrupted || result.timedOut) await stop(child);
    assert.ok(!result.interrupted && !result.timedOut && !result.error, 'Linux keyring fixture interrupted, timed out or could not start');
    return result.code;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
async function checkedDirectory(directory, parent) {
  const stat = await fs.lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && await fs.realpath(directory) === directory,
    'Redirected fixture directory refused');
  assert.equal(path.dirname(directory), parent);
  assert.match(path.basename(directory), /^openaster-keyring-[A-Za-z0-9]+$/u);
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o077, 0, 'Fixture directory must be private');
  return stat;
}
function probe(env, args) {
  const result = spawnSync('/usr/bin/dbus-send', ['--session', '--type=method_call', '--print-reply', '--reply-timeout=1000', ...args],
    { env, encoding: 'utf8', timeout: 1500, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 && !result.error ? result.stdout : '';
}
async function waitReady(daemon, env, signal) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !signal.aborted) {
    assert.ok(daemon.pid && daemon.exitCode === null && daemon.signalCode === null, 'Keyring daemon exited before readiness');
    // Asking the bus for the owner does not auto-activate a second keyring.
    const owner = probe(env, ['--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus.GetConnectionUnixProcessID', 'string:org.freedesktop.secrets']);
    const pid = servicePid(owner);
    if (pid !== null) {
      assert.equal(pid, daemon.pid, 'Secret Service is not the fixture daemon');
      const locked = probe(env, ['--dest=org.freedesktop.secrets', '/org/freedesktop/secrets/collection/login',
        'org.freedesktop.DBus.Properties.Get', 'string:org.freedesktop.Secret.Collection', 'string:Locked']);
      if (collectionUnlocked(locked)) return;
    }
    await pause(100);
  }
  throw new Error('Private Secret Service did not become unlocked within its preparation deadline');
}

export async function main(args = process.argv.slice(2)) {
  const requested = invocation(args);
  assert.equal(process.platform, 'linux', 'Linux CI fixture only');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.env.GITHUB_REPOSITORY, 'yanghaitao1995/OpenAster');
  assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP));
  const parent = await fs.realpath(process.env.RUNNER_TEMP);
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  let directory = requested.directory, identity, completed = false;
  try {
    if (!requested.inside) {
      directory = await fs.mkdtemp(path.join(parent, 'openaster-keyring-'));
      await fs.chmod(directory, 0o700);
      identity = await checkedDirectory(directory, parent);
      for (const name of ['home', 'config', 'data', 'runtime']) await fs.mkdir(path.join(directory, name), { mode: 0o700 });
      const env = { ...keyringEnvironment(process.env, directory), GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
        GITHUB_REPOSITORY: 'yanghaitao1995/OpenAster', RUNNER_TEMP: parent };
      const bus = launch('/usr/bin/dbus-run-session', ['--', process.execPath, SELF, '--session', requested.scenario, requested.executable, directory], env, 'inherit');
      try {
        const code = await bounded(bus, LIMITS[requested.scenario] + 5000, controller.signal);
        assert.equal(code, 0, 'Private Linux keyring smoke failed');
        completed = true;
      } finally { await stop(bus); }
    } else {
      await checkedDirectory(directory, parent);
      assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS?.startsWith('unix:'), 'Private session bus missing');
      const env = keyringEnvironment(process.env, directory, { session: true });
      const control = path.join(directory, 'runtime', 'keyring'); await fs.mkdir(control, { mode: 0o700 });
      const script = requested.scenario === 'relaunch' ? 'desktop-relaunch-smoke.mjs' : 'desktop-smoke.mjs';
      const deadline = setTimeout(cancel, LIMITS[requested.scenario]);
      try {
        await withUnlockedKeyring({
          start: () => launch('/usr/bin/gnome-keyring-daemon', ['--foreground', '--unlock', '--components=secrets', '--control-directory', control], env, ['pipe', 'ignore', 'ignore']),
          ready: daemon => waitReady(daemon, env, controller.signal),
          run: async () => {
            assert.equal(controller.signal.aborted, false, 'Fixture deadline elapsed before smoke');
            const smoke = launch(process.execPath, [path.join(ROOT, 'scripts', script), requested.executable, '--software-rendering',
              ...(requested.scenario === 'backup' ? ['--backup'] : [])], env, 'inherit');
            try { assert.equal(await bounded(smoke, LIMITS[requested.scenario], controller.signal), 0, 'Installed Linux smoke failed'); }
            finally { await stop(smoke); }
          },
          stop,
        });
      } finally { clearTimeout(deadline); }
    }
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    // A forced/failed run may leave app descendants until the verifier reaps its
    // process group. Retain its private directory rather than claim safe cleanup.
    if (!requested.inside && directory && completed) {
      const current = await checkedDirectory(directory, parent);
      assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
      await fs.rm(directory, { recursive: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try { await main(); }
  catch (error) {
    // Do not publish raw process output, environment values or daemon internals.
    console.error('Linux keyring fixture failed: ' + (error instanceof assert.AssertionError ? error.message.split('\n')[0] : error.message));
    process.exitCode = 1;
  }
}
