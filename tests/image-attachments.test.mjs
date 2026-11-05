// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import zlib from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import { prepareImages, validateImages, IMAGE_LIMITS } from '../core/image-attachments.mjs';

// These tiny fixtures are original 3x2 color grids encoded locally with Pillow.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/image-attachments.json', import.meta.url), 'utf8'));
const raw = name => Buffer.from(fixtures[name].data, 'base64');
const image = (buffer, mimeType = 'image/png') => ({ name: '测试图片', mimeType, data: buffer.toString('base64') });
const reject = (value, code = 'INVALID_IMAGE_DATA') => assert.throws(() => prepareImages([value]), { code });
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, bytes) { const value = Buffer.alloc(bytes.length + 12); value.writeUInt32BE(bytes.length); value.write(type, 4, 4, 'latin1'); bytes.copy(value, 8); value.writeUInt32BE(crc32(value.subarray(4, -4)), value.length - 4); return value; }
function png({ width = 1, height = 1, depth = 8, color = 6, interlace = 0, content = Buffer.from([0, 255, 0, 0, 255]), compressed, extra = [] } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = color; header[12] = interlace;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...extra, chunk('IDAT', compressed ?? deflateSync(content)), chunk('IEND', Buffer.alloc(0))]);
}
function pngChunks(buffer) { const out = []; for (let offset = 8; offset < buffer.length;) { const length = buffer.readUInt32BE(offset); out.push({ type: buffer.toString('latin1', offset + 4, offset + 8), data: buffer.subarray(offset + 8, offset + 8 + length) }); offset += 12 + length; } return out; }
function riff(chunks) { const content = Buffer.concat([Buffer.from('WEBP'), ...chunks.map(({ type, data }) => { const out = Buffer.alloc(8 + data.length + data.length % 2); out.write(type, 0, 4, 'latin1'); out.writeUInt32LE(data.length, 4); data.copy(out, 8); return out; })]); const head = Buffer.alloc(8); head.write('RIFF'); head.writeUInt32LE(content.length, 4); return Buffer.concat([head, content]); }
function webpChunks(buffer) { const out = []; for (let offset = 12; offset < buffer.length;) { const length = buffer.readUInt32LE(offset + 4); out.push({ type: buffer.toString('latin1', offset, offset + 4), data: Buffer.from(buffer.subarray(offset + 8, offset + 8 + length)) }); offset += 8 + length + length % 2; } return out; }
function jpegMarker(buffer, marker) { for (let index = 2; index < buffer.length - 1; index++) if (buffer[index] === 255 && buffer[index + 1] === marker) return index; throw new Error('Fixture marker missing'); }

for (const [name, fixture] of Object.entries(fixtures)) {
  test(`normalizes and revalidates original ${name} with exact bytes and dimensions`, () => {
    const prepared = prepareImages([fixture]); assert.equal(prepared.length, 1); const value = prepared[0];
    assert.equal(value.width, 3); assert.equal(value.height, 2); assert.equal(value.bytes, Buffer.from(fixture.data, 'base64').length);
    assert.equal(value.sha256, createHash('sha256').update(Buffer.from(fixture.data, 'base64')).digest('hex'));
    assert.deepEqual(validateImages(prepared), prepared); assert.deepEqual(fixture, { name: value.name, mimeType: value.mimeType, data: value.data });
  });
}

test('only explicit image bytes are accepted; URL, data URL, SVG and MIME spoofing are rejected', () => {
  for (const value of [null, {}, { ...fixtures.png_rgb, url: 'https://fixture.invalid/photo.png' }, { ...fixtures.png_rgb, width: 3 }, { ...fixtures.png_rgb, mimeType: 'image/svg+xml' }, { ...fixtures.png_rgb, data: `data:image/png;base64,${fixtures.png_rgb.data}` }, { ...fixtures.png_rgb, data: 'https://fixture.invalid/photo.png' }]) reject(value, 'INVALID_IMAGES');
  reject(image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>run()</script></svg>')));
  reject(image(raw('png_rgb'), 'image/jpeg')); reject(image(raw('jpeg_baseline'), 'image/png')); reject(image(raw('webp_lossy'), 'image/png'));
});

test('base64 must be canonical with no whitespace, URL alphabet, missing padding or invalid low bits', () => {
  for (const data of ['', 'TQ', 'TQ=', 'TQ===', 'TR==', 'TQ=Z', 'TQ==\n', 'TQ_=', 'TQ-=', 'T Q=', '====', '\ud800AAA']) reject({ ...fixtures.png_rgb, data }, 'INVALID_IMAGES');
  assert.deepEqual(prepareImages(undefined), []); assert.deepEqual(prepareImages([]), []); assert.deepEqual(validateImages([]), []);
  assert.throws(() => validateImages(undefined), { code: 'INVALID_IMAGES' });
});

test('names must be bounded filenames and object getters or sparse arrays are not evaluated', () => {
  for (const name of ['', '  ', '../image.png', 'dir/image.png', 'dir\\image.png', 'nul\0.png', 'line\n.png', 'x'.repeat(201), '\ud800']) reject({ ...fixtures.png_rgb, name }, 'INVALID_IMAGES');
  let evaluated = 0; const getter = { ...fixtures.png_rgb }; Object.defineProperty(getter, 'data', { get() { evaluated++; return fixtures.png_rgb.data; }, enumerable: true });
  reject(getter, 'INVALID_IMAGES'); assert.equal(evaluated, 0);
  const list = []; Object.defineProperty(list, '0', { get() { evaluated++; return fixtures.png_rgb; } });
  assert.throws(() => prepareImages(list), { code: 'INVALID_IMAGES' }); assert.equal(evaluated, 0);
  assert.throws(() => prepareImages(new Array(1)), { code: 'INVALID_IMAGES' });
});

test('stored bytes, digest, dimensions and exact fields are revalidated rather than trusted', () => {
  const [value] = prepareImages([fixtures.png_rgb]);
  for (const patch of [{ bytes: value.bytes + 1 }, { sha256: '0'.repeat(64) }, { width: 8 }, { height: '2' }, { additional: true }, { mimeType: 'image/jpeg' }]) assert.throws(() => validateImages([{ ...value, ...patch }]), error => ['INVALID_IMAGES', 'INVALID_IMAGE_DATA'].includes(error.code));
  assert.throws(() => validateImages([fixtures.png_rgb]), { code: 'INVALID_IMAGES' });
  assert.throws(() => prepareImages([value]), { code: 'INVALID_IMAGES' });
});

test('image count, single file and aggregate byte budgets are enforced before provider use', () => {
  assert.throws(() => prepareImages(Array(IMAGE_LIMITS.count + 1).fill(fixtures.png_rgb)), { code: 'IMAGE_LIMIT' });
  reject(image(Buffer.alloc(IMAGE_LIMITS.fileBytes + 1)), 'IMAGE_LIMIT');
  const padded = image(png({ extra: [chunk('tEXt', Buffer.alloc(550 * 1024, 65))] }));
  assert.equal(prepareImages([padded]).length, 1);
  assert.throws(() => prepareImages([padded, padded]), { code: 'IMAGE_LIMIT' });
});

test('all formats reject oversized dimensions before decompression or image delivery', () => {
  for (const [width, height] of [[8193, 1], [1, 8193], [4001, 4000], [0xffffffff, 1]]) reject(image(png({ width, height })), 'IMAGE_LIMIT');
  reject(image(png({ width: 0 }))); reject(image(png({ height: 0 })));
  const jpg = raw('jpeg_baseline'), sof = jpegMarker(jpg, 0xc0); jpg.writeUInt16BE(8193, sof + 7); reject(image(jpg, 'image/jpeg'), 'IMAGE_LIMIT');
  const chunks = webpChunks(raw('webp_lossy')); chunks[0].data.writeUInt16LE(8193, 6); reject(image(riff(chunks), 'image/webp'), 'IMAGE_LIMIT');
  const lossless = webpChunks(raw('webp_lossless')); lossless[0].data.writeUInt32LE(8192, 1); reject(image(riff(lossless), 'image/webp'), 'IMAGE_LIMIT');
});

test('PNG validates CRC, critical chunk ordering, terminator and rejects animated containers', () => {
  const good = png(); const badCrc = Buffer.from(good); badCrc[29] ^= 1; reject(image(badCrc));
  reject(image(Buffer.concat([good, Buffer.from('trailing')]))); reject(image(good.subarray(0, good.length - 12)));
  for (const extra of [[chunk('IHDR', pngChunks(good)[0].data)], [chunk('ABCD', Buffer.alloc(0))], [chunk('acTL', Buffer.alloc(8))]]) reject(image(png({ extra })));
  const chunks = pngChunks(good); reject(image(Buffer.concat([good.subarray(0, 8), chunk('IDAT', chunks[1].data), chunk('IHDR', chunks[0].data), chunk('IEND', Buffer.alloc(0))])));
  // High-bit ASCII lookalikes must not pass marker comparisons.
  reject(image(png({ extra: [chunk(String.fromCharCode(0xe1) + 'BCD', Buffer.alloc(0))] })));
});

test('PNG rejects truncated/invalid compressed data, invalid filter bytes and small compressed expansion bombs', () => {
  for (const compressed of [Buffer.alloc(0), Buffer.from('not zlib'), deflateSync(Buffer.from([0, 1])), deflateSync(Buffer.alloc(4096)), Buffer.concat([deflateSync(Buffer.from([0, 255, 0, 0, 255])), Buffer.from('extra')])]) reject(image(png({ compressed })));
  reject(image(png({ content: Buffer.from([5, 255, 0, 0, 255]) })));
  reject(image(png({ depth: 3 }))); reject(image(png({ color: 5 })));
  assert.equal(prepareImages([image(png({ interlace: 1 }))])[0].width, 1);
});

test('PNG palette and transparency must agree with color type', () => {
  reject(image(png({ color: 3, depth: 1, content: Buffer.from([0, 0]) })));
  assert.equal(prepareImages([image(png({ color: 3, depth: 1, content: Buffer.from([0, 0]), extra: [chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])), chunk('tRNS', Buffer.from([0, 255]))] }))])[0].height, 1);
  reject(image(png({ extra: [chunk('tRNS', Buffer.from([0]))] })));
  reject(image(png({ color: 0, content: Buffer.from([0, 0]), extra: [chunk('PLTE', Buffer.from([0, 0, 0]))] })));
});

test('JPEG requires full frame, tables, a nonempty scan and final EOI with no trailing bytes', () => {
  const good = raw('jpeg_baseline');
  for (const bytes of [Buffer.from([255, 216, 255, 217]), good.subarray(0, -2), Buffer.concat([good, Buffer.from([0])]), good.subarray(0, jpegMarker(good, 0xda))]) reject(image(bytes, 'image/jpeg'));
  const sos = jpegMarker(good, 0xda), scanStart = sos + 2 + good.readUInt16BE(sos + 2);
  reject(image(Buffer.concat([good.subarray(0, scanStart), Buffer.from([255, 217])]), 'image/jpeg'));
  const missingTable = Buffer.from(good); const dqt = jpegMarker(missingTable, 0xdb); missingTable[dqt + 1] = 0xe1; reject(image(missingTable, 'image/jpeg'));
  const dhtBad = Buffer.from(good); const dht = jpegMarker(dhtBad, 0xc4); dhtBad[dht + 5] = 3; reject(image(dhtBad, 'image/jpeg'));
  const duplicateComponent = Buffer.from(good); const sof = jpegMarker(duplicateComponent, 0xc0); duplicateComponent[sof + 13] = duplicateComponent[sof + 10]; reject(image(duplicateComponent, 'image/jpeg'));
});

test('WebP validates RIFF/chunk sizes, frame dimensions, padding and rejects animation or header-only payloads', () => {
  const good = raw('webp_lossy'); const size = Buffer.from(good); size.writeUInt32LE(good.length, 4); reject(image(size, 'image/webp'));
  const marker = Buffer.from(good); marker[0] |= 0x80; reject(image(marker, 'image/webp'));
  reject(image(good.subarray(0, -1), 'image/webp')); reject(image(riff([{ type: 'VP8L', data: Buffer.from([0x2f, 0, 0, 0, 0]) }]), 'image/webp'));
  const invalidVp8 = webpChunks(good); invalidVp8[0].data[3] = 0; reject(image(riff(invalidVp8), 'image/webp'));
  const alphaChunks = webpChunks(raw('webp_alpha')); alphaChunks[0].data[0] |= 2; reject(image(riff(alphaChunks), 'image/webp'));
  const mismatch = webpChunks(raw('webp_alpha')); mismatch[0].data.writeUIntLE(3, 4, 3); reject(image(riff(mismatch), 'image/webp'));
  const duplicate = webpChunks(good); reject(image(riff([...duplicate, ...duplicate]), 'image/webp'));
  const padded = riff([...webpChunks(good), { type: 'meta', data: Buffer.from([1]) }]); padded[padded.length - 1] = 1; reject(image(padded, 'image/webp'));
});

test('bounded random truncations and corruptions never escape the public CoreError contract', () => {
  let seed = 0x193a5; const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (const fixture of Object.values(fixtures)) for (let index = 0; index < 40; index++) {
    let buffer = Buffer.from(fixture.data, 'base64');
    if (index % 2) buffer = buffer.subarray(0, random(buffer.length)); else buffer[random(buffer.length)] ^= 1 << random(8);
    try { const result = prepareImages([image(buffer, fixture.mimeType)]); assert.ok(result[0].width > 0 && result[0].width <= IMAGE_LIMITS.maxDimension); }
    catch (error) { assert.equal(error.name, 'CoreError'); assert.ok(['INVALID_IMAGES', 'INVALID_IMAGE_DATA', 'IMAGE_LIMIT'].includes(error.code)); }
  }
});

test('verified image cache avoids repeated PNG inflation, rechecks identity and evicts after 64 digest entries', t => {
  let inflations = 0; const original = zlib.inflateSync;
  t.mock.method(zlib, 'inflateSync', function (...args) { inflations++; return original.apply(this, args); }); syncBuiltinESMExports();
  try {
    const client = image(png({ content: Buffer.from([0, 17, 19, 201, 253]) })), canonical = prepareImages([client]);
    assert.equal(inflations, 1);
    for (let index = 0; index < 8; index++) assert.deepEqual(validateImages(canonical), canonical);
    assert.equal(inflations, 1, 'stream checkpoints reuse only verified dimensions');
    assert.throws(() => validateImages([{ ...canonical[0], bytes: canonical[0].bytes + 1 }]), { code: 'INVALID_IMAGES' });
    assert.throws(() => validateImages([{ ...canonical[0], sha256: '0'.repeat(64) }]), { code: 'INVALID_IMAGES' });
    const changed = image(png({ content: Buffer.from([0, 17, 19, 202, 253]) }));
    assert.throws(() => validateImages([{ ...canonical[0], data: changed.data }]), { code: 'INVALID_IMAGES' });
    assert.equal(inflations, 1, 'changed bytes are rejected before decompression or cache lookup');
    reject({ ...client, mimeType: 'image/jpeg' });
    for (let index = 0; index < 64; index++) prepareImages([image(png({ content: Buffer.from([0, 17, 19, index, 253]) }))]);
    assert.equal(inflations, 65); validateImages(canonical); assert.equal(inflations, 66, 'oldest verified digest was evicted');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('malformed images and incorrect stored dimensions never populate the verification cache', t => {
  let inflations = 0; const original = zlib.inflateSync;
  t.mock.method(zlib, 'inflateSync', function (...args) { inflations++; return original.apply(this, args); }); syncBuiltinESMExports();
  try {
    const bad = image(png({ content: Buffer.from([5, 173, 31, 16, 111]) })); reject(bad); reject(bad); assert.equal(inflations, 2);
    const bytes = png({ content: Buffer.from([0, 173, 31, 16, 111]) }), forged = { ...image(bytes), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 2, height: 1 };
    for (let index = 0; index < 2; index++) assert.throws(() => validateImages([forged]), { code: 'INVALID_IMAGES' });
    assert.equal(inflations, 4, 'an exception does not cache the image validation attempt');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
