import test from 'node:test';
import assert from 'node:assert/strict';
import beforePack, { preserveWindowsRuntimeIdentity } from './windows-compat.mjs';

test('Windows resource compatibility preserves signing and every argument except binary identity override', async () => {
  const calls = [];
  const packager = { async signAndEditResources(file, arch, outDir, internalName, requestedExecutionLevel) {
    calls.push({ owner: this, args: [file, arch, outDir, internalName, requestedExecutionLevel] });
    return 'normal-resource-edit-and-sign';
  } };
  preserveWindowsRuntimeIdentity(packager);
  const wrapper = packager.signAndEditResources;
  preserveWindowsRuntimeIdentity(packager);
  assert.equal(packager.signAndEditResources, wrapper);
  assert.equal(await packager.signAndEditResources('OpenAster.exe', 1, 'release', 'OpenAster', 'asInvoker'), 'normal-resource-edit-and-sign');
  assert.equal(calls[0].owner, packager);
  assert.deepEqual(calls[0].args, ['OpenAster.exe', 1, 'release', null, 'asInvoker']);
});

test('Resource compatibility fails on an unknown builder contract and leaves non-Windows builds alone', async () => {
  assert.throws(() => preserveWindowsRuntimeIdentity({}), /Unsupported Windows/);
  assert.throws(() => preserveWindowsRuntimeIdentity({ signAndEditResources() {} }), /Unsupported Windows/);
  await beforePack({ electronPlatformName: 'darwin', packager: {} });
});
