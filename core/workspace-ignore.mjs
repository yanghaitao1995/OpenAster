// SPDX-License-Identifier: Apache-2.0
import { CoreError } from './errors.mjs';

export const GITIGNORE_LIMITS = Object.freeze({ fileBytes: 256 * 1024, totalBytes: 1024 * 1024, files: 128, rules: 4096, patternBytes: 1024, work: 16 * 1024 * 1024 });
const compiled = new WeakMap();
const budgets = new WeakMap();
const invalid = () => new CoreError('GITIGNORE_INVALID', '.gitignore 必须是有效且不含空字符的 UTF-8 文本。');
const limit = () => new CoreError('GITIGNORE_LIMIT', '.gitignore 规则或匹配工作量超过本次扫描限制；请缩小范围或明确包含已忽略项。', 413);

export function createIgnoreBudget(maxWork = GITIGNORE_LIMITS.work) {
  if (!Number.isSafeInteger(maxWork) || maxWork < 1 || maxWork > GITIGNORE_LIMITS.work) throw new TypeError('Invalid ignore work budget');
  const state = { used: 0, maxWork };
  const budget = Object.freeze({ get used() { return state.used; }, maxWork });
  budgets.set(budget, state);
  return budget;
}

function spend(budget, amount = 1) {
  const state = budgets.get(budget);
  if (!state) throw new TypeError('Use createIgnoreBudget for matching');
  if (amount > state.maxWork - state.used) throw limit();
  state.used += amount;
}

function ordinaryPath(value, empty = false) {
  return typeof value === 'string' && value.isWellFormed() && !value.includes('\0')
    && (empty && value === '' || value.length > 0 && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..'));
}

const classes = Object.freeze({
  alnum: n => n >= 48 && n <= 57 || n >= 65 && n <= 90 || n >= 97 && n <= 122,
  alpha: n => n >= 65 && n <= 90 || n >= 97 && n <= 122,
  blank: n => n === 9 || n === 32,
  cntrl: n => n < 32 || n === 127,
  digit: n => n >= 48 && n <= 57,
  graph: n => n >= 33 && n <= 126,
  lower: n => n >= 97 && n <= 122,
  print: n => n >= 32 && n <= 126,
  punct: n => n >= 33 && n <= 126 && !(n >= 48 && n <= 57 || n >= 65 && n <= 90 || n >= 97 && n <= 122),
  space: n => n === 32 || n >= 9 && n <= 13,
  upper: n => n >= 65 && n <= 90,
  xdigit: n => n >= 48 && n <= 57 || n >= 65 && n <= 70 || n >= 97 && n <= 102,
});

// Character classes and ? consume bytes, not UTF-16 units or Unicode points.
function characterClass(pattern, start) {
  let cursor = start + 1;
  const negate = pattern[cursor] === 33 || pattern[cursor] === 94;
  if (negate) cursor++;
  const elements = [];
  while (cursor < pattern.length) {
    const byte = pattern[cursor++];
    if (byte === 93 && elements.length) {
      const mask = new Uint8Array(256);
      for (let index = 0; index < elements.length; index++) {
        const item = elements[index];
        if (item.range) {
          // The preceding literal remains a member even for a descending range.
          mask[item.range[0]] = 1;
          for (let n = item.range[0]; n <= item.range[1]; n++) mask[n] = 1;
        } else if (typeof item === 'number') mask[item] = 1;
        else for (let n = 0; n < 128; n++) if (item.test(n)) mask[n] = 1;
      }
      if (negate) for (let n = 0; n < 256; n++) mask[n] ^= 1;
      mask[47] = 0;
      return { token: { kind: 'class', mask }, end: cursor };
    }
    if (byte === 92) {
      if (cursor === pattern.length) return null;
      elements.push(pattern[cursor++]);
    } else if (byte === 45 && typeof elements.at(-1) === 'number' && cursor < pattern.length && pattern[cursor] !== 93) {
      let endpoint = pattern[cursor++];
      if (endpoint === 92) {
        if (cursor === pattern.length) return null;
        endpoint = pattern[cursor++];
      }
      // A range endpoint is one literal byte. '[' here cannot start a class.
      elements.push({ range: [elements.pop(), endpoint] });
    } else if (byte === 91 && pattern[cursor] === 58) {
      let end = cursor + 1;
      while (end < pattern.length && pattern[end] !== 93) end++;
      if (end === pattern.length) return null;
      if (pattern[end - 1] === 58) {
        const name = pattern.subarray(cursor + 1, end - 1).toString('ascii');
        if (!Object.hasOwn(classes, name)) return null;
        elements.push({ test: classes[name] }); cursor = end + 1;
      } else elements.push(byte);
    } else elements.push(byte);
  }
  return null;
}

function tokenize(pattern, pathname) {
  const tokens = [];
  for (let index = 0; index < pattern.length;) {
    const start = index, byte = pattern[index++];
    if (byte === 92) {
      if (index === pattern.length) return null;
      tokens.push({ kind: 'literal', byte: pattern[index++] });
    } else if (byte === 63) tokens.push({ kind: 'any' });
    else if (byte === 91) {
      const parsed = characterClass(pattern, start);
      if (!parsed) return null;
      tokens.push(parsed.token); index = parsed.end;
    } else if (byte === 42) {
      while (pattern[index] === 42) index++;
      const wholeSegment = pathname && index - start >= 2 && (start === 0 || pattern[start - 1] === 47)
        && (index === pattern.length || pattern[index] === 47 || pattern[index] === 92 && pattern[index + 1] === 47);
      if (wholeSegment && index < pattern.length) {
        tokens.push({ kind: 'directories' }); index += pattern[index] === 92 ? 2 : 1;
      } else tokens.push({ kind: wholeSegment ? 'all' : 'star' });
    } else tokens.push({ kind: 'literal', byte });
  }
  return tokens;
}

/** Compile one UTF-8 .gitignore, anchored at its containing workspace directory. */
export function compileGitignore(content, { base = '' } = {}) {
  if (typeof content !== 'string' || !content.isWellFormed() || content.includes('\0') || !ordinaryPath(base, true)) throw invalid();
  if (Buffer.byteLength(content, 'utf8') > GITIGNORE_LIMITS.fileBytes) throw limit();
  const lines = (content.startsWith('\ufeff') ? content.slice(1) : content).split('\n');
  const rules = [];
  for (let line = 0; line < lines.length; line++) {
    let text = lines[line];
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.startsWith('#')) continue;
    let end = text.length;
    while (end > 0 && text[end - 1] === ' ') {
      let backslashes = 0;
      for (let pos = end - 2; pos >= 0 && text[pos] === '\\'; pos--) backslashes++;
      if (backslashes % 2) break;
      end--;
    }
    text = text.slice(0, end);
    if (!text) continue;
    if (rules.length === GITIGNORE_LIMITS.rules || Buffer.byteLength(text, 'utf8') > GITIGNORE_LIMITS.patternBytes) throw limit();
    const negative = text.startsWith('!');
    let pattern = Buffer.from(negative ? text.slice(1) : text, 'utf8');
    const directoryOnly = pattern.at(-1) === 47;
    if (directoryOnly) pattern = pattern.subarray(0, -1);
    const pathname = pattern.includes(47);
    if (pattern[0] === 47) pattern = pattern.subarray(1);
    const tokens = pattern.length ? tokenize(pattern, pathname) : null;
    const rule = Object.freeze({ base, line: line + 1, pattern: text, negative, directoryOnly, invalid: tokens === null });
    const literal = tokens?.every(token => token.kind === 'literal') ? Buffer.from(tokens.map(token => token.byte)) : null;
    compiled.set(rule, { tokens, pathname, literal });
    rules.push(rule);
  }
  return Object.freeze(rules);
}

// Bounded NFA simulation: no regex/backtracking and no recursion through stars.
function matches(tokens, bytes, budget, literal) {
  if (literal) {
    spend(budget, Math.max(literal.length, 1));
    return literal.equals(bytes);
  }
  let current = new Uint8Array(bytes.length + 1); current[0] = 1;
  for (const token of tokens) {
    spend(budget, bytes.length + 1);
    const next = new Uint8Array(bytes.length + 1);
    if (token.kind === 'star' || token.kind === 'all') {
      next.set(current);
      for (let index = 0; index < bytes.length; index++) if (next[index] && (token.kind === 'all' || bytes[index] !== 47)) next[index + 1] = 1;
    } else if (token.kind === 'directories') {
      next.set(current);
      const reachable = current.slice();
      for (let index = 0; index < bytes.length; index++) if (reachable[index]) {
        reachable[index + 1] = 1;
        if (bytes[index] === 47) next[index + 1] = 1;
      }
    } else for (let index = 0; index < bytes.length; index++) if (current[index]) {
      const byte = bytes[index];
      if (token.kind === 'literal' ? byte === token.byte : token.kind === 'any' ? byte !== 47 : token.mask[byte]) next[index + 1] = 1;
    }
    current = next;
    if (!current.includes(1)) return false;
  }
  return current[bytes.length] === 1;
}

/** Match this item only; callers must prune ignored parents before loading children. */
export function matchRules(rules, relative, isDirectory, { budget = createIgnoreBudget() } = {}) {
  if (!Array.isArray(rules) || !ordinaryPath(relative) || typeof isDirectory !== 'boolean') throw invalid();
  for (let index = rules.length - 1; index >= 0; index--) {
    spend(budget);
    const rule = rules[index], data = compiled.get(rule);
    if (!data) throw invalid();
    if (!data.tokens || rule.directoryOnly && !isDirectory) continue;
    if (rule.base && !relative.startsWith(`${rule.base}/`)) continue;
    let candidate = rule.base ? relative.slice(rule.base.length + 1) : relative;
    if (!data.pathname) candidate = candidate.slice(candidate.lastIndexOf('/') + 1);
    if (matches(data.tokens, Buffer.from(candidate, 'utf8'), budget, data.literal)) return { ignored: !rule.negative, line: rule.line };
  }
  return null;
}
