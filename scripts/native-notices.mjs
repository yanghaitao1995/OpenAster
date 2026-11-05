import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const namedEntities = new Map(Object.entries({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }));
const tags = new Set(['html', 'head', 'meta', 'title', 'link', 'body', 'span', 'a', 'label', 'input', 'div', 'pre']);
const voidTags = new Set(['meta', 'link', 'input']);

function fail(message) {
  throw new Error(`Chromium notices: ${message}`);
}

/** Decode the generator's escapes once. Unknown or ambiguous entities fail closed. */
export function decodeNoticeEntities(text) {
  return text.replace(/&(?:#[^;\s<&]*;?|[A-Za-z][A-Za-z0-9]*;?)/g, (entity) => {
    if (!entity.endsWith(';')) fail(`unterminated entity ${JSON.stringify(entity)}`);
    const name = entity.slice(1, -1);
    if (namedEntities.has(name)) return namedEntities.get(name);
    if (/^#(?:[0-9]+|[xX][0-9a-fA-F]+)$/.test(name)) {
      const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      // Reject references that HTML would replace or remap instead of changing source text silently.
      if (!Number.isSafeInteger(code) || code === 0 || code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff) || (code >= 0x80 && code <= 0x9f)) {
        fail(`invalid or remapped numeric entity ${entity}`);
      }
      return String.fromCodePoint(code);
    }
    fail(`unsupported entity ${JSON.stringify(entity)}`);
  });
}

function attributes(raw) {
  const attrs = Object.create(null);
  let rest = raw;
  while (rest.trim()) {
    const match = /^\s+([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(rest);
    if (!match) fail(`unrecognized attributes ${JSON.stringify(rest.slice(0, 80))}`);
    const key = match[1].toLowerCase();
    if (Object.hasOwn(attrs, key)) fail(`duplicate attribute ${key}`);
    attrs[key] = decodeNoticeEntities(match[2] ?? match[3] ?? match[4] ?? '');
    rest = rest.slice(match[0].length);
  }
  return attrs;
}

// This is deliberately a strict parser for the generated credits format, not a browser.
// It never loads URLs or executes markup and never normalizes preformatted line endings.
function parseDocument(html) {
  const root = { tag: '#document', children: [] };
  const stack = [root];
  const elements = [];
  let position = 0;
  while (position < html.length) {
    const parent = stack.at(-1);
    if (html[position] !== '<') {
      const next = html.indexOf('<', position);
      const end = next === -1 ? html.length : next;
      parent.children.push({ tag: '#text', text: html.slice(position, end) });
      position = end;
      continue;
    }
    if (html.startsWith('<!--', position)) {
      const end = html.indexOf('-->', position + 4);
      if (end === -1) fail(`unclosed comment at character ${position}`);
      parent.children.push({ tag: '#comment' });
      position = end + 3;
      continue;
    }
    const token = /^(?:<!doctype\s+html\s*>|<\/[A-Za-z][A-Za-z0-9]*\s*>|<[A-Za-z][A-Za-z0-9]*(?:"[^"]*"|'[^']*'|[^'"<>])*?>)/i.exec(html.slice(position));
    if (!token) fail(`unrecognized markup at character ${position}`);
    const raw = token[0];
    const end = position + raw.length;
    if (/^<!doctype/i.test(raw)) {
      if (parent !== root) fail('doctype inside an element');
    } else if (raw.startsWith('</')) {
      const tag = raw.slice(2, -1).trim().toLowerCase();
      if (parent.tag !== tag) fail(`mismatched closing ${tag} at character ${position}`);
      parent.end = end;
      stack.pop();
    } else {
      const match = /^<([A-Za-z][A-Za-z0-9]*)([\s\S]*?)\s*(\/?)>$/.exec(raw);
      const tag = match[1].toLowerCase();
      if (!tags.has(tag)) fail(`unsupported element ${tag} at character ${position}`);
      if (match[3] && !voidTags.has(tag)) fail(`self-closing non-void element ${tag}`);
      const node = { tag, attrs: attributes(match[2]), children: [], parent, start: position, end };
      parent.children.push(node);
      elements.push(node);
      if (!voidTags.has(tag)) stack.push(node);
    }
    position = end;
  }
  // licenses.py's supplied document omits these two optional HTML end tags.
  if (stack.length !== 1 && !(stack.length === 3 && stack[1].tag === 'html' && stack[2].tag === 'body')) {
    fail(`unclosed element ${stack.at(-1).tag}`);
  }
  return { root, elements };
}

const hasClass = (node, name) => (node.attrs?.class ?? '').split(/\s+/).includes(name);
const significantChildren = (node) => node.children.filter((child) => child.tag !== '#comment' && !(child.tag === '#text' && !child.text.trim()));

function textOnly(node, context) {
  if (node.children.some((child) => child.tag !== '#text')) fail(`unexpected markup in ${context}`);
  return decodeNoticeEntities(node.children.map((child) => child.text).join(''));
}

function one(nodes, context) {
  if (nodes.length !== 1) fail(`expected exactly one ${context}; found ${nodes.length}`);
  return nodes[0];
}

/**
 * Create a source-bound notice inventory, not a binary SBOM or a license verdict.
 * Input is UTF-8 bytes (preferred for exact file hashes) or a well-formed string.
 * Byte ranges are zero-based and end-exclusive in the original source file.
 */
export function parseChromiumNotices(input, { sourcePath = null } = {}) {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) throw new TypeError('Expected UTF-8 bytes or text');
  if (typeof input === 'string' && !input.isWellFormed()) fail('malformed Unicode string');
  const bytes = Buffer.from(input);
  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('source is not valid UTF-8');
  }
  if (html.includes('\0')) fail('source contains a NUL character');
  const { root, elements } = parseDocument(html);
  for (const node of elements) {
    if (['product', 'title', 'homepage', 'license'].filter((name) => hasClass(node, name)).length > 1) {
      fail(`ambiguous notice field at character ${node.start}`);
    }
  }
  const products = elements.filter((node) => hasClass(node, 'product'));
  if (!products.length) fail('no product records found');
  const container = products[0].parent;
  if (products.some((node) => node.parent !== container)) fail('product records must share one container');
  const siblings = significantChildren(container);
  if (siblings.some((node) => !products.includes(node))) fail('unrecognized content in the product container');
  const consumed = new Set();
  let cursor = 0;
  let byteCursor = 0;
  const records = products.map((product, index) => {
    if (product.tag !== 'div') fail('product must be a div');
    const children = significantChildren(product);
    if (children.some((node) => !((node.tag === 'span' && (hasClass(node, 'title') || hasClass(node, 'homepage'))) ||
        (node.tag === 'div' && hasClass(node, 'license')) || (node.tag === 'label' && hasClass(node, 'show'))))) {
      fail(`unrecognized content in product ${index + 1}`);
    }
    const titleNode = one(children.filter((node) => hasClass(node, 'title')), `title in product ${index + 1}`);
    const title = textOnly(titleNode, `title in product ${index + 1}`);
    if (!title.trim()) fail(`empty title in product ${index + 1}`);
    const licenseNode = one(children.filter((node) => hasClass(node, 'license')), `license in product ${index + 1}`);
    const pre = one(significantChildren(licenseNode), `pre in product ${index + 1}`);
    if (pre.tag !== 'pre') fail(`license must contain a pre in product ${index + 1}`);
    const licenseText = textOnly(pre, `license in product ${index + 1}`);
    if (!licenseText.trim()) fail(`empty license in product ${index + 1}`);
    const homepages = children.filter((node) => hasClass(node, 'homepage'));
    if (homepages.length > 1) fail(`duplicate homepage in product ${index + 1}`);
    let homepage = null;
    if (homepages.length) {
      const link = one(significantChildren(homepages[0]), `homepage link in product ${index + 1}`);
      if (link.tag !== 'a' || !Object.hasOwn(link.attrs, 'href') || !link.attrs.href.trim()) fail(`missing homepage href in product ${index + 1}`);
      textOnly(link, `homepage link in product ${index + 1}`);
      homepage = link.attrs.href;
      consumed.add(homepages[0]);
    }
    const labels = children.filter((node) => node.tag === 'label');
    if (labels.length > 1) fail(`duplicate show control in product ${index + 1}`);
    for (const label of labels) {
      const inputNode = one(significantChildren(label), `show input in product ${index + 1}`);
      if (inputNode.tag !== 'input' || inputNode.attrs.type !== 'checkbox') fail(`unrecognized show control in product ${index + 1}`);
    }
    for (const node of [product, titleNode, licenseNode, pre]) consumed.add(node);
    byteCursor += Buffer.byteLength(html.slice(cursor, product.start));
    const startByte = byteCursor;
    byteCursor += Buffer.byteLength(html.slice(product.start, product.end));
    cursor = product.end;
    return {
      index: index + 1,
      title,
      homepage,
      licenseText,
      licenseTextSha256: sha256(licenseText),
      source: { startByte, endByte: byteCursor, sha256: sha256(bytes.subarray(startByte, byteCursor)) },
    };
  });
  for (const node of elements) {
    if ((node.tag === 'pre' || ['product', 'title', 'homepage', 'license'].some((name) => hasClass(node, name))) && !consumed.has(node)) {
      fail(`unbound notice field ${node.tag} at character ${node.start}`);
    }
    // Unknown div wrappers could be a new record format. Do not silently skip them.
    if (node.tag === 'div' && node !== container && !consumed.has(node) && !hasClass(node, 'open-sourced')) {
      fail(`unrecognized div at character ${node.start}`);
    }
  }
  if (container !== root && container.tag !== 'div') fail('unrecognized product container');
  return {
    schemaVersion: 1,
    inventoryType: 'electron-chromium-notices',
    scope: 'Records extracted from the supplied notice document only; not an exact binary SBOM, version inventory, SPDX classification, or legal assessment.',
    source: { path: sourcePath, sha256: sha256(bytes), byteLength: bytes.length, encoding: 'UTF-8' },
    recordCount: records.length,
    records,
  };
}

export async function readChromiumNoticeInventory(sourcePath) {
  return parseChromiumNotices(await readFile(sourcePath), { sourcePath: sourcePath instanceof URL ? fileURLToPath(sourcePath) : sourcePath });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/native-notices.mjs <LICENSES.chromium.html> (JSON to stdout)');
    process.stdout.write(`${JSON.stringify(await readChromiumNoticeInventory(process.argv[2]), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
