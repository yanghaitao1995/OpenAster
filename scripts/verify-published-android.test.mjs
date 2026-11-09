// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { APK, assertHostedAndroid, assertKvmProcessIdentity, kvmDeviceIdentity, assertPackagedConfiguration, parseHierarchy, selectControl, visibleBounds } from './verify-published-android.mjs';

test('acceptance cannot start against a local host, another repository or another CPU', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'yanghaitao1995/OpenAster' };
  assert.doesNotThrow(() => assertHostedAndroid(env, 'linux', 'x64'));
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'other/project' }]) assert.throws(() => assertHostedAndroid({ ...env, ...patch }, 'linux', 'x64'));
  assert.throws(() => assertHostedAndroid(env, 'win32', 'x64')); assert.throws(() => assertHostedAndroid(env, 'linux', 'arm64'));
});
test('KVM process context retains the original non-root UID and both real and effective device GID', () => {
  const identity = { uid: 1001, euid: 1001, gid: 108, egid: 108 }, expected = { uid: 1001, gid: 108 };
  assert.deepEqual(assertKvmProcessIdentity(identity, expected), { ...identity, scope: 'process-tree-primary-group', accountMembershipChanged: false });
  for (const patch of [{ uid: 0 }, { euid: 0 }, { uid: 1002 }, { euid: 1002 }, { gid: 1001 }, { egid: 1001 }]) {
    assert.throws(() => assertKvmProcessIdentity({ ...identity, ...patch }, expected), /original non-root/u);
  }
  for (const value of [0, -1, NaN, Infinity, 1.5, 0xffffffff, undefined]) {
    assert.throws(() => assertKvmProcessIdentity(identity, { ...expected, uid: value }));
    assert.throws(() => assertKvmProcessIdentity(identity, { ...expected, gid: value }));
  }
});
test('KVM device snapshot detects changes in device, ownership and permissions and rejects links or ordinary files', () => {
  const stat = { dev: 24, ino: 173, rdev: 2792, uid: 0, gid: 108, mode: 0o20660, isCharacterDevice: () => true, isSymbolicLink: () => false };
  assert.equal(kvmDeviceIdentity(stat), '24:173:2792:0:108:660');
  for (const patch of [{ dev: 25 }, { ino: 174 }, { rdev: 2793 }, { gid: 109 }, { mode: 0o20666 }]) {
    assert.notEqual(kvmDeviceIdentity({ ...stat, ...patch }), kvmDeviceIdentity(stat));
  }
  for (const patch of [{ uid: 1001 }, { isCharacterDevice: () => false }, { isSymbolicLink: () => true }]) {
    assert.throws(() => kvmDeviceIdentity({ ...stat, ...patch }), /root-owned character device/u);
  }
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
