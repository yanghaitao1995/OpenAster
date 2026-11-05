// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { updateIOSVersion } from './ios-version.mjs';

const project = ['Debug', 'Release'].map(name => `${name} = {\n CURRENT_PROJECT_VERSION = 9;\n MARKETING_VERSION = 0.1.0;\n PRODUCT_NAME = OpenAster;\n};`).join('\n');
test('iOS Debug and Release take the same release version without changing other settings', () => {
  const updated = updateIOSVersion(project, { version: '0.2.0', buildNumber: 10 });
  assert.equal(updated.match(/MARKETING_VERSION = 0\.2\.0;/g).length, 2);
  assert.equal(updated.match(/CURRENT_PROJECT_VERSION = 10;/g).length, 2);
  assert.equal(updated.replaceAll('0.2.0', '0.1.0').replaceAll('= 10;', '= 9;'), project);
  assert.equal(updateIOSVersion(updated, { version: '0.2.0', buildNumber: 10 }), updated);
});
test('iOS version update refuses downgrades and unexpected native build configurations', () => {
  assert.throws(() => updateIOSVersion(project, { version: '0.2.0', buildNumber: 8 }), /decrease/);
  assert.throws(() => updateIOSVersion(project + project, { version: '0.2.0', buildNumber: 10 }), /custom/);
  assert.throws(() => updateIOSVersion(project, { version: '0.2.0; injected', buildNumber: 10 }), /Invalid/);
});
