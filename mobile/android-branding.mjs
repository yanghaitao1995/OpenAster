// SPDX-License-Identifier: Apache-2.0
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const namespace = 'http://schemas.android.com/apk/res/android';
const xmlHeader = '<?xml version="1.0" encoding="utf-8"?>\n';

/** Translate the original architectural A into Android vectors without a raster toolchain. */
export function androidBrandResources(svg) {
  const knownSvg = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="([0-9.]+)" fill="(#[0-9a-f]{6})"\/><path d="M([0-9. ]+)Z M([0-9. ]+)Z" fill="(#[0-9a-f]{6})" fill-rule="evenodd"\/><\/svg>$/i;
  const match = svg.trim().match(knownSvg);
  if (!match) throw new Error('Unknown original icon SVG; review Android vector conversion before continuing');
  const [, radiusText, background, outline, aperture, foreground] = match;
  const radius = Number(radiusText), polygons = [outline, aperture].map(contour => contour.trim().split(/\s+/).map(Number));
  if (!Number.isFinite(radius) || radius <= 0 || radius > 32 || polygons.some(numbers => numbers.length < 6 || numbers.length > 128 || numbers.length % 2 || numbers.some(number => !Number.isFinite(number) || number < 0 || number > 64))) {
    throw new Error('Unsupported icon geometry');
  }
  const mark = offset => polygons.map(numbers => numbers.reduce((output, number, index) =>
    output + (index % 2 ? ',' : index ? ' L' : 'M') + Number((number + offset).toFixed(4)), '') + ' Z').join(' ');
  const vector = (viewport, content) => `${xmlHeader}<vector xmlns:android="${namespace}" android:width="${viewport}dp" android:height="${viewport}dp" android:viewportWidth="${viewport}" android:viewportHeight="${viewport}">\n${content}\n</vector>\n`;
  const legacy = vector(64, `    <path android:fillColor="${background}" android:pathData="M${radius},0 H${64-radius} Q64,0 64,${radius} V${64-radius} Q64,64 ${64-radius},64 H${radius} Q0,64 0,${64-radius} V${radius} Q0,0 ${radius},0 Z" />\n    <path android:fillColor="${foreground}" android:fillType="evenOdd" android:pathData="${mark(0)}" />`);
  const foregroundVector = vector(108, `    <path android:fillColor="${foreground}" android:fillType="evenOdd" android:pathData="${mark(22)}" />`);
  const monochrome = vector(108, `    <path android:fillColor="#FFFFFF" android:fillType="evenOdd" android:pathData="${mark(22)}" />`);
  const adaptive = `${xmlHeader}<adaptive-icon xmlns:android="${namespace}">\n    <background android:drawable="@color/ic_launcher_background" />\n    <foreground android:drawable="@drawable/openaster_launcher_foreground" />\n    <monochrome android:drawable="@drawable/openaster_launcher_monochrome" />\n</adaptive-icon>\n`;
  return {
    'mipmap-anydpi/ic_launcher.xml': legacy,
    'mipmap-anydpi/ic_launcher_round.xml': legacy,
    'mipmap-anydpi-v26/ic_launcher.xml': adaptive,
    'mipmap-anydpi-v26/ic_launcher_round.xml': adaptive,
    'drawable/openaster_launcher_foreground.xml': foregroundVector,
    'drawable/openaster_launcher_monochrome.xml': monochrome,
    'drawable/splash.xml': `${xmlHeader}<layer-list xmlns:android="${namespace}">\n    <item><shape android:shape="rectangle"><solid android:color="${background}" /></shape></item>\n    <item android:width="108dp" android:height="108dp" android:gravity="center" android:drawable="@drawable/openaster_launcher_foreground" />\n</layer-list>\n`,
    'values/ic_launcher_background.xml': `${xmlHeader}<resources>\n    <color name="ic_launcher_background">${background}</color>\n</resources>\n`,
  };
}

async function checkedResource(root, relative) {
  let current = root;
  for (const part of ['.', ...relative.split('/')]) {
    current = path.join(current, part);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || (metadata.isFile() && metadata.nlink !== 1)) throw new Error('Android icon resources must not contain symbolic links or shared hard links');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

export async function brandAndroidProject(projectDirectory) {
  const source = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');
  const resources = androidBrandResources(source);
  const resourceRoot = await checkedResource(path.resolve(projectDirectory), 'app/src/main/res');
  const targets = [];
  for (const [relative, content] of Object.entries(resources)) targets.push([await checkedResource(resourceRoot, relative), content]);
  // Generated Capacitor bitmap launchers must not retain a template identity.
  const obsolete = [];
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
      obsolete.push(await checkedResource(resourceRoot, `mipmap-${density}/${name}.png`));
    }
    for (const orientation of ['land', 'port']) obsolete.push(await checkedResource(resourceRoot, `drawable-${orientation}-${density}/splash.png`));
  }
  for (const relative of ['drawable/splash.png', 'drawable-v24/ic_launcher_foreground.xml', 'drawable/ic_launcher_background.xml']) obsolete.push(await checkedResource(resourceRoot, relative));
  for (const [file, content] of targets) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  for (const file of obsolete) {
    try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { source: 'public/icon.svg', vectorResources: Object.keys(resources).length };
}
