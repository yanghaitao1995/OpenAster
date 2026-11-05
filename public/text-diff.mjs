// SPDX-License-Identifier: Apache-2.0
// Original, bounded line comparison. No markup is produced by this module.
export const DIFF_LIMITS = Object.freeze({ bytesPerText: 256 * 1024, inputLines: 10000, matrixCells: 500000, displayRows: 500, lineCharacters: 4000, contextLines: 3 });
const encoder = new TextEncoder();

function inspect(text, exists) {
  if (text.length > DIFF_LIMITS.bytesPerText) return { exists, oversized: true, bytes: null };
  const bytes = encoder.encode(text).length;
  if (bytes > DIFF_LIMITS.bytesPerText) return { exists, oversized: true, bytes };
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  const endings = { LF: 0, CRLF: 0, CR: 0 };
  let lines = 0, start = 0, longest = 0, finalEnding = null;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\r' && body[i] !== '\n') continue;
    longest = Math.max(longest, i - start);
    const ending = body[i] === '\n' ? 'LF' : body[i + 1] === '\n' ? 'CRLF' : 'CR';
    if (ending === 'CRLF') i++;
    endings[ending]++; lines++; start = i + 1;
    if (start === body.length) finalEnding = ending;
  }
  if (start < body.length) { lines++; longest = Math.max(longest, body.length - start); }
  return { exists, oversized: false, bytes, bom, lines, endings, finalEnding, longest };
}

function tokenize(text, intern) {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const lines = []; let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\r' && body[i] !== '\n') continue;
    const content = body.slice(start, i), ending = body[i] === '\n' ? 'LF' : body[i + 1] === '\n' ? 'CRLF' : 'CR';
    if (ending === 'CRLF') i++;
    lines.push({ text: content, ending }); start = i + 1;
  }
  if (start < body.length) lines.push({ text: body.slice(start), ending: null });
  for (const line of lines) {
    const key = String(line.ending) + ':' + line.text;
    if (!intern.has(key)) intern.set(key, intern.size);
    line.token = intern.get(key);
  }
  return lines;
}
const same = (a, b) => a.token === b.token;

function compact(rows) {
  const visible = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) if (rows[i].kind !== 'context') {
    visible.fill(1, Math.max(0, i - DIFF_LIMITS.contextLines), Math.min(rows.length, i + DIFF_LIMITS.contextLines + 1));
  }
  const result = []; let omitted = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!visible[i]) { omitted++; continue; }
    if (omitted) { result.push({ kind: 'gap', count: omitted }); omitted = 0; }
    result.push(rows[i]);
  }
  if (omitted) result.push({ kind: 'gap', count: omitted });
  return result;
}

export function buildTextDiff(before, after) {
  if (before !== null && typeof before !== 'string') throw new TypeError('before must be a string or null');
  if (typeof after !== 'string') throw new TypeError('after must be a string');
  const original = before ?? '';
  const summary = { before: inspect(original, before !== null), after: inspect(after, true) };
  const base = { changed: before === null || original !== after, summary };
  const fallback = reason => ({ ...base, mode: 'fallback', reason, rows: [], added: null, removed: null });
  if (summary.before.oversized || summary.after.oversized) return fallback('bytes');
  if (summary.before.lines + summary.after.lines > DIFF_LIMITS.inputLines) return fallback('lines');
  if (summary.before.longest > DIFF_LIMITS.lineCharacters || summary.after.longest > DIFF_LIMITS.lineCharacters) return fallback('long-line');
  if (original === after) return { ...base, mode: 'diff', reason: null, rows: [], added: 0, removed: 0 };
  const intern = new Map();
  const a = tokenize(original, intern), b = tokenize(after, intern); let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && same(a[prefix], b[prefix])) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && same(a[a.length - 1 - suffix], b[b.length - 1 - suffix])) suffix++;
  const n = a.length - prefix - suffix, m = b.length - prefix - suffix;
  if ((n + 1) * (m + 1) > DIFF_LIMITS.matrixCells) return fallback('matrix');
  const width = m + 1, table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * width + j] = same(a[prefix + i], b[prefix + j]) ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const rows = []; let oldLine = 1, newLine = 1, added = 0, removed = 0;
  const append = (kind, line) => {
    rows.push({ kind, oldLine: kind === 'add' ? null : oldLine++, newLine: kind === 'remove' ? null : newLine++, text: line.text, ending: line.ending });
    if (kind === 'add') added++; if (kind === 'remove') removed++;
  };
  for (let i = 0; i < prefix; i++) append('context', a[i]);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same(a[prefix + i], b[prefix + j])) { append('context', a[prefix + i]); i++; j++; }
    else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) append('remove', a[prefix + i++]);
    else append('add', b[prefix + j++]);
  }
  for (let k = a.length - suffix; k < a.length; k++) append('context', a[k]);
  const display = compact(rows);
  if (display.length > DIFF_LIMITS.displayRows) return fallback('display');
  return { ...base, mode: 'diff', reason: null, rows: display, added, removed };
}
