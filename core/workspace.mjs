import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CoreError, checkAbort } from './errors.mjs';
import { isSensitiveSegment as sensitiveSegment } from './sensitive-paths.mjs';
import { createLiteralMatcher, validateSearchQuery, validateSearchCaseSensitive } from './workspace-search.mjs';
import { compileGitignore, matchRules, createIgnoreBudget, GITIGNORE_LIMITS } from './workspace-ignore.mjs';

export const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 1000;
const MAX_DIRECTORY_ENTRIES = 10000;
const SCAN_METADATA_CONCURRENCY = 4;
const MAX_DEPTH = 16;
const MAX_SEARCH_FILES = 100;
const MAX_SEARCH_MATCHES = 100;
const WINDOWS_RENAME_DELAYS = [25, 75, 150];
const WINDOWS_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const SCAN_LIMITS = ['entries', 'directory-entries', 'depth', 'search-files', 'search-matches'];
const GENERATED_DIRECTORIES = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.cache', '.next', '.nuxt', '.turbo', 'coverage', 'dist', 'build', 'target', 'vendor']);
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
// ignoreBOM means the decoder preserves U+FEFF as text instead of stripping the
// original UTF-8 signature. Exact edits must round-trip every untouched byte.
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function absoluteDirectory(value) {
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && path.isAbsolute(value);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function within(parent, child) {
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlaps(a, b) { return within(a, b) || within(b, a); }

function validateIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !Object.hasOwn(value, 'canonical') || !Object.hasOwn(value, 'dev') || !Object.hasOwn(value, 'ino')
    || !absoluteDirectory(value.canonical) || ![value.dev, value.ino].every(part => typeof part === 'string' && /^(?:0|[1-9]\d{0,39})$/u.test(part))) {
    throw new CoreError('INVALID_WORKSPACE', '工作区目录身份无效。');
  }
  return Object.freeze({ canonical: path.resolve(value.canonical), dev: value.dev, ino: value.ino });
}

function sameIdentity(a, b) {
  return comparablePath(a.canonical) === comparablePath(b.canonical) && a.dev === b.dev && a.ino === b.ino;
}

// A nonexistent child still has a canonical location beneath its nearest existing ancestor.
async function canonicalLocation(directory) {
  const suffix = [];
  let candidate = directory;
  while (true) {
    try { return path.join(await fs.realpath(candidate), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value.length > 512 || /[\\\x00-\x1f\x7f<>:"|?*]/u.test(value) || value.includes('%')) {
    throw new CoreError('INVALID_PATH', '请使用工作区内的相对路径及普通文件名。');
  }
  const segments = value.split('/');
  if (segments.length > MAX_DEPTH || segments.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || RESERVED.test(part) || part.length > 128)) {
    throw new CoreError('INVALID_PATH', '路径包含不允许的片段。');
  }
  if (segments.some(part => part.toLowerCase().startsWith('.openaster-'))) throw new CoreError('INVALID_PATH', '该文件名前缀保留给应用内部使用。');
  return segments.join('/');
}

function decode(buffer) {
  if (buffer.includes(0)) throw new CoreError('BINARY_FILE', '仅支持 UTF-8 文本文件。');
  try { return textDecoder.decode(buffer); }
  catch { throw new CoreError('BINARY_FILE', '文件不是有效的 UTF-8 文本。'); }
}

export function validateContent(content) {
  if (typeof content !== 'string' || !content.isWellFormed() || content.includes('\0')) throw new CoreError('INVALID_CONTENT', '内容必须是 UTF-8 文本。');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new CoreError('FILE_TOO_LARGE', '单个文本文件不能超过 256 KiB。', 413);
  return Buffer.from(content, 'utf8');
}

function waitForRenameRetry(milliseconds, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      try { checkAbort(signal); resolve(); } catch (error) { reject(error); }
    }, milliseconds);
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new CoreError('CANCELLED', '任务已取消。', 409));
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Workspace boundary. Rechecks do not constitute an OS sandbox against hostile local processes. */
export function createWorkspace(root, options = {}) {
  if (!absoluteDirectory(root)) throw new CoreError('INVALID_WORKSPACE', '工作区必须是绝对目录。');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new CoreError('INVALID_WORKSPACE', '工作区选项无效。');
  const { createRoot = true, expectedIdentity, protectedRoots = [], denySensitivePaths = false, projectScan = false } = options;
  if (typeof createRoot !== 'boolean' || typeof denySensitivePaths !== 'boolean' || typeof projectScan !== 'boolean' || !Array.isArray(protectedRoots) || !Array.from(protectedRoots).every(absoluteDirectory)) {
    throw new CoreError('INVALID_WORKSPACE', '工作区选项无效。');
  }
  const expected = expectedIdentity === undefined ? undefined : validateIdentity(expectedIdentity);
  const absoluteRoot = path.resolve(root);
  const protectedDirectories = protectedRoots.map(directory => path.resolve(directory));
  const rootSegments = path.relative(path.parse(absoluteRoot).root, absoluteRoot).split(path.sep);
  let canonicalRoot;
  let rootIdentity;
  const rootErrors = new WeakSet();
  const proposals = new Map();
  const replacementModes = new WeakMap();
  let writeQueue = Promise.resolve();

  function validateAccessPath(relative) {
    // Check before the reserved internal-name rule so denied paths have one explicit error.
    if (denySensitivePaths && typeof relative === 'string' && relative.split('/').some(sensitiveSegment)) {
      throw new CoreError('SENSITIVE_PATH', '该路径属于工作区禁止访问的敏感文件或目录。', 403);
    }
    return validateRelativePath(relative);
  }

  async function checkProtected(real) {
    for (const protectedRoot of protectedDirectories) {
      if (overlaps(absoluteRoot, protectedRoot)) throw new CoreError('PROTECTED_WORKSPACE', '工作区不能与应用或受保护目录重叠。', 403);
      let protectedCanonical;
      try {
        if (!(await fs.stat(protectedRoot)).isDirectory()) throw new Error('not a directory');
        protectedCanonical = await fs.realpath(protectedRoot);
      } catch { throw new CoreError('INVALID_WORKSPACE', '受保护目录不可用，无法确认工作区边界。', 403); }
      if (overlaps(real, protectedCanonical)) throw new CoreError('PROTECTED_WORKSPACE', '工作区不能与应用或受保护目录重叠。', 403);
    }
  }

  async function inspectRoot() {
    let candidate = path.parse(absoluteRoot).root;
    let stat;
    for (const segment of ['', ...rootSegments.filter(Boolean)]) {
      if (segment) candidate = path.join(candidate, segment);
      stat = await fs.lstat(candidate, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CoreError('UNSAFE_PATH', '工作区及其父目录不能是符号链接或重定向目录。', 403);
    }
    return stat;
  }

  async function ensureRoot() {
    try {
      if (denySensitivePaths && rootSegments.some(sensitiveSegment)) throw new CoreError('SENSITIVE_PATH', '不能将敏感目录或其内部目录选为工作区。', 403);
      // Validate protected boundaries before any initial directory creation.
      if (protectedDirectories.length) await checkProtected(await canonicalLocation(absoluteRoot));
      if (createRoot && !rootIdentity && !expected) await fs.mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
      const stat = createRoot ? await fs.lstat(absoluteRoot, { bigint: true }) : await inspectRoot();
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError('UNSAFE_PATH', '工作区不能是符号链接或重定向目录。', 403);
      const real = await fs.realpath(absoluteRoot);
      const after = await fs.lstat(absoluteRoot, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) {
        throw new CoreError('WORKSPACE_CHANGED', '工作区目录已被替换，需要重新选择工作区。', 409);
      }
      const identity = Object.freeze({ canonical: real, dev: String(stat.dev), ino: String(stat.ino) });
      if ((expected && !sameIdentity(identity, expected)) || (rootIdentity && !sameIdentity(identity, rootIdentity))) {
        throw new CoreError('WORKSPACE_CHANGED', '工作区目录已被替换，需要重新选择工作区。', 409);
      }
      if (protectedDirectories.length) await checkProtected(real);
      canonicalRoot ??= real;
      rootIdentity ??= identity;
      return rootIdentity;
    } catch (error) {
      if (error.code === 'ENOENT') {
        error = rootIdentity || expected
          ? new CoreError('WORKSPACE_CHANGED', '已绑定的工作区目录不可用，需要重新选择工作区。', 409)
          : new CoreError('WORKSPACE_MISSING', '所选工作区目录不存在。', 404);
      }
      // Root failures must never be mistaken for a skippable child-file error.
      rootErrors.add(error);
      throw error;
    }
  }

  async function getIdentity() { return ensureRoot(); }

  async function resolve(relative, { allowMissing = false, makeParents = false } = {}) {
    const normalized = validateAccessPath(relative);
    await ensureRoot();
    let target = absoluteRoot;
    const segments = normalized.split('/');
    for (let i = 0; i < segments.length; i++) {
      target = path.join(target, segments[i]);
      let stat;
      try { stat = await fs.lstat(target); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (makeParents && i < segments.length - 1) {
          try { await fs.mkdir(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
          stat = await fs.lstat(target);
        } else if (allowMissing) continue;
        else throw new CoreError('FILE_NOT_FOUND', '工作区文件不存在。', 404);
      }
      if (!stat) continue;
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new CoreError('UNSAFE_PATH', '禁止访问符号链接、重定向和特殊文件。', 403);
      if (i < segments.length - 1 && !stat.isDirectory()) throw new CoreError('INVALID_PATH', '路径的父级不是文件夹。');
      if (stat.isFile() && stat.nlink > 1) throw new CoreError('UNSAFE_PATH', '禁止访问硬链接文件。', 403);
      const real = await fs.realpath(target);
      const rel = path.relative(canonicalRoot, real);
      if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) throw new CoreError('UNSAFE_PATH', '路径超出工作区。', 403);
    }
    return target;
  }

  async function snapshot(relative, missing = false) {
    const target = await resolve(relative, { allowMissing: missing });
    let handle;
    try {
      handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1) throw new CoreError('UNSAFE_PATH', '目标必须是普通且未链接的文件。', 403);
      if (stat.size > MAX_FILE_BYTES) throw new CoreError('FILE_TOO_LARGE', '文件超过 256 KiB 文本读取限制。', 413);
      // Bounded reads also remain bounded if another process grows the file after stat().
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > MAX_FILE_BYTES) throw new CoreError('FILE_TOO_LARGE', '文件超过 256 KiB 文本读取限制。', 413);
      await resolve(relative);
      const now = await fs.lstat(target);
      if (now.dev !== stat.dev || now.ino !== stat.ino) throw new CoreError('FILE_CHANGED', '读取期间文件已被替换，请重试。', 409);
      const buffer = bytes.subarray(0, count);
      return { hash: digest(buffer), content: decode(buffer), bytes: count, mode: stat.mode };
    } catch (error) {
      if (error.code === 'EISDIR') throw new CoreError('UNSAFE_PATH', '目标必须是普通且未链接的文件。', 403);
      if (error.code === 'ENOENT') {
        await ensureRoot();
        if (missing) return null;
        throw new CoreError('FILE_NOT_FOUND', '工作区文件不存在。', 404);
      }
      throw error;
    } finally { await handle?.close(); }
  }

  function scanOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new CoreError('INVALID_SCAN_OPTIONS', '目录扫描选项无效。');
    const { signal, path: scope = '', includeGenerated = false, includeIgnored = false } = options;
    if (typeof scope !== 'string') throw new CoreError('INVALID_PATH', '扫描范围必须是工作区内的相对目录。');
    if (typeof includeGenerated !== 'boolean') throw new CoreError('INVALID_SCAN_OPTIONS', '是否包含生成目录必须是布尔值。');
    if (typeof includeIgnored !== 'boolean') throw new CoreError('INVALID_SCAN_OPTIONS', '是否包含已忽略项必须是布尔值。');
    if (scope) validateAccessPath(scope);
    return { signal, scope, includeGenerated, includeIgnored };
  }

  async function resolveDirectory(relative) {
    const target = relative ? await resolve(relative) : (await ensureRoot(), absoluteRoot);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new CoreError('UNSAFE_PATH', '禁止访问符号链接或重定向目录。', 403);
    if (!stat.isDirectory()) throw new CoreError('NOT_DIRECTORY', '扫描范围必须是目录。');
    return target;
  }

  async function commandDirectory(relative = '', { signal } = {}) {
    checkAbort(signal);
    if (typeof relative !== 'string') throw new CoreError('INVALID_PATH', '命令工作目录必须是工作区内的相对目录。');
    const target = await resolveDirectory(relative), before = await fs.lstat(target, { bigint: true });
    const canonical = await fs.realpath(target);
    await resolveDirectory(relative);
    const after = await fs.lstat(target, { bigint: true });
    checkAbort(signal);
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw new CoreError('COMMAND_DIRECTORY_CHANGED', '命令工作目录已变化。', 409);
    return Object.freeze({ canonical, dev: String(after.dev), ino: String(after.ino) });
  }

  function skippable(error) {
    return !rootErrors.has(error) && error.code !== 'CANCELLED' && !error.code?.startsWith('GITIGNORE_') && (error instanceof CoreError || error.code === 'ENOENT');
  }

  function ignoreFailure(code, status = 409) {
    const messages = {
      GITIGNORE_CHANGED: '扫描期间 .gitignore 已变化，请重新扫描。',
      GITIGNORE_INVALID: '.gitignore 必须是有效且不含空字符的 UTF-8 文本。',
      GITIGNORE_LIMIT: '.gitignore 规则或匹配工作量超过本次扫描限制；请缩小范围或明确包含已忽略项。',
      GITIGNORE_UNAVAILABLE: '无法安全读取 .gitignore；请检查规则文件或明确包含已忽略项。',
    };
    return new CoreError(code, messages[code], status);
  }

  function ruleIdentity(stat) {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
  }

  async function ruleSnapshot(relative, signal) {
    checkAbort(signal);
    let handle, result, failure;
    try {
      const target = await resolve(relative, { allowMissing: true });
      try { handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await resolveDirectory(relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '');
        checkAbort(signal);
        return null;
      }
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw ignoreFailure('GITIGNORE_UNAVAILABLE', 403);
      if (before.size > BigInt(GITIGNORE_LIMITS.fileBytes)) throw ignoreFailure('GITIGNORE_LIMIT', 413);
      const buffer = Buffer.alloc(GITIGNORE_LIMITS.fileBytes + 1);
      let count = 0;
      while (count < buffer.length) {
        checkAbort(signal);
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > GITIGNORE_LIMITS.fileBytes) throw ignoreFailure('GITIGNORE_LIMIT', 413);
      const after = await handle.stat({ bigint: true });
      await resolve(relative);
      const installed = await fs.lstat(target, { bigint: true });
      if (!installed.isFile() || installed.nlink !== 1n || ruleIdentity(before) !== ruleIdentity(after)
        || ruleIdentity(before) !== ruleIdentity(installed) || before.size !== BigInt(count)) throw ignoreFailure('GITIGNORE_CHANGED');
      const bytes = buffer.subarray(0, count);
      let content;
      try { content = decode(bytes); } catch { throw ignoreFailure('GITIGNORE_INVALID', 400); }
      result = { content, bytes: count, sha256: digest(bytes), identity: ruleIdentity(before) };
    } catch (error) { failure = error; }
    if (handle) {
      try { await handle.close(); }
      catch (error) { failure ??= error; }
    }
    if (failure) {
      if (rootErrors.has(failure) || failure.code === 'CANCELLED' || failure.code?.startsWith('GITIGNORE_')) throw failure;
      throw ignoreFailure('GITIGNORE_UNAVAILABLE', failure.status === 403 ? 403 : 409);
    }
    checkAbort(signal);
    return result;
  }

  function ignoreContext(signal, includeIgnored) {
    const info = { enabled: projectScan && !includeIgnored, includeIgnored, caseSensitive: true, files: 0, rules: 0, bytes: 0, ignoredFiles: 0, ignoredDirectories: 0, scopeIgnored: false };
    const probes = new Map(), contexts = new Map(), budget = createIgnoreBudget();
    async function enter(relative, parent) {
      if (!info.enabled || relative && relative.split('/').length >= MAX_DEPTH) return parent;
      if (contexts.has(relative)) return contexts.get(relative);
      const name = relative ? `${relative}/.gitignore` : '.gitignore';
      const value = await ruleSnapshot(name, signal);
      probes.set(name, value);
      let context = parent;
      if (value !== null) {
        if (info.files === GITIGNORE_LIMITS.files || info.bytes + value.bytes > GITIGNORE_LIMITS.totalBytes) throw ignoreFailure('GITIGNORE_LIMIT', 413);
        const rules = compileGitignore(value.content, { base: relative });
        if (info.rules + rules.length > GITIGNORE_LIMITS.rules) throw ignoreFailure('GITIGNORE_LIMIT', 413);
        info.files++; info.bytes += value.bytes; info.rules += rules.length;
        if (rules.length) context = [...parent, rules];
      }
      contexts.set(relative, context);
      return context;
    }
    function excluded(context, name, isDirectory, count = true) {
      if (!info.enabled) return false;
      for (let index = context.length - 1; index >= 0; index--) {
        const match = matchRules(context[index], name, isDirectory, { budget });
        if (!match) continue;
        if (match.ignored && count) info[isDirectory ? 'ignoredDirectories' : 'ignoredFiles']++;
        return match.ignored;
      }
      return false;
    }
    async function forScope(scope) {
      let context = await enter('', []), relative = '';
      for (const segment of scope ? scope.split('/') : []) {
        checkAbort(signal);
        relative = relative ? `${relative}/${segment}` : segment;
        if (excluded(context, relative, true)) { info.scopeIgnored = true; break; }
        context = await enter(relative, context);
      }
      return context;
    }
    async function verify() {
      for (const [name, before] of probes) {
        checkAbort(signal);
        const after = await ruleSnapshot(name, signal);
        if ((before === null) !== (after === null) || before && (before.identity !== after.identity || before.sha256 !== after.sha256)) throw ignoreFailure('GITIGNORE_CHANGED');
      }
      await ensureRoot(); checkAbort(signal);
    }
    return { info, enter, excluded, forScope, verify };
  }

  // Every candidate traverses the complete live path/root checks. This overlaps
  // metadata waits only; no authority, directory identity or file content is cached.
  // Ignore evaluation and observable counters remain in the ordered consumer.
  async function inspectScanEntry(item, relative, includeGenerated, signal) {
    checkAbort(signal);
    if (item.name.toLowerCase().startsWith('.openaster-') || (denySensitivePaths && sensitiveSegment(item.name))
      || item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) return { kind: 'skipped' };
    if (projectScan && !includeGenerated && item.isDirectory() && GENERATED_DIRECTORIES.has(item.name.toLowerCase())) return { kind: 'generated' };
    const name = relative ? relative + '/' + item.name : item.name;
    if (name.split('/').length > MAX_DEPTH) {
      validateAccessPath(item.name);
      return { kind: 'depth', name, isDirectory: item.isDirectory() };
    }
    const target = await resolve(name);
    checkAbort(signal);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) return { kind: 'skipped' };
    if (projectScan && !includeGenerated && stat.isDirectory() && GENERATED_DIRECTORIES.has(item.name.toLowerCase())) return { kind: 'generated' };
    return { kind: 'entry', name, stat };
  }

  async function inventory(options = {}, { recursive = true } = {}) {
    const { signal, scope, includeGenerated, includeIgnored } = scanOptions(options);
    checkAbort(signal);
    await resolveDirectory(scope);
    const ignores = ignoreContext(signal, includeIgnored);
    const initialContext = await ignores.forScope(scope);
    const files = [];
    const scan = { projectMode: projectScan, includeGenerated, excludedDirectories: 0, skippedEntries: 0, visitedEntries: 0, limits: [], ignore: ignores.info };
    const limits = new Set();
    // Only returned directories enter this queue, so it contains at most 1 + MAX_FILES paths.
    const queue = [{ relative: scope, context: initialContext }];
    let stop = ignores.info.scopeIgnored;
    for (let cursor = 0; cursor < queue.length && !stop; cursor++) {
      checkAbort(signal);
      const { relative, context: inherited } = queue[cursor];
      const context = cursor === 0 ? inherited : await ignores.enter(relative, inherited);
      const items = [];
      try {
        const entries = await fs.opendir(await resolveDirectory(relative));
        for await (const item of entries) {
          checkAbort(signal);
          // One extra Dirent is a lookahead, making an exactly-full directory truthful.
          if (++scan.visitedEntries > MAX_DIRECTORY_ENTRIES) { limits.add('directory-entries'); stop = true; break; }
          items.push(item);
          if (scan.visitedEntries % 64 === 0) await ensureRoot();
        }
      } catch (error) {
        if (error.code === 'ENOENT') await ensureRoot();
        if (cursor === 0 || !skippable(error)) throw error;
        scan.skippedEntries++;
        continue;
      }
      await ensureRoot();
      // Collect only a bounded directory window, sort it, then visit children breadth-first.
      items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      itemBatches: for (let offset = 0; offset < items.length;) {
        checkAbort(signal);
        // Reserve just one lookahead beyond the remaining output slots. Once the
        // cap is reached, do not probe paths the sequential scan would not visit.
        const batchSize = Math.min(SCAN_METADATA_CONCURRENCY, MAX_FILES - files.length + 1);
        const batch = items.slice(offset, offset + batchSize);
        offset += batch.length;
        const outcomes = await Promise.allSettled(batch.map(item => inspectScanEntry(item, relative, includeGenerated, signal)));
        // Drain every started check before cancellation/error can release a caller's
        // search slot or workspace lock. A later fatal failure must never be lost.
        checkAbort(signal);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected' && !skippable(outcome.reason)) throw outcome.reason;
        }
        for (const outcome of outcomes) {
          checkAbort(signal);
          if (outcome.status === 'rejected') { scan.skippedEntries++; continue; }
          const entry = outcome.value;
          if (entry.kind === 'skipped') { scan.skippedEntries++; continue; }
          if (entry.kind === 'generated') { scan.excludedDirectories++; continue; }
          if (entry.kind === 'depth') {
            if (ignores.excluded(context, entry.name, entry.isDirectory)) continue;
            limits.add('depth'); scan.skippedEntries++; continue;
          }
          const { name, stat } = entry;
          if (ignores.excluded(context, name, stat.isDirectory())) continue;
          if (files.length === MAX_FILES) { limits.add('entries'); stop = true; break itemBatches; }
          files.push({ path: name, type: stat.isDirectory() ? 'directory' : 'file', size: stat.isFile() ? stat.size : 0 });
          // Keep breadth-first traversal, including bounded inspection at MAX_DEPTH.
          if (recursive && stat.isDirectory()) queue.push({ relative: name, context });
        }
      }
    }
    await ensureRoot();
    checkAbort(signal);
    scan.limits = SCAN_LIMITS.filter(limit => limits.has(limit));
    return { result: { name: path.basename(absoluteRoot), files, truncated: scan.limits.length > 0, scope, scan }, verifyIgnore: ignores.verify };
  }

  async function list(options = {}) {
    const scanned = await inventory(options);
    await scanned.verifyIgnore();
    return scanned.result;
  }

  async function directory(options = {}) {
    // A child listing uses the same authority and ignore-policy checks as a full
    // inventory, but never opens child directories or reads their ignore rules.
    const scanned = await inventory(options, { recursive: false });
    await scanned.verifyIgnore();
    return { version: 1, listing: 'children', ...scanned.result };
  }

  async function read(relative, { signal } = {}) {
    checkAbort(signal);
    const value = await snapshot(relative);
    checkAbort(signal);
    return { path: validateRelativePath(relative), content: value.content, sha256: value.hash };
  }

  async function search(query, options = {}) {
    validateSearchQuery(query);
    const { signal, scope, includeGenerated, includeIgnored } = scanOptions(options);
    const caseSensitive = validateSearchCaseSensitive(options.caseSensitive);
    const matchLine = createLiteralMatcher(query, { caseSensitive });
    const scanned = await inventory({ signal, path: scope, includeGenerated, includeIgnored });
    const entries = scanned.result;
    const matches = [];
    let searchedFiles = 0;
    const limits = new Set(entries.scan.limits);
    const scan = { ...entries.scan, limits: [] };
    searchFiles: for (const file of entries.files) {
      checkAbort(signal);
      if (file.type !== 'file') continue;
      if (file.size > MAX_FILE_BYTES) { scan.skippedEntries++; continue; }
      if (searchedFiles === MAX_SEARCH_FILES) { limits.add('search-files'); break; }
      searchedFiles++;
      try {
        const { content, sha256 } = await read(file.path, { signal });
        const lines = content.split(/\r\n|\r|\n/u);
        for (let i = 0; i < lines.length; i++) {
          checkAbort(signal);
          const match = matchLine(lines[i]);
          if (!match) continue;
          if (matches.length === MAX_SEARCH_MATCHES) { limits.add('search-matches'); break searchFiles; }
          matches.push({ path: file.path, line: i + 1, sha256, ...match });
        }
      } catch (error) {
        if (!skippable(error)) throw error;
        scan.skippedEntries++;
      }
    }
    await ensureRoot();
    checkAbort(signal);
    await scanned.verifyIgnore();
    scan.limits = SCAN_LIMITS.filter(limit => limits.has(limit));
    return { version: 1, query, caseSensitive, matches, truncated: scan.limits.length > 0, scope, scan, searchedFiles };
  }

  function registerProposal(relative, content, buffer, original) {
    if (proposals.size >= 100) throw new CoreError('TOO_MANY_PROPOSALS', '待处理文件写入过多。', 429);
    const proposal = Object.freeze({ id: randomUUID(), path: relative, content, originalHash: original?.hash ?? null, originalContent: original?.content ?? null, newHash: digest(buffer), bytes: buffer.length });
    proposals.set(proposal.id, proposal);
    return proposal;
  }

  async function prepareWrite({ path: relative, content }) {
    validateAccessPath(relative);
    const buffer = validateContent(content);
    const original = await snapshot(relative, true);
    return registerProposal(relative, content, buffer, original);
  }

  async function prepareReplace({ path: relative, content, expectedHash }, { signal } = {}) {
    checkAbort(signal);
    validateAccessPath(relative);
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw new CoreError('INVALID_HASH', '保存必须提供读取时返回的小写 SHA-256 文件哈希。');
    }
    const buffer = validateContent(content);
    // Unlike import/write, replacement cannot establish a missing-file baseline.
    const original = await snapshot(relative);
    checkAbort(signal);
    if (original.hash !== expectedHash) throw new CoreError('WRITE_CONFLICT', '文件在读取后已改变；请保留编辑内容并重新读取。', 409);
    const proposal = registerProposal(relative, content, buffer, original);
    // Manual replacement preserves only ordinary POSIX permissions. This private
    // metadata is not part of the model approval capability or an ACL guarantee.
    replacementModes.set(proposal, original.mode & 0o777);
    return proposal;
  }

  async function prepareEdit({ path: relative, oldText, newText, expectedHash }, { signal } = {}) {
    checkAbort(signal);
    validateAccessPath(relative);
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw new CoreError('INVALID_HASH', '编辑必须提供读取时返回的小写 SHA-256 文件哈希。');
    }
    validateContent(oldText);
    validateContent(newText);
    if (!oldText.length) throw new CoreError('EDIT_EMPTY_MATCH', '要替换的原文不能为空。');
    const original = await snapshot(relative);
    checkAbort(signal);
    if (original.hash !== expectedHash) throw new CoreError('WRITE_CONFLICT', '文件在读取后已改变；请重新读取后再编辑。', 409);
    const position = original.content.indexOf(oldText);
    if (position < 0) throw new CoreError('EDIT_NO_MATCH', '文件中未找到完全一致的原文。', 409);
    // Advance by one code unit so overlapping occurrences are also ambiguous.
    if (original.content.indexOf(oldText, position + 1) >= 0) throw new CoreError('EDIT_AMBIGUOUS', '原文出现多次；请提供更长且唯一的上下文。', 409);
    if (oldText === newText) throw new CoreError('EDIT_NO_CHANGE', '替换后的文本与原文相同，没有需要修改的内容。', 409);
    const content = original.content.slice(0, position) + newText + original.content.slice(position + oldText.length);
    const buffer = validateContent(content);
    checkAbort(signal);
    // Register the exact checked snapshot; prepareWrite would take a second one.
    return registerProposal(relative, content, buffer, original);
  }

  function discardWrite(proposal) { if (proposal && proposals.get(proposal.id) === proposal) proposals.delete(proposal.id); }

  function unchangedSnapshot(proposal, value) {
    if ((value?.hash ?? null) !== proposal.originalHash) return false;
    return process.platform === 'win32' || !replacementModes.has(proposal) || (value.mode & 0o777) === replacementModes.get(proposal);
  }

  async function commitWrite(proposal, { signal } = {}) {
    // Consume the exact immutable proposal before queuing or awaiting any work.
    if (!proposal || proposals.get(proposal.id) !== proposal) throw new CoreError('INVALID_APPROVAL', '写入提案无效或已使用。', 409);
    proposals.delete(proposal.id);
    const previous = writeQueue;
    let release;
    writeQueue = new Promise(resolve => { release = resolve; });
    await previous;
    let temp;
    let tempIdentity;
    async function removeOwnedTemp() {
      // Validate the parent rather than the target: a newly linked target and its
      // staging file legitimately have nlink=2 until staging cleanup completes.
      const separator = proposal.path.lastIndexOf('/');
      const parentRelative = separator < 0 ? '' : proposal.path.slice(0, separator);
      await resolveDirectory(parentRelative);
      const current = await fs.lstat(temp, { bigint: true });
      if (!tempIdentity || !current.isFile() || current.isSymbolicLink()
        || current.dev !== tempIdentity.dev || current.ino !== tempIdentity.ino) {
        throw new CoreError('UNSAFE_PATH', '暂存文件的路径或身份已改变，已停止自动清理。', 403);
      }
      await fs.unlink(temp);
      temp = undefined;
    }
    try {
      checkAbort(signal);
      const current = await snapshot(proposal.path, true);
      if (!unchangedSnapshot(proposal, current)) throw new CoreError('WRITE_CONFLICT', '文件在预览后已改变；需要重新生成提案。', 409);
      const creating = proposal.originalHash === null;
      const target = await resolve(proposal.path, { allowMissing: creating, makeParents: creating });
      temp = path.join(path.dirname(target), `.openaster-${randomUUID()}.tmp`);
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        tempIdentity = await handle.stat({ bigint: true });
        await handle.writeFile(proposal.content, 'utf8');
        if (process.platform !== 'win32' && replacementModes.has(proposal)) await handle.chmod(replacementModes.get(proposal));
        await handle.sync();
      } finally { await handle.close(); }
      checkAbort(signal);
      const latest = await snapshot(proposal.path, true);
      if (!unchangedSnapshot(proposal, latest)) throw new CoreError('WRITE_CONFLICT', '文件在确认过程中已改变；需要重新生成提案。', 409);
      await resolve(proposal.path, { allowMissing: creating });
      // The final asynchronous validation may have overlapped cancellation.
      // Stop before issuing the native mutation; an issued rename/link cannot be recalled.
      checkAbort(signal);
      if (proposal.originalHash === null) {
        // link() gives create-without-replacement semantics on supported desktop filesystems.
        try { await fs.link(temp, target); }
        catch (error) { if (error.code === 'EEXIST') throw new CoreError('WRITE_CONFLICT', '目标文件已存在；需要重新生成提案。', 409); throw error; }
        try { await removeOwnedTemp(); }
        catch { throw new CoreError('POST_WRITE_CLEANUP_FAILED', '文件已写入，但临时文件未能安全清理；请检查工作区。', 503); }
      } else {
        for (let attempt = 0; ; attempt++) {
          try { await fs.rename(temp, target); break; }
          catch (error) {
            if (process.platform !== 'win32' || !WINDOWS_BUSY_CODES.has(error.code)) throw error;
            checkAbort(signal);
            if (attempt === WINDOWS_RENAME_DELAYS.length) throw new CoreError('FILE_BUSY', '文件暂时无法替换，可能被占用或访问受限；请检查后重新生成提案。', 409);
            await waitForRenameRetry(WINDOWS_RENAME_DELAYS[attempt], signal);
            checkAbort(signal);
            // Permission and content checks apply again before every native retry.
            const retrySnapshot = await snapshot(proposal.path, true);
            if (!unchangedSnapshot(proposal, retrySnapshot)) throw new CoreError('WRITE_CONFLICT', '文件在等待写入时已改变；需要重新生成提案。', 409);
            await resolve(proposal.path);
            checkAbort(signal);
          }
        }
      }
      temp = undefined;
      return { path: proposal.path, bytes: proposal.bytes, sha256: proposal.newHash };
    } finally {
      // Do not follow a changed parent or remove another file with our old name.
      if (temp) await removeOwnedTemp().catch(() => {});
      release();
    }
  }

  // Explicit user imports may create new files, never silently overwrite existing content.
  async function importText(input) {
    const proposal = await prepareWrite(input);
    if (proposal.originalHash !== null) { discardWrite(proposal); throw new CoreError('FILE_EXISTS', '文件已存在，请使用新名称或通过审核提案修改。', 409); }
    return commitWrite(proposal);
  }

  return Object.freeze({ root: absoluteRoot, getIdentity, list, directory, read, search, commandDirectory, prepareWrite, prepareReplace, prepareEdit, commitWrite, discardWrite, importText });
}
