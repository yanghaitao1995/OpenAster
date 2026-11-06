import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planSummaryDraft, validateSummaryPreviewRequest, validateSummaryRequest, summaryRequestHash,
  createSummaryDraft, validateSummaryDraft, generateSummaryDraft, interruptSummaryDraft, SUMMARY_DRAFT_LIMITS } from '../core/summary-draft.mjs';
import { snapshotConversationHandoff, previewConversationHandoff, prepareConversationHandoff } from '../core/conversation-handoff.mjs';
import { measureProviderRequest } from '../core/providers.mjs';

const now = '2026-01-01T00:00:00.000Z', sha = value => createHash('sha256').update(value).digest('hex');
const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null };
const provider = patch => ({ id: 'chosen', name: 'Chosen connection', type: 'openai', model: 'model', baseUrl: 'https://example.invalid/v1', apiKey: 'secret-not-persisted', ...patch });
const message = (id, role, content) => ({ id, role, content, createdAt: now });
function source() { return { id: 'source', title: '长任务', providerId: 'old', messages: [message('u', 'user', '保留所有要求；不要自动执行。'), message('a', 'assistant', '这是一条历史主张。')], run: null, approvals: [] }; }
function setup(session = source(), config = provider()) {
  const plan = planSummaryDraft(session, config), request = { requestId: 'draft', providerId: config.id,
    expectedSourceHash: plan.preview.source.hash, expectedPlanHash: plan.preview.planHash };
  return { plan, config, request, draft: createSummaryDraft(plan, request, { now: () => now }) };
}
const reply = content => ({ content, toolCalls: [], usage });
function largeSource() {
  const session = source(); session.messages = Array.from({ length: 201 }, (_, index) => message(`m${index}`, index % 2 ? 'assistant' : 'user', '😀'.repeat(10000)));
  let remaining = SUMMARY_DRAFT_LIMITS.sourceBytes - Buffer.byteLength(JSON.stringify(session.messages));
  for (const item of session.messages) { const add = Math.min(remaining, 256 * 1024 - Buffer.byteLength(item.content)); item.content += 'x'.repeat(add); remaining -= add; if (!remaining) break; }
  assert.equal(remaining, 0); return session;
}

test('summary plan covers all 201 messages at exact 8 MiB with UTF-8-safe contiguous fragments and no source in preview', () => {
  const session = largeSource(), original = structuredClone(session), f = setup(session);
  const canonical = JSON.stringify(snapshotConversationHandoff(session).messages);
  assert.equal(f.plan.preview.sourceBytes, 8 * 1024 * 1024); assert.equal(f.plan.preview.partCount, 33);
  assert.equal(f.plan.preview.maxRequests, 34); assert.equal(f.plan.chunks.join(''), canonical);
  assert.equal(f.plan.preview.sourceSha256, sha(canonical)); assert.equal(f.plan.preview.source.hash, previewConversationHandoff(session).source.hash);
  f.plan.chunks.forEach((chunk, index) => { assert.ok(chunk.isWellFormed()); const part = f.plan.preview.parts[index];
    assert.equal(Buffer.byteLength(chunk), part.endOffset - part.offset); assert.ok(part.bytes <= 262144); assert.equal(sha(chunk), part.sha256); });
  assert.ok(!JSON.stringify(f.plan.preview).includes('😀')); assert.deepEqual(session, original);
});

test('planner includes exact BOM/CRLF attachment snapshots and inherited handoff without reading live files', () => {
  const first = source(), p = previewConversationHandoff(first);
  const continuation = prepareConversationHandoff(first, { requestId: 'continued', expectedSourceHash: p.source.hash, summary: '\uFEFF old summary\r\n ', content: 'continue', providerId: 'chosen' }, { now: () => now });
  const session = continuation.session, content = '\uFEFF 原始附件\r\n"$&"';
  session.messages = [{ ...message('new-u', 'user', 'new user'), contextHandoff: continuation.contextHandoff, contextFiles: [{ path: ' exact.txt', content, sha256: sha(content) }] }];
  const f = setup(session), parsed = JSON.parse(f.plan.chunks.join(''));
  assert.equal(parsed[0].contextFiles[0].content, content); assert.equal(parsed[0].contextHandoff.summary, continuation.contextHandoff.summary);
  assert.deepEqual(f.plan.preview.files, { count: 1, bytes: Buffer.byteLength(content) }); assert.equal(f.plan.preview.maxRequests, 1);
});

test('requests and provider-bound plan hashes are strict, secret-free, and reject stale selection or reserved/colliding IDs', () => {
  const f = setup(); assert.deepEqual(validateSummaryPreviewRequest({ providerId: 'chosen', expectedSourceHash: f.plan.preview.source.hash }), { providerId: 'chosen', expectedSourceHash: f.plan.preview.source.hash });
  for (const value of [{ providerId: 'chosen' }, { providerId: 'chosen', expectedSourceHash: 'bad' }, { providerId: 'chosen', expectedSourceHash: f.plan.preview.source.hash, extra: true }]) assert.throws(() => validateSummaryPreviewRequest(value));
  assert.equal(summaryRequestHash({ ...f.request }), summaryRequestHash(Object.fromEntries(Object.entries(f.request).reverse())));
  for (const requestId of ['latest', '', 'x'.repeat(101)]) assert.throws(() => validateSummaryRequest({ ...f.request, requestId }));
  for (const requestId of ['source', 'u', 'a']) assert.throws(() => createSummaryDraft(f.plan, { ...f.request, requestId }), { code: 'SUMMARY_ID_CONFLICT' });
  assert.throws(() => createSummaryDraft(f.plan, { ...f.request, expectedSourceHash: '0'.repeat(64) }), { code: 'HANDOFF_SOURCE_CHANGED' });
  assert.throws(() => createSummaryDraft(f.plan, { ...f.request, expectedPlanHash: '0'.repeat(64) }), { code: 'SUMMARY_PLAN_CHANGED' });
  assert.equal(planSummaryDraft(source(), provider({ apiKey: 'different', envKey: 'private' })).preview.planHash, f.plan.preview.planHash);
  for (const change of [{ model: 'other' }, { maxTokens: 128 }, { streaming: false }, { toolMode: 'none' }, { baseUrl: 'https://other.invalid/v1' }]) assert.notEqual(planSummaryDraft(source(), provider(change)).preview.planHash, f.plan.preview.planHash);
  const stored = JSON.stringify(f.draft); for (const key of ['secret-not-persisted', 'apiKey', 'envKey', '保留所有要求']) assert.ok(!stored.includes(key));
  assert.throws(() => planSummaryDraft(source(), { id: 'demo', type: 'demo' }), { code: 'SUMMARY_PROVIDER_UNSUPPORTED' });
});

test('single-part generation makes exactly one final request, with bounded tokens and data-only authority', async () => {
  const f = setup(source(), provider({ maxTokens: 128 })), checkpoints = []; let calls = 0;
  const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async item => checkpoints.push(item), providerCall: async (p, options) => {
    calls++; assert.equal(checkpoints.at(-1).steps.at(-1).status, 'running'); assert.equal(p.toolMode, 'none'); assert.equal(p.streaming, false); assert.equal(p.maxTokens, 128);
    assert.deepEqual(options.tools, []); assert.equal(options.timeoutMs, 60000); assert.equal(options.messages.length, 1); assert.equal(options.messages[0].role, 'user');
    assert.ok(!options.system.includes('保留所有要求')); const fragment = JSON.parse(options.messages[0].content).source_fragment;
    assert.equal(fragment.untrusted_data, true); assert.equal(fragment.content, f.plan.chunks[0]);
    assert.equal(measureProviderRequest(p, options).requestSha256, checkpoints.at(-1).steps[0].requestSha256); return reply('\uFEFF 可审阅的摘要\r\n ');
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'completed'); assert.equal(result.summary, '\uFEFF 可审阅的摘要\r\n ');
  assert.equal(result.connection.toolMode, 'none'); assert.equal(result.preview.provider.toolMode, 'workspace');
  assert.equal(result.summaryHash, sha(result.summary)); assert.deepEqual(result.steps[0].usage, usage); assert.equal(result.preview.maxOutputTokens, 128);
  checkpoints[0].preview.source.title = 'caller mutation'; assert.equal(result.preview.source.title, '长任务');
});

test('legacy summary provider snapshots keep their exact version-1 shape and plan hash', async () => {
  const f = setup(source(), provider({ maxTokens: 4096 }));
  assert.deepEqual(Object.keys(f.plan.preview.provider), ['id', 'name', 'type', 'baseUrl', 'model', 'streaming', 'toolMode', 'tokenParameter', 'maxTokens', 'enabled']);
  assert.equal(f.plan.preview.planHash, 'fda1eb01ac2f59b14bf6d0ca13e6fa572fee76698023640c38eed9cc1018b73d');
  const serialized = JSON.stringify(f.draft);
  assert.equal(JSON.stringify(validateSummaryDraft(JSON.parse(serialized))), serialized);
  const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async () => reply('legacy summary') });
  assert.equal(result.status, 'completed');
  assert.equal(result.preview.planHash, f.plan.preview.planHash);
});

test('optional long-task settings bind new summary plans without expanding summary requests or output budgets', async () => {
  const settings = { contextWindowTokens: 131072, autoCompact: true, autoContinue: true, maxModelCalls: 64, maxTools: 256, maxRunMinutes: 60 };
  const legacy = setup(source(), provider({ maxTokens: 131072 })), f = setup(source(), provider({ maxTokens: 131072, ...settings }));
  assert.deepEqual(Object.keys(f.plan.preview.provider), ['id', 'name', 'type', 'baseUrl', 'model', 'streaming', 'toolMode', 'tokenParameter', 'maxTokens', ...Object.keys(settings), 'enabled']);
  assert.notEqual(f.plan.preview.planHash, legacy.plan.preview.planHash);
  assert.deepEqual(f.plan.preview.parts, legacy.plan.preview.parts);
  assert.deepEqual(f.plan.preview.partOutputLimit, legacy.plan.preview.partOutputLimit);
  assert.deepEqual(f.plan.preview.finalOutputLimit, legacy.plan.preview.finalOutputLimit);
  assert.equal(f.plan.preview.maxOutputTokens, 4096);
  const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async (p) => {
    assert.equal(p.maxTokens, 4096); assert.equal(p.streaming, false); assert.equal(p.toolMode, 'none');
    return reply('bounded summary');
  } });
  assert.equal(result.status, 'completed');
  for (const [key, value] of Object.entries(settings)) {
    const changed = { ...f.config, [key]: typeof value === 'boolean' ? !value : value + 1 };
    assert.notEqual(planSummaryDraft(source(), changed).preview.planHash, f.plan.preview.planHash);
    await assert.rejects(generateSummaryDraft(f.plan, changed, { draft: f.draft, checkpoint: async () => {}, providerCall: async () => assert.fail('No stale call') }), { code: 'SUMMARY_PLAN_CHANGED' });
    const partial = setup(source(), provider({ [key]: value }));
    assert.deepEqual(Object.keys(partial.plan.preview.provider).slice(-2), [key, 'enabled']);
    assert.deepEqual(validateSummaryDraft(partial.draft), partial.draft);
  }
});

test('summary validation rejects malformed optional settings and never invokes their getters', () => {
  const f = setup(source(), provider({ contextWindowTokens: 131072, autoCompact: true, autoContinue: true, maxModelCalls: 64, maxTools: 256, maxRunMinutes: 60 }));
  for (const [key, value] of Object.entries({ contextWindowTokens: 8191, autoCompact: 'true', autoContinue: null, maxModelCalls: 513, maxTools: 2049, maxRunMinutes: 241 })) {
    const bad = structuredClone(f.draft); bad.preview.provider[key] = value;
    assert.throws(() => validateSummaryDraft(bad), { code: 'INVALID_SUMMARY_DRAFT' });
  }
  let reads = 0;
  const bad = structuredClone(f.draft);
  Object.defineProperty(bad.preview.provider, 'autoCompact', { enumerable: true, get() { reads++; throw Error('Must not run'); } });
  assert.throws(() => validateSummaryDraft(bad), { code: 'INVALID_SUMMARY_DRAFT' });
  assert.equal(reads, 0);
});

test('multiple parts are all summarized in order and all notes reach final synthesis with measured bodies', async () => {
  const session = source(); session.messages = Array.from({ length: 4 }, (_, index) => message(`m${index}`, index % 2 ? 'assistant' : 'user', 'x'.repeat(200000)));
  const f = setup(session), checkpoints = [], seen = []; let calls = 0;
  const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async item => checkpoints.push(item), providerCall: async (p, options) => {
    calls++; const body = JSON.parse(options.messages[0].content), last = checkpoints.at(-1).steps.at(-1), measurement = measureProviderRequest(p, options);
    assert.equal(last.requestBytes, measurement.requestBytes); assert.equal(last.requestSha256, measurement.requestSha256); assert.ok(last.requestBytes <= 2097152);
    if (body.source_fragment) { seen.push(body.source_fragment.content); assert.equal(p.maxTokens, 2048); return reply(`note ${body.source_fragment.index}`); }
    assert.equal(p.maxTokens, 4096); assert.deepEqual(body.notes.map(item => item.content), f.plan.chunks.map((_, index) => `note ${index}`));
    return reply('完整合并草稿');
  } });
  assert.equal(seen.join(''), f.plan.chunks.join('')); assert.equal(calls, f.plan.preview.partCount + 1);
  assert.equal(result.steps.length, calls); assert.equal(result.summary, '完整合并草稿'); assert.equal(checkpoints.length, calls * 2);
  for (const mutate of [d => d.steps.at(-1).requestSha256 = '0'.repeat(64), d => d.steps.at(-1).requestBytes++]) {
    const bad = structuredClone(result); mutate(bad); assert.throws(() => validateSummaryDraft(bad), { code: 'INVALID_SUMMARY_DRAFT' });
  }
});

test('invalid or tool-bearing replies retain returned usage, stop without retry and never expose a complete summary', async () => {
  for (const returned of [reply(''), reply('\ud800'), reply('x\0'), reply('x'.repeat(24001)), { ...reply('text'), toolCalls: [{ name: 'write_file', args: {} }] }]) {
    const f = setup(), saved = []; let calls = 0;
    const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async item => saved.push(item), providerCall: async () => { calls++; return returned; } });
    assert.equal(calls, 1); assert.equal(result.status, 'failed'); assert.equal(result.summary, null); assert.deepEqual(result.steps[0].usage, usage);
    assert.equal(saved.at(-1).status, 'failed'); assert.equal(result.steps[0].output, null);
  }
});

test('cancellation before a call or immediately after a returned reply cannot discard known counts', async () => {
  for (const afterReply of [false, true]) {
    const f = setup(), controller = new AbortController(), saved = []; let calls = 0;
    if (!afterReply) controller.abort();
    const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, signal: controller.signal, checkpoint: async item => saved.push(item), providerCall: async () => { calls++; controller.abort(); return reply('not accepted'); } });
    assert.equal(result.status, 'cancelled'); assert.equal(result.summary, null); assert.equal(calls, afterReply ? 1 : 0);
    if (afterReply) assert.deepEqual(result.steps[0].usage, usage); assert.equal(saved.at(-1).status, 'cancelled');
  }
});

test('a completed final checkpoint remains completed if cancellation arrives while it is being saved', async () => {
  const f = setup(), controller = new AbortController(), statuses = [];
  const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, signal: controller.signal, providerCall: async () => reply('committed'),
    checkpoint: async item => { statuses.push(item.status); if (item.status === 'completed') controller.abort(); } });
  assert.equal(result.status, 'completed'); assert.equal(result.summary, 'committed'); assert.deepEqual(statuses, ['running', 'completed']);
});

test('checkpoint failures stop before later requests and do not mask uncertain persistence as a normal model failure', async () => {
  for (const failAfterReply of [false, true]) {
    const f = setup(); let calls = 0, saves = 0;
    await assert.rejects(generateSummaryDraft(f.plan, f.config, { draft: f.draft, providerCall: async () => { calls++; return reply('answer'); }, checkpoint: async () => {
      saves++; if (!failAfterReply || saves === 2) throw Error('private disk details');
    } }), { code: 'SUMMARY_SAVE_FAILED' });
    assert.equal(calls, failAfterReply ? 1 : 0); assert.equal(saves, failAfterReply ? 2 : 1);
  }
});

test('persistent validation rejects tampering, extra fields and invented completion; interruption keeps accepted notes', async () => {
  const f = setup(); assert.deepEqual(validateSummaryDraft(f.draft), f.draft);
  for (const mutate of [d => d.extra = true, d => d.preview.parts[0].offset = 1, d => d.preview.provider.apiKey = 'no', d => d.requestHash = '0'.repeat(64), d => d.status = 'completed', d => d.summary = 'invented', d => d.connection.model = 'other']) {
    const draft = structuredClone(f.draft); mutate(draft); assert.throws(() => validateSummaryDraft(draft), { code: 'INVALID_SUMMARY_DRAFT' });
  }
  const running = []; await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async item => running.push(item), providerCall: async () => reply('accepted') });
  running[0].steps[0].usage = usage;
  const interrupted = interruptSummaryDraft(running[0], { code: 'RESTARTED', message: '服务重启，中止未完成摘要。' });
  assert.equal(interrupted.status, 'cancelled'); assert.equal(interrupted.steps[0].status, 'cancelled'); assert.deepEqual(interrupted.steps[0].usage, usage);
  assert.equal(running[0].status, 'running'); assert.deepEqual(interruptSummaryDraft(running[1]), running[1]);
});

test('safe errors and unavailable counts do not disclose arbitrary provider errors or invoke hostile usage getters', async () => {
  const f = setup(); let accessed = 0;
  const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async () => ({ content: 'text', toolCalls: [], get usage() { accessed++; throw Error('secret'); } }) });
  assert.equal(result.status, 'completed'); assert.equal(result.steps[0].usage, null); assert.equal(accessed, 0);
  const failed = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async () => { throw new Error('secret upstream payload'); } });
  assert.equal(failed.error.code, 'SUMMARY_FAILED'); assert.ok(!JSON.stringify(failed).includes('secret'));
  const exhausted = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async () => { throw Object.assign(new Error('private context payload'), { code: 'MODEL_CONTEXT_LIMIT' }); } });
  assert.equal(exhausted.error.code, 'MODEL_CONTEXT_LIMIT'); assert.match(exhausted.error.message, /上下文窗口/); assert.doesNotMatch(JSON.stringify(exhausted), /private context payload/);
});

test('full source generation reaches every fragment and final note without changing original messages', async () => {
  const session = largeSource(), originalHash = sha(JSON.stringify(session)), f = setup(session); let bytes = 0, calls = 0, finalCount = 0;
  const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async (_p, options) => {
    calls++; const body = JSON.parse(options.messages[0].content);
    if (body.source_fragment) { bytes += Buffer.byteLength(body.source_fragment.content); return reply(`part ${body.source_fragment.index}`); }
    finalCount = body.notes.length; return reply('由全部片段形成的待审阅草稿');
  } });
  assert.equal(bytes, 8 * 1024 * 1024); assert.equal(calls, 34); assert.equal(finalCount, 33); assert.equal(result.status, 'completed'); assert.equal(sha(JSON.stringify(session)), originalHash);
});

test('part and final output byte/character limits reject whole replies rather than truncating', async () => {
  const session = source(); session.messages[0].content = 'x'.repeat(262144);
  const multi = setup(session);
  assert.ok(multi.plan.preview.partCount > 1);
  for (const content of ['x'.repeat(6001), '中'.repeat(6000)]) {
    let calls = 0;
    const result = await generateSummaryDraft(multi.plan, multi.config, { draft: multi.draft, checkpoint: async () => {}, providerCall: async () => { calls++; return reply(content); } });
    assert.equal(calls, 1); assert.equal(result.error.code, 'SUMMARY_OUTPUT_INVALID'); assert.equal(result.steps[0].output, null); assert.deepEqual(result.steps[0].usage, usage);
  }
  const f = setup(), exact = '中'.repeat(21845) + 'a'; assert.equal(Buffer.byteLength(exact), 65536);
  const complete = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async () => reply(exact) });
  assert.equal(complete.summary, exact);
  const over = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async () => reply(exact + 'b') });
  assert.equal(over.status, 'failed'); assert.equal(over.summary, null);
});

test('worst-case escaped legal notes fit the disclosed 2 MiB draft and final-request budgets', async () => {
  const f = setup(largeSource()); let finalBytes = 0;
  const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async (p, options) => {
    const data = JSON.parse(options.messages[0].content);
    if (data.source_fragment) return reply('\u0001'.repeat(6000));
    finalBytes = measureProviderRequest(p, options).requestBytes; return reply('\u0001'.repeat(24000));
  } });
  assert.equal(result.status, 'completed'); assert.ok(Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2 * 1024 * 1024); assert.ok(finalBytes <= 2 * 1024 * 1024);
});

test('hostile reply and error getters cannot run, and total deadline has a distinct failure code', async () => {
  const f = setup(); let accesses = 0;
  const bad = { usage, toolCalls: [], get content() { accesses++; throw Error('secret'); } };
  const result = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async () => bad });
  assert.equal(result.status, 'failed'); assert.deepEqual(result.steps[0].usage, usage); assert.equal(accesses, 0);
  const failed = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, checkpoint: async () => {}, providerCall: async () => { throw { get code() { accesses++; throw Error('secret'); } }; } });
  assert.equal(failed.error.code, 'SUMMARY_FAILED'); assert.equal(accesses, 0);
  const controller = new AbortController(); controller.abort({ code: 'SUMMARY_TIMEOUT' });
  const timeout = await generateSummaryDraft(f.plan, f.config, { draft: f.draft, signal: controller.signal, checkpoint: async () => {}, providerCall: async () => assert.fail('No call') });
  assert.equal(timeout.status, 'failed'); assert.equal(timeout.error.code, 'SUMMARY_TIMEOUT');
});

test('internal plans must bind canonical source metadata and original messages, even if a caller recalculates planHash', () => {
  const f = setup();
  for (const mutate of [p => p.source.hash = '0'.repeat(64), p => p.source.messageCount++, p => p.files.count++]) {
    const bad = structuredClone(f.plan); mutate(bad.preview);
    const { planHash, ...body } = bad.preview; bad.preview.planHash = sha(JSON.stringify(body));
    assert.throws(() => createSummaryDraft(bad, { ...f.request, expectedPlanHash: bad.preview.planHash, expectedSourceHash: bad.preview.source.hash }), { code: 'INVALID_SUMMARY_DRAFT' });
  }
});
