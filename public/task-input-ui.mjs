// SPDX-License-Identifier: Apache-2.0
// Presentation only: acceptance and consumption remain server-authoritative.
import { renderMarkdown } from './markdown.js';
const node = (tag, className, text) => { const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value; };
export function createTaskInputUI({ input, onInterrupt }) {
  const root = node('div', 'composer-running-controls'), note = node('p', 'composer-running-note');
  const interrupt = node('button', 'text-button composer-interrupt', '打断并发送'); interrupt.type = 'button'; interrupt.id = 'interrupt-send-button';
  interrupt.title = '请求停止当前步骤，再处理这条消息；已完成的操作不会回滚。';
  interrupt.addEventListener('click', () => { if (!interrupt.disabled && !root.hidden) onInterrupt(); });
  root.append(note, interrupt); root.hidden = true; input.after(root);
  return {
    sync({ busy, supported, disabled, awaitingApproval = false, switchingInput = false }) {
      root.hidden = !busy;
      note.textContent = switchingInput ? '正在切换到已接收的补充内容，新的草稿会保留。' : !supported ? '此工作台暂不支持运行中补充，草稿会保留到任务结束。' : awaitingApproval ? '发送补充会取消当前待审批操作，再处理新内容。' : '补充内容将在下一个安全节点处理。';
      interrupt.hidden = !supported || switchingInput; interrupt.disabled = disabled || !supported;
    }
  };
}

export function createQueuedInputView({ renderImages }) {
  const root = node('section', 'queued-inputs'); root.setAttribute('aria-label', '尚未处理的补充消息');
  let key = ''; const entries = new Map();
  return {
    render(session) {
      if (key !== session.id) { key = session.id; entries.clear(); root.replaceChildren(); }
      const inputs = (Array.isArray(session.queuedInputs) ? session.queuedInputs : []).filter(item => ['pending', 'failed'].includes(item?.status));
      const keep = new Set();
      for (const [index, item] of inputs.entries()) {
        if (typeof item.requestId !== 'string' || typeof item.content !== 'string') continue;
        keep.add(item.requestId); const signature = JSON.stringify([item.content, item.images, item.files, item.mode, item.status, item.error]); let entry = entries.get(item.requestId);
        if (!entry || entry.signature !== signature) {
          const article = node('article', 'queued-input'); article.dataset.requestId = item.requestId; article.dataset.status = item.status;
          const label = node('p', 'queued-input-state', item.status === 'failed' ? '补充消息 · 未处理' : item.mode === 'interrupt' ? '补充消息 · 已排队，等待当前步骤停止' : '补充消息 · 已排队，等待安全节点'); label.setAttribute('role', 'status');
          article.append(label); if (item.content) article.append(renderMarkdown(item.content)); if (Array.isArray(item.images) && item.images.length) article.append(renderImages(item.images));
          const files = (Array.isArray(item.files) ? item.files : []).map(file => file?.path).filter(path => typeof path === 'string'); if (files.length) article.append(node('p', 'queued-input-files', '附加文件：' + files.join('、')));
          if (item.status === 'failed') article.append(node('p', 'queued-input-error', (typeof item.error?.message === 'string' ? item.error.message + ' ' : '') + '内容已保留，不会自动重发。'));
          if (entry) entry.node.replaceWith(article); entry = { node: article, signature }; entries.set(item.requestId, entry);
        }
        if (root.children[index] !== entry.node) root.insertBefore(entry.node, root.children[index] || null);
      }
      for (const [id, entry] of entries) if (!keep.has(id)) { entry.node.remove(); entries.delete(id); }
      root.hidden = !entries.size; return root;
    }
  };
}
