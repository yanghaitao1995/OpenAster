// A textarea normalizes newlines to LF. Keep the source format outside its
// value so merely entering the editor cannot rewrite BOMs or line endings.
export const EDITOR_MAX_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const endings = Object.freeze({ LF: '\n', CRLF: '\r\n', CR: '\r' });

function invalid(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateText(content) {
  if (typeof content !== 'string') throw invalid('FILE_EDITOR_INVALID_TEXT', '文件内容必须是文本。');
  for (let index = 0; index < content.length; index++) {
    const unit = content.charCodeAt(index);
    if (unit === 0) throw invalid('FILE_EDITOR_NUL', '含有 NUL 字符的文件不能在文本编辑器中保存。');
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = content.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid('FILE_EDITOR_INVALID_UNICODE', '文本包含不完整的 Unicode 字符。');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw invalid('FILE_EDITOR_INVALID_UNICODE', '文本包含不完整的 Unicode 字符。');
    }
  }
  const bytes = encoder.encode(content).byteLength;
  if (bytes > EDITOR_MAX_BYTES) throw invalid('FILE_EDITOR_TOO_LARGE', '文件内容不能超过 256 KiB。');
  return bytes;
}

export function inspectEditorText(content) {
  const bytes = validateText(content), bom = content.startsWith('\uFEFF');
  const body = bom ? content.slice(1) : content;
  const kinds = new Set();
  const text = body.replace(/\r\n|\r|\n/g, value => {
    kinds.add(value === '\r\n' ? 'CRLF' : value === '\r' ? 'CR' : 'LF');
    return '\n';
  });
  return Object.freeze({ bom, ending: kinds.size > 1 ? 'mixed' : kinds.values().next().value ?? 'none', text, bytes });
}

export function encodeEditorText(originalContent, editorText, { ending } = {}) {
  const original = inspectEditorText(originalContent);
  validateText(editorText);
  if (editorText.includes('\r')) throw invalid('FILE_EDITOR_INVALID_EOL', '编辑区的换行必须为 LF。');
  if (ending !== undefined && !Object.hasOwn(endings, ending)) throw invalid('FILE_EDITOR_INVALID_EOL', '请选择 LF、CRLF 或 CR 换行。');
  if (original.ending === 'mixed' && ending === undefined) {
    if (editorText === original.text) return originalContent;
    throw invalid('FILE_EDITOR_EOL_REQUIRED', '原文件使用混合换行；请明确选择保存格式后再审阅修改。');
  }
  const selected = ending ?? (original.ending === 'none' ? 'LF' : original.ending);
  const content = (original.bom ? '\uFEFF' : '') + editorText.replace(/\n/g, endings[selected]);
  validateText(content);
  return content;
}
