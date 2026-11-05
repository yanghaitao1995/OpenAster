// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';

const FILE = 'exact-plan.md';
const BEFORE = '\uFEFF# 精确计划\r\n状态：待处理\r\n保留 $& 与中文。\r\n';
const OLD = '状态：待处理', NEW = '状态：已完成 $& 中文';
const AFTER = BEFORE.split(OLD).join(NEW);
const hash = value => createHash('sha256').update(value).digest('hex');
const editArgs = { path: FILE, oldText: OLD, newText: NEW, expectedHash: hash(BEFORE) };

function toolResults(type, body) {
  if (type === 'responses') return body.input.filter(value => value.type === 'function_call_output').map(value => JSON.parse(value.output));
  if (type === 'anthropic') return body.messages.flatMap(value => Array.isArray(value.content) ? value.content : []).filter(value => value.type === 'tool_result').map(value => JSON.parse(value.content));
  return body.messages.filter(value => value.role === 'tool').map(value => JSON.parse(value.content));
}

function response(type, command, index) {
  const call = command.tool ? { id: `local-call-${index}`, name: command.tool, args: command.args } : null;
  if (type === 'openai') return { choices: [{ index: 0, message: { role: 'assistant', content: command.text ?? '', ...(call ? { tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }] };
  if (type === 'responses') return { status: 'completed', output: call ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: command.text }] }] };
  if (type === 'anthropic') return { type: 'message', role: 'assistant', stop_reason: call ? 'tool_use' : 'end_turn', content: call ? [{ type: 'tool_use', id: call.id, name: call.name, input: call.args }] : [{ type: 'text', text: command.text }] };
  return { done: true, done_reason: 'stop', message: { role: 'assistant', content: command.text ?? '', ...(call ? { tool_calls: [{ function: { name: call.name, arguments: call.args } }] } : {}) } };
}

async function fixture(t, { type = 'openai', toolMode = 'workspace', decision = 'approve' } = {}) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-edit-http-'));
  const owner = randomUUID();
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  const dataDir = path.join(root, 'data'), workspace = path.join(dataDir, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, FILE), BEFORE, { flag: 'wx' });
  const payloads = [], modelErrors = [];
  let app, cookie, csrfToken;
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); payloads.push(body);
      assert.equal(req.method, 'POST');
      assert.equal(req.url, { openai: '/v1/chat/completions', responses: '/v1/responses', anthropic: '/v1/messages', ollama: '/api/chat' }[type]);
      assert.equal(body.model, 'deterministic-edit-fixture'); assert.equal(body.stream, false);
      let command;
      if (toolMode === 'none') {
        assert.equal(Object.hasOwn(body, 'tools'), false);
        command = { tool: 'edit_file', args: editArgs };
      } else {
        const edit = body.tools.find(value => (value.function?.name ?? value.name) === 'edit_file');
        assert.ok(edit, 'Edit schema reaches the actual model transport');
        const schema = edit.function?.parameters ?? edit.parameters ?? edit.input_schema;
        assert.deepEqual([...schema.required].sort(), ['expectedHash', 'newText', 'oldText', 'path']);
        if (payloads.length === 1) command = { tool: 'read_file', args: { path: FILE } };
        else if (payloads.length === 2) {
          const previous = toolResults(type, body).at(-1);
          assert.equal(previous.untrusted_data, true);
          assert.deepEqual(previous.result, { path: FILE, content: BEFORE, sha256: hash(BEFORE) });
          command = { tool: 'edit_file', args: { ...editArgs, expectedHash: previous.result.sha256 } };
        } else {
          if (payloads.length === 3) {
            const previous = toolResults(type, body).at(-1);
            assert.equal(previous.untrusted_data, true);
            if (decision === 'deny') assert.equal(previous.error.code, 'APPROVAL_DENIED');
            else { assert.equal(previous.result.path, FILE); assert.equal(previous.result.sha256, hash(AFTER)); }
          }
          command = { text: decision === 'deny' ? '已按用户决定保留原文件。' : '精确编辑流程已完成。' };
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response(type, command, payloads.length)));
    } catch (error) {
      modelErrors.push(error);
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{}');
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app?.close();
    await new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); });
    const canonical = await fs.realpath(root);
    assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-edit-http-[a-zA-Z0-9]+$/);
    assert.equal(await fs.readFile(path.join(canonical, '.owner'), 'utf8'), owner);
    await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function request(route, { method = 'GET', data } = {}) {
    const result = await fetch(app.url + route, { method, signal: AbortSignal.timeout(10_000), headers: { ...(cookie ? { cookie, 'X-CSRF-Token': csrfToken } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    assert.equal(result.headers.get('cache-control'), 'no-store');
    return { status: result.status, data: await result.json(), headers: result.headers };
  }
  async function start(target = dataDir) {
    app = await startServer({ dataDir: target }); cookie = csrfToken = undefined;
    const boot = await request('/api/bootstrap'); assert.equal(boot.status, 200);
    cookie = boot.headers.get('set-cookie')?.split(';')[0]; csrfToken = boot.data.csrfToken;
  }
  async function stop() { await app?.close(); app = undefined; }
  await start();
  const provider = await request('/api/providers', { method: 'POST', data: { name: `Local ${type} edit`, type, model: 'deterministic-edit-fixture', baseUrl: `http://127.0.0.1:${upstream.address().port}${type === 'ollama' ? '' : '/v1'}`, streaming: false, toolMode } });
  assert.equal(provider.status, 201);
  const created = await request('/api/sessions', { method: 'POST', data: { providerId: provider.data.provider.id } });
  assert.equal(created.status, 201);
  const sessionId = created.data.session.id, sessionUrl = `/api/sessions/${sessionId}`;
  async function send(content = '仅把状态行精确改为已完成，其他内容保持不变。') {
    const result = await request(`${sessionUrl}/messages`, { method: 'POST', data: { content } });
    assert.equal(result.status, 202, JSON.stringify(result.data));
  }
  async function wait(status) {
    const end = performance.now() + 10_000;
    let current;
    while (performance.now() < end) {
      const result = await request(sessionUrl); assert.equal(result.status, 200); current = result.data.session;
      if (modelErrors.length) throw modelErrors[0];
      if (current.run?.status === status) return current;
      if (current.run && ['failed', 'cancelled'].includes(current.run.status)) throw new Error(`Unexpected task status: ${JSON.stringify(current.run)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${status}: ${JSON.stringify(current?.run)}`);
  }
  return { root, dataDir, workspace, provider: provider.data.provider, sessionId, sessionUrl, payloads, modelErrors, request, start, stop, send, wait };
}

async function pendingEdit(f) {
  const read = await f.request('/api/workspace/file?' + new URLSearchParams({ path: FILE }));
  assert.equal(read.status, 200); assert.deepEqual(read.data, { path: FILE, content: BEFORE, sha256: hash(BEFORE) });
  await f.send(); const session = await f.wait('awaiting_approval');
  assert.equal(f.payloads.length, 2);
  const approval = session.approvals.find(value => value.status === 'pending');
  assert.ok(approval); assert.equal(approval.tool, 'edit_file');
  assert.deepEqual(approval.args, { path: FILE, content: AFTER });
  assert.deepEqual(approval.preview, { before: BEFORE, after: AFTER, originalHash: hash(BEFORE), newHash: hash(AFTER) });
  assert.deepEqual(await fs.readFile(path.join(f.workspace, FILE)), Buffer.from(BEFORE));
  return { session, approval };
}

function stored(dataDir, sessionId) {
  const store = new Store(dataDir);
  try { return { session: store.getSession(sessionId), providers: store.listProviders() }; }
  finally { store.close(); }
}

for (const type of ['openai', 'responses', 'anthropic', 'ollama']) test(`${type}: actual HTTP read-to-edit approval survives SQLite restart and offline backup with exact UTF-8 bytes`, async t => {
  const f = await fixture(t, { type });
  const { approval } = await pendingEdit(f);
  assert.equal((await f.request(`/api/approvals/${approval.id}`, { method: 'POST', data: { decision: 'approve' } })).status, 200);
  const completed = await f.wait('completed');
  assert.equal(f.payloads.length, 3); assert.equal(completed.approvals[0].status, 'approved'); assert.ok(completed.approvals[0].appliedAt);
  assert.deepEqual(await fs.readFile(path.join(f.workspace, FILE)), Buffer.from(AFTER));
  const audit = await f.request('/api/audit');
  assert.equal(audit.data.entries.filter(value => value.action === 'workspace.written' && value.sessionId === f.sessionId).length, 1);
  assert.ok((await f.request(`/api/approvals/${approval.id}`, { method: 'POST', data: { decision: 'approve' } })).status >= 400);
  await f.stop(); await f.start();
  assert.deepEqual((await f.request(f.sessionUrl)).data.session.approvals, completed.approvals);
  assert.equal((await f.request('/api/workspace/file?' + new URLSearchParams({ path: FILE }))).data.sha256, hash(AFTER));
  await f.stop();
  const databaseBefore = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
  const output = path.join(f.root, 'approved-backup.json'), restored = path.join(f.root, 'approved-restored');
  await createBackup({ dataDir: f.dataDir, output });
  const envelope = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(envelope.version, 8); assert.equal(envelope.payload.sessions[0].approvals[0].tool, 'edit_file');
  await restoreBackup({ input: output, dataDir: restored });
  const restoredData = stored(restored, f.sessionId);
  assert.deepEqual(restoredData.session.approvals, completed.approvals);
  assert.equal(restoredData.providers.find(value => value.id === f.provider.id).enabled, false);
  assert.deepEqual(await fs.readFile(path.join(restored, 'workspace', FILE)), Buffer.from(AFTER));
  assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), databaseBefore);
  if (type === 'openai') {
    await f.start(); await f.send('只回复一行，不再次修改文件。');
    const next = await f.wait('completed'), archived = next.approvals.find(value => value.id === approval.id);
    assert.equal(archived.tool, 'edit_file'); assert.equal(archived.archived, true); assert.equal(archived.status, 'approved');
    assert.deepEqual(archived.args, { path: FILE }); assert.equal(Object.hasOwn(archived, 'preview'), false);
    assert.deepEqual(archived.hashes, { original: hash(BEFORE), proposed: hash(AFTER) });
    assert.equal((await f.request(`/api/providers/${f.provider.id}`, { method: 'PATCH', data: { toolMode: 'none' } })).status, 200);
    await f.stop();
    const archivedOutput = path.join(f.root, 'archived-backup.json'), archivedRestore = path.join(f.root, 'archived-restored');
    await createBackup({ dataDir: f.dataDir, output: archivedOutput });
    await restoreBackup({ input: archivedOutput, dataDir: archivedRestore });
    const saved = stored(archivedRestore, f.sessionId);
    assert.deepEqual(saved.session.approvals, next.approvals);
    assert.equal(saved.providers.find(value => value.id === f.provider.id).toolMode, 'none');
    assert.equal(saved.providers.find(value => value.id === f.provider.id).enabled, false);
  }
});

test('a real edit denial preserves the original bytes and creates no write audit', async t => {
  const f = await fixture(t, { decision: 'deny' }), { approval } = await pendingEdit(f);
  assert.equal((await f.request(`/api/approvals/${approval.id}`, { method: 'POST', data: { decision: 'deny' } })).status, 200);
  const completed = await f.wait('completed');
  assert.equal(completed.approvals[0].tool, 'edit_file'); assert.equal(completed.approvals[0].status, 'denied');
  assert.equal(Object.hasOwn(completed.approvals[0], 'appliedAt'), false);
  assert.deepEqual(await fs.readFile(path.join(f.workspace, FILE)), Buffer.from(BEFORE));
  assert.equal((await f.request('/api/audit')).data.entries.some(value => value.action === 'workspace.written'), false);
  await f.stop(); await f.start();
  assert.deepEqual((await f.request(f.sessionUrl)).data.session.approvals, completed.approvals);
});

test('conversation-only model responses cannot create edit approvals or alter files', async t => {
  const f = await fixture(t, { toolMode: 'none' }); await f.send();
  const failed = await f.wait('failed');
  assert.equal(f.payloads.length, 1); assert.equal(failed.run.error.code, 'TOOLS_DISABLED');
  assert.deepEqual(failed.approvals, []); assert.ok(failed.run.steps.every(value => value.type === 'model'));
  assert.deepEqual(await fs.readFile(path.join(f.workspace, FILE)), Buffer.from(BEFORE));
  assert.equal((await f.request('/api/audit')).data.entries.some(value => ['approval.requested', 'workspace.written'].includes(value.action)), false);
});

test('offline recovery denies a durable pending edit snapshot and never executes its stored after text', async t => {
  const f = await fixture(t), { session, approval } = await pendingEdit(f);
  await f.stop();
  // Persist the actual HTTP approval snapshot to model a checkpoint left by an interrupted process.
  const source = new Store(f.dataDir);
  try {
    // Rewind only test data to the captured durable approval checkpoint. Graceful
    // shutdown has since archived a cancellation result that did not exist then.
    const retained = new Set(session.run.steps.flatMap(step => step.toolResultRef ? [step.toolResultRef.artifactId] : []));
    for (const row of source.db.prepare('SELECT id FROM tool_artifacts WHERE session_id=? AND run_id=?').all(session.id, session.run.id)) {
      if (!retained.has(row.id)) source.db.prepare('DELETE FROM tool_artifacts WHERE session_id=? AND run_id=? AND id=?').run(session.id, session.run.id, row.id);
    }
    source.db.prepare('DELETE FROM run_history WHERE session_id=? AND run_id=?').run(session.id, session.run.id); source.putSession(session);
  } finally { source.close(); }
  const output = path.join(f.root, 'pending-backup.json'), restored = path.join(f.root, 'pending-restored');
  await createBackup({ dataDir: f.dataDir, output });
  assert.equal(JSON.parse(await fs.readFile(output, 'utf8')).payload.sessions[0].approvals[0].status, 'pending');
  await restoreBackup({ input: output, dataDir: restored });
  const saved = stored(restored, f.sessionId);
  assert.equal(saved.session.run.status, 'cancelled'); assert.equal(saved.session.run.error.code, 'BACKUP_RESTORED');
  assert.equal(saved.session.approvals[0].tool, 'edit_file'); assert.equal(saved.session.approvals[0].status, 'denied');
  assert.deepEqual(saved.session.approvals[0].preview, approval.preview);
  assert.equal(saved.providers.find(value => value.id === f.provider.id).enabled, false);
  assert.deepEqual(await fs.readFile(path.join(restored, 'workspace', FILE)), Buffer.from(BEFORE));
  await f.start(restored);
  assert.ok((await f.request(`/api/approvals/${approval.id}`, { method: 'POST', data: { decision: 'approve' } })).status >= 400);
  assert.equal(f.payloads.length, 2);
  assert.deepEqual(await fs.readFile(path.join(restored, 'workspace', FILE)), Buffer.from(BEFORE));
});

test('recomputed backup hashes cannot smuggle unknown approval tools or edit-call arguments into authorization records', async t => {
  const f = await fixture(t), { session } = await pendingEdit(f);
  await f.stop();
  const source = new Store(f.dataDir);
  try {
    // Rewind only test data to the captured durable approval checkpoint. Graceful
    // shutdown has since archived a cancellation result that did not exist then.
    const retained = new Set(session.run.steps.flatMap(step => step.toolResultRef ? [step.toolResultRef.artifactId] : []));
    for (const row of source.db.prepare('SELECT id FROM tool_artifacts WHERE session_id=? AND run_id=?').all(session.id, session.run.id)) {
      if (!retained.has(row.id)) source.db.prepare('DELETE FROM tool_artifacts WHERE session_id=? AND run_id=? AND id=?').run(session.id, session.run.id, row.id);
    }
    source.db.prepare('DELETE FROM run_history WHERE session_id=? AND run_id=?').run(session.id, session.run.id); source.putSession(session);
  } finally { source.close(); }
  const output = path.join(f.root, 'valid-backup.json'); await createBackup({ dataDir: f.dataDir, output });
  const original = JSON.parse(await fs.readFile(output, 'utf8'));
  const changes = [
    ...['shell', 'read_file', 'search_files', 'EDIT_FILE', '', null, 7, {}, ['edit_file']].map(tool => approval => { approval.tool = tool; }),
    approval => { approval.args.oldText = OLD; },
    approval => { approval.args.newText = NEW; },
    approval => { approval.args.expectedHash = hash(BEFORE); },
    approval => { approval.preview.permissionGranted = true; },
  ];
  const sourceBefore = hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite')));
  for (const [index, change] of changes.entries()) {
    const envelope = structuredClone(original); change(envelope.payload.sessions[0].approvals[0]);
    envelope.sha256 = hash(JSON.stringify(envelope.payload));
    const input = path.join(f.root, `tampered-${index}.json`), dataDir = path.join(f.root, `invalid-restore-${index}`);
    await fs.writeFile(input, JSON.stringify(envelope));
    const inputBefore = await fs.readFile(input);
    await assert.rejects(restoreBackup({ input, dataDir }), { code: 'INVALID_BACKUP' });
    await assert.rejects(fs.lstat(dataDir), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(input), inputBefore);
  }
  assert.equal(hash(await fs.readFile(path.join(f.dataDir, 'openaster.sqlite'))), sourceBefore);
  const corrupt = new Store(f.dataDir);
  try { const value = corrupt.getSession(f.sessionId); value.approvals[0].tool = 'shell'; corrupt.putSession(value); } finally { corrupt.close(); }
  const invalidOutput = path.join(f.root, 'invalid-source-backup.json');
  await assert.rejects(createBackup({ dataDir: f.dataDir, output: invalidOutput }), { code: 'INVALID_BACKUP' });
  await assert.rejects(fs.lstat(invalidOutput), { code: 'ENOENT' });
});

test('v1 write approvals and legacy missing-tool records remain recoverable without granting executable approvals', async t => {
  const f = await fixture(t), { session } = await pendingEdit(f);
  await f.stop();
  const source = new Store(f.dataDir);
  try {
    // Rewind only test data to the captured durable approval checkpoint. Graceful
    // shutdown has since archived a cancellation result that did not exist then.
    const retained = new Set(session.run.steps.flatMap(step => step.toolResultRef ? [step.toolResultRef.artifactId] : []));
    for (const row of source.db.prepare('SELECT id FROM tool_artifacts WHERE session_id=? AND run_id=?').all(session.id, session.run.id)) {
      if (!retained.has(row.id)) source.db.prepare('DELETE FROM tool_artifacts WHERE session_id=? AND run_id=? AND id=?').run(session.id, session.run.id, row.id);
    }
    source.db.prepare('DELETE FROM run_history WHERE session_id=? AND run_id=?').run(session.id, session.run.id); source.putSession(session);
  } finally { source.close(); }
  const output = path.join(f.root, 'source-backup.json'); await createBackup({ dataDir: f.dataDir, output });
  const original = JSON.parse(await fs.readFile(output, 'utf8'));
  for (const variant of ['write_file', 'missing']) {
    const envelope = structuredClone(original), approval = envelope.payload.sessions[0].approvals[0];
    envelope.version = 1; delete envelope.payload.summaryJobs; delete envelope.payload.toolArtifacts; delete envelope.payload.runHistory;
    for (const value of envelope.payload.sessions) for (const step of value.run?.steps ?? []) { delete step.toolResultRef; delete step.contextPlan; }
    if (variant === 'missing') delete approval.tool; else approval.tool = variant;
    envelope.sha256 = hash(JSON.stringify(envelope.payload));
    const input = path.join(f.root, `legacy-${variant}.json`), dataDir = path.join(f.root, `restored-${variant}`);
    await fs.writeFile(input, JSON.stringify(envelope)); await restoreBackup({ input, dataDir });
    const saved = stored(dataDir, f.sessionId).session.approvals[0];
    assert.equal(saved.status, 'denied'); assert.equal(saved.tool, variant === 'missing' ? undefined : variant);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'workspace', FILE)), Buffer.from(BEFORE));
  }
});
