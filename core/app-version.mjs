// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';

// The package manifest is the version authority for the gateway and every shell.
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error('Invalid application version in package.json');
}
export const APP_VERSION = manifest.version;
