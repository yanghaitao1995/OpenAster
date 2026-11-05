// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreError } from '../core/errors.mjs';
import { createWebSearchRouter, WEB_SEARCH_PROVIDERS } from '../core/web-search-router.mjs';

function fixture(handlers = {}) {
  const calls = [];
  const invoke = name => async (input, options) => { calls.push({ name, input, options }); return handlers[name] ? handlers[name](input, options) : { source: name }; };
  const dependencies = { pages: { read: invoke('read'), search: invoke('duckduckgo') }, parallel: { search: invoke('parallel') }, bailian: { search: invoke('bailian') } };
  return { calls, dependencies, router: createWebSearchRouter(dependencies) };
}

test('search routing starts at parallel and setting a supported choice never calls a provider', () => {
  const f = fixture();
  assert.deepEqual(WEB_SEARCH_PROVIDERS, ['parallel', 'bailian', 'duckduckgo']);
  assert.equal(f.router.getProvider(), 'parallel');
  for (const provider of WEB_SEARCH_PROVIDERS) { f.router.setProvider(provider); assert.equal(f.router.getProvider(), provider); }
  assert.deepEqual(f.calls, []);
  assert.equal(createWebSearchRouter(f.dependencies).getProvider(), 'parallel');
  assert.equal(createWebSearchRouter({ ...f.dependencies, provider: 'bailian' }).getProvider(), 'bailian');
});

test('invalid choices never mutate the selected provider or invoke a transport', () => {
  const f = fixture(); f.router.setProvider('bailian');
  for (const provider of [null, undefined, '', 'Parallel', 'openai', 'https://example.com/', true, 1, {}, ['parallel']]) {
    assert.throws(() => f.router.setProvider(provider), { code: 'INVALID_SEARCH_PROVIDER' });
    assert.equal(f.router.getProvider(), 'bailian');
    if (provider !== undefined) assert.throws(() => createWebSearchRouter({ ...f.dependencies, provider }), { code: 'INVALID_SEARCH_PROVIDER' });
  }
  assert.deepEqual(f.calls, []);
});

test('only the explicit service receives the exact query, cancellation signal, connection and session context', async () => {
  const f = fixture(), input = { query: 'public documentation', maxResults: 3 };
  const options = { signal: new AbortController().signal, provider: { id: 'fixture', type: 'openai' }, contextKey: 'isolated-task' };
  for (const provider of WEB_SEARCH_PROVIDERS) {
    f.router.setProvider(provider); const result = await f.router.search(input, options);
    assert.equal(result.source, provider);
    if (provider === 'duckduckgo') assert.equal(result.provider, 'duckduckgo');
    assert.equal(f.calls.at(-1).input, input); assert.equal(f.calls.at(-1).options, options);
  }
  assert.deepEqual(f.calls.map(value => value.name), [...WEB_SEARCH_PROVIDERS]);
});

test('every rejection including challenge, auth, missing sources and cancellation propagates without another provider or retry', async () => {
  for (const provider of WEB_SEARCH_PROVIDERS) {
    for (const code of ['WEB_CHALLENGE', 'SEARCH_AUTH_FAILED', 'SEARCH_RATE_LIMIT', 'SEARCH_UNSUPPORTED', 'SEARCH_SOURCES_MISSING', 'SEARCH_UNAVAILABLE', 'CANCELLED']) {
      const original = new CoreError(code, 'Isolated provider refusal.');
      const f = fixture({ [provider]: async () => { throw original; } }); f.router.setProvider(provider);
      await assert.rejects(f.router.search({ query: 'documentation' }, {}), cause => cause === original);
      assert.deepEqual(f.calls.map(value => value.name), [provider]);
    }
  }
});

test('an empty successful search stays empty and does not cause a fallback request', async () => {
  for (const provider of WEB_SEARCH_PROVIDERS) {
    const original = { results: [], truncated: false, untrusted_data: true }, f = fixture({ [provider]: async () => original });
    f.router.setProvider(provider);
    const result = await f.router.search({ query: 'no results' }); assert.deepEqual(result.results, []);
    assert.deepEqual(f.calls.map(value => value.name), [provider]);
    assert.equal(Object.hasOwn(original, 'provider'), false);
  }
});

test('webpage reading always uses the page adapter regardless of the selected search provider', async () => {
  const f = fixture(), input = { url: 'https://example.com/docs' }, options = { signal: new AbortController().signal };
  for (const provider of WEB_SEARCH_PROVIDERS) {
    f.router.setProvider(provider); assert.deepEqual(await f.router.read(input, options), { source: 'read' });
    assert.equal(f.calls.at(-1).input, input); assert.equal(f.calls.at(-1).options, options);
  }
  assert.deepEqual(f.calls.map(value => value.name), ['read', 'read', 'read']);
  const failure = new CoreError('WEB_CHALLENGE', 'Page requires human verification.');
  const failed = fixture({ read: async () => { throw failure; } });
  await assert.rejects(failed.router.read(input, options), cause => cause === failure);
  assert.deepEqual(failed.calls.map(value => value.name), ['read']);
});

test('an in-flight search keeps its originally selected service when a later explicit choice changes', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ parallel: async () => pending });
  const first = f.router.search({ query: 'first' }); f.router.setProvider('bailian');
  assert.deepEqual(await f.router.search({ query: 'second' }), { source: 'bailian' });
  release({ source: 'parallel', results: [] }); assert.equal((await first).source, 'parallel');
  assert.deepEqual(f.calls.map(value => value.name), ['parallel', 'bailian']);
});
