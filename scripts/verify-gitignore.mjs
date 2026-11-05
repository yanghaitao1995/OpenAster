// SPDX-License-Identifier: Apache-2.0
// Git is a development oracle only. The application never imports this script.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(import.meta.dirname, '..');
const DEFAULT_SEED = 0x47a91c03;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = ['core/workspace-ignore.mjs', 'scripts/verify-gitignore.mjs', 'tests/gitignore-conformance.test.mjs'];

function baseEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANG: 'C' };
}
export function probeGit() {
  const result = spawnSync('git', ['--version'], { env: baseEnvironment(), windowsHide: true, timeout: 15000, maxBuffer: 16384, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return { available: false, reason: 'Git executable is not installed or not on PATH.' };
  if (result.error || result.status !== 0) throw new Error('Git version probe failed', { cause: result.error ?? new Error(result.stderr) });
  return { available: true, version: result.stdout.trim() };
}
const file = (name, directory = false) => ({ path: name, directory });
function group(name, content, names, nested = []) {
  return { name, ignores: [{ base: '', content }, ...nested], probes: names.map(value => typeof value === 'string' ? file(value) : value) };
}

export function createConformanceFixtures({ seed = DEFAULT_SEED, fuzzGroups = 24 } = {}) {
  assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff);
  assert.ok(Number.isSafeInteger(fuzzGroups) && fuzzGroups >= 0 && fuzzGroups <= 64);
  const basename = ['a', 'b', 'c', 'z', 'A', '0', '5', '9', '-', ']', '!', '#', ' ', 'a ', 'ab', 'aa', 'bb', 'a.txt', 'b.log', 'file7', 'é', '中', '🙂', 'sub/a', 'sub/b', 'sub/ab'];
  const groups = [
    group('comments-escaped-markers-spaces', '# comment\n\\#literal\n\\!literal\nplain \nescaped\\ \n!plain\n', ['#literal', '!literal', 'plain', 'plain ', 'escaped', 'escaped ', 'comment', 'sub/#literal']),
    group('bom-crlf-last-wins', '\uFEFF# first\r\n*.tmp\r\n!keep.tmp\r\nkeep.tmp\r\n!last.tmp\r\n', ['a.tmp', 'keep.tmp', 'last.tmp', 'a.TMP', 'deep/a.tmp', 'deep/last.tmp']),
    group('leading-slash-anchoring', '/root.txt\n/x/y\n', ['root.txt', 'sub/root.txt', 'x/y', 'sub/x/y', 'x/y.txt']),
    group('slash-relative', 'one/two\n', ['one/two', 'x/one/two', 'one/three', 'one/deep/two']),
    group('directory-rule', 'cache/\n!cache/keep.txt\n', [file('cache', true), 'cache/keep.txt', 'cache/deep/file', 'nested/cache/child', 'cache.txt']),
    group('file-rule-without-directory', 'cache/\n', ['cache', 'cache.txt', 'nested/cache']),
    group('parent-exclusion-cannot-reinclude-child', 'blocked\n!blocked/keep.txt\n', ['blocked/keep.txt', 'blocked/other.txt', 'open/keep.txt'], [{ base: 'blocked', content: '!keep.txt\n' }]),
    group('unexclude-parent-before-child', 'blocked/\n!blocked/\nblocked/*\n!blocked/keep.txt\n', ['blocked/keep.txt', 'blocked/other.txt', 'blocked/deep/keep.txt']),
    group('nested-file-relative-precedence', '*.log\n!root.log\n', ['root.log', 'sub/root.log', 'sub/keep.log', 'sub/drop.log', 'sub/deep/keep.log', 'sub/deep/drop.log'], [
      { base: 'sub', content: '!keep.log\n/root.log\n' }, { base: 'sub/deep', content: '*.log\n!drop.log\n' },
    ]),
    group('nested-anchoring-and-parent-pruning', '/top\nsub/private/\n', ['top/keep', 'sub/top', 'sub/private/keep', 'sub/public/keep', 'sub/deep/top'], [{ base: 'sub', content: '/top\n!private/keep\n' }]),
    group('double-star-leading', '**/target\n', ['target', 'a/target', 'a/b/target', 'a/not-target', 'target.txt']),
    group('double-star-trailing', 'tree/**\n!tree/keep\n', [file('tree', true), 'tree/keep', 'tree/child', 'tree/deep/keep', 'other/tree/child']),
    group('double-star-middle', 'a/**/b\n', ['a/b', 'a/x/b', 'a/x/y/b', 'x/a/b', 'a/xxb']),
    group('triple-star-middle', 'a/***/b\n', ['a/b', 'a/x/b', 'a/x/y/b', 'x/a/b']),
    group('non-component-stars', 'a**b\n', ['ab', 'axb', 'axxxb', 'a/x/b', 'a/b', 'x/ab']),
    group('four-star-path', 'a/****/b\n', ['a/b', 'a/x/b', 'a/x/y/b', 'a/xxb']),
    group('single-star-path', 'a/*/b\n', ['a/b', 'a/x/b', 'a/x/y/b']),
    group('escaped-glob', '\\[literal\\]\nq\\?mark\nstar\\*name\n', ['[literal]', 'literal', 'qXmark', 'starXname']),
    group('escaped-slash', 'a\\/b\n', ['a/b', 'aXb', 'x/a/b', 'a/deep/b']),
    group('trailing-space-escapes', ['trimmed ', 'one\\ ', 'two\\\\ ', 'three\\\\\\ ', 'neg ', '!neg '].join('\n') + '\n', ['trimmed', 'trimmed ', 'one', 'one ', 'two', 'two ', 'three', 'three ', 'neg', 'neg ']),
    group('invalid-bracket-and-backslash', '[\n[abc\nabc\\\n[[:bogus:]]\n', ['[', '[abc', 'abc', 'abca', '[b]', 'a', 'b']),
    group('literal-escaped-negation', '\\!keep\n*\n!\\!keep\n', ['!keep', 'keep', 'anything']),
    group('blank-negation-lines', '\n#comment\n!\n/\n', ['a', 'sub/a']),
  ];
  for (const pattern of ['?', '??', '???', '*', '***', '[ab]', '[a-c]', '[a-b-c]', '[c-a]', '[z-a]', '[9-0]', '[a-[:digit:]]', '[[:digit:]-a]', '[a-\\]]', '[!a]', '[^a]', '[]a]', '[-a]', '[a-]', '[\\]]', '[[:digit:]]', '[[:alpha:]]', '[[:alnum:]]', '[[:space:]]', '[[:blank:]]', '[[:lower:]]', '[[:upper:]]', '[[:xdigit:]]', '[[:punct:]]', '[[:cntrl:]]', '[[:graph:]]', '[[:print:]]', '[é]', '[中]', 'é?', '?é']) {
    groups.push(group('single-pattern-' + groups.length, pattern + '\n', basename));
  }
  let state = seed >>> 0;
  const random = () => { state += 0x6D2B79F5; let value = Math.imul(state ^ state >>> 15, 1 | state); value ^= value + Math.imul(value ^ value >>> 7, 61 | value); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
  const choose = values => values[Math.floor(random() * values.length)];
  const tokens = ['a', 'b', '0', 'é', '中', '*', '**', '***', '?', '[ab]', '[a-c]', '[!a]', '[^b]', '[', '[]a]', '[a-]', '[[:digit:]]', '[[:alpha:]]', '[[:bogus:]]', '\\a', '\\!', '\\#'];
  const components = ['a', 'b', 'ab', 'ba', '0', '5', 'é', '中', '🙂', 'a.txt', '!x', '#x'];
  for (let index = 0; index < fuzzGroups; index++) {
    const patterns = [];
    for (let rule = 0; rule < 8; rule++) {
      let pattern = '';
      for (let token = 0, count = 1 + Math.floor(random() * 5); token < count; token++) pattern += choose(tokens);
      if (random() < 0.3) pattern = choose(['**/', 'dir/', 'a/**/', '/']) + pattern;
      if (random() < 0.2) pattern += '/';
      if (random() < 0.25) pattern = '!' + pattern;
      if (random() < 0.1) pattern += '\\';
      patterns.push(pattern);
    }
    // Distinct first components prevent a candidate file from also becoming an
    // ancestor directory in the real Git fixture.
    const names = new Set(['dir/a', 'dir/b', 'dir/ab', 'dir/é', 'dir/中', 'dir/🙂', 'dir/deep/a', 'dir/deep/ab']);
    for (let query = 0; query < 24; query++) names.add(choose(['root/', 'dir/', 'dir/deep/']) + choose(components) + (random() < 0.4 ? choose(components) : ''));
    groups.push(group(`seed-${seed}-group-${index}`, patterns.join('\n') + '\n', [...names]));
  }
  return groups;
}

function safeRelative(value) {
  assert.ok(typeof value === 'string' && value.length <= 512 && value && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0'));
  assert.ok(value.split('/').every(part => part && part !== '.' && part !== '..'));
  return value;
}

export async function verifyGitignore({ seed = DEFAULT_SEED, fuzzGroups = 24 } = {}) {
  const git = probeGit();
  if (!git.available) return { skipped: true, reason: git.reason };
  const { compileGitignore, matchRules, createIgnoreBudget } = await import('../core/workspace-ignore.mjs');
  const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(path.join(project, file)))])));
  const groups = createConformanceFixtures({ seed, fuzzGroups });
  const parent = await fs.realpath(tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'openaster-gitignore-'));
  const identity = await fs.lstat(directory, { bigint: true }), owner = randomUUID();
  await fs.writeFile(path.join(directory, '.oracle-owner'), owner, { flag: 'wx' });
  const startedAt = new Date().toISOString(), start = performance.now();
  const report = { version: 1, git, seed, fuzzGroups, startedAt, sourceHashes: sources, groups: groups.length, probes: 0, differences: [], commands: [], fixtureRoot: directory,
    scope: 'Original deterministic cases and seeded inputs; isolated Git with case-sensitive byte matching and ancestor pruning. Ignore files and directories are real; non-directory probe leaves are virtual paths, allowing trailing-space byte cases on Windows. No external repository, runtime Git dependency, network request, or user workspace read.' };
  let caught;
  try {
    const config = path.join(directory, 'empty-config'), template = path.join(directory, 'empty-template'), hooks = path.join(directory, 'empty-hooks'), repository = path.join(directory, 'repository');
    await fs.writeFile(config, '', { flag: 'wx' });
    for (const location of [template, hooks, repository]) await fs.mkdir(location);
    const env = { ...baseEnvironment(), GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_TEMPLATE_DIR: template };
    const gitArgs = ['-c', 'core.ignoreCase=false', '-c', `core.excludesFile=${config}`, '-c', `core.attributesFile=${config}`, '-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'protocol.allow=never'];
    const invoke = (args, input) => {
      const before = performance.now();
      const result = spawnSync('git', [...gitArgs, ...args], { cwd: repository, env, input, timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      report.commands.push({ args: [...gitArgs, ...args], exitCode: result.status, signal: result.signal, error: result.error?.code ?? null, durationMs: Math.round(performance.now() - before) });
      if (result.error) throw result.error;
      return result;
    };
    const init = invoke(['init', '--quiet', '--template=' + template]);
    assert.equal(init.status, 0, init.stderr?.toString('utf8'));
    const probes = [], compiled = new Map();
    for (const [index, fixture] of groups.entries()) {
      const groupPath = `cases/g${String(index).padStart(3, '0')}`;
      await fs.mkdir(path.join(repository, groupPath), { recursive: true });
      for (const ignore of fixture.ignores) {
        if (ignore.base) safeRelative(ignore.base);
        const location = path.join(repository, groupPath, ignore.base);
        await fs.mkdir(location, { recursive: true });
        await fs.writeFile(path.join(location, '.gitignore'), ignore.content, { flag: 'wx' });
      }
      compiled.set(fixture, { budget: createIgnoreBudget(), ignores: fixture.ignores.map(ignore => ({ ...ignore, rules: compileGitignore(ignore.content, { base: ignore.base }) })).sort((a, b) => a.base.split('/').length - b.base.split('/').length || a.base.localeCompare(b.base)) });
      const seen = new Set();
      for (const probe of fixture.probes) {
        safeRelative(probe.path); assert.ok(!seen.has(probe.path)); seen.add(probe.path);
        const absolute = path.join(repository, groupPath, probe.path);
        if (probe.directory) await fs.mkdir(absolute, { recursive: true });
        else await fs.mkdir(path.dirname(absolute), { recursive: true });
        // Use the exact slash-separated API path. A trailing slash is not
        // interchangeable: Git can match tree/** against tree/ but not tree.
        // Directory type comes from the real fixture, not a rewritten query.
        probes.push({ ...probe, fixture, groupPath, gitPath: `${groupPath}/${probe.path}` });
      }
    }
    const checked = invoke(['check-ignore', '--no-index', '--stdin', '-z', '--verbose', '--non-matching'], Buffer.from(probes.map(probe => probe.gitPath).join('\0') + '\0'));
    assert.ok(checked.status === 0 || checked.status === 1, checked.stderr?.toString('utf8'));
    assert.equal(checked.stderr.length, 0, checked.stderr.toString('utf8'));
    const fields = checked.stdout.toString('utf8').split('\0'); assert.equal(fields.pop(), ''); assert.equal(fields.length, probes.length * 4);
    const directories = probes.filter(probe => probe.directory);
    const spellings = invoke(['check-ignore', '--no-index', '--stdin', '-z', '--verbose', '--non-matching'], Buffer.from(directories.flatMap(probe => [probe.gitPath, probe.gitPath + '/']).join('\0') + '\0'));
    assert.ok(spellings.status === 0 || spellings.status === 1); assert.equal(spellings.stderr.length, 0);
    const spellingFields = spellings.stdout.toString('utf8').split('\0'); assert.equal(spellingFields.pop(), ''); assert.equal(spellingFields.length, directories.length * 8);
    report.directorySpellingObservations = directories.map((probe, index) => ({ group: probe.fixture.name, path: probe.path,
      canonical: spellingFields.slice(index * 8, index * 8 + 4), withTrailingSlash: spellingFields.slice(index * 8 + 4, index * 8 + 8),
      compared: 'Canonical path only; the matcher API receives no appended trailing slash.' }));
    for (const [index, probe] of probes.entries()) {
      const [source, line, pattern, pathname] = fields.slice(index * 4, index * 4 + 4);
      assert.equal(pathname, probe.gitPath);
      const expected = source ? { ignored: !pattern.startsWith('!'), base: path.posix.dirname(source.slice(probe.groupPath.length + 1)).replace(/^\.$/u, ''), line: Number(line) } : null;
      let actual = null, failure;
      try {
        const local = compiled.get(probe.fixture), parts = probe.path.split('/');
        for (let count = 1; count <= parts.length; count++) {
          const current = parts.slice(0, count).join('/'), isDirectory = count < parts.length || probe.directory;
          let currentResult = null;
          for (const ignore of local.ignores) {
            if (ignore.base && !current.startsWith(ignore.base + '/')) continue;
            const match = matchRules(ignore.rules, current, isDirectory, { budget: local.budget });
            if (match) currentResult = { ignored: match.ignored, base: ignore.base, line: match.line };
          }
          actual = currentResult;
          if (currentResult?.ignored) break;
        }
      } catch (error) { failure = { code: error.code ?? null, message: error.message }; }
      report.probes++;
      if (failure || JSON.stringify(actual) !== JSON.stringify(expected)) report.differences.push({ group: probe.fixture.name, ignores: probe.fixture.ignores, path: probe.path, directory: probe.directory, expected, actual, ...(failure ? { error: failure } : {}), git: { source, line, pattern } });
    }
    const after = Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(path.join(project, file)))])));
    assert.deepEqual(after, sources, 'Source changed during oracle verification');
    report.sourceUnchanged = true;
  } catch (error) {
    caught = error;
    report.failure = { code: error.code ?? null, message: error.message };
  } finally {
    try {
      const canonical = await fs.realpath(directory), current = await fs.lstat(directory, { bigint: true });
      assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-gitignore-[A-Za-z0-9]+$/u);
      assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(await fs.readFile(path.join(canonical, '.oracle-owner'), 'utf8'), owner);
      await fs.rm(canonical, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
      report.temporaryResourcesCleaned = true;
    } catch (error) { report.cleanupFailure = { code: error.code ?? null, message: error.message }; }
  }
  report.durationMs = Math.round(performance.now() - start);
  report.passed = !caught && !report.cleanupFailure && report.differences.length === 0;
  const evidence = `.diagnostics/gitignore-conformance-${startedAt.replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}.json`;
  await fs.mkdir(path.join(project, '.diagnostics'), { recursive: true });
  await fs.writeFile(path.join(project, evidence), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  return { ...report, evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(['--seed', '--fuzz-groups'].includes(args[index]) && args[index + 1] !== undefined, 'Use --seed <uint32> --fuzz-groups <0..64>');
    const key = args[index] === '--seed' ? 'seed' : 'fuzzGroups'; assert.ok(!Object.hasOwn(options, key)); options[key] = Number(args[index + 1]);
  }
  const result = await verifyGitignore(options);
  console.log(JSON.stringify({ passed: result.passed, skipped: result.skipped ?? false, reason: result.reason, evidence: result.evidence, git: result.git, seed: result.seed, groups: result.groups, probes: result.probes, differences: result.differences?.length, failure: result.failure, durationMs: result.durationMs, temporaryResourcesCleaned: result.temporaryResourcesCleaned }, null, 2));
  if (!result.passed) process.exitCode = result.skipped ? 2 : 1;
}
