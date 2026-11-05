// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createComputerWorkspace } from '../core/computer-workspace.mjs';
import { createWorkspace } from '../core/workspace.mjs';

test('protected computer directories cannot be reached through Windows short path aliases', { skip: process.platform !== 'win32' }, async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-alias-review-'));
  const workspace = path.join(root, 'project'), protectedDirectory = path.join(root, 'Application Private Directory');
  await fs.mkdir(workspace); await fs.mkdir(protectedDirectory);
  await fs.writeFile(path.join(protectedDirectory, 'marker.txt'), 'private fixture marker');
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), parent); assert.ok(path.basename(root).startsWith('openaster-alias-review-')); await fs.rm(root, { recursive: true, force: true }); });
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `for %I in ("${protectedDirectory}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 5000 });
  assert.equal(result.status, 0); const alias = result.stdout.trim();
  if (path.resolve(alias).toLowerCase() === path.resolve(protectedDirectory).toLowerCase()) { t.skip('This volume does not expose 8.3 aliases'); return; }
  assert.equal((await fs.realpath(alias)).toLowerCase(), protectedDirectory.toLowerCase());
  const adapter = createComputerWorkspace({ workspace: createWorkspace(workspace), getFileAccess: () => 'computer', protectedRoots: [protectedDirectory] });
  await assert.rejects(adapter.read(path.join(protectedDirectory, 'marker.txt')), { code: 'PROTECTED_PATH' });
  await assert.rejects(adapter.read(path.join(alias, 'marker.txt')), error => ['PROTECTED_PATH', 'PROTECTED_WORKSPACE', 'UNSAFE_PATH'].includes(error.code));
  await assert.rejects(adapter.list({ path: alias }), error => ['PROTECTED_PATH', 'UNSAFE_PATH'].includes(error.code));
  await assert.rejects(adapter.commandDirectory(alias), error => ['PROTECTED_PATH', 'UNSAFE_PATH'].includes(error.code));
  await assert.rejects(adapter.prepareWrite({ path: path.join(alias, 'new.txt'), content: 'must not be prepared' }), error => ['PROTECTED_PATH', 'UNSAFE_PATH'].includes(error.code));
  await assert.rejects(fs.stat(path.join(protectedDirectory, 'new.txt')), { code: 'ENOENT' });
  const aliasedProtection = createComputerWorkspace({ workspace: createWorkspace(workspace), getFileAccess: () => 'computer', protectedRoots: [alias] });
  await assert.rejects(aliasedProtection.search('private fixture marker', { path: root }), { code: 'SEARCH_SCOPE_REQUIRED' });
  const listed = await aliasedProtection.list({ path: root });
  assert.ok(!listed.files.some(file => file.path.toLowerCase() === protectedDirectory.toLowerCase()));
});
