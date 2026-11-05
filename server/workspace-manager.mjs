// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreError } from '../core/errors.mjs';
import { isSensitiveSegment } from '../core/sensitive-paths.mjs';

const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (root, target) => { const p = path.relative(key(root), key(target)); return !p || p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p); };
const fail = (code, message, status = 400) => { throw new CoreError(code, message, status); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) { if (!plain(value) || Object.keys(value).some(name => !allowed.includes(name))) fail('INVALID_PROJECT_REQUEST', '项目请求包含无效字段。'); }
function absolute(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/u.test(value) || value.split(/[\\/]/u).includes('..') ||
      process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/u.test(value) || /[:<>"|?*]/u.test(value.slice(2)) || value.slice(3).split(/[\\/]/u).some(part => /[ .]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)))) fail('WORKSPACE_INVALID_PATH', '请输入服务主机上的有效绝对目录路径。');
  return path.resolve(value);
}
function projectName(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value !== value.trim() || !value || value.length > 100 || /[\\/:<>"|?*\x00-\x1f\x7f]/u.test(value) || /^[.]/u.test(value) || /[ .]$/u.test(value) || isSensitiveSegment(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)) fail('INVALID_PROJECT_NAME', '项目名称须为 1–100 个字符，不能含路径分隔符、保留名称或以点开头。');
  return value;
}
export async function inspectProjectDirectory(location) {
  const lexical = absolute(location), parsed = path.parse(lexical);
  let cursor = parsed.root, final;
  for (const part of ['', ...path.relative(parsed.root, lexical).split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    final = await fs.lstat(cursor, { bigint: true });
    if (!final.isDirectory() || final.isSymbolicLink()) fail('WORKSPACE_UNSAFE_PATH', '目录及其上级不能是符号链接或目录联接。', 403);
  }
  const canonical = await fs.realpath(lexical), after = await fs.lstat(canonical, { bigint: true });
  if (after.dev !== final.dev || after.ino !== final.ino || after.ino === 0n) fail('WORKSPACE_IDENTITY_CHANGED', '目录身份发生变化，请重新选择。', 409);
  return { canonical, dev: after.dev.toString(), ino: after.ino.toString() };
}
function same(a, b) { return a.canonical === b.canonical && a.dev === b.dev && a.ino === b.ino; }
function view(profile) { return { id: profile.id, name: profile.label || path.basename(profile.workspace), path: profile.workspace, kind: profile.kind }; }

/** Authenticated server routes own access control. This module never reads file contents.
 * transition(commit) must stop the old service with its atomic idle gate before commit(). */
export function createWorkspaceManager({ profiles, getCurrent, transition, projectsRoot, homeDirectory, protectedRoots = [], now = Date.now }) {
  const managedRoot = absolute(projectsRoot), home = absolute(homeDirectory), protectedPaths = protectedRoots.map(absolute);
  const tickets = new Map(), operations = new Map();
  let pending = null;
  const current = async () => getCurrent();
  const denied = location => location.split(/[\\/]/u).some(isSensitiveSegment);
  const protectedLocation = location => protectedPaths.some(root => inside(root, location));
  const prune = () => { for (const [id, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(id); };
  const convert = cause => {
    if (cause instanceof CoreError) return cause;
    const code = /^WORKSPACE_[A-Z_]+$/u.test(cause?.code || '') ? cause.code : cause?.code === 'ENOENT' ? 'WORKSPACE_MISSING' : 'WORKSPACE_ACCESS';
    return new CoreError(code, /^WORKSPACE_/u.test(cause?.code || '') ? cause.message : '无法访问项目目录，请检查路径和权限。', /PROTECTED|UNSAFE/u.test(code) ? 403 : /EXISTS|IDENTITY|CHANGED|BUSY/u.test(code) ? 409 : 400);
  };
  async function roots(remote) {
    const entries = await profiles.list(), result = [{ id: 'projects', name: '项目目录', path: managedRoot, create: true }];
    if (!remote && key(home) !== key(managedRoot)) result.push({ id: 'home', name: '主机用户目录', path: home, create: true });
    for (const item of entries) if (!result.some(root => key(root.path) === key(item.workspace))) result.push({ id: `profile:${item.id}`, name: item.label, path: item.workspace, create: true, registered: true });
    return result;
  }
  async function rootTarget(value, remote) {
    if (typeof value.rootId !== 'string' || typeof (value.path ?? '') !== 'string') fail('INVALID_PROJECT_REQUEST', '请选择项目根目录。');
    const root = (await roots(remote)).find(item => item.id === value.rootId);
    if (!root) fail('PROJECT_ROOT_UNAVAILABLE', '此项目根目录不可用于当前连接。', 403);
    const relative = value.path ?? '';
    if (!relative.isWellFormed() || relative.length > 4096 || path.isAbsolute(relative) || /[\\:\x00-\x1f\x7f]/u.test(relative) || relative.split('/').some(part => part === '.' || part === '..' || isSensitiveSegment(part))) fail('WORKSPACE_INVALID_PATH', '请选择当前根目录内的普通子目录。');
    const target = absolute(path.join(root.path, relative));
    if (!inside(root.path, target) || !root.registered && (denied(target) || protectedLocation(target))) fail('WORKSPACE_PROTECTED_PATH', '此位置不属于可管理的项目目录。', 403);
    return { root, target, relative };
  }
  async function ensureManagedRoot() {
    try { return await inspectProjectDirectory(managedRoot); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      if (denied(managedRoot) || protectedLocation(managedRoot)) fail('WORKSPACE_PROTECTED_PATH', '项目根目录配置不安全。', 403);
      const before = await inspectProjectDirectory(path.dirname(managedRoot));
      try { await fs.mkdir(managedRoot, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!same(before, await inspectProjectDirectory(path.dirname(managedRoot)))) fail('WORKSPACE_IDENTITY_CHANGED', '项目父目录发生变化。', 409);
      return inspectProjectDirectory(managedRoot);
    }
  }
  return {
    get busy() { return Boolean(pending); },
    async list({ remote = false } = {}) {
      try { return { version: 1, location: 'service-host', current: view(await current()), roots: (await roots(remote)).map(({ registered, ...root }) => root), projects: (await profiles.list()).map(view), allowAbsolutePath: !remote, pendingOperation: pending }; }
      catch (cause) { throw convert(cause); }
    },
    async browse(value, { remote = false } = {}) {
      fields(value, ['rootId', 'path']);
      try {
        const { root, target, relative } = await rootTarget(value, remote);
        let identity;
        try { identity = await inspectProjectDirectory(target); }
        catch (cause) { if (cause.code === 'ENOENT' && root.id === 'projects' && !relative) return { version: 1, rootId: root.id, path: '', hostPath: target, exists: false, directories: [], truncated: false }; throw cause; }
        const directories = []; let count = 0, truncated = false;
        const handle = await fs.opendir(target);
        try {
          for await (const entry of handle) {
            if (++count > 2000) { truncated = true; break; }
            if (!entry.isDirectory() || entry.isSymbolicLink() || isSensitiveSegment(entry.name) || entry.name.startsWith('.')) continue;
            const location = path.join(target, entry.name);
            if (!root.registered && protectedLocation(location)) continue;
            try { await inspectProjectDirectory(location); } catch { continue; }
            directories.push({ name: entry.name, path: relative ? `${relative}/${entry.name}` : entry.name });
            if (directories.length >= 500) { truncated = true; break; }
          }
        } finally { await handle.close().catch(() => {}); }
        if (!same(identity, await inspectProjectDirectory(target))) fail('WORKSPACE_IDENTITY_CHANGED', '浏览期间目录发生变化，请刷新。', 409);
        directories.sort((a, b) => a.name.localeCompare(b.name));
        return { version: 1, rootId: root.id, path: relative, hostPath: identity.canonical, exists: true, directories, truncated };
      } catch (cause) { throw convert(cause); }
    },
    async prepare(value, { remote = false, owner } = {}) {
      fields(value, ['action', 'id', 'absolutePath', 'rootId', 'path', 'name']);
      if (!['open', 'create', 'switch'].includes(value.action) || typeof owner !== 'string' || !owner) fail('INVALID_PROJECT_REQUEST', '项目操作无效。');
      if (pending) fail('WORKSPACE_BUSY', '另一次项目切换尚未结束。', 409);
      prune(); if (tickets.size >= 64) fail('PROJECT_REQUEST_LIMIT', '待确认的项目过多，请稍后重试。', 429);
      try {
        let candidate, targetPath;
        if (value.action === 'switch') {
          fields(value, ['action', 'id']);
          const target = (await profiles.list()).find(item => item.id === value.id);
          if (!target) fail('WORKSPACE_UNKNOWN_PROFILE', '项目不存在。', 404);
          candidate = target.kind === 'external' ? await profiles.inspect(target.workspace) : target.id;
          targetPath = target.workspace;
        } else {
          fields(value, value.action === 'create' ? ['action', 'rootId', 'path', 'name'] : ['action', 'rootId', 'path', 'absolutePath']);
          const name = value.action === 'create' ? projectName(value.name) : null;
          let target;
          if (value.absolutePath !== undefined) {
            if (remote || value.rootId !== undefined || value.path !== undefined) fail('LOCAL_PROJECT_PATH_REQUIRED', '远程连接只能选择主机公布的项目目录。', 403);
            target = absolute(value.absolutePath);
          } else {
            const resolved = await rootTarget(value, remote); target = resolved.target;
            if (name && resolved.root.id === 'projects' && !resolved.relative) await ensureManagedRoot();
          }
          if (denied(target)) fail('WORKSPACE_PROTECTED_PATH', '敏感目录不能作为项目。', 403);
          targetPath = name ? path.join(target, name) : target;
          candidate = name ? await profiles.prepareProject(targetPath) : await profiles.inspect(targetPath);
        }
        const selected = await current(), id = randomUUID(), expiresAt = now() + 300000;
        tickets.set(id, { action: value.action, candidate, targetPath, owner, currentId: selected.id, currentPath: selected.workspace, expiresAt });
        return { version: 1, ticket: id, action: value.action, path: targetPath, name: path.basename(targetPath), expiresAt, alreadyActive: key(selected.workspace) === key(targetPath) };
      } catch (cause) { throw convert(cause); }
    },
    async reserve(value, { owner } = {}) {
      fields(value, ['ticket']); prune();
      if (pending) fail('WORKSPACE_BUSY', '另一次项目切换尚未结束。', 409);
      const ticket = tickets.get(value.ticket);
      if (!ticket || ticket.owner !== owner) fail('PROJECT_TICKET_EXPIRED', '项目选择已失效，请重新选择。', 409);
      const selected = await current();
      if (pending || tickets.get(value.ticket) !== ticket || ticket.expiresAt <= now()) fail('WORKSPACE_BUSY', '项目选择已被处理，请重新选择。', 409);
      if (selected.id !== ticket.currentId || selected.workspace !== ticket.currentPath) fail('WORKSPACE_IDENTITY_CHANGED', '当前项目已经改变，请重新选择。', 409);
      tickets.delete(value.ticket);
      const id = randomUUID(), operation = { id, status: 'pending', path: ticket.targetPath, error: null };
      operations.set(id, operation); pending = id;
      while (operations.size > 20) operations.delete(operations.keys().next().value);
      let started = false;
      return { id, async run() {
        if (started) return; started = true; operation.status = 'running';
        try {
          const commit = () => ticket.action === 'create' ? profiles.createProject(ticket.candidate) : profiles.activate(ticket.candidate);
          const result = await transition(commit);
          if (result === false) fail('WORKSPACE_BUSY', '项目未切换，请先结束当前操作。', 409);
          operation.status = 'completed';
        } catch (cause) { const failure = convert(cause); operation.status = 'failed'; operation.error = { code: failure.code, message: failure.message }; }
        finally { pending = null; }
      } };
    },
    operation(id) {
      const operation = operations.get(id);
      if (!operation) fail('PROJECT_OPERATION_UNKNOWN', '项目操作记录已失效，请查看当前项目。', 404);
      return { ...operation, error: operation.error ? { ...operation.error } : null };
    },
  };
}
