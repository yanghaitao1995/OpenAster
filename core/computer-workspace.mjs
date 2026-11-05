// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { createWorkspace } from './workspace.mjs';
import { CoreError, checkAbort } from './errors.mjs';
import { validateOperationPath, pathWithin } from './access-path.mjs';
import { isSensitiveSegment } from './sensitive-paths.mjs';

// File access is granted by the authenticated human UI, never model arguments.
// Shell still has current-account privileges and always has its own exact approval.
export function createComputerWorkspace({ workspace, getFileAccess, protectedRoots = [] }) {
  if (!workspace?.root || typeof getFileAccess !== 'function') throw new TypeError('Invalid file access dependencies');
  const roots = protectedRoots.map(root => path.resolve(root));
  const proposals = new WeakMap();
  const denied = () => new CoreError('COMPUTER_ACCESS_REQUIRED', '此路径位于工作区外。请由用户在设置中授予电脑文件访问权限后再操作。', 403);
  const protectedPath = location => roots.some(root => pathWithin(root, location));
  const canonicalProtectedRoots = () => Promise.all(roots.map(root=>realpath(root)));
  const relative = (root, location) => path.relative(root, location).split(path.sep).join('/');
  function target(value, { empty = false } = {}) {
    const validated = validateOperationPath(value, { empty });
    const location = path.isAbsolute(validated) ? validated : path.resolve(workspace.root, validated);
    if (pathWithin(workspace.root, location)) return { external: false, location, path: relative(workspace.root, location) };
    if (getFileAccess() !== 'computer') throw denied();
    if (protectedPath(location) || location.split(path.sep).some(isSensitiveSegment)) throw new CoreError('PROTECTED_PATH', '应用数据、凭据及敏感目录不允许由文件工具访问。', 403);
    return { external: true, location };
  }
  async function checkCanonical(location) {
    let ancestor=location; const missing=[];
    for(;;) {
      try { await lstat(ancestor); break; }
      catch(cause) { if(cause.code!=="ENOENT")throw cause; const parent=path.dirname(ancestor); if(parent===ancestor)throw cause; missing.unshift(path.basename(ancestor));ancestor=parent; }
    }
    const canonical=path.join(await realpath(ancestor),...missing);
    for(const root of roots) {
      const actual=await realpath(root);
      if(pathWithin(actual,canonical))throw new CoreError("PROTECTED_PATH","应用数据、凭据及敏感目录不允许由文件工具访问。",403);
    }
    const key=value=>process.platform==="win32"?path.resolve(value).toLowerCase():path.resolve(value);
    if(key(canonical)!==key(location))throw new CoreError("UNSAFE_PATH","请使用规范路径，文件工具不接受路径别名或重定向。",403);
  }
  async function recheck(value) { if (!target(value).external) throw new CoreError("FILE_SCOPE_CHANGED", "文件访问范围已改变，请重新请求操作。", 409); await checkCanonical(value); }
  const externalAdapter = root => createWorkspace(root, { createRoot: false, denySensitivePaths: true, projectScan: true });
  async function fileTarget(value) {
    const result = target(value);
    if (!result.external) return { ...result, adapter: workspace };
    await checkCanonical(result.location);
    let root = path.dirname(result.location);
    // Use an existing ancestor; only an approved write may create missing parents.
    for (;;) {
      try { const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError('UNSAFE_PATH', '文件父目录不是普通目录。', 403); break; }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; const parent = path.dirname(root); if (parent === root) throw cause; root = parent; }
    }
    return { ...result, path: relative(root, result.location), adapter: externalAdapter(root) };
  }
  async function prepare(method, args, options) {
    const resolved = await fileTarget(args.path);
    const original = await resolved.adapter[method]({ ...args, path: resolved.path }, options);
    if (!resolved.external) return original;
    try { await recheck(resolved.location); }
    catch (cause) { resolved.adapter.discardWrite(original); throw cause; }
    const proposal = Object.freeze({ ...original, path: resolved.location });
    proposals.set(proposal, { ...resolved, original });
    return proposal;
  }
  async function browse(options = {}) {
    const resolved = target(options.path ?? '', { empty: true });
    if (!resolved.external) return workspace.list({ ...options, path: resolved.path });
    // Global browsing is deliberately one directory at a time; no drive-wide walk.
    await checkCanonical(resolved.location);
    const result = await externalAdapter(resolved.location).directory({ ...options, path: '' });
    await recheck(resolved.location);
    const actualProtected=await canonicalProtectedRoots();
    const files = result.files.filter(file => !protectedPath(path.resolve(resolved.location, file.path))&&!actualProtected.some(root=>pathWithin(root,path.resolve(resolved.location,file.path))))
      .map(file => ({ ...file, path: path.resolve(resolved.location, file.path) }));
    return { ...result, files, scope: resolved.location, listing: 'children', excludedProtectedEntries: result.files.length - files.length };
  }
  return Object.freeze({
    ...workspace,
    pathKey(value) { return target(value).location; },
    permissionSummary() { return `Current workspace: ${workspace.root}. Human-granted file access: ${getFileAccess() === 'computer' ? 'computer: absolute local file paths are allowed, excluding credentials/application data; global directory listings show direct children' : 'workspace: file tools are limited to this directory'}. Every write and shell command still requires explicit approval. Python, git and other installed programs can be invoked with run_command. Permission changes are available only to the human, never through tools.`; },
    list: browse,
    async read(value, options) { const resolved = await fileTarget(value); const result = await resolved.adapter.read(resolved.path, options); if (resolved.external) await recheck(resolved.location); return { ...result, path: resolved.external ? resolved.location : resolved.path }; },
    async search(query, options = {}) {
      const resolved = target(options.path ?? '', { empty: true });
      if (!resolved.external) return workspace.search(query, { ...options, path: resolved.path });
      await checkCanonical(resolved.location);
      if ((await canonicalProtectedRoots()).some(root=>pathWithin(resolved.location,root))) throw new CoreError('SEARCH_SCOPE_REQUIRED', '请缩小搜索目录，避免递归读取包含应用数据的父目录。', 403);
      const result = await externalAdapter(resolved.location).search(query, { ...options, path: '' });
      await recheck(resolved.location);
      return { ...result, scope: resolved.location, matches: result.matches.map(match => ({ ...match, path: path.resolve(resolved.location, match.path) })) };
    },
    prepareWrite: (args, options) => prepare('prepareWrite', args, options),
    prepareEdit: (args, options) => prepare('prepareEdit', args, options),
    async commitWrite(proposal, options) {
      const prepared = proposals.get(proposal);
      if (!prepared) return workspace.commitWrite(proposal, options);
      proposals.delete(proposal);
      try { await recheck(prepared.location); checkAbort(options?.signal); const result = await prepared.adapter.commitWrite(prepared.original, options); return { ...result, path: prepared.location }; }
      finally { prepared.adapter.discardWrite(prepared.original); }
    },
    discardWrite(proposal) { const prepared = proposals.get(proposal); if (prepared) { proposals.delete(proposal); prepared.adapter.discardWrite(prepared.original); } else workspace.discardWrite(proposal); },
    async commandDirectory(value = '', options) {
      const resolved = target(value, { empty: true });
      if (!resolved.external) return workspace.commandDirectory(resolved.path, options);
      await checkCanonical(resolved.location);
      const result = await externalAdapter(resolved.location).commandDirectory('', options);
      await recheck(resolved.location); return result;
    },
  });
}
