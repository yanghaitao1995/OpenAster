// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startServer } from '../server/index.mjs';
import { createWorkspace } from '../core/workspace.mjs';

async function fixture(t, { projectScan = true } = {}) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-scan-http-'));
  const workspace = path.join(root, 'project'), dataDir = path.join(root, 'data'), appRoot = path.join(root, 'app');
  let service;
  t.after(async () => {
    await service?.close();
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const directory of [workspace, dataDir, appRoot]) await fs.mkdir(directory);
  for (const directory of ['src/中文目录', 'node_modules/inner/node_modules', 'dist', '.git']) await fs.mkdir(path.join(workspace, directory), { recursive: true });
  for (const [relative, content] of Object.entries({
    'README.md': 'project readme', 'src/main.js': 'ordinary source', 'src/中文目录/笔记.md': '中文文件',
    'src/node_modules': 'ordinary file with a generated directory name',
    'node_modules/package.txt': 'installed dependency', 'node_modules/inner/node_modules/deep.txt': 'nested dependency',
    'dist/result.txt': 'generated output', '.env': 'FIXTURE_KEY=secret', '.env.example': 'FIXTURE_KEY=replace', '.git/config': 'private repo metadata',
  })) await fs.writeFile(path.join(workspace, relative), content);
  const identity = await createWorkspace(workspace, { createRoot: false }).getIdentity();
  service = await startServer({ dataDir, workspace, workspaceOptions: { createRoot: false, expectedIdentity: identity, protectedRoots: [dataDir, appRoot], denySensitivePaths: true, projectScan } });
  const bootstrap = await fetch(service.url + '/api/bootstrap', { signal: AbortSignal.timeout(10000) });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0], csrfToken = (await bootstrap.json()).csrfToken;
  async function request(endpoint, { auth = true, headers = {}, method = 'GET', data } = {}) {
    const response = await fetch(service.url + endpoint, {
      method, signal: AbortSignal.timeout(30000), headers: { ...(auth ? { cookie, 'X-CSRF-Token': csrfToken } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, data: await response.json() };
  }
  return { root, workspace, dataDir, appRoot, service, request };
}
const listing = (scope = '', includeGenerated) => '/api/workspace?' + new URLSearchParams({ path: scope, ...(includeGenerated === undefined ? {} : { includeGenerated: String(includeGenerated) }) });

test('authenticated directory listing returns project scope metadata and keeps all paths workspace-relative', async t => {
  const f = await fixture(t);
  const result = await f.request('/api/workspace');
  assert.equal(result.status, 200); assert.equal(result.data.scope, ''); assert.equal(result.data.name, 'project');
  assert.equal(result.data.scan.projectMode, true); assert.equal(result.data.scan.includeGenerated, false);
  assert.equal(result.data.truncated, false); assert.deepEqual(result.data.scan.limits, []);
  assert.equal(result.data.scan.excludedDirectories, 2); assert.ok(result.data.scan.skippedEntries >= 2);
  assert.ok(Number.isSafeInteger(result.data.scan.visitedEntries) && result.data.scan.visitedEntries > 0);
  const names = result.data.files.map(item => item.path);
  for (const expected of ['README.md', 'src/main.js', 'src/node_modules', 'src/中文目录/笔记.md', '.env.example']) assert.ok(names.includes(expected), expected);
  assert.ok(!names.some(name => name.startsWith('node_modules/') || name.startsWith('dist/') || name === '.env' || name.startsWith('.git/')));
  assert.deepEqual((await f.request(listing(''))).data, result.data);
  const nested = await f.request(listing('src/中文目录'));
  assert.equal(nested.status, 200); assert.equal(nested.data.scope, 'src/中文目录');
  assert.deepEqual(nested.data.files.map(item => item.path), ['src/中文目录/笔记.md']);
  assert.equal(nested.data.truncated, false);
  assert.equal((await f.request('/api/workspace?path=%73rc')).data.scope, 'src');
  assert.equal((await f.request('/api/workspace/search?query=source')).status, 404, 'Content search accepts authenticated POST bodies, not GET query strings');
});

test('generated scanning can be explicitly included or scoped while sensitive paths remain excluded', async t => {
  const f = await fixture(t);
  const included = await f.request(listing('', true));
  assert.equal(included.status, 200); assert.equal(included.data.scan.includeGenerated, true); assert.equal(included.data.scan.excludedDirectories, 0);
  assert.ok(included.data.files.some(item => item.path === 'node_modules/inner/node_modules/deep.txt'));
  assert.ok(included.data.files.some(item => item.path === 'dist/result.txt'));
  assert.ok(!included.data.files.some(item => item.path === '.env' || item.path.startsWith('.git/')));
  const scoped = await f.request(listing('node_modules'));
  assert.equal(scoped.status, 200); assert.equal(scoped.data.scope, 'node_modules');
  assert.ok(scoped.data.files.some(item => item.path === 'node_modules/package.txt'));
  assert.ok(!scoped.data.files.some(item => item.path === 'node_modules/inner/node_modules/deep.txt'));
  assert.equal(scoped.data.scan.excludedDirectories, 1); assert.equal(scoped.data.truncated, false);
  assert.ok((await f.request(listing('node_modules', true))).data.files.some(item => item.path === 'node_modules/inner/node_modules/deep.txt'));
  assert.equal((await f.request(listing('src', false))).data.scan.includeGenerated, false);
  for (const relative of ['.git', '.env']) {
    const blocked = await f.request(listing(relative, true)); assert.equal(blocked.status, 403); assert.equal(blocked.data.error.code, 'SENSITIVE_PATH');
  }
  assert.equal((await f.request('/api/workspace/file?path=.env&includeGenerated=true')).status, 403);
  assert.equal((await f.request('/api/workspace/files', { method: 'POST', data: { path: '.env', content: 'should not write' } })).status, 403);
  assert.equal(await fs.readFile(path.join(f.workspace, '.env'), 'utf8'), 'FIXTURE_KEY=secret');
});

test('legacy scan policy remains disabled and query parameters cannot change server policy or limits', async t => {
  const f = await fixture(t, { projectScan: false });
  for (const includeGenerated of [undefined, false, true]) {
    const result = await f.request(listing('', includeGenerated));
    assert.equal(result.status, 200); assert.equal(result.data.scan.projectMode, false); assert.equal(result.data.scan.excludedDirectories, 0);
    assert.ok(result.data.files.some(item => item.path === 'node_modules/inner/node_modules/deep.txt'));
  }
  for (const query of ['projectScan=true', 'denySensitivePaths=false', 'protectedRoots=', 'createRoot=true', 'expectedIdentity={}', 'maxFiles=100000', 'limit=100000', 'limits=entries', 'signal=none']) {
    const response = await f.request('/api/workspace?' + query);
    assert.equal(response.status, 400); assert.equal(response.data.error.code, 'INVALID_WORKSPACE_QUERY');
  }
});

test('unknown, duplicate, malformed and nonboolean query inputs return explicit 400 without bypassing authentication', async t => {
  const f = await fixture(t);
  const invalid = [
    'path=src&path=dist', 'path=src&%70ath=dist', 'includeGenerated=true&includeGenerated=false',
    'includeGenerated=true&includeGenerated=true', 'unknown=', '=src', 'Path=src', 'includeGenerated[]=true',
    ...['', '1', '0', 'True', 'FALSE', 'null', 'undefined', 'true%20', 'false%00'].map(value => `includeGenerated=${value}`),
    'path=%', 'path=%FF', 'path=%ED%A0%80', '%FF=src',
  ];
  for (const query of invalid) {
    const result = await f.request('/api/workspace?' + query);
    assert.equal(result.status, 400, query); assert.equal(result.data.error.code, 'INVALID_WORKSPACE_QUERY', query);
  }
  assert.equal((await f.request('/api/workspace?path=src', { auth: false })).status, 401);
  assert.equal((await f.request('/api/workspace?denySensitivePaths=false', { auth: false })).status, 401);
  assert.equal((await f.request('/api/workspace?path=src', { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
});

test('invalid, file, missing and linked scopes cannot escape or widen the protected workspace', async t => {
  const f = await fixture(t);
  for (const scope of ['../data', '/etc', 'C:/Windows', 'src/../dist', 'src\\main.js', '.', 'src//child', 'src/', 'a'.repeat(513), 'bad\0name', 'CON.txt', 'src:stream']) {
    const result = await f.request(listing(scope, true)); assert.equal(result.status, 400, scope); assert.equal(result.data.error.code, 'INVALID_PATH', scope);
  }
  const file = await f.request(listing('README.md'));
  assert.equal(file.status, 400); assert.equal(file.data.error.code, 'NOT_DIRECTORY');
  const missing = await f.request(listing('does-not-exist'));
  assert.equal(missing.status, 404); assert.equal(missing.data.error.code, 'FILE_NOT_FOUND');
  await assert.rejects(fs.lstat(path.join(f.workspace, 'does-not-exist')), { code: 'ENOENT' });
  await fs.writeFile(path.join(f.dataDir, 'private.txt'), 'must remain private');
  await fs.symlink(f.dataDir, path.join(f.workspace, 'data-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.link(path.join(f.dataDir, 'private.txt'), path.join(f.workspace, 'private-alias.txt'));
  for (const scope of ['data-alias', 'private-alias.txt']) {
    const response = await f.request(listing(scope, true)); assert.equal(response.status, 403); assert.equal(response.data.error.code, 'UNSAFE_PATH');
  }
  const root = await f.request(listing('', true));
  assert.ok(!root.data.files.some(item => item.path.startsWith('data-alias') || item.path === 'private-alias.txt'));
  assert.ok(root.data.scan.skippedEntries >= 4);
});

test('actual output cap remains fixed and a narrower directory scope can inspect entries outside the root result', async t => {
  const f = await fixture(t);
  const folder = path.join(f.workspace, 'many'); await fs.mkdir(folder);
  for (let start = 0; start < 1001; start += 40) {
    await Promise.all(Array.from({ length: Math.min(40, 1001 - start) }, (_, index) => fs.writeFile(path.join(folder, `file-${String(start + index).padStart(4, '0')}.txt`), '')));
  }
  const result = await f.request(listing('many'));
  assert.equal(result.status, 200); assert.equal(result.data.files.length, 1000); assert.equal(result.data.truncated, true);
  assert.ok(result.data.scan.limits.includes('entries')); assert.ok(result.data.scan.visitedEntries <= 10000);
  const override = await f.request('/api/workspace?path=many&entries=2000');
  assert.equal(override.status, 400); assert.equal(override.data.error.code, 'INVALID_WORKSPACE_QUERY');
  const scoped = await f.request(listing('src/中文目录'));
  assert.equal(scoped.status, 200); assert.equal(scoped.data.truncated, false); assert.deepEqual(scoped.data.scan.limits, []);
  assert.deepEqual(scoped.data.files.map(item => item.path), ['src/中文目录/笔记.md']);
});

test('file previews preserve leading spaces and every valid core path length without selecting another file', async t => {
  const f = await fixture(t);
  const longPath = [...Array(3).fill('a'.repeat(125)), 'b'.repeat(121) + '.txt'].join('/');
  assert.equal(longPath.length, 503);
  await fs.mkdir(path.dirname(path.join(f.workspace, longPath)), { recursive: true });
  for (const [relative, content] of [[' note.txt', 'leading-space file'], ['note.txt', 'different ordinary file'], [longPath, 'long-path content']]) {
    await fs.writeFile(path.join(f.workspace, relative), content);
  }
  const inventory = await f.request('/api/workspace');
  for (const relative of [' note.txt', 'note.txt', longPath]) assert.ok(inventory.data.files.some(entry => entry.path === relative), relative);
  for (const [relative, content] of [[' note.txt', 'leading-space file'], ['note.txt', 'different ordinary file'], [longPath, 'long-path content']]) {
    const response = await f.request('/api/workspace/file?' + new URLSearchParams({ path: relative }));
    assert.equal(response.status, 200, relative);
    assert.deepEqual(response.data, { path: relative, content, sha256: createHash('sha256').update(content).digest('hex') });
  }
  for (const endpoint of ['/api/workspace/file', '/api/workspace/file?path=']) {
    const response = await f.request(endpoint);
    assert.equal(response.status, 400);
    assert.equal(response.data.error.code, 'INVALID_PATH');
  }
});
