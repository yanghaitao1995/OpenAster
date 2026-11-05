// SPDX-License-Identifier: Apache-2.0
// Synthetic local-only benchmark. No external model or user workspace is used.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, lstat, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpus, platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const project = path.resolve(import.meta.dirname, '..');
const sourceFiles = ['core/usage-overview.mjs', 'core/usage.mjs', 'core/run-history.mjs', 'core/tool-artifacts.mjs',
  'core/workspace.mjs', 'core/workspace-ignore.mjs', 'core/workspace-search.mjs', 'core/sensitive-paths.mjs', 'core/context-files.mjs', 'core/conversation-branch.mjs', 'core/context-planner.mjs',
  'core/runtime.mjs', 'core/providers.mjs', 'core/provider-stream.mjs', 'core/provider-terminal.mjs',
  'server/index.mjs', 'server/workspace-search.mjs', 'server/store.mjs', 'server/lock.mjs', 'scripts/benchmark-usage-overview.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(path.join(project, file)))])));
async function owned(directory, owner) {
  const parent = await realpath(tmpdir()), current = await lstat(directory, { bigint: true }), canonical = await realpath(directory);
  assert.ok(current.isDirectory() && !current.isSymbolicLink());
  assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-usage-benchmark-[a-zA-Z0-9]+$/);
  assert.equal(await readFile(path.join(canonical, '.owner'), 'utf8'), owner);
  return { parent, canonical, current };
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.argv[2] === '--serve') {
  const [, , , directory, owner] = process.argv;
  await owned(directory, owner);
  let service, stopping, stopRequested = false;
  const stop = () => {
    stopRequested = true;
    if (service && !stopping) stopping = service.close().catch(() => { process.exitCode = 1; })
      .finally(() => { if (process.connected) process.disconnect(); });
  };
  process.on('message', message => { if (message === 'shutdown') stop(); });
  process.on('disconnect', stop);
  service = await startServer({ host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'data'), workspace: path.join(directory, 'data', 'workspace') });
  if (stopRequested) stop(); else process.send({ type: 'ready', url: service.url, pid: process.pid });
} else {
  assert.equal(process.argv.length, 2);
  const sourceHashes = await hashes(), startedAt = new Date().toISOString();
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'openaster-usage-benchmark-'));
  const owner = randomBytes(32).toString('hex');
  await writeFile(path.join(directory, '.owner'), owner, { flag: 'wx', mode: 0o600 });
  const binding = await owned(directory, owner);
  const runCount = 1000, stepsPerRun = 48, groupCount = 50, detailBytes = 32768;
  const usage = { inputTokens: 400000000000, outputTokens: 100000000000, totalTokens: 500000000000,
    cachedInputTokens: 0, cacheWriteInputTokens: null, reasoningOutputTokens: 0 };
  const detail = 'PRIVATE_BENCHMARK_HISTORY_'.padEnd(detailBytes, 'x');
  let child, childError, exitCode, childClosed = false, deadline, expired = false, completed = false, result, seed;
  try {
    seed = new Store(path.join(directory, 'data'));
    const session = seed.createSession();
    seed.transaction(() => {
      for (let index = 0; index < runCount; index++) {
        const group = index % groupCount, time = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        seed.putRunHistory({ sessionId: session.id, run: { id: 'benchmark-run-' + index, status: 'completed', startedAt: time, finishedAt: time,
          connection: { providerId: 'benchmark-provider-' + group, name: '本机性能样例 ' + group, type: 'openai', model: 'fixture-' + group, toolMode: 'none' },
          steps: Array.from({ length: stepsPerRun }, (_, step) => ({ id: 'step-' + step, type: 'model', status: 'completed',
            detail: step === 0 ? detail : '', usage: index % 4 === 0 && step === stepsPerRun - 1 ? null : usage })) }, approvals: [] });
      }
    });
    const databaseBytes = (await lstat(path.join(directory, 'data', 'openaster.sqlite'))).size;
    seed.close(); seed = null;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('OPENASTER_') || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
    child = spawn(process.execPath, [import.meta.filename, '--serve', directory, owner], {
      cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
    child.on('error', error => { childError = error; });
    child.once('close', code => { exitCode = code; childClosed = true; });
    // This handle belongs to this invocation. Never signal a PID from a file.
    deadline = setTimeout(() => { expired = true; if (!childClosed) child.kill(); }, 180000);
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Usage benchmark server startup timed out')), 20000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error('Usage benchmark server exited early: ' + code + logs)); });
      child.on('message', value => { if (value?.type === 'ready') { clearTimeout(timeout); resolve(value); } });
    });
    const bootstrap = await fetch(ready.url + '/api/bootstrap', { signal: AbortSignal.timeout(10000) });
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0]; const boot = await bootstrap.json();
    assert.equal(boot.capabilities.usageOverview, 1);
    const request = async cursor => {
      const start = performance.now();
      const response = await fetch(ready.url + '/api/usage?' + new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) }),
        { headers: { cookie }, signal: AbortSignal.timeout(20000) });
      const bytes = Buffer.from(await response.arrayBuffer()), bodyReceivedMs = performance.now() - start;
      assert.equal(response.status, 200, bytes.toString('utf8'));
      assert.ok(!bytes.includes(Buffer.from('PRIVATE_BENCHMARK_HISTORY_')));
      const data = JSON.parse(bytes.toString('utf8'));
      assert.equal(data.summary.runs.total, runCount); assert.equal(data.summary.modelSteps, runCount * stepsPerRun);
      const reported = runCount * stepsPerRun - runCount / 4;
      assert.equal(data.summary.tokens.inputTokens.knownSum, (BigInt(reported) * BigInt(usage.inputTokens)).toString());
      assert.equal(data.summary.tokens.totalTokens.knownSum, (BigInt(reported) * BigInt(usage.totalTokens)).toString());
      assert.equal(data.summary.tokens.inputTokens.reportedSteps, reported);
      assert.equal(data.summary.tokens.inputTokens.missingSteps, runCount / 4);
      assert.equal(data.summary.tokens.cacheWriteInputTokens.knownSum, null);
      assert.equal(data.summary.tokens.cachedInputTokens.knownSum, '0');
      return { data, responseBytes: bytes.length, bodyReceivedMs };
    };
    const firstAggregationRequest = await request(); // one uncached summary observation, not a distribution
    const samples = [];
    for (let index = 0; index < 7; index++) {
      const start = performance.now(), pages = []; let cursor, snapshot, summary; const keys = new Set();
      const cursors = new Set();
      do {
        assert.ok(pages.length < 3, 'Unexpected extra or repeating group pages');
        if (cursor) { assert.ok(!cursors.has(cursor), 'Repeated group cursor'); cursors.add(cursor); }
        const page = await request(cursor); pages.push({ responseBytes: page.responseBytes, bodyReceivedMs: page.bodyReceivedMs });
        if (!snapshot) { snapshot = page.data.snapshotId; summary = page.data.summary; }
        assert.equal(page.data.snapshotId, snapshot); assert.deepEqual(page.data.summary, summary);
        assert.equal(page.data.groups.length, pages.length === 3 ? 10 : 20);
        for (const group of page.data.groups) {
          assert.ok(!keys.has(group.key)); keys.add(group.key);
          const number = Number(group.connection?.providerId?.replace('benchmark-provider-', ''));
          assert.ok(Number.isInteger(number) && number >= 0 && number < groupCount);
          const expectedConnection = { providerId: 'benchmark-provider-' + number, name: '本机性能样例 ' + number, type: 'openai', model: 'fixture-' + number, toolMode: 'none' };
          assert.deepEqual(group.connection, expectedConnection);
          assert.equal(group.key, digest(JSON.stringify(Object.values(expectedConnection))));
          assert.deepEqual(group.stats.runs, { total: 20, running: 0, awaitingApproval: 0, completed: 20, failed: 0, cancelled: 0 });
          const missing = number % 2 === 0 ? 10 : 0, reported = 960 - missing;
          assert.equal(group.stats.modelSteps, 960); assert.equal(group.stats.stepsWithCompleteUsage, reported);
          assert.equal(group.stats.stepsWithAnyUsage, reported); assert.equal(group.stats.stepsWithoutUsage, missing);
          for (const [key, value] of Object.entries(usage)) assert.deepEqual(group.stats.tokens[key], {
            knownSum: value === null ? null : (BigInt(reported) * BigInt(value)).toString(),
            reportedSteps: value === null ? 0 : reported, missingSteps: value === null ? 960 : missing,
          });
          for (const key of ['unclassifiedSteps', 'runsWithoutStepData', 'unattributedRuns', 'demoRuns']) assert.equal(group.stats[key], 0);
        }
        cursor = page.data.nextCursor;
      } while (cursor);
      assert.equal(keys.size, groupCount); assert.equal(pages.length, 3); assert.equal(cursor, null);
      samples.push({ allPagesMs: performance.now() - start, pages });
    }
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Usage benchmark graceful shutdown timed out; cleanup requires confirmed process termination')), 20000);
      child.once('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Benchmark server exit ' + code)); });
      child.send('shutdown');
    });
    assert.equal(exitCode, 0); assert.equal(childError, undefined); assert.equal(expired, false); assert.deepEqual(await hashes(), sourceHashes);
    const rounded = value => Number(value.toFixed(3));
    const stats = values => { const ordered = values.toSorted((a,b) => a-b); return { p50: rounded(ordered[Math.floor(ordered.length * .5)]), p95: rounded(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * .95) - 1)]) }; };
    result = { startedAt, measuredAt: new Date().toISOString(),
      environment: { node: process.version, os: platform() + ' ' + release(), cpu: cpus()[0]?.model, sqlite: process.versions.sqlite, sourceHashes },
      methodology: { repeats: 7, warmups: 1, separateServerProcess: true, externalModelRequests: false,
        chain: 'Authenticated real loopback HTTP -> production usage API -> SQLite compact usage projections; all group pages verified, exact integers checked above MAX_SAFE_INTEGER.',
        timing: 'First aggregation is one separate observation before the summary cache is populated, not an OS cold-cache test. Seven repeated samples use the cached summary; group page queries remain real. Body-received time excludes client JSON parsing; all-pages time includes parsing, assertions and pagination control. No RSS or isolated SQL timing is claimed.',
        scope: 'One synthetic local host sample; fixture creation and startup excluded. Does not establish real provider billing accuracy or all-platform performance.' },
      fixture: { runs: runCount, modelSteps: runCount * stepsPerRun, groups: groupCount, firstStepDetailBytes: detailBytes, databaseBytesBeforeCheckpoint: databaseBytes },
      summary: { firstUncachedSummaryBodyReceivedMs: rounded(firstAggregationRequest.bodyReceivedMs), firstPageBodyReceivedMs: stats(samples.map(value => value.pages[0].bodyReceivedMs)),
        allPagesMs: stats(samples.map(value => value.allPagesMs)), pageCount: samples[0].pages.length,
        maximumResponseBytes: Math.max(...samples.flatMap(value => value.pages.map(page => page.responseBytes))) },
      samples: samples.map(value => ({ allPagesMs: rounded(value.allPagesMs), pages: value.pages.map(page => ({...page, bodyReceivedMs: rounded(page.bodyReceivedMs)})) })),
      exactLargeTotalsVerified: true, unknownAndZeroSeparated: true, privateDetailAbsent: true, allGroupsVerified: true, serverExited: true };
    completed = true;
  } finally {
    seed?.close();
    clearTimeout(deadline);
    if (child && !childClosed) {
      if (child.connected) try { child.send('shutdown'); } catch { /* still wait for close */ }
      const gracefulDeadline = Date.now() + 10000; while (!childClosed && Date.now() < gracefulDeadline) await pause(100);
      if (!childClosed) {
        child.kill();
        const terminationDeadline = Date.now() + 10000; while (!childClosed && Date.now() < terminationDeadline) await pause(100);
      }
    }
    if (!child || childClosed) {
      const current = await owned(directory, owner);
      assert.equal(current.current.dev, binding.current.dev); assert.equal(current.current.ino, binding.current.ino);
      await rm(current.canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } else {
      console.error('Benchmark fixture retained because its server has not exited: ' + directory);
      if (child.connected) child.disconnect();
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }
  }
  assert.equal(completed, true);
  await writeFile(path.join(project, 'docs', 'usage-overview-benchmark-result.json'), JSON.stringify({ ...result, ownedFixtureCleaned: true }, null, 2) + '\n');
  console.log(JSON.stringify(result.summary));
}

