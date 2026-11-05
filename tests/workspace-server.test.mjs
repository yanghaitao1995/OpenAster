import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { startServer } from '../server/index.mjs';
import { createWorkspaceProfiles } from '../desktop/workspace-profiles.mjs';
import { createWorkspace } from '../core/workspace.mjs';

async function sandbox(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'openaster-workspace-server-'));
  const userData = path.join(root, 'data'), appRoot = path.join(root, 'app');
  await mkdir(userData); await mkdir(appRoot);
  const services = new Set();
  t.after(async () => { for (const service of services) await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, userData, appRoot, track: service => { services.add(service); return service; } };
}
async function connect(service) {
  const first = await fetch(service.url + '/api/bootstrap');
  const bootstrap = await first.json();
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'X-CSRF-Token': bootstrap.csrfToken, 'Content-Type': 'application/json' };
  return { bootstrap, headers, async request(endpoint, data, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch(service.url + endpoint, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  } };
}
const until = async check => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('timed out waiting for task');
};

test('idle-only close rejects unfinished HTTP bodies without interrupting the operation', async t => {
  const f = await sandbox(t), service = f.track(await startServer({ dataDir: f.userData }));
  t.after(() => service.close());
  const client = await connect(service);
  const entered = new Promise(resolve => service.server.once('request', resolve));
  let finish;
  const response = new Promise((resolve, reject) => {
    const request = http.request(service.url + '/api/sessions', { method: 'POST', headers: client.headers }, result => {
      result.resume(); result.once('end', () => resolve(result.statusCode));
    });
    request.once('error', reject); request.write('{"title":'); finish = () => request.end('"pending body"}');
  });
  await entered;
  await assert.rejects(service.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  finish(); assert.equal(await response, 201);
  assert.equal((await client.request('/api/state')).body.sessions[0].title, 'pending body');
  await service.close({ ifIdle: true });
});

test('idle-only close refuses running tasks; normal shutdown is shared and releases data lock', async t => {
  const f = await sandbox(t); let providerEntered = false;
  const service = f.track(await startServer({ dataDir: f.userData, runtimeOptions: { providerCall: async (_provider, { signal }) => {
    providerEntered = true;
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } } }));
  t.after(() => service.close());
  const client = await connect(service);
  const provider = await client.request('/api/providers', { name: 'fixture', type: 'openai', model: 'fixture', baseUrl: 'http://127.0.0.1:12345/v1' });
  const created = await client.request('/api/sessions', { providerId: provider.body.provider.id });
  await client.request(`/api/sessions/${created.body.session.id}/messages`, { content: 'wait' });
  await until(() => providerEntered);
  await assert.rejects(service.close({ ifIdle: true }), { code: 'WORKSPACE_BUSY' });
  const first = service.close(), second = service.close(); assert.equal(first, second);
  await first;
  const reopened = f.track(await startServer({ dataDir: f.userData }));
  try { assert.equal((await connect(reopened)).bootstrap.sessions[0].run.status, 'cancelled'); }
  finally { await reopened.close(); }
});

test('external workspaces isolate tasks, model credentials and files while preserving legacy data', async t => {
  const f = await sandbox(t), profiles = createWorkspaceProfiles({ userData: f.userData, appRoots: [f.appRoot], homeDirectory: f.root });
  await profiles.initialize();
  const vaults = new Map();
  async function open(profile) {
    let values = vaults.get(profile.secretsDir); if (!values) { values = new Map(); vaults.set(profile.secretsDir, values); }
    const service = f.track(await startServer({ dataDir: profile.dataDir, workspace: profile.workspace, workspaceId: profile.id, workspaceName: profile.label,
      workspaceOptions: profile.kind === 'external' ? { createRoot: false, expectedIdentity: profile.identity, protectedRoots: [f.userData, f.appRoot], denySensitivePaths: true } : undefined,
      secretStore: { get: id => values.get(id), set: (id, value) => values.set(id, value), delete: id => values.delete(id) },
    }));
    return { service, client: await connect(service) };
  }
  let current = await open(await profiles.getActive());
  t.after(() => current.service.close());
  const legacy = await current.client.request('/api/sessions', { title: 'legacy record' });
  await current.service.close();
  const dirA = path.join(f.root, 'project-a'), dirB = path.join(f.root, 'project-b');
  await mkdir(dirA); await mkdir(dirB);
  const a = await profiles.activate(await profiles.inspect(dirA));
  current = await open(a);
  assert.equal(current.client.bootstrap.sessions.length, 0);
  assert.equal(current.client.bootstrap.workspace.id, a.id);
  assert.equal(current.client.bootstrap.workspace.sensitiveFilesExcluded, true);
  await current.client.request('/api/sessions', { title: 'task A' });
  const provider = await current.client.request('/api/providers', { name: 'A only', type: 'openai', model: 'fixture', baseUrl: 'http://127.0.0.1:12345/v1', apiKey: 'isolated-fixture-key' });
  await current.client.request('/api/workspace/files', { path: 'shared-name.txt', content: 'A' });
  await writeFile(path.join(dirA, '.env'), 'SECRET=fixture');
  assert.equal((await current.client.request('/api/workspace/file?path=.env')).status, 403);
  assert.ok(!(await current.client.request('/api/workspace')).body.files.some(item => item.path === '.env'));
  await current.service.close();
  const b = await profiles.activate(await profiles.inspect(dirB));
  current = await open(b);
  assert.equal(current.client.bootstrap.sessions.length, 0);
  assert.equal(current.client.bootstrap.providers.length, 1);
  assert.equal((await current.client.request(`/api/providers/${provider.body.provider.id}/test`, {})).status, 404);
  await current.client.request('/api/workspace/files', { path: 'shared-name.txt', content: 'B' });
  await current.service.close();
  current = await open(await profiles.activate(a.id));
  assert.equal(current.client.bootstrap.sessions[0].title, 'task A');
  assert.equal(current.client.bootstrap.providers.find(item => item.id === provider.body.provider.id).hasKey, true);
  assert.equal(await readFile(path.join(dirA, 'shared-name.txt'), 'utf8'), 'A');
  assert.equal(await readFile(path.join(dirB, 'shared-name.txt'), 'utf8'), 'B');
  await current.service.close();
  current = await open(await profiles.activate('default'));
  assert.equal(current.client.bootstrap.sessions[0].id, legacy.body.session.id);
  assert.equal(current.client.bootstrap.providers.length, 1);
});

test('server never recreates a missing external directory or exposes sibling application data', async t => {
  const f = await sandbox(t), root = path.join(f.root, 'external'); await mkdir(root);
  const identity = await createWorkspace(root, { createRoot: false }).getIdentity();
  await rm(root, { recursive: true });
  await assert.rejects(startServer({ dataDir: f.userData, workspace: root, workspaceOptions: { createRoot: false, expectedIdentity: identity } }));
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  const sibling = path.join(f.userData, 'profiles', 'other'); await mkdir(sibling, { recursive: true });
  await assert.rejects(startServer({ dataDir: path.join(f.root, 'another-data'), workspace: sibling, workspaceOptions: { createRoot: false, protectedRoots: [f.userData] } }), { code: 'PROTECTED_WORKSPACE' });
});
