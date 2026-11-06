// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareReadOnlyCommand } from '../core/read-only-command.mjs';
import { createCommandRunner, commandEnvironment } from '../core/command-runner.mjs';
import { createWorkspace } from '../core/workspace.mjs';

const windows = process.platform === 'win32';
const command = value => ({ command: value, cwd: '', timeoutMs: 5000, shell: windows ? 'powershell' : 'sh' });
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-readonly-'));
  const stat = await fs.lstat(root, { bigint: true });
  await fs.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
  await fs.mkdir(path.join(root, '.git', 'refs'));
  await fs.writeFile(path.join(root, '.git', 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const workspace = createWorkspace(root), directory = await workspace.commandDirectory();
  t.after(async () => { const current = await fs.lstat(root, { bigint: true }); assert.equal(path.dirname(await fs.realpath(root)), parent); assert.equal(current.dev, stat.dev); assert.equal(current.ino, stat.ino); await fs.rm(root, { recursive: true }); });
  return { root, workspace, options: { root, directory }, config: path.join(root, '.git', 'config') };
}

test('read-only catalog is exact; arbitrary parameters, wrappers and absolute cwd never become fixed plans', async t => {
  const f = await fixture(t);
  for (const text of ['git status --short --branch', 'git diff --output=result', 'git status; echo x', 'git -c core.fsmonitor=x status', 'npm test']) assert.equal(await prepareReadOnlyCommand(command(text), f.options), null, text);
  assert.equal(await prepareReadOnlyCommand({ ...command('git status'), cwd: f.root }, f.options), null);
  const pwd = await prepareReadOnlyCommand(command(windows ? 'Get-Location' : 'pwd'), f.options);
  assert.ok(pwd); await pwd.verify();
  if (windows) assert.equal(pwd.command, 'Microsoft.PowerShell.Management\\Get-Location');
});

test('Git view plan disables global/system configuration, hooks, pager, fsmonitor, external diff and text conversion', async t => {
  const f = await fixture(t), plan = await prepareReadOnlyCommand(command('git diff'), f.options);
  assert.ok(plan, 'Git must be installed for the local Git query feature');
  assert.equal(plan.environment.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(plan.environment.GIT_CONFIG_GLOBAL, windows ? 'NUL' : '/dev/null');
  assert.equal(plan.environment.GIT_DIR, path.join(f.root, '.git'));
  assert.equal(plan.environment.GIT_WORK_TREE, f.root);
  for (const flag of ['core.fsmonitor=false', 'core.hooksPath=', '--no-pager', '--no-ext-diff', '--no-textconv', 'protocol.allow=never']) assert.ok(plan.command.includes(flag), flag);
  assert.equal(plan.environment.GIT_NO_LAZY_FETCH, '1');
  await plan.verify();
});

test('Git configurations with includes, filters, extensions, escapes and external metadata require once approval', async t => {
  const f = await fixture(t), base = await fs.readFile(f.config, 'utf8');
  for (const unsafe of ['[include]\npath = /tmp/private\n', '[includeIf "gitdir:x"]\npath = other\n', '[filter "demo"]\nclean = node bad.js\n', '[extensions]\nworktreeConfig = true\n', '[core]\nfsmonitor = bad\\ command\n']) {
    await fs.writeFile(f.config, base + unsafe);
    assert.equal(await prepareReadOnlyCommand(command('git status'), f.options), null, unsafe.split('\n')[0]);
  }
  await fs.writeFile(f.config, base);
  for (const file of ['commondir', 'config.worktree']) {
    await fs.writeFile(path.join(f.root, '.git', file), '../outside');
    assert.equal(await prepareReadOnlyCommand(command('git status'), f.options), null);
    await fs.unlink(path.join(f.root, '.git', file));
  }
});

test('Git plan revalidates config bytes before execution and ignores no later replacement', async t => {
  const f = await fixture(t), plan = await prepareReadOnlyCommand(command('git status'), f.options);
  assert.ok(plan); await plan.verify();
  await fs.appendFile(f.config, '\n[core]\nfsmonitor = node bad.js\n');
  await assert.rejects(plan.verify(), { code: 'COMMAND_READ_ONLY_CHANGED' });
});

test('Git lookup never discovers a parent repository outside the chosen workspace', async t => {
  const f = await fixture(t), child = path.join(f.root, 'child'); await fs.mkdir(child);
  const workspace = createWorkspace(child);
  assert.equal(await prepareReadOnlyCommand(command('git status'), { root: child, directory: await workspace.commandDirectory() }), null);
});

test('a real fixed Git status cannot execute a configured fsmonitor hook', { timeout: 45000 }, async t => {
  const f = await fixture(t), plan = await prepareReadOnlyCommand(command('git --version'), f.options);
  assert.ok(plan);
  // Extract only the resolved executable from the trusted plan generated above.
  const match = plan.command.match(windows ? /^& '((?:[^']|'')+)'/u : /^'((?:[^']|'\\'')+)'/u);
  assert.ok(match); const executable = windows ? match[1].replaceAll("''", "'") : match[1].replaceAll("'\\''", "'");
  await fs.writeFile(path.join(f.root, 'tracked.txt'), 'before\n');
  const setupStarted = performance.now();
  const added = spawnSync(executable, ['add', 'tracked.txt'], { cwd: f.root, env: { ...commandEnvironment(), ...plan.environment }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  t.diagnostic(JSON.stringify({ phase: 'owned-git-setup', exitCode: added.status, durationMs: Math.round(performance.now() - setupStarted),
    timedOut: added.error?.code === 'ETIMEDOUT', stdoutBytes: Buffer.byteLength(added.stdout ?? ''), stderrBytes: Buffer.byteLength(added.stderr ?? '') }));
  assert.equal(added.status, 0, added.stderr);
  await fs.writeFile(path.join(f.root, 'hook.cjs'), "require('node:fs').writeFileSync('hook-ran.txt','unexpected'); process.stdout.write('token\\n');\n");
  await fs.appendFile(f.config, '\n[core]\nfsmonitor = node hook.cjs\n');
  await fs.writeFile(path.join(f.root, 'tracked.txt'), 'after\n');
  const runner = createCommandRunner({ workspace: f.workspace }), proposal = await runner.prepare({ command: 'git status --short', timeoutMs: 10000 });
  assert.equal(runner.describe(proposal).readOnly, true);
  const executionStarted = performance.now();
  let readyCount = 0, readyElapsedMs = null;
  const result = await runner.execute(proposal, { readOnly: true, onStarted: () => { readyCount++; readyElapsedMs = Math.round(performance.now() - executionStarted); } });
  // Record bounded process facts only: no environment, paths, command text or
  // arbitrary stderr. An empty exit code alone cannot distinguish startup delay.
  t.diagnostic(JSON.stringify({ phase: 'fixed-git-status', readyCount, readyElapsedMs, durationMs: result.durationMs,
    elapsedMs: Math.round(performance.now() - executionStarted), exitCode: result.exitCode, timedOut: result.timedOut,
    cancelled: result.cancelled, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), truncated: result.truncated }));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /tracked\.txt/u);
  await assert.rejects(fs.stat(path.join(f.root, 'hook-ran.txt')), { code: 'ENOENT' });
});
