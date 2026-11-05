// SPDX-License-Identifier: Apache-2.0
// Original local HTTP benchmark: a directory view and a recursive inventory are different products.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { fork } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../core/workspace.mjs';
import { startServer } from '../server/index.mjs';

const SCRIPT = fileURLToPath(import.meta.url), PROJECT = path.resolve(import.meta.dirname, '..');
const PREFIX = 'openaster-workspace-directory-', WARMUP = 1, REPEATS = 3;
const MAX_MS = 300_000, REQUEST_MS = 30_000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const round = value => Number(value.toFixed(3));
const identityEqual = (actual, expected) => { assert.equal(actual.dev, expected.dev); assert.equal(actual.ino, expected.ino); };
const identity = value => ({ dev: String(value.dev), ino: String(value.ino) });

async function sourceHashes() {
  const files = ['package.json', 'pnpm-lock.yaml', 'scripts/benchmark-workspace-directory.mjs'];
  for (const directory of ['core', 'server']) {
    for (const entry of await fs.readdir(path.join(PROJECT, directory), { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink());
      if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(`${directory}/${entry.name}`);
    }
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, sha256(await fs.readFile(path.join(PROJECT, file)))])));
}

async function verifyOwned(directory, owner, expected) {
  const parent = await fs.realpath(os.tmpdir()), actual = await fs.lstat(directory, { bigint: true });
  assert.ok(actual.isDirectory() && !actual.isSymbolicLink());
  assert.equal(await fs.realpath(directory), directory); assert.equal(path.dirname(directory), parent);
  assert.match(path.basename(directory), /^openaster-workspace-directory-[A-Za-z0-9]+$/u);
  if (expected) identityEqual(actual, expected);
  const marker = path.join(directory, '.benchmark-owner'), markerStat = await fs.lstat(marker);
  assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1);
  assert.equal(await fs.readFile(marker, 'utf8'), owner);
  return actual;
}

async function worker() {
  assert.equal(process.argv.length, 5); assert.equal(typeof process.send, 'function');
  const directory = path.resolve(process.argv[3]), owner = process.argv[4];
  assert.match(owner, /^[a-f0-9]{64}$/u); await verifyOwned(directory, owner);
  let service, stopping = false, shutdown;
  const stop = async () => { stopping = true; if (service) await (shutdown ??= service.close()); };
  process.on('disconnect', () => { stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
  process.on('message', message => {
    if (message?.op !== 'stop') return;
    stop().then(() => { if (process.connected) process.disconnect(); }).catch(error => { console.error(error.message); process.exitCode = 1; if (process.connected) process.disconnect(); });
  });
  const workspace = path.join(directory, 'project');
  const expectedIdentity = await createWorkspace(workspace, { createRoot: false }).getIdentity();
  service = await startServer({ host: '127.0.0.1', port: 0, dataDir: path.join(directory, 'data'), workspace,
    workspaceOptions: { createRoot: false, expectedIdentity, protectedRoots: [path.join(directory, 'data'), path.join(directory, 'app')], denySensitivePaths: true, projectScan: true } });
  if (stopping) { await stop(); if (process.connected) process.disconnect(); return; }
  process.send({ ready: true, url: service.url, pid: process.pid, expectedIdentity });
}

async function seed(directory, signal) {
  const files = new Map([
    ['.gitignore', '*.tmp\n'], ['README.md', 'Synthetic directory benchmark 中文😀\r\n'],
    ['hidden.tmp', 'Ignored fixture\n'], ['node_modules/small.js', 'Generated fixture\n'],
  ]);
  for (let i = 0; i < 10; i++) files.set(`docs/guide-${String(i).padStart(2, '0')}.md`, `Guide ${i}\n`);
  for (let pkg = 0; pkg < 8; pkg++) {
    const base = `packages/pkg-${String(pkg).padStart(2, '0')}`;
    files.set(`${base}/README.md`, `Package ${pkg}\r\n`);
    files.set(`${base}/package.json`, JSON.stringify({ name: `fixture-${pkg}`, private: true }) + '\n');
    for (const folder of ['src', 'test', 'notes']) for (let i = 0; i < 12; i++) {
      files.set(`${base}/${folder}/file-${String(i).padStart(2, '0')}.txt`, `\uFEFF${folder} ${pkg}/${i} 中文😀\r\nKEY_OLD\r\n`);
    }
  }
  for (const name of ['project', 'data', 'app']) await fs.mkdir(path.join(directory, name));
  const directories = new Set();
  for (const name of files.keys()) for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir);
  for (const dir of [...directories].sort()) await fs.mkdir(path.join(directory, 'project', dir), { recursive: true });
  const entries = [...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (let offset = 0; offset < entries.length; offset += 16) {
    signal.throwIfAborted();
    await Promise.all(entries.slice(offset, offset + 16).map(([name, content]) => fs.writeFile(path.join(directory, 'project', name), content, { flag: 'wx' })));
  }
  const manifest = entries.map(([name, content]) => ({ path: name, bytes: Buffer.byteLength(content), sha256: sha256(content) }));
  return { contents: files, fixture: { files: files.size, directories: directories.size, visibleRecursiveEntries: 350, generatedFiles: 1, ignoredFiles: 1, manifestSha256: sha256(JSON.stringify(manifest)), manifest } };
}

async function destination(value) {
  assert.equal(typeof value, 'string');
  const output = path.resolve(PROJECT, value), parent = path.join(PROJECT, '.diagnostics');
  assert.equal(path.dirname(output), parent);
  assert.match(path.basename(output), /^workspace-directory-benchmark(?:-[A-Za-z0-9_-]+)?\.json$/u);
  const stat = await fs.lstat(parent, { bigint: true });
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); assert.equal(await fs.realpath(parent), parent);
  await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  return { output, identity: stat };
}

function stats(samples, key) {
  const values = samples.map(item => item[key]).sort((a, b) => a - b);
  return { count: values.length, min: values[0], p50: values[Math.ceil(values.length / 2) - 1], p95: values[Math.ceil(values.length * .95) - 1], max: values.at(-1) };
}
function directChildren(files, scope) {
  return files.filter(item => path.posix.dirname(item.path) === (scope || '.'));
}
function validateListing(data, kind, scope) {
  assert.equal(data.scope, scope); assert.equal(data.name, 'project');
  assert.equal(data.truncated, false); assert.deepEqual(data.scan.limits, []);
  assert.equal(data.scan.projectMode, true); assert.equal(data.scan.includeGenerated, false);
  assert.equal(data.scan.ignore.enabled, true); assert.equal(data.scan.ignore.includeIgnored, false);
  assert.equal(data.scan.skippedEntries, 0);
  assert.ok(data.files.every(item => !item.path.startsWith('node_modules') && item.path !== 'hidden.tmp'));
  if (kind === 'directory') {
    assert.equal(data.version, 1); assert.equal(data.listing, 'children');
    assert.deepEqual(data.files, directChildren(data.files, scope));
  } else assert.equal(Object.hasOwn(data, 'listing'), false);
}

async function main() {
  assert.equal(process.argv.length, 4); assert.equal(process.argv[2], '--output');
  const output = await destination(process.argv[3]), hashes = await sourceHashes();
  const startedAt = new Date().toISOString(), started = performance.now(), signal = AbortSignal.timeout(MAX_MS);
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), PREFIX));
  const owned = await fs.lstat(directory, { bigint: true }), owner = randomBytes(32).toString('hex');
  await fs.writeFile(path.join(directory, '.benchmark-owner'), owner, { flag: 'wx', mode: 0o600 });
  let child, closed, hasClosed = false, stderr = '', failure, cleaned = false, report;
  const cases = [], comparisons = [], mutationChecks = [];
  const terminateOwned = () => { if (child && !hasClosed) child.kill(); };
  signal.addEventListener('abort', terminateOwned, { once: true });
  async function waitClosed(ms) {
    let timer;
    try { return await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned service did not exit; temporary directory retained')), ms); })]); }
    finally { clearTimeout(timer); }
  }
  try {
    const { contents, fixture } = await seed(directory, signal);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('OPENASTER_') || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
    child = fork(SCRIPT, ['--worker', directory, owner], { execArgv: [], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
    closed = new Promise(resolve => child.once('close', (code, terminationSignal) => { hasClosed = true; resolve({ code, terminationSignal }); }));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned service startup timed out')), 30_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', () => { clearTimeout(timer); reject(new Error('Owned service closed before readiness: ' + stderr)); });
      child.on('message', message => { if (message?.ready) { clearTimeout(timer); resolve(message); } });
    });
    assert.equal(ready.pid, child.pid);
    const origin = new URL(ready.url); assert.equal(origin.hostname, '127.0.0.1'); assert.equal(origin.protocol, 'http:');
    const bootstrap = await fetch(ready.url + '/api/bootstrap', { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    assert.equal(bootstrap.status, 200); const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
    const state = await bootstrap.json(); assert.ok(cookie); assert.equal(state.capabilities.workspaceDirectory, 1);
    const unauthorized = await fetch(ready.url + '/api/workspace/directory', { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    assert.equal(unauthorized.status, 401); await unauthorized.arrayBuffer();
    async function request(route) {
      signal.throwIfAborted(); const start = performance.now();
      const response = await fetch(ready.url + route, { headers: { cookie }, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]) });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const bytes = Buffer.from(await response.arrayBuffer()), received = performance.now();
      const data = JSON.parse(bytes.toString('utf8')), parsed = performance.now();
      return { data, sample: { responseBodyReceivedMs: round(received - start), responseWithClientJsonParseMs: round(parsed - start), jsonBytes: bytes.length, responseSha256: sha256(bytes), resultSha256: sha256(JSON.stringify(data)) } };
    }
    const listing = (kind, scope) => request((kind === 'directory' ? '/api/workspace/directory?' : '/api/workspace?') + new URLSearchParams({ path: scope, includeGenerated: 'false', includeIgnored: 'false' }));
    for (const scope of ['', 'packages/pkg-02']) {
      const byKind = {};
      for (const kind of ['recursive', 'directory']) {
        const warmup = await listing(kind, scope); validateListing(warmup.data, kind, scope);
        byKind[kind] = { kind, scope, warmupRequestsDiscarded: WARMUP, measuredRequests: REPEATS, warmup: warmup.sample, result: warmup.data, samples: [] };
      }
      for (let sample = 0; sample < REPEATS; sample++) {
        for (const kind of sample % 2 === 0 ? ['directory', 'recursive'] : ['recursive', 'directory']) {
          const value = await listing(kind, scope), baseline = byKind[kind];
          validateListing(value.data, kind, scope); assert.deepEqual(value.data, baseline.result);
          assert.equal(value.sample.responseSha256, baseline.warmup.responseSha256);
          baseline.samples.push({ order: sample, ...value.sample, visitedEntries: value.data.scan.visitedEntries, returnedItems: value.data.files.length, truncated: value.data.truncated });
        }
      }
      assert.deepEqual(byKind.directory.result.files, directChildren(byKind.recursive.result.files, scope));
      assert.equal(byKind.recursive.result.files.length, scope ? 41 : 350);
      assert.equal(byKind.directory.result.files.length, scope ? 5 : 4);
      for (const value of Object.values(byKind)) {
        value.latency = { bodyReceivedMs: stats(value.samples, 'responseBodyReceivedMs'), withJsonParseMs: stats(value.samples, 'responseWithClientJsonParseMs') };
        value.scan = value.result.scan; value.returnedItems = value.result.files.length; value.truncated = value.result.truncated;
        cases.push(value);
      }
      comparisons.push({ scope, directoryEqualsRecursiveDirectChildProjection: true, recursiveReturned: byKind.recursive.returnedItems, directoryReturned: byKind.directory.returnedItems,
        recursiveVisited: byKind.recursive.scan.visitedEntries, directoryVisited: byKind.directory.scan.visitedEntries,
        recursiveP50Ms: byKind.recursive.latency.bodyReceivedMs.p50, directoryP50Ms: byKind.directory.latency.bodyReceivedMs.p50,
        medianReductionPercent: round((1 - byKind.directory.latency.bodyReceivedMs.p50 / byKind.recursive.latency.bodyReceivedMs.p50) * 100) });
      console.log(JSON.stringify({ scope, ...comparisons.at(-1) }));
    }
    // Mutation checks use the same server and workspace after all timed requests.
    const parentScope = 'packages/pkg-02', childScope = parentScope + '/src';
    const parentBefore = (await listing('directory', parentScope)).data.files;
    const childBefore = (await listing('directory', childScope)).data.files;
    const newRelative = childScope + '/created.txt', oldRelative = childScope + '/file-00.txt';
    const newText = '\uFEFFCreated after parent listing 中文😀\r\n';
    const changedText = contents.get(oldRelative).replace('KEY_OLD', 'KEY_NEW');
    await fs.writeFile(path.join(directory, 'project', newRelative), newText, { flag: 'wx' });
    await fs.writeFile(path.join(directory, 'project', oldRelative), changedText);
    await fs.unlink(path.join(directory, 'project', childScope, 'file-01.txt'));
    const parentAfter = await listing('directory', parentScope), childAfter = await listing('directory', childScope);
    assert.deepEqual(parentAfter.data.files, parentBefore);
    const expectedChild = childBefore.filter(item => !item.path.endsWith('/file-01.txt')).concat({ path: newRelative, type: 'file', size: Buffer.byteLength(newText) });
    const sorted = files => [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    assert.deepEqual(sorted(childAfter.data.files), sorted(expectedChild));
    mutationChecks.push({ id: 'deep-create-edit-delete-keeps-parent-children', passed: true, parentScope, childScope, parentItems: parentBefore.length, childrenBefore: childBefore.length, childrenAfter: childAfter.data.files.length,
      parentFilesSha256: sha256(JSON.stringify(parentAfter.data.files)), childFilesSha256: sha256(JSON.stringify(childAfter.data.files)), childResult: childAfter.data });
    for (const [name, content] of [[newRelative, newText], [oldRelative, changedText]]) {
      const value = await request('/api/workspace/file?' + new URLSearchParams({ path: name }));
      assert.equal(value.data.path, name); assert.equal(value.data.content, content); assert.equal(value.data.sha256, sha256(content));
      mutationChecks.push({ id: name === newRelative ? 'new-child-content-visible' : 'same-length-edit-content-visible', passed: true, path: name, sha256: value.data.sha256, bytes: Buffer.byteLength(content) });
    }
    const recursiveAfter = (await listing('recursive', parentScope)).data;
    assert.deepEqual(parentAfter.data.files, directChildren(recursiveAfter.files, parentScope));
    assert.deepEqual(sorted(childAfter.data.files), sorted(directChildren(recursiveAfter.files, childScope)));
    mutationChecks.push({ id: 'post-mutation-recursive-projection-equals-directory', passed: true });
    await new Promise((resolve, reject) => child.send({ op: 'stop' }, error => error ? reject(error) : resolve()));
    assert.deepEqual(await waitClosed(15_000), { code: 0, terminationSignal: null });
    assert.deepEqual(await sourceHashes(), hashes, 'Benchmark input sources changed');
    report = { version: 1, passed: true, startedAt, finishedAt: new Date().toISOString(), elapsedMs: round(performance.now() - started),
      environment: { node: process.version, platform: process.platform, release: os.release(), architecture: process.arch, sqlite: process.versions.sqlite, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
      sourceHashes: hashes, sourceUnchanged: true, fixture, cases, comparisons, mutationChecks,
      authentication: { workspaceDirectoryCapability: 1, unauthenticatedDirectoryStatus: 401, authenticatedResponsesNoStore: true },
      worker: { pid: child.pid, exited: true, expectedIdentity: ready.expectedIdentity, stderr },
      methodology: {
        transport: 'Separate client/service Node processes; real authenticated loopback GET requests. Latency starts before fetch and includes complete response transfer; JSON parse completion is separately reported. No model calls.',
        sampling: 'One warmup per route/scope, followed by three measured requests per route; route order alternates within each scope. Warmup values are recorded but excluded from median. No latency pass threshold; nearest-rank p95 with three points is only the observed maximum, not an SLA.',
        cache: 'New server process, freshly written synthetic files; no attempt to flush OS caches. Even first-request warmups are not cold-cache measurements. Background host activity is uncontrolled.',
        correctness: 'Each route must return its own identical complete response on repeated stable requests. Only directory files are compared with the direct-child projection of an untruncated recursive inventory; complete responses have intentionally different semantics and scan metadata.',
        safety: 'Dedicated owned temporary root, fixed fixture, random loopback port, pinned workspace identity, createRoot false, projectScan true, denySensitivePaths true, separate protected data/app directories. Cleanup only after own child close and root/owner verification.',
        limits: 'Small uncapped fixture, single client, local filesystem; no general large-project, cross-platform, cloud, mobile or native GUI claims. Memory/event-loop metrics are intentionally not collected. Concurrent replacement and limit pressure are covered by separate safety regressions.',
        maximumMs: MAX_MS, requestTimeoutMs: REQUEST_MS },
    };
  } catch (error) { failure = error; }
  finally {
    signal.removeEventListener('abort', terminateOwned);
    if (child && !hasClosed) { terminateOwned(); try { await waitClosed(10_000); } catch (error) { failure ??= error; } }
    if (!child || hasClosed) {
      try { await verifyOwned(directory, owner, owned); await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }); cleaned = true; }
      catch (error) { failure ??= error; }
    }
  }
  if (failure) report = { version: 1, passed: false, startedAt, finishedAt: new Date().toISOString(), sourceHashes: hashes, cases, comparisons, mutationChecks,
    error: { code: failure.code ?? null, message: failure.message }, workerExited: hasClosed, workerStderr: stderr, ...(cleaned ? {} : { retainedTemporaryDirectory: directory, ownedIdentity: identity(owned) }) };
  report.temporaryResourcesCleaned = cleaned;
  const finalDestination = await destination(process.argv[3]); identityEqual(finalDestination.identity, output.identity);
  const handle = await fs.open(output.output, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  console.log(JSON.stringify({ passed: report.passed, output: path.relative(PROJECT, output.output), elapsedMs: report.elapsedMs, cases: cases.length, mutationChecks: mutationChecks.length, sourceHashes: Object.keys(hashes).length, temporaryResourcesCleaned: cleaned, ...(failure ? { error: report.error } : {}) }));
  if (failure) process.exitCode = 1;
}

if (process.argv[2] === '--worker') await worker();
else await main();
