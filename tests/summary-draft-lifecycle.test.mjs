// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummaryDraftRunner } from '../server/summary-drafts.mjs';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('summary background ownership starts synchronously and releases only after real settlement', async () => {
  const runner = createSummaryDraftRunner(), release = gate(); let signal;
  const operation = runner.start('first', async value => { signal = value; await release.promise; return 'late'; });
  assert.ok(signal); assert.equal(runner.active, true); assert.equal(runner.isActive('first'), true);
  assert.equal(runner.cancel('other'), false); assert.equal(runner.cancel('first'), true); assert.equal(signal.aborted, true);
  assert.throws(() => runner.start('second', async () => {}), { code: 'SUMMARY_DRAFT_BUSY' });
  let finished = false; operation.then(() => { finished = true; }); await wait(5); assert.equal(finished, false);
  release.resolve(); assert.deepEqual(await operation, { ok: true, value: 'late' }); assert.equal(runner.active, false);
  assert.deepEqual(await runner.start('second', async () => 'next'), { ok: true, value: 'next' });
  await runner.close();
});

test('summary background failures are observed and do not poison the next slot', async () => {
  const runner = createSummaryDraftRunner(), failure = new Error('fixture');
  for (const operation of [() => { throw failure; }, async () => { throw failure; }]) {
    const result = await runner.start('job', operation); assert.equal(result.ok, false); assert.equal(result.error, failure); assert.equal(runner.active, false);
  }
  assert.deepEqual(await runner.start('next', async () => 1), { ok: true, value: 1 }); await runner.close();
});

test('summary shutdown aborts but waits for an uninterruptible credential/save operation', async () => {
  const runner = createSummaryDraftRunner(), release = gate(); let signal;
  const operation = runner.start('job', async value => { signal = value; await release.promise; value.throwIfAborted(); });
  let closed = false; const closing = runner.close().then(() => { closed = true; });
  assert.equal(signal.aborted, true); assert.equal(signal.reason.code, 'SHUTTING_DOWN');
  assert.throws(() => runner.start('next', async () => {}), { code: 'SHUTTING_DOWN' });
  await wait(5); assert.equal(closed, false); assert.equal(runner.active, true);
  release.resolve(); const result = await operation; assert.equal(result.ok, false); assert.equal(result.error.code, 'SHUTTING_DOWN'); await closing;
  assert.equal(runner.active, false);
});

test('summary total deadline retains the slot until the underlying operation acknowledges it', async () => {
  const runner = createSummaryDraftRunner({ timeoutMs: 10 }), release = gate(), aborted = gate(); let signal;
  const operation = runner.start('job', async value => { signal = value; value.addEventListener('abort', aborted.resolve, { once: true }); await release.promise; value.throwIfAborted(); });
  await Promise.race([aborted.promise, wait(500).then(() => { throw new Error('Deadline missing'); })]);
  assert.equal(signal.reason.code, 'SUMMARY_TIMEOUT'); assert.equal(runner.active, true);
  assert.throws(() => runner.start('next', async () => {}), { code: 'SUMMARY_DRAFT_BUSY' });
  release.resolve(); assert.equal((await operation).error.code, 'SUMMARY_TIMEOUT'); assert.equal(runner.active, false); await runner.close();
});

test('summary runner validates fixed deadlines and identities before occupying its slot', async () => {
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 600001]) assert.throws(() => createSummaryDraftRunner({ timeoutMs }), TypeError);
  const runner = createSummaryDraftRunner();
  for (const id of ['', '/escape', 'a'.repeat(101), null]) assert.throws(() => runner.start(id, () => {}), TypeError);
  assert.equal(runner.active, false); assert.throws(() => runner.start('job', null), TypeError); await runner.close();
});
