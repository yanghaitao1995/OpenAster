// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRegistryDiagnostic } from './workspace-errors.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { initializeSkillDirectory, DEFAULT_SKILLS_ROOT } from '../core/skills.mjs';

const LIMIT = 100;
const MAX_BYTES = 1024 * 1024;
const WINDOWS_RENAME_RETRY_DELAYS = [25, 75, 150];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const equalPath = (a, b) => key(a) === key(b);
const inside = (parent, child) => { const relative = path.relative(key(parent), key(child)); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const overlap = (a, b) => inside(a, b) || inside(b, a);
function error(code, message, location, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, ...(location ? { path: location } : {}) });
}
function failedCleanup(primary, cleanup, retainedPaths = []) {
  const failure = primary.committed ? primary : error('WORKSPACE_CLEANUP_INCOMPLETE', '操作未完成，部分临时数据无法安全清理，已保留供检查。', retainedPaths[0], primary);
  const previous = primary.retainedPaths ?? [];
  failure.retainedPaths = [...new Set([...previous, ...retainedPaths])].slice(0, 3);
  if (failure.retainedPaths.length) failure.orphanPath = failure.retainedPaths[0];
  Object.defineProperty(failure, 'cleanupCauses', { value: [...(primary.cleanupCauses ?? []), ...cleanup.map(item => item.cause)], configurable: true });
  failure.registryDiagnostic = createRegistryDiagnostic({ stage: primary.registryDiagnostic?.stage ?? 'prepare-profile', committed: primary.committed === true, cause: primary, cleanup });
  return failure;
}
function shape(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function absolute(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.isWellFormed() || /[\0-\x1f\x7f]/.test(value) || !path.isAbsolute(value) || value.split(/[\\/]/).includes('..') || (process.platform === 'win32' && (!/^[a-zA-Z]:[\\/]/.test(value) || /[:<>"|?*]/.test(value.slice(2)) || value.slice(3).split(/[\\/]/).some(part => /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) {
    throw error('WORKSPACE_INVALID_PATH', '请选择有效的本机绝对目录路径。', typeof value === 'string' ? value : undefined);
  }
  return path.resolve(value);
}
// Reject links in every component, not just the selected final directory.
async function walk(location, { missing = false, file = false } = {}) {
  const parsed = path.parse(location);
  const parts = path.relative(parsed.root, location).split(path.sep).filter(Boolean);
  let current = parsed.root, final;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    let info;
    try { info = await fs.lstat(current, { bigint: true }); }
    catch (cause) {
      if (cause.code === 'ENOENT' && missing && index === parts.length - 1) return null;
      throw error(cause.code === 'ENOENT' ? 'WORKSPACE_MISSING' : 'WORKSPACE_ACCESS', '无法访问工作区或其上级目录。', current, cause);
    }
    if (info.isSymbolicLink() || (!info.isDirectory() && !(file && index === parts.length - 1 && info.isFile()))) throw error('WORKSPACE_UNSAFE_PATH', '路径或上级目录必须是普通目录，不能是符号链接或目录联接。', current);
    final = info;
  }
  return final;
}
async function existingDirectory(location) {
  const lexical = absolute(location);
  const before = await walk(lexical);
  const canonical = await fs.realpath(lexical);
  const after = await walk(canonical);
  if (!sameFile(before, after) || after.ino === 0n) throw error('WORKSPACE_CHANGED', '目录身份发生变化或文件系统不提供稳定目录标识。', lexical);
  return { canonical, dev: after.dev.toString(), ino: after.ino.toString() };
}
function validIdentity(identity, workspace) {
  return shape(identity, ['canonical', 'dev', 'ino']) && identity.canonical === workspace && decimal(identity.dev) && decimal(identity.ino) && identity.ino !== '0';
}

/** Startup must establish the controlled workspace before seeding ./skills.
 * Registry initialization remains read-only with respect to workspace contents.
 * External/restored roots must retain their existing no-recreation policy. */
export async function initializeProfileWorkspace(profile, options) {
  if (!profile || !['default', 'external', 'restored'].includes(profile.kind)
    || (profile.kind !== 'default' && options?.createRoot !== false)) {
    throw error('WORKSPACE_INVALID_CONFIG', '工作区启动配置无效。');
  }
  await createWorkspace(profile.workspace, options).getIdentity();
  const skillsDirectory = path.join(profile.workspace, 'skills');
  await initializeSkillDirectory(DEFAULT_SKILLS_ROOT, skillsDirectory);
  return skillsDirectory;
}

/** Single-process registry; the desktop lifecycle must serialize profile switches.
 * Path/identity checks fail closed on observed changes. They are not an OS sandbox
 * against a hostile same-user process replacing paths between filesystem calls.
 */
export function createWorkspaceProfiles({ userData, appRoots = [], homeDirectory = homedir() }) {
  const requestedData = absolute(userData);
  if (!Array.isArray(appRoots) || appRoots.length > 32) throw error('WORKSPACE_INVALID_CONFIG', '应用保护目录配置无效。');
  const requestedApps = appRoots.map(absolute);
  const requestedHome = absolute(homeDirectory);
  let root, rootIdentity, protectedRoots, home, registry, profilesRoot, state, token;
  let queue = Promise.resolve();
  const serialized = operation => { const current = queue.catch(() => {}).then(operation); queue = current; return current; };
  const ready = () => { if (!state) throw error('WORKSPACE_NOT_INITIALIZED', '工作区配置尚未初始化。'); };
  async function checkRoot() {
    const current = await existingDirectory(root);
    if (!equalPath(current.canonical, rootIdentity.canonical) || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) throw error('WORKSPACE_CHANGED', '应用数据目录身份已改变。', root);
  }
  function validateState(value) {
    const invalid = () => error('WORKSPACE_REGISTRY_INVALID', '工作区注册文件格式无效，请保留原文件并检查配置。', registry);
    if (!shape(value, ['version', 'activeId', 'recent', 'profiles']) || ![1, 2].includes(value.version) || !Array.isArray(value.profiles) || value.profiles.length > LIMIT || !Array.isArray(value.recent)) throw invalid();
    const ids = new Set(['default']), workspaces = new Set();
    for (const item of value.profiles) {
      const restored = value.version === 2 && item?.kind === 'restored';
      const fields = restored ? ['id', 'kind', 'identity', 'dataIdentity'] : value.version === 1 ? ['id', 'workspace', 'identity'] : ['id', 'kind', 'workspace', 'identity'];
      if (!shape(item, fields) || !UUID.test(item.id) || ids.has(item.id) || (value.version === 2 && !restored && item.kind !== 'external')) throw invalid();
      const dataDir = path.join(profilesRoot, item.id);
      const workspace = restored ? path.join(dataDir, 'workspace') : item.workspace;
      if (restored) {
        if (!validIdentity(item.identity, workspace) || !validIdentity(item.dataIdentity, dataDir)) throw invalid();
      } else {
        try { if (absolute(workspace) !== workspace) throw invalid(); } catch { throw invalid(); }
        if (!validIdentity(item.identity, workspace) || equalPath(workspace, path.parse(workspace).root) || equalPath(workspace, home) || protectedRoots.some(protectedRoot => overlap(protectedRoot, workspace))) throw invalid();
      }
      if (workspaces.has(key(workspace))) throw invalid();
      ids.add(item.id); workspaces.add(key(workspace));
    }
    if (value.recent.length !== ids.size || new Set(value.recent).size !== ids.size || value.recent.some(id => !ids.has(id)) || !ids.has(value.activeId) || value.recent[0] !== value.activeId) throw invalid();
    return value;
  }
  async function readRegistry({ stage = 'read-registry', committed = false } = {}) {
    let handle, failure, result;
    try {
      await checkRoot();
      let before;
      try { before = await fs.lstat(registry, { bigint: true }); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES)) throw error('WORKSPACE_REGISTRY_UNSAFE', '工作区注册文件必须是有界的普通单链接文件。', registry);
      handle = await fs.open(registry, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(before, opened) || !opened.isFile() || opened.nlink !== 1n) throw error('WORKSPACE_REGISTRY_CHANGED', '读取工作区注册文件时发现替换。', registry);
      const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
      while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length); if (!result.bytesRead) break; length += result.bytesRead; }
      const after = await handle.stat({ bigint: true }), named = await fs.lstat(registry, { bigint: true });
      if (length > MAX_BYTES || !sameFile(after, named) || after.nlink !== 1n || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw error('WORKSPACE_REGISTRY_CHANGED', '工作区注册文件在读取期间变化。', registry);
      const bytes = buffer.subarray(0, length);
      let value;
      try { value = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch (cause) { if (cause.code?.startsWith('WORKSPACE_')) throw cause; throw error('WORKSPACE_REGISTRY_INVALID', '工作区注册文件不是有效 JSON。', registry, cause); }
      result = { value, token: `${after.dev}:${after.ino}:${after.mtimeNs}:${after.ctimeNs}:${hash(bytes)}` };
    } catch (cause) { failure = cause; }
    const cleanup = [];
    if (handle) {
      try { await handle.close(); }
      catch (cause) {
        if (failure) cleanup.push({ stage: 'close-registry', cause });
        else failure = cause;
      }
    }
    if (failure) {
      const reported = failure.code?.startsWith('WORKSPACE_') ? failure : error('WORKSPACE_REGISTRY_READ_FAILED', '无法读取或关闭工作区注册文件。', registry, failure);
      reported.registryDiagnostic = createRegistryDiagnostic({ stage, committed, cause: failure, cleanup });
      if (cleanup.length) Object.defineProperty(reported, 'cleanupCauses', { value: cleanup.map(item => item.cause), configurable: true });
      throw reported;
    }
    return result;
  }
  async function unchanged(stage = 'read-registry') {
    const current = await readRegistry({ stage });
    if ((current?.token ?? null) !== token) throw error('WORKSPACE_REGISTRY_CHANGED', '工作区配置已被其他操作修改，请重新启动后检查。', registry);
  }
  async function removeOwned(file, identity, expectedBytes) {
    await checkRoot();
    let info; try { info = await fs.lstat(file, { bigint: true }); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    if (!sameFile(info, identity) || info.isSymbolicLink() || !info.isFile()) throw error('WORKSPACE_CLEANUP_INCOMPLETE', '临时文件身份已改变，已保留该文件。', file);
    if (expectedBytes) {
      const verified = await inspectRetryTemporary(file, identity, expectedBytes);
      await checkRoot();
      info = await fs.lstat(file, { bigint: true });
      if (!sameFile(info, verified) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
        || info.size !== verified.size || info.mtimeNs !== verified.mtimeNs || info.ctimeNs !== verified.ctimeNs) {
        throw error('WORKSPACE_CLEANUP_INCOMPLETE', '临时配置内容无法确认，已保留该文件。', file);
      }
    }
    await fs.unlink(file);
  }
  async function inspectRetryTemporary(file, identity, expected) {
    const changed = () => error('WORKSPACE_REGISTRY_CHANGED', '重试前暂存配置的身份或内容已变化。', file);
    const valid = info => sameFile(info, identity) && info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.size === BigInt(expected.length);
    let handle, result, failure;
    try {
      await checkRoot();
      const before = await fs.lstat(file, { bigint: true });
      if (!valid(before)) throw changed();
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!valid(opened) || before.mtimeNs !== opened.mtimeNs || before.ctimeNs !== opened.ctimeNs) throw changed();
      const buffer = Buffer.alloc(expected.length + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat({ bigint: true }), named = await fs.lstat(file, { bigint: true });
      if (!valid(after) || !valid(named) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || after.mtimeNs !== named.mtimeNs || after.ctimeNs !== named.ctimeNs || !buffer.subarray(0, length).equals(expected)) throw changed();
      result = after;
    } catch (cause) { failure = cause; }
    const cleanup = [];
    if (handle) {
      try { await handle.close(); }
      catch (cause) {
        if (failure) cleanup.push({ stage: 'close-temporary', cause }); else failure = cause;
        // A rejected close is not proof that the handle was released. Preserve
        // its first failure even if this final cleanup attempt also rejects.
        try { await handle.close(); }
        catch (cause) { cleanup.push({ stage: 'close-temporary', cause }); }
      }
    }
    if (failure) {
      failure.registryDiagnostic = createRegistryDiagnostic({ stage: 'inspect-before-commit', cause: failure, cleanup });
      if (cleanup.length) Object.defineProperty(failure, 'cleanupCauses', { value: cleanup.map(item => item.cause), configurable: true });
      throw failure;
    }
    return result;
  }
  async function persist(next) {
    if (next.version !== 2) throw error('WORKSPACE_REGISTRY_INVALID', '新工作区配置必须使用当前版本。', registry);
    validateState(next);
    const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    if (bytes.length > MAX_BYTES) throw error('WORKSPACE_REGISTRY_LIMIT', '工作区配置超过容量上限。', registry);
    const temporary = path.join(root, `.workspaces-${randomUUID()}.tmp`);
    let handle, owned, created = false, committed = false, stage = 'verify-before', failure, firstDenied;
    const cleanup = [], retained = [];
    try {
      await unchanged(stage);
      stage = 'open-temporary'; handle = await fs.open(temporary, 'wx', 0o600); created = true;
      stage = 'inspect-temporary'; owned = await handle.stat({ bigint: true });
      stage = 'write-temporary'; await handle.writeFile(bytes);
      stage = 'sync-temporary'; await handle.sync();
      stage = 'close-temporary'; await handle.close(); handle = undefined;
      stage = 'verify-before-commit';
      await unchanged(stage);
      stage = 'inspect-before-commit';
      const currentTemp = await fs.lstat(temporary, { bigint: true });
      if (!sameFile(currentTemp, owned) || !currentTemp.isFile() || currentTemp.isSymbolicLink() || currentTemp.nlink !== 1n) throw error('WORKSPACE_REGISTRY_CHANGED', '写入期间临时配置文件发生变化。', temporary);
      if (token === null) {
        // Hard-link installation is atomic and refuses an unexpected destination.
        stage = 'link-registry';
        await fs.link(temporary, registry);
        committed = true;
        stage = 'remove-installed-temporary';
        await removeOwned(temporary, owned);
      } else {
        // Only a Windows EPERM from the uncommitted replacement is retried.
        // A delay never grants permission to replace a newly changed registry.
        for (let attempt = 0; ; attempt++) {
          stage = 'rename-registry';
          try { await fs.rename(temporary, registry); committed = true; break; }
          catch (cause) {
            if (process.platform !== 'win32' || cause.code !== 'EPERM') throw cause;
            firstDenied ??= cause;
            if (attempt === WINDOWS_RENAME_RETRY_DELAYS.length) throw firstDenied;
          }
          await new Promise(resolve => setTimeout(resolve, WINDOWS_RENAME_RETRY_DELAYS[attempt]));
          stage = 'verify-before-commit'; await unchanged(stage);
          stage = 'inspect-before-commit'; const verified = await inspectRetryTemporary(temporary, owned, bytes);
          // Close the verification handle before replacement, then recheck the
          // original destination and the still-bound parent/name one last time.
          stage = 'verify-before-commit'; await unchanged(stage);
          stage = 'inspect-before-commit';
          const named = await fs.lstat(temporary, { bigint: true });
          if (!sameFile(named, verified) || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1n
            || named.size !== verified.size || named.mtimeNs !== verified.mtimeNs || named.ctimeNs !== verified.ctimeNs) {
            throw error('WORKSPACE_REGISTRY_CHANGED', '重试前暂存配置发生变化。', temporary);
          }
        }
      }
      stage = 'readback-registry';
      const saved = await readRegistry({ stage, committed });
      stage = 'validate-readback';
      if (!saved || hash(Buffer.from(JSON.stringify(saved.value))) !== hash(Buffer.from(JSON.stringify(next)))) throw error('WORKSPACE_REGISTRY_CHANGED', '保存后工作区注册文件发生变化。', registry);
      state = saved.value; token = saved.token;
    } catch (cause) {
      failure = committed
        ? Object.assign(error('WORKSPACE_REGISTRY_COMMIT_UNCERTAIN', '配置已提交但无法确认，请保留现场并检查工作区选择与临时配置。', registry, cause), { committed: true })
        : cause.code?.startsWith('WORKSPACE_') ? cause : error('WORKSPACE_REGISTRY_WRITE_FAILED', '无法保存工作区配置。', registry, cause);
      failure.registryDiagnostic = createRegistryDiagnostic({ stage, committed, cause });
      if (cause.cleanupCauses && failure !== cause) Object.defineProperty(failure, 'cleanupCauses', { value: cause.cleanupCauses.slice(), configurable: true });
      if (committed && stage === 'remove-installed-temporary') retained.push(temporary);
    }
    // Closing or removing a temporary file can fail too. Do not let a second
    // exception erase the operation that failed first, or skip remaining cleanup.
    if (handle) {
      try { await handle.close(); }
      catch (cause) { cleanup.push({ stage: 'close-temporary', cause }); }
    }
    if (created && !committed) {
      if (owned) {
        try { await removeOwned(temporary, owned, firstDenied ? bytes : undefined); }
        catch (cause) { cleanup.push({ stage: 'remove-temporary', cause }); retained.push(temporary); }
      } else {
        // The exclusive create succeeded, but identity acquisition did not. A
        // later lstat cannot prove this name still denotes our original file.
        retained.push(temporary);
      }
    }
    if (failure) {
      if (cleanup.length || retained.length) failure = failedCleanup(failure, cleanup, retained);
      throw failure;
    }
  }
  function view(item) {
    if (!item) return { id: 'default', kind: 'default', label: '默认工作区', workspace: path.join(root, 'workspace'), dataDir: root, secretsDir: path.join(root, 'secrets') };
    const dataDir = path.join(profilesRoot, item.id);
    if (item.kind === 'restored') return { id: item.id, kind: 'restored', label: `恢复的工作区 · ${item.id.slice(0, 8)}`, workspace: path.join(dataDir, 'workspace'), identity: { ...item.identity }, dataIdentity: { ...item.dataIdentity }, dataDir, secretsDir: path.join(dataDir, 'secrets') };
    return { id: item.id, kind: 'external', label: path.basename(item.workspace), workspace: item.workspace, identity: { ...item.identity }, dataDir, secretsDir: path.join(dataDir, 'secrets') };
  }
  async function inspectDirectory(location) {
    const identity = await existingDirectory(location), workspace = identity.canonical;
    if (equalPath(workspace, path.parse(workspace).root) || equalPath(workspace, home) || protectedRoots.some(protectedRoot => overlap(workspace, protectedRoot))) throw error('WORKSPACE_PROTECTED_PATH', '此目录包含应用数据、安装文件，或范围过大，不能作为外部工作区。', workspace);
    const known = state.profiles.find(item => item.kind === 'external' && equalPath(item.workspace, workspace));
    if (known && (known.identity.dev !== identity.dev || known.identity.ino !== identity.ino)) throw error('WORKSPACE_IDENTITY_CHANGED', '此目录已被替换，不能继续使用原工作区历史。', workspace);
    return { id: known?.id ?? null, kind: 'external', workspace, identity };
  }
  async function validateSelected(item) {
    await checkRoot();
    const selected = view(item);
    if (item?.kind === 'restored') {
      for (const [location, expected] of [[selected.dataDir, item.dataIdentity], [selected.workspace, item.identity]]) {
        const found = await existingDirectory(location);
        if (found.canonical !== expected.canonical || found.dev !== expected.dev || found.ino !== expected.ino) throw error('WORKSPACE_IDENTITY_CHANGED', '恢复工作区的目录身份与原绑定不符。', location);
      }
      // A restored profile must never turn a missing database into an empty one.
      const database = path.join(selected.dataDir, 'openaster.sqlite');
      const info = await walk(database, { file: true });
      if (!info.isFile() || info.nlink !== 1n) throw error('WORKSPACE_UNSAFE_PATH', '恢复数据库必须是普通单链接文件。', database);
    } else if (item) {
      const found = await inspectDirectory(item.workspace);
      if (!equalPath(found.workspace, item.identity.canonical) || found.identity.dev !== item.identity.dev || found.identity.ino !== item.identity.ino) throw error('WORKSPACE_IDENTITY_CHANGED', '工作区目录身份与原绑定不符。', item.workspace);
      await walk(selected.dataDir);
    } else await walk(selected.workspace, { missing: true });
    await walk(selected.secretsDir, { missing: true });
    return selected;
  }
  async function ensureProfilesRoot() {
    await checkRoot();
    await walk(profilesRoot, { missing: true });
    try { await fs.mkdir(profilesRoot, { mode: 0o700 }); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    return existingDirectory(profilesRoot);
  }
  async function activateSelection(selection) {
      ready(); await unchanged();
      let item;
      if (typeof selection === 'string') {
        if (selection !== 'default') { item = state.profiles.find(entry => entry.id === selection); if (!item) throw error('WORKSPACE_UNKNOWN_PROFILE', '工作区标识不存在。'); }
      } else {
        if (!shape(selection, ['id', 'kind', 'workspace', 'identity']) || selection.kind !== 'external' || !validIdentity(selection.identity, selection.workspace) || (selection.id !== null && !UUID.test(selection.id))) throw error('WORKSPACE_INVALID_CANDIDATE', '请重新选择并确认工作区目录。');
        const found = await inspectDirectory(selection.workspace);
        if (found.id !== selection.id || found.identity.dev !== selection.identity.dev || found.identity.ino !== selection.identity.ino || !equalPath(found.workspace, selection.workspace)) throw error('WORKSPACE_IDENTITY_CHANGED', '选择后目录发生变化，请重新选择。', selection.workspace);
        item = found.id ? state.profiles.find(entry => entry.id === found.id) : { id: randomUUID(), kind: 'external', workspace: found.workspace, identity: found.identity };
      }
      const isNew = item && !state.profiles.some(entry => entry.id === item.id);
      let created;
      try {
        if (isNew) {
          if (state.profiles.length >= LIMIT) throw error('WORKSPACE_PROFILE_LIMIT', '最多注册 100 个独立工作区。');
          await ensureProfilesRoot();
          const directory = path.join(profilesRoot, item.id);
          await fs.mkdir(directory, { mode: 0o700 }); created = { directory };
          created.identity = await fs.lstat(directory, { bigint: true });
          if (!created.identity.isDirectory() || created.identity.isSymbolicLink()) throw error('WORKSPACE_IDENTITY_CHANGED', '新工作区数据目录身份无法确认。', directory);
        }
        const selected = await validateSelected(item);
        const next = { version: 2, activeId: selected.id, recent: [selected.id, ...state.recent.filter(id => id !== selected.id)], profiles: isNew ? [...state.profiles, item] : state.profiles };
        await persist(next);
        return selected;
      } catch (cause) {
        if (created && !cause.committed) {
          if (!cause.registryDiagnostic) cause.registryDiagnostic = createRegistryDiagnostic({ stage: 'prepare-profile', cause });
          if (!created.identity) throw failedCleanup(cause, [], [created.directory]);
          try {
            await checkRoot(); await walk(profilesRoot);
            const current = await fs.lstat(created.directory, { bigint: true });
            if (!sameFile(current, created.identity) || !current.isDirectory() || current.isSymbolicLink()) throw error('WORKSPACE_CLEANUP_INCOMPLETE', '新工作区数据目录发生变化，已保留该目录。', created.directory);
            // rmdir only removes an empty, still-bound leaf. Unknown contents
            // remain intact; never fall back to recursive removal.
            await fs.rmdir(created.directory);
          } catch (cleanup) { throw failedCleanup(cause, [{ stage: 'remove-profile', cause: cleanup }], [created.directory]); }
        }
        throw cause;
      }
  }

  function projectPath(location) {
    const workspace = absolute(location), name = path.basename(workspace);
    if (!name || name.length > 120 || name === '.' || name === '..' || /[\\/:<>"|?*]/u.test(name)
      || /[ .]$/u.test(name) || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(name)) {
      throw error('WORKSPACE_PROJECT_NAME', '请输入有效的新项目文件夹名称（不需要文件扩展名）。');
    }
    if (equalPath(workspace, home) || equalPath(workspace, path.parse(workspace).root)
      || protectedRoots.some(protectedRoot => overlap(workspace, protectedRoot))) {
      throw error('WORKSPACE_PROTECTED_PATH', '项目文件夹不能包含应用数据、安装文件，或使用受保护的位置。', workspace);
    }
    return workspace;
  }
  async function inspectNewProject(location) {
    if (state.profiles.length >= LIMIT) throw error('WORKSPACE_PROFILE_LIMIT', '最多注册 100 个独立工作区。');
    const requested = projectPath(location), parentIdentity = await existingDirectory(path.dirname(requested));
    const workspace = projectPath(path.join(parentIdentity.canonical, path.basename(requested)));
    try { await fs.lstat(workspace); }
    catch (cause) {
      if (cause.code === 'ENOENT') return { kind: 'new-project', workspace, parentIdentity };
      throw error('WORKSPACE_ACCESS', '无法检查新项目位置。', workspace, cause);
    }
    throw error('WORKSPACE_PROJECT_EXISTS', '此位置已经存在。请输入新的项目文件夹名称；已有文件和目录不会被覆盖。', workspace);
  }
  async function checkProjectCandidate(candidate) {
    if (!shape(candidate, ['kind', 'workspace', 'parentIdentity']) || candidate.kind !== 'new-project'
      || typeof candidate.workspace !== 'string' || !validIdentity(candidate.parentIdentity, path.dirname(candidate.workspace))) {
      throw error('WORKSPACE_INVALID_CANDIDATE', '请重新选择并确认新项目位置。');
    }
    const found = await inspectNewProject(candidate.workspace);
    if (!equalPath(found.workspace, candidate.workspace) || found.parentIdentity.canonical !== candidate.parentIdentity.canonical
      || found.parentIdentity.dev !== candidate.parentIdentity.dev || found.parentIdentity.ino !== candidate.parentIdentity.ino) {
      throw error('WORKSPACE_IDENTITY_CHANGED', '新项目的父目录已被替换，请重新选择。', candidate.workspace);
    }
    return found;
  }
  async function createProject(candidate) {
    ready(); await unchanged();
    const found = await checkProjectCandidate(candidate);let created = false, identity;
    try {
      // A single missing leaf only: mkdir cannot adopt or overwrite any existing path.
      try { await fs.mkdir(found.workspace, { mode: 0o700 }); created = true; }
      catch (cause) { if (cause.code === 'EEXIST') throw error('WORKSPACE_PROJECT_EXISTS', '此位置已经存在；已有文件和目录不会被覆盖。', found.workspace, cause); throw cause; }
      identity = await fs.lstat(found.workspace, { bigint: true });
      if (!identity.isDirectory() || identity.isSymbolicLink()) throw error('WORKSPACE_IDENTITY_CHANGED', '新项目目录身份无法确认。', found.workspace);
      const parent = await existingDirectory(found.parentIdentity.canonical);
      if (parent.dev !== found.parentIdentity.dev || parent.ino !== found.parentIdentity.ino) throw error('WORKSPACE_IDENTITY_CHANGED', '创建期间父目录已改变。', found.workspace);
      const selected = await inspectDirectory(found.workspace);
      if (selected.id !== null || selected.identity.dev !== identity.dev.toString() || selected.identity.ino !== identity.ino.toString()) throw error('WORKSPACE_IDENTITY_CHANGED', '新项目目录在注册前已改变。', found.workspace);
      return await activateSelection(selected);
    } catch (cause) {
      if (created && !cause.committed) {
        try {
          if (!identity) throw error('WORKSPACE_IDENTITY_CHANGED', '无法确认新项目目录身份。');
          const parent = await existingDirectory(found.parentIdentity.canonical);
          if (parent.dev !== found.parentIdentity.dev || parent.ino !== found.parentIdentity.ino) throw error('WORKSPACE_IDENTITY_CHANGED', '项目父目录已改变。');
          await walk(found.workspace);
          const named = await fs.lstat(found.workspace, { bigint: true });
          if (!sameFile(named, identity) || !named.isDirectory() || named.isSymbolicLink()) throw error('WORKSPACE_IDENTITY_CHANGED', '项目目录已改变。');
          await fs.rmdir(found.workspace); // Never remove unknown contents recursively.
        } catch (cleanup) {
          const retained = error('WORKSPACE_PROJECT_RETAINED', '新项目尚未确认创建完成，已保留该目录供检查；不会删除其中的内容。', found.workspace, cause);
          retained.projectPath = found.workspace;
          Object.defineProperty(retained, 'cleanupCause', { value: cleanup });
          throw retained;
        }
      }
      if (created && cause.committed) cause.projectPath = found.workspace;
      throw cause;
    }
  }

  return {
    initialize: () => serialized(async () => {
      if (state) return state.recent.map(id => view(state.profiles.find(item => item.id === id)));
      await walk(path.dirname(requestedData));
      try { await fs.mkdir(requestedData, { mode: 0o700 }); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      rootIdentity = await existingDirectory(requestedData); root = rootIdentity.canonical;
      registry = path.join(root, 'workspaces.json'); profilesRoot = path.join(root, 'profiles');
      home = (await existingDirectory(requestedHome)).canonical;
      protectedRoots = [root];
      for (const appRoot of requestedApps) { await walk(appRoot, { file: true }); protectedRoots.push(await fs.realpath(appRoot)); }
      const loaded = await readRegistry(); token = loaded?.token ?? null;
      if (loaded?.value.version === 1) {
        // Validate v1 before adding kind. No directory, history, identity or order
        // changes are part of this atomic format migration.
        await persist({ ...loaded.value, version: 2, profiles: loaded.value.profiles.map(item => ({ ...item, kind: 'external' })) });
      } else if (loaded) state = loaded.value;
      else await persist({ version: 2, activeId: 'default', recent: ['default'], profiles: [] });
      return state.recent.map(id => view(state.profiles.find(item => item.id === id)));
    }),
    list: () => serialized(async () => { ready(); return state.recent.map(id => view(state.profiles.find(item => item.id === id))); }),
    inspect: location => serialized(async () => { ready(); await unchanged(); return inspectDirectory(location); }),
    getActive: () => serialized(async () => { ready(); await unchanged(); return validateSelected(state.profiles.find(item => item.id === state.activeId)); }),
    activate: selection => serialized(() => activateSelection(selection)),
    prepareProject: location => serialized(async () => { ready(); await unchanged(); return inspectNewProject(location); }),
    createProject: candidate => serialized(() => createProject(candidate)),
    createRestored: options => serialized(async () => {
      ready(); await unchanged();
      if (!shape(options, ['restore']) || typeof Object.getOwnPropertyDescriptor(options, 'restore')?.value !== 'function') throw error('WORKSPACE_INVALID_RESTORE', '恢复操作必须由受信任的桌面流程提供。');
      if (state.profiles.length >= LIMIT) throw error('WORKSPACE_PROFILE_LIMIT', '最多注册 100 个独立工作区。');
      const parentIdentity = await ensureProfilesRoot();
      let id;
      do { id = randomUUID(); } while (state.profiles.some(item => item.id === id));
      const dataDir = path.join(profilesRoot, id);
      if (await walk(dataDir, { missing: true })) throw error('WORKSPACE_RESTORE_EXISTS', '恢复目标已存在；不会接入或覆盖已有数据。', dataDir);
      await unchanged();
      // restoreBackup exclusively creates this missing leaf and owns its failure
      // cleanup. Never pre-create it, adopt an existing DB, or recursively delete.
      let result;
      try { result = await options.restore({ dataDir }); }
      catch (cause) {
        // A worker can exit before the restore routine reports its own cleanup.
        // Only establish absence through the original, still-bound parent. A
        // link, replacement or inaccessible path is a site to inspect, never a
        // complete restore to adopt or an owned tree to remove.
        let absent = false;
        try {
          await checkRoot();
          const before = await existingDirectory(profilesRoot);
          if (!equalPath(before.canonical, parentIdentity.canonical) || before.dev !== parentIdentity.dev || before.ino !== parentIdentity.ino) throw error('WORKSPACE_IDENTITY_CHANGED', '恢复期间工作区父目录发生变化。', profilesRoot);
          try { await fs.lstat(dataDir, { bigint: true }); }
          catch (inspection) { if (inspection.code !== 'ENOENT') throw inspection; absent = true; }
          await checkRoot();
          const after = await existingDirectory(profilesRoot);
          if (!equalPath(after.canonical, parentIdentity.canonical) || after.dev !== parentIdentity.dev || after.ino !== parentIdentity.ino) throw error('WORKSPACE_IDENTITY_CHANGED', '恢复期间工作区父目录发生变化。', profilesRoot);
        } catch { absent = false; }
        if (!absent) Object.assign(cause, { orphanPath: dataDir, partialRestore: true });
        throw cause;
      }
      try {
        await checkRoot();
        const parent = await existingDirectory(profilesRoot);
        if (parent.canonical !== parentIdentity.canonical || parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino) throw error('WORKSPACE_IDENTITY_CHANGED', '恢复期间工作区父目录发生变化。', profilesRoot);
        const dataIdentity = await existingDirectory(dataDir);
        const identity = await existingDirectory(path.join(dataDir, 'workspace'));
        const item = { id, kind: 'restored', identity, dataIdentity };
        const profile = await validateSelected(item);
        await persist({ version: 2, activeId: id, recent: [id, ...state.recent], profiles: [...state.profiles, item] });
        return { profile, result };
      } catch (cause) {
        // The callback already completed. Preserve every restored/unknown file
        // even if registration failed or its commit cannot be confirmed.
        throw Object.assign(cause, { orphanPath: dataDir, restoreResult: result });
      }
    }),
  };
}
