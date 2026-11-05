// SPDX-License-Identifier: Apache-2.0
// Synthetic stored snapshots only. No model calls, user data, global tools or platform installation.
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const file = fileURLToPath(import.meta.url);
const project = resolve(dirname(file), '..');
const FIXED_OUTPUT = '流式中文片段。'.repeat(48);
const FIXED_DATE = '2026-01-01T00:00:00.000Z';
const MiB = 2 ** 20;
const rounded = value => Number(value.toFixed(3));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const memory = () => {
  const values = process.memoryUsage();
  return Object.fromEntries(['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'].map(key => [`${key}MiB`, rounded(values[key] / MiB)]));
};

function seed(dataDir, historyBytes) {
  const store = new Store(dataDir);
  try {
    const session = store.createSession({ title: 'Synthetic long session' });
    const question = 'Synthetic archived question.';
    const pairs = 40;
    const answerBudget = historyBytes - Buffer.byteLength(question) * pairs;
    const marker = 'SYNTHETIC_HISTORY_ONLY:';
    session.messages = Array.from({ length: pairs }, (_, index) => {
      const length = Math.floor(answerBudget / pairs) + (index < answerBudget % pairs ? 1 : 0);
      return [
        { id: `user-${index}`, role: 'user', content: question, createdAt: FIXED_DATE },
        { id: `assistant-${index}`, role: 'assistant', content: marker + 'x'.repeat(length - marker.length), createdAt: FIXED_DATE },
      ];
    }).flat();
    session.approvals = Array.from({ length: 16 }, (_, index) => ({ id: `approval-${index}`, status: 'denied', preview: { before: 'APPROVAL_ONLY:'.repeat(80), after: 'NO_APPROVAL_IN_OUTPUT:'.repeat(80) } }));
    session.run = {
      id: 'fixed-stream-run', status: 'cancelled', startedAt: FIXED_DATE, finishedAt: FIXED_DATE,
      steps: Array.from({ length: 32 }, (_, index) => ({ id: `step-${index}`, type: 'model', detail: 'STEPS_ONLY:'.repeat(80), status: 'cancelled' })),
      output: { stepId: 'fixed-stream-step', content: FIXED_OUTPUT, status: 'interrupted' },
    };
    session.createdAt = session.updatedAt = FIXED_DATE;
    assert.equal(session.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0), historyBytes);
    const storedBytes = Buffer.byteLength(JSON.stringify(session));
    assert.ok(storedBytes < 8 * MiB);
    store.putSession(session);
    return { sessionId: session.id, historyBytes, storedSessionBytes: storedBytes, messages: session.messages.length, approvals: session.approvals.length, steps: session.run.steps.length, fixedOutputUtf8Bytes: Buffer.byteLength(FIXED_OUTPUT) };
  } finally { store.close(); }
}

async function worker() {
  const dataDir = resolve(process.argv[3]);
  const historyBytes = Number(process.argv[4]);
  assert.ok([MiB, 4 * MiB].includes(historyBytes));
  const fixture = seed(dataDir, historyBytes);
  const app = await startServer({ dataDir, workspace: join(dataDir, 'workspace') });
  let sampleTimer, sample, before, cpuStart, samples, peaks, closing;
  const close = () => closing ??= app.close();
  const watchdog = setTimeout(() => { close().finally(() => process.exit(1)); }, 90_000);
  process.on('disconnect', () => { clearInterval(sampleTimer); clearTimeout(watchdog); close().finally(() => process.exit()); });
  process.on('message', async message => {
    try {
      let result;
      if (message.command === 'begin') {
        global.gc?.(); // Controlled baseline only; never force GC while requests are timed.
        before = memory(); cpuStart = process.cpuUsage(); samples = 0; peaks = { ...before };
        sample = () => {
          samples++;
          const current = memory();
          for (const key of Object.keys(peaks)) peaks[key] = Math.max(peaks[key], current[key]);
        };
        sampleTimer = setInterval(sample, 10);
        result = { before };
      } else if (message.command === 'end') {
        clearInterval(sampleTimer); sample();
        const after = memory();
        const cpu = process.cpuUsage(cpuStart);
        global.gc?.();
        result = { before, observedPeak: peaks, after, afterForcedGc: memory(), samples, sampleIntervalMs: 10, observedRssGrowthMiB: rounded(peaks.rssMiB - before.rssMiB), lifetimeMaxRssMiB: rounded(process.resourceUsage().maxRSS / 1024), cpuUserMs: rounded(cpu.user / 1000), cpuSystemMs: rounded(cpu.system / 1000) };
      } else if (message.command === 'close') {
        clearInterval(sampleTimer); clearTimeout(watchdog); await close(); result = { closed: true };
      } else throw new Error('Unknown benchmark IPC command');
      process.send({ id: message.id, result }, () => { if (message.command === 'close') process.disconnect(); });
    } catch (error) { process.send({ id: message.id, error: error.message }); }
  });
  process.send({ ready: true, url: app.url, fixture });
}

function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => rounded(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
  return { samples: sorted.length, min: rounded(sorted[0]), p50: percentile(.5), p95: percentile(.95), max: rounded(sorted.at(-1)) };
}

function platformAvailability() {
  const result = { currentNativePlatform: process.platform, linuxExecutionPerformed: process.platform === 'linux', macOsExecutionPerformed: process.platform === 'darwin', iosExecutionPerformed: false };
  if (process.platform === 'win32') {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe');
    const decode = bytes => bytes?.includes(0) ? bytes.toString('utf16le').trim() : bytes?.toString('utf8').trim();
    result.wsl = { executable, operations: [['--status'], ['--list', '--quiet']].map(args => {
      const call = spawnSync(executable, args, { windowsHide: true, timeout: 5_000 });
      return { arguments: args, exitCode: call.status, stdout: decode(call.stdout), stderr: decode(call.stderr), error: call.error?.message ?? null };
    }) };
    result.wsl.listedInstalledDistributions = result.wsl.operations[1].exitCode === 0 && Boolean(result.wsl.operations[1].stdout);
    result.wsl.installationOrFeatureChangesPerformed = false;
    result.macOsAndIos = 'No macOS host or Xcode toolchain available in this Windows execution environment; no native execution claimed.';
  }
  return result;
}

async function main() {
  const sourceFiles = ['server/index.mjs', 'server/workspace-search.mjs', 'server/store.mjs', 'core/context-files.mjs', 'core/conversation-branch.mjs', 'core/context-planner.mjs', 'core/tool-artifacts.mjs', 'core/run-history.mjs', 'server/lock.mjs', 'core/sensitive-paths.mjs', 'core/runtime.mjs', 'core/workspace.mjs', 'core/workspace-ignore.mjs', 'core/workspace-search.mjs', 'core/providers.mjs', 'core/provider-stream.mjs', 'core/provider-terminal.mjs', 'core/usage.mjs', 'core/usage-overview.mjs', 'scripts/benchmark-long-session.mjs'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async relative => [relative, sha256(await readFile(join(project, relative)))])));
  const availablePlatforms = platformAvailability();
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'openaster-long-session-benchmark-'));
  const owner = randomBytes(32).toString('hex');
  await writeFile(join(directory, '.benchmark-owner'), owner, { flag: 'wx', mode: 0o600 });
  const deadline = AbortSignal.timeout(120_000);
  const workers = new Set();
  const cases = [];
  let caseNumber = 0;
  try {
    for (const historyBytes of [MiB, 4 * MiB]) {
      for (const endpoint of ['full-session', 'output-only']) {
        deadline.throwIfAborted();
        const dataDir = join(directory, `case-${++caseNumber}`);
        await mkdir(dataDir);
        // Each endpoint/size gets a fresh server process; client JSON parsing is outside server RSS.
        const child = fork(file, ['--server-worker', dataDir, String(historyBytes)], { execArgv: ['--expose-gc'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
        workers.add(child);
        let stderr = '', serial = 0;
        const callbacks = new Map();
        child.stderr.on('data', value => { stderr = `${stderr}${value}`.slice(-4000); });
        const ready = new Promise((accept, reject) => {
          const timer = setTimeout(() => reject(new Error(`Benchmark worker startup timeout: ${stderr}`)), 10_000);
          child.on('message', value => { if (value.ready) { clearTimeout(timer); accept(value); } });
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); reject(new Error(`Benchmark worker exited ${code}: ${stderr}`)); });
        });
        child.on('message', value => {
          const pending = callbacks.get(value.id);
          if (!pending) return;
          clearTimeout(pending.timer); callbacks.delete(value.id);
          value.error ? pending.reject(new Error(value.error)) : pending.accept(value.result);
        });
        const command = command => new Promise((accept, reject) => {
          const id = ++serial;
          const timer = setTimeout(() => { callbacks.delete(id); reject(new Error('Benchmark worker IPC timeout')); }, 8_000);
          callbacks.set(id, { accept, reject, timer }); child.send({ id, command });
        });
        try {
          const { url, fixture } = await ready;
          const route = `/api/sessions/${fixture.sessionId}${endpoint === 'output-only' ? '/output' : ''}`;
          const unauthenticated = await fetch(url + route, { signal: AbortSignal.timeout(5_000) });
          assert.equal(unauthenticated.status, 401); await unauthenticated.arrayBuffer();
          const bootstrap = await fetch(url + '/api/bootstrap', { signal: AbortSignal.timeout(5_000) });
          assert.equal(bootstrap.status, 200);
          const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
          assert.ok(cookie); await bootstrap.arrayBuffer();
          async function request() {
            deadline.throwIfAborted();
            const start = performance.now();
            const response = await fetch(url + route, { headers: { cookie }, signal: AbortSignal.any([deadline, AbortSignal.timeout(5_000)]) });
            assert.equal(response.status, 200);
            const bytes = Buffer.from(await response.arrayBuffer());
            const bodyReceived = performance.now();
            const data = JSON.parse(bytes.toString('utf8'));
            const parsed = performance.now();
            if (endpoint === 'output-only') {
              assert.deepEqual(Object.keys(data).sort(), ['run', 'sessionId', 'updatedAt']);
              assert.equal(data.sessionId, fixture.sessionId);
              assert.deepEqual(Object.keys(data.run).sort(), ['id', 'output', 'status']);
              assert.deepEqual(Object.keys(data.run.output).sort(), ['content', 'status', 'stepId']);
              assert.equal(data.run.output.content, FIXED_OUTPUT);
              assert.equal(data.run.status, 'cancelled');
              for (const forbidden of ['SYNTHETIC_HISTORY_ONLY', 'APPROVAL_ONLY', 'STEPS_ONLY']) assert.ok(!bytes.includes(Buffer.from(forbidden)));
            } else {
              assert.equal(data.session.messages.length, fixture.messages);
              assert.equal(data.session.approvals.length, fixture.approvals);
              assert.equal(data.session.run.steps.length, fixture.steps);
              assert.equal(data.session.run.output.content, FIXED_OUTPUT);
              assert.equal(data.session.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0), historyBytes);
            }
            return { bodyBytes: bytes.length, bodyReceivedMs: bodyReceived - start, withClientJsonParseMs: parsed - start, clientJsonParseMs: parsed - bodyReceived };
          }
          for (let index = 0; index < 5; index++) await request();
          const phases = [];
          for (const [mode, concurrency, count] of [['sequential', 1, 40], ['concurrent', 4, 32]]) {
            await command('begin');
            const responses = [];
            const start = performance.now();
            for (let index = 0; index < count; index += concurrency) responses.push(...await Promise.all(Array.from({ length: concurrency }, request)));
            const wallMs = performance.now() - start;
            const serverMemory = await command('end');
            assert.equal(new Set(responses.map(value => value.bodyBytes)).size, 1);
            phases.push({ mode, concurrency, requests: count, wallMs: rounded(wallMs), responseBodyBytes: responses[0].bodyBytes, aggregateBodyBytes: responses.reduce((sum, value) => sum + value.bodyBytes, 0), responseBodyReceivedMs: statistics(responses.map(value => value.bodyReceivedMs)), responseWithClientJsonParseMs: statistics(responses.map(value => value.withClientJsonParseMs)), clientJsonParseMs: statistics(responses.map(value => value.clientJsonParseMs)), serverMemory });
          }
          cases.push({ endpoint, fixture, unauthenticatedRequestStatus: 401, warmupRequestsDiscarded: 5, phases });
          await command('close');
        } finally {
          for (const pending of callbacks.values()) { clearTimeout(pending.timer); pending.reject(new Error('Benchmark worker closing')); }
          if (child.exitCode == null) {
            await new Promise(accept => { const timer = setTimeout(() => { child.kill(); accept(); }, 3_000); child.once('exit', () => { clearTimeout(timer); accept(); }); });
          }
          workers.delete(child);
        }
      }
    }
    const narrow = cases.filter(value => value.endpoint === 'output-only');
    assert.equal(narrow[0].phases[0].responseBodyBytes, narrow[1].phases[0].responseBodyBytes, 'Narrow response grew with history');
    for (const [relative, hash] of Object.entries(sourceHashes)) assert.equal(sha256(await readFile(join(project, relative))), hash, `Source changed during benchmark: ${relative}; rerun after freeze`);
    const comparison = [MiB, 4 * MiB].map(historyBytes => {
      const full = cases.find(value => value.endpoint === 'full-session' && value.fixture.historyBytes === historyBytes);
      const output = cases.find(value => value.endpoint === 'output-only' && value.fixture.historyBytes === historyBytes);
      return { historyBytes, fullResponseBytes: full.phases[0].responseBodyBytes, outputResponseBytes: output.phases[0].responseBodyBytes, responseByteReductionPercent: rounded((1 - output.phases[0].responseBodyBytes / full.phases[0].responseBodyBytes) * 100), sequentialP50BodyLatencyRatioFullToOutput: rounded(full.phases[0].responseBodyReceivedMs.p50 / output.phases[0].responseBodyReceivedMs.p50), concurrentP50BodyLatencyRatioFullToOutput: rounded(full.phases[1].responseBodyReceivedMs.p50 / output.phases[1].responseBodyReceivedMs.p50) };
    });
    const result = {
      measuredAt: new Date().toISOString(),
      environment: { node: process.version, os: `${platform()} ${release()}`, architecture: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryGiB: rounded(totalmem() / 2 ** 30), sqlite: process.versions.sqlite, sourceHashes, platformAvailability: availablePlatforms },
      methodology: {
        chain: 'Authenticated real loopback HTTP -> production route -> SQLite WAL FULL; server and client are separate Node processes',
        fixture: 'Fixed persisted interrupted streaming draft plus synthetic archived messages, approvals and steps. No model execution or generated-token speed is measured.',
        historyBytes: [MiB, 4 * MiB], fixedOutputUtf8Bytes: Buffer.byteLength(FIXED_OUTPUT),
        contextLimitNote: 'The 4 MiB case measures storage reads below the 8 MiB session storage limit. It does not change or test the smaller model-context submission limit.',
        latency: 'bodyReceivedMs ends after complete response bytes arrive; withClientJsonParseMs additionally includes Node client JSON decoding/parsing. Semantic assertions are outside each request timer.',
        memory: 'Server-only process.memoryUsage sampled every 10 ms; forced GC only before/after each phase. Observed peak can miss synchronous spikes; lifetimeMaxRss is OS process high-water since worker startup, including seeding/warmup. RSS includes SQLite/native/network buffers, is not retained JS size, and need not fall after GC.',
        machineIsolation: 'Fresh process per endpoint/history size, but host CPU, disk and other applications are not pinned or exclusively reserved; small local measurements may vary.',
        queryLimit: 'Narrow HTTP response size is independent of history in these fixtures; SQLite still reads and extracts fields from stored JSON, so database latency is not claimed independent of history size.',
        limitations: 'No cloud model, browser painting, mobile execution, macOS execution or Linux execution is inferred from these Windows measurements.',
        maximumBenchmarkMs: 120_000, noPaidModels: true, noPlatformInstallationOrGlobalChanges: true,
      },
      comparison, cases,
    };
    await writeFile(join(project, 'docs/long-session-benchmark-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const child of workers) child.kill();
    const canonical = await realpath(directory);
    assert.equal(dirname(canonical), temporaryRoot);
    assert.match(canonical.slice(temporaryRoot.length + 1), /^openaster-long-session-benchmark-[a-zA-Z0-9]+$/);
    assert.equal(await readFile(join(canonical, '.benchmark-owner'), 'utf8'), owner);
    await rm(canonical, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  }
}

if (process.argv[2] === '--server-worker') await worker();
else await main();
