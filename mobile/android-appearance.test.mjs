import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rmdir, link, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { synchronizeAndroidAppearance } from './android-appearance.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(here);
const mainPath = 'app/src/main/java/org/openaster/preview/MainActivity.java';
const originalMain = 'package org.openaster.preview;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n';
async function findJavaTools({ javaHome, toolchains }) {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const candidates = javaHome ? [path.join(javaHome, 'bin')] : [];
  let entries;
  try { entries = await readdir(toolchains); }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
  candidates.push(...entries.filter(name => name.startsWith('jdk-')).sort().reverse().map(name => path.join(toolchains, name, 'bin')));
  for (const bin of candidates) {
    const javac = path.join(bin, 'javac' + extension), java = path.join(bin, 'java' + extension);
    try { if ((await stat(javac)).isFile() && (await stat(java)).isFile()) return { javac, java }; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return null;
}
async function fixture(t) {
  const parent = path.join(project, 'test-results');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'android-appearance-'));
  t.after(async () => { assert.ok(root.startsWith(parent + path.sep)); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.dirname(path.join(root, mainPath)), { recursive: true });
  await writeFile(path.join(root, mainPath), originalMain);
  return root;
}

test('appearance generation is deterministic after repeat sync and a regenerated original MainActivity', async t => {
  const root = await fixture(t);
  const first = await synchronizeAndroidAppearance(root);
  assert.equal(first.plugin, 'OpenAsterAppearance');
  const contents = await Promise.all(first.files.map(file => readFile(path.join(root, file), 'utf8')));
  assert.deepEqual(await synchronizeAndroidAppearance(root), first);
  assert.deepEqual(await Promise.all(first.files.map(file => readFile(path.join(root, file), 'utf8'))), contents);
  await writeFile(path.join(root, mainPath), originalMain.replaceAll('\n', '\r\n'));
  await synchronizeAndroidAppearance(root);
  assert.deepEqual(await Promise.all(first.files.map(file => readFile(path.join(root, file), 'utf8'))), contents);
});

test('unknown MainActivity is refused without adding native files', async t => {
  const root = await fixture(t);
  const unknown = originalMain.replace('{}', '{ /* app-owned changes */ }');
  await writeFile(path.join(root, mainPath), unknown);
  await assert.rejects(synchronizeAndroidAppearance(root), /Unknown Android MainActivity/);
  assert.equal(await readFile(path.join(root, mainPath), 'utf8'), unknown);
  assert.deepEqual(await readdir(path.dirname(path.join(root, mainPath))), ['MainActivity.java']);
});

test('an unknown late resource refuses the entire appearance sync before changing MainActivity', async t => {
  const root = await fixture(t);
  const target = path.join(root, 'app/src/main/res/values/openaster_appearance.xml');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, '<resources><style name="Other" /></resources>');
  await assert.rejects(synchronizeAndroidAppearance(root), /Unknown Android openaster_appearance.xml/);
  assert.equal(await readFile(path.join(root, mainPath), 'utf8'), originalMain);
  assert.deepEqual(await readdir(path.dirname(path.join(root, mainPath))), ['MainActivity.java']);
});

test('unknown plugin contents cannot be overwritten by repeated synchronization', async t => {
  const root = await fixture(t);
  const { files } = await synchronizeAndroidAppearance(root);
  const plugin = path.join(root, files.find(file => file.endsWith('/OpenAsterAppearance.java')));
  const unknown = (await readFile(plugin, 'utf8')) + '\n// unexpected local change\n';
  await writeFile(plugin, unknown);
  await writeFile(path.join(root, mainPath), originalMain);
  await assert.rejects(synchronizeAndroidAppearance(root), /Unknown Android OpenAsterAppearance.java/);
  assert.equal(await readFile(plugin, 'utf8'), unknown);
  assert.equal(await readFile(path.join(root, mainPath), 'utf8'), originalMain);
});

test('a missing MainActivity is not silently invented', async t => {
  const root = await fixture(t);
  await rm(path.join(root, mainPath));
  await assert.rejects(synchronizeAndroidAppearance(root), /Expected the generated MainActivity/);
  assert.deepEqual(await readdir(path.dirname(path.join(root, mainPath))), []);
});

test('appearance rejects file parent paths and non-regular targets', async t => {
  const root = await fixture(t);
  const plugin = path.join(root, 'app/src/main/java/org/openaster/preview/AppearanceController.java');
  await mkdir(plugin);
  await assert.rejects(synchronizeAndroidAppearance(root), /regular single-link file/);
  assert.equal(await readFile(path.join(root, mainPath), 'utf8'), originalMain);
  await rmdir(plugin);
  await writeFile(path.join(root, 'app/src/main/res'), 'not a directory');
  await assert.rejects(synchronizeAndroidAppearance(root), /parent must be a directory/);
  assert.equal(await readFile(path.join(root, mainPath), 'utf8'), originalMain);
});

test('appearance never writes through a hard-linked target', async t => {
  const root = await fixture(t);
  const original = path.join(root, 'original.java');
  await writeFile(original, originalMain);
  await rm(path.join(root, mainPath));
  await link(original, path.join(root, mainPath));
  await assert.rejects(synchronizeAndroidAppearance(root), /regular single-link file/);
  assert.equal(await readFile(original, 'utf8'), originalMain);
});

test('native enum policy accepts only exact light/dark values and uses fixed matching colors', async t => {
  const root = await fixture(t);
  const tools = await findJavaTools({ javaHome: process.env.JAVA_HOME, toolchains: path.join(project, '.toolchains') });
  if (!tools) return t.skip('A JDK in JAVA_HOME or project .toolchains is required for this pure Java enum contract test; no tool is downloaded');
  const check = path.join(root, 'AppearanceThemeCheck.java');
  await writeFile(check, `package org.openaster.preview;
public class AppearanceThemeCheck {
  public static void main(String[] args) {
    for (Object value : new Object[]{null, "", "DARK", " dark", "light ", "#ffffff", 1, false, new Object()}) {
      try { AppearanceTheme.requireTheme(value); throw new AssertionError("accepted invalid input"); }
      catch (IllegalArgumentException expected) {}
    }
    if (!AppearanceTheme.requireTheme("light").equals("light") || !AppearanceTheme.requireTheme("dark").equals("dark")) throw new AssertionError();
    if (AppearanceTheme.background("light") != 0xffffffff || AppearanceTheme.background("dark") != 0xff1c1c1e) throw new AssertionError();
    if (!AppearanceTheme.savedTheme(null).equals("light") || !AppearanceTheme.savedTheme("invalid").equals("light") || !AppearanceTheme.savedTheme("dark").equals("dark")) throw new AssertionError();
    System.out.println("Exact enum, fixed colors and missing/invalid mirror behavior passed");
  }
}\n`);
  const options = { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 };
  await exec(tools.javac, ['-d', root, path.join(here, 'android-appearance/AppearanceTheme.java'), check], options);
  const result = await exec(tools.java, ['-cp', root, 'org.openaster.preview.AppearanceThemeCheck'], options);
  assert.match(result.stdout, /Exact enum, fixed colors/);
});

test('Java discovery permits a clean checkout without local toolchains', async t => {
  const root = await fixture(t);
  assert.equal(await findJavaTools({ toolchains: path.join(root, 'absent') }), null);
});

test('Java discovery uses JAVA_HOME when project toolchains are absent and requires both tools', async t => {
  const root = await fixture(t), javaHome = path.join(root, 'ci-jdk'), bin = path.join(javaHome, 'bin');
  const extension = process.platform === 'win32' ? '.exe' : '';
  await mkdir(bin, { recursive: true });
  const javac = path.join(bin, 'javac' + extension), java = path.join(bin, 'java' + extension);
  await writeFile(javac, 'discovery fixture only; never executed');
  assert.equal(await findJavaTools({ javaHome, toolchains: path.join(root, 'absent') }), null);
  await writeFile(java, 'discovery fixture only; never executed');
  assert.deepEqual(await findJavaTools({ javaHome, toolchains: path.join(root, 'absent') }), { javac, java });
});
