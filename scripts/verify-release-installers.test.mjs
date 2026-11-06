// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ARTIFACTS, RELEASE_COMMIT, assertDownloadURL, verifyArtifactFile, assertHostedRunner, executionEnvironment, acceptanceDiagnostics } from './verify-release-installers.mjs';

test('release assets and source commit are fixed and have no user supplied execution URLs', () => {
  assert.match(RELEASE_COMMIT, /^[a-f0-9]{40}$/u);
  assert.equal(Object.keys(ARTIFACTS).length, 4);
  for (const artifact of Object.values(ARTIFACTS)) {
    assert.match(artifact.file, /^OpenAster-0\.2\.2-[A-Za-z0-9_.-]+$/u);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(artifact.bytes > 100000000 && artifact.bytes < 160000000);
    assert.ok(Object.isFrozen(artifact));
  }
});
test('download redirects reject untrusted hosts, credentials and protocol downgrades', () => {
  for (const value of ['http://github.com/file', 'https://example.com/file', 'https://github.com.evil.invalid/file', 'https://user:secret@github.com/file', 'https://github.com:444/file', 'file:///tmp/x']) assert.throws(() => assertDownloadURL(value));
  for (const host of ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']) assert.equal(assertDownloadURL(`https://${host}/artifact`).hostname, host);
});
test('hash verification refuses substituted or incomplete installer bytes before any execution', async t => {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'openaster-installer-verifier-test-'));
  const identity = await fs.lstat(directory, { bigint: true });
  t.after(async () => {
    const current = await fs.lstat(directory, { bigint: true });
    assert.equal(path.dirname(await fs.realpath(directory)), parent);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
    await fs.rm(directory, { recursive: true });
  });
  const file = path.join(directory, 'fake-installer'), data = Buffer.from('only test data, never an executable');
  const expected = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  await fs.writeFile(file, data);
  assert.deepEqual(await verifyArtifactFile(file, expected), expected);
  await fs.writeFile(file, Buffer.alloc(data.length));
  await assert.rejects(verifyArtifactFile(file, expected), /SHA-256/u);
  await fs.writeFile(file, data.subarray(1));
  await assert.rejects(verifyArtifactFile(file, expected), /size/u);
});
test('installer execution refuses local, self-hosted, wrong repository and wrong architecture environments', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'yanghaitao1995/OpenAster', RUNNER_TEMP: path.resolve(os.tmpdir()) };
  assert.doesNotThrow(() => assertHostedRunner(env, 'win32', 'x64', ARTIFACTS.windows));
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'other/repo' }, { RUNNER_TEMP: 'relative' }]) assert.throws(() => assertHostedRunner({ ...env, ...patch }, 'win32', 'x64', ARTIFACTS.windows));
  assert.throws(() => assertHostedRunner(env, 'darwin', 'x64', ARTIFACTS.macos));
});
test('installed applications do not inherit workflow credentials or Node/Electron hooks', () => {
  const source = { PATH: '/bin', HOME: '/test-home', SystemRoot: 'C:\\Windows', GITHUB_TOKEN: 'fixture', ACTIONS_RUNTIME_TOKEN: 'fixture', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1', PRIVATE_PROVIDER_KEY: 'fixture' };
  assert.deepEqual(executionEnvironment(source), { PATH: '/bin', HOME: '/test-home', SystemRoot: 'C:\\Windows' });
});

test('failure diagnostics retain stage and timeout evidence with bounded, redacted known log tails', async t => {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'openaster-installer-diagnostic-test-'));
  const identity = await fs.lstat(directory, { bigint: true });
  t.after(async () => {
    const current = await fs.lstat(directory, { bigint: true });
    assert.equal(path.dirname(await fs.realpath(directory)), parent);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino);
    await fs.rm(directory, { recursive: true });
  });
  const marker = 'fixture-credential-value';
  const token = `ghp_${'x'.repeat(24)}`;
  const logs = ['01-source-commit.log', '02-install.log', '03-copy.log', '04-installed-smoke.log', '05-cleanup.log'];
  for (const log of logs) await fs.writeFile(path.join(directory, log), `${'ordinary output\n'.repeat(1500)}\u001b[31mFixed failure marker\u001b[0m\nhttps://github.com/fixture?token=${marker}\nAuthorization: Bearer ${marker}\n{"api_key":"${marker}"}\n${token}\n`);
  const receipt = { status: 'failed', version: '0.2.2', sourceCommit: RELEASE_COMMIT, kind: 'windows',
    error: 'installed-smoke failed (1)', cleanupFailed: true,
    steps: logs.map((log, index) => ({ name: log, status: index >= 3 ? 'failed' : 'passed',
      ...(index === 3 ? { error: `Failed after reading https://example.invalid/${marker}` } : {}),
      command: { executable: 'fixture.exe', args: ['must-never-be-printed'], log, code: index === 3 ? 1 : 0,
        signal: null, timedOut: index === 3, durationMs: 100 + index,
        ...(index === 4 ? { termination: { requested: true, cleanupUnconfirmed: true, exitCode: 1 } } : {}) } })) };
  receipt.steps.push({ name: 'invalid-log-name', status: 'failed', command: { log: '../outside.log' } });
  const before = JSON.stringify(receipt);
  const events = await acceptanceDiagnostics(receipt, directory), serialized = JSON.stringify(events);
  assert.equal(JSON.stringify(receipt), before);
  const summary = events[0];
  assert.equal(summary.status, 'failed'); assert.equal(summary.cleanupFailed, true);
  assert.equal(summary.steps[3].command.code, 1); assert.equal(summary.steps[3].command.timedOut, true);
  assert.equal(summary.steps[3].command.durationMs, 103);
  assert.equal(summary.steps[4].command.termination.cleanupUnconfirmed, true);
  assert.equal(events.length, 5); assert.equal(events[1].log, '05-cleanup.log');
  for (const event of events.slice(1)) {
    assert.ok(event.tail.length <= 8000 && event.tail.split('\n').length <= 80);
    assert.ok(event.fileBytes > 16384); assert.match(event.tail, /Fixed failure marker/u);
  }
  for (const forbidden of [marker, token, 'https://', 'must-never-be-printed', '../outside.log', '\u001b']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.match(serialized, /redacted URL/u); assert.match(serialized, /redacted credential/u);
  assert.ok(serialized.length < 40000);
});

test('diagnostic read failures and passed receipts do not replace acceptance results', async () => {
  const failed = { status: 'failed', kind: 'deb', steps: [{ name: 'install', status: 'failed', command: { log: '01-missing.log', code: 2, timedOut: false, spawnError: 'ENOENT' } }] };
  const events = await acceptanceDiagnostics(failed, path.join(os.tmpdir(), 'openaster-no-such-evidence-fixture'));
  assert.equal(events[0].steps[0].command.spawnError, 'ENOENT');
  assert.equal(events[1].readError, 'ENOENT'); assert.equal(failed.status, 'failed');
  const passed = await acceptanceDiagnostics({ ...failed, status: 'passed' }, 'unused-evidence-path');
  assert.equal(passed.length, 1); assert.equal(passed[0].status, 'passed');
});
