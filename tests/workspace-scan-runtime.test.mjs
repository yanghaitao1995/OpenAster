// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';

async function fixture(t, { calls = [], demo = false } = {}) {
  const parent = await fs.realpath(tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'openaster-scan-runtime-'));
  let runtime;
  t.after(async () => {
    await runtime?.shutdown();
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.match(path.basename(root), /^openaster-scan-runtime-[A-Za-z0-9]+$/);
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const directory of ['src', 'other', 'node_modules', '.git']) await fs.mkdir(path.join(root, directory));
  for (const [relative, content] of Object.entries({
    'README.md': 'root text', 'src/main.txt': 'needle source', 'other/ignored.txt': 'needle elsewhere',
    'node_modules/dependency.txt': 'needle dependency', '.env': 'PRIVATE_SCAN_SECRET', '.git/config': 'PRIVATE_SCAN_SECRET',
  })) await fs.writeFile(path.join(root, relative), content);
  const workspace = createWorkspace(root, { createRoot: false, projectScan: true, denySensitivePaths: true });
  const touches = [];
  const tracked = Object.fromEntries(Object.entries(workspace).map(([key, value]) => [key,
    typeof value === 'function' ? (...args) => { touches.push(key); return value(...args); } : value]));
  let session = { id: 'session', title: '新任务', providerId: 'fixture', messages: [], approvals: [] };
  let requests = 0;
  const outputs = [], schemas = [];
  runtime = createRuntime({
    workspace: tracked,
    providers: async () => ({ id: 'fixture', name: 'Fixture', type: demo ? 'demo' : 'openai', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', enabled: true }),
    getSession: async () => structuredClone(session), saveSession: async value => { session = structuredClone(value); },
    providerCall: async (_provider, request) => {
      requests++;
      if (requests === 1) { schemas.push(...structuredClone(request.tools)); return { content: '', toolCalls: calls }; }
      outputs.push(...request.messages.filter(message => message.role === 'tool').map(message => ({ ...JSON.parse(message.content), name: message.name, isError: message.isError })));
      return { content: '已检查当前扫描范围。', toolCalls: [] };
    },
    limits: { maxRunMs: 15000 },
  });
  return { root, touches, schemas, outputs, get: () => session, run: async () => {
    await runtime.start(session.id, { content: '列出文件并搜索文本，不要写入。' });
    const deadline = Date.now() + 20000;
    while (runtime.isActive(session.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtime.isActive(session.id), false, 'runtime finished');
    assert.equal(session.run.status, 'completed', JSON.stringify(session.run.error));
  } };
}
const call = (name, args, id) => ({ id: String(id), name, args });

test('model discovery and search pass independent gitignore overrides while keeping sensitive paths denied', async t => {
  const f = await fixture(t, { calls: [
    call('list_workspace', {}, 1),
    call('list_workspace', { includeIgnored: true }, 2),
    call('search_files', { query: 'needle' }, 3),
    call('search_files', { query: 'needle', includeIgnored: true }, 4),
  ] });
  await fs.writeFile(path.join(f.root, '.gitignore'), 'other/\n!.env\n');
  await f.run();
  assert.equal(f.outputs.length, 4); assert.ok(f.outputs.every(output => output.untrusted_data && !output.isError));
  assert.equal(f.outputs[0].result.scan.ignore.enabled, true);
  assert.ok(!f.outputs[0].result.files.some(file => file.path.startsWith('other')));
  assert.ok(f.outputs[1].result.files.some(file => file.path === 'other/ignored.txt'));
  assert.equal(f.outputs[1].result.scan.ignore.enabled, false);
  assert.ok(!f.outputs[2].result.matches.some(file => file.path.startsWith('other')));
  assert.ok(f.outputs[3].result.matches.some(file => file.path === 'other/ignored.txt'));
  assert.ok(!JSON.stringify(f.outputs).includes('PRIVATE_SCAN_SECRET'));
  assert.ok(!f.outputs[3].result.matches.some(file => file.path.startsWith('node_modules/')));
});

test('model tools accept omitted or explicit scan options and return scoped metadata in untrusted tool context', async t => {
  const f = await fixture(t, { calls: [
    call('list_workspace', {}, 1),
    call('list_workspace', { path: 'src' }, 2),
    call('search_files', { query: 'needle', path: 'src', includeGenerated: false }, 3),
    call('search_files', { query: 'needle', includeGenerated: true }, 4),
    call('list_workspace', { path: 'node_modules' }, 5),
  ] });
  await f.run();
  assert.equal(f.outputs.length, 5); assert.ok(f.outputs.every(output => output.untrusted_data && !output.isError));
  assert.deepEqual(f.schemas.find(tool => tool.name === 'list_workspace').parameters.required, []);
  assert.deepEqual(f.schemas.find(tool => tool.name === 'search_files').parameters.required, ['query']);
  assert.equal(f.schemas.find(tool => tool.name === 'search_files').parameters.properties.caseSensitive.type, 'boolean');
  assert.equal(f.schemas.find(tool => tool.name === 'search_files').parameters.properties.includeIgnored.type, 'boolean');
  assert.equal(f.schemas.find(tool => tool.name === 'list_workspace').parameters.properties.includeIgnored.type, 'boolean');
  const [root, scoped, searched, expanded, dependency] = f.outputs.map(output => output.result);
  assert.equal(root.scope, ''); assert.equal(root.scan.projectMode, true); assert.equal(root.scan.excludedDirectories, 1);
  assert.ok(!root.files.some(file => file.path.startsWith('node_modules/')));
  assert.equal(scoped.scope, 'src'); assert.deepEqual(scoped.files.map(file => file.path), ['src/main.txt']);
  assert.equal(searched.scope, 'src'); assert.equal(searched.searchedFiles, 1); assert.equal(searched.truncated, false);
  assert.equal(searched.version, 1); assert.equal(searched.caseSensitive, false);
  assert.deepEqual(searched.matches.map(match => match.path), ['src/main.txt']);
  assert.equal(expanded.scan.includeGenerated, true); assert.equal(expanded.scan.excludedDirectories, 0);
  assert.deepEqual(expanded.matches.map(match => match.path).sort(), ['node_modules/dependency.txt', 'other/ignored.txt', 'src/main.txt']);
  assert.equal(dependency.scope, 'node_modules'); assert.deepEqual(dependency.files.map(file => file.path), ['node_modules/dependency.txt']);
  assert.doesNotMatch(JSON.stringify(f.outputs), /PRIVATE_SCAN_SECRET/);
  assert.equal(f.get().approvals.length, 0);
});

test('model search casing is explicitly selectable and invalid casing arguments never invoke the workspace', async t => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({ query: 'needle' }, 'caseSensitive', { enumerable: true, get() { getterCalls++; return true; } });
  const f = await fixture(t, { calls: [
    call('search_files', { query: 'NEEDLE', path: 'src' }, 1),
    call('search_files', { query: 'NEEDLE', path: 'src', caseSensitive: true }, 2),
    call('search_files', { query: 'needle', path: 'src', caseSensitive: true }, 3),
    call('search_files', { query: 'needle', caseSensitive: 'false' }, 4),
    call('search_files', { query: 'needle', caseSensitive: null }, 5),
    call('search_files', accessor, 6),
  ] });
  await f.run();
  assert.equal(f.outputs.length, 6);
  assert.equal(f.outputs[0].result.caseSensitive, false); assert.equal(f.outputs[0].result.matches.length, 1);
  assert.equal(f.outputs[1].result.caseSensitive, true); assert.deepEqual(f.outputs[1].result.matches, []);
  assert.equal(f.outputs[2].result.caseSensitive, true); assert.equal(f.outputs[2].result.matches.length, 1);
  const preview = await createWorkspace(f.root, { createRoot: false }).read('src/main.txt');
  assert.equal(f.outputs[2].result.matches[0].sha256, preview.sha256);
  assert.equal(f.outputs[2].result.matches[0].text, 'needle source');
  assert.equal(f.outputs[2].result.matches[0].matchStart, 0); assert.equal(f.outputs[2].result.matches[0].matchEnd, 6);
  assert.ok(f.outputs.slice(3).every(output => output.isError && output.error.code === 'INVALID_TOOL_ARGUMENTS'));
  assert.deepEqual(f.touches, ['search', 'search', 'search']); assert.equal(getterCalls, 0);
  assert.equal(f.get().approvals.length, 0);
});

test('invalid optional tool arguments are rejected before workspace access or getter evaluation', async t => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'path', { enumerable: true, get() { getterCalls++; return 'src'; } });
  const f = await fixture(t, { calls: [
    call('list_workspace', { includeGenerated: 'true' }, 1),
    call('list_workspace', { path: null }, 2),
    call('list_workspace', { includeGenerated: undefined }, 3),
    call('list_workspace', { maxFiles: 100000 }, 4),
    call('search_files', { path: 'src' }, 5),
    call('search_files', { query: 'needle', includeGenerated: 1 }, 6),
    call('search_files', { query: 'needle', denySensitivePaths: false }, 7),
    call('list_workspace', accessor, 8),
  ] });
  await f.run();
  assert.equal(f.outputs.length, 8);
  assert.ok(f.outputs.every(output => output.isError && output.error.code === 'INVALID_TOOL_ARGUMENTS'));
  assert.deepEqual(f.touches, []); assert.equal(getterCalls, 0); assert.equal(f.get().approvals.length, 0);
});

test('model scan scope and generated inclusion cannot bypass sensitive paths or workspace boundary', async t => {
  const f = await fixture(t, { calls: [
    call('list_workspace', { path: '.git', includeGenerated: true }, 1),
    call('search_files', { query: 'PRIVATE_SCAN_SECRET', path: '.git', includeGenerated: true }, 2),
    call('list_workspace', { path: '../', includeGenerated: true }, 3),
    call('search_files', { query: 'PRIVATE_SCAN_SECRET', includeGenerated: true }, 4),
  ] });
  await f.run();
  assert.equal(f.outputs[0].error.code, 'SENSITIVE_PATH'); assert.equal(f.outputs[1].error.code, 'SENSITIVE_PATH');
  assert.ok(f.outputs[2].isError); assert.deepEqual(f.outputs[3].result.matches, []);
  assert.ok(f.outputs[3].result.scan.skippedEntries >= 2);
  assert.equal(await fs.readFile(path.join(f.root, '.env'), 'utf8'), 'PRIVATE_SCAN_SECRET');
  assert.equal(f.get().approvals.length, 0);
});

test('local demo reports filtered discovery without presenting the entire project as inspected', async t => {
  const f = await fixture(t, { demo: true }); await f.run();
  const text = f.get().messages.at(-1).content;
  assert.match(text, /当前文件列表/); assert.match(text, /略过 1 个依赖或构建目录入口/);
  assert.doesNotMatch(text, /已扫描工作区|PRIVATE_SCAN_SECRET|node_modules\/dependency/);
  assert.equal(f.get().approvals.length, 0);
});
