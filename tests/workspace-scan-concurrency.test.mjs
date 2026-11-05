// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../core/workspace.mjs';
import { startServer } from '../server/index.mjs';
import { acquireDataLock } from '../server/lock.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function within(promise, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The expected filesystem lifecycle event did not arrive')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const turn = () => new Promise(resolve => setImmediate(resolve));
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

function observe(promise) {
  const result = { settled: false };
  result.promise = promise.then(value => {
    result.settled = true; return { value };
  }, error => {
    result.settled = true; return { error };
  });
  return result;
}

async function fixture(t, options = {}) {
  const parent = await fs.realpath(tmpdir());
  const base = await fs.mkdtemp(path.join(parent, 'openaster-scan-concurrency-'));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(base)), parent);
    assert.match(path.basename(base), /^openaster-scan-concurrency-[A-Za-z0-9]+$/u);
    await fs.rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { base, root, workspace: createWorkspace(root, { createRoot: false, ...options }) };
}

async function write(root, relative, content = 'needle') {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function manyFiles(root, count) {
  for (let offset = 0; offset < count; offset += 64) {
    await Promise.all(Array.from({ length: Math.min(64, count - offset) }, (_, index) =>
      write(root, `file-${String(offset + index).padStart(4, '0')}.txt`, '')));
  }
}

// Patch the real built-in rather than introducing a production testing hook.
// Each gate pauses the first actual lstat of one path; every released operation
// still executes the original filesystem call (unless an explicit fault is set).
function metadataGates(root, names, { faults = new Map() } = {}) {
  const originalLstat = fs.lstat;
  const originalOpen = fs.open;
  const gates = new Map(names.map(name => [name, { started: deferred(), release: deferred(), finished: deferred() }]));
  const seen = new Set(), started = [], completed = [], calls = [], opens = [];
  let active = 0, peak = 0;
  const relative = target => {
    if (typeof target !== 'string') return null;
    const value = path.relative(key(root), key(target));
    return value && !value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value) ? value.split(path.sep).join('/') : null;
  };
  fs.lstat = async function (target, options) {
    const name = !options?.bigint ? relative(target) : null;
    if (!name) return originalLstat.call(this, target, options);
    calls.push(name); active++; peak = Math.max(peak, active);
    const first = !seen.has(name), gate = first ? gates.get(name) : null;
    if (first) { seen.add(name); started.push(name); gate?.started.resolve(); }
    try {
      if (gate) await gate.release.promise;
      if (first && faults.has(name)) throw faults.get(name);
      return await originalLstat.call(this, target, options);
    } finally {
      active--;
      if (first) { completed.push(name); gate?.finished.resolve(); }
    }
  };
  fs.open = async function (target, ...args) {
    const name = relative(target);
    if (name) opens.push(name);
    return originalOpen.call(this, target, ...args);
  };
  syncBuiltinESMExports();
  return {
    gates, started, completed, calls, opens,
    get active() { return active; }, get peak() { return peak; },
    async entered(namesToWait = names) { await within(Promise.all(namesToWait.map(name => gates.get(name).started.promise))); },
    async release(name) { const gate = gates.get(name); gate.release.resolve(); await within(gate.finished.promise); },
    releaseAll() { for (const gate of gates.values()) gate.release.resolve(); },
    restore() { fs.lstat = originalLstat; fs.open = originalOpen; syncBuiltinESMExports(); },
  };
}

async function finish(gates, operation) {
  gates.releaseAll();
  try { if (operation) await within(operation.promise); }
  finally { gates.restore(); }
}

test('four reversed metadata completions preserve sorted breadth-first inventory and search order', async t => {
  const { root, workspace } = await fixture(t);
  for (const name of ['a/z.txt', 'b/nested/k.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']) await write(root, name);
  const baseline = await workspace.list(), baselineSearch = await workspace.search('needle');
  assert.deepEqual(baseline.files.map(file => file.path), ['a', 'b', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'a/z.txt', 'b/nested', 'b/nested/k.txt']);
  assert.deepEqual(baselineSearch.matches.map(match => match.path), ['c.txt', 'd.txt', 'e.txt', 'f.txt', 'a/z.txt', 'b/nested/k.txt']);
  for (const [run, expected] of [[() => workspace.list(), baseline], [() => workspace.search('needle'), baselineSearch]]) {
    const held = metadataGates(root, ['a', 'b', 'c.txt', 'd.txt']);
    const operation = observe(run());
    try {
      await held.entered();
      assert.equal(held.active, 4);
      assert.equal(held.started.includes('e.txt'), false);
      for (const name of ['d.txt', 'c.txt', 'b']) await held.release(name);
      assert.equal(operation.settled, false);
      assert.equal(held.started.includes('e.txt'), false, 'The next batch cannot begin until its predecessor drains');
      assert.equal(held.opens.length, 0, 'Metadata batches do not speculatively read file content');
      await held.release('a');
      const result = await within(operation.promise);
      assert.ifError(result.error); assert.deepEqual(result.value, expected);
      assert.deepEqual(held.completed.slice(0, 4), ['d.txt', 'c.txt', 'b', 'a']);
      assert.equal(held.peak, 4); assert.equal(held.active, 0);
    } finally { await finish(held, operation); }
  }
});

test('cancellation waits for all four started metadata checks and starts no later I/O', async t => {
  const { root, workspace } = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt']) await write(root, name);
  const controller = new AbortController();
  const held = metadataGates(root, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  const operation = observe(workspace.search('needle', { signal: controller.signal }));
  try {
    await held.entered(); controller.abort();
    for (const name of ['d.txt', 'c.txt', 'b.txt']) await held.release(name);
    await turn();
    assert.equal(operation.settled, false); assert.equal(held.active, 1);
    assert.equal(held.started.includes('e.txt'), false); assert.deepEqual(held.opens, []);
    await held.release('a.txt');
    const result = await within(operation.promise);
    assert.equal(result.error?.code, 'CANCELLED'); assert.equal(held.active, 0);
    const calls = held.calls.length;
    await turn(); await turn();
    assert.equal(held.calls.length, calls); assert.deepEqual(held.opens, []);
    assert.deepEqual([...held.started].sort(), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  } finally { await finish(held, operation); }
});

test('fatal metadata failures drain peers and select the first fatal error in item order', async t => {
  const { root, workspace } = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) await write(root, name);
  const missing = Object.assign(new Error('injected vanished child'), { code: 'ENOENT' });
  const earlier = Object.assign(new Error('injected earlier metadata I/O failure'), { code: 'EIO' });
  const later = Object.assign(new Error('injected later metadata access failure'), { code: 'EPERM' });
  const held = metadataGates(root, ['a.txt', 'b.txt', 'c.txt', 'd.txt'], { faults: new Map([['b.txt', missing], ['c.txt', earlier], ['d.txt', later]]) });
  const operation = observe(workspace.list());
  try {
    await held.entered();
    for (const name of ['d.txt', 'c.txt', 'b.txt']) await held.release(name);
    await turn();
    assert.equal(operation.settled, false); assert.equal(held.active, 1);
    await held.release('a.txt');
    const result = await within(operation.promise);
    assert.equal(result.error, earlier, 'Completion order must not select the later fatal error');
    assert.equal(held.started.includes('e.txt'), false); assert.equal(held.active, 0);
    const calls = held.calls.length; await turn(); assert.equal(held.calls.length, calls);
  } finally { await finish(held, operation); }
});

test('cancellation has priority over a concurrent fatal failure after every started check settles', async t => {
  const { root, workspace } = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) await write(root, name);
  const controller = new AbortController();
  const held = metadataGates(root, ['a.txt', 'b.txt', 'c.txt', 'd.txt'], {
    faults: new Map([['d.txt', Object.assign(new Error('injected failure'), { code: 'EIO' })]]),
  });
  const operation = observe(workspace.list({ signal: controller.signal }));
  try {
    await held.entered(); await held.release('d.txt'); controller.abort();
    await held.release('c.txt'); await held.release('b.txt'); await turn();
    assert.equal(operation.settled, false);
    await held.release('a.txt');
    assert.equal((await within(operation.promise)).error?.code, 'CANCELLED');
    assert.equal(held.active, 0); assert.equal(held.started.includes('e.txt'), false);
  } finally { await finish(held, operation); }
});

test('a full inventory inspects only its real lookahead and never starts paths beyond it', { timeout: 60000 }, async t => {
  const { root, workspace } = await fixture(t, { createRoot: true });
  await manyFiles(root, 1003);
  const forbidden = Object.assign(new Error('this path must not be inspected'), { code: 'EIO' });
  for (const failLookahead of [false, true]) {
    const lookaheadFailure = Object.assign(new Error('the actual lookahead failed'), { code: 'EIO' });
    const faults = new Map([['file-1001.txt', forbidden], ['file-1002.txt', forbidden]]);
    if (failLookahead) faults.set('file-1000.txt', lookaheadFailure);
    const held = metadataGates(root, ['file-1000.txt'], { faults });
    const operation = observe(workspace.list());
    try {
      await held.entered();
      assert.equal(held.active, 1);
      assert.equal(held.started.length, 1001);
      assert.equal(held.started.includes('file-1001.txt'), false);
      await held.release('file-1000.txt');
      const result = await within(operation.promise);
      if (failLookahead) assert.equal(result.error, lookaheadFailure);
      else {
        assert.ifError(result.error); assert.equal(result.value.files.length, 1000);
        assert.deepEqual(result.value.scan.limits, ['entries']);
        assert.equal(result.value.scan.visitedEntries, 1003);
        assert.equal(result.value.files.at(-1).path, 'file-0999.txt');
      }
      assert.equal(held.started.includes('file-1001.txt'), false);
      assert.equal(held.started.includes('file-1002.txt'), false);
      assert.equal(held.active, 0); assert.deepEqual(held.opens, []);
    } finally { await finish(held, operation); }
  }
});

test('one remaining slot allows at most two checks and excluded candidates do not consume it', { timeout: 60000 }, async t => {
  const { root, workspace } = await fixture(t, { createRoot: true, projectScan: true });
  // The rule file and 998 normal files occupy 999 returned slots. Cheap hidden
  // and invalid entries plus a rule-excluded file cannot consume the last slot.
  await manyFiles(root, 998);
  await write(root, '.gitignore', 'x-ignore.txt\n');
  await write(root, '.openaster-internal', 'hidden');
  for (const name of ['x-invalid%.txt', 'x-ignore.txt', 'y-last.txt', 'z-lookahead.txt', 'zz-forbidden.txt']) await write(root, name);
  const fault = Object.assign(new Error('past the true lookahead'), { code: 'EIO' });
  const held = metadataGates(root, ['x-ignore.txt', 'y-last.txt', 'z-lookahead.txt'], { faults: new Map([['zz-forbidden.txt', fault]]) });
  const operation = observe(workspace.list());
  try {
    await held.entered(['x-ignore.txt']);
    assert.equal(held.started.includes('y-last.txt'), false, 'An ignored and invalid pair still drains before advancing');
    await held.release('x-ignore.txt');
    await held.entered(['y-last.txt', 'z-lookahead.txt']);
    assert.equal(held.active, 2);
    assert.equal(held.started.includes('zz-forbidden.txt'), false);
    await held.release('z-lookahead.txt');
    assert.equal(operation.settled, false); await held.release('y-last.txt');
    const result = await within(operation.promise);
    assert.ifError(result.error); assert.equal(result.value.files.length, 1000);
    assert.equal(result.value.files.at(-1).path, 'y-last.txt');
    assert.equal(result.value.scan.skippedEntries, 2);
    assert.equal(result.value.scan.ignore.ignoredFiles, 1);
    assert.equal(result.value.scan.visitedEntries, 1005);
    assert.deepEqual(result.value.scan.limits, ['entries']);
    assert.equal(held.started.includes('zz-forbidden.txt'), false);
  } finally { await finish(held, operation); }
});

test('an in-flight hard-link replacement is skipped and the next request reads fresh metadata', async t => {
  const { base, root, workspace } = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await write(root, name);
  const outside = path.join(base, 'outside.txt');
  await fs.writeFile(outside, 'outside content must remain unchanged');
  const held = metadataGates(root, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  const operation = observe(workspace.list());
  try {
    await held.entered();
    await fs.unlink(path.join(root, 'a.txt')); await fs.link(outside, path.join(root, 'a.txt'));
    held.releaseAll();
    const result = await within(operation.promise);
    assert.ifError(result.error);
    assert.deepEqual(result.value.files.map(file => file.path), ['b.txt', 'c.txt', 'd.txt']);
    assert.equal(result.value.scan.skippedEntries, 1); assert.deepEqual(held.opens, []);
  } finally { await finish(held, operation); }
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside content must remain unchanged');
  await fs.unlink(path.join(root, 'a.txt')); await write(root, 'a.txt', 'replacement needle with a different byte length');
  const refreshed = await workspace.list();
  assert.equal(refreshed.files.find(file => file.path === 'a.txt').size, Buffer.byteLength('replacement needle with a different byte length'));
  const found = await workspace.search('replacement');
  assert.deepEqual(found.matches.map(match => match.path), ['a.txt']);
});

test('root replacement during a metadata batch fails closed after draining and cannot rebind later', async t => {
  const { base, root, workspace } = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) await write(root, name);
  await workspace.getIdentity();
  const held = metadataGates(root, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  const operation = observe(workspace.list());
  try {
    await held.entered();
    await fs.rename(root, path.join(base, 'previous-project')); await fs.mkdir(root);
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) await write(root, name, 'untrusted replacement');
    await held.release('d.txt'); await held.release('c.txt'); await held.release('b.txt');
    assert.equal(operation.settled, false); await held.release('a.txt');
    const result = await within(operation.promise);
    assert.equal(result.error?.code, 'WORKSPACE_CHANGED');
    assert.equal(held.active, 0); assert.deepEqual(held.opens, []);
  } finally { await finish(held, operation); }
  await assert.rejects(workspace.list(), { code: 'WORKSPACE_CHANGED' });
  await assert.rejects(workspace.search('replacement'), { code: 'WORKSPACE_CHANGED' });
});

test('HTTP disconnect and shutdown retain the slot and data lock until both metadata gates drain', { timeout: 30000 }, async t => {
  const { base, root } = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) await write(root, name);
  const dataDir = path.join(base, 'data');
  const app = await startServer({ dataDir, workspace: root, workspaceOptions: { createRoot: false } });
  let held, operation, request, shutdown;
  try {
    const response = await fetch(`${app.url}/api/bootstrap`), bootstrap = await response.json();
    const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-csrf-token': bootstrap.csrfToken, 'content-type': 'application/json' };
    const search = async () => {
      const result = await fetch(`${app.url}/api/workspace/search`, { method: 'POST', headers, body: JSON.stringify({ query: 'needle' }), signal: AbortSignal.timeout(5000) });
      return { status: result.status, data: await result.json() };
    };
    held = metadataGates(root, ['a.txt', 'b.txt']);
    const marker = randomUUID(), serverClosed = deferred(), clientClosed = deferred();
    let responses = 0;
    const listener = (incoming, outgoing) => {
      if (incoming.headers['x-test-request'] !== marker) return;
      app.server.removeListener('request', listener); outgoing.once('close', serverClosed.resolve);
    };
    app.server.on('request', listener);
    t.after(() => app.server.removeListener('request', listener));
    request = http.request(`${app.url}/api/workspace/search`, { method: 'POST', headers: { ...headers, 'x-test-request': marker, Connection: 'close' } });
    request.on('error', () => {}); request.once('close', clientClosed.resolve);
    request.on('response', result => { responses++; result.resume(); });
    request.end(JSON.stringify({ query: 'needle' }));
    await held.entered(); request.destroy();
    await within(Promise.all([clientClosed.promise, serverClosed.promise]));
    const busy = await search();
    assert.equal(busy.status, 429); assert.equal(busy.data.error.code, 'WORKSPACE_SEARCH_BUSY');
    await assert.rejects(app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
    await held.release('a.txt');
    const stillBusy = await search();
    assert.equal(stillBusy.status, 429); assert.equal(stillBusy.data.error.code, 'WORKSPACE_SEARCH_BUSY');
    await assert.rejects(app.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
    operation = observe(app.close()); shutdown = operation.promise;
    await assert.rejects(acquireDataLock(dataDir), { code: 'DATA_LOCKED' });
    assert.equal(operation.settled, false, 'A drained first worker does not mean the handler has ended');
    await held.release('b.txt');
    const closed = await within(shutdown); assert.ifError(closed.error);
    assert.equal(held.active, 0); assert.equal(held.started.includes('e.txt'), false);
    assert.deepEqual(held.opens, []); assert.equal(responses, 0);
    const release = await acquireDataLock(dataDir); await release();
  } finally {
    request?.destroy(); held?.releaseAll();
    try { await app.close(); if (shutdown) await within(shutdown); }
    finally { held?.restore(); }
  }
});
