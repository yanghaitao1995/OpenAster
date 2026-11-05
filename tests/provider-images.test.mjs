// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { buildRequest, callProvider, measureProviderRequest } from '../core/providers.mjs';
import { retryProviderRequest } from '../core/provider-retry.mjs';

function crc32(buffer) { let value = 0xffffffff; for (const byte of buffer) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const tag = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([tag, data]))); return Buffer.concat([length, tag, data, checksum]); }
const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
const image = Object.freeze({ name: 'white.png', mimeType: 'image/png', data: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 1, height: 1 });
const provider = type => ({ type, model: 'vision-fixture', baseUrl: type === 'ollama' ? 'http://127.0.0.1:11434' : 'https://fixture.invalid/v1' });
const response = type => ({
  openai: { choices: [{ message: { role: 'assistant', content: 'white' }, finish_reason: 'stop' }] },
  responses: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'white' }] }] },
  anthropic: { content: [{ type: 'text', text: 'white' }], stop_reason: 'end_turn' },
  ollama: { message: { role: 'assistant', content: 'white' }, done: true, done_reason: 'stop' },
}[type]);

for (const type of ['openai', 'responses', 'anthropic', 'ollama']) {
  test(`${type} sends validated image bytes with text in its official request shape`, async () => {
    let captured, calls = 0;
    const result = await callProvider(provider(type), { messages: [{ role: 'user', content: 'What color?', images: [image] }], fetchImpl: async (url, options) => {
      calls++; captured = JSON.parse(options.body); assert.equal(options.redirect, 'error');
      return Response.json(response(type));
    } });
    assert.equal(calls, 1); assert.equal(result.content, 'white');
    const message = type === 'responses' ? captured.input[0] : captured.messages.find(item => item.role === 'user');
    if (type === 'openai') assert.deepEqual(message, { role: 'user', content: [{ type: 'text', text: 'What color?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } }] });
    else if (type === 'responses') assert.deepEqual(message, { role: 'user', content: [{ type: 'input_text', text: 'What color?' }, { type: 'input_image', image_url: `data:image/png;base64,${image.data}` }] });
    else if (type === 'anthropic') assert.deepEqual(message, { role: 'user', content: [{ type: 'text', text: 'What color?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } }] });
    else assert.deepEqual(message, { role: 'user', content: 'What color?', images: [image.data] });
    assert.doesNotMatch(JSON.stringify(message), /white\.png|sha256|width|height/);
  });

  test(`${type} keeps the text-only wire unchanged and supports image-only user messages`, () => {
    const plain = { messages: [{ role: 'user', content: 'Hello' }] };
    assert.equal(buildRequest(provider(type), plain).body, buildRequest(provider(type), { messages: [{ ...plain.messages[0], images: [] }] }).body);
    const body = JSON.parse(buildRequest(provider(type), { messages: [{ role: 'user', content: '', images: [image] }] }).body);
    const user = type === 'responses' ? body.input[0] : body.messages.find(item => item.role === 'user');
    if (type === 'ollama') assert.equal(user.content, '');
    else assert.equal(user.content.length, 1);
  });

  test(`${type} rejects images on other roles and malformed attachments before transport`, async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return Response.json(response(type)); };
    for (const role of ['assistant', 'system', 'tool']) await assert.rejects(callProvider(provider(type), { messages: [{ role, content: 'Not user data', images: [image] }], fetchImpl }), { code: 'INVALID_IMAGES' });
    await assert.rejects(callProvider(provider(type), { messages: [{ role: 'user', content: 'Bad hash', images: [{ ...image, sha256: '0'.repeat(64) }] }], fetchImpl }));
    await assert.rejects(callProvider(provider(type), { messages: [{ role: 'user', content: 'Remote URL is not an inline image', images: [{ ...image, data: 'https://example.test/image.png' }] }], fetchImpl }));
    assert.equal(calls, 0);
  });

  test(`${type} includes base64 image expansion in the existing 2 MiB request budget`, () => {
    const emptySize = measureProviderRequest(provider(type), { messages: [{ role: 'user', content: '' }] }).requestBytes;
    const content = 'x'.repeat(2 * 1024 * 1024 - emptySize - 10);
    buildRequest(provider(type), { messages: [{ role: 'user', content }] });
    assert.throws(() => buildRequest(provider(type), { messages: [{ role: 'user', content, images: [image] }] }), { code: 'CONTEXT_TOO_LARGE' });
  });
}

test('image-bearing user history remains attached across an exact assistant/tool exchange', () => {
  const tool = { role: 'tool', callId: 'call-1', name: 'read_file', content: '{"result":"fixture"}' };
  for (const type of ['openai', 'responses', 'anthropic', 'ollama']) {
    const message = { role: 'user', content: 'Describe this, then read the file', images: [image] };
    const assistant = { role: 'assistant', content: '', wire: {
      type, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: type === 'ollama' ? { path: 'one.txt' } : '{"path":"one.txt"}' } }] },
      content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'one.txt' } }],
      output: [{ type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"one.txt"}' }],
    } };
    const body = JSON.parse(buildRequest(provider(type), { messages: [message, assistant, tool, { role: 'user', content: 'Continue' }] }).body);
    assert.equal(JSON.stringify(body).split(image.data).length - 1, 1);
    const values = type === 'responses' ? body.input : body.messages;
    assert.equal(values.at(-1).content, 'Continue');
    if (type === 'responses') assert.equal(values[2].call_id, 'call-1');
    else if (type === 'anthropic') assert.equal(values[2].content[0].tool_use_id, 'call-1');
    else if (type === 'openai') assert.equal(values[3].tool_call_id, 'call-1');
    else assert.equal(values[3].tool_name, 'read_file');
  }
});

test('a model rejecting image input is a permanent HTTP error, not a repeated paid request', async () => {
  let calls = 0;
  await assert.rejects(retryProviderRequest(() => callProvider(provider('openai'), {
    messages: [{ role: 'user', content: 'What color?', images: [image] }],
    fetchImpl: async () => { calls++; return new Response('upstream private detail: images unsupported', { status: 400 }); },
  })), { code: 'PROVIDER_HTTP_ERROR' });
  assert.equal(calls, 1);
});
