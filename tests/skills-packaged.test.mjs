// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const packagingRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const asar = packagingRequire('@electron/asar');
// The package entry point can download Electron on require(). Tests only use an
// already installed runtime; dependency installation belongs before the tests.
const electronPackage = path.dirname(require.resolve('electron/package.json'));
const electronPathFile = path.join(electronPackage, 'path.txt');
assert.ok(existsSync(electronPathFile), 'Install the Electron runtime before testing: node node_modules/electron/install.js');
const electronRelative = readFileSync(electronPathFile, 'utf8').trim();
assert.ok(['electron', 'electron.exe', 'Electron.app/Contents/MacOS/Electron'].includes(electronRelative), 'Unexpected installed Electron executable path');
const electron = path.join(electronPackage, 'dist', electronRelative);
assert.ok(existsSync(electron), 'Install the Electron runtime before testing: node node_modules/electron/install.js');
const execute = promisify(execFile);
const moduleFiles = ['skills.mjs', 'workspace.mjs', 'workspace-search.mjs', 'workspace-ignore.mjs', 'sensitive-paths.mjs', 'errors.mjs'];

async function fixture(t) {
  const parent = await fs.realpath(tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'openaster-skills-asar-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    assert.match(path.basename(directory), /^openaster-skills-asar-[\w-]+$/u);
    assert.equal(await fs.realpath(directory), directory);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = path.join(directory, 'source');
  await fs.mkdir(path.join(source, 'core'), { recursive: true });
  await fs.mkdir(path.join(source, 'server'));
  await fs.writeFile(path.join(source, 'package.json'), '{"type":"module"}\n');
  for (const file of moduleFiles) await fs.copyFile(path.join(root, 'core', file), path.join(source, 'core', file));
  await fs.copyFile(path.join(root, 'server/skills.mjs'), path.join(source, 'server/skills.mjs'));
  await fs.cp(path.join(root, 'skills'), path.join(source, 'skills'), { recursive: true, errorOnExist: true, force: false });
  const probe = path.join(directory, 'probe.mjs');
  await fs.writeFile(probe, `
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [application, expectedRoot, workspace, expectedError] = process.argv.slice(2);
try {
  const { skills } = await import(pathToFileURL(path.join(application, 'server/skills.mjs')));
  const { DEFAULT_SKILLS_ROOT, createSkillRegistry, initializeSkillDirectory } = await import(pathToFileURL(path.join(application, 'core/skills.mjs')));
  assert.equal(path.resolve(DEFAULT_SKILLS_ROOT), path.resolve(expectedRoot));
  assert.equal(skills.length, 6);
  const registry = createSkillRegistry();
  assert.deepEqual(await registry.catalog(), await registry.catalog());
  for (const skill of skills) assert.ok((await registry.load(skill.id)).content.length > 0);
  const resource = await registry.readResource('code', 'references/verification.md');
  assert.ok(resource.bytes > 0);
  await fs.mkdir(workspace);
  const target = path.join(workspace, 'skills');
  assert.equal((await initializeSkillDirectory(DEFAULT_SKILLS_ROOT, target)).files, 7);
  const editable = createSkillRegistry(target);
  assert.equal((await editable.catalog()).length, 6);
  assert.equal((await editable.readResource('code', 'references/verification.md')).sha256, resource.sha256);
  await fs.rename(target, path.join(workspace, 'previous-skills'));
  await fs.mkdir(target);
  await assert.rejects(editable.load('code'), { code: 'SKILLS_CHANGED' });
  assert.ok(!expectedError, 'Expected fail-closed missing physical resource error');
  console.log('SKILL_ASAR_RESULT ' + JSON.stringify({ ok: true, electron: process.versions.electron, root: DEFAULT_SKILLS_ROOT, catalog: skills.length, copied: 7, replacementRejected: true }));
} catch (error) {
  if (!expectedError || error.code !== expectedError) throw error;
  console.log('SKILL_ASAR_RESULT ' + JSON.stringify({ expectedError: error.code }));
}
`);
  return { directory, source, probe };
}

async function probe(f, application, expectedRoot, suffix, expectedError) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  const { stdout } = await execute(electron, [f.probe, application, expectedRoot, path.join(f.directory, `workspace-${suffix}`), ...(expectedError ? [expectedError] : [])], {
    env, windowsHide: true, timeout: 20_000, maxBuffer: 128 * 1024,
  });
  const line = stdout.split(/\r?\n/u).find(value => value.startsWith('SKILL_ASAR_RESULT '));
  assert.ok(line, 'Electron did not return the skills probe result');
  return JSON.parse(line.slice('SKILL_ASAR_RESULT '.length));
}

test('real Electron reads packaged skills from physical resources and retains replacement protection', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const config = JSON.parse(await fs.readFile(path.join(root, 'desktop/electron-builder.json'), 'utf8'));
  assert.deepEqual(config.asarUnpack, ['skills/**/*']);
  const archive = path.join(f.directory, 'app.asar');
  await asar.createPackageWithOptions(f.source, archive, { unpack: `**/${config.asarUnpack[0]}` });
  assert.equal(asar.statFile(archive, path.normalize('skills/code/SKILL.md')).unpacked, true);
  assert.ok(!asar.statFile(archive, path.normalize('core/skills.mjs')).unpacked);
  const result = await probe(f, archive, path.join(`${archive}.unpacked`, 'skills'), 'packaged');
  assert.equal(result.ok, true);
  assert.ok(result.electron);
  assert.equal(result.copied, 7);
  assert.equal(result.replacementRejected, true);
});

test('source directories named app.asar or containing that suffix remain ordinary skill roots', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  for (const [index, relative] of ['app.asar', 'parent.app.asar/project', 'app.asar-source'].entries()) {
    const application = path.join(f.directory, 'development', relative);
    await fs.cp(f.source, application, { recursive: true, errorOnExist: true, force: false });
    const result = await probe(f, application, path.join(application, 'skills'), `development-${index}`);
    assert.equal(result.ok, true);
  }
});

test('a packaged application missing physical skill resources fails closed without ASAR fallback', { timeout: 45_000 }, async t => {
  const f = await fixture(t);
  const archive = path.join(f.directory, 'app.asar');
  await asar.createPackage(f.source, archive);
  const result = await probe(f, archive, path.join(`${archive}.unpacked`, 'skills'), 'missing', 'SKILLS_NOT_FOUND');
  assert.equal(result.expectedError, 'SKILLS_NOT_FOUND');
});
