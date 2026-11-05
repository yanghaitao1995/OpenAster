// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { acquireDataLock } from '../server/lock.mjs';

test('data lock rejects linked or non-file SQLite sidecars before opening the database', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openaster-lock-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), tmpdir());
    assert.ok(path.basename(directory).startsWith('openaster-lock-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const external = path.join(directory, 'unrelated.txt');
  await writeFile(external, 'This content must remain unchanged.');
  for (const [index, suffix] of ['', '-journal', '-wal', '-shm'].entries()) {
    const data = path.join(directory, `linked-${index}`);
    await mkdir(data);
    await link(external, path.join(data, `.instance.sqlite${suffix}`));
    await assert.rejects(acquireDataLock(data), { code: 'UNSAFE_DATA_DIR', status: 403 });
    assert.equal(await readFile(external, 'utf8'), 'This content must remain unchanged.');
  }
  const data = path.join(directory, 'directory-sidecar');
  await mkdir(path.join(data, '.instance.sqlite-journal'), { recursive: true });
  await assert.rejects(acquireDataLock(data), { code: 'UNSAFE_DATA_DIR' });
});
