// SPDX-License-Identifier: Apache-2.0
// Images stay in page memory until send. No storage or network APIs are used here.
const MAX_IMAGE_BYTES = 768 * 1024, MAX_TOTAL_BYTES = 1024 * 1024, MAX_IMAGES = 4;
const allowed = new Set(['image/png', 'image/jpeg', 'image/webp']);
const node = (tag, className = '', text) => { const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value; };
function metadata(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), ascii = (offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
  let width, height, mimeType;
  if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') {
    mimeType = 'image/png'; width = view.getUint32(16); height = view.getUint32(20);
  } else if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    mimeType = 'image/webp'; const type = ascii(12, 4);
    const uint24 = offset => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    if (type === 'VP8X') { width = uint24(24) + 1; height = uint24(27) + 1; }
    else if (type === 'VP8L' && bytes[20] === 47) { width = (bytes[21] | ((bytes[22] & 63) << 8)) + 1; height = ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 15) << 10)) + 1; }
    else if (type === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) { width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383; }
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mimeType = 'image/jpeg'; let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]; if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset); if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) { height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break; }
      offset += length;
    }
  }
  if (!allowed.has(mimeType) || !width || !height) throw new Error('请选择有效的 PNG、JPEG 或 WebP 图片。');
  if (width > 8192 || height > 8192 || width * height > 16000000) throw new Error('图片尺寸过大：单边最多 8192 像素，总像素最多 1600 万。请先缩小图片。');
  return { mimeType, width, height };
}
function encoded(bytes) { let binary = ''; for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768)); return btoa(binary); }
function source(image) { return `data:${image.mimeType};base64,${image.data}`; }
let previewDialog;
function preview(image, origin) {
  if (!previewDialog) {
    previewDialog = node('dialog', 'image-preview-dialog'); previewDialog.setAttribute('aria-label', '图片预览');
    document.body.append(previewDialog); previewDialog.addEventListener('close', () => { previewDialog.replaceChildren(); });
    window.addEventListener('pagehide', () => previewDialog.close());
  }
  const heading = node('div', 'image-preview-heading'), title = node('strong', '', image.name), close = node('button', 'button secondary', '关闭'); close.type = 'button';
  close.addEventListener('click', () => { previewDialog.close(); if (origin?.isConnected) origin.focus(); }); heading.append(title, close);
  const picture = node('img'); picture.src = source(image); picture.alt = image.name;
  previewDialog.replaceChildren(heading, picture, node('p', 'context-note', `${image.width} × ${image.height} · ${Math.ceil(image.bytes / 1024)} KiB`)); previewDialog.showModal(); close.focus();
}
function imageCard(image, remove) {
  const card = node('figure', 'message-image-card'), open = node('button', 'image-thumbnail-button'); open.type = 'button'; open.setAttribute('aria-label', `预览图片 ${image.name}`);
  const picture = node('img'); picture.src = source(image); picture.alt = image.name; picture.loading = 'lazy'; open.append(picture); open.addEventListener('click', () => preview(image, open));
  const caption = node('figcaption'); caption.append(node('span', '', image.name), node('small', '', `${image.width} × ${image.height} · ${Math.ceil(image.bytes / 1024)} KiB`)); card.append(open, caption);
  if (remove) { const button = node('button', 'image-remove-button', '×'); button.type = 'button'; button.setAttribute('aria-label', `移除图片 ${image.name}`); button.addEventListener('click', remove); card.append(button); }
  return card;
}
export function renderMessageImages(images) {
  const gallery = node('div', 'message-images');
  for (const image of (Array.isArray(images) ? images : []).slice(0, MAX_IMAGES)) {
    if (!allowed.has(image?.mimeType) || typeof image.data !== 'string' || image.data.length > MAX_IMAGE_BYTES * 4 / 3 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) continue;
    gallery.append(imageCard({ ...image, name: typeof image.name === 'string' ? image.name : '图片', bytes: image.bytes || Math.floor(image.data.length * 3 / 4) }));
  }
  return gallery;
}
export function createImageInputUI({ container, list, status, input, button, pasteTarget, dropTarget, onChange }) {
  const slots = new Map(); let key = '', disabled = false, supported = false, providerType = '', signature = '';
  const slot = () => { if (!slots.has(key)) slots.set(key, { images: [], pending: 0, error: '' }); return slots.get(key); };
  function render() {
    const current = slot();
    button.disabled = disabled || !supported; button.title = supported ? '添加图片（PNG、JPEG、WebP）' : '当前工作台不支持图片，请更新后重连';
    const next = JSON.stringify([key, current.images.map(image=>image.id), current.pending, current.error, disabled, supported, providerType]);
    if (signature === next) return; signature = next; list.replaceChildren();
    for (const image of current.images) list.append(imageCard(image, () => { if (disabled) return; current.images = current.images.filter(item => item.id !== image.id); current.error = ''; render(); onChange(); }));
    list.querySelectorAll('.image-remove-button').forEach(node => { node.disabled = disabled; });
    status.textContent = current.error || (current.pending ? '正在本机读取图片…' : current.images.length ? providerType === 'demo' ? '本地演示不能识别图片，请选择支持图片的真实模型。图片仅保存在本页，刷新或关闭会丢失。' : '图片仅保存在本页草稿；刷新或关闭页面会丢失。发送后交给所选模型，请确认该模型支持图片。' : '');
    status.setAttribute('role', current.error ? 'alert' : 'status');
    container.hidden = !current.images.length && !current.error && !current.pending;
  }
  async function add(files) {
    if (!files.length) return;
    const current = slot();
    if (disabled || !supported) { current.error = supported ? '正在发送，请稍后再添加图片。' : '当前工作台不支持图片，未添加附件。'; render(); return; }
    if (current.pending) { current.error = '图片仍在读取，请完成后再添加。'; render(); return; }
    current.pending++; current.error = ''; render(); onChange();
    try {
      if (current.images.length + files.length > MAX_IMAGES) throw new Error('每条消息最多 4 张图片。本批图片未添加，请减少后重试。');
      const total = current.images.reduce((sum, image) => sum + image.bytes, 0) + files.reduce((sum, file) => sum + file.size, 0);
      if (files.some(file => file.size > MAX_IMAGE_BYTES)) throw new Error('单张图片最多 768 KiB。本批图片未添加，请选择更小的图片。');
      if (total > MAX_TOTAL_BYTES) throw new Error('图片合计最多 1 MiB。本批图片未添加，请减少或缩小图片。');
      const additions = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer()), info = metadata(bytes), data = encoded(bytes);
        const image = { ...info, data, bytes: bytes.length, name: file.name?.slice(0,180) || '粘贴的图片', id: crypto.randomUUID() };
        // Decode only after byte and pixel bounds have been checked. This also rejects corrupt files.
        await new Promise((resolve, reject) => { const picture = new Image(), timer = setTimeout(() => { picture.src = ''; reject(new Error('图片读取超时，请重新选择。')); }, 10000); picture.onload = () => { clearTimeout(timer); resolve(); }; picture.onerror = () => { clearTimeout(timer); reject(new Error('图片无法解码。本批图片未添加，请检查文件。')); }; picture.src = source(image); });
        additions.push(image);
      }
      current.images.push(...additions);
    } catch (error) { current.error = error.message || '图片未添加，请重试。'; }
    finally { current.pending--; render(); onChange(); }
  }
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { const files = [...input.files]; input.value = ''; void add(files); });
  pasteTarget.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return; event.preventDefault(); void add(files);
    const text = event.clipboardData?.getData('text/plain');
    if (text) { pasteTarget.setRangeText(text, pasteTarget.selectionStart, pasteTarget.selectionEnd, 'end'); pasteTarget.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  dropTarget.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; } });
  dropTarget.addEventListener('drop', event => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); void add([...event.dataTransfer.files]); });
  return {
    bind(next) { if (next === key) return; key = next; render(); },
    sync({ enabled, busy, providerType: type }) { supported = enabled; disabled = busy; providerType = type; render(); },
    hasImages: () => slot().images.length > 0,
    pending: () => slot().pending > 0,
    hasAny: () => [...slots.values()].some(item => item.images.length || item.pending),
    snapshot: () => ({ key, slot: slot(), images: slot().images.map(image => ({ ...image })) }),
    moveCreated(token, next) { if (token.key !== key || token.slot !== slot()) return; slots.delete(key); slots.set(next, token.slot); key = next; token.key = next; render(); },
    accepted(token) { const ids = new Set(token.images.map(image => image.id)); token.slot.images = token.slot.images.filter(image => !ids.has(image.id)); token.slot.error = ''; render(); onChange(); },
    clear() { slots.clear(); render(); onChange(); }
  };
}
