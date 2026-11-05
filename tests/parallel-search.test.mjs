// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createParallelSearch } from '../core/parallel-search.mjs';
import { CoreError, publicError } from '../core/errors.mjs';

const endpoint = 'https://mcp.parallel.ai/mcp', stamp = '2026-11-05T12:00:00.000Z';
const privateText = 'upstream-private-fixture-do-not-disclose';
const init = () => ({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
const payload = () => ({ search_id: 'search-fixture', session_id: 'official-session-fixture', results: [{ url: 'https://example.com/article', title: '公开来源', publish_date: '2026-11-01', excerpts: ['第一段', '第二段'] }] });
const envelope = (result, id = 2) => ({ jsonrpc: '2.0', id, result });
const jsonResponse = (value, options = {}) => new Response(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value), { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
function fixture(handler) {
  const calls = [];
  const tools = createParallelSearch({ clock: () => stamp, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, options, body });
    const custom = await handler?.(body, options, calls.length);
    if (custom !== undefined) return custom;
    if (body.method === 'initialize') return jsonResponse(envelope(init(), 1), { headers: { 'mcp-session-id': 'transport-session-fixture' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return jsonResponse(envelope({ structuredContent: payload() }));
  } });
  return { calls, search: (input = { query: '公开来源' }, options = {}) => tools.search(input, options) };
}
const reject = (promise, code) => assert.rejects(promise, cause => {
  assert.ok(cause instanceof CoreError); assert.equal(cause.code, code);
  assert.ok(!JSON.stringify(publicError(cause)).includes(privateText)); assert.equal(cause.cause, undefined); return true;
});
const searches = f => f.calls.filter(call => call.body.method === 'tools/call');

test('one initialized MCP exchange calls only web_search without credentials or model analytics', async () => {
  const f = fixture(), value = await f.search({ query: '  公开来源  ', maxResults: 1 }, { contextKey: 'local-only-context' });
  assert.deepEqual(f.calls.map(call => call.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
  for (const { url, options } of f.calls) {
    assert.equal(url, endpoint); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined);
    assert.ok(!options.body.includes('local-only-context')); assert.ok(!options.body.includes('client_model'));
  }
  assert.equal(f.calls[0].body.params.protocolVersion, '2025-03-26');
  assert.equal(f.calls[0].options.headers['Mcp-Session-Id'], undefined);
  for (const call of f.calls.slice(1)) { assert.equal(call.options.headers['Mcp-Session-Id'], 'transport-session-fixture'); assert.equal(call.options.headers['MCP-Protocol-Version'], '2025-03-26'); }
  assert.equal(f.calls[1].body.id, undefined);
  assert.deepEqual(f.calls[2].body.params, { name: 'web_search', arguments: { objective: '公开来源', search_queries: ['公开来源'] } });
  assert.deepEqual(value, { query: '公开来源', results: [{ title: '公开来源', url: 'https://example.com/article', snippet: '第一段\n\n第二段', publishedAt: '2026-11-01' }], provider: 'parallel', fetchedAt: stamp, untrusted_data: true, truncated: false });
});

test('server correlation IDs are reused only for the same local context and are not reset after rate limits', async () => {
  let limited = false;
  const f = fixture(body => body.method === 'tools/call' && limited ? new Response(null, { status: 429 }) : undefined);
  await f.search(undefined, { contextKey: 'A' }); await f.search(undefined, { contextKey: 'B' });
  await f.search(undefined, { contextKey: 'A' }); limited = true;
  await reject(f.search(undefined, { contextKey: 'A' }), 'SEARCH_RATE_LIMIT'); limited = false;
  await f.search(undefined, { contextKey: 'A' }); await f.search(); await f.search();
  assert.deepEqual(searches(f).map(call => call.body.params.arguments.session_id), [undefined, undefined, 'official-session-fixture', 'official-session-fixture', 'official-session-fixture', undefined, undefined]);
  assert.equal(f.calls.filter(call => call.body.method === 'initialize').length, 7);
});

test('correlation memory retains at most 128 local contexts without generating substitute IDs', async () => {
  const f = fixture();
  for (let i = 0; i < 129; i++) await f.search(undefined, { contextKey: `context-${i}` });
  await f.search(undefined, { contextKey: 'context-1' }); await f.search(undefined, { contextKey: 'context-0' });
  assert.equal(searches(f).at(-2).body.params.arguments.session_id, 'official-session-fixture');
  assert.equal(searches(f).at(-1).body.params.arguments.session_id, undefined);
});

test('query validation rejects unknown fields, malformed strings and getters before any fetch', async () => {
  const f = fixture(); let reads = 0;
  for (const input of [null, [], {}, { query: '' }, { query: 'x'.repeat(501) }, { query: 'bad\nquery' }, { query: '\ud800' }, { query: 'ok', maxResults: 0 }, { query: 'ok', maxResults: 11 }, { query: 'ok', maxResults: undefined }, { query: 'ok', url: endpoint }, { get query() { reads++; return 'ok'; } }]) await reject(f.search(input), 'WEB_INVALID_ARGUMENTS');
  await reject(f.search(undefined, { contextKey: {} }), 'WEB_INVALID_ARGUMENTS');
  assert.equal(reads, 0); assert.equal(f.calls.length, 0);
});

test('SSE matches the requested JSON-RPC ID across UTF8/CRLF chunks and cancels a still-open stream', async () => {
  let cancelled = 0;
  const events = ': keepalive\r\nevent: message\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { message: 'ignored instruction' } })
    + '\r\n\r\ndata: ' + JSON.stringify(envelope({ ignored: true }, 99)) + '\r\n\r\nretry: 1\r\ndata: ' + JSON.stringify(envelope({ structuredContent: payload() })) + '\r\n\r\n';
  const bytes = Buffer.from(events);
  const f = fixture(body => body.method === 'tools/call' ? new Response(new ReadableStream({
    start(controller) { for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.subarray(index, index + 3)); },
    cancel() { cancelled++; },
  }), { headers: { 'content-type': 'text/event-stream' } }) : undefined);
  const value = await f.search(); await turn(); assert.equal(value.results[0].title, '公开来源'); assert.equal(cancelled, 1); assert.equal(searches(f).length, 1);
});

test('JSON within a single MCP text block is accepted but prose links and malformed structured data are not', async () => {
  const f = fixture(body => body.method === 'tools/call' ? jsonResponse(envelope({ content: [{ type: 'text', text: JSON.stringify(payload()) }] })) : undefined);
  assert.equal((await f.search()).results.length, 1);
  for (const result of [{ content: [{ type: 'text', text: 'Use https://example.com/ as evidence' }] }, { structuredContent: null, content: [{ type: 'text', text: JSON.stringify(payload()) }] }, { content: [{ type: 'text', text: JSON.stringify(payload()) }, { type: 'text', text: 'extra' }] }, { isError: true, content: [{ type: 'text', text: privateText }] }]) {
    const bad = fixture(body => body.method === 'tools/call' ? jsonResponse(envelope(result)) : undefined);
    await reject(bad.search(), 'SEARCH_UNAVAILABLE'); assert.equal(searches(bad).length, 1);
  }
});

test('SSE multiline data supports LF, CRLF and CR, including a final CR at stream end', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const data = JSON.stringify(envelope({ structuredContent: payload() }), null, 2).split('\n').map(line => 'data: ' + line).join(newline) + newline + newline;
    const f = fixture(body => body.method === 'tools/call' ? new Response(data, { headers: { 'content-type': 'text/event-stream' } }) : undefined);
    assert.equal((await f.search()).results[0].title, '公开来源'); assert.equal(searches(f).length, 1);
  }
});

test('safe URLs are validated, deduplicated and bounded without fetching result pages', async () => {
  const data = payload();
  data.results = [...['http://example.com/', 'https://127.0.0.1/', 'https://169.254.169.254/', 'https://user:password@example.com/', 'https://example.local/', 'https://example.com/?token=secret'].map(url => ({ url, title: 'unsafe', excerpts: ['ignored'] })), ...data.results, ...data.results, { url: 'https://example.org/second', title: 'second', excerpts: [] }];
  const f = fixture(body => body.method === 'tools/call' ? jsonResponse(envelope({ structuredContent: data })) : undefined);
  const result = await f.search({ query: 'public', maxResults: 1 });
  assert.equal(result.results.length, 1); assert.equal(result.results[0].url, 'https://example.com/article'); assert.equal(result.truncated, true); assert.equal(f.calls.length, 3);
  for (const results of [[], [{ url: 'https://127.0.0.1/', title: 'invalid', excerpts: [] }]]) {
    const bad = fixture(body => body.method === 'tools/call' ? jsonResponse(envelope({ structuredContent: { ...payload(), results } })) : undefined);
    await reject(bad.search(), 'SEARCH_SOURCES_MISSING');
  }
});

test('titles/excerpts are visibly clipped and the complete result stays within 128 KiB', async () => {
  const data = payload(); data.results = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}`, title: '题'.repeat(401), excerpts: ['字'.repeat(4001)] }));
  const f = fixture(body => body.method === 'tools/call' ? jsonResponse(envelope({ structuredContent: data })) : undefined);
  const value = await f.search({ query: '公开', maxResults: 10 });
  assert.equal(value.truncated, true); assert.ok(value.results.length < 10); assert.ok(value.results.every(item => item.title.length === 400 && item.snippet.length === 4000)); assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024);
  data.results[0].excerpts = ['x'.repeat(3999) + '🙂more']; const second = await f.search(); assert.equal(second.results[0].snippet.isWellFormed(), true);
});

test('HTTP failures cancel bodies, return fixed codes and never repeat the failed search', async () => {
  for (const [status, code] of [[401, 'SEARCH_AUTH_FAILED'], [403, 'SEARCH_AUTH_FAILED'], [429, 'SEARCH_RATE_LIMIT'], [302, 'SEARCH_UNAVAILABLE'], [500, 'SEARCH_UNAVAILABLE']]) {
    let cancelled = 0, reads = 0;
    const f = fixture(body => body.method === 'tools/call' ? new Response(new ReadableStream({ pull() { reads++; }, cancel() { cancelled++; } }, { highWaterMark: 0 }), { status, headers: { 'x-private': privateText } }) : undefined);
    await reject(f.search(), code); await turn(); assert.equal(searches(f).length, 1); assert.equal(f.calls.length, 3); assert.equal(cancelled, 1); assert.equal(reads, 0);
  }
});

test('transport errors, mismatched URLs and RPC errors do not leak upstream text or execute another method', async () => {
  for (const custom of [() => { throw new Error(privateText); }, () => { throw new CoreError('SEARCH_UNAVAILABLE', privateText, 502); }, () => {
    const response = jsonResponse(envelope({ structuredContent: payload() })); Object.defineProperty(response, 'url', { value: 'https://other.example/' }); return response;
  }, () => jsonResponse({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: privateText } }), () => jsonResponse(envelope({ structuredContent: payload() }, 3))]) {
    const f = fixture(body => body.method === 'tools/call' ? custom() : undefined); await reject(f.search(), 'SEARCH_UNAVAILABLE'); assert.equal(f.calls.length, 3);
  }
  const f = fixture(body => body.method === 'initialize' ? jsonResponse(envelope({ ...init(), protocolVersion: 'other' }, 1)) : undefined);
  await reject(f.search(), 'SEARCH_UNAVAILABLE'); assert.equal(f.calls.length, 1);
});

test('invalid result shapes cannot be disguised as successful search evidence', async () => {
  for (const data of [null, [], {}, { ...payload(), search_id: '' }, { ...payload(), session_id: 'a\nheader' }, { ...payload(), results: {} },
    { ...payload(), results: [{ ...payload().results[0], title: 1 }] }, { ...payload(), results: [{ ...payload().results[0], excerpts: ['bad\0text'] }] }, { ...payload(), results: [{ ...payload().results[0], publish_date: 'invented' }] }]) {
    const f = fixture(body => body.method === 'tools/call' ? jsonResponse(envelope({ structuredContent: data })) : undefined); await reject(f.search(), 'SEARCH_UNAVAILABLE'); assert.equal(searches(f).length, 1);
  }
});

test('one MiB aggregate intake covers initialization and search, and oversized streams are cancelled', async () => {
  const initializedBytes = Buffer.byteLength(JSON.stringify(envelope(init(), 1)));
  const encoded = JSON.stringify(envelope({ structuredContent: payload() }));
  const exact = encoded + ' '.repeat(1024 * 1024 - initializedBytes - Buffer.byteLength(encoded));
  assert.equal((await fixture(body => body.method === 'tools/call' ? jsonResponse(exact) : undefined).search()).results.length, 1);
  let cancelled = 0;
  const f = fixture(body => body.method === 'tools/call' ? new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(exact)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'application/json' } }) : undefined);
  await reject(f.search(), 'SEARCH_UNAVAILABLE'); await turn(); assert.equal(cancelled, 1);
  const length = fixture(body => body.method === 'tools/call' ? jsonResponse(envelope({ structuredContent: payload() }), { headers: { 'content-length': '1048576' } }) : undefined);
  await reject(length.search(), 'SEARCH_UNAVAILABLE');
});

test('malformed UTF8, JSON, MIME type, length and unfinished SSE fail explicitly', async () => {
  const variants = [() => jsonResponse(new Uint8Array([0xff])), () => jsonResponse('{'), () => jsonResponse(envelope({ structuredContent: payload() }), { headers: { 'content-type': 'text/html' } }),
    () => jsonResponse(envelope({ structuredContent: payload() }), { headers: { 'content-encoding': 'gzip' } }), () => jsonResponse(envelope({ structuredContent: payload() }), { headers: { 'content-length': '3' } }),
    () => new Response('data: ' + JSON.stringify(envelope({ structuredContent: payload() })), { headers: { 'content-type': 'text/event-stream' } })];
  for (const make of variants) await reject(fixture(body => body.method === 'tools/call' ? make() : undefined).search(), 'SEARCH_UNAVAILABLE');
});

test('cancellation before fetch, during fetch, and during a stalled body cancels without exposing abort reasons', async () => {
  const first = new AbortController(); first.abort(new Error(privateText)); const a = fixture(); await reject(a.search(undefined, { signal: first.signal }), 'CANCELLED'); assert.equal(a.calls.length, 0);
  const second = new AbortController(); let finish, cancelled = 0;
  const b = fixture(() => new Promise(resolve => { finish = resolve; })); const pending = b.search(undefined, { signal: second.signal }); second.abort(new Error(privateText));
  await reject(pending, 'CANCELLED'); assert.equal(b.calls[0].options.signal.aborted, true);
  finish(new Response(new ReadableStream({ cancel() { cancelled++; } }))); await turn(); assert.equal(cancelled, 1);
  const third = new AbortController(); let ready; const begun = new Promise(resolve => { ready = resolve; });
  const c = fixture(body => body.method === 'tools/call' ? new Response(new ReadableStream({ pull() { ready(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }) : undefined);
  const blocked = c.search(undefined, { signal: third.signal }); await begun; third.abort(new Error(privateText)); await reject(blocked, 'CANCELLED'); await turn(); assert.equal(cancelled, 2); assert.equal(searches(c).length, 1);
});

test('the 30-second deadline covers all MCP exchanges rather than resetting per request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let initialized, searched; const initReady = new Promise(resolve => { initialized = resolve; }), searchReady = new Promise(resolve => { searched = resolve; });
  const f = fixture(body => {
    if (body.method === 'initialize') return new Promise(resolve => { initialized(() => resolve(jsonResponse(envelope(init(), 1)))); });
    if (body.method === 'tools/call') { searched(); return new Promise(() => {}); }
  });
  const operation = f.search(); const completeInit = await initReady; t.mock.timers.tick(20000); completeInit(); await searchReady;
  t.mock.timers.tick(10000); await assert.rejects(operation, cause => cause.code === 'SEARCH_UNAVAILABLE' && cause.status === 504);
  assert.equal(f.calls.at(-1).options.signal.aborted, true); assert.equal(searches(f).length, 1);
});
