// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { realpathSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

// Exercise the actual startup guard with real files and a native Windows 8.3
// alias. Only Electron's app API and the selected temp root are fixture adapters.
// No window, application profile, installer, live model starts.
test('Windows smoke guard accepts native short temp paths while retaining ownership and link checks',
  { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
    const parent = await fs.realpath(tmpdir());
    const root = await fs.mkdtemp(path.join(parent, 'openaster-guard-path-'));
    const identity = await fs.lstat(root, { bigint: true });
    const owner = randomBytes(32).toString('hex');
    await fs.writeFile(path.join(root, '.fixture-owner'), owner, { flag: 'wx', mode: 0o600 });
    t.after(async () => {
      const canonical = await fs.realpath(root), current = await fs.lstat(root, { bigint: true });
      assert.equal(path.dirname(canonical), parent);
      assert.match(path.basename(canonical), /^openaster-guard-path-[a-zA-Z0-9]+$/u);
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
      assert.equal(await fs.readFile(path.join(canonical, '.fixture-owner'), 'utf8'), owner);
      await fs.rm(canonical, { recursive: true, maxRetries: 3, retryDelay: 100 });
    });

    // Read-only Win32 path conversion. The generated path is stdin data, never
    // interpolated into executable PowerShell text; no raw paths are logged.
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const program = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class OpenAsterShortPathProbe { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string source, StringBuilder target, uint size); }'
$source = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = [Text.StringBuilder]::new(32768)
$length = [OpenAsterShortPathProbe]::GetShortPathName([string]$source, $target, 32768)
if ($length -eq 0 -or $length -ge 32768) { throw 'Native short-path query failed' }
[Console]::Out.Write((ConvertTo-Json -InputObject $target.ToString() -Compress))`;
    const result = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], {
      input: JSON.stringify(root), encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 8192,
    });
    const shortRoot = JSON.parse(result.replace(/^\uFEFF/u, ''));
    assert.equal((await fs.realpath(shortRoot)).toLowerCase(), root.toLowerCase());
    if (shortRoot.toLowerCase() === root.toLowerCase()) {
      t.skip('This volume does not expose an 8.3 alias; native short-path regression was not exercised');
      return;
    }

    const directory = await fs.mkdtemp(path.join(root, 'openaster-smoke-'));
    await fs.writeFile(path.join(directory, '.smoke-owner'), owner, { flag: 'wx', mode: 0o600 });
    const source = await fs.readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('if (smokeMode) {'), end = source.indexOf('\nlet service;', start);
    assert.ok(start >= 0 && end > start, 'Startup smoke guard must remain independently exercisable');
    const guard = source.slice(start, end);
    const execute = ({ requested = directory, expectedOwner = owner, oldCanonicalization = false } = {}) => {
      const diagnostics = [], paths = [], exits = [];
      const context = { smokeMode: true, relaunchSmokeMode: false, backupSmokeMode: false,
        process: { env: { OPENASTER_SMOKE_DATA_DIR: requested, OPENASTER_SMOKE_OWNER: expectedOwner }, argv: [] },
        path, tmpdir: () => shortRoot, realpathSync, lstatSync, readdirSync, readFileSync,
        console: { error: line => diagnostics.push(String(line)) },
        app: { setPath: (name, value) => paths.push({ name, value }), exit: code => exits.push(code) },
      };
      const input = oldCanonicalization ? guard.replaceAll('realpathSync.native(', 'realpathSync(') : guard;
      vm.runInNewContext(input, context, { timeout: 1000 });
      const failure = diagnostics.find(line => line.startsWith('OPENASTER_SMOKE_GUARD_FAILURE '));
      return { paths, exits, failure: failure ? JSON.parse(failure.slice('OPENASTER_SMOKE_GUARD_FAILURE '.length)) : null, diagnostics };
    };

    assert.notEqual(realpathSync(shortRoot).toLowerCase(), (await fs.realpath(shortRoot)).toLowerCase());
    const legacy = execute({ oldCanonicalization: true });
    assert.deepEqual(legacy.exits, [2]); assert.equal(legacy.failure.stage, 'temporary-child');
    const current = execute();
    assert.deepEqual(current.exits, []); assert.equal(current.failure, null);
    assert.deepEqual(current.paths, [
      { name: 'userData', value: directory }, { name: 'sessionData', value: path.join(directory, 'chromium') },
    ]);
    assert.equal(execute({ requested: path.join(shortRoot, path.basename(directory)) }).failure, null);

    const wrongOwner = execute({ expectedOwner: '0'.repeat(64) });
    assert.deepEqual(wrongOwner.exits, [2]); assert.equal(wrongOwner.paths.length, 0);
    assert.equal(wrongOwner.failure.stage, 'owner-marker');
    await fs.writeFile(path.join(directory, 'existing-user-file'), 'retain this fixture');
    const stale = execute();
    assert.deepEqual(stale.exits, [2]); assert.equal(stale.paths.length, 0);
    assert.equal(stale.failure.stage, 'fresh-directory');
    assert.equal(await fs.readFile(path.join(directory, 'existing-user-file'), 'utf8'), 'retain this fixture');

    const link = path.join(root, 'openaster-smoke-Link');
    await fs.symlink(directory, link, 'junction');
    const redirected = execute({ requested: link });
    assert.deepEqual(redirected.exits, [2]); assert.equal(redirected.paths.length, 0);
    assert.equal(redirected.failure.stage, 'root-directory');
    for (const checked of [legacy, wrongOwner, stale, redirected]) {
      for (const line of checked.diagnostics) {
        assert.equal(line.includes(root), false); assert.equal(line.includes(shortRoot), false);
        assert.equal(line.includes(owner), false);
      }
    }
    t.diagnostic('actual 8.3 alias exercised; legacy mismatch reproduced; native guard passed; owner/fresh/junction rejection retained');
  });
