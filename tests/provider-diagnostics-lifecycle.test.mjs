import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderDiagnostics, validateProviderDiagnosticsRequest } from '../server/provider-diagnostics.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('provider diagnostics accepts only an empty request object', () => {
  validateProviderDiagnosticsRequest({});
  for (const value of [null, [], '', true, { checks: [] }, { timeoutMs: 1 }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => validateProviderDiagnosticsRequest(value), { code: 'INVALID_PROVIDER_DIAGNOSTICS' });
  }
});

test('trusted timeout overrides may only shorten the fixed diagnostic budgets', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 125001]) assert.throws(() => createProviderDiagnostics({ timeoutMs: value }), TypeError);
  assert.throws(() => createProviderDiagnostics({ testTimeoutMs: 60001 }), TypeError);
});

test('diagnostic cancellation retains the shared test slot until actual settlement', async () => {
  const runner = createProviderDiagnostics(), gate = deferred(), started = deferred();
  const controller = new AbortController();
  const result = runner.run(async signal => { started.resolve(signal); await gate.promise; return 'late result'; }, { signal: controller.signal });
  const rejected = assert.rejects(result, { code: 'CANCELLED' });
  const signal = await started.promise; controller.abort();
  assert.equal(signal.aborted, true);
  await assert.rejects(runner.run(async () => 'second', { kind: 'test' }), { code: 'PROVIDER_DIAGNOSTICS_BUSY' });
  gate.resolve(); await rejected;
  assert.equal(await runner.run(async () => 'next', { kind: 'test' }), 'next');
  await runner.close();
});

test('close aborts and waits for credential or provider work that has not settled', async () => {
  const runner = createProviderDiagnostics(), gate = deferred(), started = deferred();
  const work = runner.run(async signal => { started.resolve(signal); await gate.promise; });
  const rejected = assert.rejects(work, { code: 'SHUTTING_DOWN' });
  const signal = await started.promise;
  let closed = false; const closing = runner.close().then(() => { closed = true; });
  assert.equal(signal.aborted, true); await delay(5); assert.equal(closed, false);
  await assert.rejects(runner.run(async () => {}), { code: 'SHUTTING_DOWN' });
  gate.resolve(); await rejected; await closing; assert.equal(closed, true);
});

test('diagnostic and quick-test deadlines reject late success without releasing the slot early', async () => {
  for (const kind of ['diagnostics', 'test']) {
    const runner = createProviderDiagnostics({ timeoutMs: 10, testTimeoutMs: 10 });
    const gate = deferred(), aborted = deferred();
    const result = runner.run(async signal => { signal.addEventListener('abort', aborted.resolve, { once: true }); await gate.promise; return 'late'; }, { kind });
    const rejected = assert.rejects(result, { code: kind === 'test' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_DIAGNOSTICS_TIMEOUT', status: 504 });
    await Promise.race([aborted.promise, delay(200).then(() => { throw new Error('Timeout did not abort operation'); })]);
    await assert.rejects(runner.run(async () => {}), { code: 'PROVIDER_DIAGNOSTICS_BUSY' });
    gate.resolve(); await rejected; await runner.close();
  }
});

test('pre-aborted diagnostics never start the operation and failures release the slot', async () => {
  const runner = createProviderDiagnostics(); let calls = 0;
  await assert.rejects(runner.run(async () => { calls++; }, { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  assert.equal(calls, 0);
  await assert.rejects(runner.run(async () => { throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(await runner.run(async () => 'available'), 'available'); await runner.close();
});
