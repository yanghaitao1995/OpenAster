// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { startServer } from '../server/index.mjs';
import { startWorkspaceHost } from '../server/workspace-host.mjs';

async function sandbox(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-v42-projects-'));
  const identity = await fs.lstat(root, { bigint: true }), owner = randomUUID(), services = [];
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  t.after(async () => {
    for (const service of services.reverse()) await service.close();
    const actual = await fs.lstat(root, { bigint: true });
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^openaster-v42-projects-/u); assert.equal(actual.isSymbolicLink(), false);
    assert.equal(actual.ino, identity.ino); assert.equal(actual.dev, identity.dev);
    assert.equal(await fs.readFile(path.join(root, '.owner'), 'utf8'), owner);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, track: service => { services.push(service); return service; }, options: { port: 0, dataDir: path.join(root, 'data'), workspace: path.join(root, 'original'), projectsRoot: path.join(root, 'projects'), homeDirectory: root } };
}
async function connect(url, authorization) {
  const first = await fetch(url + '/api/bootstrap', { headers: authorization ? { authorization } : {} });
  assert.equal(first.status, 200); const state = await first.json();
  const headers = { 'content-type': 'application/json', 'x-csrf-token': state.csrfToken,
    ...(authorization ? { authorization } : { cookie: first.headers.get('set-cookie').split(';')[0] }) };
  return { state, headers, async request(route, body, override = {}) {
    const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...override }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  } };
}
async function waitForWorkspace(host, workspace, authorization) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { const client = await connect(host.url, authorization); if (client.state.workspace.path === workspace) return client; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Expected isolated workspace did not become available');
}

test('CLI host preserves an existing default binding and records across project switching and restart', async t => {
  const f = await sandbox(t);
  const original = f.track(await startServer(f.options)), existing = await connect(original.url);
  await fs.writeFile(path.join(f.options.workspace, 'existing.txt'), 'Original project file\r\n');
  const session = (await existing.request('/api/sessions', { title: 'Existing default history' })).data.session;
  await original.close();
  const host = f.track(await startWorkspaceHost(f.options)), first = await connect(host.url), port = host.url;
  assert.equal(first.state.workspace.path, f.options.workspace);
  assert.equal(first.state.sessions.some(item => item.id === session.id), true);
  assert.equal(first.state.capabilities.workspaceManagement, 1);
  const selected = await first.request('/api/projects/prepare', { action: 'create', rootId: 'projects', name: 'second' });
  assert.equal(selected.status, 200);
  const accepted = await first.request('/api/projects/activate', { ticket: selected.data.ticket }); assert.equal(accepted.status, 202);
  const secondPath = path.join(f.options.projectsRoot, 'second'), second = await waitForWorkspace(host, secondPath);
  assert.equal(host.url, port); assert.equal(second.state.sessions.length, 0);
  assert.notEqual(second.state.workspace.storageId, first.state.workspace.storageId);
  assert.notEqual(second.state.csrfToken, first.state.csrfToken);
  assert.equal((await first.request('/api/state')).status, 401);
  assert.equal((await second.request('/api/sessions', { title: 'stale' }, { 'x-csrf-token': first.state.csrfToken })).status, 403);
  const secondSession = (await second.request('/api/sessions', { title: 'Second independent history' })).data.session;
  const returning = await second.request('/api/projects/prepare', { action: 'switch', id: 'default' });
  assert.equal((await second.request('/api/projects/activate', { ticket: returning.data.ticket })).status, 202);
  const restored = await waitForWorkspace(host, f.options.workspace);
  assert.equal(restored.state.workspace.storageId, first.state.workspace.storageId);
  assert.equal(restored.state.sessions.some(item => item.id === session.id), true);
  assert.equal(restored.state.sessions.some(item => item.id === secondSession.id), false);
  assert.equal(await fs.readFile(path.join(f.options.workspace, 'existing.txt'), 'utf8'), 'Original project file\r\n');
  assert.equal((await fs.stat(path.join(f.options.dataDir, 'openaster.sqlite'))).isFile(), true);
  const back = await restored.request('/api/projects/prepare', { action: 'switch', id: second.state.workspace.id });
  await restored.request('/api/projects/activate', { ticket: back.data.ticket }); await waitForWorkspace(host, secondPath);
  await host.close();
  const restarted = f.track(await startWorkspaceHost(f.options)), afterRestart = await connect(restarted.url);
  assert.equal(afterRestart.state.workspace.path, secondPath);
  assert.equal(afterRestart.state.sessions.some(item => item.id === secondSession.id), true);
});

test('gateway project APIs require authentication and CSRF, restrict host ranges and renew CSRF after switching', async t => {
  const f = await sandbox(t), token = randomBytes(32).toString('hex'), authorization = `Bearer ${token}`;
  const host = f.track(await startWorkspaceHost({ ...f.options, gatewayOrigin: 'https://gateway.example', token, allowedOrigins: ['capacitor://localhost'] }));
  assert.equal((await fetch(host.url + '/api/projects')).status, 401);
  const first = await connect(host.url, authorization);
  const listing = await first.request('/api/projects');
  assert.equal(listing.data.allowAbsolutePath, false); assert.equal(listing.data.location, 'service-host');
  assert.equal(listing.data.roots.some(root => root.id === 'home'), false);
  assert.equal((await first.request('/api/projects/browse', { rootId: 'projects' }, { 'x-csrf-token': 'invalid' })).status, 403);
  assert.equal((await first.request('/api/projects/browse', { rootId: 'home' })).status, 403);
  assert.equal((await first.request('/api/projects/browse', { rootId: 'projects', path: '../' })).status, 400);
  assert.equal((await first.request('/api/projects/prepare', { action: 'open', absolutePath: f.root })).status, 403);
  const selected = await first.request('/api/projects/prepare', { action: 'create', rootId: 'projects', name: 'mobile-project' });
  assert.equal(selected.status, 200);
  assert.equal((await first.request('/api/projects/activate', { ticket: selected.data.ticket })).status, 202);
  const second = await waitForWorkspace(host, path.join(f.options.projectsRoot, 'mobile-project'), authorization);
  assert.notEqual(first.state.csrfToken, second.state.csrfToken);
  assert.equal((await first.request('/api/projects/browse', { rootId: 'projects' })).status, 403);
  assert.equal((await second.request('/api/projects/browse', { rootId: 'projects' })).status, 200);
});

test('CLI initialization does not seed skills through an existing directory link', async t => {
  const f = await sandbox(t), target = path.join(f.root, 'untouched');
  await fs.mkdir(target);
  await fs.symlink(target, f.options.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(startWorkspaceHost(f.options), { code: 'WORKSPACE_UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(target), []);
});
