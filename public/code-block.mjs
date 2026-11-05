// SPDX-License-Identifier: Apache-2.0
// Original, bounded lexical presentation. Source text is never parsed as HTML.
const aliases = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', powershell: 'powershell', ps1: 'powershell', text: 'text', txt: 'text', plaintext: 'text' };
const names = { javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON', python: 'Python', shell: 'Shell', powershell: 'PowerShell', sql: 'SQL', text: '纯文本' };
const words = {
  javascript: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield',
  typescript: 'abstract any as assert asserts async await bigint boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function if implements import in infer instanceof interface is keyof let module namespace never new null number of private protected public readonly return satisfies static string super switch symbol this throw true try type typeof undefined unique unknown var void while yield',
  json: 'true false null',
  python: 'and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield',
  shell: 'case do done elif else esac export fi for function if in local readonly return select then until while',
  powershell: 'begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using var while',
  sql: 'all alter and as asc begin between by case create delete desc distinct drop else end exists false from group having in inner insert into is join left like limit not null offset on or order outer primary references right select set table then true union unique update using values when where with',
};
const keywords = Object.fromEntries(Object.entries(words).map(([language, value]) => [language, new Set(value.split(' '))]));
const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
const number = /(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
const identifier = /[A-Za-z_$][\w$]*/y;

// This is a small lexer, not a compiler. Unknown/large blocks retain exact text
// without color. Bound both input and tokens to keep untrusted output cheap.
function tokens(text, language) {
  const vocabulary = keywords[language];
  if (!vocabulary || text.length > 65536) return null;
  const result = []; let cursor = 0, plain = '';
  const add = (kind, value) => { if (plain) { result.push({ text: plain }); plain = ''; } result.push({ kind, text: value }); };
  while (cursor < text.length) {
    if (result.length > 3000) return null;
    const start = cursor, char = text[cursor];
    const lineComment = ['javascript', 'typescript'].includes(language) && text.startsWith('//', cursor)
      || ['python', 'shell', 'powershell'].includes(language) && char === '#'
      || language === 'sql' && text.startsWith('--', cursor);
    const blockComment = ['javascript', 'typescript', 'sql'].includes(language) && text.startsWith('/*', cursor);
    if (lineComment || blockComment) {
      const end = text.indexOf(blockComment ? '*/' : '\n', cursor + 1);
      cursor = end < 0 ? text.length : end + (blockComment ? 2 : 0);
      add('comment', text.slice(start, cursor)); continue;
    }
    if (char === '"' || char === "'" && language !== 'json' || char === '`' && ['javascript', 'typescript', 'shell'].includes(language)) {
      const quote = language === 'python' && text.startsWith(char.repeat(3), cursor) ? char.repeat(3) : char;
      cursor += quote.length;
      while (cursor < text.length) {
        if (text[cursor] === '\\') { cursor = Math.min(text.length, cursor + 2); continue; }
        if (text.startsWith(quote, cursor)) {
          cursor += quote.length;
          if (language === 'sql' && text.startsWith(quote, cursor)) { cursor += quote.length; continue; }
          break;
        }
        cursor++;
      }
      let kind = 'string';
      if (language === 'json') { let after = cursor; while (/\s/u.test(text[after] ?? '') && after < text.length) after++; if (text[after] === ':') kind = 'property'; }
      add(kind, text.slice(start, cursor)); continue;
    }
    number.lastIndex = cursor;
    const numeric = /\d/.test(char) ? number.exec(text) : null;
    if (numeric) { cursor = number.lastIndex; add('number', numeric[0]); continue; }
    identifier.lastIndex = cursor;
    const word = identifier.exec(text);
    if (word) {
      cursor = identifier.lastIndex;
      const key = ['sql', 'powershell'].includes(language) ? word[0].toLowerCase() : word[0];
      if (vocabulary.has(key)) add('keyword', word[0]); else plain += word[0];
      continue;
    }
    plain += char; cursor++;
  }
  if (plain) result.push({ text: plain });
  return result;
}
function renderCode(text, language) {
  const content = node('code'), parts = tokens(text, language);
  if (!parts) { content.textContent = text; return content; }
  for (const part of parts) content.append(part.kind ? node('span', `syntax-${part.kind}`, part.text) : document.createTextNode(part.text));
  return content;
}

export function createCodeBlock(info, text) {
  const raw = String(info || '').trim().split(/\s/u, 1)[0].slice(0, 48).replace(/[\p{Cc}\p{Cf}]/gu, '');
  const language = aliases[raw.toLowerCase()] || raw.toLowerCase() || 'text';
  const label = names[language] || raw;
  const box = node('div', 'code-block'); box.dataset.language = language;
  const bar = node('div', 'code-heading'), identity = node('div', 'code-identity');
  const title = node('span', 'code-language', label); title.title = label;
  const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  const count = node('span', 'code-lines', `${lines} 行`); count.setAttribute('aria-hidden', 'true');
  identity.append(title, count);
  const actions = node('div', 'code-actions');
  const wrap = node('button', 'text-button code-wrap', '换行'); wrap.type = 'button'; wrap.setAttribute('aria-label', '自动换行'); wrap.setAttribute('aria-pressed', 'false');
  wrap.addEventListener('click', () => { const active = box.classList.toggle('is-wrapped'); wrap.setAttribute('aria-pressed', String(active)); });
  const copy = node('button', 'text-button code-copy', '复制'); copy.type = 'button'; copy.setAttribute('aria-label', language === 'text' ? '复制文本' : '复制代码');
  const status = node('span', 'sr-only code-copy-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  let reset;
  copy.addEventListener('click', async () => {
    clearTimeout(reset); copy.disabled = true; status.textContent = '';
    try { await navigator.clipboard.writeText(text); copy.textContent = '已复制'; status.textContent = '已复制完整内容。'; }
    catch { copy.textContent = '复制失败'; status.textContent = '无法访问剪贴板，请选中文本后复制。'; }
    finally { copy.disabled = false; reset = setTimeout(() => { copy.textContent = '复制'; }, 1800); }
  });
  actions.append(wrap, copy); bar.append(identity, actions);
  const pre = node('pre'); pre.tabIndex = 0; pre.setAttribute('role', 'region'); pre.setAttribute('aria-label', `${label}${language === 'text' ? '块' : '代码块'}，${lines} 行，可滚动`);
  pre.append(renderCode(text, language)); box.append(bar, pre, status); return box;
}
