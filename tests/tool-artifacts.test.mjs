import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateToolArtifact, validateToolResultRef, validateContextPlan, paginateToolArtifact, TOOL_ARTIFACT_LIMITS, MODEL_REQUEST_BYTE_LIMIT } from '../core/tool-artifacts.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
function artifact(text = '\uFEFF第一行\r\n😀末尾\n') {
  const content = JSON.stringify({ untrusted_data: true, result: { path: 'src/notes.txt', content: text } });
  return { id: 'tool-1', stepId: 'tool-1', sessionId: 'session-1', runId: 'run-1', callId: 'call.1', name: 'read_file', path: 'src/notes.txt', isError: false, createdAt: '2026-10-28T00:00:00.000Z', bytes: Buffer.byteLength(content), sha256: digest(content), content };
}
function reference(value = artifact()) {
  return { artifactId: value.id, name: value.name, path: value.path, isError: value.isError, bytes: value.bytes, sha256: value.sha256 };
}
function plan(value = artifact()) {
  return { version: 1, policy: 'preserve-messages-reference-tools', requestBytes: 1024, requestByteLimit: MODEL_REQUEST_BYTE_LIMIT, requestSha256: 'a'.repeat(64), preservedMessages: 1, toolResults: [{ artifactId: value.id, mode: 'full', sourceBytes: value.bytes, sentBytes: value.bytes, ranges: [{ start: 0, end: value.bytes }] }] };
}
const invalid = code => error => error.code === code;

test('tool artifacts preserve exact historical JSON bytes and return independent metadata', () => {
  const value = artifact();
  const clean = validateToolArtifact(value), ref = validateToolResultRef(reference(value));
  assert.deepEqual(clean, value); assert.notEqual(clean, value);
  assert.deepEqual(ref, reference(value));
  assert.equal(JSON.parse(clean.content).result.content, '\uFEFF第一行\r\n😀末尾\n');
  const error = JSON.stringify({ untrusted_data: true, error: { code: 'FILE_CHANGED', message: '旧版本' } });
  assert.equal(validateToolArtifact({ ...value, isError: true, content: error, bytes: Buffer.byteLength(error), sha256: digest(error) }).isError, true);
});

test('tool artifact identities, hashes, lengths, Unicode and envelopes reject corrupted archives', () => {
  const value = artifact();
  for (const changed of [
    { id: 'other' }, { sessionId: '../outside' }, { name: 'shell.run' }, { path: '../outside' },
    { path: undefined }, { bytes: value.bytes + 1 }, { sha256: '0'.repeat(64) }, { isError: true },
    { createdAt: '2026-02-30T00:00:00.000Z' }, { callId: '\0' }, { callId: '\uD800' },
    { content: value.content + '\0' }, { content: '\uD800' }, { extra: true },
  ]) assert.throws(() => validateToolArtifact({ ...value, ...changed }), invalid('INVALID_TOOL_ARTIFACT'));
  for (const content of ['null', '[]', '{}', '{"untrusted_data":false,"result":{}}', '{"untrusted_data":true,"result":{},"extra":1}']) {
    assert.throws(() => validateToolArtifact({ ...value, content, bytes: Buffer.byteLength(content), sha256: digest(content) }), invalid('INVALID_TOOL_ARTIFACT'));
  }
  const tooLarge = artifact('x'.repeat(TOOL_ARTIFACT_LIMITS.maxBytes));
  assert.throws(() => validateToolArtifact(tooLarge), invalid('INVALID_TOOL_ARTIFACT'));
});

test('UTF-8 pages reassemble exact BOM, CRLF, Unicode and long-line snapshots without splitting code points', () => {
  const value = artifact('\uFEFF中文😀\r\n' + '长'.repeat(70) + '\r最后');
  let offset = 0; const chunks = [];
  do {
    const page = paginateToolArtifact(value, { offset, maxBytes: 7 });
    assert.equal(page.offset, offset); assert.ok(page.endOffset > offset);
    assert.equal(Buffer.byteLength(page.content), page.endOffset - offset);
    assert.equal(page.content.includes('\uFFFD'), false);
    assert.equal(page.complete, false);
    chunks.push(page.content); offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(chunks.join(''), value.content);
  assert.equal(digest(chunks.join('')), value.sha256);
  assert.deepEqual(paginateToolArtifact(value, { offset: value.bytes, maxBytes: 4 }), { offset: value.bytes, endOffset: value.bytes, nextOffset: null, complete: false, content: '' });
  assert.equal(paginateToolArtifact(value).complete, true);
});

test('pagination rejects invalid starts and hostile limits rather than rounding or over-reading', () => {
  const value = artifact(); const bytes = Buffer.from(value.content); const chinese = bytes.indexOf(Buffer.from('第'));
  for (const offset of [-1, 0.5, '0', value.bytes + 1, chinese + 1]) {
    assert.throws(() => paginateToolArtifact(value, { offset }), invalid('INVALID_ARTIFACT_RANGE'));
  }
  for (const maxBytes of [0, 1, 3, 4.1, '8', Infinity, TOOL_ARTIFACT_LIMITS.maxPageBytes + 1]) {
    assert.throws(() => paginateToolArtifact(value, { maxBytes }), invalid('INVALID_ARTIFACT_RANGE'));
  }
});

test('context plans distinguish exact, partial and reference-only views with bounded ranges', () => {
  const full = plan(); assert.deepEqual(validateContextPlan(full), full);
  const excerpt = structuredClone(full); Object.assign(excerpt.toolResults[0], { mode: 'excerpt', sentBytes: 200, ranges: [{ start: 0, end: 10 }, { start: 20, end: 25 }] });
  assert.deepEqual(validateContextPlan(excerpt), excerpt);
  const ref = structuredClone(full); Object.assign(ref.toolResults[0], { mode: 'reference', sentBytes: 120, ranges: [] });
  assert.deepEqual(validateContextPlan(ref), ref);
  const clean = validateContextPlan(full); clean.toolResults[0].ranges[0].end = 1;
  assert.notEqual(full.toolResults[0].ranges[0].end, 1);
});

test('context plans reject ambiguous scope, duplicate sources and claimed completeness mismatches', () => {
  const full = plan();
  const bad = [
    { requestBytes: MODEL_REQUEST_BYTE_LIMIT + 1 }, { requestByteLimit: MODEL_REQUEST_BYTE_LIMIT + 1 },
    { requestBytes: 0 }, { preservedMessages: 0 }, { preservedMessages: 1.5 }, { version: 2 },
    { requestSha256: 'not-a-hash' }, { policy: 'silently-summarize' }, { extra: true },
    { toolResults: [full.toolResults[0], full.toolResults[0]] }, { toolResults: new Array(1) },
  ];
  for (const changed of bad) assert.throws(() => validateContextPlan({ ...full, ...changed }), invalid('INVALID_CONTEXT_PLAN'));
  for (const changed of [
    { mode: 'full', ranges: [] }, { mode: 'full', sentBytes: 5 },
    { mode: 'reference', ranges: [{ start: 0, end: 1 }] },
    { mode: 'excerpt', ranges: [] }, { mode: 'excerpt', ranges: full.toolResults[0].ranges },
    { mode: 'excerpt', ranges: [{ start: 0, end: 20 }, { start: 19, end: 30 }] },
    { mode: 'excerpt', ranges: [{ start: 0, end: full.toolResults[0].sourceBytes + 1 }] },
  ]) assert.throws(() => validateContextPlan({ ...full, toolResults: [{ ...full.toolResults[0], ...changed }] }), invalid('INVALID_CONTEXT_PLAN'));
});

test('artifact and plan validators do not invoke accessors or accept hidden extra properties', () => {
  let called = false;
  const value = artifact(); Object.defineProperty(value, 'content', { get() { called = true; throw Error('getter'); } });
  assert.throws(() => validateToolArtifact(value), invalid('INVALID_TOOL_ARTIFACT')); assert.equal(called, false);
  const valueRef = reference(); Object.defineProperty(valueRef, 'extra', { value: true, enumerable: false });
  assert.throws(() => validateToolResultRef(valueRef), invalid('INVALID_TOOL_ARTIFACT'));
  const valuePlan = plan(); Object.defineProperty(valuePlan.toolResults, '0', { get() { called = true; throw Error('getter'); } });
  assert.throws(() => validateContextPlan(valuePlan), invalid('INVALID_CONTEXT_PLAN')); assert.equal(called, false);
});
