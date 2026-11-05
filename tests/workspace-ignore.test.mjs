// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileGitignore, matchRules, createIgnoreBudget, GITIGNORE_LIMITS } from '../core/workspace-ignore.mjs';

const ignored = (pattern, path, directory = false, base = '') => matchRules(compileGitignore(pattern, { base }), path, directory)?.ignored ?? false;

test('ignore rules preserve whitespace, LF/CRLF, BOM, escapes and the last matching line', () => {
  const rules = compileGitignore('\ufeff#comment\r\n\n*.log\r\n!keep.log\r\n\\#notes\n\\!notes\n padded\ntrailing  \nkept\\ \n');
  assert.deepEqual(matchRules(rules, 'error.log', false), { ignored: true, line: 3 });
  assert.deepEqual(matchRules(rules, 'keep.log', false), { ignored: false, line: 4 });
  for (const name of ['#notes', '!notes', ' padded', 'trailing', 'kept ']) assert.equal(matchRules(rules, name, false)?.ignored, true, name);
  for (const name of ['padded', 'trailing ', 'kept', 'other']) assert.equal(matchRules(rules, name, false), null, name);
  assert.equal(ignored('word\t', 'word'), false);
  assert.equal(ignored('word\t', 'word\t'), true);
  assert.equal(ignored('a\rb', 'a\rb'), true, 'bare CR is a literal, not a line separator');
});

test('relative anchoring, basename and directory flags are distinct from parent traversal', () => {
  assert.equal(ignored('name', 'nested/name'), true);
  assert.equal(ignored('/name', 'nested/name'), false);
  assert.equal(ignored('/name', 'src/name', false, 'src'), true);
  assert.equal(ignored('a/name', 'src/a/name', false, 'src'), true);
  assert.equal(ignored('a/name', 'src/deeper/a/name', false, 'src'), false);
  assert.equal(ignored('a/name', 'another/a/name', false, 'src'), false);
  assert.equal(ignored('cache/', 'a/cache', true), true);
  assert.equal(ignored('cache/', 'a/cache', false), false);
  assert.equal(ignored('cache/', 'cache/file', false), false, 'caller evaluates and prunes the parent');
  assert.equal(ignored('*.txt', '.hidden.txt'), true);
  assert.equal(ignored('File', 'file'), false);
});

test('wildcards have byte semantics, slash boundaries and no bash brace/extglob expansion', () => {
  for (const [pattern, path, expected] of [
    ['a/**/b', 'a/b', true], ['a/**/b', 'a/one/two/b', true], ['a/*/b', 'a/one/two/b', false],
    ['**/name', 'name', true], ['**/name', 'a/name', true], ['a/**', 'a/deep/file', true],
    ['a/**', 'a', false], ['a/***/b', 'a/deep/b', true], ['a**b', 'a/x/b', false],
    ['?', 'é', false], ['??', 'é', true], ['????', '😀', true], ['?', '😀', false],
    ['é', 'é', true], ['é', 'e\u0301', false], ['{a,b}', 'a', false], ['{a,b}', '{a,b}', true],
    ['@(a)', 'a', false], ['@(a)', '@(a)', true], ['\\a', 'a', true], ['\\*', '*', true],
  ]) assert.equal(ignored(pattern, path), expected, `${pattern} -> ${path}`);
});

test('character classes support negation, ranges, literal brackets and POSIX ASCII classes', () => {
  for (const [pattern, path, expected] of [
    ['[a-c]', 'b', true], ['[!a-c]', 'z', true], ['[^a-c]', 'b', false], ['[]a]', ']', true],
    ['[-a]', '-', true], ['[a-]', '-', true], ['[a-b-c]', '-', true], ['[a-b-c]', 'c', true],
    ['[[:digit:]]', '5', true], ['[[:alpha:]]', 'A', true], ['[[:alpha:]]', 'é', false],
    ['[[:blank:]]', '\t', true], ['[[:xdigit:]]', 'f', true], ['[[:xdigit:]]', 'g', false],
    ['[[:lower:]]', 'A', false], ['[[:space:]]', '\r', true], ['[/]', 'a', false],
    ['[c-a]', 'c', true], ['[c-a]', 'a', false], ['[9-0]', '9', true], ['[z-a]', 'z', true],
    ['[a-[:digit:]]', 'a', false], ['[a-[:digit:]]', '5', false], ['[a-[:digit:]]', '-', false],
    ['[a-\\]]', 'a', true], ['[a-\\]]', ']', false], ['[[:digit:]-a]', '5', true], ['[[:digit:]-a]', '-', true],
  ]) assert.equal(ignored(pattern, path), expected, `${pattern} -> ${path}`);
});

test('invalid patterns never match while file encoding and declared size limits reject explicitly', () => {
  for (const pattern of ['bad\\', '[abc', '[]', '[!]', '[[:unknown:]]', '!']) {
    const rules = compileGitignore(pattern);
    assert.equal(rules[0].invalid, true, pattern);
    assert.equal(matchRules(rules, 'bad', false), null);
  }
  for (const value of ['\0', '\ud800', null, {}]) assert.throws(() => compileGitignore(value), { code: 'GITIGNORE_INVALID' });
  assert.throws(() => compileGitignore('x'.repeat(GITIGNORE_LIMITS.patternBytes + 1)), { code: 'GITIGNORE_LIMIT' });
  assert.throws(() => compileGitignore('#' + 'x'.repeat(GITIGNORE_LIMITS.fileBytes)), { code: 'GITIGNORE_LIMIT' });
  assert.throws(() => compileGitignore('x\n'.repeat(GITIGNORE_LIMITS.rules + 1)), { code: 'GITIGNORE_LIMIT' });
});

test('matching work is deterministic, shared across calls and stops before an excessive star computation', () => {
  const budget = createIgnoreBudget(100), rules = compileGitignore('*a*a*a*a*a*a*a*a*b');
  assert.throws(() => matchRules(rules, 'a'.repeat(64), false, { budget }), { code: 'GITIGNORE_LIMIT' });
  assert.ok(budget.used <= 100);
  const shared = createIgnoreBudget(4), literal = compileGitignore('x');
  assert.equal(matchRules(literal, 'x', false, { budget: shared }).ignored, true);
  assert.equal(matchRules(literal, 'x', false, { budget: shared }).ignored, true);
  assert.throws(() => matchRules(literal, 'x', false, { budget: shared }), { code: 'GITIGNORE_LIMIT' });
  assert.ok(Object.isFrozen(literal) && Object.isFrozen(literal[0]));
});
