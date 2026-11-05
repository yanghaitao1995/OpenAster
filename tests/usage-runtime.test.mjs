// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store } from '../server/store.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { CoreError } from '../core/errors.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
  for (let count = 0; count < 500; count++) { if (await predicate()) return; await delay(10); }
  throw new Error('Usage test timed out');
}
const usage = values => ({ inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null, ...values });
const answer = (content, reported, toolCalls = []) => ({ content, toolCalls, usage: reported });
const provider = { id: 'fixture', name: 'Fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true };

async function temporary(t, prefix, close = async () => {}) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, prefix));
  t.after(async () => {
    await close();
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith(prefix));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}

async function fixture(t, { providerCall, save, limits, cleanup, demo = false } = {}) {
  let store, runtime;
  const root = await temporary(t, 'openaster-usage-runtime-', async () => { await cleanup?.(); await runtime?.shutdown(); store?.close(); });
  store = new Store(root);
  store.putProvider(provider);
  const session = store.createSession({ providerId: demo ? 'demo' : provider.id });
  const snapshots = [];
  runtime = createRuntime({
    workspace: path.join(root, 'workspace'),
    providers: async id => store.getProvider(id), getSession: async id => store.getSession(id),
    saveSession: async (value, metadata) => { await save?.(value); store.putSession(value, metadata); snapshots.push(structuredClone(value)); },
    audit: async value => store.audit(value), providerCall,
    limits: { maxRunMs: 5000, streamCheckpointMs: 10, ...limits }
  });
  return { root, store, session, runtime, snapshots, get: () => store.getSession(session.id),
    start: content => runtime.start(session.id, { content }), done: () => until(() => !runtime.isActive(session.id)) };
}

test('per-step usage survives real SQLite multi-turn tools without entering model history or messages', async t => {
  const first = usage({ inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 4, cacheWriteInputTokens: 1, reasoningOutputTokens: 1 });
  const expected = structuredClone(first);
  let calls = 0;
  const f = await fixture(t, {
    save: async value => { if (value.run?.steps[0]?.status === 'completed') first.inputTokens = 999; },
    providerCall: async (_provider, options) => {
      assert.ok(options.messages.every(message => !Object.hasOwn(message, 'usage')));
      calls++;
      if (calls === 1) return answer('', first, [{ id: 'read-missing', name: 'read_file', args: { path: 'missing.txt' } }]);
      if (calls === 2) {
        assert.equal(options.messages.at(-1).isError, true);
        return answer('', { inputTokens: 30 }, [{ id: 'list-files', name: 'list_workspace', args: {} }]);
      }
      return answer('完成', undefined);
    }
  });
  await f.start('先读文件，然后列出目录'); await f.done();
  const stored = f.get();
  assert.equal(stored.run.status, 'completed'); assert.equal(calls, 3);
  assert.deepEqual(stored.run.steps.filter(step => step.type === 'model').map(step => step.usage), [expected, usage({ inputTokens: 30 }), null]);
  assert.deepEqual(stored.run.steps.filter(step => step.type === 'tool').map(step => step.status), ['failed', 'completed']);
  assert.ok(stored.run.steps.filter(step => step.type === 'tool').every(step => !Object.hasOwn(step, 'usage')));
  assert.ok(stored.messages.every(message => !Object.hasOwn(message, 'usage')));
  assert.equal(Object.hasOwn(stored.run, 'usage'), false);
  assert.ok(f.snapshots.some(value => value.run?.steps[0]?.status === 'running' && value.run.steps[0].usage === null));
  assert.notEqual(first.inputTokens, expected.inputTokens, 'fixture mutates the provider-owned object after its return');
});

test('model usage stays unknown when a disconnected stream is cancelled during backoff', async t => {
  const f = await fixture(t, { providerCall: async (_provider, { onText }) => {
    await onText('未完成文本'); throw new CoreError('MODEL_RESPONSE_INCOMPLETE', '响应中断', 502);
  } });
  await f.start('开始'); await until(() => f.get().run?.steps[0]?.phase === 'retrying');
  f.runtime.cancel(f.session.id); await f.done();
  assert.equal(f.get().run.status, 'cancelled');
  assert.equal(f.get().run.steps[0].usage, null);
  assert.equal(f.get().run.output.status, 'interrupted');
  assert.equal(f.get().run.output.content, '未完成文本');
  assert.equal(f.get().messages.length, 1);
});

test('optional usage getters, inherited fields and descriptor failures cannot reject valid provider text', async t => {
  let getterReads = 0;
  const inherited = Object.assign(Object.create({ usage: usage({ inputTokens: 5 }) }), { content: '有效正文', toolCalls: [] });
  const accessor = Object.defineProperty({ content: '有效正文', toolCalls: [] }, 'usage', { get() { getterReads++; throw new Error('must not execute'); } });
  const trapped = new Proxy({ content: '有效正文', toolCalls: [] }, { getOwnPropertyDescriptor() { throw new Error('descriptor failure'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const reply of [accessor, inherited, trapped, answer('有效正文', revoked.proxy)]) {
    const f = await fixture(t, { providerCall: async () => reply });
    await f.start('开始'); await f.done();
    assert.equal(f.get().run.status, 'completed'); assert.equal(f.get().run.steps[0].usage, null);
    assert.equal(f.get().messages.at(-1).content, '有效正文');
  }
  assert.equal(getterReads, 0);
});

test('optional explanation accessors and inherited text are never executed or displayed', async t => {
  let getterReads = 0;
  const accessor = Object.defineProperty({ content: '有效正文', toolCalls: [] }, 'publicReasoning', { get() { getterReads++; throw new Error('must not execute'); } });
  const inherited = Object.assign(Object.create({ publicReasoning: 'unvalidated inherited text' }), { content: '有效正文', toolCalls: [] });
  for (const reply of [accessor, inherited]) {
    const f = await fixture(t, { providerCall: async () => reply });
    await f.start('开始'); await f.done();
    assert.equal(f.get().run.status, 'completed');
    assert.equal(f.get().run.steps[0].publicReasoning, undefined);
    assert.equal(f.get().messages.at(-1).content, '有效正文');
  }
  assert.equal(getterReads, 0);
});

test('explicit malformed explanation data remains a terminal validation error', async t => {
  for (const value of [null, { signature: 'never-display' }, 'invalid\0text']) {
    let calls = 0;
    const f = await fixture(t, { providerCall: async () => { calls++; return { content: '有效正文', toolCalls: [], publicReasoning: value }; } });
    await f.start('开始'); await f.done();
    assert.equal(f.get().run.status, 'failed'); assert.equal(f.get().run.error.code, 'INVALID_PROVIDER_PROGRESS');
    assert.equal(calls, 1); assert.equal(f.get().run.steps[0].publicReasoning, undefined);
    assert.equal(f.get().messages.length, 1);
  }
});

test('cancelling an in-flight request keeps unknown usage unless the provider actually returns counters', async t => {
  for (const returnsUsage of [false, true]) {
    const requested = gate();
    const expected = usage({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    const f = await fixture(t, { providerCall: async (_provider, { signal }) => {
      const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      requested.resolve(); await aborted;
      if (returnsUsage) return answer('取消后不接受回答', expected);
      throw new CoreError('CANCELLED', '已取消', 409);
    } });
    await f.start('开始'); await requested.promise; f.runtime.cancel(f.session.id); await f.done();
    assert.equal(f.get().run.status, 'cancelled');
    assert.deepEqual(f.get().run.steps[0].usage, returnsUsage ? expected : null);
    assert.equal(f.get().messages.length, 1);
  }
});

for (const failure of [false, true]) test(`returned usage survives ${failure ? 'checkpoint failure' : 'cancellation'} while stream.close waits for durable writing`, async t => {
  const entered = gate(), release = gate(), returned = gate();
  let checkpoint, saves = 0, peak = 0, first = true;
  const expected = usage({ inputTokens: 20, outputTokens: 7, totalTokens: 27 });
  const f = await fixture(t, {
    cleanup: () => release.resolve(),
    save: async value => {
      saves++; peak = Math.max(peak, saves);
      try {
        if (first && value.run?.output?.status === 'streaming') {
          first = false; checkpoint = value; entered.resolve(); await release.promise;
          if (failure) throw new Error('fixture checkpoint failure');
        }
      } finally { saves--; }
    },
    providerCall: async (_provider, { onText }) => {
      await onText('已报告用量的部分文本'); await entered.promise; returned.resolve();
      return answer('完整响应尚未获准提交', expected);
    }
  });
  await f.start('开始'); await returned.promise;
  await delay(0); // Let providerCall resolve before cancellation; stream.close still awaits the checkpoint gate.
  assert.equal(checkpoint.run.steps[0].usage, null, 'in-flight persisted snapshot must not be mutated');
  if (!failure) f.runtime.cancel(f.session.id);
  release.resolve(); await f.done();
  const stored = f.get();
  assert.equal(stored.run.status, failure ? 'failed' : 'cancelled');
  assert.deepEqual(stored.run.steps[0].usage, expected);
  assert.equal(stored.run.output.status, 'interrupted'); assert.equal(stored.messages.length, 1);
  assert.equal(peak, 1, 'terminal writes must still wait for the checkpoint');
});

test('returned usage is preserved when response validation or a subsequent tool limit fails', async t => {
  for (const invalidResponse of [true, false]) {
    let calls = 0;
    const expected = usage({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
    const f = await fixture(t, { limits: { maxTools: 1 }, providerCall: async () => {
      calls++;
      if (invalidResponse) return { content: 3, toolCalls: [], usage: expected };
      return answer('', expected, [{ id: 'list1', name: 'list_workspace', args: {} }, { id: 'list2', name: 'list_workspace', args: {} }]);
    } });
    await f.start('开始'); await f.done();
    assert.equal(f.get().run.status, 'failed'); assert.equal(calls, 1);
    assert.equal(f.get().run.error.code, invalidResponse ? 'INVALID_PROVIDER_RESPONSE' : 'TOOL_LIMIT');
    assert.deepEqual(f.get().run.steps[0].usage, expected); assert.equal(f.get().messages.length, 1);
  }
});

test('explicit zero remains distinct from unknown and a new run replaces only the previous run steps', async t => {
  let calls = 0;
  const f = await fixture(t, { providerCall: async () => answer('完成', ++calls === 1 ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : undefined) });
  await f.start('第一次'); await f.done();
  assert.deepEqual(f.get().run.steps[0].usage, usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }));
  const oldMessages = f.get().messages;
  await f.start('第二次'); await f.done();
  assert.equal(f.get().run.steps.length, 1); assert.equal(f.get().run.steps[0].usage, null);
  assert.deepEqual(f.get().messages.slice(0, 2), oldMessages);
  const demo = await fixture(t, { demo: true, providerCall: async () => { throw new Error('demo must never call a provider'); } });
  await demo.start('查看工作区'); await demo.done();
  assert.equal(demo.get().run.status, 'completed');
  assert.ok(demo.get().run.steps.every(step => step.type === 'tool' && !Object.hasOwn(step, 'usage')));
});

test('abrupt runtime process exit preserves completed-step usage and unknown in-flight usage across SQLite restart', async t => {
  let child, closed, exited = false;
  const root = await temporary(t, 'openaster-usage-restart-', async () => { if (child && !exited) { child.kill(); await closed; } });
  const store = new Store(root); store.putProvider(provider);
  const session = store.createSession({ providerId: provider.id }); store.close();
  const moduleUrl = file => pathToFileURL(path.resolve(file)).href;
  const script = `
    import { Store } from ${JSON.stringify(moduleUrl('server/store.mjs'))};
    import { createRuntime } from ${JSON.stringify(moduleUrl('core/runtime.mjs'))};
    const store = new Store(process.argv[1]); let calls=0;
    const runtime=createRuntime({workspace:process.argv[1]+'/workspace',providers:async id=>store.getProvider(id),getSession:async id=>store.getSession(id),saveSession:async (value,metadata)=>store.putSession(value,metadata),providerCall:async()=>{
      if(++calls===1)return {content:'',toolCalls:[{id:'list1',name:'list_workspace',args:{}}],usage:{inputTokens:41,outputTokens:9,totalTokens:50}};
      process.stdout.write('USAGE_RESTART_READY\\n');await new Promise(()=>{});
    },limits:{maxRunMs:30000}});
    await runtime.start(process.argv[2],{content:'启动重启测试'});
  `;
  child = spawn(process.execPath, ['--input-type=module', '-e', script, root, session.id], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', () => { exited = true; resolve(); }); });
  await until(() => { if (exited) throw new Error(`Runtime child exited before readiness: ${stderr}`); return stdout.includes('USAGE_RESTART_READY'); });
  child.kill(); await closed;
  const reader = new Store(root);
  try {
    const restored = reader.getSession(session.id);
    assert.equal(restored.run.status, 'cancelled');
    assert.deepEqual(restored.run.steps.filter(step => step.type === 'model').map(step => step.usage), [usage({ inputTokens: 41, outputTokens: 9, totalTokens: 50 }), null]);
    assert.equal(restored.messages.length, 1);
  } finally { reader.close(); }
});
