// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { APK, assertHostedAndroid, assertPackagedConfiguration, parseHierarchy, selectControl, visibleBounds } from './verify-published-android.mjs';

test('acceptance cannot start against a local host, another repository or another CPU', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'yanghaitao1995/OpenAster' };
  assert.doesNotThrow(() => assertHostedAndroid(env, 'linux', 'x64'));
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'other/project' }]) assert.throws(() => assertHostedAndroid({ ...env, ...patch }, 'linux', 'x64'));
  assert.throws(() => assertHostedAndroid(env, 'win32', 'x64')); assert.throws(() => assertHostedAndroid(env, 'linux', 'arm64'));
});
test('APK policy refuses weakened HTTPS, WebView debugging and a different shared UI', () => {
  const config = { appId: APK.package, server: { hostname: 'localhost', androidScheme: 'https', cleartext: false }, android: { allowMixedContent: false, webContentsDebuggingEnabled: false } };
  const build = { version: APK.version, mode: 'companion', sharedAssets: 27, sharedAssetsSha256: APK.sharedAssetsSha256 };
  assert.doesNotThrow(() => assertPackagedConfiguration(config, build));
  for (const key of ['allowMixedContent', 'webContentsDebuggingEnabled']) assert.throws(() => assertPackagedConfiguration({ ...config, android: { ...config.android, [key]: true } }, build));
  assert.throws(() => assertPackagedConfiguration({ ...config, server: { ...config.server, cleartext: true } }, build));
  assert.throws(() => assertPackagedConfiguration(config, { ...build, sharedAssetsSha256: '0'.repeat(64) }));
});
test('native UI controls must be unique, visible, enabled and inside the expected application', () => {
  const xml = '<hierarchy><node package="org.openaster.preview" enabled="true" clickable="true" text="设置 &amp; 连接" bounds="[10,20][110,80]"/><node package="android" enabled="true" clickable="true" text="设置 &amp; 连接" bounds="[200,20][310,80]"/><node package="org.openaster.preview" enabled="true" clickable="true" text="设置 &amp; 连接" bounds="[10,1200][110,1200]"/></hierarchy>';
  const nodes = parseHierarchy(xml), choose = node => node.text === '设置 & 连接';
  assert.deepEqual({ x: selectControl(nodes, choose).x, y: selectControl(nodes, choose).y }, { x: 60, y: 50 });
  assert.throws(() => selectControl([...nodes, { ...nodes[0] }], choose), /exactly one/u);
  assert.throws(() => selectControl([{ ...nodes[0], enabled: 'false' }], choose));
  assert.equal(visibleBounds({ bounds: '[0,0][721,1280]' }), null);
  assert.equal(visibleBounds({ bounds: '[1,5][2,4]' }), null);
  assert.equal(visibleBounds({ bounds: 'not a coordinate' }), null);
});
test('hierarchy parser rejects XML declarations with entities, duplicate attributes and oversized input', () => {
  assert.throws(() => parseHierarchy('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///private">]><hierarchy><node text="&e;"/></hierarchy>'));
  assert.throws(() => parseHierarchy('<hierarchy><node text="x" text="y"/></hierarchy>'));
  assert.throws(() => parseHierarchy('x'.repeat(2 * 1024 * 1024 + 1)));
  assert.throws(() => parseHierarchy('<hierarchy/>'));
});
