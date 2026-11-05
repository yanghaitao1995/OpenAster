import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { configureStaticUninstaller } from './nsis-static.mjs';

function fixture() {
  const calls = [];
  const target = {
    name: 'nsis', outDir: path.resolve('release'), options: {},
    async computeScriptAndSignUninstaller(a, b, c, d, e) { throw new Error('must not launch the stub'); },
    packager: { async getResource() { return undefined; }, async signIf(file) { calls.push(['sign', file]); } },
    async executeMakensis(defines) { calls.push(['compile', { ...defines }]); },
    async computeFinalScript(script) { return script; },
  };
  configureStaticUninstaller(target, { read: async () => 'dependency template', extract: async (...args) => calls.push(['extract', ...args]) });
  return { target, calls };
}

test('NSIS adapter compiles, statically extracts and signs without executing the stub', async () => {
  const { target, calls } = fixture();
  const method = target.computeScriptAndSignUninstaller;
  configureStaticUninstaller(target);
  assert.equal(target.computeScriptAndSignUninstaller, method);
  const defines = {};
  const installer = path.join(target.outDir, 'app.exe');
  assert.deepEqual(await method.call(target, defines, {}, installer, '', new Map()), { script: 'dependency template', isCustomScript: false });
  assert.deepEqual(calls.map(call => call[0]), ['compile', 'extract', 'sign']);
  assert.equal(calls[0][1].BUILD_UNINSTALLER, null);
  assert.equal(calls[1][1], installer);
  assert.equal(calls[1][2], calls[2][1]);
  assert.equal(defines.UNINSTALLER_OUT_FILE, calls[2][1]);
  assert.equal(Object.hasOwn(defines, 'BUILD_UNINSTALLER'), false);
});

test('NSIS adapter rejects custom scripts, unknown contracts and outputs outside the build directory', async () => {
  const { target } = fixture();
  await assert.rejects(target.computeScriptAndSignUninstaller({}, {}, path.resolve('other/app.exe'), '', new Map()), /outside/);
  target.packager.getResource = async () => 'custom.nsi';
  await assert.rejects(target.computeScriptAndSignUninstaller({}, {}, path.join(target.outDir, 'app.exe'), '', new Map()), /standard NSIS/);
  assert.throws(() => configureStaticUninstaller({ name: 'nsis' }), /Unsupported NSIS/);
  configureStaticUninstaller({ name: 'dmg' });
});
