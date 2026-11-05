// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createBailianSearch } from '../core/bailian-search.mjs';
import { CoreError, publicError } from '../core/errors.mjs';

const key = 'isolated-search-fixture-not-a-real-key';
const provider = { type: 'openai', model: 'qwen-test', baseUrl: 'https://model.example.test/compatible-mode/v1', apiKey: key };
const stamp = '2026-11-05T12:00:00.000Z';
const searchItem = sources => ({ type: 'web_search_call', id: 'search-fixture', status: 'completed', action: { type: 'search', query: 'public query', sources: sources ?? [{ type: 'url', url: 'https://example.com/article' }] } });
const message = text => ({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
const payload = () => ({ object: 'response', status: 'completed', error: null, output: [searchItem(), message('服务商生成的简短归纳。')], usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32, output_tokens_details: { reasoning_tokens: 0 }, x_tools: { web_search: { count: 1 } } } });
const response = (value = payload(), options = {}) => new Response(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value), { headers: { 'content-type': 'application/json', ...options.headers }, ...options });
function fixture(fetcher = async () => response()) {
  const calls = [];
  const tools = createBailianSearch({ clock: () => stamp, fetchImpl: (...args) => { calls.push(args); return fetcher(...args); } });
  return { calls, search: (input = { query: '公开问题' }, options = {}) => tools.search(input, { provider, ...options }) };
}
const rejects = (operation, code) => assert.rejects(operation, failure => {
  assert.ok(failure instanceof CoreError); assert.equal(failure.code, code);
  assert.ok(!JSON.stringify(publicError(failure)).includes(key)); assert.equal(failure.cause, undefined); return true;
});

test('one fixed synchronous request preserves the configured base and maps only provider sources', async () => {
  const f = fixture(), result = await f.search({ query: '  公开问题  ', maxResults: 3 }, { provider: { ...provider, baseUrl: provider.baseUrl + '/' } });
  assert.equal(f.calls.length, 1);
  const [url, options] = f.calls[0]; assert.equal(url, provider.baseUrl + '/responses');
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.headers.Authorization, `Bearer ${key}`); assert.equal(options.headers.Cookie, undefined);
  assert.deepEqual(JSON.parse(options.body), { model: 'qwen-test', input: '公开问题', tools: [{ type: 'web_search' }], tool_choice: 'required', reasoning: { effort: 'none' }, store: false, max_output_tokens: 512, stream: false });
  assert.deepEqual(result, { query: '公开问题', results: [{ title: 'example.com', url: 'https://example.com/article', snippet: '' }], summary: '服务商生成的简短归纳。', summaryKind: 'model-generated', provider: 'bailian', sourceStatus: 'provided', fetchedAt: stamp, untrusted_data: true, truncated: false, usage: { inputTokens: 20, outputTokens: 12, totalTokens: 32, reasoningTokens: 0, searchCount: 1 } });
});

test('responses connections retain the exact configured host, port and nested base path', async () => {
  const f = fixture(); await f.search(undefined, { provider: { ...provider, type: 'responses', baseUrl: 'https://proxy.example.test:8443/custom/compatible-mode/v1' } });
  assert.equal(f.calls[0][0], 'https://proxy.example.test:8443/custom/compatible-mode/v1/responses'); assert.equal(f.calls.length, 1);
});

test('strict query and result count validation rejects unknown fields and accessors without invoking them', async () => {
  const f = fixture(); let reads = 0;
  for (const input of [null, [], {}, { query: '' }, { query: 'x'.repeat(501) }, { query: 'bad\nquery' }, { query: '\ud800' }, { query: 'ok', maxResults: 0 }, { query: 'ok', maxResults: 11 }, { query: 'ok', maxResults: null }, { query: 'ok', maxResults: undefined }, { query: 'ok', maxResults: '2' }, { query: 'ok', baseUrl: 'https://evil.example' }, { get query() { reads++; return 'ok'; } }]) await rejects(f.search(input), 'WEB_INVALID_ARGUMENTS');
  assert.equal(reads, 0); assert.equal(f.calls.length, 0);
});

test('missing keys, unsupported providers and unsafe bases fail before fetch', async () => {
  const f = fixture();
  for (const apiKey of [undefined, '', '   ']) await rejects(f.search(undefined, { provider: { ...provider, apiKey } }), 'SEARCH_NOT_CONFIGURED');
  for (const fields of [{ type: 'anthropic' }, { type: 'demo' }, { model: 'other-model' }]) await rejects(f.search(undefined, { provider: { ...provider, ...fields } }), 'SEARCH_UNSUPPORTED');
  for (const baseUrl of ['', 'http://127.0.0.1/v1', 'https://user:password@example.test/v1', 'https://example.test/v1?token=private', 'https://example.test/v1#fragment', 'https://example.test/v1/../other', 'https://example.test/v1/%2e%2e/other', 'https://example.test/v1\\other']) await rejects(f.search(undefined, { provider: { ...provider, baseUrl } }), 'SEARCH_NOT_CONFIGURED');
  await rejects(f.search(undefined, { provider: { ...provider, apiKey: 'key\nheader' } }), 'SEARCH_NOT_CONFIGURED');
  let reads = 0; await rejects(f.search(undefined, { provider: { ...provider, get apiKey() { reads++; return key; } } }), 'SEARCH_NOT_CONFIGURED');
  assert.equal(reads, 0); assert.equal(f.calls.length, 0);
});

test('HTTP errors have fixed public codes, cancel response bodies and never retry or expose upstream secrets', async () => {
  for (const [status, code] of [[401,'SEARCH_AUTH_FAILED'], [403,'SEARCH_AUTH_FAILED'], [429,'SEARCH_RATE_LIMIT'], [404,'SEARCH_UNSUPPORTED'], [405,'SEARCH_UNSUPPORTED'], [400,'SEARCH_UNAVAILABLE'], [500,'SEARCH_UNAVAILABLE'], [503,'SEARCH_UNAVAILABLE'], [302,'SEARCH_UNAVAILABLE']]) {
    let cancelled = 0, reads = 0;
    const body = new ReadableStream({ pull() { reads++; }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    const f = fixture(async () => new Response(body, { status, headers: { 'content-type': 'application/json', location: `https://evil.example/${key}`, 'x-secret': key } }));
    await rejects(f.search(), code); await turn(); assert.equal(f.calls.length, 1); assert.equal(cancelled, 1); assert.equal(reads, 0);
  }
});

test('transport exceptions and injected public errors cannot leak their messages or trigger retries', async () => {
  for (const cause of [new Error(key), new CoreError('SEARCH_UNAVAILABLE', key, 502)]) {
    const f = fixture(async () => { throw cause; }); await rejects(f.search(), 'SEARCH_UNAVAILABLE'); assert.equal(f.calls.length, 1);
  }
});

test('redirected or mismatched response URLs are refused even if a custom transport ignores redirect policy', async () => {
  for (const properties of [{ redirected: true }, { url: 'https://evil.example/v1/responses' }, { url: provider.baseUrl + '/chat/completions' }]) {
    const value = response(); for (const [name, field] of Object.entries(properties)) Object.defineProperty(value, name, { value: field });
    const f = fixture(async () => value); await rejects(f.search(), 'SEARCH_UNAVAILABLE'); assert.equal(f.calls.length, 1);
  }
});

test('only safe HTTPS source objects are kept; inferred links, titles and snippets are never invented', async () => {
  const value = payload(); value.output = [searchItem([
    ...['http://example.com', 'https://127.0.0.1/', 'https://169.254.169.254/', 'https://[::ffff:127.0.0.1]/', 'https://user:password@example.com/', 'https://example.com/?api_key=secret', 'javascript:alert(1)', 'https://example.local/', 'https://example.com/#token'].map(url => ({ type: 'url', url })),
    { type: 'url', url: 'https://example.com/safe', title: '<script>injected</script>', snippet: 'pretend page excerpt' },
    { type: 'url', url: 'https://example.com/safe' }, { type: 'url', url: 'https://example.org/second' },
  ]), message('生成摘要中的 https://invented.example.org/ 不是返回来源。')];
  const f = fixture(async () => response(value)), result = await f.search({ query: 'public', maxResults: 1 });
  assert.deepEqual(result.results, [{ title: 'example.com', url: 'https://example.com/safe', snippet: '' }]); assert.equal(result.truncated, true); assert.equal(result.summaryKind, 'model-generated'); assert.equal(f.calls.length, 1);
});

test('completed search without valid sources is an explicit missing-evidence error, not synthesized success', async () => {
  for (const sources of [[], [{ type: 'url', url: 'https://127.0.0.1/' }], [{ type: 'url', url: `https://example.com/${key}` }], [{ type: 'other', url: 'https://example.com/' }]]) {
    const value = payload(); value.output = [searchItem(sources), message('来源 https://example.org/ 不应被当成证据。')];
    const f = fixture(async () => response(value)); await rejects(f.search(), 'SEARCH_SOURCES_MISSING'); assert.equal(f.calls.length, 1);
  }
  const value = payload(); delete value.output[0].action.sources; await rejects(fixture(async () => response(value)).search(), 'SEARCH_SOURCES_MISSING');
});

test('invalid or incomplete provider responses fail without executing any returned local tool', async () => {
  const variants = [null, [], {}, { ...payload(), status: 'incomplete' }, { ...payload(), status: 'failed' }, { ...payload(), error: { message: key } },
    { ...payload(), output: [message('没有搜索调用')] }, { ...payload(), output: [{ ...searchItem(), status: 'searching' }] },
    { ...payload(), output: [{ ...searchItem(), action: { type: 'open', sources: [] } }] },
    { ...payload(), output: [searchItem(), { type: 'function_call', name: 'run_command', arguments: key }] },
    { ...payload(), output: [searchItem(), message('bad\0text')] }, { ...payload(), output: [searchItem(), message(key)] },
    { ...payload(), output: [searchItem(), { ...message('text'), status: 'incomplete' }] }];
  for (const value of variants) { const f = fixture(async () => response(value)); await rejects(f.search(), 'SEARCH_UNAVAILABLE'); assert.equal(f.calls.length, 1); }
});

test('usage is allowlisted and bounded, reasoning and arbitrary provider metadata never enter result', async () => {
  const value = payload(); value.output.unshift({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'private reasoning fixture' }], encrypted_content: key, signature: key });
  value.usage = { input_tokens: -1, output_tokens: '12', total_tokens: 1e15, output_tokens_details: { reasoning_tokens: 8 }, x_tools: { web_search: { count: 1001 } }, apiKey: key };
  const result = await fixture(async () => response(value)).search();
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, totalTokens: null, reasoningTokens: 8, searchCount: null });
  assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(result).includes('private reasoning'));
});

test('an excessive generated summary is visibly truncated without splitting a surrogate pair', async () => {
  const value = payload(); value.output[1] = message('x'.repeat(19999) + '🙂more');
  const result = await fixture(async () => response(value)).search(); assert.equal(result.summary.length, 19999); assert.equal(result.summary.isWellFormed(), true); assert.equal(result.truncated, true);
});

test('declared or streamed byte limits cancel intake; exact one MiB JSON remains acceptable', async () => {
  const tooLarge = fixture(async () => response(payload(), { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }));
  await rejects(tooLarge.search(), 'SEARCH_UNAVAILABLE'); assert.equal(tooLarge.calls.length, 1);
  let cancelled = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled++; } });
  const f = fixture(async () => new Response(body, { headers: { 'content-type': 'application/json' } })); await rejects(f.search(), 'SEARCH_UNAVAILABLE'); await turn(); assert.equal(cancelled, 1);
  const json = JSON.stringify(payload()), exact = json + ' '.repeat(1024 * 1024 - Buffer.byteLength(json));
  assert.equal((await fixture(async () => response(exact)).search()).results.length, 1);
});

test('UTF8, JSON, transport completeness and media-type failures are not reported as successful searches', async () => {
  for (const value of [response(new Uint8Array([0xff])), response('{'), response(payload(), { headers: { 'content-type': 'text/html' } }), response(payload(), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }), response(payload(), { headers: { 'content-type': 'application/json', 'content-length': '3' } })]) await rejects(fixture(async () => value).search(), 'SEARCH_UNAVAILABLE');
});

test('already cancelled requests do not fetch and pending fetch cancels immediately without leaking abort reason', async () => {
  const a = new AbortController(); a.abort(new Error(key)); const first = fixture(); await rejects(first.search(undefined, { signal: a.signal }), 'CANCELLED'); assert.equal(first.calls.length, 0);
  const b = new AbortController(); let finish, bodyCancelled = 0;
  const second = fixture(() => new Promise(resolve => { finish = resolve; })); const operation = second.search(undefined, { signal: b.signal }); b.abort(new Error(key));
  await rejects(operation, 'CANCELLED'); assert.equal(second.calls.length, 1); assert.equal(second.calls[0][1].signal.aborted, true);
  finish(new Response(new ReadableStream({ cancel() { bodyCancelled++; } }), { headers: { 'content-type': 'application/json' } })); await turn(); assert.equal(bodyCancelled, 1);
});

test('cancellation interrupts stalled body reads and cancels their stream', async () => {
  const controller = new AbortController(); let cancelled = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  const body = new ReadableStream({ pull() { started(); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const f = fixture(async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
  const operation = f.search(undefined, { signal: controller.signal }); await ready; controller.abort(new Error(key)); await rejects(operation, 'CANCELLED'); await turn(); assert.equal(cancelled, 1); assert.equal(f.calls.length, 1);
});

test('a single 30-second request deadline aborts a stalled fetch without paid retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => new Promise(() => {})), operation = f.search();
  assert.equal(f.calls.length, 1); t.mock.timers.tick(30000);
  await assert.rejects(operation, error => error instanceof CoreError && error.code === 'SEARCH_UNAVAILABLE' && error.status === 504);
  assert.equal(f.calls[0][1].signal.aborted, true); assert.equal(f.calls.length, 1);
});
