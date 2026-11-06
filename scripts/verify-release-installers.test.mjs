// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ARTIFACTS, RELEASE_COMMIT, assertDownloadURL, verifyArtifactFile, assertHostedRunner, executionEnvironment } from './verify-release-installers.mjs';

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
