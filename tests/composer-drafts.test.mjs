import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_LIMITS, validateDraft, validateDraftList, validateDraftSnapshot, draftScopeKey } from '../public/composer-drafts.mjs';

const revision = 'e69234c6-c55f-4f24-9afd-af18450d2ee0';
const storageId = '8c197b2b-bf5c-4e12-82ab-8137424cbbf3';
const make = overrides => ({ slot: 'new', text: '\ufeff 任务原文\r\n第二行 🙂 \n', files: [], providerId: 'demo', skillId: '', updatedAt: '2026-10-30T08:00:00.000Z', revision, uncertain: false, ...overrides });
const file = overrides => ({ path: 'src/资料.txt', sha256: 'a'.repeat(64), bytes: 123, ...overrides });
const fails = (run, code) => assert.throws(run, error => error instanceof Error && error.code === code);

test('draft schema preserves exact text and detached file identities without hidden content', () => {
  const original = make({ files: [file()] }); const clean = validateDraft(original);
  assert.deepEqual(clean, original); assert.notEqual(clean, original); assert.notEqual(clean.files, original.files); assert.notEqual(clean.files[0], original.files[0]);
  original.files[0].path = 'changed.txt'; assert.equal(clean.files[0].path, 'src/资料.txt');
  assert.equal(validateDraft(make({ text: '', files: [file({ bytes: 0 })], providerId: '', uncertain: true })).text, '');
  assert.ok(Object.isFrozen(DRAFT_LIMITS));
  for (const extra of [{ apiKey: 'private' }, { content: 'file body' }, { token: 'private' }]) fails(() => validateDraft({ ...make(), ...extra }), 'INVALID_DRAFT');
  fails(() => validateDraft(make({ files: [{ ...file(), content: 'must not save' }] })), 'INVALID_DRAFT');
});

test('draft schema rejects accessors, symbols, sparse arrays, exotic prototypes and revoked proxies without calling getters', () => {
  let getters = 0; const get = () => { getters++; throw new Error('must not execute'); };
  const draft = make(); Object.defineProperty(draft, 'text', { enumerable: true, get }); fails(() => validateDraft(draft), 'INVALID_DRAFT');
  const attachment = file(); Object.defineProperty(attachment, 'path', { enumerable: true, get }); fails(() => validateDraft(make({ files: [attachment] })), 'INVALID_DRAFT');
  const files = [file()]; Object.defineProperty(files, '0', { enumerable: true, get }); fails(() => validateDraft(make({ files })), 'INVALID_DRAFT');
  const list = [make()]; Object.defineProperty(list, '0', { enumerable: true, get }); fails(() => validateDraftList(list), 'INVALID_DRAFT_SNAPSHOT');
  fails(() => validateDraft({ ...make(), [Symbol('hidden')]: true }), 'INVALID_DRAFT');
  fails(() => validateDraft(Object.assign(Object.create({ inherited: true }), make())), 'INVALID_DRAFT');
  fails(() => validateDraft(make({ files: new Array(1) })), 'INVALID_DRAFT');
  const extra = []; extra.note = 'unknown'; fails(() => validateDraft(make({ files: extra })), 'INVALID_DRAFT');
  const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); fails(() => validateDraft(proxy), 'INVALID_DRAFT');
  assert.equal(getters, 0); assert.deepEqual(validateDraft(Object.assign(Object.create(null), make())), make());
});

test('draft text enforces UTF-16 limit without trimming or accepting invalid Unicode', () => {
  const exact = '🙂'.repeat(8000); assert.equal(validateDraft(make({ text: exact })).text, exact);
  fails(() => validateDraft(make({ text: exact + 'a' })), 'DRAFT_LIMIT');
  for (const text of ['\ud800', '\udfff', 'a\0b', undefined, 123]) fails(() => validateDraft(make({ text })), 'INVALID_DRAFT');
});

test('draft IDs, revision, timestamp and uncertainty have strict primitive forms', () => {
  for (const slot of ['', '../id', 'a b', 'a'.repeat(101), null]) fails(() => validateDraft(make({ slot })), 'INVALID_DRAFT');
  for (const providerId of [0, '../provider', 'a'.repeat(101)]) fails(() => validateDraft(make({ providerId })), 'INVALID_DRAFT');
  fails(() => validateDraft(make({ skillId: 'skill/name' })), 'INVALID_DRAFT');
  for (const value of ['0', revision.toUpperCase(), '00000000-0000-0000-0000-000000000000', 1]) fails(() => validateDraft(make({ revision: value })), 'INVALID_DRAFT');
  for (const updatedAt of ['2026-02-30T08:00:00.000Z', '2026-10-30T08:00:00Z', '2026-10-30T08:00:00.000+00:00', '2026-10-30', null]) fails(() => validateDraft(make({ updatedAt })), 'INVALID_DRAFT');
  for (const uncertain of [0, 'false', null]) fails(() => validateDraft(make({ uncertain })), 'INVALID_DRAFT');
});

test('attachment metadata is bounded and rejects path escapes and cross-platform collisions', () => {
  for (const path of ['../a', '/a', 'a//b', 'a/./b', 'a\\b', 'C:/a', 'a%2fb', 'a\0b', 'a\nb', 'NUL.txt', 'dir/COM1', '.openaster-data/a', 'a.', 'a ', 'a/'.repeat(16) + 'a', 'a'.repeat(129), 'a\ud800']) fails(() => validateDraft(make({ files: [file({ path })] })), 'INVALID_DRAFT');
  for (const path of ['CONIN$.txt', 'dir/conout$', 'clock$', 'COM0.txt', 'lpt0', 'COM¹.log', 'LPT².txt', 'com³']) fails(() => validateDraft(make({ files: [file({ path })] })), 'INVALID_DRAFT');
  assert.equal(validateDraft(make({ files: [file({ path: '项目/原稿.md', bytes: DRAFT_LIMITS.fileBytes })] })).files[0].bytes, DRAFT_LIMITS.fileBytes);
  for (const bytes of [-1, 0.5, NaN, Infinity, '123', Number.MAX_SAFE_INTEGER + 1]) fails(() => validateDraft(make({ files: [file({ bytes })] })), 'INVALID_DRAFT');
  fails(() => validateDraft(make({ files: [file({ bytes: DRAFT_LIMITS.fileBytes + 1 })] })), 'DRAFT_LIMIT');
  fails(() => validateDraft(make({ files: [file({ bytes: DRAFT_LIMITS.fileBytes }), file({ path: 'b.txt', bytes: 1 })] })), 'DRAFT_LIMIT');
  fails(() => validateDraft(make({ files: Array.from({ length: 6 }, (_, i) => file({ path: `${i}.txt` })) })), 'DRAFT_LIMIT');
  for (const paths of [['Foo.txt', 'foo.txt'], ['é.txt', 'e\u0301.txt']]) fails(() => validateDraft(make({ files: paths.map(path => file({ path })) })), 'INVALID_DRAFT');
  for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 12]) fails(() => validateDraft(make({ files: [file({ sha256 })] })), 'INVALID_DRAFT');
});

test('snapshots preserve list order, reject duplicate slots and do not evict at 20 drafts', () => {
  const drafts = Array.from({ length: 20 }, (_, i) => make({ slot: 'task-' + i }));
  assert.deepEqual(validateDraftList(drafts).map(item => item.slot), drafts.map(item => item.slot));
  const snapshot = validateDraftSnapshot({ version: 1, revision, drafts }); assert.deepEqual(snapshot.drafts, drafts); assert.notEqual(snapshot.drafts[0], drafts[0]);
  fails(() => validateDraftList([...drafts, make({ slot: 'extra' })]), 'DRAFT_LIMIT');
  assert.equal(drafts.length, 20);
  fails(() => validateDraftList([make(), make()]), 'INVALID_DRAFT_SNAPSHOT');
  assert.deepEqual(validateDraftSnapshot({ version: 1, revision: '0', drafts: [] }), { version: 1, revision: '0', drafts: [] });
  assert.deepEqual(validateDraftSnapshot({ version: 1, revision, drafts: [] }), { version: 1, revision, drafts: [] });
  fails(() => validateDraftSnapshot({ version: 1, revision: '0', drafts: [make()] }), 'INVALID_DRAFT_SNAPSHOT');
  for (const value of [{ version: 2, revision, drafts: [] }, { version: 1, revision, drafts: [], token: 'secret' }, { version: 1, drafts: [] }]) fails(() => validateDraftSnapshot(value), 'INVALID_DRAFT_SNAPSHOT');
});

test('snapshot capacity uses canonical escaped UTF-8 JSON including the envelope, never source character estimates', () => {
  const makeList = text => Array.from({ length: 20 }, (_, i) => make({ slot: 'task-' + i, text }));
  const ascii = makeList('a'.repeat(16000)); assert.equal(validateDraftList(ascii).length, 20);
  const unicode = makeList('汉'.repeat(16000)); fails(() => validateDraftList(unicode), 'DRAFT_LIMIT');
  const escaped = makeList('\n'.repeat(16000)); fails(() => validateDraftList(escaped), 'DRAFT_LIMIT');
  const exact = makeList('汉'.repeat(8000)); const byteSize = () => Buffer.byteLength(JSON.stringify({ version: 1, revision, drafts: exact }), 'utf8');
  let remaining = DRAFT_LIMITS.snapshotBytes - byteSize();
  for (const draft of exact) { const add = Math.min(remaining, 16000 - draft.text.length); draft.text += 'a'.repeat(add); remaining -= add; }
  assert.equal(remaining, 0); assert.equal(byteSize(), DRAFT_LIMITS.snapshotBytes); assert.equal(validateDraftList(exact).length, 20);
  exact.at(-1).text += 'a'; assert.equal(byteSize(), DRAFT_LIMITS.snapshotBytes + 1); fails(() => validateDraftList(exact), 'DRAFT_LIMIT');
});

test('scope keys bind canonical gateway origin and storage UUID without accepting paths, secrets or insecure remote HTTP', () => {
  for (const origin of ['https://example.com', 'https://example.com:8443', 'http://localhost:4317', 'http://127.0.0.1:4317', 'http://[::1]:4317']) assert.deepEqual(JSON.parse(draftScopeKey({ origin, storageId })), [origin, storageId]);
  for (const origin of ['http://example.com', 'https://example.com/', 'https://EXAMPLE.com', 'https://example.com:443', 'https://example.com/path', 'https://name:secret@example.com', 'https://example.com?token=secret', 'https://example.com#x', 'file:///tmp', 'capacitor://localhost', ' http://localhost', 'http://127.1']) fails(() => draftScopeKey({ origin, storageId }), 'INVALID_DRAFT_SCOPE');
  assert.notEqual(draftScopeKey({ origin: 'https://a.example', storageId }), draftScopeKey({ origin: 'https://b.example', storageId }));
  assert.notEqual(draftScopeKey({ origin: 'https://a.example', storageId }), draftScopeKey({ origin: 'https://a.example', storageId: revision }));
  fails(() => draftScopeKey({ origin: 'https://example.com', storageId: '0' }), 'INVALID_DRAFT_SCOPE');
  fails(() => draftScopeKey({ origin: 'https://example.com', storageId, token: 'secret' }), 'INVALID_DRAFT_SCOPE');
});
