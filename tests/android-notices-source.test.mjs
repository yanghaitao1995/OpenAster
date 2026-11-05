import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const asset = new URL('../mobile/notices/android-notices.json', import.meta.url);
const bytes = await readFile(asset);
const notices = JSON.parse(bytes.toString('utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

function visit(value, check) {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      check(key, child);
      visit(child, check);
    }
  }
}

test('offline Android material covers the reviewed Maven closure and both Capacitor packages', () => {
  assert.equal(notices.schemaVersion, 1);
  assert.equal(notices.platform, 'android');
  assert.equal(notices.variant, 'debug');
  assert.deepEqual(notices.counts, { maven: 46, npm: 2, components: 48 });
  assert.equal(new Set(notices.components.map(({ id }) => id)).size, 48);
  assert.equal(notices.components.filter(({ kind }) => kind === 'maven').length, 46);
  assert.deepEqual(notices.components.filter(({ kind }) => kind === 'npm').map(({ name, version, licenseIds }) =>
    ({ name, version, licenseIds })), [
    { name: '@capacitor/android', version: '8.5.3', licenseIds: ['MIT'] },
    { name: '@capacitor/core', version: '8.5.3', licenseIds: ['MIT'] },
  ]);
  for (const component of notices.components.filter(({ kind }) => kind === 'maven')) {
    assert.deepEqual(component.licenseIds, ['Apache-2.0']);
    assert.ok(component.declarations.length > 0);
    assert.ok(component.declarations.every(({ name, source }) => /Apache.*2\.0/.test(name) && source.path.endsWith('.pom')));
    assert.ok(component.evidence.some(({ path }) => /\.(aar|jar)$/.test(path)));
  }
});

test('license texts preserve full original bytes and public source evidence', async () => {
  const apache = notices.licenses.find(({ id }) => id === 'Apache-2.0');
  const mit = notices.licenses.find(({ id }) => id === 'MIT');
  assert.equal(notices.licenses.length, 2);
  assert.equal(apache.text, await readFile(new URL('../LICENSE', import.meta.url), 'utf8'));
  for (let section = 1; section <= 9; section++) assert.match(apache.text, new RegExp(`\\n   ${section}\\. `));
  assert.match(apache.text, /END OF TERMS AND CONDITIONS/);
  assert.match(apache.text, /APPENDIX: How to apply the Apache License to your work\./);
  assert.equal(apache.corroboratingSources.length, 8);
  assert.ok(apache.corroboratingSources.every(({ entry }) => entry.endsWith('/LICENSE.txt')));
  assert.match(mit.text, /Copyright \(c\) 2017-present Drifty Co\./);
  assert.match(mit.text, /Permission is hereby granted, free of charge/);
  assert.match(mit.text, /SOFTWARE\.\n$/);
  assert.equal(mit.sources.length, 2);
  for (const license of notices.licenses) {
    assert.equal(sha(license.text), license.sha256);
    assert.ok(license.sources.every((source) => source.sha256 === license.sha256 && source.bytes === Buffer.byteLength(license.text)));
  }
});

test('component evidence and the snapshot digest remain internally consistent', () => {
  const snapshot = {
    components: notices.components,
    metadataEvidence: notices.scope.metadataEvidence,
    generatedProjects: notices.generatedProjects,
  };
  assert.equal(sha(JSON.stringify(sorted(snapshot))), notices.scope.componentSnapshotSha256);
  assert.equal(notices.scope.metadataEvidence.length, 3);
  assert.ok(notices.scope.metadataEvidence.every(({ path }) => path.endsWith('.xml')));
  visit(notices, (key, value) => {
    if (key === 'sha256' || key === 'componentSnapshotSha256') assert.match(value, /^[a-f0-9]{64}$/);
    if (key === 'path') {
      assert.equal(typeof value, 'string');
      assert.doesNotMatch(value, /^(?:[A-Za-z]:|[\\/])|(?:^|\/)\.\.(?:\/|$)/);
      assert.doesNotMatch(value, /(?:^|\/)(?:Users|home)\//i);
    }
    assert.notEqual(key, 'apk');
    assert.notEqual(key, 'apkSha256');
    assert.notEqual(key, 'receipt');
  });
  assert.doesNotMatch(bytes.toString('utf8'), /"[^"\n]*\.apk"/);
});

test('missing embedded notices and generated Cordova project are disclosed without invented text', () => {
  assert.equal(notices.componentsWithoutEmbeddedLicenseText.length, 38);
  for (const component of notices.components) {
    assert.deepEqual(component.notices, []);
    assert.match(component.noticeStatus, /未发现/);
  }
  assert.equal(notices.generatedProjects.length, 1);
  assert.equal(notices.generatedProjects[0].name, ':capacitor-cordova-android-plugins');
  assert.equal(notices.generatedProjects[0].sourceFileCount, 0);
  assert.ok(notices.scope.limitations.some((line) => line.includes('不宣称完成法律合规认证')));
  assert.ok(notices.coverageGaps.some((line) => line.includes('尚未逐个核对全部上游源码发行包')));
});
