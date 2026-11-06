// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_MODEL_OUTPUT_BYTES } from '../core/model-limits.mjs';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { Store } from '../server/store.mjs';
import { previewConversationBranch, prepareConversationBranch } from '../core/conversation-branch.mjs';
import { previewConversationHandoff, prepareConversationHandoff, snapshotConversationHandoff } from '../core/conversation-handoff.mjs';
import { planSummaryDraft, createSummaryDraft, generateSummaryDraft } from '../core/summary-draft.mjs';

const time = '2026-01-01T00:00:00.000Z';
const message = (id, role, content) => ({ id, role, content, createdAt: time });
const source = () => ({ id: 'source', title: 'Legacy source', providerId: 'model', messages: [
  message('u1', 'user', 'Original instruction'), message('a1', 'assistant', 'Saved answer'),
  message('u2', 'user', 'Follow-up question')], run: null, approvals: [] });
const branchRequest = session => ({ messageId: 'u2', expectedPrefixHash: previewConversationBranch(session, 'u2').source.prefixHash,
  mode: 'prefix', content: 'Continue the branch', providerId: 'model' });
async function until(check) {
  for (let index = 0; index < 2000; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Conversation output fixture timed out');
}

test('legacy branch and handoff projections retain their exact shapes and hashes', () => {
  assert.deepEqual(previewConversationBranch(source(), 'u2'), { version: 1, source: {
    sessionId: 'source', messageId: 'u2', title: 'Legacy source', prefixHash: '2a69ee4065b8cc2ebf9b55eab995e168b45d7f40e1ba721281ea1caa086e24cb' },
    content: 'Follow-up question', images: [], files: [], handoff: null, previousMessages: 2, sourceProviderId: 'model' });
  assert.deepEqual(previewConversationHandoff(source()), { version: 1, source: {
    sessionId: 'source', lastMessageId: 'u2', title: 'Legacy source', hash: 'd4827bd475979608a47775f1a08f3db01a9263d4eedfdf27919636088f27e6d9', messageCount: 3 },
    files: { count: 0, bytes: 0 }, sourceProviderId: 'model' });
});

test('assistant source accepts exactly 1 MiB of ASCII or Unicode while user source stays at 256 KiB', () => {
  for (const content of ['x'.repeat(MAX_MODEL_OUTPUT_BYTES), '中'.repeat(Math.floor(MAX_MODEL_OUTPUT_BYTES / 3)) + 'a']) {
    const original = source(); original.messages[1].content = content;
    assert.equal(Buffer.byteLength(content), MAX_MODEL_OUTPUT_BYTES);
    const prepared = prepareConversationBranch(original, branchRequest(original));
    assert.equal(prepared.session.messages[1].content, content);
    assert.equal(snapshotConversationHandoff(original).messages[1].content, content);
    original.messages[1].content += 'a';
    assert.throws(() => previewConversationBranch(original, 'u2'), { code: 'INVALID_BRANCH_SOURCE' });
    assert.throws(() => previewConversationHandoff(original), { code: 'INVALID_HANDOFF_SOURCE' });
  }
  for (const content of ['x'.repeat(256 * 1024), '中'.repeat(Math.floor(256 * 1024 / 3)) + 'a']) {
    const original = source(); original.messages[0].content = content;
    assert.equal(Buffer.byteLength(content), 256 * 1024);
    assert.equal(previewConversationBranch(original, 'u2').previousMessages, 2);
    assert.equal(previewConversationHandoff(original).source.messageCount, 3);
    original.messages[0].content += 'a';
    assert.throws(() => previewConversationBranch(original, 'u2'), { code: 'INVALID_BRANCH_SOURCE' });
    assert.throws(() => previewConversationHandoff(original), { code: 'INVALID_HANDOFF_SOURCE' });
  }
});

test('larger assistant messages do not expand the 8 MiB aggregate handoff source budget', () => {
  const original = source(); original.messages = Array.from({ length: 8 }, (_, index) => message(`a${index}`, 'assistant', 'x'.repeat(MAX_MODEL_OUTPUT_BYTES)));
  const overflow = Buffer.byteLength(JSON.stringify(original.messages)) - 8 * 1024 * 1024;
  original.messages.at(-1).content = original.messages.at(-1).content.slice(overflow);
  assert.equal(Buffer.byteLength(JSON.stringify(original.messages)), 8 * 1024 * 1024);
  assert.equal(previewConversationHandoff(original).source.messageCount, 8);
  original.messages.at(-1).content += 'a';
  assert.throws(() => previewConversationHandoff(original), { code: 'HANDOFF_SOURCE_LIMIT' });
});

test('a runtime-persisted 1 MiB answer can branch and feed complete manual-summary generation', async t => {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-output-source-'));
  const store = new Store(path.join(root, 'data')), workspace = createWorkspace(path.join(root, 'workspace'));
  await workspace.list();
  const config = { id: 'model', name: 'Fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', toolMode: 'none', contextWindowTokens: 2000000 };
  store.putProvider(config); const original = store.createSession({ providerId: 'model' });
  const longAnswer = 'x'.repeat(MAX_MODEL_OUTPUT_BYTES); let calls = 0, branchMessages;
  const runtime = createRuntime({ workspace, providers: async id => store.getProvider(id), getSession: async id => store.getSession(id),
    saveSession: async (value, options) => store.putSession(value, options), providerCall: async (_provider, options) => {
      if (++calls === 1) return { content: longAnswer, toolCalls: [] };
      branchMessages = options.messages; return { content: 'Branch result', toolCalls: [] };
    } });
  t.after(async () => { await runtime.shutdown(); store.close(); const canonical = await fs.realpath(root);
    assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-output-source-[A-Za-z0-9]+$/u);
    await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await runtime.start(original.id, { content: 'Return the bounded fixture output' }); await until(() => !runtime.isActive(original.id));
  const saved = store.getSession(original.id); assert.equal(saved.run.status, 'completed'); assert.equal(saved.messages.at(-1).content, longAnswer);
  saved.messages.push(message('u2', 'user', 'Follow-up question')); store.putSession(saved);
  const branch = prepareConversationBranch(saved, branchRequest(saved));
  await runtime.startBranch(branch.session, { content: branch.content, providerId: 'model', contextFiles: branch.contextFiles });
  await until(() => !runtime.isActive(branch.session.id));
  assert.equal(store.getSession(branch.session.id).run.status, 'completed'); assert.equal(branchMessages[1].content, longAnswer);
  assert.deepEqual(store.getSession(original.id), saved);

  const plan = planSummaryDraft(saved, config), draft = createSummaryDraft(plan, { requestId: 'long-summary', providerId: 'model',
    expectedSourceHash: plan.preview.source.hash, expectedPlanHash: plan.preview.planHash });
  const fragments = [];
  const summary = await generateSummaryDraft(plan, config, { draft, checkpoint: async () => {}, providerCall: async (_provider, options) => {
    const data = JSON.parse(options.messages[0].content);
    if (data.source_fragment) { fragments.push(data.source_fragment.content); return { content: `Part ${data.source_fragment.index}`, toolCalls: [] }; }
    return { content: 'Reviewable handoff summary', toolCalls: [] };
  } });
  assert.equal(summary.status, 'completed'); assert.ok(fragments.length > 1);
  assert.deepEqual(JSON.parse(fragments.join('')), snapshotConversationHandoff(saved).messages);
  const handoff = prepareConversationHandoff(saved, { requestId: 'continued', expectedSourceHash: plan.preview.source.hash,
    summary: summary.summary, content: 'Continue from reviewed summary', providerId: 'model' });
  assert.equal(handoff.contextHandoff.sourceMessageCount, saved.messages.length);
  assert.equal(handoff.contextHandoff.summary, summary.summary);
});
