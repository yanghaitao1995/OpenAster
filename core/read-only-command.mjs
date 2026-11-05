// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CoreError, checkAbort } from './errors.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const inside = (root, value) => { const relative = path.relative(root, value); return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const quote = (value, shell) => shell === 'powershell' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
const identity = async location => {
  const stat = await fs.lstat(location, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular executable/config file');
  return { path: location, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
};
async function executable(name, root) {
  const candidates = process.platform === 'win32'
    ? (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name + '.exe'))
    : name === 'git' ? ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'] : [`/bin/${name}`, `/usr/bin/${name}`];
  for (const candidate of candidates) {
    try {
      if (!path.isAbsolute(candidate)) continue;
      const actual = await fs.realpath(candidate);
      if (inside(root, actual)) continue;
      const stamp = await identity(actual);
      await fs.access(actual, constants.X_OK);
      return stamp;
    } catch { /* Missing or redirected executables are not automatically trusted. */ }
  }
  throw new Error('No fixed executable outside the workspace');
}
async function localGit(root, directory) {
  let repo = directory;
  for (;;) {
    const git = path.join(repo, '.git');
    try {
      const stat = await fs.lstat(git, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(git) !== git) throw new Error('Linked/bare repositories need review');
      const configPath = path.join(git, 'config');
      const configEntry = await fs.lstat(configPath, { bigint: true });
      if (!configEntry.isFile() || configEntry.isSymbolicLink() || configEntry.size > 65536n) throw new Error('Unbounded or redirected repository config');
      const handle = await fs.open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let config;
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size > 65536n || before.dev !== configEntry.dev || before.ino !== configEntry.ino) throw new Error('Unbounded repository config');
        const buffer = Buffer.alloc(Number(before.size) + 1);
        const read = await handle.read(buffer, 0, buffer.length, 0);
        if (read.bytesRead !== Number(before.size)) throw new Error('Repository config changed');
        config = buffer.subarray(0, read.bytesRead);
        const after = await handle.stat({ bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error('Repository config changed');
      } finally { await handle.close(); }
      const configText = new TextDecoder('utf-8', { fatal: true }).decode(config);
      // Git config includes can read arbitrary outside files; clean/smudge filters
      // can run even in status/diff. Do not try to parse or sanitize those features.
      // Escaped/continued or non-ASCII configs also fall back to exact human review.
      if (/[^\x09\x0a\x0d\x20-\x7e]|\\|\0/u.test(configText)
        || /^\s*\[\s*(?:include|includeif|filter|extensions)\b/imu.test(configText)) throw new Error('Repository requires individual review');
      for (const relative of ['commondir', 'config.worktree', 'objects/info/alternates']) {
        try { await fs.lstat(path.join(git, relative)); throw new Error('Repository uses external metadata'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const dirs = [];
      for (const relative of ['objects', 'refs']) {
        const location = path.join(git, relative), entry = await fs.lstat(location, { bigint: true });
        if (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(location) !== location) throw new Error('Repository metadata redirected');
        dirs.push({ path: location, dev: String(entry.dev), ino: String(entry.ino) });
      }
      return { repo, git, dev: String(stat.dev), ino: String(stat.ino), config: digest(config), configIdentity: await identity(configPath), dirs };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (repo === root) throw error;
      const parent = path.dirname(repo);
      if (!inside(root, parent) || parent === repo) throw error;
      repo = parent;
    }
  }
}

const GIT_QUERIES = new Map([
  ['git status', ['status', '--short', '--untracked-files=normal', '--ignore-submodules=all']],
  ['git status --short', ['status', '--short', '--untracked-files=normal', '--ignore-submodules=all']],
  ['git status --porcelain', ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=all']],
  ['git diff', ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--']],
  ['git diff --stat', ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--stat', '--']],
  ['git diff --cached', ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--']],
  ['git log -5 --oneline', ['log', '-5', '--oneline', '--no-show-signature', '--no-decorate', '--']],
]);
export const isReadOnlyCandidate = proposal => GIT_QUERIES.has(proposal.command) || proposal.command === 'git --version' || (proposal.shell === 'powershell'
  ? ['pwd', 'Get-Location', 'Get-ChildItem -Name', 'Get-ChildItem -Force -Name'].includes(proposal.command)
  : ['pwd', 'ls', 'ls -la'].includes(proposal.command));

/** A fixed execution plan, never an interpreted user-defined command pattern. */
export async function prepareReadOnlyCommand(proposal, { root, directory, signal } = {}) {
  checkAbort(signal);
  if (!root || !directory?.canonical || path.isAbsolute(proposal.cwd) || /^[A-Za-z]:/u.test(proposal.cwd) || !inside(root, directory.canonical)) return null;
  try {
    let command, stamp = null, repository = null, environment = {};
    const label = proposal.command;
    if (proposal.shell === 'powershell') {
      command = new Map([
        ['pwd', 'Microsoft.PowerShell.Management\\Get-Location'],
        ['Get-Location', 'Microsoft.PowerShell.Management\\Get-Location'],
        ['Get-ChildItem -Name', 'Microsoft.PowerShell.Management\\Get-ChildItem -LiteralPath . -Name'],
        ['Get-ChildItem -Force -Name', 'Microsoft.PowerShell.Management\\Get-ChildItem -LiteralPath . -Force -Name'],
      ]).get(label);
    } else if (['pwd', 'ls', 'ls -la'].includes(label)) {
      stamp = await executable(label === 'pwd' ? 'pwd' : 'ls', root);
      command = `${quote(stamp.path, proposal.shell)}${label === 'ls -la' ? ' -la' : ''}`;
    }
    if (!command && (GIT_QUERIES.has(label) || label === 'git --version')) {
      stamp = await executable('git', root);
      const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
      environment = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: nullFile, GIT_CONFIG_GLOBAL: nullFile, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1', GIT_PAGER: '', GIT_CONFIG_COUNT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
      const args = label === 'git --version' ? ['--version'] : (() => {
        return ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${nullFile}`, '-c', 'core.pager=', '-c', 'core.attributesFile=', '-c', 'core.excludesFile=', '-c', 'core.preloadIndex=false', '-c', 'diff.external=', '-c', 'interactive.diffFilter=', '-c', 'log.showSignature=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', ...GIT_QUERIES.get(label)];
      })();
      if (label !== 'git --version') {
        repository = await localGit(root, directory.canonical);
        environment.GIT_DIR = repository.git; environment.GIT_WORK_TREE = repository.repo;
      }
      command = `${proposal.shell === 'powershell' ? '& ' : ''}${quote(stamp.path, proposal.shell)} ${args.map(arg => quote(arg, proposal.shell)).join(' ')}`;
    }
    if (!command) return null;
    checkAbort(signal);
    const expected = JSON.stringify({ stamp, repository });
    return Object.freeze({ command, environment: Object.freeze(environment), label,
      async verify() {
        try {
          checkAbort(signal);
          const actual = { stamp: stamp ? await identity(stamp.path) : null, repository: repository ? await localGit(root, directory.canonical) : null };
          if (JSON.stringify(actual) !== expected) throw new Error('Read-only command changed');
        } catch { checkAbort(signal); throw new CoreError('COMMAND_READ_ONLY_CHANGED', '只读命令的程序或项目配置已变化；命令未执行，请重新审核。', 409); }
      },
    });
  } catch (error) { checkAbort(signal); return null; }
}
