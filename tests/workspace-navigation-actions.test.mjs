// SPDX-License-Identifier: Apache-2.0
// Real registry, SQLite backup/restore, HTTP service and native action/lifecycle.
// Menu templates are invoked in Node; no Electron picker, OS keyring or relaunch is simulated as native evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { createWorkspaceProfiles } from '../desktop/workspace-profiles.mjs';
import { createWorkspaceNavigation } from '../desktop/workspace-navigation.mjs';
import { createWorkspaceActions } from '../desktop/workspace-actions.mjs';
import { createDesktopLifecycle } from '../desktop/lifecycle.mjs';
import { createSecretStore } from '../desktop/secret-store.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { Store } from '../server/store.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { startServer } from '../server/index.mjs';
import { acquireDataLock } from '../server/lock.mjs';

const time = '2026-10-30T00:00:00.000Z';
const later = '2026-10-30T00:01:00.000Z';
const leaves = menu => menu.submenu.flatMap(item => item.submenu ? leaves(item) : [item]);
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected owned navigation event did not arrive')), 15000); })]); }
  finally { clearTimeout(timer); }
}
// Test-only authenticated encryption exercises the actual secret-store files;
// it is deliberately not a claim about Windows DPAPI or another OS keychain.
function fixtureCrypto() {
  const key = randomBytes(32);
  return { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    async encryptStringAsync(text) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const content = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), content]);
    },
    async decryptStringAsync(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'), shouldReEncrypt: false };
    } };
}

async function fixture(t, { otherProfiles = 1, confirmSwitch, providerCall } = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-navigation-actions-'));
  const owner = randomUUID(), identity = await fs.lstat(root, { bigint: true });
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  const services = [], releases = [];
  t.after(async () => {
    for (const release of releases) release();
    for (const service of services) await service.close();
    const canonical = await fs.realpath(root), current = await fs.lstat(root, { bigint: true });
    assert.equal(path.dirname(canonical), parent); assert.match(path.basename(canonical), /^openaster-navigation-actions-[a-zA-Z0-9]+$/);
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.equal(current.isSymbolicLink(), false);
    assert.equal(await fs.readFile(path.join(canonical, '.owner'), 'utf8'), owner);
    await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const data = path.join(root, 'data'), app = path.join(root, 'app'), source = path.join(root, 'source');
  for (const directory of [data, app, source, path.join(source, 'workspace')]) await fs.mkdir(directory);
  const text = '\ufeff原来的恢复文件🙂\r\nKeep exact bytes.\r\n';
  await fs.writeFile(path.join(source, 'workspace', 'note.txt'), text);
  const sourceStore = new Store(source);
  try {
    sourceStore.putProvider({ id: 'saved-model', name: 'Saved model', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true, toolMode: 'none' });
    sourceStore.putSession({ id: 'saved-session', title: '恢复的原任务', providerId: 'saved-model', createdAt: time, updatedAt: later,
      messages: [{ id: 'saved-user', role: 'user', content: '原用户资料', createdAt: time }, { id: 'saved-answer', role: 'assistant', content: '原答复', createdAt: later }], approvals: [],
      run: { id: 'saved-run', status: 'completed', startedAt: time, finishedAt: later,
        steps: [{ id: 'saved-step', type: 'model', title: '模型请求', detail: '', status: 'completed', createdAt: time,
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null } }] } });
  } finally { sourceStore.close(); }
  const input = path.join(root, 'backup.json'); await createBackup({ dataDir: source, output: input });
  const options = { userData: data, homeDirectory: root, appRoots: [app] };
  let profiles = createWorkspaceProfiles(options); await profiles.initialize();
  const { profile: restored } = await profiles.createRestored({ restore: ({ dataDir }) => restoreBackup({ input, dataDir }) });
  const restoredStore = new Store(restored.dataDir); let savedSession, savedHistory;
  try { savedSession = restoredStore.getSession('saved-session'); savedHistory = restoredStore.getRunHistory('saved-session', 'saved-run'); }
  finally { restoredStore.close(); }
  const secretStore = createSecretStore({ directory: restored.secretsDir, crypto: fixtureCrypto() }), secret = randomBytes(24).toString('hex');
  await secretStore.set('saved-model', secret); // A key explicitly entered after restore, never restored from the archive.
  const databasePath = path.join(restored.dataDir, 'openaster.sqlite'), secretPath = path.join(restored.secretsDir, 'saved-model.secret');
  const databaseBytes = await fs.readFile(databasePath), secretBytes = await fs.readFile(secretPath);
  for (let index = 0; index < otherProfiles; index++) {
    const project = path.join(root, `project-${index}`); await fs.mkdir(project);
    await profiles.activate(await profiles.inspect(project));
  }
  profiles = createWorkspaceProfiles(options); await profiles.initialize();
  const active = await profiles.getActive(), registry = path.join(data, 'workspaces.json'), registryBytes = await fs.readFile(registry);
  const workspaceOptions = target => target.kind === 'restored' ? { createRoot: false, expectedIdentity: target.identity }
    : { createRoot: false, expectedIdentity: target.identity, protectedRoots: [data, app], denySensitivePaths: true, projectScan: true };
  const service = await startServer({ port: 0, dataDir: active.dataDir, workspace: active.workspace, workspaceId: active.id,
    workspaceOptions: workspaceOptions(active), ...(providerCall ? { runtimeOptions: { providerCall } } : {}) });
  services.push(service);
  const response = await fetch(service.url + '/api/bootstrap'), bootstrap = await response.json();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  async function request(route, body) {
    const response = await fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
      headers: { cookie, 'X-CSRF-Token': bootstrap.csrfToken, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  }
  const events = [], failures = [], closeOptions = [], selections = [], confirmations = [], activations = [], operations = [];
  const lifecycle = createDesktopLifecycle({
    closeService: options => { closeOptions.push(options); return service.close(options); },
    relaunch: async () => { events.push('relaunch'); }, quit: () => { events.push('quit'); },
    reportError: async (error, context) => { failures.push({ code: error.code, restartRequired: context.restartRequired }); },
  });
  const actions = createWorkspaceActions({ profiles: { list: () => profiles.list(), inspect: candidate => profiles.inspect(candidate),
    activate: async selection => {
      assert.equal(service.server.listening, false, 'Registry activation follows actual server shutdown');
      const release = await acquireDataLock(active.dataDir); await release();
      activations.push(selection); return profiles.activate(selection);
    } }, activeProfile: active, lifecycle,
    dialogs: { chooseDirectory: () => assert.fail('An all-workspace ID must not open/rebind through the directory chooser'),
      confirmSwitch: async (target, signal) => { confirmations.push(target.id); return confirmSwitch ? confirmSwitch(target, signal) : true; } },
    validateWorkspace: async target => { if (target.kind !== 'default') await createWorkspace(target.workspace, workspaceOptions(target)).getIdentity(); },
    runJob: async () => assert.fail('Selecting a registered workspace must not restore a second copy') });
  const entries = await profiles.list();
  const navigation = createWorkspaceNavigation({ entries, activeId: active.id, onSelect: id => { selections.push(id); const work = actions.chooseWorkspace(id); operations.push(work); return work; } });
  const select = id => { const leaf = leaves(navigation.all).find(item => item.id === `workspace-all-${id}`); assert.ok(leaf); const next = operations.length; leaf.click(); return operations[next]; };
  async function preserved() {
    assert.deepEqual(await fs.readFile(databasePath), databaseBytes); assert.deepEqual(await fs.readFile(secretPath), secretBytes);
    assert.equal(await fs.readFile(path.join(restored.workspace, 'note.txt'), 'utf8'), text);
    assert.ok(await secretStore.get('saved-model') === secret, 'The original synthetic credential remains decryptable');
  }
  return { root, profiles, restored, active, registry, registryBytes, entries, navigation, select, request, service, services, releases,
    lifecycle, events, failures, closeOptions, selections, confirmations, activations, preserved, savedSession, savedHistory, databasePath, databaseBytes, secretPath, secretBytes };
}

test('a restored workspace beyond the recent twenty opens by its original ID through the all-workspaces action', { timeout: 60000 }, async t => {
  const f = await fixture(t, { otherProfiles: 20 });
  assert.equal(f.entries.length, 22);
  assert.ok(!leaves(f.navigation.recent).some(item => item.id === `workspace-recent-${f.restored.id}`));
  assert.ok(leaves(f.navigation.all).some(item => item.id === `workspace-all-${f.restored.id}`));
  await assert.rejects(f.profiles.inspect(f.restored.workspace), { code: 'WORKSPACE_PROTECTED_PATH' });
  assert.equal(await f.select(f.restored.id), true);
  assert.deepEqual(f.selections, [f.restored.id]); assert.deepEqual(f.confirmations, [f.restored.id]); assert.deepEqual(f.activations, [f.restored.id]);
  assert.deepEqual(f.closeOptions, [{ ifIdle: true }]); assert.deepEqual(f.failures, []); assert.deepEqual(f.events, ['relaunch', 'quit']);
  assert.deepEqual(await f.profiles.getActive(), f.restored); assert.equal((await f.profiles.list()).length, 22);
  await f.preserved();
  const reopened = new Store(f.restored.dataDir);
  try { assert.deepEqual(reopened.getSession('saved-session'), f.savedSession); assert.deepEqual(reopened.getRunHistory('saved-session', 'saved-run'), f.savedHistory); }
  finally { reopened.close(); }
});

test('active selection and cancelled all-workspaces confirmation preserve the running service and registry', { timeout: 60000 }, async t => {
  const f = await fixture(t, { confirmSwitch: async () => false });
  const active = leaves(f.navigation.all).find(item => item.checked);
  assert.equal(active.id, `workspace-all-${f.active.id}`); assert.equal(active.enabled, false);
  assert.equal(await f.select(f.active.id), false); // Even a programmatic late click retains the action guard.
  assert.deepEqual(f.confirmations, []);
  assert.equal(await f.select(f.restored.id), false);
  assert.deepEqual(f.confirmations, [f.restored.id]); assert.deepEqual(f.closeOptions, []); assert.deepEqual(f.activations, []); assert.deepEqual(f.events, []);
  assert.deepEqual(await fs.readFile(f.registry), f.registryBytes); assert.equal((await f.request('/api/state')).status, 200); await f.preserved();
});

test('a concurrent all-workspaces click and a late confirmation after quit cannot activate another profile', { timeout: 60000 }, async t => {
  const entered = deferred(), decision = deferred(); let signal;
  const f = await fixture(t, { confirmSwitch: async (_target, currentSignal) => { signal = currentSignal; entered.resolve(); return decision.promise; } });
  f.releases.push(() => decision.resolve(false));
  const first = f.select(f.restored.id); await within(entered.promise);
  assert.equal(await f.select(f.restored.id), false); assert.equal(f.confirmations.length, 1);
  const quitting = f.lifecycle.requestQuit(); assert.equal(signal.aborted, true); decision.resolve(true);
  assert.equal(await within(first), false); await within(quitting);
  assert.deepEqual(f.closeOptions, [undefined]); assert.deepEqual(f.activations, []); assert.deepEqual(f.events, ['quit']); assert.deepEqual(f.failures, []);
  assert.deepEqual(await fs.readFile(f.registry), f.registryBytes); await f.preserved();
});

for (const when of ['before-selection', 'during-confirmation']) test(`a stale restored workspace ${when} fails closed without rebinding its preserved records`, { timeout: 60000 }, async t => {
  const entered = deferred(), decision = deferred();
  const f = await fixture(t, { confirmSwitch: when === 'during-confirmation' ? async () => { entered.resolve(); return decision.promise; } : undefined });
  f.releases.push(() => decision.resolve(false));
  let selection;
  if (when === 'during-confirmation') { selection = f.select(f.restored.id); await within(entered.promise); }
  const saved = path.join(f.restored.dataDir, 'original-workspace');
  await fs.rename(f.restored.workspace, saved); await fs.mkdir(f.restored.workspace);
  await fs.writeFile(path.join(f.restored.workspace, 'unknown-marker.txt'), 'replacement must not be adopted or deleted');
  if (when === 'before-selection') selection = f.select(f.restored.id); else decision.resolve(true);
  assert.equal(await selection, false);
  assert.equal(f.failures.length, 1); assert.equal(f.failures[0].restartRequired, when === 'during-confirmation');
  assert.equal(f.failures[0].code, when === 'before-selection' ? 'WORKSPACE_CHANGED' : 'WORKSPACE_IDENTITY_CHANGED');
  assert.deepEqual(await fs.readFile(f.registry), f.registryBytes);
  assert.deepEqual(await fs.readFile(f.databasePath), f.databaseBytes); assert.deepEqual(await fs.readFile(f.secretPath), f.secretBytes);
  assert.equal(await fs.readFile(path.join(f.restored.workspace, 'unknown-marker.txt'), 'utf8'), 'replacement must not be adopted or deleted');
  assert.equal((await f.profiles.getActive()).id, f.active.id);
  assert.deepEqual(f.events, when === 'during-confirmation' ? ['relaunch', 'quit'] : []);
  if (when === 'before-selection') { assert.deepEqual(f.confirmations, []); assert.deepEqual(f.closeOptions, []); assert.equal((await f.request('/api/state')).status, 200); }
});

test('the all-workspaces callback cannot bypass an actually running model task or its atomic busy check', { timeout: 60000 }, async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { providerCall: async () => { entered.resolve(); await release.promise; return { content: 'Local fixture finished', toolCalls: [] }; } });
  f.releases.push(() => release.resolve());
  const created = await f.request('/api/providers', { name: 'Local only', type: 'openai', model: 'fixture', baseUrl: 'http://127.0.0.1:9/v1', toolMode: 'none' });
  assert.equal(created.status, 201);
  const session = (await f.request('/api/sessions', { title: 'Preserve the active task', providerId: created.provider.id })).session;
  const started = await f.request(`/api/sessions/${session.id}/messages`, { content: 'Keep this run' }); assert.equal(started.status, 202); await within(entered.promise);
  assert.equal(await f.select(f.restored.id), false);
  assert.deepEqual(f.failures, [{ code: 'WORKSPACE_BUSY', restartRequired: false }]); assert.deepEqual(f.closeOptions, [{ ifIdle: true }]);
  assert.deepEqual(f.activations, []); assert.deepEqual(f.events, []); assert.deepEqual(await fs.readFile(f.registry), f.registryBytes);
  const current = await f.request(`/api/sessions/${session.id}`); assert.equal(current.session.run.id, started.runId); assert.equal(current.session.run.status, 'running');
  await assert.rejects(acquireDataLock(f.active.dataDir), { code: 'DATA_LOCKED' }); await f.preserved(); release.resolve();
});
