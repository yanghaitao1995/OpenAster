import { CoreError } from './errors.mjs';

export const MAX_SEARCH_QUERY_UNITS = 256;
export const MAX_SEARCH_EXCERPT_UNITS = 600;

export function validateSearchQuery(query) {
  if (typeof query !== 'string' || !query || query.length > MAX_SEARCH_QUERY_UNITS
    || !query.isWellFormed() || /[\0\r\n\u2028\u2029]/u.test(query)) {
    throw new CoreError('INVALID_QUERY', '搜索文本须为 1 到 256 个 UTF-16 单位的有效单行文本，不能包含空字符。');
  }
  return query;
}

export function validateSearchCaseSensitive(value = false) {
  if (typeof value !== 'boolean') throw new CoreError('INVALID_SCAN_OPTIONS', '是否区分大小写必须是布尔值。');
  return value;
}

// Apply locale-independent lowercase separately to each Unicode code point.
// This deliberately does not normalize text or implement full Unicode case
// folding (for example, sharp s is not expanded to "ss"). Separate code points
// also avoid language/context-dependent final-sigma transformations. A mapping
// expansion such as U+0130 -> "i" + U+0307 still refers to its whole source point.
function lowerCodePoints(value) {
  const parts = [];
  for (const point of value) parts.push(point.toLowerCase());
  return parts.join('');
}

function sourceRange(line, foldedStart, foldedEnd) {
  let originalOffset = 0, foldedOffset = 0, start;
  for (const point of line) {
    const nextFolded = foldedOffset + point.toLowerCase().length;
    if (start === undefined && nextFolded > foldedStart) start = originalOffset;
    originalOffset += point.length;
    if (nextFolded >= foldedEnd) return { start, end: originalOffset };
    foldedOffset = nextFolded;
  }
  throw new Error('Cannot map a lowercase search match to the source line');
}

function splitsPair(value, offset) {
  return offset > 0 && offset < value.length
    && value.charCodeAt(offset - 1) >= 0xd800 && value.charCodeAt(offset - 1) <= 0xdbff
    && value.charCodeAt(offset) >= 0xdc00 && value.charCodeAt(offset) <= 0xdfff;
}

function excerpt(line, start, end) {
  // A 256-unit query can expand during lowercase conversion. Reserve the whole
  // mapped match before dividing remaining context between its two sides.
  const spare = MAX_SEARCH_EXCERPT_UNITS - (end - start);
  if (spare < 0) throw new Error('Search match exceeds the excerpt budget');
  let excerptStart = Math.max(0, Math.min(start - Math.floor(spare / 2), line.length - MAX_SEARCH_EXCERPT_UNITS));
  if (splitsPair(line, excerptStart)) excerptStart++;
  let excerptEnd = Math.min(line.length, excerptStart + MAX_SEARCH_EXCERPT_UNITS);
  if (splitsPair(line, excerptEnd)) excerptEnd--;
  return {
    text: line.slice(excerptStart, excerptEnd), matchStart: start - excerptStart, matchEnd: end - excerptStart,
    excerptStart, excerptEnd, lineLength: line.length,
  };
}

/** First literal match on one original line; all returned offsets use UTF-16. */
export function createLiteralMatcher(query, { caseSensitive = false } = {}) {
  validateSearchQuery(query);
  validateSearchCaseSensitive(caseSensitive);
  const needle = caseSensitive ? query : lowerCodePoints(query);
  return line => {
    const found = (caseSensitive ? line : lowerCodePoints(line)).indexOf(needle);
    if (found < 0) return null;
    const { start, end } = caseSensitive
      ? { start: found, end: found + needle.length }
      : sourceRange(line, found, found + needle.length);
    return excerpt(line, start, end);
  };
}
