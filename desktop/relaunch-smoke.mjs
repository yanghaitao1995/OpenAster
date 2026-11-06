// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { assertSmokeTransition } from './smoke-diagnostics.mjs';
import { verifyDraftWorkspace } from './draft-relaunch-ui.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const note = '\ufeff跨进程恢复验证🙂\r\n';
const title = '真实重新启动后的任务';
const editedContent = '在新分支中查看同一份历史文件快照，不要写入';
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
function recordDigest(value) {
  const sorted = (items, key) => [...items].sort((left, right) => String(key(left)).localeCompare(String(key(right))));
  return digest({ sessions: sorted(value.sessions, item => item.id),
    runHistory: sorted(value.runHistory, item => item.sessionId + '/' + item.run.id),
    toolArtifacts: sorted(value.toolArtifacts, item => item.sessionId + '/' + item.runId + '/' + item.id),
    executionAudit: sorted(value.audit.filter(item => item.action.startsWith('run.')), item => item.id) });
}

/** Only used after the owner/identity/phase protocol accepted the smoke root.
 * Native choosers are supplied fixture responses; menu, service, worker, registry,
 * OS secret store, renderer load and process relaunch remain production code. */
export function createRelaunchSmokeScenario({ state, userData, getService, getProfile, getWindow, click, beforeTransition }) {
  const backup = path.join(path.dirname(userData), 'relaunch-backup.json');
  let output = null, transitionReady = false, successorPrepared = false, readiness = null;
  async function transition(selection, proof) {
    readiness = await beforeTransition();
    state.record({ ...proof, rendererReadiness: readiness });
    const result = await click(selection);
    assertSmokeTransition(result, successorPrepared);
  }
  const fixture = () => state.fixture;
  async function connect() {
    const service = getService(), first = await fetch(service.url + '/api/bootstrap', { signal: AbortSignal.timeout(10000) });
    assert.equal(first.status, 200);
    const bootstrap = await first.json(), cookie = first.headers.get('set-cookie').split(';')[0];
    return { bootstrap, request: async (route, body, expectedStatus) => {
      const response = await fetch(service.url + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, 'X-CSRF-Token': bootstrap.csrfToken, 'Content-Type': 'application/json', 'X-OpenAster-Storage-Id': bootstrap.workspace.storageId },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      assert.equal(response.ok, true, 'Fixture HTTP operation failed');
      if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus);
      return response.json();
    } };
  }
  async function completedSession(client, id, runId) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const session = (await client.request('/api/sessions/' + id)).session;
      if (session.run?.id === runId && !['running', 'awaiting_approval'].includes(session.run.status)) {
        assert.equal(session.run.status, 'completed'); assert.ok(session.run.finishedAt);
        return session;
      }
      await pause();
    }
    assert.fail('Fixture task did not complete');
  }
  async function verifyRecords(client) {
    const expected = fixture(), records = await client.request('/api/export');
    assert.equal(records.sessions.length, 2); assert.equal(records.runHistory.length, 3); assert.equal(records.toolArtifacts.length, expected.toolArtifactCount);
    assert.equal(recordDigest(records), expected.recordsSha256, 'Tasks, histories, tool artifacts or execution audit changed across restart');
    const source = records.sessions.find(item => item.id === expected.sessionId), branch = records.sessions.find(item => item.id === expected.branchId);
    assert.ok(source && branch); assert.equal(source.run.id, expected.sourceRunId); assert.equal(branch.run.id, expected.branchRunId);
    assert.deepEqual(branch.branch, expected.branchMetadata);
    assert.deepEqual(branch.messages[2].contextFiles, [{ path: 'relaunch-note.txt', sha256: hash(note), content: note }]);
    assert.equal(branch.messages[2].content, editedContent);
    assert.equal(records.runHistory.filter(item => item.sessionId === branch.id).length, 1);
    assert.equal(records.toolArtifacts.filter(item => item.sessionId === branch.id).length, 0);
    assert.deepEqual(branch.approvals, []);
    return { sourceAndBranchPreserved: true, branchMetadataPreserved: true, historicalAttachmentPreserved: true, executionNotReplayed: true,
      toolArtifacts: records.toolArtifacts.length };
  }
  async function pageTaskCheck() {
    const expected = fixture();
    const result = await getWindow().webContents.executeJavaScript(`(async () => {
      const expected = ${JSON.stringify({ id: expected.sessionId, title, branchId: expected.branchId, branchTitle: expected.branchTitle, label: getProfile().label, workspace: getProfile().workspace })};
      const until = Date.now() + 10000;
      let row, branchRow;
      while (Date.now() < until) {
        row = [...document.querySelectorAll('#session-list [data-action="open-session"]')].find(node => node.dataset.id === expected.id);
        branchRow = [...document.querySelectorAll('#session-list [data-action="open-session"]')].find(node => node.dataset.id === expected.branchId);
        if (row && branchRow) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const label = document.querySelector('#workspace-label');
      return { taskVisible: Boolean(row && row.title === expected.title),
        branchTaskVisible: Boolean(branchRow && branchRow.title === expected.branchTitle),
        workspaceVisible: label?.title === expected.label + '\\n' + expected.workspace,
        connected: Boolean(document.querySelector('#connection-indicator.connected')) };
    })()`);
    assert.deepEqual(result, { taskVisible: true, branchTaskVisible: true, workspaceVisible: true, connected: true });
    return result;
  }
  const dialogs = {
    chooseBackupOutput: async () => output,
    chooseRestoreInput: async () => backup,
    confirmBackup: async () => true,
    confirmRestore: async () => true,
    confirmSwitch: async () => true,
    backupDone: async result => {
      assert.equal(state.phase, 0); assert.equal(result.sessions, 2); assert.equal(result.runHistory, 3); assert.equal(result.toolArtifacts, fixture().toolArtifactCount);
      const bytes = await readFile(backup), envelope = JSON.parse(bytes.toString('utf8'));
      assert.equal(result.path, backup); assert.equal(hash(bytes), result.sha256);
      assert.equal(envelope.format, 'openaster-backup'); assert.equal(envelope.version, 9);
      assert.deepEqual(envelope.payload.steeringInputs, []); assert.deepEqual(envelope.payload.summaryJobs, []);
      assert.equal(hash(JSON.stringify(envelope.payload)), envelope.sha256);
      assert.equal(recordDigest(envelope.payload), fixture().recordsSha256);
      assert.equal(Object.hasOwn(envelope.payload, 'deviceDrafts'), false);
      const payloadText = JSON.stringify(envelope.payload);
      for (const draft of fixture().deviceDrafts.default.snapshot.drafts) assert.equal(payloadText.includes(JSON.stringify(draft.text)), false, 'Saved device draft text entered the logical backup');
      state.setFixture({ ...fixture(), backupSha256: result.sha256, backupVersion: envelope.version }); transitionReady = true;
    },
    restoreDone: async ({ profile, result }) => {
      assert.equal(state.phase, 1); assert.equal(profile.kind, 'restored'); assert.equal(result.sessions, 2);
      assert.equal(result.runHistory, 3); assert.equal(result.toolArtifacts, fixture().toolArtifactCount);
      state.setFixture({ ...fixture(), restoredProfileId: profile.id, restoredWorkspace: profile.workspace }); transitionReady = true;
    },
  };
  return {
    dialogs,
    beforeRelaunch(expectedProfileId) {
      assert.ok(state.phase < 4);
      assert.equal(readiness?.policy, 'pause-new-background-requests-before-transition');
      assert.equal(readiness.allAdmittedRequestsSettled, true); assert.equal(readiness.allStartedHandlersSettled, true);
      if (state.phase <= 1) assert.equal(transitionReady, true, 'Offline job did not complete');
      const expected = state.phase === 0 || state.phase === 2 ? 'default' : fixture().restoredProfileId;
      assert.equal(expectedProfileId, expected);
      const next = state.prepareNext({ expectedProfileId }); successorPrepared = true; return next;
    },
    async run(pageProof) {
      const profile = getProfile(), client = await connect();
      assert.equal(client.bootstrap.workspace.id, profile.id);
      assert.equal(client.bootstrap.capabilities.conversationBranch, 1);
      assert.equal(client.bootstrap.capabilities.deviceDrafts, 1);
      if (state.phase === 0) {
        assert.equal(profile.id, 'default'); assert.equal(client.bootstrap.sessions.length, 0);
        await client.request('/api/workspace/files', { path: 'relaunch-note.txt', content: note });
        // Only store a randomized synthetic secret. This connection is never called.
        const provider = (await client.request('/api/providers', { name: 'Restart fixture', type: 'openai', model: 'fixture',
          baseUrl: 'https://fixture.invalid/v1', apiKey: randomBytes(32).toString('hex') })).provider;
        const task = (await client.request('/api/sessions', { title, providerId: 'demo' })).session;
        const route = '/api/sessions/' + task.id;
        const started = await client.request(route + '/messages', { content: '查看当前文件，不要写入' });
        const completed = await completedSession(client, task.id, started.runId);
        const refs = completed.run.steps.filter(step => step.toolResultRef).map(step => step.toolResultRef);
        assert.equal(refs[0]?.name, 'list_workspace');
        const artifacts = [];
        for (const ref of refs) {
          assert.equal(ref.isError, false);
          const artifact = await client.request(route + '/runs/' + completed.run.id + '/artifacts/' + ref.artifactId);
          assert.equal(hash(artifact.page.content), ref.sha256); assert.equal(Buffer.byteLength(artifact.page.content), ref.bytes);
          artifacts.push(artifact);
        }
        const inventory = JSON.parse(artifacts[0].page.content).result;
        const demoReadPaths = inventory.files.filter(file => file.type === 'file' && file.size <= 256 * 1024).slice(0, 3).map(file => file.path);
        assert.deepEqual(refs.map(ref => ({ name: ref.name, path: ref.path })), [
          { name: 'list_workspace', path: null }, ...demoReadPaths.map(path => ({ name: 'read_file', path })),
        ]);
        for (let index = 1; index < artifacts.length; index++) assert.equal(JSON.parse(artifacts[index].page.content).result.path, demoReadPaths[index - 1]);
        const noteIndex = refs.findIndex(ref => ref.name === 'read_file' && ref.path === 'relaunch-note.txt');
        assert.ok(noteIndex > 0, 'The seeded note must be read by the local demo');
        const artifactId = refs[noteIndex].artifactId, artifact = artifacts[noteIndex];
        assert.equal(JSON.parse(artifact.page.content).result.content, note);
        const attached = await client.request(route + '/messages', { content: '查看我选择的文件快照，不要写入',
          files: [{ path: 'relaunch-note.txt', sha256: hash(note) }] });
        const source = await completedSession(client, task.id, attached.runId);
        assert.equal(source.messages.length, 4); assert.notEqual(source.run.id, completed.run.id);
        const anchor = source.messages[2];
        assert.equal(anchor.role, 'user'); assert.deepEqual(anchor.contextFiles, [{ path: 'relaunch-note.txt', sha256: hash(note), content: note }]);
        const preview = await client.request(route + '/branch-preview?messageId=' + encodeURIComponent(anchor.id));
        assert.equal(preview.previousMessages, 2); assert.equal(preview.source.sessionId, task.id); assert.equal(preview.source.messageId, anchor.id);
        assert.deepEqual(preview.files, [{ path: 'relaunch-note.txt', bytes: Buffer.byteLength(note), sha256: hash(note) }]);
        const created = (await client.request(route + '/branches', { messageId: anchor.id, expectedPrefixHash: preview.source.prefixHash,
          mode: 'prefix', content: editedContent, providerId: 'demo', skillId: 'general' }, 201)).session;
        const branch = await completedSession(client, created.id, created.run.id);
        assert.notEqual(branch.id, source.id); assert.notEqual(branch.run.id, source.run.id); assert.notEqual(branch.run.id, completed.run.id);
        assert.equal(branch.messages.length, 4);
        assert.ok(branch.messages.every(message => !source.messages.some(original => original.id === message.id)));
        for (let index = 0; index < 2; index++) {
          const { id: oldId, ...original } = source.messages[index], { id: newId, ...copied } = branch.messages[index];
          assert.notEqual(newId, oldId); assert.deepEqual(copied, original);
        }
        assert.deepEqual(branch.branch, { version: 1, sourceSessionId: source.id, sourceMessageId: anchor.id, sourceTitle: title,
          sourcePrefixHash: preview.source.prefixHash, mode: 'prefix', retainedMessages: 2, createdAt: branch.createdAt });
        assert.deepEqual((await client.request(route)).session, source, 'Creating a branch must preserve the source task');
        const records = await client.request('/api/export');
        assert.deepEqual(records.toolArtifacts.map(item => item.id).sort(), refs.map(ref => ref.artifactId).sort());
        state.setFixture({ sessionId: task.id, runId: completed.run.id, artifactId, artifactSha256: hash(JSON.stringify(artifact)),
          sourceRunId: source.run.id, branchId: branch.id, branchRunId: branch.run.id, branchTitle: branch.title,
          branchMetadata: branch.branch, recordsSha256: recordDigest(records), toolArtifactCount: records.toolArtifacts.length, demoReadPaths,
          providerId: provider.id, originalWorkspace: profile.workspace, noteSha256: hash(note), backupSha256: null, restoredProfileId: null, restoredWorkspace: null });
        const draftClient = await connect(); // Include the synthetic provider created after the initial bootstrap.
        const draftState = await verifyDraftWorkspace({ window: getWindow(), request: draftClient.request, bootstrap: draftClient.bootstrap, sessionId: task.id, expected: null,
          seed: { newText: '  默认工作区的新任务草稿🙂\n保留尾部空格  ', taskText: '  默认工作区的任务草稿\n这一段没有发送。\n', newProviderId: provider.id, taskProviderId: 'demo' } });
        state.setFixture({ ...fixture(), deviceDrafts: { default: { storageId: client.bootstrap.workspace.storageId, snapshot: draftState.snapshot }, restored: null } });
        assert.equal(await click({ label: '备份当前工作区…' }), false);
        assert.equal((await client.request(route)).session.id, task.id);
        const proof = { ...pageProof, ...await pageTaskCheck(), ...await verifyRecords(client), workspaceId: profile.id,
          branchCreatedViaApi: true, newBranchIdentifiers: true, cancelledPickerPreservedService: true, sourceCredentialStored: true, deviceDrafts: draftState.proof };
        output = backup;
        await transition({ label: '备份当前工作区…' }, proof);
        return { transitioning: true };
      }
      const expected = fixture();
      assert.equal(profile.id, state.expectedProfileId);
      const original = state.phase === 1 || state.phase === 3;
      assert.equal(profile.id, original ? 'default' : expected.restoredProfileId);
      assert.equal(profile.workspace, original ? expected.originalWorkspace : expected.restoredWorkspace);
      assert.deepEqual(client.bootstrap.sessions.map(item => item.id).sort(), [expected.sessionId, expected.branchId].sort());
      const provider = client.bootstrap.providers.find(item => item.id === expected.providerId);
      assert.ok(provider); assert.equal(provider.enabled, original); assert.equal(provider.hasKey, original);
      const route = '/api/sessions/' + expected.sessionId;
      const session = (await client.request(route)).session; assert.equal(session.title, title); assert.equal(session.run.status, 'completed');
      assert.equal((await client.request(route + '/runs')).runs.length, 2);
      const artifact = await client.request(route + '/runs/' + expected.runId + '/artifacts/' + expected.artifactId);
      assert.equal(hash(JSON.stringify(artifact)), expected.artifactSha256);
      for (const location of [profile.workspace, expected.originalWorkspace]) assert.equal(hash(await readFile(path.join(location, 'relaunch-note.txt'))), expected.noteSha256);
      assert.equal(hash(await readFile(backup)), expected.backupSha256);
      const draftProfile = original ? expected.deviceDrafts.default : expected.deviceDrafts.restored;
      if (state.phase === 2) {
        assert.equal(draftProfile, null);
        assert.notEqual(client.bootstrap.workspace.storageId, expected.deviceDrafts.default.storageId);
      } else {
        assert.ok(draftProfile); assert.equal(client.bootstrap.workspace.storageId, draftProfile.storageId);
      }
      const draftState = await verifyDraftWorkspace({ window: getWindow(), request: client.request, bootstrap: client.bootstrap, sessionId: expected.sessionId, expected: draftProfile?.snapshot ?? null,
        seed: state.phase === 2 ? { newText: '  恢复工作区的新任务草稿🌿\n与默认工作区分开  ', taskText: '  恢复工作区的任务草稿\n保留在恢复出的工作区。\n', newProviderId: 'demo', taskProviderId: 'demo' } : null });
      if (state.phase === 2) state.setFixture({ ...fixture(), deviceDrafts: { ...expected.deviceDrafts, restored: { storageId: client.bootstrap.workspace.storageId, snapshot: draftState.snapshot } } });
      const proof = { ...pageProof, ...await pageTaskCheck(), ...await verifyRecords(client), deviceDrafts: draftState.proof, workspaceId: profile.id, workspace: profile.workspace,
        taskAndHistoryPreserved: true, artifactBytesPreserved: true, originalWorkspacePreserved: true,
        credentialsMatchProfile: true, previousProcessExited: true };
      if (state.phase === 1) await transition({ label: '恢复备份…' }, proof);
      else if (state.phase === 2) await transition({ label: '默认工作区' }, proof);
      else if (state.phase === 3) await transition({ workspace: expected.restoredWorkspace }, proof);
      else { state.record(proof); return { realProcessRelaunches: 4, processCount: 5, restoredProfileId: expected.restoredProfileId,
        restoredTaskVisible: true, actualRecentWorkspaceSwitch: true, independentCredentials: true,
        originalWorkspacePreserved: true, artifactBytesPreserved: true, backupVersion: expected.backupVersion,
        sourceSessionId: expected.sessionId, branchSessionId: expected.branchId, sessions: 2, runHistories: 3,
        toolArtifacts: expected.toolArtifactCount, demoReadPaths: expected.demoReadPaths,
        branchCreatedViaApi: true, sourceAndBranchPreserved: true, branchMetadataPreserved: true,
        historicalAttachmentPreserved: true, executionNotReplayed: true,
        chooserResponses: 'injected; system picker visual interaction is not exercised',
        transitionReadiness: 'fixture paused new renderer and service worker requests before each transition; not naturally idle startup' }; }
      return { transitioning: true };
    },
  };
}

