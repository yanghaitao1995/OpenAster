// A deliberately small Markdown renderer. Model output never becomes HTML.
import { createCodeBlock } from './code-block.mjs';
const fenceStart = line => /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
const listItem = line => /^\s*(?:([-*+])\s+|(\d+)[.)]\s+)(.*)$/.exec(line);

// A closing code marker is an entire run of the same length. Backslashes
// inside code are literal, including one immediately before the closing run.
function codeEnd(text, from, length) {
  let cursor = from;
  while ((cursor = text.indexOf('`', cursor)) !== -1) {
    let after = cursor + 1; while (text[after] === '`') after++;
    if (after - cursor === length) return cursor;
    cursor = after;
  }
  return -1;
}

// Pipes inside complete code spans and escaped pipes belong to a cell.
// An unmatched marker is ordinary text and cannot hide later columns.
function tableCells(line) {
  const cells = []; let cell = '', separators = 0;
  const source = line.trim(), lastRuns = new Map();
  // Avoid rescanning the suffix for every unmatched marker. Successful scans
  // consume their whole span, so the table scan stays linear in the row size.
  for (const run of source.matchAll(/`+/g)) lastRuns.set(run[0].length, run.index);
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\' && index + 1 < source.length) { cell += char + source[++index]; continue; }
    if (char === '`') {
      let end = index + 1; while (source[end] === '`') end++;
      const length = end - index;
      const closing = (lastRuns.get(length) ?? -1) >= end ? codeEnd(source, end, length) : -1;
      const after = closing === -1 ? end : closing + length;
      cell += source.slice(index, after); index = after - 1; continue;
    }
    if (char === '|') { cells.push(cell.trim()); cell = ''; separators++; }
    else cell += char;
  }
  cells.push(cell.trim());
  if (source.startsWith('|')) cells.shift();
  if (source.endsWith('|') && cells.at(-1) === '') cells.pop();
  return { cells, separators };
}
function tableHeader(lines, index) {
  if (index + 1 >= lines.length) return null;
  const header = tableCells(lines[index]), rule = tableCells(lines[index + 1]);
  if (!header.separators || !header.cells.length || header.cells.length !== rule.cells.length || !rule.cells.every(cell => /^:?-+:?$/.test(cell))) return null;
  return { cells: header.cells, alignment: rule.cells.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left') };
}
export function renderMarkdown(text) {
  const root = document.createElement('div'); root.className = 'markdown';
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index], fence = fenceStart(line);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      const language = fence[3].trim(), code = [], closing = new RegExp('^ {0,3}' + fence[2][0] + '{' + fence[2].length + ',}\\s*$');
      index++;
      while (index < lines.length && !closing.test(lines[index])) {
        const value = lines[index++], indent = Math.min(fence[1].length, /^ */.exec(value)[0].length);
        code.push(value.slice(indent));
      }
      const closed = index < lines.length; if (closed) index++;
      root.append(createCodeBlock(language, code.join('\n') + (closed && code.length ? '\n' : ''))); continue;
    }
    if (!line.trim()) { index++; continue; }
    const table = tableHeader(lines, index);
    if (table) {
      const viewport = document.createElement('div'); viewport.className = 'markdown-table-scroll'; viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', '表格，可横向滚动');
      const node = document.createElement('table'), head = document.createElement('thead'), body = document.createElement('tbody');
      const appendRow = (parent, cells, heading) => {
        const row = document.createElement('tr');
        table.cells.forEach((_, column) => { const cell = document.createElement(heading ? 'th' : 'td'); if (heading) cell.scope = 'col'; cell.className = 'align-' + table.alignment[column]; inline(cell, cells[column] || '', true); row.append(cell); });
        parent.append(row);
      };
      appendRow(head, table.cells, true); index += 2;
      while (index < lines.length && lines[index].trim() && !fenceStart(lines[index]) && !/^(?:#{1,6}\s|>)/.test(lines[index]) && !listItem(lines[index]) && tableCells(lines[index]).separators) appendRow(body, tableCells(lines[index++]).cells, false);
      node.append(head, body); viewport.append(node); root.append(viewport); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const h = document.createElement(`h${Math.min(heading[1].length + 1, 6)}`); inline(h, heading[2]); root.append(h); index++; continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { root.append(document.createElement('hr')); index++; continue; }
    const list = listItem(line);
    if (list) {
      const ordered = Boolean(list[2]), node = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered && Number(list[2]) !== 1) node.start = Number(list[2]);
      while (index < lines.length) { const next = listItem(lines[index]); if (!next || Boolean(next[2]) !== ordered) break; const li = document.createElement('li'); inline(li, next[3]); node.append(li); index++; }
      root.append(node); continue;
    }
    if (/^>\s?/.test(line)) { const quote = document.createElement('blockquote'); const content = []; while (index < lines.length && /^>\s?/.test(lines[index])) content.push(lines[index++].replace(/^>\s?/, '')); inline(quote, content.join('\n')); root.append(quote); continue; }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim() && !fenceStart(lines[index]) && !/^(?:#{1,6}\s|>)/.test(lines[index]) && !listItem(lines[index]) && !tableHeader(lines, index) && !/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])) paragraph.push(lines[index++]);
    const p = document.createElement('p'); inline(p, paragraph.join('\n')); root.append(p);
  }
  return root;
}
function inline(parent, text, tableCell = false) {
  let index = 0, plain = '';
  const flush = () => { if (plain) parent.append(document.createTextNode(plain)); plain = ''; };
  while (index < text.length) {
    if (text[index] === '\\' && /[\\`*{}\[\]()#+\-.!_|>~]/.test(text[index + 1] || '')) { plain += text[index + 1]; index += 2; continue; }
    if (text[index] === '`') {
      let end = index + 1; while (text[end] === '`') end++;
      const marker = text.slice(index, end), closing = codeEnd(text, end, marker.length);
      if (closing !== -1) { flush(); const node = document.createElement('code'); let value = text.slice(end, closing).replace(/\n/g, ' '); if (value.startsWith(' ') && value.endsWith(' ') && /[^ ]/.test(value)) value = value.slice(1, -1); node.textContent = tableCell ? value.replace(/\\\|/g, '|') : value; parent.append(node); index = closing + marker.length; continue; }
      plain += marker; index = end; continue;
    }
    const strong = text.startsWith('**', index) && /^\*\*([^*\n]+)\*\*/.exec(text.slice(index));
    if (strong) { flush(); const node = document.createElement('strong'); node.textContent = strong[1]; parent.append(node); index += strong[0].length; continue; }
    const link = text[index] === '[' && /^\[([^\[\]\n]+)\]\(([^\s()\[\]]+)\)/.exec(text.slice(index));
    if (link) {
      let url; try { url = new URL(link[2]); } catch { url = null; }
      if (url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) { flush(); const node = document.createElement('a'); node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; node.textContent = link[1]; parent.append(node); index += link[0].length; continue; }
    }
    plain += text[index++];
  }
  flush();
}
