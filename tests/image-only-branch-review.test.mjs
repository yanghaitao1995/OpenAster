// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRuntime } from '../core/runtime.mjs';
import { previewConversationBranch, prepareConversationBranch } from '../core/conversation-branch.mjs';
import { previewConversationHandoff } from '../core/conversation-handoff.mjs';

test('an image-only first turn has a usable title and preserves its image when branched', async t => {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'openaster-image-branch-review-'));
  const pictures = JSON.parse(await fs.readFile(new URL('./fixtures/image-attachments.json', import.meta.url), 'utf8'));
  const image = pictures.png_rgb;
  let session = { id: 'image-session', title: '新任务', providerId: 'fixture', createdAt: new Date().toISOString(), messages: [], approvals: [] };
  const runtime = createRuntime({ workspace: directory, providers: async () => ({ id: 'fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' }), getSession: async () => structuredClone(session), saveSession: async value => { session = structuredClone(value); }, providerCall: async () => ({ content: '看到了图片。', toolCalls: [] }) });
  t.after(async () => { await runtime.shutdown(); assert.equal(path.dirname(await fs.realpath(directory)), parent); await fs.rm(directory, { recursive: true, force: true }); });
  await runtime.start(session.id, { content: '', images: [image] });
  for (let index = 0; index < 300 && runtime.isActive(session.id); index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(session.run.status, 'completed'); assert.ok(session.title.trim());
  const preview = previewConversationBranch(session, session.messages[0].id);
  const branch = prepareConversationBranch(session, { messageId: session.messages[0].id, expectedPrefixHash: preview.source.prefixHash, mode: 'message', content: '继续查看图片', providerId: 'fixture' });
  assert.deepEqual(branch.images, session.messages[0].images);
  assert.equal(preview.images[0].sha256, branch.images[0].sha256);
  assert.equal(previewConversationHandoff(session).source.messageCount, 2);
});
