// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Writable } from 'node:stream';
import { invocation, keyringEnvironment, servicePid, collectionUnlocked, withUnlockedKeyring } from './linux-keyring-session.mjs';
import { executionEnvironment, confirmOwnedUnixGroupStopped } from './verify-release-installers.mjs';

test('keyring fixture accepts only fixed scenarios and absolute executable/session paths', () => {
  const executable = path.resolve('fixture-only'), directory = path.resolve('session-only');
  assert.deepEqual(invocation(['basic', executable]), { inside: false, scenario: 'basic', executable, directory: undefined });
  assert.equal(invocation(['--session', 'relaunch', executable, directory]).inside, true);
  for (const args of [[], ['shell', executable], ['backup', 'relative'], ['basic', executable, 'extra'],
    ['--session', 'basic', executable, 'relative'], ['basic', executable + '\0'], ['constructor', executable]]) {
    assert.throws(() => invocation(args));
  }
});

test('fresh keyring sessions isolate home and bus without forwarding credentials or hooks', () => {
  const directory = path.resolve('fixture-only');
  const source = { HOME: '/real-home', XDG_CONFIG_HOME: '/real-config', XDG_DATA_HOME: '/real-data', XDG_RUNTIME_DIR: '/real-runtime',
    XDG_CURRENT_DESKTOP: 'KDE', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/real-bus', GNOME_KEYRING_CONTROL: '/real-keyring',
    GITHUB_TOKEN: 'synthetic-secret', RUNNER_TEMP: '/fixture', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1',
    DISPLAY: ':99', XAUTHORITY: '/test-display-cookie', PATH: '/usr/bin', PRIVATE_PROVIDER_KEY: 'synthetic-secret' };
  const env = keyringEnvironment(source, directory);
  assert.equal(env.HOME, path.join(directory, 'home')); assert.equal(env.XDG_CONFIG_HOME, path.join(directory, 'config'));
  assert.equal(env.XDG_DATA_HOME, path.join(directory, 'data')); assert.equal(env.XDG_RUNTIME_DIR, path.join(directory, 'runtime'));
  assert.equal(env.XDG_CURRENT_DESKTOP, 'GNOME'); assert.equal(env.DISPLAY, ':99'); assert.equal(env.PATH, '/usr/bin');
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL', 'GITHUB_TOKEN', 'RUNNER_TEMP', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PRIVATE_PROVIDER_KEY']) assert.equal(env[name], undefined);
  const inner = keyringEnvironment({ ...source, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/new-bus' }, directory, { session: true });
  assert.equal(inner.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/new-bus');
  assert.equal(executionEnvironment(env).XDG_CURRENT_DESKTOP, 'GNOME');
});

test('keyring readiness requires actual daemon owner and explicitly unlocked collection replies', () => {
  assert.equal(servicePid('method return sender=org.freedesktop.DBus\n   uint32 417\n'), 417);
  for (const text of ['', 'uint32 0', 'uint32 -1', 'string "417"', 'uint32 99999999999999999']) assert.equal(servicePid(text), null);
  assert.equal(collectionUnlocked('method return\n   variant       boolean false\n'), true);
  for (const text of ['', 'variant boolean true', 'string "false"', 'boolean false']) assert.equal(collectionUnlocked(text), false);
});

function daemonFixture() {
  const chunks = [];
  const stdin = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  return { daemon: { stdin }, chunks };
}
test('a fresh nonempty random password goes only to stdin and smoke waits for readiness', async () => {
  const passwords = [];
  for (let index = 0; index < 2; index++) {
    const { daemon, chunks } = daemonFixture(), order = [];
    const result = await withUnlockedKeyring({
      start: (...args) => { assert.equal(args.length, 0); order.push('start'); return daemon; },
      ready: async seen => { assert.equal(seen, daemon); assert.equal(daemon.stdin.writableFinished, true); order.push('ready'); },
      run: async (...args) => { assert.equal(args.length, 0); order.push('run'); return 42; },
      stop: async seen => { assert.equal(seen, daemon); order.push('stop'); },
    });
    assert.equal(result, 42); assert.deepEqual(order, ['start', 'ready', 'run', 'stop']);
    const password = Buffer.concat(chunks).toString('ascii');
    assert.match(password, /^[a-f0-9]{64}$/u); passwords.push(password);
  }
  assert.notEqual(passwords[0], passwords[1]);
});

test('readiness failure never launches smoke and always stops the owned daemon', async () => {
  const { daemon } = daemonFixture(), calls = [];
  await assert.rejects(withUnlockedKeyring({ start: () => daemon,
    ready: async () => { calls.push('ready'); throw new Error('unavailable'); },
    run: async () => { calls.push('run'); }, stop: async () => { calls.push('stop'); } }), /unavailable/u);
  assert.deepEqual(calls, ['ready', 'stop']);
});

test('smoke failures and broken password pipes stop the daemon and retain failure', async () => {
  const { daemon } = daemonFixture(); let stopped = 0;
  await assert.rejects(withUnlockedKeyring({ start: () => daemon, ready: async () => {},
    run: async () => { throw new Error('smoke failed'); }, stop: async () => { stopped++; } }), /smoke failed/u);
  assert.equal(stopped, 1);
  const broken = { stdin: new Writable({ write(_chunk, _encoding, callback) { callback(new Error('closed pipe')); } }) };
  await assert.rejects(withUnlockedKeyring({ start: () => broken, ready: async () => assert.fail('not ready'),
    run: async () => assert.fail('not run'), stop: async () => { stopped++; } }), /closed pipe/u);
  assert.equal(stopped, 2);
});

test('daemon cleanup failure cannot promote a successful smoke to pass', async () => {
  const { daemon } = daemonFixture();
  await assert.rejects(withUnlockedKeyring({ start: () => daemon, ready: async () => {}, run: async () => 0,
    stop: async () => { throw new Error('termination unconfirmed'); } }), /termination unconfirmed/u);
});

test('owned group teardown waits for disappearance and reports persistent or inaccessible groups', async () => {
  let elapsed = 0, calls = 0;
  const options = { now: () => elapsed, pause: async milliseconds => { elapsed += milliseconds; } };
  const gone = await confirmOwnedUnixGroupStopped(417, { ...options, signal: (pid, signal) => {
    assert.equal(pid, -417); assert.equal(signal, 0);
    if (++calls === 3) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  } });
  assert.deepEqual(gone, { confirmed: true }); assert.equal(elapsed, 100);
  elapsed = 0;
  assert.deepEqual(await confirmOwnedUnixGroupStopped(417, { ...options, signal: () => {} }), { confirmed: false });
  assert.equal(elapsed, 2000);
  assert.deepEqual(await confirmOwnedUnixGroupStopped(417, { ...options, signal: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }),
    { confirmed: false, errorCode: 'EPERM' });
  await assert.rejects(confirmOwnedUnixGroupStopped(0), /Invalid owned/u);
});
