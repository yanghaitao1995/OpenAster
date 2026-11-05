import { test as base, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// This fixture exercises the storage module, not an integrated composer UI.
// It serves only owned static resources; no model or workspace API exists here.
const test = base.extend({ local: async ({ context }, use) => {
  const source = await readFile(new URL('../public/composer-drafts.mjs', import.meta.url));
  const requests = [], server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    const headers = { 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' };
    if (request.method === 'GET' && request.url === '/') { response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); response.end('<!doctype html><html lang="zh-CN"><title>本机草稿存储专项</title><body>独立存储测试，不是工作台界面。</body></html>'); }
    else if (request.method === 'GET' && request.url === '/composer-drafts.mjs') { response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' }); response.end(source); }
    else { response.writeHead(404, headers); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try { await use({ url: `http://127.0.0.1:${server.address().port}`, name: 'draft-storage-' + randomUUID(), storageId: randomUUID(), requests }); }
  finally {
    await context.close();
    // Only this static fixture's connections remain; no filesystem or model work.
    const closed = new Promise(done => server.close(done)); server.closeAllConnections(); await closed;
  }
} });
test.use({ serviceWorkers: 'block', launchOptions: { chromiumSandbox: true } });

const draft = overrides => ({ slot: 'new', text: '\ufeff 本机待发送文字\r\n下一行🙂 ', files: [{ path: '资料/参考.txt', sha256: 'a'.repeat(64), bytes: 42 }], providerId: 'demo', skillId: '', updatedAt: '2026-10-30T08:00:00.000Z', revision: randomUUID(), uncertain: false, ...overrides });
async function ready(page, local) {
  await page.goto(local.url);
  await page.evaluate(async ({ name, storageId, origin }) => {
    globalThis.draftModule = await import('/composer-drafts.mjs');
    globalThis.draftScope = draftModule.draftScopeKey({ origin, storageId });
    globalThis.draftRepository = draftModule.createBrowserDraftRepository({ name });
  }, { name: local.name, storageId: local.storageId, origin: local.url });
}
async function read(page) { return page.evaluate(() => draftRepository.read(draftScope)); }
async function cas(page, revision, drafts) {
  return page.evaluate(async ({ revision, drafts }) => {
    try { return { ok: true, snapshot: await draftRepository.compareAndSwap(draftScope, revision, drafts) }; }
    catch (error) { return { ok: false, code: error.code }; }
  }, { revision, drafts });
}
async function rawRead(page, name, scope, version = 1) {
  return page.evaluate(({ name, scope, version }) => new Promise((resolve, reject) => {
    const open = indexedDB.open(name, version); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction('scopes', 'readonly'), get = tx.objectStore('scopes').get(scope); let value; get.onsuccess = () => { value = get.result; }; tx.oncomplete = () => { db.close(); resolve(value); }; tx.onabort = () => { db.close(); reject(tx.error); }; };
  }), { name, scope, version });
}

test('draft storage: two real IndexedDB connections CAS the same revision with exactly one winner', async ({ page, context, local }) => {
  const other = await context.newPage(); await ready(page, local); await ready(other, local);
  expect(await read(page)).toEqual({ version: 1, revision: '0', drafts: [] }); expect(await read(other)).toEqual(await read(page));
  const first = draft({ slot: 'task-a' }), second = draft({ slot: 'task-b' });
  const outcomes = await Promise.all([cas(page, '0', [first]), cas(other, '0', [second])]);
  expect(outcomes.filter(value => value.ok)).toHaveLength(1); expect(outcomes.filter(value => !value.ok)).toEqual([{ ok: false, code: 'DRAFT_CONFLICT' }]);
  const stored = await read(page); expect(stored).toEqual(await read(other)); expect(stored).toEqual(outcomes.find(value => value.ok).snapshot);
  const losingDraft = stored.drafts[0].slot === first.slot ? second : first;
  expect((await cas(other, stored.revision, [...stored.drafts, losingDraft])).ok).toBe(true);
  expect((await read(page)).drafts.map(value => value.slot).sort()).toEqual(['task-a', 'task-b']);
  expect(local.requests.every(request => request.method === 'GET')).toBe(true);
});

test('draft storage: exact drafts survive reload and closing then reopening a page in the same browser context', async ({ page, context, local }) => {
  await ready(page, local); const savedDraft = draft({ uncertain: true }); const saved = await cas(page, '0', [savedDraft]); expect(saved.ok).toBe(true);
  await ready(page, local); expect(await read(page)).toEqual(saved.snapshot);
  await page.close(); const reopened = await context.newPage(); await ready(reopened, local); expect(await read(reopened)).toEqual(saved.snapshot);
  expect((await read(reopened)).drafts[0].text).toBe(savedDraft.text);
  expect(local.requests.some(request => request.method !== 'GET')).toBe(false);
});

test('draft storage: gateway origins and storage identities isolate bundles in the same local database', async ({ page, local }) => {
  await ready(page, local); const otherStorage = randomUUID(), selected = draft();
  const result = await page.evaluate(async ({ storageId, otherStorage, selected }) => {
    const keys = [
      draftModule.draftScopeKey({ origin: 'https://first.example', storageId }),
      draftModule.draftScopeKey({ origin: 'https://second.example', storageId }),
      draftModule.draftScopeKey({ origin: 'https://first.example', storageId: otherStorage }),
    ];
    await draftRepository.compareAndSwap(keys[0], '0', [selected]);
    const untouched = await Promise.all(keys.slice(1).map(key => draftRepository.read(key)));
    await draftRepository.compareAndSwap(keys[1], '0', [{ ...selected, text: '另一个网关的独立草稿' }]);
    return { untouched, snapshots: await Promise.all(keys.map(key => draftRepository.read(key))) };
  }, { storageId: local.storageId, otherStorage, selected });
  expect(result.untouched).toEqual([{ version: 1, revision: '0', drafts: [] }, { version: 1, revision: '0', drafts: [] }]);
  expect(result.snapshots[0].drafts[0]).toEqual(selected); expect(result.snapshots[1].drafts[0].text).toBe('另一个网关的独立草稿'); expect(result.snapshots[2].revision).toBe('0');
});

test('draft storage: malformed records, undefined records and future database versions are preserved rather than replaced', async ({ page, local }) => {
  await ready(page, local); const scope = await page.evaluate(() => draftScope);
  const corrupt = { version: 2, revision: randomUUID(), drafts: [], unknown: 'future-data' };
  await page.evaluate(async ({ name, scope, corrupt }) => {
    await new Promise((resolve, reject) => { const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('scopes'); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction('scopes', 'readwrite'); tx.objectStore('scopes').put(corrupt, scope); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); }; }; });
  }, { name: local.name, scope, corrupt });
  expect(await page.evaluate(async () => { try { await draftRepository.read(draftScope); } catch (error) { return error.code; } })).toBe('DRAFT_STORAGE_CORRUPT');
  expect(await cas(page, '0', [])).toEqual({ ok: false, code: 'DRAFT_STORAGE_CORRUPT' }); expect(await rawRead(page, local.name, scope)).toEqual(corrupt);
  const undefinedResult = await page.evaluate(async ({ name, scope }) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open(name, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('scopes', 'readwrite'); tx.objectStore('scopes').put(undefined, scope); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    try { await draftRepository.read(draftScope); } catch (error) { return error.code; }
  }, { name: local.name, scope });
  expect(undefinedResult).toBe('DRAFT_STORAGE_CORRUPT'); expect(await cas(page, '0', [])).toEqual({ ok: false, code: 'DRAFT_STORAGE_CORRUPT' });
  const future = local.name + '-future';
  const futureResult = await page.evaluate(async ({ name, scope, corrupt }) => {
    await new Promise((resolve, reject) => { const request = indexedDB.open(name, 2); request.onupgradeneeded = () => request.result.createObjectStore('scopes'); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, tx = db.transaction('scopes', 'readwrite'); tx.objectStore('scopes').put(corrupt, scope); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); }; }; });
    const repository = draftModule.createBrowserDraftRepository({ name });
    try { await repository.compareAndSwap(scope, '0', []); } catch (error) { return error.code; } finally { repository.close(); }
  }, { name: future, scope, corrupt });
  expect(futureResult).toBe('DRAFT_STORAGE_CORRUPT'); expect(await rawRead(page, future, scope, 2)).toEqual(corrupt);
});

test('draft storage: clearing commits a new revision and rejects stale empty-state ABA writes', async ({ page, local }) => {
  await ready(page, local); const first = await cas(page, '0', [draft()]); expect(first.ok).toBe(true);
  const cleared = await cas(page, first.snapshot.revision, []); expect(cleared.ok).toBe(true); expect(cleared.snapshot.revision).not.toBe('0'); expect(cleared.snapshot.revision).not.toBe(first.snapshot.revision);
  expect(await cas(page, '0', [draft()])).toEqual({ ok: false, code: 'DRAFT_CONFLICT' });
  expect(await cas(page, first.snapshot.revision, [draft()])).toEqual({ ok: false, code: 'DRAFT_CONFLICT' }); expect(await read(page)).toEqual(cleared.snapshot);
  expect((await cas(page, cleared.snapshot.revision, [draft({ text: '明确读取新版本后再保存' })])).ok).toBe(true);
});

test('draft storage: budget rejection and an aborted real transaction leave the previously committed bundle intact', async ({ page, local }) => {
  await ready(page, local); const saved = await cas(page, '0', [draft()]); expect(saved.ok).toBe(true);
  const excessive = Array.from({ length: 20 }, (_, index) => draft({ slot: 'task-' + index, text: '汉'.repeat(16000) }));
  expect(await cas(page, saved.snapshot.revision, excessive)).toEqual({ ok: false, code: 'DRAFT_LIMIT' }); expect(await read(page)).toEqual(saved.snapshot);
  const errors = await page.evaluate(async ({ revision, replacement }) => {
    const original = IDBObjectStore.prototype.put, codes = [];
    try {
      // Inject the browser's quota error deterministically; do not fill a user's disk.
      IDBObjectStore.prototype.put = function () { throw new DOMException('owned quota fixture', 'QuotaExceededError'); };
      try { await draftRepository.compareAndSwap(draftScope, revision, [replacement]); } catch (error) { codes.push(error.code); }
      // The write is queued in a real transaction, then aborted before commit.
      IDBObjectStore.prototype.put = function (...args) { const request = original.apply(this, args); this.transaction.abort(); return request; };
      try { await draftRepository.compareAndSwap(draftScope, revision, [replacement]); } catch (error) { codes.push(error.code); }
    } finally { IDBObjectStore.prototype.put = original; }
    return codes;
  }, { revision: saved.snapshot.revision, replacement: draft({ text: '这份更改不应提交' }) });
  expect(errors).toEqual(['DRAFT_STORAGE_QUOTA', 'DRAFT_STORAGE_ERROR']); expect(await read(page)).toEqual(saved.snapshot);
  expect((await cas(page, saved.snapshot.revision, [draft({ text: '故障解除后明确保存' })])).ok).toBe(true);
});

test('draft storage: unavailable or closed repositories reject without altering an existing database', async ({ page, local }) => {
  await ready(page, local); const saved = await cas(page, '0', [draft()]); const scope = await page.evaluate(() => draftScope);
  const codes = await page.evaluate(async ({ name }) => {
    const codes = [], unavailable = draftModule.createBrowserDraftRepository({ indexedDB: null, name });
    try { await unavailable.read(draftScope); } catch (error) { codes.push(error.code); }
    const denied = draftModule.createBrowserDraftRepository({ indexedDB: { open() { throw new DOMException('owned denied fixture', 'SecurityError'); } }, name });
    try { await denied.read(draftScope); } catch (error) { codes.push(error.code); }
    draftRepository.close();
    try { await draftRepository.read(draftScope); } catch (error) { codes.push(error.code); }
    try { await draftRepository.compareAndSwap(draftScope, '0', []); } catch (error) { codes.push(error.code); }
    unavailable.close(); denied.close(); return codes;
  }, { name: local.name });
  expect(codes).toEqual(['DRAFT_STORAGE_UNAVAILABLE', 'DRAFT_STORAGE_UNAVAILABLE', 'DRAFT_STORAGE_CLOSED', 'DRAFT_STORAGE_CLOSED']);
  expect(await rawRead(page, local.name, scope)).toEqual(saved.snapshot);
});

test('draft storage: a real versionchange closes old connections and prevents stale-schema writes', async ({ page, local }) => {
  await ready(page, local); const saved = await cas(page, '0', [draft()]); const scope = await page.evaluate(() => draftScope);
  const result = await page.evaluate(async ({ name, revision }) => {
    const upgraded = await new Promise((resolve, reject) => { const request = indexedDB.open(name, 2); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('old repository did not close on versionchange')); request.onsuccess = () => { const db = request.result; db.close(); resolve(true); }; });
    try { await draftRepository.compareAndSwap(draftScope, revision, []); } catch (error) { return { upgraded, code: error.code }; }
  }, { name: local.name, revision: saved.snapshot.revision });
  expect(result).toEqual({ upgraded: true, code: 'DRAFT_STORAGE_UNAVAILABLE' }); expect(await rawRead(page, local.name, scope, 2)).toEqual(saved.snapshot);
});

test('draft storage: an owned persistent browser context restores drafts after the browser process closes', async ({ local }, info) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const directory = await mkdtemp(resolve('test-results', 'draft-persistent-profile-'));
  const options = { channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true, chromiumSandbox: true, serviceWorkers: 'block' };
  let context = await chromium.launchPersistentContext(directory, options); let saved;
  try { const page = context.pages()[0] || await context.newPage(); await ready(page, local); saved = await cas(page, '0', [draft({ uncertain: true })]); expect(saved.ok).toBe(true); }
  finally { await context.close(); }
  context = await chromium.launchPersistentContext(directory, options);
  try { const page = context.pages()[0] || await context.newPage(); await ready(page, local); expect(await read(page)).toEqual(saved.snapshot); }
  finally { await context.close(); }
  await info.attach('browser-persistent-draft-scope', { body: JSON.stringify({ browserProcessRestarted: true, ownedProfileDirectory: directory, sandboxEnabled: true, exactDraftRestored: true, networkWrites: local.requests.filter(request => request.method !== 'GET').length, scope: 'Real Edge/Chromium IndexedDB adapter persistence only; not Electron persistence, a mobile-device test, or an integrated product UI claim.' }, null, 2), contentType: 'application/json' });
  expect(local.requests.some(request => request.method !== 'GET')).toBe(false);
});
