// SPDX-License-Identifier: Apache-2.0
// Local synthetic fixtures only. This measures one host; it is not a latency SLA.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createWorkspace } from '../core/workspace.mjs';

const project = path.resolve(import.meta.dirname, '..');
const sourceFiles = ['core/workspace.mjs', 'core/workspace-ignore.mjs', 'core/workspace-search.mjs', 'core/sensitive-paths.mjs', 'core/errors.mjs', 'scripts/benchmark-workspace-ignore.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await fs.readFile(path.join(project, file)))])));
const sources = await hashes();
const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-ignore-bench-'));
const owned = await fs.lstat(root, { bigint: true });
const owner = digest(Buffer.from(root + performance.now()));
await fs.writeFile(path.join(root, '.benchmark-owner'), owner, { flag: 'wx' });
const workspacePath = path.join(root, 'project'); await fs.mkdir(workspacePath);
const query = 'synthetic-benchmark-content-548';
const content = `${query}\n${'bounded representative source line\n'.repeat(32)}`;
async function write(file, value = content) { const target = path.join(workspacePath, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, value, { flag: 'wx' }); }
let result;
try {
  await write('.gitignore', 'cache/\n*.tmp\n**/generated/\n'); await write('README.md');
  for (let part = 0; part < 12; part++) {
    const base = `packages/p${String(part).padStart(2, '0')}`;
    await write(`${base}/.gitignore`, '!keep.tmp\n'); await write(`${base}/keep.tmp`);
    for (let offset = 0; offset < 40; offset += 10) await Promise.all(Array.from({ length: 10 }, (_, i) => write(`${base}/source-${String(offset + i).padStart(2, '0')}.txt`)));
    for (let offset = 0; offset < 20; offset += 10) await Promise.all(Array.from({ length: 10 }, (_, i) => write(`${base}/temporary-${offset + i}.tmp`)));
    for (let offset = 0; offset < 30; offset += 10) await Promise.all(Array.from({ length: 10 }, (_, i) => write(`${base}/generated/output-${offset + i}.txt`)));
  }
  for (let offset = 0; offset < 200; offset += 20) await Promise.all(Array.from({ length: 20 }, (_, i) => write(`cache/cached-${offset + i}.txt`)));
  const workspace = createWorkspace(workspacePath, { createRoot: false, denySensitivePaths: true, projectScan: true });
  const summarize = value => ({ files: value.files?.length, matches: value.matches?.length, searchedFiles: value.searchedFiles, truncated: value.truncated, scan: value.scan });
  const scenarios = [
    { name: 'root-with-rules', run: () => workspace.list(), check: value => { assert.equal(value.truncated, false); assert.equal(value.scan.ignore.files, 13); assert.equal(value.scan.ignore.ignoredFiles, 240); assert.equal(value.scan.ignore.ignoredDirectories, 13); assert.ok(!value.files.some(file => file.path.startsWith('cache/') || file.path.includes('/generated/'))); } },
    { name: 'scoped-with-ancestors', run: () => workspace.list({ path: 'packages/p05' }), check: value => { assert.equal(value.truncated, false); assert.ok(value.files.some(file => file.path.endsWith('/keep.tmp'))); assert.ok(!value.files.some(file => file.path.includes('/temporary-') || file.path.includes('/generated'))); } },
    { name: 'root-explicitly-included', run: () => workspace.list({ includeGenerated: true, includeIgnored: true }), check: value => { assert.equal(value.scan.ignore.enabled, false); assert.equal(value.scan.ignore.files, 0); assert.equal(value.files.length, 1000); assert.equal(value.truncated, true); } },
    { name: 'bounded-content-search', run: () => workspace.search(query), check: value => { assert.equal(value.searchedFiles, 100); assert.ok(value.matches.length > 0); assert.ok(value.scan.limits.includes('search-files')); assert.ok(!value.matches.some(file => file.path.startsWith('cache/') || file.path.includes('/generated/') || file.path.includes('/temporary-'))); } },
  ];
  const measurements = [];
  for (const scenario of scenarios) {
    scenario.check(await scenario.run());
    const samples = [], eventLoop = monitorEventLoopDelay({ resolution: 10 }); eventLoop.enable();
    let last;
    for (let index = 0; index < 5; index++) {
      const start = performance.now(); last = await scenario.run(); samples.push(performance.now() - start); scenario.check(last);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    eventLoop.disable(); const sorted = [...samples].sort((a, b) => a - b), round = value => Math.round(value * 100) / 100;
    measurements.push({ name: scenario.name, samplesMs: samples.map(round), medianMs: round(sorted[2]), maxMs: round(sorted.at(-1)), eventLoopMaxMs: round(eventLoop.max / 1e6), observed: summarize(last) });
  }
  assert.deepEqual(await hashes(), sources, 'Source changed during benchmark; run again after freeze');
  result = { version: 1, verifiedAt: new Date().toISOString(), scope: 'One warm-up and five measurements per scenario on a local synthetic project; no network or production data',
    environment: { node: process.version, platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
    fixture: { packages: 12, sourceTextFiles: 480, explicitlyIncludedTemporaryFiles: 12, ignoredTemporaryFiles: 240, ignoredGeneratedFiles: 360, ignoredCacheFiles: 200, ignoreFiles: 13 }, measurements, sourceHashes: sources };
} finally {
  const current = await fs.lstat(root, { bigint: true });
  assert.equal(current.dev, owned.dev); assert.equal(current.ino, owned.ino); assert.ok(!current.isSymbolicLink());
  assert.equal(path.dirname(await fs.realpath(root)), parent); assert.equal(await fs.readFile(path.join(root, '.benchmark-owner'), 'utf8'), owner);
  await fs.rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...result, temporaryResourcesCleaned: true }, null, 2));
