// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createSkillRegistry, initializeSkillDirectory, skillCatalogPrompt, DEFAULT_SKILLS_ROOT, SKILL_LIMITS } from '../core/skills.mjs';

const source = (body = 'PRIVATE-BODY', header = 'name: Test skill\ndescription: Use when reviewing code.\nicon: code') => `---\n${header}\n---\n\n${body}`;
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-skills-'));
  const skillsRoot = path.join(root, 'skills'); await fs.mkdir(skillsRoot);
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^openaster-skills-[\w-]+$/u); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  async function put(id, text = source()) { await fs.mkdir(path.join(skillsRoot, id), { recursive: true }); await fs.writeFile(path.join(skillsRoot, id, 'SKILL.md'), text); }
  return { root, skillsRoot, put, registry: createSkillRegistry(skillsRoot) };
}

test('catalog exposes metadata only; body and resources are read on demand with provenance', async t => {
  const f = await fixture(t); await f.put('review');
  await fs.mkdir(path.join(f.skillsRoot, 'review', 'references'));
  await fs.writeFile(path.join(f.skillsRoot, 'review', 'references', 'guide.md'), 'PRIVATE-RESOURCE');
  const catalog = await f.registry.catalog();
  assert.deepEqual(catalog, [{ id: 'review', name: 'Test skill', description: 'Use when reviewing code.', icon: 'code', relativePath: 'skills/review/SKILL.md' }]);
  const prompt = skillCatalogPrompt([{ ...catalog[0], content: 'BODY-INJECTION', prompt: 'PROMPT-INJECTION' }], 'review');
  assert.doesNotMatch(prompt, /PRIVATE-BODY|PRIVATE-RESOURCE|BODY-INJECTION|PROMPT-INJECTION/u);
  assert.match(prompt, /load_skill/u);
  const loaded = await f.registry.load('review'); assert.match(loaded.content, /PRIVATE-BODY/u); assert.equal(loaded.untrusted, true);
  assert.equal(loaded.sha256, createHash('sha256').update(loaded.content).digest('hex'));
  const resource = await f.registry.readResource('review', 'references/guide.md');
  assert.equal(resource.content, 'PRIVATE-RESOURCE'); assert.equal(resource.relativePath, 'skills/review/references/guide.md');
  await f.put('review', source('UPDATED-BODY'));
  assert.match((await f.registry.load('review')).content, /UPDATED-BODY/u);
});

test('catalog does not decode body or load resources during discovery', async t => {
  const f = await fixture(t);
  await f.put('review', Buffer.concat([Buffer.from(source('')), Buffer.from([0xff, 0x00])]));
  assert.equal((await f.registry.catalog())[0].id, 'review');
  await assert.rejects(f.registry.load('review'), { code: 'SKILL_TEXT_INVALID' });
});

test('frontmatter supports UTF-8 BOM, CRLF, quotes, block descriptions and closing delimiter at EOF', async t => {
  const f = await fixture(t);
  await f.put('quoted', '\ufeff---\r\nname: "代码审阅"\r\ndescription: >-\r\n  Inspect changes\r\n  with evidence.\r\nicon: unknown\r\n---');
  await f.put('single', source('', "name: 'A ''quoted'' name'\ndescription: |\n  First line\n  Second line"));
  const catalog = await f.registry.catalog();
  assert.equal(catalog[0].name, '代码审阅'); assert.equal(catalog[0].description, 'Inspect changes with evidence.'); assert.equal(catalog[0].icon, 'sparkles');
  assert.equal(catalog[1].name, "A 'quoted' name"); assert.equal(catalog[1].description, 'First line\nSecond line');
});

test('invalid metadata, duplicate fields and missing required display fields are rejected', async t => {
  const f = await fixture(t);
  for (const header of ['name: test', 'name: test\ndescription: one\ndescription: two', 'name: "bad\ndescription: value', 'name: test\ndescription: true\n  nested: invalid', `name: test\ndescription: ${'x'.repeat(1001)}`]) {
    await f.put('review', source('', header));
    await assert.rejects(f.registry.catalog(), { code: 'SKILL_METADATA_INVALID' });
  }
});

test('unknown metadata does not grant tool permissions and missing skill folders are ignored', async t => {
  const f = await fixture(t); await f.put('review', source('', 'name: Review\ndescription: Code review\npermissions: all\nautoApprove: yes'));
  await fs.mkdir(path.join(f.skillsRoot, 'empty')); await fs.writeFile(path.join(f.skillsRoot, 'README.md'), 'not a skill');
  const catalog = await f.registry.catalog(); assert.equal(catalog.length, 1); assert.equal(catalog[0].permissions, undefined);
  assert.throws(() => skillCatalogPrompt(catalog, 'missing'), { code: 'SKILL_NOT_FOUND' });
});

test('catalog and full reads have separate bounded limits', async t => {
  const f = await fixture(t); await f.put('review', source('x'.repeat(SKILL_LIMITS.fileBytes)));
  assert.equal((await f.registry.catalog()).length, 1);
  await assert.rejects(f.registry.load('review'), { code: 'SKILL_FILE_TOO_LARGE' });
  await f.put('review', source('', 'name: test\n#' + 'x'.repeat(SKILL_LIMITS.metadataBytes) + '\ndescription: test'));
  await assert.rejects(f.registry.catalog(), { code: 'SKILL_METADATA_INVALID' });
});

test('resource paths cannot traverse into another skill, use absolute paths or access known sensitive files', async t => {
  const f = await fixture(t); await f.put('review'); await f.put('other', source('OTHER-PRIVATE'));
  for (const value of ['../other/SKILL.md', '/outside.txt', 'C:/outside.txt', 'references\\outside.txt', './SKILL.md', 'references/%2e%2e/outside']) await assert.rejects(f.registry.readResource('review', value), { code: 'INVALID_PATH' });
  for (const value of ['.env', 'private.key', '.ssh/id_rsa', '.openaster-data/config.json']) await assert.rejects(f.registry.readResource('review', value), { code: 'SKILL_RESOURCE_DENIED' });
  await assert.rejects(f.registry.load('../other'), { code: 'INVALID_SKILL' });
  await assert.rejects(f.registry.load('missing'), { code: 'SKILL_NOT_FOUND' });
});

test('directory junctions and linked skill roots are rejected without disclosing outside content', async t => {
  const f = await fixture(t); await f.put('review'); const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.md'), 'OUTSIDE-CONTENT');
  const linked = path.join(f.skillsRoot, 'review', 'linked');
  try { await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory link creation is unavailable'); return; } throw error; }
  await assert.rejects(f.registry.readResource('review', 'linked/secret.md'), { code: 'UNSAFE_SKILL_PATH' });
  await fs.symlink(f.skillsRoot, path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createSkillRegistry(path.join(f.root, 'alias')).catalog(), { code: 'UNSAFE_SKILL_PATH' });
});

test('hardlinked skill files and resources are rejected', async t => {
  const f = await fixture(t); await f.put('review'); await fs.writeFile(path.join(f.root, 'outside.txt'), 'OUTSIDE-CONTENT');
  await fs.link(path.join(f.root, 'outside.txt'), path.join(f.skillsRoot, 'review', 'linked.txt'));
  await assert.rejects(f.registry.readResource('review', 'linked.txt'), { code: 'UNSAFE_SKILL_PATH' });
  await fs.link(path.join(f.skillsRoot, 'review', 'SKILL.md'), path.join(f.root, 'linked-skill.md'));
  await assert.rejects(f.registry.catalog(), { code: 'UNSAFE_SKILL_PATH' });
});

test('registry pins root identity and rejects replacement', async t => {
  const f = await fixture(t); await f.put('review'); await f.registry.catalog();
  await fs.rename(f.skillsRoot, path.join(f.root, 'previous-skills')); await fs.mkdir(f.skillsRoot); await f.put('review', source('REPLACED'));
  await assert.rejects(f.registry.load('review'), { code: 'SKILLS_CHANGED' });
});

test('cancelled discovery, full load and resource reads stop before returning content', async t => {
  const f = await fixture(t); await f.put('review'); const signal = AbortSignal.abort();
  await assert.rejects(f.registry.catalog({ signal }), { code: 'CANCELLED' });
  await assert.rejects(f.registry.load('review', { signal }), { code: 'CANCELLED' });
  await assert.rejects(f.registry.readResource('review', 'SKILL.md', { signal }), { code: 'CANCELLED' });
});

test('six migrated built-in skill ids remain compatible and all content lives under ./skills', async () => {
  const registry = createSkillRegistry(DEFAULT_SKILLS_ROOT), catalog = await registry.catalog();
  assert.deepEqual(catalog.map(skill => skill.id).sort(), ['code', 'general', 'planning', 'research', 'translation', 'writing']);
  for (const entry of catalog) { assert.equal(entry.prompt, undefined); assert.equal(entry.content, undefined); assert.equal((await registry.load(entry.id)).relativePath, `skills/${entry.id}/SKILL.md`); }
  assert.doesNotMatch((await registry.load('code')).content, /不能运行终端/u);
});

test('first initialization creates one editable ./skills directory with exact built-in resources', async t => {
  const f = await fixture(t); const workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace); const target = path.join(workspace, 'skills');
  const result = await initializeSkillDirectory(DEFAULT_SKILLS_ROOT, target); assert.equal(result.initialized, true); assert.equal(result.files, 7);
  const registry = createSkillRegistry(target); assert.equal((await registry.catalog()).length, 6);
  for (const entry of await registry.catalog()) assert.equal((await registry.load(entry.id)).sha256, (await createSkillRegistry().load(entry.id)).sha256);
  assert.equal((await registry.readResource('code', 'references/verification.md')).sha256, (await createSkillRegistry().readResource('code', 'references/verification.md')).sha256);
});

test('existing empty or customized skill directories are never populated, merged or overwritten', async t => {
  const f = await fixture(t);
  assert.deepEqual(await initializeSkillDirectory(DEFAULT_SKILLS_ROOT, f.skillsRoot), { initialized: false, path: f.skillsRoot, files: 0 });
  assert.deepEqual(await fs.readdir(f.skillsRoot), []);
  await f.put('review', source('USER-EDIT'));
  const before = await fs.readFile(path.join(f.skillsRoot, 'review', 'SKILL.md'));
  assert.equal((await initializeSkillDirectory(DEFAULT_SKILLS_ROOT, f.skillsRoot)).initialized, false);
  assert.deepEqual(await fs.readdir(f.skillsRoot), ['review']); assert.deepEqual(await fs.readFile(path.join(f.skillsRoot, 'review', 'SKILL.md')), before);
});

test('invalid source or linked target causes no partial destination or writes outside the workspace', async t => {
  const f = await fixture(t); await f.put('review'); const workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace); const target = path.join(workspace, 'skills');
  await fs.writeFile(path.join(f.skillsRoot, 'review', 'private.key'), 'PRIVATE-KEY-FIXTURE');
  await assert.rejects(initializeSkillDirectory(f.skillsRoot, target), { code: 'SKILL_RESOURCE_DENIED' });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' }); assert.deepEqual(await fs.readdir(workspace), []);
  const external = path.join(f.root, 'external'); await fs.mkdir(external);
  try { await fs.symlink(external, target, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory link creation is unavailable'); return; } throw error; }
  await assert.rejects(initializeSkillDirectory(DEFAULT_SKILLS_ROOT, target), { code: 'UNSAFE_SKILL_PATH' });
  assert.deepEqual(await fs.readdir(external), []);
});

test('concurrent initializers preserve the first owner and produce one complete directory', async t => {
  const f = await fixture(t); const workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace); const target = path.join(workspace, 'skills');
  const results = await Promise.all([initializeSkillDirectory(DEFAULT_SKILLS_ROOT, target), initializeSkillDirectory(DEFAULT_SKILLS_ROOT, target)]);
  assert.equal(results.filter(result => result.initialized).length, 1); assert.equal((await createSkillRegistry(target).catalog()).length, 6);
});

test('a real partial initialization write failure removes only the unchanged tree created by that attempt', async t => {
  const f = await fixture(t); const workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace); const target = path.join(workspace, 'skills');
  const probe = await fs.open(path.join(f.root, 'probe.txt'), 'wx'), prototype = Object.getPrototypeOf(probe), original = prototype.writeFile; await probe.close();
  let injected = false;
  t.mock.method(prototype, 'writeFile', async function (buffer, ...rest) {
    if (injected) return original.call(this, buffer, ...rest);
    injected = true; await original.call(this, buffer.subarray(0, 4), ...rest); throw new Error('Injected partial write failure');
  });
  await assert.rejects(initializeSkillDirectory(DEFAULT_SKILLS_ROOT, target), /Injected partial write failure/u);
  assert.equal(injected, true); await assert.rejects(fs.stat(target), { code: 'ENOENT' }); assert.deepEqual(await fs.readdir(workspace), []);
});

test('initialization cleanup preserves files introduced by another actor after creation', async t => {
  const f = await fixture(t); const workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace); const target = path.join(workspace, 'skills');
  const probe = await fs.open(path.join(f.root, 'probe.txt'), 'wx'), prototype = Object.getPrototypeOf(probe), original = prototype.writeFile; await probe.close();
  let injected = false;
  t.mock.method(prototype, 'writeFile', async function (buffer, ...rest) {
    if (injected) return original.call(this, buffer, ...rest);
    injected = true; await original.call(this, buffer, ...rest); await fs.writeFile(path.join(target, 'keep.txt'), 'OTHER-ACTOR-FIXTURE'); throw new Error('Injected subsequent failure');
  });
  await assert.rejects(initializeSkillDirectory(DEFAULT_SKILLS_ROOT, target), { code: 'SKILL_INITIALIZATION_INCOMPLETE' });
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'OTHER-ACTOR-FIXTURE');
});
