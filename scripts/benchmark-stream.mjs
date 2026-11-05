// SPDX-License-Identifier: Apache-2.0
// Deterministic loopback measurements, never a paid/cloud model or user-data benchmark.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from '../core/runtime.mjs';
import { callProvider } from '../core/providers.mjs';
import { Store } from '../server/store.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const intervalMs = 15;
const fragments = Array.from({ length: 60 }, (_, index) => `第${String(index + 1).padStart(2, '0')}片中文。`);
const expectedText = fragments.join('');
const repeats = 3;
const deadline = AbortSignal.timeout(60_000);
const temporaryRoot = await realpath(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, 'openaster-stream-benchmark-'));
const ownership = randomBytes(32).toString('hex');
await writeFile(join(directory, '.benchmark-owner'), ownership, { flag: 'wx', mode: 0o600 });
const requests = new Map();
const pendingTimers = new Set();
const liveRuntimes = new Set();
let activeRequests = 0;
let peakRequests = 0;
let scenarioNumber = 0;
const number = value => value == null ? null : Number(value.toFixed(3));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {};
for (const relative of ['core/workspace.mjs', 'core/workspace-ignore.mjs', 'core/workspace-search.mjs', 'core/sensitive-paths.mjs', 'core/runtime.mjs', 'core/providers.mjs', 'core/provider-stream.mjs', 'core/provider-terminal.mjs', 'core/usage.mjs', 'core/usage-overview.mjs', 'server/store.mjs', 'core/context-files.mjs', 'core/conversation-branch.mjs', 'core/context-planner.mjs', 'core/tool-artifacts.mjs', 'core/run-history.mjs', 'server/lock.mjs', 'scripts/benchmark-stream.mjs']) sourceHashes[relative] = sha256(await readFile(join(project, relative)));

async function until(condition, timeoutMs = 8_000) {
  const start = performance.now();
  while (!condition()) {
    deadline.throwIfAborted();
    if (performance.now() - start > timeoutMs) throw new Error('Streaming benchmark timed out');
    await delay(2, undefined, { signal: deadline });
  }
}

const server = createServer(async (request, response) => {
  let state;
  let timer;
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') throw new Error('Unexpected benchmark route');
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error('Oversized benchmark request');
    }
    const input = JSON.parse(body);
    state = requests.get(input.model);
    if (!state || input.stream !== true || state.requestReceivedAt != null) throw new Error('Unexpected benchmark request');
    state.requestReceivedAt = performance.now();
    activeRequests++;
    peakRequests = Math.max(peakRequests, activeRequests);
    response.on('close', () => {
      clearTimeout(timer);
      pendingTimers.delete(timer);
      activeRequests--;
      state.responseClosedAt = performance.now();
    });
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.flushHeaders();
    function schedule() {
      timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (response.destroyed) return;
        const delta = fragments[state.sentFragments];
        state.firstSentAt ??= performance.now();
        state.sentAt.push(performance.now());
        state.sentFragments++;
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`);
        if (state.sentFragments < fragments.length) schedule();
        else {
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          response.end('data: [DONE]\n\n');
          state.finishedSendingAt = performance.now();
        }
      }, intervalMs);
      pendingTimers.add(timer);
    }
    schedule();
  } catch (error) {
    if (state) state.transportError = error.message;
    if (!response.headersSent) response.writeHead(500);
    response.end('Local benchmark fixture rejected its request');
  }
});
server.requestTimeout = 10_000;
server.headersTimeout = 5_000;

function distribution(values) {
  const sorted = values.filter(value => value != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const percentile = fraction => number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
  return { samples: sorted.length, min: number(sorted[0]), p50: percentile(.5), p95: percentile(.95), max: number(sorted.at(-1)) };
}

function summarize(runs) {
  const metrics = ['firstFragmentPersistedFromStartMs', 'firstFragmentPersistedFromMockSendMs', 'totalMs', 'checkpointWrites', 'allSessionWrites', 'serializedSessionBytesWritten', 'cancelToDurableTerminalMs', 'cancelToTransportClosedMs'];
  return Object.fromEntries(metrics.map(key => [key, distribution(runs.map(run => run[key]))]));
}

async function scenario({ name, concurrency = 1, checkpointMs = 200, cancel = false }) {
  const folder = join(directory, `case-${++scenarioNumber}`);
  await mkdir(join(folder, 'workspace'), { recursive: true });
  const store = new Store(join(folder, 'database'));
  const states = new Map();
  const bySession = new Map();
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const runtime = createRuntime({
    workspace: join(folder, 'workspace'),
    providers: async id => ({ id, type: 'openai', model: id, baseUrl, streaming: true, maxTokens: 1024 }),
    getSession: id => store.getSession(id),
    saveSession: (session, metadata) => {
      const state = bySession.get(session.id);
      const writeStart = performance.now();
      store.putSession(session, metadata);
      const persistedAt = performance.now();
      state.allSessionWrites++;
      state.serializedSessionBytesWritten += Buffer.byteLength(JSON.stringify(session));
      state.sessionWriteDurationsMs.push(persistedAt - writeStart);
      if (session.run?.output?.status === 'streaming') {
        state.checkpointWrites++;
        state.checkpointTimes.push(persistedAt);
        if (state.firstPersistedAt == null) {
          // Verify that the measured checkpoint is readable from the actual SQLite database.
          assert.equal(store.getSession(session.id).run.output.content, session.run.output.content);
          state.firstPersistedAt = persistedAt;
        }
      }
      if (['completed', 'cancelled', 'failed'].includes(session.run?.status)) state.terminalPersistedAt = persistedAt;
    },
    emit: event => { if (event.type === 'stream') bySession.get(event.sessionId).checkpointEvents++; },
    audit: entry => store.audit(entry),
    providerCall: (provider, options) => callProvider(provider, {
      ...options,
      onText: async text => {
        const state = states.get(provider.id);
        state.receivedFragments++;
        state.firstCallbackAt ??= performance.now();
        await options.onText(text);
      },
      timeoutMs: 6_000,
    }),
    limits: { maxConcurrent: 4, streamCheckpointMs: checkpointMs, maxRunMs: 8_000 },
  });
  liveRuntimes.add(runtime);
  peakRequests = 0;
  try {
    for (let index = 0; index < concurrency; index++) {
      const model = `benchmark-${scenarioNumber}-${index}`;
      const session = store.createSession({ title: '确定性本机流式性能样本', providerId: model });
      const state = { model, sessionId: session.id, sentFragments: 0, receivedFragments: 0, sentAt: [], checkpointTimes: [], checkpointWrites: 0, checkpointEvents: 0, allSessionWrites: 0, serializedSessionBytesWritten: 0, sessionWriteDurationsMs: [] };
      states.set(model, state);
      bySession.set(session.id, state);
      requests.set(model, state);
    }
    const wallStart = performance.now();
    await Promise.all([...states.values()].map(async state => {
      state.startedAt = performance.now();
      await runtime.start(state.sessionId, { content: '请逐片段返回中文测试文本。' });
    }));
    if (cancel) {
      await until(() => [...states.values()].every(state => state.receivedFragments >= 8 && state.firstPersistedAt != null));
      for (const state of states.values()) {
        state.cancelAt = performance.now();
        runtime.cancel(state.sessionId);
      }
    }
    await until(() => [...states.values()].every(state => !runtime.isActive(state.sessionId)));
    const wallMs = performance.now() - wallStart;
    await until(() => [...states.values()].every(state => state.responseClosedAt != null));
    assert.equal(peakRequests, concurrency);
    const runs = [...states.values()].map(state => {
      const saved = store.getSession(state.sessionId);
      assert.equal(state.transportError, undefined);
      assert.equal(saved.run.status, cancel ? 'cancelled' : 'completed', JSON.stringify(saved.run.error));
      assert.ok(state.firstPersistedAt != null, 'No partial text was durably persisted before completion');
      assert.equal(state.checkpointEvents, state.checkpointWrites);
      if (cancel) {
        assert.equal(saved.run.output.status, 'interrupted');
        assert.ok(expectedText.startsWith(saved.run.output.content));
        assert.equal(saved.messages.filter(message => message.role === 'assistant').length, 0);
        assert.ok(state.sentFragments < fragments.length);
      } else {
        assert.equal(saved.messages.at(-1).content, expectedText);
        assert.equal(saved.run.output, null);
        assert.equal(state.receivedFragments, fragments.length);
      }
      return {
        firstFragmentPersistedFromStartMs: number(state.firstPersistedAt - state.startedAt),
        firstFragmentPersistedFromMockSendMs: number(state.firstPersistedAt - state.firstSentAt),
        firstFragmentCallbackFromMockSendMs: number(state.firstCallbackAt - state.firstSentAt),
        totalMs: number(state.terminalPersistedAt - state.startedAt),
        cancelToDurableTerminalMs: cancel ? number(state.terminalPersistedAt - state.cancelAt) : null,
        cancelToTransportClosedMs: cancel ? number(state.responseClosedAt - state.cancelAt) : null,
        sentFragments: state.sentFragments, receivedFragments: state.receivedFragments,
        checkpointWrites: state.checkpointWrites, allSessionWrites: state.allSessionWrites,
        serializedSessionBytesWritten: state.serializedSessionBytesWritten,
        sessionWriteDurationMs: distribution(state.sessionWriteDurationsMs),
        observedMockInterFragmentMs: distribution(state.sentAt.slice(1).map((time, index) => time - state.sentAt[index])),
        terminalStatus: saved.run.status,
      };
    });
    return { name, concurrency, checkpointMs, wallMs: number(wallMs), peakConcurrentHttpRequests: peakRequests, runs };
  } finally {
    await runtime.shutdown();
    liveRuntimes.delete(runtime);
    store.close();
    for (const model of states.keys()) requests.delete(model);
  }
}

try {
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  await scenario({ name: 'warmup-discarded' });
  const cases = [];
  // Interleave the two single-stream settings to reduce simple warm-cache/order bias.
  for (let repeat = 0; repeat < repeats; repeat++) {
    cases.push(await scenario({ name: 'coalesced-single', checkpointMs: 200 }));
    cases.push(await scenario({ name: 'per-fragment-comparison', checkpointMs: 1 }));
    cases.push(await scenario({ name: 'coalesced-four', checkpointMs: 200, concurrency: 4 }));
    cases.push(await scenario({ name: 'cancellation', checkpointMs: 200, cancel: true }));
  }
  const grouped = Object.fromEntries(['coalesced-single', 'per-fragment-comparison', 'coalesced-four', 'cancellation'].map(name => [name, cases.filter(value => value.name === name).flatMap(value => value.runs)]));
  const summary = Object.fromEntries(Object.entries(grouped).map(([name, runs]) => [name, summarize(runs)]));
  const total = (name, key) => grouped[name].reduce((sum, run) => sum + run[key], 0);
  const reduction = key => number((1 - total('coalesced-single', key) / total('per-fragment-comparison', key)) * 100);
  for (const [relative, hash] of Object.entries(sourceHashes)) assert.equal(sha256(await readFile(join(project, relative))), hash, `Source changed during benchmark: ${relative}; rerun after freeze`);
  const result = {
    measuredAt: new Date().toISOString(),
    environment: { node: process.version, os: `${platform()} ${release()}`, architecture: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryGiB: number(totalmem() / 2 ** 30), sqlite: process.versions.sqlite, sourceHashes },
    methodology: {
      chain: 'Real loopback HTTP SSE -> callProvider -> createRuntime -> Store SQLite WAL synchronous=FULL',
      provider: 'Deterministic OpenAI-compatible local mock; no external or paid model',
      fragmentsPerCompletedRun: fragments.length, targetInterFragmentMs: intervalMs,
      content: expectedText, repeatsPerScenario: repeats, discardedWarmups: 1,
      normalCheckpointMs: 200, comparisonCheckpointMs: 1,
      comparisonMeaning: 'One visible mock fragment per event; fragments are not measured tokenizer tokens. The 1 ms checkpoint setting approximates per-fragment persistence; actual writes are counted.',
      clock: 'Monotonic performance.now(); first persistence ends when synchronous SQLite write returns, with first partial snapshot read back',
      cancellation: 'Call runtime.cancel after at least 8 parsed fragments and one saved partial snapshot; measure durable cancelled status and mock response close',
      byteMetric: 'Serialized session JSON bytes submitted to SQLite, excluding audit and terminal run_history rows; not all SQL writes or filesystem/WAL physical bytes',
      limitations: 'Small deterministic local samples, not cloud-model latency, model throughput, mobile speed, browser painting, cross-machine SLA or durable-power-loss testing. SQLite FULL requests durability from the local OS/storage.',
      maximumBenchmarkMs: 60_000, temporaryUserDataOnly: true,
    },
    summary,
    comparison: { checkpointWriteReductionPercent: reduction('checkpointWrites'), totalSessionWriteReductionPercent: reduction('allSessionWrites'), serializedSessionByteReductionPercent: reduction('serializedSessionBytesWritten') },
    cases,
  };
  await writeFile(join(project, 'docs/stream-benchmark-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const timer of pendingTimers) clearTimeout(timer);
  server.closeAllConnections();
  await Promise.allSettled([...liveRuntimes].map(runtime => runtime.shutdown()));
  await new Promise(accept => server.close(accept));
  const canonical = await realpath(directory);
  if (dirname(canonical) !== temporaryRoot || !/^openaster-stream-benchmark-[a-zA-Z0-9]+$/.test(canonical.slice(temporaryRoot.length + 1)) || await readFile(join(canonical, '.benchmark-owner'), 'utf8') !== ownership) throw new Error('Refusing unsafe benchmark cleanup');
  await rm(canonical, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
