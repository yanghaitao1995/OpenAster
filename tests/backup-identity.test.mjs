// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { createBackup, restoreBackup } from '../server/backup.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { isSensitiveSegment } from '../core/sensitive-paths.mjs';

const absent = file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
async function identity(directory) {
  const value = await fs.lstat(directory, { bigint: true });
  return { canonical: await fs.realpath(directory), dev: String(value.dev), ino: String(value.ino) };
}
async function fixture(t) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-backup-identity-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.match(path.basename(root), /^openaster-backup-identity-[a-zA-Z0-9]+$/u);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const dataDir = path.join(root, 'data'), workspace = path.join(root, 'project');
  await fs.mkdir(dataDir); await fs.mkdir(workspace);
  const store = new Store(dataDir); const session = store.createSession({ title: 'Bound backup' }); store.close();
  await fs.writeFile(path.join(workspace, 'normal.txt'), '\ufeffexact 中文\r\n');
  return { root, dataDir, workspace, session, output: path.join(root, 'backup.json'), expectedDataIdentity: await identity(dataDir), expectedWorkspaceIdentity: await identity(workspace) };
}

test('strict backup identity and sensitive-policy options reject malformed values before source access', async () => {
  const base = { dataDir: path.resolve('does-not-exist-backup'), output: path.resolve('never-written-backup.json') };
  const valid = { canonical: path.resolve('does-not-exist-backup'), dev: '1', ino: '2' };
  for (const denySensitivePaths of [null, 0, 1, 'false', {}, []]) await assert.rejects(createBackup({ ...base, denySensitivePaths }), { code: 'INVALID_BACKUP_OPTIONS' });
  let getterCalls = 0;
  const accessor = { ...valid }; Object.defineProperty(accessor, 'ino', { enumerable: true, get() { getterCalls++; throw Error('getter ran'); } });
  const symbol = { ...valid, [Symbol('extra')]: true };
  for (const value of [null, [], {}, { ...valid, ino: '0' }, { ...valid, dev: 1 }, { ...valid, ino: '01' }, { ...valid, dev: '1'.repeat(41) },
    { ...valid, canonical: 'relative' }, { ...valid, canonical: path.join(valid.canonical, '..') + path.sep + '..' },
    { ...valid, canonical: valid.canonical + '\ud800' }, { ...valid, extra: true }, accessor, symbol]) {
    for (const key of ['expectedWorkspaceIdentity', 'expectedDataIdentity']) await assert.rejects(createBackup({ ...base, [key]: value }), { code: 'INVALID_BACKUP_OPTIONS' });
  }
  assert.equal(getterCalls, 0);
});

test('bound external snapshots round-trip exact bytes without restoring the external location', async t => {
  const f = await fixture(t), original = await fs.readFile(path.join(f.workspace, 'normal.txt'));
  if (process.platform === 'win32') {
    f.expectedWorkspaceIdentity.canonical = f.expectedWorkspaceIdentity.canonical.toUpperCase();
    f.expectedDataIdentity.canonical = f.expectedDataIdentity.canonical.toUpperCase();
  }
  const result = await createBackup({ ...f, denySensitivePaths: true });
  assert.equal(result.sessions, 1); assert.equal(result.workspaceEntries, 1);
  const restored = path.join(f.root, 'restored'); await restoreBackup({ input: f.output, dataDir: restored });
  assert.deepEqual(await fs.readFile(path.join(restored, 'workspace', 'normal.txt')), original);
  assert.deepEqual(await fs.readFile(path.join(f.workspace, 'normal.txt')), original);
  const reader = new Store(restored);
  try { assert.equal(reader.getSession(f.session.id).title, 'Bound backup'); } finally { reader.close(); }
});

test('all expected identity fields must match before backup can bind either directory', async t => {
  const f = await fixture(t);
  for (const key of ['expectedWorkspaceIdentity', 'expectedDataIdentity']) {
    const original = f[key];
    for (const value of [{ ...original, canonical: f.root }, { ...original, dev: String(BigInt(original.dev) + 1n) }, { ...original, ino: String(BigInt(original.ino) + 1n) }]) {
      await assert.rejects(createBackup({ ...f, [key]: value }), { code: 'SOURCE_CHANGED' });
      await absent(f.output);
    }
  }
  await absent(path.join(f.dataDir, '.instance.sqlite'));
});

for (const field of ['workspace', 'dataDir']) test(`a replaced registered ${field} cannot be backed up or silently recreated`, async t => {
  const f = await fixture(t), directory = f[field];
  await fs.rename(directory, directory + '-original');
  await assert.rejects(createBackup(f), { code: 'SOURCE_CHANGED' }); await absent(directory);
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'replacement.txt'), 'must not be read');
  const before = await fs.readdir(directory);
  await assert.rejects(createBackup(f), { code: 'SOURCE_CHANGED' }); await absent(f.output);
  assert.deepEqual(await fs.readdir(directory), before);
});

test('sensitive segment rules are shared with workspace access and reject the whole external backup', async t => {
  const f = await fixture(t), workspace = createWorkspace(f.workspace, { createRoot: false, denySensitivePaths: true });
  const names = ['.git', '.hg', '.svn', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.config', '.npmrc', '.netrc', '_netrc', '.pypirc',
    '.git-credentials', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_xmss', 'id_ecdsa_sk', 'id_ed25519_sk',
    '.openaster-private', '.env', '.env.production', 'TLS.PEM', 'private.key', 'bundle.p12', 'bundle.pfx'];
  for (const name of names) {
    assert.equal(isSensitiveSegment(name), true);
    const file = path.join(f.workspace, name); await fs.writeFile(file, 'sensitive fixture');
    await assert.rejects(workspace.read(name), { code: 'SENSITIVE_PATH' });
    await assert.rejects(createBackup({ ...f, denySensitivePaths: true }), { code: 'SENSITIVE_PATH' });
    await absent(f.output); assert.equal(await fs.readFile(file, 'utf8'), 'sensitive fixture'); await fs.unlink(file);
  }
  for (const name of ['.env.example', '.env.sample', '.env.template', '.editorconfig', '.gitignore', 'public.pem.txt']) assert.equal(isSensitiveSegment(name), false);
  await fs.writeFile(path.join(f.workspace, '.editorconfig'), 'ordinary dotfile');
  await createBackup({ ...f, denySensitivePaths: true });
  assert.equal(JSON.parse(await fs.readFile(f.output, 'utf8')).payload.workspace.length, 2);
});

test('sensitive ancestor directories are rejected and default legacy backups keep their existing policy', async t => {
  const f = await fixture(t), legacy = path.join(f.workspace, '.ssh'); await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'note.txt'), 'legacy full snapshot');
  await createBackup({ dataDir: f.dataDir, workspace: f.workspace, output: f.output });
  const value = JSON.parse(await fs.readFile(f.output, 'utf8'));
  assert.ok(value.payload.workspace.some(entry => entry.path === '.ssh/note.txt'));
  await assert.rejects(createBackup({ dataDir: f.dataDir, workspace: legacy, output: path.join(f.root, 'blocked.json'), denySensitivePaths: true }), { code: 'SENSITIVE_PATH' });
  await absent(path.join(f.root, 'blocked.json'));
});

test('a real root replacement during directory discovery is caught before reading replacement contents', async t => {
  const f = await fixture(t), originalOpenDirectory = fs.opendir, originalOpen = fs.open;
  let replaced = false, replacementReads = 0;
  t.mock.method(fs, 'opendir', async function (directory, ...args) {
    if (!replaced && path.resolve(directory) === f.workspace) {
      replaced = true; await fs.rename(f.workspace, f.workspace + '-original'); await fs.mkdir(f.workspace);
      await fs.writeFile(path.join(f.workspace, 'replacement.txt'), 'replacement content');
    }
    return originalOpenDirectory.call(this, directory, ...args);
  });
  t.mock.method(fs, 'open', async function (file, ...args) {
    if (path.resolve(file) === path.join(f.workspace, 'replacement.txt')) replacementReads++;
    return originalOpen.call(this, file, ...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(createBackup({ ...f, denySensitivePaths: true }), { code: 'SOURCE_CHANGED' });
    assert.equal(replaced, true); assert.equal(replacementReads, 0); await absent(f.output);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('a root replacement after writing the archive fails final verification and removes only the owned output', async t => {
  const f = await fixture(t), probe = await fs.open(path.join(f.workspace, 'normal.txt'));
  const prototype = Object.getPrototypeOf(probe), original = prototype.writeFile; await probe.close();
  let replaced = false;
  t.mock.method(prototype, 'writeFile', async function (value, ...args) {
    const result = await original.call(this, value, ...args);
    if (!replaced && typeof value === 'string' && value.startsWith('{"format":"openaster-backup"')) {
      replaced = true; await fs.rename(f.workspace, f.workspace + '-original'); await fs.mkdir(f.workspace);
      await fs.writeFile(path.join(f.workspace, 'replacement.txt'), 'preserve replacement');
    }
    return result;
  });
  try {
    await assert.rejects(createBackup(f), { code: 'SOURCE_CHANGED' }); assert.equal(replaced, true); await absent(f.output);
    assert.equal(await fs.readFile(path.join(f.workspace, 'replacement.txt'), 'utf8'), 'preserve replacement');
  } finally { t.mock.restoreAll(); }
});
