// SPDX-License-Identifier: Apache-2.0
// Real HTTP, storage, filesystem and desktop action/lifecycle integration.
// This does not launch Electron or exercise an OS picker, keychain or relaunch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { startServer } from '../server/index.mjs';
import { acquireDataLock } from '../server/lock.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { createWorkspaceProfiles } from '../desktop/workspace-profiles.mjs';
import { createDesktopLifecycle } from '../desktop/lifecycle.mjs';
import { createWorkspaceActions } from '../desktop/workspace-actions.mjs';
import { createSecretStore } from '../desktop/secret-store.mjs';

const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const hash = value => createHash('sha256').update(value).digest('hex');
function deferred() { let resolve; const promise = new Promise(accept => { resolve = accept; }); return { promise, resolve }; }
async function within(promise, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Expected owned HTTP/filesystem/lifecycle event did not arrive')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Exercise the actual persistent secret-store queue/files with a test-only
// authenticated encryption adapter. Never present this as a DPAPI/keyring test.
function fixtureCrypto() {
  const encryptionKey = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    async encryptStringAsync(value) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    async decryptStringAsync(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    },
  };
}

async function fixture(t, { retrySwitch, onNextModel } = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-native-busy-'));
  const owner = randomUUID(), identity = await fs.lstat(root, { bigint: true });
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  const services = [], clients = new Set(), gates = [], originals = new Map();
  t.after(async () => {
    for (const gate of gates) gate.release.resolve();
    for (const client of clients) client.destroy();
    try { for (const service of services) await service.close(); }
    finally { for (const [method, original] of originals) fs[method] = original; syncBuiltinESMExports(); }
    const canonical = await fs.realpath(root), current = await fs.lstat(root, { bigint: true });
    assert.equal(path.dirname(canonical), parent);
    assert.match(path.basename(canonical), /^openaster-native-busy-[a-zA-Z0-9]+$/u);
    assert.equal(current.isSymbolicLink(), false); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.equal(await fs.readFile(path.join(canonical, '.owner'), 'utf8'), owner);
    await fs.rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const userData = path.join(root, 'data'), appRoot = path.join(root, 'app');
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  for (const directory of [userData, appRoot, first, second]) await fs.mkdir(directory);
  await fs.mkdir(path.join(first, 'slow-directory'));
  await fs.writeFile(path.join(first, 'slow-directory', 'nested.txt'), 'A real scanned entry');
  await fs.writeFile(path.join(first, 'slow-read.txt'), 'A real preview read');
  const text = '\ufeff保留资料🙂\r\nOriginal snapshot\r\n';
  await fs.writeFile(path.join(first, 'notes.txt'), text);
  await fs.writeFile(path.join(second, 'target.txt'), 'A separate workspace');
  const profiles = createWorkspaceProfiles({ userData, appRoots: [appRoot], homeDirectory: root });
  await profiles.initialize();
  const profile = await profiles.activate(await profiles.inspect(first));
  const registry = path.join(userData, 'workspaces.json');
  const crypto = fixtureCrypto(), secretStore = createSecretStore({ directory: profile.secretsDir, crypto });
  const secret = randomBytes(32).toString('hex');
  const options = target => ({ createRoot: false, expectedIdentity: target.identity,
    protectedRoots: [userData, appRoot], denySensitivePaths: true, projectScan: true });
  let modelCalls = 0;
  const service = await startServer({ port: 0, dataDir: profile.dataDir, workspace: profile.workspace,
    workspaceId: profile.id, workspaceName: profile.label, workspaceOptions: options(profile), secretStore,
    runtimeOptions: { providerCall: async provider => {
      // Boolean assertions cannot print either the synthetic key or a value returned by the vault.
      assert.ok(provider.apiKey === secret, 'The local provider receives the original synthetic credential');
      modelCalls++;
      if (modelCalls === 1) return { content: '', toolCalls: [{ id: 'original-read', name: 'read_file', args: { path: 'notes.txt' } }] };
      if (modelCalls > 2 && onNextModel) await onNextModel();
      return { content: '本机测试已完成', toolCalls: [] };
    } },
  });
  services.push(service);

  function raw(endpoint, { body, headers = auth } = {}) {
    return within(new Promise((resolve, reject) => {
      const client = http.request(service.url + endpoint, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...headers, Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
      clients.add(client); client.once('close', () => clients.delete(client)); client.once('error', reject);
      client.once('response', response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
        response.once('end', () => {
          try { resolve({ status: response.statusCode, headers: response.headers, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
          catch (error) { reject(error); }
        });
      });
      client.end(body === undefined ? undefined : JSON.stringify(body));
    }));
  }
  let auth;
  const bootstrap = await raw('/api/bootstrap', { headers: {} }); assert.equal(bootstrap.status, 200);
  auth = { cookie: bootstrap.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': bootstrap.data.csrfToken };
  async function request(endpoint, body) {
    const result = await raw(endpoint, { body });
    assert.equal(result.headers['cache-control'], 'no-store');
    return { status: result.status, ...result.data };
  }

  // Keep a genuine event stream open: its socket must not itself prevent a later
  // idle switch. Notifications, rather than fixed sleeps, synchronize run reads.
  const ready = deferred(), streamClosed = deferred(), waiters = new Set(); let sequence = 0;
  const eventClient = http.get(service.url + '/api/events', { headers: auth });
  clients.add(eventClient); eventClient.once('close', () => { clients.delete(eventClient); streamClosed.resolve(); });
  eventClient.once('error', () => { ready.resolve(false); for (const wake of waiters) wake(); });
  eventClient.once('response', response => {
    let buffer = ''; response.setEncoding('utf8');
    response.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith('event:')) { sequence++; ready.resolve(true); for (const wake of waiters) wake(); waiters.clear(); }
      }
    });
    response.on('error', () => { for (const wake of waiters) wake(); });
  });
  assert.equal(await within(ready.promise), true);
  async function completed(route, runId) {
    return within((async () => {
      for (;;) {
        const before = sequence, result = await request(route);
        assert.equal(result.status, 200);
        if (result.session.run?.id === runId && result.session.run.finishedAt) {
          assert.equal(result.session.run.status, 'completed'); return result.session;
        }
        if (before === sequence) await new Promise(resolve => waiters.add(resolve));
      }
    })());
  }
  const providerResult = await request('/api/providers', { name: 'Local credential fixture', type: 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: secret });
  assert.equal(providerResult.status, 201); const provider = providerResult.provider;
  const created = await request('/api/sessions', { title: '原工作区任务', providerId: provider.id }); assert.equal(created.status, 201);
  const route = '/api/sessions/' + created.session.id;
  const started = await request(route + '/messages', { content: '读取当时资料', files: [{ path: 'notes.txt', sha256: hash(text) }] });
  assert.equal(started.status, 202);
  const session = await completed(route, started.runId);
  const reference = session.run.steps.find(step => step.toolResultRef).toolResultRef;
  const artifactRoute = route + '/runs/' + started.runId + '/artifacts/' + reference.artifactId;
  const history = await request(route + '/runs/' + started.runId), artifact = await request(artifactRoute);
  assert.equal(history.status, 200); assert.equal(artifact.status, 200); assert.equal(artifact.page.complete, true);
  assert.equal(JSON.parse(artifact.page.content).result.content, text); assert.equal(hash(artifact.page.content), reference.sha256);
  assert.equal(modelCalls, 2);
  const beforeRegistry = await fs.readFile(registry), beforeProfiles = await profiles.list();

  function hold(kind) {
    const gate = { entered: deferred(), release: deferred(), finished: deferred(), active: 0, starts: 0 };
    gates.push(gate);
    if (kind === 'index') {
      const original = fs.opendir; originals.set('opendir', original);
      const target = key(path.join(first, 'slow-directory'));
      fs.opendir = async function (candidate, ...args) {
        if (typeof candidate !== 'string' || key(candidate) !== target || gate.starts) return original.call(this, candidate, ...args);
        gate.starts++; gate.active++; gate.entered.resolve();
        try { await gate.release.promise; return await original.call(this, candidate, ...args); }
        finally { gate.active--; gate.finished.resolve(); }
      };
    } else {
      const original = fs.open; originals.set('open', original);
      const target = key(path.join(first, 'slow-read.txt'));
      fs.open = async function (candidate, ...args) {
        const handle = await original.call(this, candidate, ...args);
        if (typeof candidate !== 'string' || key(candidate) !== target || gate.starts) return handle;
        const read = handle.read;
        handle.read = async function (...readArgs) {
          if (!gate.starts) {
            gate.starts++; gate.active++; gate.entered.resolve();
            try { await gate.release.promise; return await read.apply(handle, readArgs); }
            finally { gate.active--; gate.finished.resolve(); }
          }
          return read.apply(handle, readArgs);
        };
        return handle;
      };
    }
    syncBuiltinESMExports(); return gate;
  }
  const events = [], failures = [], closeOptions = [], validationTargets = []; let activationCount = 0, confirmations = 0;
  const lifecycle = createDesktopLifecycle({
    closeService: value => { closeOptions.push(value); return service.close(value); },
    relaunch: async () => { events.push('relaunch'); }, quit: () => { events.push('quit'); },
    reportError: async (error, context) => { failures.push({ code: error.code, status: error.status, operation: context.operation, restartRequired: context.restartRequired }); },
  });
  const actions = createWorkspaceActions({
    profiles: { list: () => profiles.list(), inspect: directory => profiles.inspect(directory), activate: async target => { activationCount++; return profiles.activate(target); } },
    activeProfile: profile, lifecycle,
    dialogs: { chooseDirectory: async () => second, confirmSwitch: async () => { confirmations++; return true; }, ...(retrySwitch ? { retrySwitch } : {}) },
    validateWorkspace: async target => { validationTargets.push(target); await createWorkspace(target.workspace, options(target)).getIdentity(); },
    runJob: async () => assert.fail('Switching must not start a backup/restore worker'),
  });
  return { root, first, second, profile, profiles, registry, service, services, crypto, options, secretStore, secret,
    request, completed, route, provider, session, history, artifact, artifactRoute, text, beforeRegistry, beforeProfiles,
    hold, actions, lifecycle, events, failures, closeOptions, validationTargets, streamClosed,
    get activationCount() { return activationCount; }, get confirmations() { return confirmations; }, get modelCalls() { return modelCalls; } };
}

for (const kind of ['index', 'preview']) test(`native workspace action refuses a real pending ${kind} read, preserves the original service, then switches exactly once after drain`, { timeout: 60000 }, async t => {
  const f = await fixture(t), gate = f.hold(kind);
  const pending = f.request(kind === 'index' ? '/api/workspace?path=slow-directory' : '/api/workspace/file?path=slow-read.txt');
  // Observe failures immediately so an earlier assertion cannot leave an
  // unhandled rejection while cleanup releases the gate and closes the service.
  pending.catch(() => {});
  await within(gate.entered.promise); assert.equal(gate.active, 1); assert.equal(gate.starts, 1);

  assert.equal(await f.actions.chooseWorkspace(), false);
  assert.deepEqual(f.failures, [{ code: 'WORKSPACE_BUSY', status: 409, operation: 'switch', restartRequired: false }]);
  assert.equal(f.activationCount, 0); assert.equal(f.confirmations, 1); assert.deepEqual(f.events, []);
  assert.deepEqual(f.closeOptions, [{ ifIdle: true }]); assert.equal(f.lifecycle.busy, false); assert.equal(f.lifecycle.quitting, false);
  assert.equal(f.service.server.listening, true); assert.equal(gate.active, 1);
  assert.deepEqual(await fs.readFile(f.registry), f.beforeRegistry);
  assert.deepEqual(await f.profiles.list(), f.beforeProfiles); assert.deepEqual(await f.profiles.getActive(), f.profile);
  await assert.rejects(acquireDataLock(f.profile.dataDir), { code: 'DATA_LOCKED' });

  // Use the original login and CSRF token while the gate is STILL held. This
  // distinguishes an intact service from one mistakenly stopped before refusal.
  assert.deepEqual((await f.request(f.route)).session, f.session);
  assert.deepEqual(await f.request(f.route + '/runs/' + f.session.run.id), f.history);
  assert.deepEqual(await f.request(f.artifactRoute), f.artifact);
  const file = await f.request('/api/workspace/file?path=notes.txt'); assert.equal(file.status, 200); assert.equal(file.content, f.text);
  const state = await f.request('/api/state'); assert.equal(state.status, 200);
  assert.equal(state.workspace.id, f.profile.id); assert.equal(state.workspace.path, f.profile.workspace);
  assert.deepEqual(state.providers.find(provider => provider.id === f.provider.id), f.provider);
  assert.ok(await f.secretStore.get(f.provider.id) === f.secret, 'The original persisted credential still decrypts');
  assert.equal((await fs.readFile(path.join(f.profile.secretsDir, f.provider.id + '.secret'))).includes(Buffer.from(f.secret)), false);
  assert.equal(JSON.stringify([state, f.history, f.artifact]).includes(f.secret), false);
  assert.equal(gate.active, 1); assert.equal(f.modelCalls, 2);

  gate.release.resolve(); const read = await pending; await within(gate.finished.promise);
  assert.equal(read.status, 200); assert.equal(gate.active, 0);
  if (kind === 'index') assert.deepEqual(read.files.map(file => file.path), ['slow-directory/nested.txt']);
  else assert.equal(read.content, 'A real preview read');
  const continued = await f.request(f.route + '/messages', { content: '拒绝切换后继续原任务' }); assert.equal(continued.status, 202);
  const completed = await f.completed(f.route, continued.runId);
  assert.equal(completed.messages.at(-1).content, '本机测试已完成'); assert.equal(f.modelCalls, 3);
  assert.deepEqual(await f.request(f.artifactRoute), f.artifact);
  assert.equal((await f.request(f.route + '/runs')).runs.length, 2);

  // The long-lived SSE stream remains open. Only the gate-held handler needed
  // to drain; no sleep, slot-limit change, busy retry or forced socket close.
  assert.equal(await f.actions.chooseWorkspace(), true);
  await within(f.streamClosed.promise);
  assert.equal(f.activationCount, 1); assert.equal(f.confirmations, 2);
  assert.deepEqual(f.events, ['relaunch', 'quit']); assert.equal(f.failures.length, 1);
  assert.deepEqual(f.closeOptions, [{ ifIdle: true }, { ifIdle: true }]);
  assert.equal(f.service.server.listening, false);
  const active = await f.profiles.getActive(); assert.equal(active.workspace, f.second); assert.notEqual(active.id, f.profile.id);
  assert.equal((await f.profiles.list()).length, f.beforeProfiles.length + 1);
  const release = await acquireDataLock(f.profile.dataDir); await release();
  assert.equal(await f.actions.chooseWorkspace(), false); assert.equal(f.activationCount, 1); assert.deepEqual(f.events, ['relaunch', 'quit']);

  // Open the selected profile with the same real server constructor to verify
  // isolation. Relaunch/quit above are callback spies, not an Electron process.
  const targetVault = createSecretStore({ directory: active.secretsDir, crypto: f.crypto });
  const target = await startServer({ port: 0, dataDir: active.dataDir, workspace: active.workspace, workspaceId: active.id,
    workspaceName: active.label, workspaceOptions: f.options(active), secretStore: targetVault });
  f.services.push(target);
  const response = await fetch(target.url + '/api/bootstrap', { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); const bootstrap = await response.json();
  assert.equal(bootstrap.workspace.id, active.id); assert.equal(bootstrap.workspace.path, f.second);
  assert.deepEqual(bootstrap.sessions, []); assert.equal(bootstrap.providers.some(provider => provider.id === f.provider.id), false);
  assert.equal(await targetVault.get(f.provider.id), undefined);
  assert.ok(await f.secretStore.get(f.provider.id) === f.secret, 'The selected profile cannot consume the old credential');
  assert.equal(await fs.readFile(path.join(f.first, 'notes.txt'), 'utf8'), f.text);
});

for (const kind of ['index', 'preview']) test(`an explicit user retry completes one confirmed switch after a real ${kind} read drains`, { timeout: 60000 }, async t => {
  const decision = deferred(), prompted = deferred(); let prompts = 0;
  const f = await fixture(t, { retrySwitch: async (target, error, signal) => {
    prompts++; assert.equal(error.code, 'WORKSPACE_BUSY'); assert.equal(signal.aborted, false);
    assert.equal(target.workspace, f.second); prompted.resolve(); return decision.promise;
  } });
  const gate = f.hold(kind), reading = f.request(kind === 'index' ? '/api/workspace?path=slow-directory' : '/api/workspace/file?path=slow-read.txt');
  reading.catch(() => {});
  await within(gate.entered.promise);
  const switching = f.actions.chooseWorkspace();
  await within(prompted.promise);
  assert.equal(f.lifecycle.busy, true); assert.equal(f.activationCount, 0);
  assert.equal(await f.actions.chooseWorkspace(), false, 'A second menu action cannot enter the pending decision');
  assert.deepEqual(f.closeOptions, [{ ifIdle: true }]); assert.deepEqual(f.events, []);
  assert.deepEqual(await fs.readFile(f.registry), f.beforeRegistry);
  await assert.rejects(acquireDataLock(f.profile.dataDir), { code: 'DATA_LOCKED' });
  gate.release.resolve(); assert.equal((await reading).status, 200); await within(gate.finished.promise);
  assert.equal(f.activationCount, 0, 'Finishing a read cannot itself retry the menu intent');
  decision.resolve(true);
  assert.equal(await within(switching), true);
  assert.equal(prompts, 1); assert.equal(f.confirmations, 1); assert.equal(f.activationCount, 1);
  assert.deepEqual(f.closeOptions, [{ ifIdle: true }, { ifIdle: true }]);
  assert.equal(f.validationTargets.length, 2); assert.equal(f.validationTargets[0], f.validationTargets[1]);
  assert.deepEqual(f.failures, []); assert.deepEqual(f.events, ['relaunch', 'quit']);
  assert.equal((await f.profiles.getActive()).workspace, f.second);
  assert.equal(await fs.readFile(path.join(f.first, 'notes.txt'), 'utf8'), f.text);
  assert.ok(await f.secretStore.get(f.provider.id) === f.secret);
  const release = await acquireDataLock(f.profile.dataDir); await release();
});

for (const outcome of ['cancel', 'quit']) test(`${outcome} while a busy retry decision is pending never activates the target or repeats idle shutdown`, { timeout: 60000 }, async t => {
  const decision = deferred(), prompted = deferred(); let signal;
  const f = await fixture(t, { retrySwitch: async (_target, _error, currentSignal) => {
    signal = currentSignal; prompted.resolve(); return decision.promise;
  } });
  const gate = f.hold('index'), reading = f.request('/api/workspace?path=slow-directory'); reading.catch(() => {});
  await within(gate.entered.promise);
  const switching = f.actions.chooseWorkspace(); await within(prompted.promise);
  let quitting;
  if (outcome === 'quit') { quitting = f.lifecycle.requestQuit(); assert.equal(signal.aborted, true); }
  decision.resolve(outcome === 'quit'); // Even a late affirmative response cannot revive a cancelled intent.
  assert.equal(await within(switching), false);
  assert.equal(f.activationCount, 0); assert.equal(f.confirmations, 1); assert.equal(f.validationTargets.length, 1);
  assert.deepEqual(f.failures, []); assert.deepEqual(await fs.readFile(f.registry), f.beforeRegistry);
  assert.deepEqual(f.closeOptions, [{ ifIdle: true }, ...(outcome === 'quit' ? [undefined] : [])]);
  await assert.rejects(acquireDataLock(f.profile.dataDir), { code: 'DATA_LOCKED' });
  assert.equal(gate.active, 1); assert.deepEqual(f.events, []);
  if (outcome === 'cancel') assert.equal((await f.request('/api/state')).status, 200);
  gate.release.resolve(); const result = await reading; await within(gate.finished.promise);
  assert.equal(result.status, outcome === 'quit' ? 503 : 200);
  if (quitting) { await within(quitting); assert.deepEqual(f.events, ['quit']); }
  else { assert.equal(f.service.server.listening, true); assert.deepEqual(f.events, []); }
});

test('a replacement target is rejected after the retry decision without closing or rebinding the original workspace', { timeout: 60000 }, async t => {
  const decision = deferred(), prompted = deferred();
  const f = await fixture(t, { retrySwitch: async () => { prompted.resolve(); return decision.promise; } });
  const gate = f.hold('index'), reading = f.request('/api/workspace?path=slow-directory'); reading.catch(() => {});
  await within(gate.entered.promise);
  const switching = f.actions.chooseWorkspace(); await within(prompted.promise);
  await fs.rename(f.second, path.join(f.root, 'original-target'));
  await fs.mkdir(f.second); await fs.writeFile(path.join(f.second, 'marker.txt'), 'replacement remains');
  decision.resolve(true);
  assert.equal(await within(switching), false);
  assert.deepEqual(f.failures, [{ code: 'WORKSPACE_CHANGED', status: 409, operation: 'switch', restartRequired: false }]);
  assert.equal(f.validationTargets.length, 2); assert.equal(f.validationTargets[0], f.validationTargets[1]);
  assert.deepEqual(f.closeOptions, [{ ifIdle: true }]); assert.equal(f.activationCount, 0); assert.deepEqual(f.events, []);
  assert.deepEqual(await fs.readFile(f.registry), f.beforeRegistry);
  assert.equal((await f.request('/api/state')).status, 200);
  assert.equal(await fs.readFile(path.join(f.second, 'marker.txt'), 'utf8'), 'replacement remains');
  gate.release.resolve(); assert.equal((await reading).status, 200);
});

test('a task started while the retry dialog is open is checked again and cannot be cancelled or bypassed by retry', { timeout: 60000 }, async t => {
  const firstDecision = deferred(), firstPrompt = deferred(), secondPrompt = deferred(), model = deferred(), modelEntered = deferred();
  t.after(() => model.resolve()); let prompts = 0;
  const f = await fixture(t, { retrySwitch: async () => {
    if (++prompts === 1) { firstPrompt.resolve(); return firstDecision.promise; }
    secondPrompt.resolve(); return false;
  }, onNextModel: async () => { modelEntered.resolve(); await model.promise; } });
  const gate = f.hold('index'), reading = f.request('/api/workspace?path=slow-directory'); reading.catch(() => {});
  await within(gate.entered.promise);
  const switching = f.actions.chooseWorkspace(); await within(firstPrompt.promise);
  const started = await f.request(f.route + '/messages', { content: '保留正在运行的任务' }); assert.equal(started.status, 202);
  await within(modelEntered.promise);
  gate.release.resolve(); assert.equal((await reading).status, 200);
  firstDecision.resolve(true); await within(secondPrompt.promise);
  assert.equal(await within(switching), false); assert.equal(prompts, 2);
  assert.deepEqual(f.closeOptions, [{ ifIdle: true }, { ifIdle: true }]);
  assert.equal(f.activationCount, 0); assert.equal(f.confirmations, 1); assert.deepEqual(f.events, []); assert.deepEqual(f.failures, []);
  assert.deepEqual(await fs.readFile(f.registry), f.beforeRegistry);
  const current = await f.request(f.route); assert.equal(current.session.run.id, started.runId); assert.equal(current.session.run.status, 'running');
  model.resolve(); await f.completed(f.route, started.runId);
  assert.equal(f.modelCalls, 3); assert.equal(f.service.server.listening, true);
});
