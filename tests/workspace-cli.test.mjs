// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { APP_VERSION } from '../core/app-version.mjs';

test('the actual CLI entry point starts a healthy isolated workspace host without a top-level import cycle', { timeout: 20000 }, async t => {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-workspace-cli-'));
  const identity = await fs.lstat(root, { bigint: true }), owner = randomUUID();
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  const workspace = path.join(root, 'workspace'), environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith('OPENASTER_') || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete environment[key];
  Object.assign(environment, { PORT: '0', OPENASTER_DATA_DIR: path.join(root, 'data'), OPENASTER_WORKSPACE: workspace, OPENASTER_PROJECTS_ROOT: path.join(root, 'projects'), USERPROFILE: root, HOME: root });
  let child, exited = false, exit, readinessTimer, output = '', errors = '';
  t.after(async () => {
    clearTimeout(readinessTimer);
    if (child && !exited) child.kill('SIGTERM');
    if (exit) { let deadline; try { await Promise.race([exit, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Owned CLI child failed to exit')), 5000); })]); } finally { clearTimeout(deadline); } }
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), parent); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.equal(current.isSymbolicLink(), false); assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner);
    await fs.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 });
  });
  const url = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.resolve('server/index.mjs')], { cwd: path.resolve('.'), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    exit = new Promise(done => child.once('close', (code, signal) => { exited = true; clearTimeout(readinessTimer); done({ code, signal }); reject(new Error(`CLI exited before health verification: ${code}; ${errors.slice(-2000)}`)); }));
    child.once('error', reject);
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8192); });
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); const found = output.match(/OpenAster [^\r\n]+ — (http:\/\/127\.0\.0\.1:\d+)/u); if (found) { clearTimeout(readinessTimer); resolve(found[1]); } });
    readinessTimer = setTimeout(() => reject(new Error(`CLI did not become ready: ${errors.slice(-2000)}`)), 10000);
  });
  const healthResponse = await fetch(url + '/api/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(healthResponse.status, 200); assert.deepEqual(await healthResponse.json(), { ok: true, version: APP_VERSION });
  const bootstrapResponse = await fetch(url + '/api/bootstrap', { signal: AbortSignal.timeout(5000) });
  assert.equal(bootstrapResponse.status, 200); const state = await bootstrapResponse.json();
  assert.equal(state.workspace.path, workspace); assert.equal(state.capabilities.workspaceManagement, 1); assert.equal(state.security.webAccess, false);
  assert.doesNotMatch(errors, /unsettled top-level await|Detected unsettled/u); assert.equal(exited, false);
});
