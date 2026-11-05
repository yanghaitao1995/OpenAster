// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { CoreError } from '../core/errors.mjs';
import { createWorkspace } from '../core/workspace.mjs';

const provider = { id: 'fixture', name: '本机测试', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' };
const answer = content => ({ content, toolCalls: [] });
async function until(predicate) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('History runtime condition timed out');
}
async function fixture(t, providerCall, wrapWorkspace = value => value) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-history-runtime-'));
  let store = new Store(root), runtime;
  store.putProvider(provider); const session = store.createSession({ providerId: provider.id });
  runtime = createRuntime({
    workspace: wrapWorkspace(createWorkspace(path.join(root, 'workspace'))), providerCall,
    providers: async id => store.getProvider(id), getSession: async id => store.getSession(id),
    saveSession: async (value, metadata) => store.putSession(value, metadata), audit: entry => store.audit(entry),
    limits: { maxRunMs: 5000, streamCheckpointMs: 1 },
  });
  t.after(async () => {
    await runtime.shutdown(); store.close();
    const canonical = await fs.realpath(root);
    assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-history-runtime-[A-Za-z0-9]+$/u);
    await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    session, runtime, get: () => store.getSession(session.id), history: () => store.listRunHistory(session.id).runs,
    record: id => store.getRunHistory(session.id, id), start: (content = '正常请求', skillPrompt = '') => runtime.start(session.id, { content, skillPrompt }),
    done: () => until(() => !runtime.isActive(session.id)),
    restart: async () => { await runtime.shutdown(); store.close(); store = new Store(root); return store.getSession(session.id); },
  };
}

test('invalid user and skill text is rejected before persistence; valid Unicode still runs and restarts', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return answer('有效回复🙂\r\n'); });
  const before = f.get();
  for (const bad of ['\ud800', '\udfff', 'prefix\0suffix']) {
    await assert.rejects(f.start(bad), { code: 'INVALID_MESSAGE' });
    await assert.rejects(f.start('有效消息', bad), { code: 'INVALID_SKILL' });
  }
  assert.deepEqual(f.get(), before); assert.equal(calls, 0); assert.deepEqual(f.history(), []);
  const prompt = '🙂'.repeat(121) + 'e\u0301\r\n尾部';
  const { runId } = await f.start(prompt, '合法指引🙂'); await f.done();
  assert.equal(f.get().run.status, 'completed');
  assert.equal(f.record(runId).run.requestPreview, '🙂'.repeat(120));
  assert.equal(f.record(runId).run.requestPreview.length, 240);
  assert.equal(f.get().messages[0].content, prompt);
  assert.equal(f.get().messages[1].content, '有效回复🙂\r\n');
  assert.equal((await f.restart()).run.status, 'completed');
});

for (const [label, invalid] of [['high surrogate', '\ud800'], ['low surrogate', '\udfff'], ['NUL', '\0']]) {
  test(`invalid streamed ${label} cannot replace a saved valid prefix or prevent restart`, async t => {
    let calls = 0, f;
    f = await fixture(t, async (_provider, { onText }) => {
      if (++calls > 1) return answer('正常后续回复');
      await onText('已保存🙂\r\n');
      await until(() => f.get().run?.output?.content === '已保存🙂\r\n');
      await onText(invalid);
      throw new Error('Invalid delta should already have rejected');
    });
    const { runId } = await f.start(); await f.done();
    const archived = f.record(runId);
    assert.equal(archived.run.status, 'failed'); assert.equal(archived.run.error.code, 'INVALID_PROVIDER_RESPONSE');
    assert.deepEqual(archived.run.output, { stepId: archived.run.steps[0].id, content: '已保存🙂\r\n', status: 'interrupted' });
    assert.equal(f.get().messages.length, 1);
    await f.start('后续请求'); await f.done();
    assert.equal(f.get().run.status, 'completed'); assert.equal(f.history().length, 2);
    assert.deepEqual(f.record(runId), archived);
    assert.equal((await f.restart()).run.status, 'completed'); assert.deepEqual(f.record(runId), archived);
  });

  test(`invalid complete ${label} response fails before messages or output are overwritten`, async t => {
    let calls = 0;
    const f = await fixture(t, async (_provider, { onText }) => {
      if (++calls > 1) return answer('后续完成🙂');
      await onText('合法前缀🙂');
      return { content: invalid, toolCalls: [], usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
    });
    const { runId } = await f.start(); await f.done();
    const saved = f.record(runId);
    assert.equal(saved.run.status, 'failed'); assert.equal(saved.run.error.code, 'INVALID_PROVIDER_RESPONSE');
    assert.equal(saved.run.output.content, '合法前缀🙂'); assert.equal(saved.run.steps[0].usage.totalTokens, 7);
    assert.equal(f.get().messages.length, 1);
    await f.start('后续请求'); await f.done();
    assert.equal(f.get().run.status, 'completed'); assert.equal(f.history().length, 2);
    assert.equal((await f.restart()).run.status, 'completed'); assert.deepEqual(f.record(runId), saved);
  });
}

test('malformed adapter error metadata uses a generic failure that remains archivable', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    if (calls === 1) throw new CoreError('BAD\ud800', 'normal');
    if (calls === 2) throw new CoreError('BAD_MESSAGE', 'private\0message');
    return answer('下一次仍可完成');
  });
  for (let index = 0; index < 2; index++) {
    const { runId } = await f.start(); await f.done();
    const saved = f.record(runId);
    assert.equal(saved.run.status, 'failed'); assert.equal(saved.run.error.code, 'INTERNAL_ERROR');
    assert.equal(saved.run.steps[0].detail, '操作失败，请稍后重试。');
    assert.ok(!JSON.stringify(saved).includes('private'));
  }
  await f.start(); await f.done(); assert.equal(f.history().length, 3);
  assert.equal((await f.restart()).run.status, 'completed');
});

test('tool display prefix does not split surrogate pairs or alter original adapter arguments', async t => {
  const suppliedPath = 'a'.repeat(511) + '🙂tail'; let seenPath, calls = 0;
  const f = await fixture(t, async () => ++calls === 1
    ? { content: '', toolCalls: [{ id: 'read-one', name: 'read_file', args: { path: suppliedPath } }] }
    : answer('适配器返回完成'), workspace => ({ ...workspace, read: async relative => { seenPath = relative; return { path: relative, content: 'fixture' }; } }));
  const { runId } = await f.start(); await f.done();
  assert.equal(seenPath, suppliedPath);
  const detail = f.record(runId).run.steps.find(step => step.type === 'tool').detail;
  assert.equal(detail, 'a'.repeat(511)); assert.ok(detail.isWellFormed()); assert.ok(detail.length <= 512);
  assert.equal((await f.restart()).run.status, 'completed');
});

test('invalid Unicode tool paths are still rejected by the real workspace without poisoning history', async t => {
  let calls = 0;
  const f = await fixture(t, async (_provider, { messages }) => {
    if (++calls === 1) return { content: '', toolCalls: [{ id: 'bad-path', name: 'read_file', args: { path: 'bad\ud800.txt' } }] };
    assert.equal(JSON.parse(messages.at(-1).content).error.code, 'INVALID_PATH');
    return answer('路径被安全拒绝');
  });
  const { runId } = await f.start(); await f.done();
  assert.equal(f.record(runId).run.status, 'completed');
  assert.equal(f.record(runId).run.steps.find(step => step.type === 'tool').status, 'failed');
  assert.equal((await f.restart()).run.status, 'completed');
});
