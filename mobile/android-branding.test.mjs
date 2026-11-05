import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { androidBrandResources, brandAndroidProject } from './android-branding.mjs';

const originalIcon = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');

test('Android launcher vectors preserve the original architectural A and provide legacy, adaptive and monochrome icons', () => {
  const fills=[...originalIcon.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map(match=>match[1]);
  const paletteFixture=originalIcon.replaceAll(fills[0],'#112233').replaceAll(fills[1],'#445566');
  const resources = androidBrandResources(paletteFixture);
  assert.equal(Object.keys(resources).length, 8);
  assert.match(resources['mipmap-anydpi/ic_launcher.xml'], /#112233/);
  assert.match(resources['mipmap-anydpi/ic_launcher.xml'], /#445566/);
  assert.match(resources['mipmap-anydpi-v26/ic_launcher.xml'], /<monochrome android:drawable="@drawable\/openaster_launcher_monochrome"/);
  assert.match(resources['drawable/openaster_launcher_foreground.xml'], /viewportWidth="108"/);
  assert.match(resources['drawable/openaster_launcher_monochrome.xml'], /fillType="evenOdd"/);
  assert.match(resources['drawable/openaster_launcher_foreground.xml'], /M36,72 L49,36 L59,36/);
  assert.match(resources['drawable/splash.xml'], /android:gravity="center" android:drawable="@drawable\/openaster_launcher_foreground"/);
});

test('Android vector conversion refuses unsupported SVG and invalid geometry', () => {
  assert.throws(() => androidBrandResources('<svg><image href="https://remote.example/icon.png" /></svg>'), /Unknown original icon/);
  assert.throws(() => androidBrandResources(originalIcon.replace('M14 50', 'M99 50')), /Unsupported icon geometry/);
  assert.throws(() => androidBrandResources(originalIcon.replace(/rx="[0-9.]+"/, 'rx="200"')), /Unsupported icon geometry/);
});

test('Android branding removes template bitmap icons and survives repeated native sync', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openaster-branding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldIcon = path.join(directory, 'app/src/main/res/mipmap-mdpi/ic_launcher.png');
  const oldSplash = path.join(directory, 'app/src/main/res/drawable-land-hdpi/splash.png');
  await mkdir(path.dirname(oldIcon), { recursive: true });
  await mkdir(path.dirname(oldSplash), { recursive: true });
  await writeFile(oldIcon, 'generated template');
  await writeFile(oldSplash, 'generated splash template');
  await brandAndroidProject(directory);
  await assert.rejects(access(oldIcon), { code: 'ENOENT' });
  await assert.rejects(access(oldSplash), { code: 'ENOENT' });
  const adaptive = path.join(directory, 'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml');
  const expected = await readFile(adaptive, 'utf8');
  await writeFile(adaptive, 'regenerated template');
  await brandAndroidProject(directory);
  assert.equal(await readFile(adaptive, 'utf8'), expected);
});
