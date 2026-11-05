// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'openaster-output-'));
  t.after(async () => {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('openaster-output-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('output projection excludes history and approvals and tracks run/step/terminal transitions', async t => {
  const root = await directory(t);
  const store = new Store(root);
  try {
    const session = store.createSession();
    const project = () => store.getSessionOutput(session.id);
    assert.deepEqual(project(), { sessionId: session.id, updatedAt: session.updatedAt, run: null });
    assert.equal(store.getSessionOutput('missing'), null);
    session.messages = [{ role: 'user', content: '历史数据'.repeat(300000) }];
    session.approvals = [{ id: 'not-an-output', content: '审批内容不得重复传输', status: 'denied' }];
    session.run = { id: 'run-one', status: 'running', steps: [{ content: '工具内部信息' }],
      output: { stepId: 'step-one', content: '当前片段', status: 'streaming', extra: '不在投影内' } };
    store.putSession(session);
    assert.deepEqual(project().run, { id: 'run-one', status: 'running',
      output: { stepId: 'step-one', content: '当前片段', status: 'streaming' } });
    const small = JSON.stringify(project());
    assert.ok(Buffer.byteLength(small) < 500);
    for (const hidden of ['历史数据', '审批内容', '工具内部信息', '不在投影内']) assert.ok(!small.includes(hidden));
    session.run.output = { stepId: 'step-two', content: '工具后的下一轮', status: 'processing' };
    store.putSession(session);
    assert.equal(project().run.output.stepId, 'step-two');
    session.run.status = 'completed'; session.run.output = null;
    store.putSession(session);
    assert.deepEqual(project().run, { id: 'run-one', status: 'completed', output: null });
    session.run = { id: 'run-two', status: 'running', output: null };
    store.putSession(session);
    assert.equal(project().run.id, 'run-two');
    store.deleteSession(session.id);
    assert.equal(project(), null);
  } finally { store.close(); }
});

test('HTTP output endpoint authenticates, is not cached, and avoids full-session reads', async t => {
  const root = await directory(t);
  const seed = new Store(root);
  const session = seed.createSession();
  session.messages = [{ role: 'user', content: 'history-not-in-output-'.repeat(100000) }];
  session.run = { id: 'done-run', status: 'failed', steps: [],
    output: { stepId: 'saved-step', content: '未完成片段', status: 'interrupted' } };
  seed.putSession(session); seed.close();
  const app = await startServer({ dataDir: root });
  // A regression that calls requireSession() would invoke this full-history reader.
  const fullRead = Store.prototype.getSession;
  Store.prototype.getSession = () => { throw new Error('Full history must not be read for an output refresh'); };
  try {
    const bootstrap = await fetch(`${app.url}/api/bootstrap`);
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    await bootstrap.json();
    const endpoint = `${app.url}/api/sessions/${session.id}/output`;
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { cookie, Origin: 'https://invalid.example' } })).status, 403);
    const response = await fetch(endpoint, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const raw = await response.text();
    assert.ok(Buffer.byteLength(raw) < 500);
    const result = JSON.parse(raw);
    assert.equal(result.sessionId, session.id);
    assert.deepEqual(result.run, { id: 'done-run', status: 'failed',
      output: { stepId: 'saved-step', content: '未完成片段', status: 'interrupted' } });
    assert.equal((await fetch(`${app.url}/api/sessions/missing/output`, { headers: { cookie } })).status, 404);
  } finally {
    Store.prototype.getSession = fullRead;
    await app.close();
  }
});
