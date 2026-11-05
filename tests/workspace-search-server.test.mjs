// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startServer } from '../server/index.mjs';
import { createWorkspace } from '../core/workspace.mjs';

async function fixture(t, { gateway = false } = {}) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-search-http-'));
  const workspace = path.join(root, 'project'), dataDir = path.join(root, 'data');
  await fs.mkdir(workspace); await fs.mkdir(dataDir);
  const files = {
    'README.md': '\ufeffOverview\rNeedle two\r\nneedle three\n[a.*] <img src=x>\n tail needle ',
    'src/中文.txt': '开头\n' + '😀'.repeat(500) + '中文 NEEDLE 结束',
    'dist/output.txt': 'needle generated', '.env': 'needle private', '.env.example': 'needle placeholder',
  };
  for (const [relative, content] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(workspace, relative)), { recursive: true }); await fs.writeFile(path.join(workspace, relative), content); }
  const identity = await createWorkspace(workspace).getIdentity();
  const token = 'search-gateway-test-'.repeat(4);
  const service = await startServer({ dataDir, workspace, workspaceOptions: { createRoot: false, expectedIdentity: identity, protectedRoots: [dataDir], denySensitivePaths: true, projectScan: true }, ...(gateway ? { gatewayOrigin: 'https://search.example.test', token, allowedOrigins: ['capacitor://localhost'] } : {}) });
  t.after(async () => { await service.close(); assert.equal(path.dirname(await fs.realpath(root)), parent); await fs.rm(root, { recursive: true, force: true }); });
  const authHeaders = gateway ? { Authorization: `Bearer ${token}`, Origin: 'capacitor://localhost' } : {};
  const bootResponse = await fetch(service.url + '/api/bootstrap', { headers: authHeaders });
  const bootstrap = await bootResponse.json(), cookie = bootResponse.headers.get('set-cookie')?.split(';')[0];
  const headers = { ...authHeaders, ...(cookie ? { cookie } : {}), 'X-CSRF-Token': bootstrap.csrfToken };
  async function request(endpoint, { method = 'GET', data, raw, auth = true, extraHeaders = {} } = {}) {
    const response = await fetch(service.url + endpoint, { method, signal: AbortSignal.timeout(10000), headers: { ...(auth ? headers : {}), ...(data !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: raw ?? (data === undefined ? undefined : JSON.stringify(data)) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  const search = (data, options = {}) => request('/api/workspace/search', { method: 'POST', data, ...options });
  return { root, workspace, dataDir, files, service, bootstrap, request, search };
}

test('content search returns exact original snippets, CR line numbers, hashes and explicit scope', async t => {
  const f = await fixture(t);
  assert.equal(f.bootstrap.capabilities.workspaceSearch, 1);
  const result = await f.search({ query: 'needle' });
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.data.version, 1); assert.equal(result.data.caseSensitive, false); assert.equal(result.data.scope, '');
  assert.equal(result.data.matches.length, 5); assert.equal(result.data.searchedFiles, 3);
  assert.equal(result.data.truncated, false); assert.equal(result.data.scan.excludedDirectories, 1); assert.ok(result.data.scan.skippedEntries >= 1);
  assert.deepEqual(result.data.matches.filter(match => match.path === 'README.md').map(match => match.line), [2, 3, 5]);
  for (const match of result.data.matches) {
    const content = f.files[match.path], line = content.split(/\r\n|\r|\n/u)[match.line - 1];
    assert.equal(match.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal(match.text, line.slice(match.excerptStart, match.excerptEnd));
    assert.equal(match.lineLength, line.length); assert.ok(match.text.isWellFormed()); assert.ok(match.text.length <= 600);
    assert.equal(match.text.slice(match.matchStart, match.matchEnd).toLowerCase(), 'needle');
  }
  const late = result.data.matches.find(match => match.path === 'src/中文.txt'); assert.ok(late.excerptStart > 0); assert.equal(late.line, 2);
  const scoped = await f.search({ query: 'NEEDLE', path: 'src', caseSensitive: true });
  assert.equal(scoped.data.scope, 'src'); assert.equal(scoped.data.caseSensitive, true); assert.equal(scoped.data.matches.length, 1);
  assert.equal((await f.search({ query: 'needle', path: 'src', caseSensitive: true })).data.matches.length, 0);
  assert.equal((await f.search({ query: '[a.*]' })).data.matches[0].text, '[a.*] <img src=x>');
  assert.deepEqual((await f.search({ query: ' needle ' })).data.matches.map(match => [match.path, match.line]), [['README.md', 5], ['src/中文.txt', 2]], 'significant query spaces survive validation');
  assert.ok((await f.search({ query: 'needle', includeGenerated: true })).data.matches.some(match => match.path === 'dist/output.txt'));
});

test('search requires session, CSRF and allowed origin and never persists the query', async t => {
  const f = await fixture(t), query = 'private query only held in request';
  assert.equal((await f.search({ query }, { auth: false })).status, 401);
  assert.equal((await f.search({ query }, { extraHeaders: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.search({ query }, { extraHeaders: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.search({ query }, { extraHeaders: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.search({ query })).status, 200);
  for (const route of ['/api/audit', '/api/export', '/api/state']) assert.ok(!JSON.stringify((await f.request(route)).data).includes(query));
  assert.equal((await f.request('/api/workspace/search?query=needle')).status, 404);
  assert.equal((await f.request('/api/workspace/search?query=needle', { method: 'POST', data: { query } })).status, 400);
});

test('remote mobile-origin search retains bearer and CSRF protections', async t => {
  const f = await fixture(t, { gateway: true });
  const result = await f.search({ query: 'needle', path: 'src' });
  assert.equal(result.status, 200); assert.equal(result.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  assert.equal(result.data.matches.length, 1);
  assert.equal((await f.search({ query: 'needle' }, { extraHeaders: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await f.search({ query: 'needle' }, { extraHeaders: { 'X-CSRF-Token': '' } })).status, 403);
});

test('strict search body rejects malformed text, option types, unknown options and overlarge input', async t => {
  const f = await fixture(t);
  for (const query of [undefined, null, 4, '', 'x'.repeat(257), '\0', 'a\nb', 'a\rb', '\u2028', '\u2029', '\ud800']) {
    const result = await f.search({ query }); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_QUERY');
  }
  for (const data of [{ query: 'x', unknown: true }, { query: 'x', path: null }, { query: 'x', path: [] }, { query: 'x', includeGenerated: 'false' }, { query: 'x', caseSensitive: null }, { query: 'x', maxFiles: 10000 }, { query: 'x', signal: {} }]) {
    const result = await f.search(data); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_WORKSPACE_SEARCH');
  }
  for (const raw of ['null', '[]', '{"query":', Buffer.from([123,34,113,117,101,114,121,34,58,34,255,34,125])]) {
    const result = await f.search(undefined, { raw }); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_JSON');
  }
  assert.equal((await f.search({ query: 'x' }, { extraHeaders: { 'Content-Type': 'text/plain' } })).status, 415);
  const large = await f.search({ query: 'x'.repeat(8192) }); assert.equal(large.status, 413); assert.equal(large.data.error.code, 'BODY_TOO_LARGE');
});

test('search uses the same sensitive-path, linked-directory and workspace identity boundaries as previews', async t => {
  const f = await fixture(t);
  for (const scope of ['../data', '/etc', 'C:/Windows', 'src\\file', 'CON', 'src/..']) assert.equal((await f.search({ query: 'needle', path: scope })).status, 400);
  for (const scope of ['.env', '.git']) assert.equal((await f.search({ query: 'needle', path: scope, includeGenerated: true })).status, 403);
  assert.equal((await f.search({ query: 'needle', path: 'README.md' })).data.error.code, 'NOT_DIRECTORY');
  assert.equal((await f.search({ query: 'needle', path: 'missing' })).status, 404);
  await fs.writeFile(path.join(f.dataDir, 'secret.txt'), 'needle private');
  await fs.symlink(f.dataDir, path.join(f.workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.link(path.join(f.dataDir, 'secret.txt'), path.join(f.workspace, 'alias.txt'));
  assert.equal((await f.search({ query: 'needle', path: 'alias' })).status, 403);
  const scan = await f.search({ query: 'needle', includeGenerated: true });
  assert.ok(!scan.data.matches.some(match => match.path.startsWith('alias') || match.path === '.env'));
  await fs.rename(f.workspace, path.join(f.root, 'original')); await fs.mkdir(f.workspace);
  await fs.writeFile(path.join(f.workspace, 'fake.txt'), 'needle');
  const changed = await f.search({ query: 'needle' }); assert.equal(changed.status, 409); assert.equal(changed.data.error.code, 'WORKSPACE_CHANGED');
});

test('search results retain their read-time hash and bounded partial results do not imply absence', async t => {
  const f = await fixture(t);
  const before = await f.search({ query: 'needle', path: 'src' });
  await fs.writeFile(path.join(f.workspace, 'src/中文.txt'), 'new line\nnew text');
  const preview = await f.request('/api/workspace/file?' + new URLSearchParams({ path: 'src/中文.txt' }));
  assert.notEqual(before.data.matches[0].sha256, preview.data.sha256);
  await fs.mkdir(path.join(f.workspace, 'many'));
  await fs.writeFile(path.join(f.workspace, 'many/lines.txt'), Array.from({ length: 101 }, (_, index) => 'needle ' + index).join('\n'));
  const bounded = await f.search({ query: 'needle', path: 'many' });
  assert.equal(bounded.data.matches.length, 100); assert.equal(bounded.data.truncated, true); assert.deepEqual(bounded.data.scan.limits, ['search-matches']);
  assert.equal(bounded.data.searchedFiles, 1);
  const absent = await f.search({ query: 'absent', path: 'many' }); assert.equal(absent.data.matches.length, 0); assert.equal(absent.data.truncated, false);
});
