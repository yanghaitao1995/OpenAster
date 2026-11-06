// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.mjs';
import { Store } from '../server/store.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { createWorkspaceProfiles, initializeProfileWorkspace } from './workspace-profiles.mjs';
import { createRelaunchSmokeScenario } from './relaunch-smoke.mjs';
import { runBackupJob } from './backup-worker-client.mjs';

test('relaunch API fixture preserves every seeded-workspace tool artifact in a version 9 backup', { timeout: 20000 }, async t => {
  const temporaryRoot = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'openaster-relaunch-fixture-'));
  let service;
  t.after(async () => {
    await service?.close();
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), temporaryRoot);
    assert.match(path.basename(root), /^openaster-relaunch-fixture-[A-Za-z0-9]+$/u);
    await fs.rm(root, { recursive: true, force: true });
  });
  const userData = path.join(root, 'data'); await fs.mkdir(userData);
  const profiles = createWorkspaceProfiles({ userData, homeDirectory: root }); await profiles.initialize();
  const profile = await profiles.getActive();
  const skillsDirectory = await initializeProfileWorkspace(profile);
  const vault = new Map();
  service = await startServer({ port: 0, host: '127.0.0.1', dataDir: profile.dataDir, workspace: profile.workspace,
    workspaceId: profile.id, workspaceName: profile.label, skillsDirectory,
    secretStore: { get: id => vault.get(id), set: (id, value) => vault.set(id, value), delete: id => vault.delete(id) },
    deviceDraftStore: { read() { assert.fail('No draft API call before the renderer boundary'); }, compareAndSwap() { assert.fail('No draft mutation'); }, drain() {}, close() {} },
  });
  const state = { phase: 0, fixture: null, setFixture(value) { this.fixture = value; } };
  const rendererBoundary = new Error('The headless regression stops before all renderer and native menu interactions.');
  const scenario = createRelaunchSmokeScenario({ state, userData, getService: () => service, getProfile: () => profile,
    getWindow() { throw rendererBoundary; }, click() { assert.fail('No native menu interaction'); }, beforeTransition() { assert.fail('No transition'); },
  });
  await assert.rejects(scenario.run({}), error => error === rendererBoundary);
  assert.equal(state.fixture.toolArtifactCount, 4);
  assert.deepEqual(state.fixture.demoReadPaths, ['relaunch-note.txt', 'skills/code/SKILL.md', 'skills/general/SKILL.md']);
  const response = await fetch(service.url + '/api/bootstrap'); await response.json();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const records = await (await fetch(service.url + '/api/export', { headers: { cookie } })).json();
  assert.equal(records.toolArtifacts.length, 4);
  const note = records.toolArtifacts.find(item => item.id === state.fixture.artifactId);
  assert.equal(note.path, 'relaunch-note.txt'); assert.equal(JSON.parse(note.content).result.content, '\ufeff跨进程恢复验证🙂\r\n');
  await service.close();
  const backup = await runBackupJob('backup', { dataDir: profile.dataDir, workspace: profile.workspace,
    output: path.join(root, 'relaunch-backup.json'),
    expectedDataIdentity: await createWorkspace(profile.dataDir, { createRoot: false }).getIdentity(),
    expectedWorkspaceIdentity: await createWorkspace(profile.workspace, { createRoot: false }).getIdentity(),
  });
  const envelope = JSON.parse(await fs.readFile(backup.path, 'utf8'));
  assert.equal(envelope.version, 9); assert.deepEqual(envelope.payload.steeringInputs, []);
  assert.deepEqual(envelope.payload.toolArtifacts, records.toolArtifacts);
  // Renderer draft checks remain covered by the real five-process smoke. The
  // headless fixture supplies only its empty snapshot to reach archive checks.
  state.setFixture({ ...state.fixture, deviceDrafts: { default: { snapshot: { drafts: [] } } } });
  await scenario.dialogs.backupDone(backup);
  assert.equal(state.fixture.backupVersion, 9);
  const restoredData = path.join(root, 'restored');
  const restored = await runBackupJob('restore', { input: backup.path, dataDir: restoredData });
  const store = new Store(restoredData);
  try {
    const actual = store.exportSessionsWithHistory();
    assert.deepEqual(actual.toolArtifacts, records.toolArtifacts);
    assert.deepEqual(actual.sessions, records.sessions); assert.deepEqual(actual.runHistory, records.runHistory);
  } finally { store.close(); }
  state.phase = 1;
  await scenario.dialogs.restoreDone({ profile: { kind: 'restored', id: 'fixture-restored', workspace: path.join(restoredData, 'workspace') }, result: restored });
});
