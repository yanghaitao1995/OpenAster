import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createWorkspace, MAX_FILE_BYTES } from '../core/workspace.mjs';
import { createLiteralMatcher, validateSearchQuery, validateSearchCaseSensitive, MAX_SEARCH_EXCERPT_UNITS } from '../core/workspace-search.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'openaster-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return { root, workspace: createWorkspace(root, { createRoot: false, denySensitivePaths: true, projectScan: true }) };
}

function assertExcerpt(match, original, expectedStart, expectedEnd) {
  assert.ok(match);
  assert.equal(match.lineLength, original.length);
  assert.ok(Number.isInteger(match.excerptStart) && match.excerptStart >= 0);
  assert.ok(Number.isInteger(match.excerptEnd) && match.excerptEnd <= original.length);
  assert.equal(match.text, original.slice(match.excerptStart, match.excerptEnd));
  assert.ok(match.text.length <= MAX_SEARCH_EXCERPT_UNITS);
  assert.ok(match.text.isWellFormed());
  assert.ok(match.matchStart >= 0 && match.matchEnd > match.matchStart && match.matchEnd <= match.text.length);
  assert.equal(match.matchStart + match.excerptStart, expectedStart);
  assert.equal(match.matchEnd + match.excerptStart, expectedEnd);
  assert.equal(match.text.slice(match.matchStart, match.matchEnd), original.slice(expectedStart, expectedEnd));
  assert.ok(match.text.slice(0, match.matchStart).isWellFormed());
  assert.ok(match.text.slice(match.matchStart, match.matchEnd).isWellFormed());
  assert.ok(match.text.slice(match.matchEnd).isWellFormed());
  assert.ok(original.slice(0, match.excerptStart).isWellFormed());
  assert.ok(original.slice(match.excerptEnd).isWellFormed());
}

test('query validation preserves literal spaces and limits UTF-16 without accepting malformed or multiline text', () => {
  for (const query of [undefined, null, 0, false, {}, [], '', 'x'.repeat(257), '😀'.repeat(129), '\0', 'a\0b', '\ud800', 'a\udc00', '\r', '\n', 'a\r\nb', '\u2028', 'a\u2029b']) {
    assert.throws(() => validateSearchQuery(query), { code: 'INVALID_QUERY' });
  }
  for (const query of [' ', '  needle  ', '\t', '[a-z]+(x)*$', '😀'.repeat(128), 'x'.repeat(256), '\uFEFF', 'e\u0301']) {
    assert.equal(validateSearchQuery(query), query);
  }
  assert.equal(validateSearchCaseSensitive(), false);
  assert.equal(validateSearchCaseSensitive(false), false);
  assert.equal(validateSearchCaseSensitive(true), true);
  for (const value of [null, 0, 1, '', 'false', 'true', {}, []]) {
    assert.throws(() => validateSearchCaseSensitive(value), { code: 'INVALID_SCAN_OPTIONS' });
  }
});

test('invalid queries and case options fail before touching an unavailable workspace', async t => {
  const { root } = await fixture(t);
  const absent = path.join(root, 'missing'), workspace = createWorkspace(absent, { createRoot: false });
  for (const query of ['\0', '\ud800', 'a\nb']) await assert.rejects(workspace.search(query), { code: 'INVALID_QUERY' });
  for (const caseSensitive of [null, 'false', 0]) {
    await assert.rejects(workspace.search('needle', { caseSensitive }), { code: 'INVALID_SCAN_OPTIONS' });
  }
  await assert.rejects(fs.lstat(absent), { code: 'ENOENT' });
});

test('lowercase expansions and supplementary characters map the first match onto complete original code points', () => {
  const examples = [
    ['aİbİc', 'i', 1, 2], ['aİbİc', '\u0307', 1, 2], ['aİbİc', 'i\u0307b', 1, 3],
    ['aİbİc', 'İB', 1, 3], ['😀İ😀', '\u0307😀', 2, 5], ['x\u{10400}z', '\u{10428}', 1, 3],
    ['İ and I', 'I', 0, 1], ['x😀a😀', '😀', 1, 3],
  ];
  for (const [line, query, start, end] of examples) assertExcerpt(createLiteralMatcher(query)(line), line, start, end);
  assert.equal(createLiteralMatcher('ib')('İb'), null, 'The combining dot is not silently removed');
  assert.equal(createLiteralMatcher('i', { caseSensitive: true })('İ'), null);
});

test('case-insensitive search uses code-point lowercase without locale, normalization or full case folding', () => {
  assertExcerpt(createLiteralMatcher('i')('I'), 'I', 0, 1);
  assert.equal(createLiteralMatcher('ı')('I'), null, 'Turkish locale rules are not selected by the host');
  assertExcerpt(createLiteralMatcher('οσ')('ΟΣ'), 'ΟΣ', 0, 2);
  assert.equal(createLiteralMatcher('ος')('ΟΣ'), null, 'Final sigma context is not an extra case-folding rule');
  assert.equal(createLiteralMatcher('strasse')('Straße'), null);
  assert.equal(createLiteralMatcher('é')('e\u0301'), null);
  assert.equal(createLiteralMatcher('e\u0301')('é'), null);
});

test('long-line excerpts contain the hit and keep all UTF-16 boundaries valid', () => {
  let seed = 173;
  for (let index = 0; index < 160; index++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const prefix = '🧭'.repeat(seed % 520) + 'x'.repeat(index % 3);
    const suffix = '🌍'.repeat((seed >>> 8) % 510) + 'z'.repeat(index % 5);
    const hit = 'İNeEdLe😀', line = prefix + hit + suffix;
    assertExcerpt(createLiteralMatcher('i\u0307needle😀')(line), line, prefix.length, prefix.length + hit.length);
  }
  const line = 'x'.repeat(2000) + 'needle';
  const match = createLiteralMatcher('needle')(line);
  assertExcerpt(match, line, 2000, 2006);
  assert.ok(match.excerptStart > 0);
  assert.equal(match.excerptEnd, line.length);
});

test('a maximum-length query expanding in lowercase retains its entire 512-unit source match', () => {
  const query = 'İ'.repeat(256), hit = 'i\u0307'.repeat(256);
  const line = '😀'.repeat(100) + hit + '😀'.repeat(100);
  const match = createLiteralMatcher(query)(line);
  assertExcerpt(match, line, 200, 712);
  assert.equal(match.matchEnd - match.matchStart, 512);
});

test('real searches keep exact query text, literal metacharacters, first match per line and explicit sensitivity', async t => {
  const { root, workspace } = await fixture(t);
  const content = 'Needle needle NEEDLE\n[a-z]+(x)*$\n leading and trailing \nnone';
  await fs.writeFile(path.join(root, 'notes.txt'), content);
  const result = await workspace.search('needle');
  assert.equal(result.version, 1); assert.equal(result.caseSensitive, false); assert.equal(result.query, 'needle');
  assert.equal(result.matches.length, 1); assert.equal(result.searchedFiles, 1); assert.equal(result.truncated, false);
  assertExcerpt(result.matches[0], 'Needle needle NEEDLE', 0, 6);
  assert.equal(result.matches[0].sha256, hash(content));
  const exact = await workspace.search('needle', { caseSensitive: true });
  assert.equal(exact.caseSensitive, true); assert.equal(exact.matches.length, 1);
  assertExcerpt(exact.matches[0], 'Needle needle NEEDLE', 7, 13);
  const literal = await workspace.search('[a-z]+(x)*$');
  assert.equal(literal.matches.length, 1); assert.equal(literal.matches[0].line, 2);
  assert.equal((await workspace.search('[A-Z]+(X)*$', { caseSensitive: true })).matches.length, 0);
  const spaced = await workspace.search(' leading and trailing ');
  assert.equal(spaced.query, ' leading and trailing '); assert.equal(spaced.matches[0].line, 3);
});

test('CRLF, CR and LF line numbers and raw BOM hashes agree with exact file previews', async t => {
  const { root, workspace } = await fixture(t);
  const content = '\uFEFFNeedle\rneedle\r\nNEEDLE\nneedle';
  await fs.writeFile(path.join(root, 'mixed.txt'), content);
  const result = await workspace.search('needle');
  assert.deepEqual(result.matches.map(match => match.line), [1, 2, 3, 4]);
  assert.equal(result.matches[0].text, '\uFEFFNeedle');
  assert.equal(result.matches[0].matchStart, 1); assert.equal(result.matches[0].matchEnd, 7);
  const preview = await workspace.read('mixed.txt');
  assert.equal(preview.content, content); assert.equal(preview.sha256, hash(Buffer.from(content)));
  for (const match of result.matches) assert.equal(match.sha256, preview.sha256);
});

test('search results pin the bytes actually read and expose a stale result after later disk edits', async t => {
  const { root, workspace } = await fixture(t);
  const target = path.join(root, 'file.txt');
  await fs.writeFile(target, 'one\r\nneedle');
  const first = await workspace.search('needle');
  assert.equal(first.matches[0].sha256, hash('one\r\nneedle'));
  await fs.writeFile(target, 'needle\nnewer');
  const current = await workspace.read('file.txt');
  assert.notEqual(first.matches[0].sha256, current.sha256);
  assert.equal(first.matches[0].line, 2);
  const next = await workspace.search('needle');
  assert.equal(next.matches[0].sha256, current.sha256); assert.equal(next.matches[0].line, 1);
});

test('large valid UTF-8 lines remain searchable while binary and oversized files remain explicitly skipped', async t => {
  const { root, workspace } = await fixture(t);
  const content = 'x'.repeat(MAX_FILE_BYTES - 6) + 'needle';
  await fs.writeFile(path.join(root, 'large.txt'), content);
  await fs.writeFile(path.join(root, 'binary.txt'), Buffer.from([0, 65]));
  await fs.writeFile(path.join(root, 'oversized.txt'), 'x'.repeat(MAX_FILE_BYTES + 1));
  const result = await workspace.search('needle');
  assert.equal(result.matches.length, 1); assert.equal(result.searchedFiles, 2);
  assert.equal(result.scan.skippedEntries, 2); assert.equal(result.truncated, false);
  assertExcerpt(result.matches[0], content, MAX_FILE_BYTES - 6, MAX_FILE_BYTES);
});

test('new matching options do not override scope, generated exclusions or sensitive paths', async t => {
  const { root, workspace } = await fixture(t);
  await fs.mkdir(path.join(root, 'src')); await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'src', 'Code.txt'), 'NEEDLE');
  await fs.writeFile(path.join(root, 'dist', 'generated.txt'), 'needle');
  await fs.writeFile(path.join(root, '.env'), 'needle');
  const normal = await workspace.search('needle');
  assert.deepEqual(normal.matches.map(match => match.path), ['src/Code.txt']);
  const scoped = await workspace.search('needle', { path: 'src', caseSensitive: true });
  assert.equal(scoped.scope, 'src'); assert.deepEqual(scoped.matches, []);
  const generated = await workspace.search('needle', { path: 'dist', caseSensitive: true });
  assert.deepEqual(generated.matches.map(match => match.path), ['dist/generated.txt']);
  const expanded = await workspace.search('needle', { includeGenerated: true });
  assert.deepEqual(expanded.matches.map(match => match.path).sort(), ['dist/generated.txt', 'src/Code.txt']);
  await assert.rejects(workspace.search('needle', { path: '.env', includeGenerated: true, caseSensitive: true }), { code: 'SENSITIVE_PATH' });
});

test('cancellation during a real file read rejects the whole search rather than returning a partial success', async t => {
  const { root, workspace } = await fixture(t);
  const target = path.join(root, 'one.txt');
  await fs.writeFile(target, 'needle');
  const opened = await fs.open(target, 'r'), prototype = Object.getPrototypeOf(opened), originalRead = prototype.read;
  await opened.close();
  const controller = new AbortController(); let intercepted = 0;
  const mocked = t.mock.method(prototype, 'read', async function (...args) {
    const result = await Reflect.apply(originalRead, this, args);
    if (result.bytesRead > 0) { intercepted++; controller.abort(); }
    return result;
  });
  try { await assert.rejects(workspace.search('needle', { signal: controller.signal }), { code: 'CANCELLED' }); }
  finally { mocked.mock.restore(); }
  assert.equal(intercepted, 1);
  assert.equal((await workspace.search('needle')).matches.length, 1);
});
