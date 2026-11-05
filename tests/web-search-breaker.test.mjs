// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../core/runtime.mjs';
import { createWorkspace } from '../core/workspace.mjs';
import { CoreError } from '../core/errors.mjs';
import { Store } from '../server/store.mjs';

const reply = (toolCalls = [], content = '') => ({ content, toolCalls });
const call = (name, args) => ({ id: randomUUID(), name, args });
const search = query => call('search_web', { query });
const read = () => call('read_webpage', { url: 'https://example.com/known-source' });
const tools = request => request.tools.map(value => value.name);
const results = request => request.messages.filter(value => value.role === 'tool').map(value => JSON.parse(value.content));
const searchResult = query => ({ query, results: [{ title: 'Observed source', url: 'https://example.com/known-source', snippet: 'Returned by the mock search.' }], truncated: false, fetchedAt: '2026-01-01T00:00:00.000Z', untrusted_data: true });
const pageResult = () => ({ title: 'Known page', url: 'https://example.com/known-source', content: 'A known page remains readable when searching stops.', links: [], truncated: false, fetchedAt: '2026-01-01T00:00:00.000Z', untrusted_data: true });
async function fixture(t, { webTools, providerCall }) {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-search-breaker-'));
  const identity = await fs.lstat(root, { bigint: true }), directory = path.join(root, 'workspace'); await fs.mkdir(directory);
  const store = new Store(path.join(root, 'data'));
  store.putProvider({ id: 'mock', type: 'openai', model: 'mock', baseUrl: 'https://fixture.invalid/v1', enabled: true, streaming: false });
  const session = store.createSession({ providerId: 'mock' }); let turns = 0;
  const runtime = createRuntime({ workspace: createWorkspace(directory), providers: async id => store.getProvider(id),
    getSession: async id => store.getSession(id), saveSession: async (...args) => store.putSession(...args), audit: value => store.audit(value),
    skillRegistry: { catalog: async () => [] }, webTools, providerCall: async (_provider, request) => providerCall(++turns, request), limits: { maxRunMs: 10000 } });
  t.after(async () => { await runtime.shutdown(); store.close(); const current = await fs.lstat(root, { bigint: true });
    assert.equal(await fs.realpath(root), root); assert.equal(path.dirname(root), parent); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.equal(current.isSymbolicLink(), false); await fs.rm(root, { recursive: true, maxRetries: 5 }); });
  runtime.setWebAccess(true);
  return { runtime, store, session, get: () => store.getSession(session.id), start: () => runtime.start(session.id, { content: 'Search public sources.' }),
    async done() { const end = Date.now() + 8000; while (Date.now() < end) { if (!runtime.isActive(session.id)) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Search breaker fixture timed out'); } };
}

for (const code of ['WEB_CHALLENGE', 'WEB_RATE_LIMIT', 'WEB_ACCESS_DENIED', 'WEB_SEARCH_UNAVAILABLE', 'SEARCH_NOT_CONFIGURED', 'SEARCH_AUTH_FAILED', 'SEARCH_RATE_LIMIT', 'SEARCH_UNAVAILABLE']) {
  test(`${code} stops only this run's later searches, preserves reading and allows a new run`, async t => {
    let searches = 0, reads = 0;
    const f = await fixture(t, { webTools: {
      search: async ({ query }) => { if (++searches === 1) throw new CoreError(code, 'Mock service refused this search.', 503); return searchResult(query); },
      read: async () => { reads++; return pageResult(); },
    }, providerCall: async (turn, request) => {
      if (turn === 1) { assert.ok(tools(request).includes('search_web')); assert.match(request.system, /never retry by changing the query/u); return reply([search('first'), search('changed query in same batch'), read()]); }
      if (turn === 2) {
        assert.ok(!tools(request).includes('search_web')); assert.ok(tools(request).includes('read_webpage'));
        assert.equal(results(request)[0].error.code, code); assert.equal(results(request)[1].error.code, 'SEARCH_STOPPED_FOR_RUN'); assert.equal(results(request)[2].result.url, pageResult().url);
        return reply([search('guessed unavailable tool in later model response'), read()]);
      }
      if (turn === 3) { assert.equal(results(request).at(-2).error.code, 'SEARCH_STOPPED_FOR_RUN'); assert.ok(results(request).at(-1).result.content); return reply([], 'Search failed; only the known page was read.'); }
      if (turn === 4) { assert.ok(tools(request).includes('search_web')); return reply([search('new run may search')]); }
      assert.equal(results(request).at(-1).result.query, 'new run may search'); return reply([], 'This run obtained a search result.');
    } });
    await f.start(); await f.done(); const firstRun = f.get().run.id;
    assert.equal(searches, 1); assert.equal(reads, 2); assert.equal(f.runtime.getWebAccess(), true); assert.equal(f.get().run.status, 'completed');
    const refs = f.get().run.steps.filter(step => step.toolResultRef).map(step => f.store.getToolArtifact(f.session.id, firstRun, step.id));
    assert.deepEqual(refs.filter(item => item.name === 'search_web').map(item => JSON.parse(item.content).error.code), [code, 'SEARCH_STOPPED_FOR_RUN', 'SEARCH_STOPPED_FOR_RUN']);
    await f.start(); await f.done(); assert.notEqual(f.get().run.id, firstRun); assert.equal(searches, 2); assert.equal(f.get().run.status, 'completed');
  });
}

test('successful search can use several queries in one batch and later model rounds', async t => {
  const seen = [];
  const f = await fixture(t, { webTools: { search: async ({ query }) => { seen.push(query); return searchResult(query); } }, providerCall: async (turn, request) => {
    assert.ok(tools(request).includes('search_web'));
    if (turn === 1) return reply([search('first topic'), search('second topic')]);
    if (turn === 2) return reply([search('third topic')]);
    assert.deepEqual(results(request).map(value => value.result.query), seen); return reply([], 'Three returned results.');
  } });
  await f.start(); await f.done(); assert.deepEqual(seen, ['first topic', 'second topic', 'third topic']); assert.equal(f.get().run.status, 'completed');
});

test('a page access denial does not disable the separate search tool', async t => {
  let searches = 0;
  const f = await fixture(t, { webTools: { read: async () => { throw new CoreError('WEB_ACCESS_DENIED', 'This page denied access.', 403); }, search: async ({ query }) => { searches++; return searchResult(query); } },
    providerCall: async (turn, request) => {
      assert.ok(tools(request).includes('search_web'));
      if (turn === 1) return reply([read(), search('find another public source')]);
      assert.equal(results(request)[0].error.code, 'WEB_ACCESS_DENIED'); assert.ok(results(request)[1].result.results.length); return reply([], 'Search remained available.');
    } });
  await f.start(); await f.done(); assert.equal(searches, 1); assert.equal(f.get().run.status, 'completed');
});
