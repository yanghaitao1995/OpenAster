// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startServer } from '../server/index.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { createWorkspaceProfiles } from '../desktop/workspace-profiles.mjs';
import { createDesktopLifecycle } from '../desktop/lifecycle.mjs';
import { createWorkspaceActions } from '../desktop/workspace-actions.mjs';
import { runBackupJob } from '../desktop/backup-worker-client.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function connect(service) {
  const response = await fetch(service.url + '/api/bootstrap'), bootstrap = await response.json();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { bootstrap, async request(route, body) {
    const result = await fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
      headers: { cookie, 'X-CSRF-Token': bootstrap.csrfToken, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, ...await result.json() };
  } };
}
async function until(get, accept) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const item = await get(); if (accept(item)) return item; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('desktop backup integration timed out');
}
async function fixture(t, external = false) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'openaster-actions-'));
  const userData = path.join(root, 'data'), appRoot = path.join(root, 'app');
  await fs.mkdir(userData); await fs.mkdir(appRoot);
  const profiles = createWorkspaceProfiles({ userData, appRoots: [appRoot], homeDirectory: root }); await profiles.initialize();
  if (external) { const project = path.join(root, 'project'); await fs.mkdir(project); await profiles.activate(await profiles.inspect(project)); }
  const services = [], vault = new Map();
  t.after(async () => { for (const service of services) await service.close(); assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const options = profile => profile.kind === 'external' ? { createRoot: false, expectedIdentity: profile.identity, protectedRoots: [userData, appRoot], denySensitivePaths: true }
    : profile.kind === 'restored' ? { createRoot: false, expectedIdentity: profile.identity } : undefined;
  async function open(runtimeOptions) {
    const profile = await profiles.getActive();
    const service = await startServer({ dataDir: profile.dataDir, workspace: profile.workspace, workspaceId: profile.id, workspaceName: profile.label,
      workspaceOptions: options(profile), runtimeOptions, secretStore: { get: id => vault.get(profile.id + id), set: (id, value) => vault.set(profile.id + id, value), delete: id => vault.delete(profile.id + id) } });
    services.push(service); const events = [], errors = [];
    const lifecycle = createDesktopLifecycle({ closeService: value => service.close(value), relaunch: () => events.push('relaunch'), quit: () => events.push('quit'), reportError: async error => errors.push(error) });
    const dialogs = { chooseDirectory: async () => null, chooseBackupOutput: async () => path.join(root, 'backup.json'), chooseRestoreInput: async () => path.join(root, 'backup.json'),
      confirmSwitch: async () => true, confirmBackup: async () => true, confirmRestore: async () => true,
      backupDone: async result => events.push(['saved', result.path]), restoreDone: async value => events.push(['restored', value.profile.id]),
    };
    const backupIdentity = { workspace: await createWorkspace(profile.workspace, { ...options(profile), createRoot: false }).getIdentity(), data: await createWorkspace(profile.dataDir, { createRoot: false }).getIdentity() };
    const actions = createWorkspaceActions({ profiles, activeProfile: profile, lifecycle, dialogs, backupIdentity, runJob: runBackupJob,
      validateWorkspace: async target => { if (target.kind !== 'default') await createWorkspace(target.workspace, options(target)).getIdentity(); } });
    return { profile, service, actions, dialogs, lifecycle, events, errors, ...await connect(service) };
  }
  return { root, profiles, open };
}

for (const external of [false, true]) test(`desktop ${external ? 'external' : 'default'} backup restores real tasks, histories, attachments and tool bytes into an independently opened profile`, async t => {
  const f = await fixture(t, external); let calls = 0;
  let current = await f.open({ providerCall: async () => {
    calls++;
    if (calls === 1) return { content: '', toolCalls: [{ id: 'read-original', name: 'read_file', args: { path: 'notes.txt' } }] };
    if (calls === 3) return { content: '', toolCalls: [{ id: 'write-proposal', name: 'write_file', args: { path: 'never-written.txt', content: 'pending' } }] };
    return { content: '已完成读取', toolCalls: [] };
  } });
  const originalProfile = current.profile, text = '\ufeff真实本地恢复🙂\r\n';
  const provider = (await current.request('/api/providers', { name: 'Local fixture only', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'never-export-fixture-key' })).provider;
  assert.equal((await current.request('/api/workspace/files', { path: 'notes.txt', content: text })).status, 201);
  const session = (await current.request('/api/sessions', { title: '需要恢复的任务', providerId: provider.id })).session;
  const route = `/api/sessions/${session.id}`;
  const run = await current.request(route + '/messages', { content: '读取资料', files: [{ path: 'notes.txt', sha256: hash(text) }] });
  assert.equal(run.status, 202);
  const completed = (await until(() => current.request(route), value => value.session?.run?.status === 'completed')).session;
  const ref = completed.run.steps.find(step => step.toolResultRef).toolResultRef;
  const artifactRoute = `${route}/runs/${run.runId}/artifacts/${ref.artifactId}`;
  const archived = await current.request(artifactRoute);
  assert.equal(JSON.parse(archived.page.content).result.content, text);
  assert.equal((await current.request(route + '/messages', { content: '写入前等待批准' })).status, 202);
  const waiting = (await until(() => current.request(route), value => value.session?.run?.status === 'awaiting_approval')).session;
  const approvalId = waiting.approvals.find(item => item.status === 'pending').id;
  assert.equal(await current.actions.backup(), false); assert.equal(current.errors[0].code, 'WORKSPACE_BUSY');
  assert.deepEqual(current.events, []);
  assert.equal((await current.request(route)).session.run.status, 'awaiting_approval');
  await current.request(route + '/cancel', {});
  await until(() => current.request(route), value => value.session?.run?.status === 'cancelled');
  const backup = await current.actions.backup(); assert.equal(backup.sessions, 1); assert.equal(backup.toolArtifacts, 2);
  assert.deepEqual(current.events, [['saved', path.join(f.root, 'backup.json')], 'relaunch', 'quit']);
  assert.ok(!(await fs.readFile(backup.path, 'utf8')).includes('never-export-fixture-key'));
  current = await f.open(); assert.equal(current.profile.id, originalProfile.id);
  const restored = await current.actions.restore(); assert.equal(restored.profile.kind, 'restored'); assert.notEqual(restored.profile.id, originalProfile.id);
  current = await f.open(); assert.equal(current.profile.id, restored.profile.id);
  const state = current.bootstrap;
  assert.equal(state.workspace.id, restored.profile.id); assert.equal(state.sessions[0].id, session.id);
  assert.equal(state.providers.find(item => item.id === provider.id).enabled, false);
  assert.equal(state.providers.find(item => item.id === provider.id).hasKey, false);
  const loaded = (await current.request(route)).session;
  assert.equal(loaded.messages[0].contextFiles[0].content, text);
  assert.equal((await current.request(route + '/runs')).runs.length, 2);
  assert.deepEqual(await current.request(artifactRoute), archived);
  assert.equal((await current.request(`/api/approvals/${approvalId}`, { decision: 'approve' })).status, 409);
  assert.equal((await current.request(route + '/messages', { content: 'disabled connection' })).status, 409);
  assert.equal(await fs.readFile(path.join(originalProfile.workspace, 'notes.txt'), 'utf8'), text);
  assert.equal(await fs.readFile(path.join(current.profile.workspace, 'notes.txt'), 'utf8'), text);
  await assert.rejects(fs.lstat(path.join(current.profile.workspace, 'never-written.txt')), { code: 'ENOENT' });
  await current.actions.chooseWorkspace(originalProfile.id);
  current = await f.open(); assert.equal(current.profile.id, originalProfile.id);
  await current.actions.chooseWorkspace(restored.profile.id);
  current = await f.open(); assert.equal(current.profile.id, restored.profile.id); assert.equal(current.bootstrap.sessions[0].id, session.id);
});

test('native action cancellation and invalid restore preserve original records; stopped failure requests reopen', async t => {
  const f = await fixture(t); const current = await f.open();
  const session = (await current.request('/api/sessions', { title: 'keep this task' })).session;
  current.dialogs.chooseBackupOutput = async () => null;
  assert.equal(await current.actions.backup(), false);
  current.dialogs.confirmRestore = async () => false;
  assert.equal(await current.actions.restore(), false);
  assert.deepEqual(current.events, []); assert.equal((await current.request(`/api/sessions/${session.id}`)).status, 200);
  current.dialogs.confirmRestore = async () => true;
  await fs.writeFile(path.join(f.root, 'backup.json'), '{"invalid":true}');
  assert.equal(await current.actions.restore(), false);
  assert.equal(current.errors.length, 1); assert.deepEqual(current.events, ['relaunch', 'quit']);
  const reopened = await f.open(); assert.equal(reopened.profile.id, 'default'); assert.equal(reopened.bootstrap.sessions[0].id, session.id);
  assert.equal((await f.profiles.list()).length, 1);
});
