// SPDX-License-Identifier: Apache-2.0
// Synthetic local files only. No model requests, user directories or global changes.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../core/workspace.mjs';
import { startServer } from '../server/index.mjs';

const file = fileURLToPath(import.meta.url);
const project = resolve(dirname(file), '..');
const MiB = 2 ** 20;
const QUERY = 'SCAN_BENCHMARK_NEEDLE';
const WARMUP = 1, REPEATS = 5, MAXIMUM_MS = 300_000;
const rounded = value => Number(value.toFixed(3));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['core/workspace.mjs', 'core/workspace-ignore.mjs', 'core/workspace-search.mjs', 'core/errors.mjs', 'server/index.mjs', 'server/workspace-search.mjs', 'server/store.mjs', 'core/context-files.mjs', 'core/conversation-branch.mjs', 'core/context-planner.mjs', 'core/tool-artifacts.mjs', 'core/run-history.mjs', 'server/lock.mjs', 'server/skills.mjs', 'core/sensitive-paths.mjs', 'core/runtime.mjs', 'core/providers.mjs', 'core/provider-stream.mjs', 'core/provider-terminal.mjs', 'core/usage.mjs', 'core/usage-overview.mjs', 'scripts/benchmark-workspace-scan.mjs'];
const definitions = [
  { id: 'default-list', operation: 'list', path: '', includeGenerated: false },
  { id: 'include-generated-list', operation: 'list', path: '', includeGenerated: true },
  { id: 'src-list', operation: 'list', path: 'src', includeGenerated: false },
  { id: 'src-search', operation: 'search', path: 'src', includeGenerated: false },
];

function memory() {
  const values = process.memoryUsage();
  return Object.fromEntries(['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'].map(key => [`${key}MiB`, rounded(values[key] / MiB)]));
}

function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => rounded(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
  return { samples: sorted.length, min: rounded(sorted[0]), p50: percentile(.5), p95: percentile(.95), max: rounded(sorted.at(-1)) };
}

async function hashes() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async relative => [relative, sha256(await readFile(join(project, relative)))])));
}

async function worker() {
  assert.equal(typeof process.send, 'function', 'Worker requires the benchmark parent IPC channel');
  const directory = resolve(process.argv[3]);
  const definition = definitions.find(value => value.id === process.argv[4]);
  assert.ok(definition);
  const workspacePath = join(directory, 'project');
  const dataRoot = join(directory, 'data');
  const dataDir = join(dataRoot, definition.id);
  await mkdir(dataDir);
  const expectedIdentity = await createWorkspace(workspacePath, { createRoot: false }).getIdentity();
  const workspaceOptions = { createRoot: false, expectedIdentity, protectedRoots: [dataRoot, join(directory, 'app')], denySensitivePaths: true, projectScan: true };
  const workspace = createWorkspace(workspacePath, workspaceOptions);
  const service = await startServer({ dataDir, workspace: workspacePath, workspaceOptions });
  let closing, sampleTimer, before, peaks, samples, cpuStart;
  const close = () => closing ??= service.close();
  const watchdog = setTimeout(() => { close().finally(() => process.exit(1)); }, 180_000);
  process.on('disconnect', () => { clearInterval(sampleTimer); clearTimeout(watchdog); close().finally(() => process.exit()); });
  process.on('message', async message => {
    try {
      let result;
      if (message.command === 'begin') {
        assert.equal(sampleTimer, undefined);
        global.gc?.();
        before = memory(); peaks = { ...before }; samples = 0; cpuStart = process.cpuUsage();
        sampleTimer = setInterval(() => {
          samples++;
          const current = memory();
          for (const key of Object.keys(peaks)) peaks[key] = Math.max(peaks[key], current[key]);
        }, 10);
        result = { before };
      } else if (message.command === 'end') {
        assert.ok(sampleTimer);
        clearInterval(sampleTimer); sampleTimer = undefined;
        const after = memory(), cpu = process.cpuUsage(cpuStart);
        for (const key of Object.keys(peaks)) peaks[key] = Math.max(peaks[key], after[key]);
        samples++;
        global.gc?.();
        result = { before, observedPeak: peaks, after, afterForcedGc: memory(), samples, sampleIntervalMs: 10, observedRssGrowthMiB: rounded(peaks.rssMiB - before.rssMiB), lifetimeMaxRssMiB: rounded(process.resourceUsage().maxRSS / 1024), cpuUserMs: rounded(cpu.user / 1000), cpuSystemMs: rounded(cpu.system / 1000) };
      } else if (message.command === 'search') {
        assert.equal(definition.operation, 'search');
        const start = performance.now();
        const data = await workspace.search(QUERY, { path: definition.path, includeGenerated: definition.includeGenerated, signal: AbortSignal.timeout(45_000) });
        const operationMs = performance.now() - start;
        result = { data, operationMs, serializedResultBytes: Buffer.byteLength(JSON.stringify(data)) };
      } else if (message.command === 'close') {
        clearInterval(sampleTimer); clearTimeout(watchdog); await close(); result = { closed: true };
      } else throw new Error('Unknown benchmark IPC command');
      process.send({ id: message.id, result }, () => { if (message.command === 'close') process.disconnect(); });
    } catch (error) { process.send({ id: message.id, error: error.message }); }
  });
  process.send({ ready: true, url: service.url });
}

function verifyResult(definition, data) {
  assert.equal(data.scope, definition.path);
  assert.equal(data.scan.projectMode, true);
  assert.equal(data.scan.includeGenerated, definition.includeGenerated);
  assert.equal(data.scan.skippedEntries, 0);
  if (definition.id === 'default-list') {
    assert.equal(data.files.length, 102); // README, src directory and 100 source files.
    assert.equal(data.scan.excludedDirectories, 1);
    assert.equal(data.scan.visitedEntries, 103);
    assert.equal(data.truncated, false);
    assert.deepEqual(data.scan.limits, []);
    assert.ok(!data.files.some(value => value.path.startsWith('node_modules')));
  } else if (definition.id === 'include-generated-list') {
    assert.equal(data.files.length, 1000);
    assert.equal(data.scan.excludedDirectories, 0);
    assert.equal(data.scan.visitedEntries, 2003);
    assert.equal(data.truncated, true);
    assert.deepEqual(data.scan.limits, ['entries']);
    assert.ok(data.files.some(value => value.path.startsWith('node_modules/')));
  } else {
    assert.equal(data.scan.excludedDirectories, 0);
    assert.equal(data.scan.visitedEntries, 100);
    assert.equal(data.truncated, false);
    assert.deepEqual(data.scan.limits, []);
    const entries = definition.operation === 'search' ? data.matches : data.files;
    assert.equal(entries.length, 100);
    assert.ok(entries.every(value => value.path.startsWith('src/')));
    if (definition.operation === 'search') {
      assert.equal(data.query, QUERY); assert.equal(data.searchedFiles, 100);
      assert.ok(entries.every(value => value.line === 1 && value.text.includes(QUERY)));
    }
  }
  return { scope: data.scope, truncated: data.truncated, scan: data.scan, returnedEntries: data.files?.length ?? null, returnedFiles: data.files?.filter(value => value.type === 'file').length ?? null, returnedDirectories: data.files?.filter(value => value.type === 'directory').length ?? null, matches: data.matches?.length ?? null, searchedFiles: data.searchedFiles ?? null };
}

async function seed(directory, deadline) {
  for (const relative of ['project', 'project/src', 'project/node_modules', 'data', 'app']) await mkdir(join(directory, relative));
  await writeFile(join(directory, 'project/README.md'), '# Synthetic project scan benchmark\n', { flag: 'wx' });
  const files = [
    ...Array.from({ length: 100 }, (_, index) => [`src/source-${String(index).padStart(4, '0')}.js`, `// ${QUERY} source ${String(index).padStart(4, '0')} 中文\nexport const value = ${index};\n`]),
    ...Array.from({ length: 2000 }, (_, index) => [`node_modules/dependency-${String(index).padStart(4, '0')}.js`, `// synthetic dependency ${String(index).padStart(4, '0')}\nexport default ${index};\n`]),
  ];
  for (let offset = 0; offset < files.length; offset += 32) {
    deadline.throwIfAborted();
    await Promise.all(files.slice(offset, offset + 32).map(([relative, content]) => writeFile(join(directory, 'project', relative), content, { flag: 'wx' })));
  }
  return { sourceFiles: 100, readmeFiles: 1, dependencyFiles: 2000, directoriesInsideWorkspace: 2, totalFiles: 2101, sourceMatchesPerFile: 1, query: QUERY };
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((accept, reject) => {
    const killTimer = setTimeout(() => child.kill(), 2_000);
    const deadline = setTimeout(() => reject(new Error('Benchmark child did not terminate; refusing to remove its workspace')), 7_000);
    child.once('exit', () => { clearTimeout(killTimer); clearTimeout(deadline); accept(); });
  });
}

async function main() {
  const started = performance.now(), sourceHashes = await hashes();
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'openaster-workspace-scan-benchmark-'));
  const initialIdentity = await lstat(directory, { bigint: true });
  const owner = randomBytes(32).toString('hex');
  await writeFile(join(directory, '.benchmark-owner'), owner, { flag: 'wx', mode: 0o600 });
  const deadline = AbortSignal.timeout(MAXIMUM_MS);
  const children = new Set(), cases = [];
  deadline.addEventListener('abort', () => { for (const child of children) child.kill(); }, { once: true });
  let result;
  try {
    const fixture = await seed(directory, deadline);
    for (const definition of definitions) {
      deadline.throwIfAborted();
      const child = fork(file, ['--scan-worker', directory, definition.id], { execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
      children.add(child);
      let stderr = '', serial = 0;
      const pending = new Map();
      child.stderr.on('data', value => { stderr = `${stderr}${value}`.slice(-4000); });
      const ready = new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error(`Scan worker startup timeout: ${stderr}`)), 30_000);
        child.on('message', value => { if (value.ready) { clearTimeout(timer); accept(value); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Scan worker exited ${code}: ${stderr}`)); });
      });
      child.on('message', value => {
        const callback = pending.get(value.id);
        if (!callback) return;
        clearTimeout(callback.timer); pending.delete(value.id);
        value.error ? callback.reject(new Error(value.error)) : callback.accept(value.result);
      });
      child.once('exit', code => {
        for (const callback of pending.values()) { clearTimeout(callback.timer); callback.reject(new Error(`Scan worker exited ${code}: ${stderr}`)); }
        pending.clear();
      });
      const command = command => new Promise((accept, reject) => {
        deadline.throwIfAborted();
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Scan worker IPC timeout')); }, 50_000);
        pending.set(id, { accept, reject, timer });
        child.send({ id, command }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
      });
      try {
        const { url } = await ready;
        const route = '/api/workspace?' + new URLSearchParams({ path: definition.path, includeGenerated: String(definition.includeGenerated) });
        const unauthenticated = await fetch(url + route, { signal: AbortSignal.timeout(5_000) });
        assert.equal(unauthenticated.status, 401); await unauthenticated.arrayBuffer();
        const bootstrap = await fetch(url + '/api/bootstrap', { signal: AbortSignal.timeout(5_000) });
        assert.equal(bootstrap.status, 200);
        const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
        assert.ok(cookie); await bootstrap.arrayBuffer();
        async function request() {
          deadline.throwIfAborted();
          const start = performance.now();
          let data, sample;
          if (definition.operation === 'list') {
            const response = await fetch(url + route, { headers: { cookie }, signal: AbortSignal.any([deadline, AbortSignal.timeout(45_000)]) });
            assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
            const bytes = Buffer.from(await response.arrayBuffer());
            const bodyReceivedAt = performance.now();
            data = JSON.parse(bytes.toString('utf8'));
            const parsedAt = performance.now();
            sample = { responseBodyReceivedMs: rounded(bodyReceivedAt - start), responseWithClientJsonParseMs: rounded(parsedAt - start), clientJsonParseMs: rounded(parsedAt - bodyReceivedAt), jsonBytes: bytes.length };
          } else {
            const response = await command('search');
            const receivedAt = performance.now();
            data = response.data;
            sample = { coreOperationMs: rounded(response.operationMs), ipcRoundTripMs: rounded(receivedAt - start), jsonBytes: response.serializedResultBytes };
          }
          return { ...sample, result: verifyResult(definition, data) };
        }
        for (let index = 0; index < WARMUP; index++) await request();
        await command('begin');
        const samples = [];
        const phaseStarted = performance.now();
        for (let index = 0; index < REPEATS; index++) samples.push(await request());
        const phaseWallMs = rounded(performance.now() - phaseStarted);
        const serverMemory = await command('end');
        for (const sample of samples) {
          assert.deepEqual(sample.result, samples[0].result);
          assert.equal(sample.jsonBytes, samples[0].jsonBytes);
        }
        const metrics = definition.operation === 'list' ? ['responseBodyReceivedMs', 'responseWithClientJsonParseMs', 'clientJsonParseMs'] : ['coreOperationMs', 'ipcRoundTripMs'];
        cases.push({ ...definition, transport: definition.operation === 'list' ? 'authenticated-loopback-http' : 'core-search-in-server-process-via-benchmark-ipc', unauthenticatedListStatus: 401, warmupRequestsDiscarded: WARMUP, measuredRequests: REPEATS, concurrency: 1, phaseWallMs, jsonBytes: samples[0].jsonBytes, result: samples[0].result, latency: Object.fromEntries(metrics.map(key => [key, statistics(samples.map(sample => sample[key]))])), serverMemory, samples });
        await command('close');
      } finally {
        for (const callback of pending.values()) { clearTimeout(callback.timer); callback.reject(new Error('Scan benchmark worker closing')); }
        await stop(child); children.delete(child);
      }
    }
    assert.deepEqual(await hashes(), sourceHashes, 'Source changed during benchmark; rerun after freeze');
    const [defaultList, includedList, scopedList] = cases;
    result = {
      measuredAt: new Date().toISOString(), elapsedMs: rounded(performance.now() - started),
      environment: { node: process.version, os: `${platform()} ${release()}`, architecture: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryGiB: rounded(totalmem() / 2 ** 30), sqlite: process.versions.sqlite, sourceHashes },
      methodology: {
        fixture: 'A fresh owned temporary project with 100 UTF-8 source files, a root README, and 2000 synthetic node_modules files. Fixture creation and worker startup are outside request latency.',
        listing: 'Authenticated real loopback HTTP -> production /api/workspace -> production workspace.list; responseBodyReceivedMs ends after receiving all bytes, responseWithClientJsonParseMs includes client decoding/parsing.',
        search: 'Production workspace.search called in the service worker with identical safety options; coreOperationMs excludes JSON serialization and IPC. ipcRoundTripMs includes the benchmark IPC transfer. No production search HTTP endpoint is added or implied.',
        safetyOptions: { createRoot: false, expectedIdentity: 'Pinned canonical path plus bigint device/inode identity', protectedRoots: ['separate temporary data parent', 'separate temporary application directory'], denySensitivePaths: true, projectScan: true },
        repetitions: { warmupPerCase: WARMUP, measurementsPerCase: REPEATS, concurrency: 1, percentile: 'Nearest rank; with five samples p95 is the observed maximum, not a population-tail estimate.' },
        memory: 'Separate fresh Node service process per case; client parsing and fixture creation excluded. process.memoryUsage sampled every 10 ms across measured calls; observed peak can miss synchronous spikes. Forced GC only before/after the phase. Lifetime max RSS includes startup and warmup; RSS is not retained JavaScript size.',
        machineIsolation: 'Service/client processes are separate, but the host CPU, disk, filesystem cache and other applications are not pinned or exclusively reserved. The one warmup and preceding fixture writes make these warm-cache-oriented measurements.',
        limits: 'The includeGenerated fixture reaches the production 1000-entry output cap, so its duration is a bounded partial inventory, not a complete 2101-file scan. Root and scoped listing have different output sizes; ratios are fixture-specific.',
        limitations: 'No cloud model, mobile device, native GUI rendering, network filesystem, macOS or Linux performance is inferred. This is a deterministic local fixture, not representative of all projects.',
        noPaidModels: true, noPlatformInstallationOrGlobalChanges: true, maximumBenchmarkMs: MAXIMUM_MS,
      },
      fixture,
      comparison: {
        includeGeneratedToDefaultListP50Ratio: rounded(includedList.latency.responseBodyReceivedMs.p50 / defaultList.latency.responseBodyReceivedMs.p50),
        defaultToScopedListP50Ratio: rounded(defaultList.latency.responseBodyReceivedMs.p50 / scopedList.latency.responseBodyReceivedMs.p50),
        defaultVisitedEntries: defaultList.result.scan.visitedEntries, includeGeneratedVisitedEntries: includedList.result.scan.visitedEntries, scopedVisitedEntries: scopedList.result.scan.visitedEntries,
        includeGeneratedResultIsTruncated: includedList.result.truncated,
      },
      cases,
    };
  } finally {
    for (const child of children) { child.kill(); await stop(child); }
    const canonical = await realpath(directory), current = await lstat(directory, { bigint: true });
    assert.equal(dirname(canonical), temporaryRoot);
    assert.match(basename(canonical), /^openaster-workspace-scan-benchmark-[a-zA-Z0-9]+$/);
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, initialIdentity.dev); assert.equal(current.ino, initialIdentity.ino);
    assert.equal(await readFile(join(canonical, '.benchmark-owner'), 'utf8'), owner);
    await rm(canonical, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  }
  result.temporaryResourcesCleaned = true;
  await writeFile(join(project, 'docs/workspace-scan-benchmark-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[2] === '--scan-worker') await worker();
else { assert.equal(process.argv.length, 2, 'This benchmark takes no arguments'); await main(); }
