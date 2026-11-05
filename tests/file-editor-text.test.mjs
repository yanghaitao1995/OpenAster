import test from 'node:test';
import assert from 'node:assert/strict';
import { EDITOR_MAX_BYTES, inspectEditorText, encodeEditorText } from '../public/file-editor-text.mjs';

test('opening and closing a text editor preserves BOMs, spaces and every newline format byte for byte', () => {
  const samples = ['', '\uFEFF', 'no newline  ', '  leading\t', '\n', '\r', '\r\n', '\uFEFF\uFEFFvalue\r\n', 'first\r\nsecond\r\n', 'first\rsecond', 'first\nsecond\n\n', '\uFEFF一\r\n二\n三\r四  ', 'emoji 🧑🏽‍💻\n𝄞'];
  for (const sample of samples) {
    const inspected = inspectEditorText(sample);
    assert.equal(inspected.bytes, Buffer.byteLength(sample));
    assert.ok(Object.isFrozen(inspected));
    assert.equal(encodeEditorText(sample, inspected.text), sample);
  }
});

test('an edit retains the original BOM and uniform newline convention without trimming or adding a final line', () => {
  assert.deepEqual(inspectEditorText('\uFEFFa\r\nb\r\n'), { bom: true, ending: 'CRLF', text: 'a\nb\n', bytes: 9 });
  assert.equal(encodeEditorText('\uFEFFa\r\nb\r\n', '  new\nvalue\n\n'), '\uFEFF  new\r\nvalue\r\n\r\n');
  assert.equal(encodeEditorText('a\rb', 'changed\nend'), 'changed\rend');
  assert.equal(encodeEditorText('a\nb\n', ''), '');
  assert.equal(encodeEditorText('\uFEFFa\nb\n', ''), '\uFEFF');
  assert.equal(encodeEditorText('a', 'a\nb'), 'a\nb');
  assert.equal(encodeEditorText('', 'a\nb\n'), 'a\nb\n');
});

test('mixed line endings require an explicit choice after editing and allow intentional format-only changes', () => {
  const original = '\uFEFFa\r\nb\nc\rd';
  assert.equal(inspectEditorText(original).ending, 'mixed');
  assert.throws(() => encodeEditorText(original, 'a\nb\nc\nchanged'), { code: 'FILE_EDITOR_EOL_REQUIRED' });
  assert.equal(encodeEditorText(original, 'a\nb\nc\nchanged', { ending: 'CRLF' }), '\uFEFFa\r\nb\r\nc\r\nchanged');
  assert.equal(encodeEditorText(original, 'a\nb\nc\nd', { ending: 'LF' }), '\uFEFFa\nb\nc\nd');
  assert.equal(encodeEditorText(original, 'a\nb\nc\nd', { ending: 'CR' }), '\uFEFFa\rb\rc\rd');
  assert.equal(encodeEditorText('one\r\ntwo\r\n', 'one\ntwo\n', { ending: 'LF' }), 'one\ntwo\n');
});

test('raw carriage returns and unsupported newline choices cannot silently transform an edit', () => {
  for (const ending of ['mixed', 'none', '', '\n', 'toString', '__proto__', null]) {
    assert.throws(() => encodeEditorText('a', 'b', { ending }), { code: 'FILE_EDITOR_INVALID_EOL' });
  }
  for (const value of ['a\rb', 'a\r\nb']) assert.throws(() => encodeEditorText('a', value), { code: 'FILE_EDITOR_INVALID_EOL' });
});

test('malformed Unicode and NUL are rejected before UTF-8 replacement can change the requested text', () => {
  for (const value of ['\ud800', 'a\udc00', '\ud800x', '\ud800\ud800', '\udfff\udbff']) {
    assert.throws(() => inspectEditorText(value), { code: 'FILE_EDITOR_INVALID_UNICODE' });
    assert.throws(() => encodeEditorText('original', value), { code: 'FILE_EDITOR_INVALID_UNICODE' });
  }
  for (const value of ['\0', 'before\0after']) {
    assert.throws(() => inspectEditorText(value), { code: 'FILE_EDITOR_NUL' });
    assert.throws(() => encodeEditorText('original', value), { code: 'FILE_EDITOR_NUL' });
  }
  for (const value of [null, undefined, 42, {}, ['text']]) assert.throws(() => inspectEditorText(value), { code: 'FILE_EDITOR_INVALID_TEXT' });
  assert.equal(encodeEditorText('', '\ud800\udc00'), '𐀀');
});

test('the limit applies to final UTF-8 bytes including retained BOM and expanded CRLF', () => {
  assert.equal(EDITOR_MAX_BYTES, 262144);
  assert.equal(inspectEditorText('a'.repeat(262144)).bytes, 262144);
  assert.throws(() => inspectEditorText('a'.repeat(262145)), { code: 'FILE_EDITOR_TOO_LARGE' });
  assert.equal(inspectEditorText('😀'.repeat(65536)).bytes, 262144);
  assert.throws(() => inspectEditorText('😀'.repeat(65537)), { code: 'FILE_EDITOR_TOO_LARGE' });
  assert.equal(Buffer.byteLength(encodeEditorText('\uFEFF', 'a'.repeat(262141))), 262144);
  assert.throws(() => encodeEditorText('\uFEFF', 'a'.repeat(262142)), { code: 'FILE_EDITOR_TOO_LARGE' });
  assert.equal(Buffer.byteLength(encodeEditorText('\r\n', 'a'.repeat(262142) + '\n')), 262144);
  assert.throws(() => encodeEditorText('\r\n', 'a'.repeat(262143) + '\n'), { code: 'FILE_EDITOR_TOO_LARGE' });
});

test('source-like markup is ordinary editable text and format conversion uses literal replacements', () => {
  const body = '<img src=x onerror="throw 1">\n$& $$ $1 $` ${secret}\n';
  assert.equal(encodeEditorText('\uFEFF\r\n', body), '\uFEFF<img src=x onerror="throw 1">\r\n$& $$ $1 $` ${secret}\r\n');
  assert.equal(inspectEditorText('\uFEFF\uFEFFx').text, '\uFEFFx');
});
