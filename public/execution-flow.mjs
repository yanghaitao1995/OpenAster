// SPDX-License-Identifier: Apache-2.0
// This view displays recorded actions and public model output, never invented reasoning.
import { renderMarkdown } from './markdown.js';
const node = (tag, className = '', text) => { const value = document.createElement(tag); value.className = className; if (text !== undefined) value.textContent = text; return value; };
const statuses = { running: '进行中', awaiting_approval: '等待批准', completed: '已完成', cancelled: '已停止', failed: '执行失败', denied: '已拒绝' };
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const duration = value => { const seconds = Math.max(0, Math.floor(value / 1000)); return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`; };
const detailText = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
// Only these explicit public fields are presentational. Provider signatures,
// encrypted content and raw reasoning objects must never be inspected here.
export function createModelStepNotes() {
  const root = node('div', 'execution-model-notes'), entries = new Map();
  function paint(entry) {
    if (!entry.disclosure.open || entry.rendered === entry.signature) return;
    entry.rendered = entry.signature; entry.body.replaceChildren(node('p', 'model-note-caption', entry.caption));
    for (const part of entry.parts) {
      if (part.label) entry.body.append(node('p', 'model-note-part-label', part.label));
      entry.body.append(renderMarkdown(part.text));
    }
  }
  function render(step) {
    const notes = [];
    if (step.type === 'model') {
      const interrupted = step.phase === 'retrying' || ['failed', 'cancelled'].includes(step.status);
      if (typeof step.publicReasoning === 'string' && step.publicReasoning) notes.push({ key: 'reasoning', className: 'execution-model-reasoning', label: interrupted ? '模型公开解释 · 未完成' : '模型公开解释', caption: interrupted ? '中断前由服务商返回的可见片段。' : step.status === 'running' ? '服务商返回的可见内容 · 生成中。' : '服务商返回的可见内容。', parts: [{ text: step.publicReasoning }] });
      if (typeof step.publicSummary === 'string' && step.publicSummary) notes.push({ key: 'output', className: 'execution-model-summary', label: step.publicSummaryTruncated ? '模型输出 · 已截取' : '模型输出', caption: step.publicSummaryTruncated ? '此旧记录只保存了部分正文。' : '本轮模型返回的公开正文。', parts: [{ text: step.publicSummary }] });
      if (Array.isArray(step.interruptedOutputs)) for (const [index, output] of step.interruptedOutputs.entries()) {
        if (!Number.isSafeInteger(output?.attempt) || output.attempt < 1) continue;
        const parts = [];
        if (typeof output.publicReasoning === 'string' && output.publicReasoning) parts.push({ label: '模型公开解释 · 未完成', text: output.publicReasoning });
        if (typeof output.content === 'string' && output.content) parts.push({ label: '回答片段 · 未完成', text: output.content });
        if (parts.length) notes.push({ key: `interrupted-${output.attempt}-${index}`, className: 'execution-model-interrupted', label: `第 ${output.attempt} 次连接 · 未完成输出`, caption: '连接中断前保存的片段，未作为完成答复。', parts });
      }
    }
    const keys = new Set();
    notes.forEach((note, index) => {
      keys.add(note.key); let entry = entries.get(note.key);
      if (!entry) {
        const disclosure = node('details', `model-note ${note.className}`), summary = node('summary', 'model-note-heading'), label = node('span'), arrow = node('span', 'model-note-chevron', '⌄'); arrow.setAttribute('aria-hidden', 'true'); summary.append(label, arrow);
        const body = node('div', 'model-note-body'); disclosure.append(summary, body); entry = { disclosure, label, body }; entries.set(note.key, entry);
        disclosure.addEventListener('toggle', () => paint(entry));
      }
      entry.label.textContent = note.label; entry.parts = note.parts; entry.caption = note.caption; entry.signature = JSON.stringify([note.caption, note.parts]); paint(entry);
      if (root.children[index] !== entry.disclosure) root.insertBefore(entry.disclosure, root.children[index] || null);
    });
    for (const [key, entry] of entries) if (!keys.has(key)) { entry.disclosure.remove(); entries.delete(key); }
    root.hidden = !notes.length; return root;
  }
  return { render };
}
export function createExecutionFlow({ onOpenToolResult } = {}) {
  let current = null, interval = null;
  function stepStatus(step, run) {
    if (step.status === 'running' && run.status === 'awaiting_approval' && step.type === 'tool') return '等待你的批准';
    if (step.status === 'running' && step.phase === 'retrying') return '等待重连';
    if (step.status === 'running' && step.type === 'model' && (run.output?.stepId === step.id && run.output?.status === 'streaming' && !run.output?.content && run.output?.publicReasoning)) return '正在思考';
    if (step.status === 'running' && (step.phase === 'streaming' || (run.output?.stepId === step.id && run.output?.status === 'streaming' && run.output?.content))) return '正在生成';
    if (step.status === 'running' && step.type === 'model') return '正在连接模型';
    return statuses[step.status] || step.status || '';
  }
  function updateClocks(force = false) {
    if (!current || (!force && !current.root.isConnected) || document.hidden) return;
    const { run, elapsed, entries } = current, now = Date.now(), start = time(run.startedAt), finish = time(run.finishedAt);
    elapsed.textContent = start === null ? '' : duration((finish ?? now) - start);
    for (const [key, entry] of entries) {
      const step = (run.steps || []).find(item => item.id === key); if (!step) continue;
      const from = time(step.createdAt), to = time(step.finishedAt);
      entry.clock.textContent = from === null ? '' : to !== null ? duration(to - from) : step.status === 'running' ? duration(now - from) : '';
      const retryAt = time(step.connection?.nextRetryAt), retrying = step.status === 'running' && step.phase === 'retrying';
      entry.retry.textContent = retrying ? `第 ${step.connection?.attempt || 1} 次连接未成功 · ${retryAt === null ? '正在准备重连' : `${Math.max(0, Math.ceil((retryAt - now) / 1000))} 秒后重连`}` : '';
    }
  }
  function render(run, { key, providerName = '' } = {}) {
    if (!run) { clearInterval(interval); interval = null; current = null; return null; }
    if (current?.key !== key) {
      const root = node('details', 'execution-flow'); root.open = true; root.setAttribute('aria-label', '本次任务的执行过程');
      const heading = node('summary', 'execution-flow-heading'), mark = node('span', 'execution-flow-mark'); mark.setAttribute('aria-hidden', 'true');
      const title = node('span', 'execution-flow-title'), elapsed = node('span', 'execution-flow-elapsed'); elapsed.setAttribute('aria-hidden', 'true');
      const chevron = node('span', 'execution-flow-chevron', '⌄'); chevron.setAttribute('aria-hidden', 'true');
      heading.append(mark, title, elapsed, chevron);
      const body = node('div', 'execution-flow-body'), meta = node('p', 'execution-flow-meta'), list = node('ol', 'execution-flow-list');
      const status = node('p', 'execution-flow-current'); status.setAttribute('role', 'status');
      body.append(meta, list, status); root.append(heading, body);
      current = { key, root, title, elapsed, meta, list, status, entries: new Map(), run };
    }
    current.run = run; current.root.dataset.status = run.status;
    const steps = Array.isArray(run.steps) ? run.steps : [], active = [...steps].reverse().find(step => step.status === 'running');
    const modelCount = steps.filter(step => step.type === 'model').length, toolCount = steps.filter(step => step.type === 'tool').length;
    current.title.textContent = run.status === 'running' ? active?.phase === 'retrying' ? '模型连接中断，正在重试' : active?.type === 'model' ? '正在思考' : active?.title || '正在准备任务' : statuses[run.status] || '执行过程';
    current.meta.textContent = [providerName, modelCount ? `${modelCount} 轮模型处理` : '', toolCount ? `${toolCount} 次工具调用` : ''].filter(Boolean).join(' · ');
    current.status.textContent = run.status === 'awaiting_approval' ? '核对下方操作内容，批准后继续。' : active?.phase === 'retrying' ? detailText(active.connection?.lastError?.message) || '模型服务暂时不可用，可随时停止任务。' : '';
    current.status.hidden = !current.status.textContent;
    const keys = new Set();
    steps.forEach((step, index) => {
      const stepKey = step.id || `legacy-${index}`; keys.add(stepKey); let entry = current.entries.get(stepKey);
      if (!entry) {
        const row = node('li', 'execution-step'), disclosure = node('details'), summary = node('summary');
        const mark = node('span', 'execution-step-mark'); mark.setAttribute('aria-hidden', 'true');
        const copy = node('span', 'execution-step-copy'), title = node('strong'), preview = node('small'); copy.append(title, preview);
        const status = node('span', 'execution-step-state'), clock = node('span', 'execution-step-clock'); clock.setAttribute('aria-hidden', 'true');
        summary.append(mark, copy, status, clock);
        const detail = node('pre', 'execution-step-detail'); detail.tabIndex = 0; detail.setAttribute('role', 'region'); detail.setAttribute('aria-label', '步骤详情');
        const retry = node('p', 'execution-step-retry'); retry.setAttribute('aria-live', 'off');
        const notes = createModelStepNotes(), toolResult = node('button', 'execution-tool-result', '查看完整工具结果'); toolResult.type = 'button'; toolResult.hidden = true;
        disclosure.append(summary, detail); row.append(disclosure, notes.render(step), toolResult, retry); entry = { row, title, preview, status, clock, detail, retry, mark, notes, toolResult }; current.entries.set(stepKey, entry);
        toolResult.addEventListener('click', () => { const latest = current?.run?.steps?.find(item => item.id === stepKey); if (latest?.toolResultRef) onOpenToolResult?.(latest, current.run); });
      }
      const text = detailText(step.detail); entry.row.dataset.stepId = stepKey; entry.row.dataset.status = step.status;
      entry.title.textContent = step.title || (step.type === 'tool' ? '工具操作' : '模型处理');
      entry.mark.textContent = step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.type === 'tool' ? '›_' : '·';
      entry.preview.textContent = text.split('\n')[0].slice(0,160); entry.preview.hidden = !text;
      entry.status.textContent = stepStatus(step, run);
      const artifact = step.toolResultRef;
      entry.detail.textContent = [text || '此步骤没有附加说明。', artifact ? `结果已保存：${artifact.name}${artifact.path ? ` · ${artifact.path}` : ''} · ${artifact.bytes} 字节。完整原记录可在任务详情中展开查看。` : '', step.connection?.attempt ? `连接次数：${step.connection.attempt}${step.connection.retryCount ? ` · 已重试 ${step.connection.retryCount} 次。重试连接的用量可能未回报，以服务商账单为准。` : ''}` : ''].filter(Boolean).join('\n\n');
      entry.notes.render(step); entry.toolResult.hidden = !(step.type === 'tool' && artifact && onOpenToolResult);
      if (current.list.children[index] !== entry.row) current.list.insertBefore(entry.row, current.list.children[index] || null);
    });
    for (const [id, entry] of current.entries) if (!keys.has(id)) { entry.row.remove(); current.entries.delete(id); }
    if (['running', 'awaiting_approval'].includes(run.status)) { if (!interval) interval = setInterval(updateClocks, 1000); }
    else { clearInterval(interval); interval = null; }
    updateClocks(true); return current.root;
  }
  window.addEventListener('pagehide', () => { clearInterval(interval); interval = null; });
  return { render };
}
