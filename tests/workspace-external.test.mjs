import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkspace } from '../core/workspace.mjs';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function fixture(t) {
  // External roots deliberately reject ancestors such as macOS's /var symlink.
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'openaster-external-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  return { base, root, workspace: createWorkspace(root, { createRoot: false, denySensitivePaths: true }) };
}

test('external options and persisted identity have a strict shape', () => {
  const root = path.resolve('unused-workspace-fixture');
  for (const options of [null, [], { createRoot: null }, { createRoot: 0 }, { denySensitivePaths: 'yes' }, { protectedRoots: null }, { protectedRoots: ['relative'] }, { protectedRoots: Array(1) },
    { expectedIdentity: null }, { expectedIdentity: {} }, { expectedIdentity: { canonical: root, dev: 1, ino: '2' } },
    { expectedIdentity: { canonical: root, dev: '01', ino: '2' } }, { expectedIdentity: { canonical: root, dev: '1', ino: '2', extra: true } }]) {
    assert.throws(() => createWorkspace(root, options), { code: 'INVALID_WORKSPACE' });
  }
});

test('missing external roots are never created, while the legacy default still creates its root', async t => {
  const { base } = await fixture(t);
  const missing = path.join(base, 'missing', 'child');
  const external = createWorkspace(missing, { createRoot: false });
  for (const action of [() => external.getIdentity(), () => external.list(), () => external.read('a.txt'), () => external.search('x'),
    () => external.prepareWrite({ path: 'a.txt', content: 'x' }), () => external.importText({ path: 'a.txt', content: 'x' })]) {
    await assert.rejects(action(), { code: 'WORKSPACE_MISSING' });
    await assert.rejects(fs.lstat(path.join(base, 'missing')), { code: 'ENOENT' });
  }
  const internal = createWorkspace(path.join(base, 'internal'));
  assert.deepEqual((await internal.list()).files, []);
  assert.equal((await fs.stat(internal.root)).isDirectory(), true);
});

test('directory identity is JSON-safe, immutable and reusable across workspace instances', async t => {
  const { root, workspace } = await fixture(t);
  const identity = await workspace.getIdentity();
  const stat = await fs.lstat(root, { bigint: true });
  assert.deepEqual(identity, { canonical: await fs.realpath(root), dev: String(stat.dev), ino: String(stat.ino) });
  assert.equal(Object.isFrozen(identity), true);
  const expected = JSON.parse(JSON.stringify(identity));
  const reopened = createWorkspace(root, { createRoot: false, expectedIdentity: expected });
  expected.ino = '0';
  await reopened.importText({ path: 'normal.txt', content: 'preserved' });
  assert.equal((await reopened.read('normal.txt')).content, 'preserved');
  assert.deepEqual(await reopened.getIdentity(), identity);
  if (process.platform === 'win32') {
    const caseAlias = createWorkspace(root, { createRoot: false, expectedIdentity: { ...identity, canonical: identity.canonical.toUpperCase() } });
    assert.deepEqual(await caseAlias.getIdentity(), identity);
  }
});

test('all three expected identity fields must match before a root can bind', async t => {
  const { base, root, workspace } = await fixture(t);
  const identity = await workspace.getIdentity();
  for (const expectedIdentity of [{ ...identity, canonical: base }, { ...identity, dev: `${BigInt(identity.dev) + 1n}` }, { ...identity, ino: `${BigInt(identity.ino) + 1n}` }]) {
    const reopened = createWorkspace(root, { createRoot: false, expectedIdentity });
    await assert.rejects(reopened.getIdentity(), { code: 'WORKSPACE_CHANGED' });
    await assert.rejects(reopened.importText({ path: 'must-not-exist.txt', content: 'bad' }), { code: 'WORKSPACE_CHANGED' });
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test('disappearing bound roots and saved-but-missing roots stay missing', async t => {
  const { base, root, workspace } = await fixture(t);
  const identity = await workspace.getIdentity();
  const proposal = await workspace.prepareWrite({ path: 'new.txt', content: 'approved' });
  await fs.rename(root, path.join(base, 'moved'));
  const restoredProfile = createWorkspace(root, { createRoot: false, expectedIdentity: identity });
  for (const instance of [workspace, restoredProfile]) {
    await assert.rejects(instance.getIdentity(), { code: 'WORKSPACE_CHANGED' });
    await assert.rejects(instance.list(), { code: 'WORKSPACE_CHANGED' });
    await assert.rejects(instance.read('new.txt'), { code: 'WORKSPACE_CHANGED' });
    await assert.rejects(instance.search('x'), { code: 'WORKSPACE_CHANGED' });
    await assert.rejects(instance.prepareWrite({ path: 'nested/new.txt', content: 'x' }), { code: 'WORKSPACE_CHANGED' });
    await assert.rejects(instance.importText({ path: 'new.txt', content: 'x' }), { code: 'WORKSPACE_CHANGED' });
  }
  await assert.rejects(workspace.commitWrite(proposal), { code: 'WORKSPACE_CHANGED' });
  await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.join(base, 'moved')), []);
});

test('a replacement directory cannot inherit an earlier binding or pending approval', async t => {
  const { base, root, workspace } = await fixture(t);
  await workspace.importText({ path: 'existing.txt', content: 'original' });
  const identity = await workspace.getIdentity();
  const proposal = await workspace.prepareWrite({ path: 'existing.txt', content: 'approved replacement' });
  await fs.rename(root, path.join(base, 'previous'));
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'existing.txt'), 'new owner');
  const reopened = createWorkspace(root, { createRoot: false, expectedIdentity: identity });
  for (const instance of [workspace, reopened]) {
    await assert.rejects(instance.list(), { code: 'WORKSPACE_CHANGED' });
    await assert.rejects(instance.read('existing.txt'), { code: 'WORKSPACE_CHANGED' });
    await assert.rejects(instance.search('owner'), { code: 'WORKSPACE_CHANGED' });
    await assert.rejects(instance.importText({ path: 'new.txt', content: 'bad' }), { code: 'WORKSPACE_CHANGED' });
  }
  await assert.rejects(workspace.commitWrite(proposal), { code: 'WORKSPACE_CHANGED' });
  assert.equal(await fs.readFile(path.join(root, 'existing.txt'), 'utf8'), 'new owner');
  assert.deepEqual(await fs.readdir(root), ['existing.txt']);
});

test('external roots reject symlinks or junctions at the root and every parent', async t => {
  const { base, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'safe.txt'), 'outside alias');
  const alias = path.join(base, 'alias');
  await fs.symlink(root, alias, linkType);
  await assert.rejects(createWorkspace(alias, { createRoot: false }).list(), { code: 'UNSAFE_PATH' });
  const realParent = path.join(base, 'real-parent');
  await fs.mkdir(path.join(realParent, 'deep', 'project'), { recursive: true });
  await fs.symlink(realParent, path.join(base, 'parent-alias'), linkType);
  const indirect = createWorkspace(path.join(base, 'parent-alias', 'deep', 'project'), { createRoot: false });
  await assert.rejects(indirect.getIdentity(), { code: 'UNSAFE_PATH' });
  await assert.rejects(indirect.importText({ path: 'no.txt', content: 'x' }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(path.join(realParent, 'deep', 'project')), []);
});

test('a parent changed to a junction after binding invalidates reads and approval commits', async t => {
  const { base } = await fixture(t);
  const parent = path.join(base, 'parent');
  const root = path.join(parent, 'project');
  await fs.mkdir(root, { recursive: true });
  const external = createWorkspace(root, { createRoot: false });
  const proposal = await external.prepareWrite({ path: 'no.txt', content: 'approved' });
  await fs.rename(parent, path.join(base, 'old-parent'));
  const newParent = path.join(base, 'new-parent');
  await fs.mkdir(path.join(newParent, 'project'), { recursive: true });
  await fs.symlink(newParent, parent, linkType);
  await assert.rejects(external.list(), { code: 'UNSAFE_PATH' });
  await assert.rejects(external.search('x'), { code: 'UNSAFE_PATH' });
  await assert.rejects(external.commitWrite(proposal), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(path.join(newParent, 'project')), []);
  assert.deepEqual(await fs.readdir(path.join(base, 'old-parent', 'project')), []);
});

test('protected roots reject equality and ancestry in either direction without prefix false positives', async t => {
  const { base, root } = await fixture(t);
  const child = path.join(root, 'nested');
  await fs.mkdir(child);
  for (const protectedRoot of [root, base, child]) {
    const workspace = createWorkspace(root, { createRoot: false, protectedRoots: [protectedRoot] });
    await assert.rejects(workspace.list(), { code: 'PROTECTED_WORKSPACE' });
  }
  const sibling = `${root}-protected`;
  await fs.mkdir(sibling);
  const safe = createWorkspace(root, { createRoot: false, protectedRoots: [sibling] });
  assert.deepEqual((await safe.list()).files.map(entry => entry.path), ['nested']);
  const missing = createWorkspace(root, { createRoot: false, protectedRoots: [path.join(base, 'missing')] });
  await assert.rejects(missing.list(), { code: 'INVALID_WORKSPACE' });
});

test('canonical protected-root aliases and later aliases cannot bypass the boundary', async t => {
  const { base, root } = await fixture(t);
  const alias = path.join(base, 'protected-alias');
  await fs.symlink(root, alias, linkType);
  await assert.rejects(createWorkspace(root, { createRoot: false, protectedRoots: [alias] }).list(), { code: 'PROTECTED_WORKSPACE' });
  const protectedRoot = path.join(base, 'protected');
  await fs.mkdir(protectedRoot);
  const workspace = createWorkspace(root, { createRoot: false, protectedRoots: [protectedRoot] });
  const proposal = await workspace.prepareWrite({ path: 'must-not-exist.txt', content: 'x' });
  await fs.rename(protectedRoot, path.join(base, 'previous-protected'));
  await fs.symlink(root, protectedRoot, linkType);
  await assert.rejects(workspace.commitWrite(proposal), { code: 'PROTECTED_WORKSPACE' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('protected paths are checked before legacy root creation, including canonical ancestors', async t => {
  const { base, root } = await fixture(t);
  const missing = path.join(root, 'must-not-be-created');
  await assert.rejects(createWorkspace(missing, { protectedRoots: [root] }).list(), { code: 'PROTECTED_WORKSPACE' });
  await assert.rejects(fs.lstat(missing), { code: 'ENOENT' });
  const alias = path.join(base, 'alias');
  await fs.symlink(root, alias, linkType);
  await assert.rejects(createWorkspace(path.join(alias, 'must-not-be-created'), { protectedRoots: [root] }).list(), { code: 'PROTECTED_WORKSPACE' });
  await assert.rejects(fs.lstat(missing), { code: 'ENOENT' });
});

test('sensitive entries are omitted from lists and searches and reject every direct read/write path', async t => {
  const { root, workspace } = await fixture(t);
  const sensitiveFiles = ['.env', '.ENV.production', '.npmrc', '.netrc', '_netrc', '.pypirc', '.git-credentials',
    'server.pem', 'PRIVATE.KEY', 'backup.p12', 'identity.PFX', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_xmss', 'id_ecdsa_sk', 'id_ed25519_sk', '.openaster-secret', '.openasterdata'];
  const sensitiveDirectories = ['.git', '.HG', '.svn', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.config', '.openaster-cache'];
  for (const name of sensitiveFiles) await fs.writeFile(path.join(root, name), 'private-marker');
  for (const name of sensitiveDirectories) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'secret.txt'), 'private-marker');
  }
  await fs.mkdir(path.join(root, 'normal'));
  await fs.writeFile(path.join(root, 'normal', '.env.local'), 'private-marker');
  await fs.writeFile(path.join(root, 'normal', 'visible.txt'), 'public-marker');
  assert.deepEqual((await workspace.list()).files.map(entry => entry.path), ['normal', 'normal/visible.txt']);
  assert.deepEqual((await workspace.search('private-marker')).matches, []);
  assert.equal((await workspace.search('public-marker')).matches.length, 1);
  for (const name of [...sensitiveFiles, ...sensitiveDirectories.map(name => `${name}/secret.txt`), 'normal/.env.local']) {
    await assert.rejects(workspace.read(name), { code: 'SENSITIVE_PATH' }, name);
    await assert.rejects(workspace.prepareWrite({ path: name, content: 'overwrite' }), { code: 'SENSITIVE_PATH' }, name);
    await assert.rejects(workspace.importText({ path: name, content: 'overwrite' }), { code: 'SENSITIVE_PATH' }, name);
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), 'private-marker');
  }
});

test('ordinary dotfiles, public keys and exact environment templates remain usable with approvals', async t => {
  const { root, workspace } = await fixture(t);
  const allowed = ['.gitignore', '.editorconfig', '.env.example', '.ENV.SAMPLE', '.env.template', 'id_rsa.pub', '.well-known/readme.txt', 'notes/普通.md'];
  for (const name of allowed) await workspace.importText({ path: name, content: 'initial' });
  for (const name of allowed) {
    const proposal = await workspace.prepareWrite({ path: name, content: 'approved update' });
    assert.equal(proposal.originalContent, 'initial');
    await workspace.commitWrite(proposal);
    await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
    assert.equal((await workspace.read(name)).content, 'approved update');
  }
  assert.equal((await workspace.search('approved update')).matches.length, allowed.length);
  await assert.rejects(workspace.importText({ path: '.env.example.local', content: 'secret' }), { code: 'SENSITIVE_PATH' });
  await assert.rejects(fs.lstat(path.join(root, '.env.example.local')), { code: 'ENOENT' });
});

test('sensitive parent paths cannot create directories and another workspace cannot supply approval capabilities', async t => {
  const { root, workspace } = await fixture(t);
  await assert.rejects(workspace.prepareWrite({ path: 'nested/.ssh/new.txt', content: 'x' }), { code: 'SENSITIVE_PATH' });
  await assert.rejects(fs.lstat(path.join(root, 'nested')), { code: 'ENOENT' });
  const relaxed = createWorkspace(root);
  const proposal = await relaxed.prepareWrite({ path: '.env', content: 'secret' });
  await assert.rejects(workspace.commitWrite(proposal), { code: 'INVALID_APPROVAL' });
  await assert.rejects(fs.lstat(path.join(root, '.env')), { code: 'ENOENT' });
  relaxed.discardWrite(proposal);
});

test('selecting a sensitive directory or one of its descendants does not bypass path filtering', async t => {
  const { root } = await fixture(t);
  for (const directory of ['.ssh', '.config/project', '.openaster-data/project']) {
    const nested = path.join(root, directory);
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'secret.txt'), 'private');
    const external = createWorkspace(nested, { createRoot: false, denySensitivePaths: true });
    await assert.rejects(external.list(), { code: 'SENSITIVE_PATH' });
    await assert.rejects(external.read('secret.txt'), { code: 'SENSITIVE_PATH' });
  }
});

test('sensitive filtering is opt-in for existing dedicated workspaces', async t => {
  const { root } = await fixture(t);
  const legacy = createWorkspace(root);
  await legacy.importText({ path: '.env', content: 'local-only config' });
  assert.equal((await legacy.read('.env')).content, 'local-only config');
  assert.deepEqual((await legacy.list()).files.map(entry => entry.path), ['.env']);
});

test('cancellation inside the last nested directory never returns a successful inventory', async t => {
  const { root, workspace } = await fixture(t);
  const nested = path.join(root, 'only-child');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'ordinary.txt'), 'content');
  const directory = await fs.opendir(root);
  const prototype = Object.getPrototypeOf(directory);
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(prototype, Symbol.asyncIterator);
  const iterate = iteratorDescriptor.value;
  await directory.close();
  const controller = new AbortController();
  Object.defineProperty(prototype, Symbol.asyncIterator, { ...iteratorDescriptor, value: async function* () {
    for await (const entry of iterate.call(this)) {
      if (this.path === nested) controller.abort();
      yield entry;
    }
  } });
  try {
    await assert.rejects(workspace.list({ signal: controller.signal }), { code: 'CANCELLED' });
    assert.equal(controller.signal.aborted, true);
  } finally { Object.defineProperty(prototype, Symbol.asyncIterator, iteratorDescriptor); }
});

test('root boundary failures discovered during nested traversal propagate immediately', async t => {
  const { base, root } = await fixture(t);
  const nested = path.join(root, 'only-child');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'ordinary.txt'), 'content');
  const protectedRoot = path.join(base, 'protected');
  await fs.mkdir(protectedRoot);
  const workspace = createWorkspace(root, { createRoot: false, protectedRoots: [protectedRoot] });
  const directory = await fs.opendir(root);
  const prototype = Object.getPrototypeOf(directory);
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(prototype, Symbol.asyncIterator);
  const iterate = iteratorDescriptor.value;
  await directory.close();
  let switched = false;
  Object.defineProperty(prototype, Symbol.asyncIterator, { ...iteratorDescriptor, value: async function* () {
    for await (const entry of iterate.call(this)) {
      if (this.path === nested && !switched) {
        switched = true;
        await fs.rename(protectedRoot, path.join(base, 'previous-protected'));
        await fs.symlink(root, protectedRoot, linkType);
      }
      yield entry;
    }
  } });
  try {
    await assert.rejects(workspace.list(), { code: 'PROTECTED_WORKSPACE' });
    assert.equal(switched, true);
  } finally { Object.defineProperty(prototype, Symbol.asyncIterator, iteratorDescriptor); }
});
