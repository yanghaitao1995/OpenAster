// SPDX-License-Identifier: Apache-2.0
// Original, deterministic local HTTP benchmark. No models, user workspaces or native builds.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../core/workspace.mjs';
import { startServer } from '../server/index.mjs';

const script = fileURLToPath(import.meta.url), project = path.resolve(import.meta.dirname, '..');
const QUERY = 'WORKSPACE_PERFORMANCE_NEEDLE', MiB = 2 ** 20;
const MAXIMUM_MS = 600_000, REQUEST_MS = 45_000, WARMUP = 1, REPEATS = 5;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const round = value => Number(value.toFixed(3));
const scenarios = [
  { id: 'root-with-rules', kind: 'list', options: { path: '', includeGenerated: false, includeIgnored: false } },
  { id: 'package-with-ancestor-rules', kind: 'list', options: { path: 'packages/p05', includeGenerated: false, includeIgnored: false } },
  { id: 'root-explicitly-included', kind: 'list', options: { path: '', includeGenerated: true, includeIgnored: true } },
  { id: 'scoped-content-search', kind: 'search', options: { path: 'src', includeGenerated: false, includeIgnored: false, caseSensitive: true } },
  { id: 'root-bounded-content-search', kind: 'search', options: { path: '', includeGenerated: false, includeIgnored: false, caseSensitive: true } },
];

async function hashes() {
  const files = ['package.json', 'pnpm-lock.yaml', 'scripts/benchmark-workspace-performance.mjs'];
  for (const directory of ['core', 'server']) {
    for (const entry of await fs.readdir(path.join(project, directory), { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink());
      if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(`${directory}/${entry.name}`);
    }
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, sha256(await fs.readFile(path.join(project, file)))])));
}

function memory() {
  return Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, value]) => [`${key}MiB`, round(value / MiB)]));
}
function stats(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return { samples: values.length, min: round(ordered[0]), p50: round(ordered[Math.ceil(ordered.length * .5) - 1]), p95: round(ordered[Math.ceil(ordered.length * .95) - 1]), max: round(ordered.at(-1)) };
}

async function worker() {
  assert.equal(typeof process.send, 'function');
  assert.equal(process.argv.length, 5);
  const directory = path.resolve(process.argv[3]), owner = process.argv[4];
  assert.match(owner, /^[a-f0-9]{64}$/u);
  assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(os.tmpdir()));
  assert.match(path.basename(directory), /^openaster-workspace-performance-[A-Za-z0-9]+$/u);
  assert.equal(await fs.readFile(path.join(directory, '.benchmark-owner'), 'utf8'), owner);
  let service, stopping = false, shutdown, interval, histogram, measurement;
  const stop = () => {
    stopping = true;
    if (service) shutdown ??= service.close();
    return shutdown ?? Promise.resolve();
  };
  process.on('disconnect', () => { clearInterval(interval); histogram?.disable(); stop().finally(() => process.exit()); });
  process.on('message', async message => {
    try {
      let result;
      if (message.op === 'stop') { await stop(); result = { stopped: true }; }
      else if (message.op === 'measure-start') {
        assert.ok(service && !stopping && !interval);
        global.gc?.();
        measurement = { before: memory(), peaks: memory(), samples: 0, cpu: process.cpuUsage() };
        histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
        interval = setInterval(() => {
          measurement.samples++;
          for (const [key, value] of Object.entries(memory())) measurement.peaks[key] = Math.max(measurement.peaks[key], value);
        }, 10);
        result = { started: true };
      } else if (message.op === 'measure-stop') {
        assert.ok(interval); clearInterval(interval); interval = undefined; histogram.disable();
        const after = memory(), cpu = process.cpuUsage(measurement.cpu);
        for (const [key, value] of Object.entries(after)) measurement.peaks[key] = Math.max(measurement.peaks[key], value);
        const eventLoop = histogram.count ? { samples: Number(histogram.count), meanMs: round(histogram.mean / 1e6), p95Ms: round(histogram.percentile(95) / 1e6), maxMs: round(histogram.max / 1e6) } : { samples: 0, meanMs: null, p95Ms: null, maxMs: null };
        global.gc?.();
        result = { before: measurement.before, observedPeak: measurement.peaks, after, afterForcedGc: memory(), samples: measurement.samples + 1, sampleIntervalMs: 10, lifetimeMaxRssMiB: round(process.resourceUsage().maxRSS / 1024), cpuUserMs: round(cpu.user / 1000), cpuSystemMs: round(cpu.system / 1000), eventLoop };
      } else throw new Error('Unknown benchmark control message');
      process.send({ id: message.id, result }, () => { if (message.op === 'stop') process.disconnect(); });
    } catch (error) { process.send({ id: message.id, error: String(error.message).slice(0, 2000) }); }
  });
  const workspacePath = path.join(directory, 'project');
  const expectedIdentity = await createWorkspace(workspacePath, { createRoot: false }).getIdentity();
  service = await startServer({ host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'data'), workspace: workspacePath,
    workspaceOptions: { createRoot: false, expectedIdentity, protectedRoots: [path.join(directory, 'data'), path.join(directory, 'app')], denySensitivePaths: true, projectScan: true } });
  if (stopping) { await stop(); process.disconnect(); return; }
  process.send({ ready: true, url: service.url, pid: process.pid });
}

async function seed(directory, signal) {
  const files = new Map([['.gitignore', 'cache/\n*.tmp\n**/generated/\n'], ['README.md', `${QUERY}\nSynthetic project only.\n`]]);
  const content = index => `// ${QUERY} ${index} 中文😀\r\n${'representative source line\n'.repeat(32)}`;
  for (let index = 0; index < 100; index++) files.set(`src/source-${String(index).padStart(3, '0')}.txt`, content(index));
  for (let part = 0; part < 12; part++) {
    const base = `packages/p${String(part).padStart(2, '0')}`;
    files.set(`${base}/.gitignore`, '!keep.tmp\n'); files.set(`${base}/keep.tmp`, content('keep'));
    for (let index = 0; index < 40; index++) files.set(`${base}/source-${String(index).padStart(2, '0')}.txt`, content(index));
    for (let index = 0; index < 20; index++) files.set(`${base}/temporary-${index}.tmp`, content(index));
    for (let index = 0; index < 30; index++) files.set(`${base}/generated/output-${index}.txt`, content(index));
  }
  for (let index = 0; index < 200; index++) files.set(`cache/cached-${index}.txt`, content(index));
  for (let index = 0; index < 2000; index++) files.set(`node_modules/dependency-${String(index).padStart(4, '0')}.js`, content(index));
  const fixtureDirectories = new Set(['']);
  for (const name of files.keys()) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') { fixtureDirectories.add(parent); parent = path.posix.dirname(parent); }
  }
  for (const name of ['project', 'data', 'app']) await fs.mkdir(path.join(directory, name));
  for (const name of [...fixtureDirectories].filter(Boolean).sort()) await fs.mkdir(path.join(directory, 'project', name), { recursive: true });
  const entries = [...files.entries()];
  for (let offset = 0; offset < entries.length; offset += 24) {
    signal.throwIfAborted();
    await Promise.all(entries.slice(offset, offset + 24).map(([name, value]) => fs.writeFile(path.join(directory, 'project', name), value, { flag: 'wx' })));
  }
  const manifest = entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => ({ path: name, bytes: Buffer.byteLength(value), sha256: sha256(value) }));
  return { files, fixture: { files: files.size, directories: fixtureDirectories.size - 1, packages: 12, sourceFiles: 580, nodeModulesFiles: 2000, ignoredTemporaryFiles: 240, ignoredGeneratedFiles: 360, ignoredCacheFiles: 200, ignoreFiles: 13, manifestSha256: sha256(JSON.stringify(manifest)), manifest } };
}

function verifyScenario(scenario, data, fixtureFiles) {
  assert.equal(data.scope, scenario.options.path); assert.equal(data.scan.projectMode, true);
  assert.equal(data.scan.includeGenerated, scenario.options.includeGenerated);
  assert.equal(data.scan.ignore.includeIgnored, scenario.options.includeIgnored);
  assert.equal(data.scan.skippedEntries, 0);
  if (scenario.id === 'root-with-rules') {
    assert.equal(data.files.length, 620); assert.equal(data.truncated, false); assert.deepEqual(data.scan.limits, []);
    assert.equal(data.scan.excludedDirectories, 1); assert.equal(data.scan.ignore.files, 13);
    assert.equal(data.scan.ignore.ignoredFiles, 240); assert.equal(data.scan.ignore.ignoredDirectories, 13);
  } else if (scenario.id === 'package-with-ancestor-rules') {
    assert.equal(data.files.length, 42); assert.equal(data.truncated, false); assert.deepEqual(data.scan.limits, []);
    assert.equal(data.scan.ignore.files, 2); assert.ok(data.files.some(entry => entry.path.endsWith('/keep.tmp')));
  } else if (scenario.id === 'root-explicitly-included') {
    assert.equal(data.files.length, 1000); assert.equal(data.truncated, true); assert.deepEqual(data.scan.limits, ['entries']);
    assert.equal(data.scan.ignore.enabled, false); assert.equal(data.scan.ignore.files, 0);
  } else {
    assert.equal(data.version, 1); assert.equal(data.query, QUERY); assert.equal(data.caseSensitive, true); assert.equal(data.searchedFiles, 100);
    if (scenario.id === 'scoped-content-search') { assert.equal(data.matches.length, 100); assert.equal(data.truncated, false); assert.deepEqual(data.scan.limits, []); }
    else { assert.ok(data.matches.length > 0); assert.ok(data.scan.limits.includes('search-files')); }
    for (const entry of data.matches) {
      assert.ok(fixtureFiles.has(entry.path)); assert.equal(entry.sha256, sha256(fixtureFiles.get(entry.path)));
      assert.equal(entry.line, 1); assert.equal(entry.text.slice(entry.matchStart, entry.matchEnd), QUERY);
    }
  }
  for (const entry of data.files ?? data.matches) {
    if (!scenario.options.includeIgnored) assert.ok(!entry.path.startsWith('cache') && !entry.path.includes('/generated') && !entry.path.includes('/temporary-'));
    if (!scenario.options.includeGenerated) assert.ok(!entry.path.startsWith('node_modules'));
    if (scenario.options.path) assert.ok(entry.path.startsWith(scenario.options.path + '/'));
  }
}

async function validateOutput(value) {
  assert.equal(typeof value, 'string'); assert.ok(value.endsWith('.json'));
  const output = path.resolve(project, value), relative = path.relative(project, output);
  assert.ok(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  let current = project;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment); const info = await fs.lstat(current);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Output parent must be an existing ordinary directory');
  }
  assert.equal(await fs.realpath(current), current);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  return { output, parent: current, identity: await fs.lstat(current, { bigint: true }) };
}

async function main() {
  assert.equal(process.argv.length, 4); assert.equal(process.argv[2], '--output');
  const destination = await validateOutput(process.argv[3]), sourceHashes = await hashes();
  const startedAt = new Date().toISOString(), started = performance.now(), signal = AbortSignal.timeout(MAXIMUM_MS);
  const temporaryParent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(temporaryParent, 'openaster-workspace-performance-'));
  const ownedIdentity = await fs.lstat(directory, { bigint: true }), owner = randomBytes(32).toString('hex');
  await fs.writeFile(path.join(directory, '.benchmark-owner'), owner, { flag: 'wx', mode: 0o600 });
  let child, childClosed, childHasClosed = false, failure, result, serial = 0, stderr = '', url, cleanupComplete = false;
  const pending = new Map();
  const terminateOwnedChild = () => { if (child && !childHasClosed) child.kill(); };
  signal.addEventListener('abort', terminateOwnedChild, { once: true });
  function rpc(op) {
    signal.throwIfAborted();
    return new Promise((accept, reject) => {
      const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('Benchmark worker control timed out')); }, 45_000);
      pending.set(id, { accept, reject, timer });
      child.send({ id, op }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
    });
  }
  async function awaitClosed(timeoutMs) {
    if (childHasClosed) return;
    let timer;
    try { await Promise.race([childClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned worker did not close; temporary directory retained')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  try {
    const { files: fixtureFiles, fixture } = await seed(directory, signal);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('OPENASTER_') || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
    child = fork(script, ['--worker', directory, owner], { execArgv: ['--expose-gc'], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
    childClosed = new Promise(resolve => child.once('close', (code, terminationSignal) => {
      childHasClosed = true;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Owned worker closed ${code}/${terminationSignal}: ${stderr}`)); }
      pending.clear(); resolve({ code, terminationSignal });
    }));
    const ready = new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('Benchmark worker startup timed out')), 45_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(new Error('Benchmark worker closed before readiness: ' + stderr)); });
      child.on('message', message => {
        if (message.ready) { clearTimeout(timer); accept(message); return; }
        const entry = pending.get(message.id); if (!entry) return;
        clearTimeout(entry.timer); pending.delete(message.id);
        message.error ? entry.reject(new Error(message.error)) : entry.accept(message.result);
      });
    });
    ({ url } = await ready); assert.equal(new URL(url).hostname, '127.0.0.1');
    const bootstrap = await fetch(url + '/api/bootstrap', { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    assert.equal(bootstrap.status, 200); const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
    const { csrfToken } = await bootstrap.json(); assert.ok(cookie && csrfToken);
    const unauthorized = await fetch(url + '/api/workspace', { signal: AbortSignal.timeout(5000) }); assert.equal(unauthorized.status, 401); await unauthorized.arrayBuffer();
    const missingCsrf = await fetch(url + '/api/workspace/search', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: url }, body: JSON.stringify({ query: QUERY, path: 'src' }), signal: AbortSignal.timeout(5000) });
    assert.equal(missingCsrf.status, 403); await missingCsrf.arrayBuffer();
    async function request(kind, options, query = QUERY) {
      signal.throwIfAborted(); const start = performance.now();
      const route = kind === 'list' ? '/api/workspace?' + new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)])) : '/api/workspace/search';
      const response = await fetch(url + route, { method: kind === 'list' ? 'GET' : 'POST', headers: { cookie, origin: url, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        ...(kind === 'search' ? { body: JSON.stringify({ query, ...options }) } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]) });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const bytes = Buffer.from(await response.arrayBuffer()), received = performance.now();
      const data = JSON.parse(bytes.toString('utf8')), parsed = performance.now();
      return { data, metrics: { responseBodyReceivedMs: round(received - start), responseWithClientJsonParseMs: round(parsed - start), clientJsonParseMs: round(parsed - received), jsonBytes: bytes.length, responseSha256: sha256(bytes), resultSha256: sha256(JSON.stringify(data)) } };
    }
    const cases = [];
    for (const scenario of scenarios) {
      const warmup = await request(scenario.kind, scenario.options); verifyScenario(scenario, warmup.data, fixtureFiles);
      await rpc('measure-start'); const samples = [];
      for (let index = 0; index < REPEATS; index++) {
        const value = await request(scenario.kind, scenario.options); verifyScenario(scenario, value.data, fixtureFiles);
        assert.deepEqual(value.data, warmup.data, 'Complete response changed between identical requests');
        assert.equal(value.metrics.responseSha256, warmup.metrics.responseSha256); samples.push(value.metrics);
      }
      const serverResources = await rpc('measure-stop');
      cases.push({ ...scenario, transport: 'authenticated-loopback-http', warmupRequestsDiscarded: WARMUP, measuredRequests: REPEATS, concurrency: 1,
        responseSha256: warmup.metrics.responseSha256, jsonBytes: warmup.metrics.jsonBytes, result: warmup.data, samples,
        latency: Object.fromEntries(['responseBodyReceivedMs', 'responseWithClientJsonParseMs', 'clientJsonParseMs'].map(key => [key, stats(samples.map(sample => sample[key]))])), serverResources });
      console.log(JSON.stringify({ case: scenario.id, p50Ms: cases.at(-1).latency.responseBodyReceivedMs.p50, responseSha256: warmup.metrics.responseSha256 }));
    }
    // Non-timed consistency checks run in this SAME server/workspace object after warm requests.
    const mutationRoot = path.join(directory, 'project', 'mutations'); await fs.mkdir(mutationRoot);
    const a = path.join(mutationRoot, 'a.txt'), b = path.join(mutationRoot, 'b.txt'), rule = path.join(mutationRoot, '.gitignore');
    const beforeText = 'visibility OLD 中文😀\r\n', afterText = 'visibility NEW 中文😀\r\n';
    assert.equal(Buffer.byteLength(beforeText), Buffer.byteLength(afterText));
    await fs.writeFile(a, beforeText, { flag: 'wx' }); await fs.writeFile(b, 'second ordinary file\n', { flag: 'wx' });
    const mutationChecks = [];
    async function mutation(id, kind, options, query, check) {
      const value = await request(kind, options, query); check(value.data);
      mutationChecks.push({ id, responseSha256: value.metrics.responseSha256, result: value.data });
    }
    const scoped = { path: 'mutations' }, expectFiles = names => data => assert.deepEqual(data.files.map(entry => entry.path).sort(), names.map(name => 'mutations/' + name).sort());
    await mutation('created-directory-visible', 'list', scoped, QUERY, expectFiles(['a.txt', 'b.txt']));
    await mutation('old-content-present', 'search', scoped, 'OLD', data => { assert.equal(data.matches.length, 1); assert.equal(data.matches[0].sha256, sha256(beforeText)); });
    const originalTime = await fs.stat(a); await fs.writeFile(a, afterText); await fs.utimes(a, originalTime.atime, originalTime.mtime);
    await mutation('same-length-rewrite-old-content-gone', 'search', scoped, 'OLD', data => assert.equal(data.matches.length, 0));
    await mutation('same-length-rewrite-new-hash', 'search', scoped, 'NEW', data => { assert.equal(data.matches.length, 1); assert.equal(data.matches[0].sha256, sha256(afterText)); });
    await fs.writeFile(rule, 'a.txt\n', { flag: 'wx' });
    await mutation('previously-missing-ignore-created', 'list', scoped, QUERY, expectFiles(['.gitignore', 'b.txt']));
    await mutation('ignore-created-affects-search', 'search', scoped, 'NEW', data => assert.equal(data.matches.length, 0));
    await mutation('explicit-override-is-request-local', 'list', { ...scoped, includeIgnored: true }, QUERY, data => { expectFiles(['.gitignore', 'a.txt', 'b.txt'])(data); assert.equal(data.scan.ignore.enabled, false); });
    await mutation('override-does-not-leak', 'list', scoped, QUERY, expectFiles(['.gitignore', 'b.txt']));
    const ruleTime = await fs.stat(rule); await fs.writeFile(rule, 'b.txt\n'); await fs.utimes(rule, ruleTime.atime, ruleTime.mtime);
    await mutation('same-length-rule-rewrite-visible', 'list', scoped, QUERY, expectFiles(['.gitignore', 'a.txt']));
    await mutation('rule-rewrite-affects-search', 'search', scoped, 'NEW', data => { assert.equal(data.matches.length, 1); assert.equal(data.matches[0].sha256, sha256(afterText)); });
    await fs.unlink(rule); await mutation('ignore-removal-visible', 'list', scoped, QUERY, expectFiles(['a.txt', 'b.txt']));
    await fs.unlink(a); await fs.writeFile(path.join(mutationRoot, 'c.txt'), 'replacement ordinary file\n', { flag: 'wx' });
    await mutation('delete-create-visible', 'list', scoped, QUERY, expectFiles(['b.txt', 'c.txt']));
    await mutation('deleted-content-not-reused', 'search', scoped, 'NEW', data => assert.equal(data.matches.length, 0));
    await rpc('stop'); await awaitClosed(15_000); assert.ok(childHasClosed);
    assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
    assert.deepEqual(await hashes(), sourceHashes, 'Sources changed during benchmark');
    result = { version: 1, passed: true, startedAt, measuredAt: new Date().toISOString(), elapsedMs: round(performance.now() - started),
      environment: { node: process.version, platform: process.platform, release: os.release(), architecture: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryGiB: round(os.totalmem() / 2 ** 30), sqlite: process.versions.sqlite },
      sourceHashes, fixture, cases, mutationChecks, authentication: { unauthenticatedListStatus: 401, missingSearchCsrfStatus: 403 },
      methodology: { client: 'Separate parent process. Timed real authenticated GET /api/workspace and CSRF-protected POST /api/workspace/search; receive-all-body and client-JSON parsing are reported separately. No IPC substitute for search.',
        worker: 'One fresh Node service process and pinned external-style workspace identity for all cases, including between-request mutation checks. Loopback port 0; separate data/app protected roots; createRoot false, denySensitivePaths true, projectScan true.',
        repetitions: 'One discarded warmup and five sequential measured requests per case. Nearest-rank p95 with five samples is only the observed maximum, not a population tail/SLA.',
        correctness: 'Every measured response is deeply equal to its warmup, including ordered paths, snippets, file hashes, scan counters, policy and truncation. Fixture/response digests enable identical-harness before/after comparison. Non-timed modifications retain byte length and restore mtime where stated, but do not claim control of filesystem ctime.',
        resources: 'Worker-only memory, CPU and 10ms event-loop samples across each five-request phase; excludes parent parsing/fixture creation. Sampling can miss short spikes; lifetime RSS includes startup/warmup. GC only at phase boundaries.',
        comparison: 'Compare only matching harness hash, fixture manifest hash, safety options, case definitions and complete response digests. Archive before/after separately; no automatic baseline overwrite.',
        limitations: 'Warm-cache-oriented synthetic local Windows measurements; host CPU, disk and OS cache are shared. No cold-cache, pure-kernel, native GUI, mobile, network-filesystem, cloud-model or cross-platform performance claims. Capped listing/search are partial inventories, not complete-project scans. Identity replacement and concurrent hostile mutation belong to separate safety regressions.',
        maximumMs: MAXIMUM_MS, requestTimeoutMs: REQUEST_MS, noModelRequests: true, noGlobalChanges: true },
      worker: { pid: child.pid, exited: true, stderr }, sourceUnchanged: true };
  } catch (error) { failure = error; }
  finally {
    signal.removeEventListener('abort', terminateOwnedChild);
    if (child && !childHasClosed) { terminateOwnedChild(); try { await awaitClosed(10_000); } catch (error) { failure ??= error; } }
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Benchmark cleanup')); } pending.clear();
    if (!child || childHasClosed) {
      try {
        const canonical = await fs.realpath(directory), current = await fs.lstat(directory, { bigint: true });
        assert.equal(path.dirname(canonical), temporaryParent); assert.equal(canonical, directory);
        assert.match(path.basename(canonical), /^openaster-workspace-performance-[A-Za-z0-9]+$/u);
        assert.ok(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.dev, ownedIdentity.dev); assert.equal(current.ino, ownedIdentity.ino);
        assert.equal(await fs.readFile(path.join(directory, '.benchmark-owner'), 'utf8'), owner);
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 }); cleanupComplete = true;
      } catch (error) { failure ??= error; }
    }
  }
  if (failure) result = { version: 1, passed: false, startedAt, finishedAt: new Date().toISOString(), sourceHashes, error: { code: failure.code ?? null, message: failure.message }, workerStderr: stderr, workerExited: childHasClosed, ...(cleanupComplete ? {} : { retainedTemporaryDirectory: directory }) };
  result.temporaryResourcesCleaned = cleanupComplete;
  const currentDestination = await validateOutput(process.argv[3]); assert.equal(currentDestination.parent, destination.parent);
  assert.equal(currentDestination.identity.dev, destination.identity.dev); assert.equal(currentDestination.identity.ino, destination.identity.ino);
  const output = await fs.open(destination.output, 'wx', 0o600);
  try { await output.writeFile(JSON.stringify(result, null, 2) + '\n'); await output.sync(); } finally { await output.close(); }
  console.log(JSON.stringify({ passed: result.passed, output: path.relative(project, destination.output), elapsedMs: result.elapsedMs ?? round(performance.now() - started), cases: result.cases?.length ?? 0, mutationChecks: result.mutationChecks?.length ?? 0, sourceHashes: Object.keys(sourceHashes).length, temporaryResourcesCleaned: cleanupComplete, ...(failure ? { error: result.error } : {}) }));
  if (failure) process.exitCode = 1;
}

if (process.argv[2] === '--worker') await worker();
else await main();
