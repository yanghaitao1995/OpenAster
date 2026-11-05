// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { readUtf8Body } from './helpers/http-body.mjs';
import { buildRequest, measureProviderRequest } from '../core/providers.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

test('HTTP fixture preserves Chinese, emoji and BOM when every UTF-8 byte is a separate chunk', async () => {
  const text = '\uFEFF{"content":"中文😀\r\n资料 İ"}', bytes = Buffer.from(text);
  async function* parts() { for (const byte of bytes) yield Buffer.from([byte]); }
  const decoded = await readUtf8Body(parts());
  assert.equal(decoded, text);
  assert.equal(Buffer.byteLength(decoded), bytes.length);
  assert.equal(hash(decoded), hash(bytes));
});

test('HTTP fixture rejects malformed and truncated UTF-8 instead of replacing bytes', async () => {
  await assert.rejects(readUtf8Body([Buffer.from([0xe4, 0xb8])]), TypeError);
  await assert.rejects(readUtf8Body([Buffer.from([0xff])]), TypeError);
});

test('real HTTP split Chinese request preserves exact production bytes and SHA across two forced boundaries', async t => {
  const provider = { id: 'fixture', name: 'Local fixture', type: 'openai', model: 'fixture',
    baseUrl: 'http://127.0.0.1:9/v1', streaming: false, toolMode: 'none', maxTokens: 512 };
  const options = { messages: [{ role: 'user', content: '中文' }], system: 'Local synthetic request', tools: [], stream: false };
  const targetBytes = 64772, overhead = Buffer.byteLength(buildRequest(provider, options).body);
  options.messages[0].content = 'a'.repeat(targetBytes - overhead) + '中文';
  const wire = Buffer.from(buildRequest(provider, options).body), measured = measureProviderRequest(provider, options);
  assert.equal(wire.length, targetBytes);
  const chinese = wire.indexOf(Buffer.from('中文')), cuts = [chinese + 2, chinese + 5, wire.length];
  let observed = 0;
  const waiters = [];
  const waitFor = bytes => observed >= bytes ? Promise.resolve() : new Promise(resolve => waiters.push({ bytes, resolve }));
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; let legacy = '';
      async function* observedParts() {
        for await (const part of req) {
          chunks.push(Buffer.from(part)); legacy += part; observed += part.length;
          for (let i = waiters.length - 1; i >= 0; i--) if (observed >= waiters[i].bytes) {
            waiters[i].resolve(); waiters.splice(i, 1);
          }
          yield part;
        }
      }
      const decoded = await readUtf8Body(observedParts()), bytes = Buffer.concat(chunks);
      res.end(JSON.stringify({ wireBytes: bytes.length, wireSha256: hash(bytes),
        decodedBytes: Buffer.byteLength(decoded), decodedSha256: hash(decoded),
        legacyBytes: Buffer.byteLength(legacy), legacySha256: hash(legacy),
        replacementCharacters: [...legacy].filter(character => character === '\uFFFD').length,
        chunkBytes: chunks.map(chunk => chunk.length), contentPreserved: JSON.parse(decoded).messages.at(-1).content === options.messages[0].content }));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let outgoing;
  try {
    const response = new Promise((resolve, reject) => {
      outgoing = request({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/chat/completions',
        method: 'POST', headers: { 'content-type': 'application/json', 'content-length': wire.length },
        signal: AbortSignal.timeout(10000) }, incoming => {
        const chunks = []; incoming.on('data', chunk => chunks.push(chunk));
        incoming.once('error', reject);
        incoming.once('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
      });
      outgoing.once('error', reject);
    });
    let offset = 0;
    for (const cut of cuts) {
      outgoing.write(wire.subarray(offset, cut)); offset = cut;
      // Wait for observation, not a timer: the next write cannot coalesce with this boundary.
      await Promise.race([waitFor(cut), response.then(() => { throw new Error('HTTP response ended before all bytes were observed'); })]);
    }
    outgoing.end();
    const actual = await response;
    assert.equal(actual.wireBytes, measured.requestBytes);
    assert.equal(actual.wireSha256, measured.requestSha256);
    assert.equal(actual.decodedBytes, measured.requestBytes);
    assert.equal(actual.decodedSha256, measured.requestSha256);
    assert.equal(actual.contentPreserved, true);
    assert.equal(actual.legacyBytes, 64778);
    assert.equal(actual.replacementCharacters, 4);
    assert.notEqual(actual.legacySha256, measured.requestSha256);
    t.diagnostic('UTF8_HTTP_EVIDENCE ' + JSON.stringify({ measured, actual, cuts }));
  } finally {
    outgoing?.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
