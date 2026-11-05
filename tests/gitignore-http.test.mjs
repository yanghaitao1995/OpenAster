// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { validateWorkspaceSearch } from '../server/workspace-search.mjs';

const needle = 'fixture-content-only-4826';
async function fixture(t, { projectMode = true, rules, gateway = false, parentRules } = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-ignore-http-'));
  const owned = await fs.lstat(root, { bigint: true });
  let service;
  t.after(async () => {
    await service?.close();
    const current = await fs.lstat(root, { bigint: true });
    assert.equal(current.dev, owned.dev); assert.equal(current.ino, owned.ino); assert.ok(!current.isSymbolicLink());
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'project'), dataDir = path.join(root, 'data');
  await fs.mkdir(workspace); await fs.mkdir(dataDir);
  async function write(relative, content = needle) {
    const target = path.join(workspace, relative);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content);
  }
  for (const file of ['visible.txt', 'draft.tmp', 'keep.tmp', 'root-only.txt', 'cache/rescued.txt', 'src/local.tmp', 'src/other.tmp', 'src/root-only.txt', 'src/deep/skip1.js', 'src/deep/keep.js', 'dist/bundle.txt', '.env', '.git/config']) await write(file);
  await write('.gitignore', rules ?? 'cache/\n*.tmp\n!keep.tmp\n/root-only.txt\nsrc/**/skip?.js\n!cache/rescued.txt\n');
  await write('src/.gitignore', '!local.tmp\n');
  if (parentRules !== undefined) await fs.writeFile(path.join(root, '.gitignore'), parentRules);
  const identity = await createWorkspace(workspace, { createRoot: false }).getIdentity();
  const token = 'isolated-ignore-gateway-token-'.repeat(3);
  service = await startServer({ dataDir, workspace, workspaceOptions: { createRoot: false, expectedIdentity: identity, protectedRoots: [dataDir], denySensitivePaths: true, projectScan: projectMode },
    ...(gateway ? { gatewayOrigin: 'https://ignore.example.test', token, allowedOrigins: ['capacitor://localhost'] } : {}) });
  const gatewayHeaders = gateway ? { Authorization: `Bearer ${token}`, Origin: 'capacitor://localhost' } : {};
  const bootResponse = await fetch(service.url + '/api/bootstrap', { headers: gatewayHeaders });
  assert.equal(bootResponse.status, 200);
  const bootstrap = await bootResponse.json(), cookie = bootResponse.headers.get('set-cookie')?.split(';')[0];
  const auth = { ...gatewayHeaders, ...(cookie ? { cookie } : {}), 'X-CSRF-Token': bootstrap.csrfToken };
  async function request(endpoint, { method = 'GET', data, authenticated = true, headers = {} } = {}) {
    const response = await fetch(service.url + endpoint, { method, signal: AbortSignal.timeout(15000), headers: { ...(authenticated ? auth : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, data: await response.json() };
  }
  const list = (options = {}) => request('/api/workspace?' + new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)])));
  const search = (options = {}, transport = {}) => request('/api/workspace/search', { method: 'POST', data: { query: needle, ...options }, ...transport });
  return { root, workspace, dataDir, service, bootstrap, write, request, list, search };
}
const names = result => result.data.files.map(entry => entry.path);
const matches = result => result.data.matches.map(entry => entry.path);

test('project discovery and content search share hierarchical ignore rules with separate generated overrides', async t => {
  const f = await fixture(t);
  assert.equal(f.bootstrap.capabilities.workspaceIgnore, 1); assert.equal(f.bootstrap.workspace.projectMode, true);
  const state = await f.request('/api/state'); assert.equal(state.data.capabilities.workspaceIgnore, 1); assert.equal(state.data.workspace.projectMode, true);
  const listed = await f.list(), searched = await f.search();
  assert.equal(listed.status, 200); assert.equal(searched.status, 200);
  for (const result of [listed, searched]) {
    assert.equal(result.data.scan.ignore.enabled, true); assert.equal(result.data.scan.ignore.includeIgnored, false); assert.equal(result.data.scan.ignore.caseSensitive, true);
    assert.ok(result.data.scan.ignore.files >= 2); assert.ok(result.data.scan.ignore.ignoredFiles >= 3); assert.ok(result.data.scan.ignore.ignoredDirectories >= 1);
    assert.equal(result.data.truncated, false); assert.equal(result.data.scan.ignore.scopeIgnored, false);
  }
  for (const expected of ['visible.txt', 'keep.tmp', 'src/local.tmp', 'src/root-only.txt', 'src/deep/keep.js']) { assert.ok(names(listed).includes(expected), expected); assert.ok(matches(searched).includes(expected), expected); }
  for (const hidden of ['draft.tmp', 'root-only.txt', 'cache/rescued.txt', 'src/other.tmp', 'src/deep/skip1.js', 'dist/bundle.txt', '.env', '.git/config']) { assert.ok(!names(listed).includes(hidden), hidden); assert.ok(!matches(searched).includes(hidden), hidden); }
  for (const method of [f.list, f.search]) {
    const paths = result => method === f.list ? names(result) : matches(result);
    const generated = await method({ includeGenerated: true }); assert.ok(paths(generated).includes('dist/bundle.txt')); assert.ok(!paths(generated).includes('draft.tmp'));
    const ignored = await method({ includeIgnored: true }); assert.ok(paths(ignored).includes('draft.tmp')); assert.ok(paths(ignored).includes('cache/rescued.txt')); assert.ok(!paths(ignored).includes('dist/bundle.txt'));
    assert.equal(ignored.data.scan.ignore.enabled, false); assert.equal(ignored.data.scan.ignore.files, 0);
    const both = await method({ includeIgnored: true, includeGenerated: true }); assert.ok(paths(both).includes('draft.tmp')); assert.ok(paths(both).includes('dist/bundle.txt'));
    assert.ok(!paths(both).includes('.env')); assert.ok(!paths(both).includes('.git/config'));
  }
});

test('direct subdirectory scopes retain ancestor rules and cannot reinclude an excluded parent implicitly', async t => {
  const f = await fixture(t);
  const src = await f.list({ path: 'src' });
  assert.ok(names(src).includes('src/local.tmp')); assert.ok(!names(src).includes('src/other.tmp')); assert.ok(!names(src).includes('src/deep/skip1.js'));
  for (const method of [f.list, f.search]) {
    const excluded = await method({ path: 'cache' }); assert.equal(excluded.status, 200); assert.equal(excluded.data.scan.ignore.scopeIgnored, true); assert.equal(excluded.data.truncated, false);
    assert.deepEqual(method === f.list ? names(excluded) : matches(excluded), []);
    const explicit = await method({ path: 'cache', includeIgnored: true }); assert.equal(explicit.status, 200); assert.equal(explicit.data.scan.ignore.scopeIgnored, false);
    assert.deepEqual(method === f.list ? names(explicit) : matches(explicit), ['cache/rescued.txt']);
  }
});

test('ignore filtering is not a read/write permission and never bypasses sensitive or linked paths', async t => {
  const f = await fixture(t);
  const preview = await f.request('/api/workspace/file?' + new URLSearchParams({ path: 'draft.tmp' }));
  assert.equal(preview.status, 200); assert.equal(preview.data.content, needle);
  const imported = await f.request('/api/workspace/files', { method: 'POST', data: { path: 'new.tmp', content: 'explicitly imported content' } });
  assert.equal(imported.status, 201);
  assert.ok(!names(await f.list()).includes('new.tmp')); assert.ok(names(await f.list({ includeIgnored: true })).includes('new.tmp'));
  await fs.writeFile(path.join(f.dataDir, 'secret.txt'), needle);
  await fs.link(path.join(f.dataDir, 'secret.txt'), path.join(f.workspace, 'alias.txt'));
  await fs.symlink(f.dataDir, path.join(f.workspace, 'alias-dir'), process.platform === 'win32' ? 'junction' : 'dir');
  const all = await f.list({ includeIgnored: true, includeGenerated: true }); assert.ok(!names(all).includes('alias.txt')); assert.ok(!names(all).includes('alias-dir'));
  for (const forbidden of ['.env', '.git', 'alias-dir']) {
    assert.equal((await f.list({ path: forbidden, includeIgnored: true, includeGenerated: true })).status, 403);
    assert.equal((await f.search({ path: forbidden, includeIgnored: true, includeGenerated: true })).status, 403);
  }
});

test('invalid rules do not prevent startup; explicit override and later corrected rules remain usable', async t => {
  const f = await fixture(t, { rules: Buffer.from([0xff, 0xfe, 0x00]) });
  assert.equal(f.bootstrap.workspace.projectMode, true);
  for (const method of [f.list, f.search]) {
    const blocked = await method(); assert.equal(blocked.data.error.code, 'GITIGNORE_INVALID'); assert.ok(blocked.status >= 400);
    assert.ok(!JSON.stringify(blocked.data).includes(f.workspace));
    const override = await method({ includeIgnored: true }); assert.equal(override.status, 200); assert.equal(override.data.scan.ignore.enabled, false);
  }
  assert.equal((await f.request('/api/health')).status, 200);
  const task = await f.request('/api/sessions', { method: 'POST', data: { title: 'Available despite ignore policy error', providerId: 'demo' } });
  assert.equal(task.status, 201);
  await f.write('.gitignore', 'visible.txt\n');
  const recovered = await f.list(); assert.equal(recovered.status, 200); assert.ok(!names(recovered).includes('visible.txt'));
  assert.ok(!matches(await f.search()).includes('visible.txt'));
});

test('disabled project policy and workspace boundaries avoid reading unrelated ignore rules', async t => {
  const legacy = await fixture(t, { projectMode: false, rules: Buffer.from([0xff]), parentRules: '*\n' });
  assert.equal(legacy.bootstrap.workspace.projectMode, false);
  for (const method of [legacy.list, legacy.search]) {
    const result = await method(); assert.equal(result.status, 200); assert.equal(result.data.scan.ignore.enabled, false); assert.equal(result.data.scan.ignore.files, 0);
    const paths = method === legacy.list ? names(result) : matches(result); assert.ok(paths.includes('draft.tmp')); assert.ok(paths.includes('dist/bundle.txt'));
  }
  const bounded = await fixture(t, { rules: '', parentRules: '*\n' });
  assert.ok(names(await bounded.list()).includes('visible.txt')); assert.ok(matches(await bounded.search()).includes('visible.txt'));
});

test('ignore options use strict booleans and keep authentication, origin and search CSRF checks', async t => {
  const f = await fixture(t);
  for (const query of ['includeIgnored=', 'includeIgnored=1', 'includeIgnored=True', 'includeIgnored=null', 'includeIgnored[]=true', 'includeIgnored=true&includeIgnored=false', 'includeIgnored=true&%69ncludeIgnored=true', 'includeIgnored=%FF', 'respectGitignore=false']) {
    const response = await f.request('/api/workspace?' + query); assert.equal(response.status, 400); assert.equal(response.data.error.code, 'INVALID_WORKSPACE_QUERY');
  }
  for (const value of [null, 0, 1, '', 'true', [], {}]) { const result = await f.search({ includeIgnored: value }); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_WORKSPACE_SEARCH'); }
  assert.equal((await f.request('/api/workspace?includeIgnored=true', { authenticated: false })).status, 401);
  assert.equal((await f.search({ includeIgnored: true }, { authenticated: false })).status, 401);
  assert.equal((await f.search({ includeIgnored: true }, { headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.search({ includeIgnored: true }, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await f.request('/api/workspace?includeIgnored=true', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal(validateWorkspaceSearch({ query: 'x' }).includeIgnored, false);
  assert.equal(validateWorkspaceSearch({ query: 'x', includeIgnored: true }).includeIgnored, true);
});

test('mobile gateway override remains authenticated and discovery rules are not copied into stored task state', async t => {
  const f = await fixture(t, { gateway: true, rules: 'unique-ignore-pattern-9463/\n*.tmp\n' });
  const result = await f.search({ includeIgnored: true }); assert.equal(result.status, 200); assert.ok(matches(result).includes('draft.tmp'));
  assert.equal((await f.search({ includeIgnored: true }, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await f.search({ includeIgnored: true }, { headers: { 'X-CSRF-Token': '' } })).status, 403);
  for (const route of ['/api/audit', '/api/export', '/api/state']) {
    const response = await f.request(route); assert.equal(response.status, 200); assert.ok(!JSON.stringify(response.data).includes('unique-ignore-pattern-9463'));
  }
});
