// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { CoreError } from './errors.mjs';

export const IMAGE_LIMITS = Object.freeze({ count: 4, fileBytes: 768 * 1024, totalBytes: 1024 * 1024, maxPixels: 16_000_000, maxDimension: 8192 });
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const CLIENT_FIELDS = ['name', 'mimeType', 'data'];
const STORED_FIELDS = [...CLIENT_FIELDS, 'bytes', 'sha256', 'width', 'height'];
const invalid = () => new CoreError('INVALID_IMAGES', '图片须具有名称、PNG/JPEG/WebP 类型和有效的 Base64 内容。');
const corrupt = () => new CoreError('INVALID_IMAGE_DATA', '图片内容、类型或结构无效，请重新选择有效的静态 PNG、JPEG 或 WebP 图片。');
const limit = () => new CoreError('IMAGE_LIMIT', '最多添加 4 张图片，单张不超过 768 KiB，合计不超过 1 MiB；单边不超过 8192 像素、单张不超过 1600 万像素。', 413);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Repeated stream checkpoints revalidate the same snapshots. Keep only 64
// successfully verified digest/dimension records, never image bytes or errors.
const verifiedDimensions = new Map();

function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  let descriptors, keys;
  try { descriptors = Object.getOwnPropertyDescriptors(value); keys = Reflect.ownKeys(value); } catch { throw invalid(); }
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || fields.some(field => !descriptors[field] || !Object.hasOwn(descriptors[field], 'value'))) throw invalid();
  return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
}

function items(value) {
  if (!Array.isArray(value)) throw invalid();
  if (value.length > IMAGE_LIMITS.count) throw limit();
  const result = [];
  for (let index = 0; index < value.length; index++) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, index); } catch { throw invalid(); }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
    result.push(descriptor.value);
  }
  return result;
}

function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw corrupt();
  if (width > IMAGE_LIMITS.maxDimension || height > IMAGE_LIMITS.maxDimension || width * height > IMAGE_LIMITS.maxPixels) throw limit();
  return { width, height };
}

function decode(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4) throw invalid();
  if (value.length > Math.ceil(IMAGE_LIMITS.fileBytes / 3) * 4) throw limit();
  let padding = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 61 && index >= value.length - 2) { padding++; continue; }
    if (padding || !(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47)) throw invalid();
  }
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.toString('base64') !== value) throw invalid();
  if (buffer.length > IMAGE_LIMITS.fileBytes) throw limit();
  return buffer;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }

// PNG structure and filtered data are validated, without rendering or executing metadata.
// Format reference: https://www.w3.org/TR/png-3/
function png(buffer) {
  if (buffer.length < 57 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw corrupt();
  let offset = 8, info, color, depth, interlace, palette = 0, transparency = false, ended = false, afterData = false;
  const compressed = [];
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw corrupt();
    const length = buffer.readUInt32BE(offset), end = offset + 12 + length;
    if (length > 0x7fffffff || end > buffer.length) throw corrupt();
    const type = buffer.toString('latin1', offset + 4, offset + 8), data = buffer.subarray(offset + 8, offset + 8 + length);
    if (!/^[A-Za-z]{4}$/u.test(type) || type[2] !== type[2].toUpperCase() || crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(offset + 8 + length)) throw corrupt();
    if (!info && type !== 'IHDR') throw corrupt();
    if (type === 'IHDR') {
      if (info || offset !== 8 || length !== 13) throw corrupt();
      info = dimensions(data.readUInt32BE(0), data.readUInt32BE(4)); depth = data[8]; color = data[9]; interlace = data[12];
      const allowed = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!allowed[color]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || interlace > 1) throw corrupt();
    } else if (type === 'PLTE') {
      if (palette || compressed.length || color === 0 || color === 4 || !length || length % 3 || length > 768 || color === 3 && length / 3 > 2 ** depth) throw corrupt();
      palette = length / 3;
    } else if (type === 'tRNS') {
      if (transparency || compressed.length || ![0, 2, 3].includes(color) || color === 0 && length !== 2 || color === 2 && length !== 6 || color === 3 && (!palette || length < 1 || length > palette)) throw corrupt();
      transparency = true;
    } else if (type === 'IDAT') {
      if (afterData || color === 3 && !palette) throw corrupt();
      compressed.push(data);
    } else if (type === 'IEND') {
      if (length || !compressed.length || end !== buffer.length) throw corrupt();
      ended = true; offset = end; break;
    } else {
      if (['acTL', 'fcTL', 'fdAT'].includes(type) || type[0] === type[0].toUpperCase()) throw corrupt();
      if (compressed.length) afterData = true;
    }
    offset = end;
  }
  if (!info || !ended || !compressed.length) throw corrupt();
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color], bits = channels * depth;
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((info.width - x) / dx)), height = Math.max(0, Math.ceil((info.height - y) / dy));
    return { bytes: Math.ceil(width * bits / 8), count: width ? height : 0 };
  });
  const expected = rows.reduce((sum, row) => sum + (row.bytes + 1) * row.count, 0), input = Buffer.concat(compressed);
  let decoded;
  try {
    const result = inflateSync(input, { maxOutputLength: expected, info: true });
    if (result.engine.bytesWritten !== input.length || result.buffer.length !== expected) throw corrupt();
    decoded = result.buffer;
  } catch { throw corrupt(); }
  let rowOffset = 0;
  for (const row of rows) for (let index = 0; index < row.count; index++) { if (decoded[rowOffset] > 4) throw corrupt(); rowOffset += row.bytes + 1; }
  return info;
}

// JPEG marker, table and scan framing checks. This is not a second JPEG pixel decoder.
// Format reference: https://www.w3.org/Graphics/JPEG/itu-t81.pdf (Annex B).
function jpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw corrupt();
  let offset = 2, info, frameType, scans = 0, ended = false, restartInterval = 0, markers = 0;
  const components = new Map(), quantization = new Set(), huffman = new Set(), scanned = new Set();
  while (offset < buffer.length) {
    if (++markers > 10000 || buffer[offset++] !== 0xff) throw corrupt();
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9) { if (!info || !scans || offset !== buffer.length || scanned.size !== components.size) throw corrupt(); ended = true; break; }
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > buffer.length) throw corrupt();
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw corrupt();
    const data = buffer.subarray(offset + 2, offset + length); offset += length;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (info || data.length < 6 || data[0] !== 8 || ![1, 3, 4].includes(data[5]) || data.length !== 6 + 3 * data[5]) throw corrupt();
      frameType = marker; info = dimensions(data.readUInt16BE(3), data.readUInt16BE(1));
      for (let at = 6; at < data.length; at += 3) {
        const id = data[at], horizontal = data[at + 1] >>> 4, vertical = data[at + 1] & 15, table = data[at + 2];
        if (components.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4 || table > 3) throw corrupt();
        components.set(id, table);
      }
    } else if (marker === 0xdb) {
      for (let at = 0; at < data.length;) {
        const selector = data[at++], precision = selector >>> 4, id = selector & 15, size = precision ? 128 : 64;
        if (precision > 1 || id > 3 || at + size > data.length) throw corrupt();
        for (let index = at; index < at + size; index += precision ? 2 : 1) if (!(precision ? data.readUInt16BE(index) : data[index])) throw corrupt();
        quantization.add(id); at += size;
      }
      if (!data.length) throw corrupt();
    } else if (marker === 0xc4) {
      for (let at = 0; at < data.length;) {
        const selector = data[at++], kind = selector >>> 4, id = selector & 15;
        if (kind > 1 || id > 3 || at + 16 > data.length) throw corrupt();
        let count = 0, capacity = 1;
        for (let index = 0; index < 16; index++) { const size = data[at++]; count += size; capacity = capacity * 2 - size; if (capacity < 0) throw corrupt(); }
        if (!count || count > 256 || at + count > data.length) throw corrupt();
        for (let index = 0; index < count; index++) if (kind === 0 && data[at + index] > 15) throw corrupt();
        huffman.add(`${kind}:${id}`); at += count;
      }
      if (!data.length) throw corrupt();
    } else if (marker === 0xdd) {
      if (data.length !== 2) throw corrupt(); restartInterval = data.readUInt16BE(0);
    } else if (marker === 0xda) {
      if (!info || data.length < 6 || !data[0] || data[0] > components.size || data.length !== 4 + 2 * data[0]) throw corrupt();
      const first = data.at(-3), last = data.at(-2), high = data.at(-1) >>> 4, low = data.at(-1) & 15;
      if (frameType !== 0xc2 ? first !== 0 || last !== 63 || high !== 0 || low !== 0 : first > last || last > 63 || first === 0 && last !== 0 || first > 0 && data[0] !== 1 || high > 13 || low > 13 || high !== 0 && high !== low + 1) throw corrupt();
      const seen = new Set();
      for (let at = 1; at < 1 + data[0] * 2; at += 2) {
        const id = data[at], dc = data[at + 1] >>> 4, ac = data[at + 1] & 15;
        if (!components.has(id) || seen.has(id) || dc > 3 || ac > 3 || !quantization.has(components.get(id))) throw corrupt();
        if ((frameType !== 0xc2 || first === 0 && high === 0) && !huffman.has(`0:${dc}`) || (frameType !== 0xc2 || first > 0) && !huffman.has(`1:${ac}`)) throw corrupt();
        seen.add(id); scanned.add(id);
      }
      let entropy = 0, restart = 0;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) { entropy++; offset++; continue; }
        const start = offset;
        while (buffer[offset] === 0xff) offset++;
        const next = buffer[offset];
        if (next === 0) { entropy++; offset++; continue; }
        if (next >= 0xd0 && next <= 0xd7) { if (!restartInterval || next !== 0xd0 + restart % 8) throw corrupt(); restart++; offset++; continue; }
        offset = start; break;
      }
      if (!entropy) throw corrupt(); scans++;
    } else if (!(marker >= 0xe0 && marker <= 0xef || marker === 0xfe)) throw corrupt();
  }
  if (!ended) throw corrupt();
  return info;
}

// Container and bitstream header validation; no URL fetch or native image execution.
// Format references: https://developers.google.com/speed/webp/docs/riff_container
// https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification
function webp(buffer) {
  if (buffer.length < 26 || buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP' || buffer.readUInt32LE(4) !== buffer.length - 8 || buffer.length % 2) throw corrupt();
  let offset = 12, extended, flags = 0, encoded, alpha;
  const seen = new Set();
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw corrupt();
    const type = buffer.toString('latin1', offset, offset + 4), length = buffer.readUInt32LE(offset + 4), end = offset + 8 + length;
    if (end + length % 2 > buffer.length || length % 2 && buffer[end] !== 0) throw corrupt();
    const data = buffer.subarray(offset + 8, end);
    if (['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type)) { if (seen.has(type)) throw corrupt(); seen.add(type); }
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || data[0] & 0xc1 || data[1] || data[2] || data[3]) throw corrupt();
      flags = data[0]; if (flags & 2) throw corrupt();
      extended = dimensions(data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1);
    } else if (type === 'VP8 ') {
      if (encoded || length < 11 || !data.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) throw corrupt();
      const tag = data.readUIntLE(0, 3), partition = tag >>> 5;
      if (tag & 1 || (tag >>> 1 & 7) > 3 || !(tag & 16) || !partition || partition + 10 > length) throw corrupt();
      encoded = dimensions(data.readUInt16LE(6) & 0x3fff, data.readUInt16LE(8) & 0x3fff);
    } else if (type === 'VP8L') {
      if (encoded || alpha || length < 6 || data[0] !== 0x2f) throw corrupt();
      const bits = data.readUInt32LE(1); if (bits >>> 29) throw corrupt();
      encoded = dimensions((bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1);
    } else if (type === 'ALPH') {
      if (!extended || encoded || !length || data[0] & 0xc0 || (data[0] >>> 4 & 3) > 1 || (data[0] & 3) > 1) throw corrupt();
      alpha = data;
    } else if (type === 'ANIM' || type === 'ANMF') throw corrupt();
    else if (['ICCP', 'EXIF', 'XMP '].includes(type) && (!extended || !length || type === 'ICCP' && encoded)) throw corrupt();
    offset = end + length % 2;
  }
  if (!encoded || offset !== buffer.length || extended && (extended.width !== encoded.width || extended.height !== encoded.height)) throw corrupt();
  if (alpha && (alpha[0] & 3) === 0 && alpha.length !== encoded.width * encoded.height + 1 || alpha && (alpha[0] & 3) === 1 && alpha.length < 2) throw corrupt();
  if (extended && ((seen.has('VP8L') ? false : Boolean(flags & 16) !== Boolean(alpha)) || Boolean(flags & 32) !== seen.has('ICCP') || Boolean(flags & 8) !== seen.has('EXIF') || Boolean(flags & 4) !== seen.has('XMP '))) throw corrupt();
  return encoded;
}

function normalize(value, stored) {
  let total = 0;
  return items(value).map(item => {
    const entry = object(item, stored ? STORED_FIELDS : CLIENT_FIELDS);
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 200 || !entry.name.isWellFormed() || /[\x00-\x1f\x7f/\\]/u.test(entry.name) || !TYPES.has(entry.mimeType)) throw invalid();
    const buffer = decode(entry.data); total += buffer.length; if (total > IMAGE_LIMITS.totalBytes) throw limit();
    const sha256 = hash(buffer), key = `${entry.mimeType}:${sha256}`;
    if (stored && (entry.bytes !== buffer.length || entry.sha256 !== sha256)) throw invalid();
    let info;
    try { info = verifiedDimensions.get(key) ?? (entry.mimeType === 'image/png' ? png(buffer) : entry.mimeType === 'image/jpeg' ? jpeg(buffer) : webp(buffer)); }
    catch (error) { if (error instanceof CoreError) throw error; throw corrupt(); }
    const result = { name: entry.name, mimeType: entry.mimeType, data: entry.data, bytes: buffer.length, sha256, ...info };
    if (stored && (entry.width !== result.width || entry.height !== result.height)) throw invalid();
    verifiedDimensions.delete(key); verifiedDimensions.set(key, Object.freeze({ width: info.width, height: info.height }));
    if (verifiedDimensions.size > 64) verifiedDimensions.delete(verifiedDimensions.keys().next().value);
    return result;
  });
}

/** Accept only local image bytes; remote URLs, data URLs and caller-supplied metadata are rejected. */
export function prepareImages(value) { return value === undefined ? [] : normalize(value, false); }
/** Revalidate durable images before use; MIME type, dimensions and hashes are never trusted. */
export function validateImages(value) { return normalize(value, true); }
