// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createRuntime } from '../core/runtime.mjs';
import { validateToolArtifact, validateContextPlan } from '../core/tool-artifacts.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const reply = (content = 'Done', toolCalls = []) => ({ content, toolCalls });
const call = (name, args, id = 'call') => ({ id, name, args });
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) { const end = performance.now() + 6000; while (performance.now() < end) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('Runtime fixture timeout'); }
function fixture(t, options = {}) {
  let session = { id: 's', title: '新任务', providerId: 'p', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', messages: options.messages ?? [], approvals: [], run: null };
  const artifacts = new Map(), files = new Map(), saves = [], reservations = new Map(), releases = [], audits = [];
  let reads = 0, writes = 0, calls = 0;
  const provider = { id: 'p', name: 'Fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', streaming: false, autoCompact: false, contextWindowTokens: 2000000, ...options.provider };
  const workspace = { read: async path => { reads++; const content = files.get(path) ?? options.fileContent ?? 'file'; return { path, content, sha256: sha(content) }; },
    prepareWrite: async ({ path, content }) => ({ path, content, originalContent: null, originalHash: null, newHash: sha(content), bytes: Buffer.byteLength(content) }),
    commitWrite: async proposal => { writes++; files.set(proposal.path, proposal.content); return { path: proposal.path, bytes: proposal.bytes, sha256: proposal.newHash }; }, discardWrite() {}, ...options.workspace };
  const runtime = createRuntime({ workspace, providers: async () => provider, getSession: async () => structuredClone(session),
    saveSession: async (value, metadata) => {
      await options.beforeSave?.(value, metadata);
      for (const artifact of metadata?.artifacts ?? []) { validateToolArtifact(artifact); assert.equal(artifacts.has(artifact.id), false); }
      for (const artifact of metadata?.artifacts ?? []) artifacts.set(artifact.id, structuredClone(artifact));
      session = structuredClone(value); saves.push({ session: structuredClone(value), artifactIds: (metadata?.artifacts ?? []).map(a => a.id) });
    }, reserveArtifact: async value => { const token = value.id; await options.beforeReserve?.(value); reservations.set(token, value); return token; },
    releaseArtifact: async token => { releases.push(token); reservations.delete(token); }, audit: value => audits.push(value), emit: options.emit,
    ...(options.actualProvider ? {} : { providerCall: async (...args) => { calls++; return (options.providerCall ?? (async () => reply()))(...args); } }),
    limits: { maxRunMs: 5000, streamCheckpointMs: 1, ...options.limits } });
  t.after(() => runtime.shutdown());
  return { runtime, artifacts, files, saves, reservations, releases, audits, get: () => structuredClone(session), counts: () => ({ reads, writes, calls }),
    start: value => runtime.start('s', { content: 'Preserve my exact constraints.', ...value }), done: () => until(() => !runtime.isActive('s')) };
}

function protocolReply(type, calls) {
  if (!calls.length) {
    if (type === 'openai') return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }] };
    if (type === 'responses') return { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done' }] }] };
    if (type === 'anthropic') return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] };
    return { done: true, done_reason: 'stop', message: { role: 'assistant', content: 'Done' } };
  }
  if (type === 'openai') return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', reasoning_content: 'opaque', tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] };
  if (type === 'responses') return { status: 'completed', output: [{ type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'opaque' }, ...calls.map(c => ({ type: 'function_call', id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: JSON.stringify(c.args), status: 'completed' }))] };
  if (type === 'anthropic') return { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'opaque', signature: 'signed' }, ...calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))] };
  return { done: true, done_reason: 'stop', message: { role: 'assistant', content: '', thinking: 'opaque', tool_calls: calls.map(c => ({ function: { name: c.name, arguments: c.args } })) } };
}

for (const type of ['openai', 'responses', 'anthropic', 'ollama']) test(`${type} actual HTTP completes eight 256 KiB reads without dropping wire or user text`, async t => {
  const calls = Array.from({ length: 8 }, (_, i) => call('read_file', { path: `file${i}.txt` }, `call${i}`)), bodies = [];
  const first = protocolReply(type, calls);
  const upstream = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); bodies.push(Buffer.concat(chunks).toString('utf8')); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(bodies.length === 1 ? first : protocolReply(type, []))); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => upstream.close(resolve)));
  const f = fixture(t, { actualProvider: true, fileContent: 'x'.repeat(256 * 1024), provider: { type, baseUrl: `http://127.0.0.1:${upstream.address().port}${type === 'ollama' ? '' : '/v1'}` } });
  await f.start(); await f.done(); assert.equal(f.get().run.status, 'completed'); assert.equal(bodies.length, 2); assert.equal(f.artifacts.size, 8);
  const plans = f.get().run.steps.filter(step => step.type === 'model').map(step => step.contextPlan);
  for (let i = 0; i < bodies.length; i++) { validateContextPlan(plans[i]); assert.equal(plans[i].requestBytes, Buffer.byteLength(bodies[i])); assert.equal(plans[i].requestSha256, sha(bodies[i])); assert.ok(plans[i].requestBytes <= 2 * 1024 * 1024); }
  assert.ok(plans[1].toolResults.some(item => item.mode === 'excerpt')); assert.equal(plans[1].toolResults.length, 8);
  const second = JSON.parse(bodies[1]), messages = second.messages ?? second.input;
  assert.equal(messages.find(message => message.role === 'user').content, 'Preserve my exact constraints.');
  if (type === 'openai' || type === 'ollama') { assert.deepEqual(messages.find(message => message.role === 'assistant'), type === 'openai' ? first.choices[0].message : first.message); assert.equal(messages.filter(message => message.role === 'tool').length, 8); }
  else if (type === 'responses') { assert.deepEqual(second.input.slice(1, first.output.length + 1), first.output); assert.deepEqual(second.input.filter(item => item.type === 'function_call_output').map(item => item.call_id), calls.map(c => c.id)); }
  else { assert.deepEqual(messages[1].content, first.content); assert.deepEqual(messages[2].content.map(item => item.tool_use_id), calls.map(c => c.id)); }
  assert.equal(f.reservations.size, 0); assert.equal(f.releases.length, 8);
  for (const value of f.artifacts.values()) { assert.equal(JSON.parse(value.content).result.content.length, 256 * 1024); assert.equal(sha(value.content), value.sha256); }
});

test('one 256 KiB read reaches the model completely with no pagination under the default budget', async t => {
  const content = 'x'.repeat(256 * 1024); let turn = 0;
  const f = fixture(t, { fileContent: content, providerCall: async (_p, { messages }) => {
    if (turn++ === 0) return reply('', [call('read_file', { path: 'whole.txt' })]);
    const observation = JSON.parse(messages.at(-1).content);
    assert.equal(observation.tool_result_view, undefined);
    assert.equal(observation.result.content, content); assert.equal(observation.result.sha256, sha(content));
    return reply();
  } });
  await f.start(); await f.done(); assert.equal(f.get().run.status, 'completed');
  assert.equal(f.counts().calls, 2); assert.equal(f.counts().reads, 1); assert.equal(f.artifacts.size, 1);
  assert.equal(f.get().run.steps.at(-1).contextPlan.toolResults[0].mode, 'full');
});

test('32 accumulated results are archived once, bounded on the wire, and retain user history', async t => {
  let turn = 0;
  const f = fixture(t, { fileContent: 'x'.repeat(256 * 1024), limits: { maxRequestBytes: 64 * 1024 }, providerCall: async (_p, options) => {
    assert.equal(options.messages[0].content, 'Preserve my exact constraints.');
    if (turn++ === 4) return reply();
    return reply('', Array.from({ length: 8 }, (_, i) => call('read_file', { path: `file${i}.txt` }, `batch${turn}_${i}`)));
  } });
  await f.start(); await f.done(); assert.equal(f.get().run.status, 'completed'); assert.equal(f.artifacts.size, 32); assert.equal(f.counts().reads, 32);
  const models = f.get().run.steps.filter(step => step.type === 'model'); assert.equal(models.length, 5);
  assert.ok(models.every(step => step.contextPlan.requestBytes <= 64 * 1024)); assert.ok(models.at(-1).contextPlan.toolResults.some(item => item.mode === 'reference'));
  assert.equal(f.saves.reduce((n, save) => n + save.artifactIds.length, 0), 32);
});

test('pagination under actual request pressure reads immutable JSON after the file changes and returns the page whole', async t => {
  let turn = 0, original, selected;
  // Keep the original artifact larger than the wire budget, but allow the added
  // shell schema alongside a complete requested 16 KiB page and its metadata.
  const budget = 40000;
  const f = fixture(t, { fileContent: '\ufeff中文🙂\r\n'.repeat(5000), limits: { maxRequestBytes: budget }, providerCall: async (_p, { messages }) => {
    if (turn++ === 0) return reply('', [call('read_file', { path: 'original.txt' })]);
    if (turn === 2) { const view = JSON.parse(messages.at(-1).content).tool_result_view; selected = view.artifactId; original = f.artifacts.get(selected); f.files.set('original.txt', 'changed'); return reply('', [call('read_tool_result', { artifactId: selected, offset: view.endOffset, maxBytes: 16384 }, 'page')]); }
    const page = JSON.parse(messages.at(-1).content).result; assert.equal(page.artifactId, selected); assert.equal(page.sha256, original.sha256);
    assert.equal(page.content, Buffer.from(original.content).subarray(page.offset, page.endOffset).toString('utf8')); assert.ok(page.endOffset - page.offset <= 16384);
    return reply();
  } });
  await f.start(); await f.done(); assert.equal(f.get().run.status, 'completed', JSON.stringify(f.get().run.error)); assert.equal(f.counts().reads, 1); assert.equal(f.artifacts.size, 2);
  const latest = f.get().run.steps.filter(step => step.type === 'model').at(-1); assert.equal(latest.contextPlan.toolResults.at(-1).mode, 'full');
  assert.ok(f.get().run.steps.filter(step => step.type === 'model').every(step => step.contextPlan.requestBytes <= budget));
});

test('exact first-request measurement rejects escaped snapshots before persistence or provider invocation', async t => {
  const content = '"'.repeat(256 * 1024), messages = Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, role: 'user', content: 'keep', createdAt: '2026-10-28T00:00:00.000Z', contextFiles: [{ path: `f${i}.txt`, content, sha256: sha(content) }] }));
  const f = fixture(t, { messages }), before = f.get(); assert.ok(Buffer.byteLength(JSON.stringify(messages)) < 2 * 1024 * 1024);
  await assert.rejects(f.start(), { code: 'CONTEXT_TOO_LARGE' }); assert.deepEqual(f.get(), before); assert.equal(f.saves.length, 0); assert.equal(f.counts().calls, 0);
});

test('oversized immutable assistant wire is rejected before any write proposal or reservation', async t => {
  const f = fixture(t, { limits: { maxRequestBytes: 16000 }, providerCall: async () => ({ ...reply('', [call('write_file', { path: 'new.txt', content: 'new' })]), wire: { type: 'openai', message: { role: 'assistant', content: 'x'.repeat(20000) } } }) });
  await f.start(); await f.done(); assert.equal(f.get().run.error.code, 'CONTEXT_TOO_LARGE'); assert.equal(f.get().approvals.length, 0); assert.equal(f.counts().writes, 0); assert.equal(f.releases.length, 0);
});

test('a write followed by a requested page that cannot fit is rejected before the entire group executes', async t => {
  let turn = 0;
  const f = fixture(t, { fileContent: 'x'.repeat(20000), limits: { maxRequestBytes: 16000 }, providerCall: async (_p, { messages }) => {
    if (turn++ === 0) return reply('', [call('read_file', { path: 'file.txt' }, 'read')]);
    const artifactId = JSON.parse(messages.at(-1).content).tool_result_view.artifactId;
    return reply('', [call('write_file', { path: 'new.txt', content: 'new' }, 'write'),
      call('read_tool_result', { artifactId, offset: 0, maxBytes: 16384 }, 'page')]);
  } });
  await f.start(); await f.done();
  assert.equal(f.get().run.error.code, 'CONTEXT_TOO_LARGE'); assert.equal(f.counts().calls, 2);
  assert.equal(f.get().approvals.length, 0); assert.equal(f.counts().writes, 0);
  assert.equal(f.artifacts.size, 1); assert.equal(f.releases.length, 1); assert.equal(f.reservations.size, 0);
  assert.equal(f.get().run.steps.filter(step => step.type === 'tool').length, 1);
});

for (const kind of ['maxBytes', 'offset', 'getter', 'unknown', 'UTF8 boundary']) test(`invalid page ${kind} stops a group before an earlier write without reading accessors`, async t => {
  let turn = 0, accesses = 0;
  const f = fixture(t, { fileContent: '中'.repeat(10000), limits: { maxRequestBytes: 24000 }, providerCall: async (_p, { messages }) => {
    if (turn++ === 0) return reply('', [call('read_file', { path: 'file.txt' }, 'read')]);
    const artifactId = JSON.parse(messages.at(-1).content).tool_result_view.artifactId;
    const args = { artifactId, offset: 0, maxBytes: 8192 };
    if (kind === 'maxBytes') args.maxBytes = 16385;
    if (kind === 'offset') args.offset = -1;
    if (kind === 'getter') Object.defineProperty(args, 'offset', { enumerable: true, get() { accesses++; throw Error('must not read'); } });
    if (kind === 'unknown') args.artifactId = 'unknown';
    if (kind === 'UTF8 boundary') {
      const raw = f.artifacts.get(artifactId).content;
      args.offset = Buffer.byteLength(raw.slice(0, raw.indexOf('中'))) + 1;
    }
    return reply('', [call('write_file', { path: 'new.txt', content: 'new' }, 'write'), call('read_tool_result', args, 'page')]);
  } });
  await f.start(); await f.done(); assert.equal(f.get().run.status, 'failed'); assert.equal(accesses, 0);
  assert.equal(f.get().run.error.code, kind === 'unknown' ? 'TOOL_ARTIFACT_NOT_FOUND' : kind === 'UTF8 boundary' ? 'INVALID_ARTIFACT_RANGE' : 'INVALID_TOOL_ARGUMENTS');
  assert.equal(f.counts().calls, 2); assert.equal(f.counts().writes, 0); assert.equal(f.get().approvals.length, 0);
  assert.equal(f.artifacts.size, 1); assert.equal(f.releases.length, 1); assert.equal(f.reservations.size, 0);
});

test('archive failure is fatal and an unsaved observation never reaches another model request', async t => {
  const f = fixture(t, { providerCall: async () => reply('', [call('read_file', { path: 'file.txt' })]), beforeSave: async (_session, metadata) => { if (metadata?.artifacts?.length) throw Error('disk failure'); } });
  await f.start(); await f.done(); assert.equal(f.get().run.error.code, 'TOOL_ARTIFACT_SAVE_FAILED'); assert.equal(f.counts().calls, 1); assert.equal(f.artifacts.size, 0);
  assert.ok(f.get().run.steps.every(step => !step.toolResultRef)); assert.equal(f.reservations.size, 0); assert.equal(f.releases.length, 1);
});

test('post-write archive failure records the applied fact and stops without retrying', async t => {
  const f = fixture(t, { providerCall: async () => reply('', [call('write_file', { path: 'new.txt', content: 'approved' })]), beforeSave: async (_session, metadata) => { if (metadata?.artifacts?.length) throw Error('disk failure'); } });
  await f.start(); await until(() => f.get().approvals.some(item => item.status === 'pending')); await f.runtime.decide(f.get().approvals[0].id, 'approve'); await f.done();
  assert.equal(f.get().run.error.code, 'POST_WRITE_ARTIFACT_FAILED'); assert.equal(f.files.get('new.txt'), 'approved'); assert.ok(f.get().approvals[0].appliedAt);
  assert.equal(f.counts().writes, 1); assert.equal(f.counts().calls, 1); assert.ok(f.audits.some(entry => entry.action === 'workspace.written')); assert.equal(f.reservations.size, 0);
});

test('cancellation during reservation releases it and executes no workspace operation', async t => {
  const entered = gate(), release = gate();
  const f = fixture(t, { providerCall: async () => reply('', [call('read_file', { path: 'file.txt' })]), beforeReserve: async () => { entered.resolve(); await release.promise; } });
  await f.start(); await entered.promise; f.runtime.cancel('s'); release.resolve(); await f.done();
  assert.equal(f.get().run.status, 'cancelled'); assert.equal(f.counts().reads, 0); assert.equal(f.artifacts.size, 0); assert.equal(f.reservations.size, 0); assert.equal(f.releases.length, 1);
});

test('reservation rejection executes no tool or proposal and exposes no result', async t => {
  const f = fixture(t, { providerCall: async () => reply('', [call('write_file', { path: 'new.txt', content: 'new' })]), beforeReserve: async () => { throw Error('reservation rejected'); } });
  await f.start(); await f.done(); assert.equal(f.get().run.status, 'failed'); assert.equal(f.get().approvals.length, 0);
  assert.equal(f.counts().writes, 0); assert.equal(f.artifacts.size, 0); assert.equal(f.counts().calls, 1); assert.equal(f.reservations.size, 0);
});

test('notification exceptions after durable saves cannot undo archive references or stop valid work', async t => {
  let turn = 0;
  const f = fixture(t, { emit: () => { throw Error('observer disconnected'); }, providerCall: async () => turn++ === 0 ? reply('', [call('read_file', { path: 'file.txt' })]) : reply() });
  await f.start(); await f.done(); assert.equal(f.get().run.status, 'completed'); assert.equal(f.artifacts.size, 1);
  const ref = f.get().run.steps.find(step => step.type === 'tool').toolResultRef;
  assert.equal(f.artifacts.get(ref.artifactId).sha256, ref.sha256); assert.equal(f.counts().calls, 2);
});

test('unknown or previous-run artifact identities cannot be paged into a new run', async t => {
  let turn = 0, previous;
  const f = fixture(t, { providerCall: async (_p, { messages }) => {
    if (turn++ === 0) return reply('', [call('read_file', { path: 'file.txt' })]);
    if (turn === 2) return reply();
    if (turn === 3) return reply('', [call('read_tool_result', { artifactId: previous, offset: 0 }, 'foreign')]);
    throw Error('An unknown page must fail preflight before another model request.');
  } });
  await f.start(); await f.done(); previous = [...f.artifacts.keys()][0]; await f.start(); await f.done(); assert.equal(f.get().run.status, 'failed');
  assert.equal(f.get().run.error.code, 'TOOL_ARTIFACT_NOT_FOUND'); assert.equal(f.counts().calls, 3);
  assert.equal(f.counts().reads, 1); assert.equal(f.artifacts.size, 1); assert.equal(f.get().run.steps.length, 1);
});

test('per-run reservation accounts for worst-case JSON and stops before exceeding 16 MiB', async t => {
  let turn = 0;
  const f = fixture(t, { fileContent: '\u0001'.repeat(256 * 1024), providerCall: async () => { turn++; return reply('', Array.from({ length: 8 }, (_, i) => call('read_file', { path: 'file.txt' }, `batch${turn}_${i}`))); } });
  await f.start(); await f.done(); assert.equal(f.get().run.error.code, 'TOOL_ARTIFACT_LIMIT'); assert.equal(f.artifacts.size, 10); assert.equal(f.counts().reads, 10);
  assert.ok([...f.artifacts.values()].reduce((n, a) => n + a.bytes, 0) <= 16 * 1024 * 1024); assert.equal(f.reservations.size, 0);
});

test('stream checkpoints keep archive bodies out of repeated session saves', async t => {
  let turn = 0;
  const f = fixture(t, { provider: { streaming: true }, fileContent: 'x'.repeat(256 * 1024), providerCall: async (_p, options) => {
    if (turn++ === 0) return reply('', [call('read_file', { path: 'file.txt' })]);
    for (let i = 0; i < 4; i++) { await options.onText('part'); await new Promise(resolve => setTimeout(resolve, 5)); } return reply('part'.repeat(4));
  } });
  await f.start(); await f.done(); assert.equal(f.get().run.status, 'completed'); assert.equal(f.saves.reduce((n, save) => n + save.artifactIds.length, 0), 1);
  assert.ok(f.saves.filter(save => save.session.run?.output?.content).length >= 2);
  assert.ok(f.saves.every(save => Buffer.byteLength(JSON.stringify(save.session)) < 32000));
});
