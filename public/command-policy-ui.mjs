// SPDX-License-Identifier: Apache-2.0
// Task-scoped permission UI. Only explicit user actions can change policy.
const modes = {
  smart: { label: '智能审批', description: '固定只读命令直接执行，其他命令逐次询问。' },
  ask: { label: '每次询问', description: '每条命令执行前都需你确认。' },
  trusted: { label: '本轮授权', description: '允许限定的简单开发命令继续执行；危险、复杂或范围外命令仍需单独批准。' },
};
const risk = '命令以当前系统账户运行，可能修改文件、启动程序或联网；工作目录不是操作系统沙箱。授权只对当前任务的本轮执行有效；空闲时授权用于下一轮，执行结束或服务重启后恢复智能审批。撤销只阻止后续未开始的命令，不会停止已启动命令或回滚已有操作。';
const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
function validPolicy(value, sessionId) {
  if (!value || value.sessionId !== sessionId || !Object.hasOwn(modes, value.mode) || value.lifetime !== 'task-run' || value.sandbox !== false || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.pending)) throw new Error('命令策略返回不完整，请重新读取后操作。');
  for (const item of value.pending) if (typeof item?.approvalId !== 'string' || typeof item.sessionEligible !== 'boolean' || typeof item.reason !== 'string') throw new Error('命令授权范围返回不完整，未启用批量授权。');
  return value;
}

export function createCommandPolicyUI({ context, request, openDialog, onUpdate = () => {}, onChanged = async () => {} }) {
  let key = '', policy = null, controller = null, requestId = 0, loading = false, changing = false, again = false, error = '';
  const views = [];
  function createView(settings) {
    const root = node('section', settings ? 'settings-section command-policy-settings' : 'command-policy-panel');
    root.setAttribute('aria-label', settings ? '当前任务命令权限' : '命令权限');
    const heading = node(settings ? 'h2' : 'h3', '', '命令权限');
    const identity = node('p', 'context-note command-policy-task');
    const label = node('strong', 'command-policy-current'), description = node('p', 'context-note command-policy-description');
    const controls = node('div', 'command-policy-actions'), change = node('button', 'text-button', '更改命令策略…'), revoke = node('button', 'text-button', '撤销本轮授权'), retry = node('button', 'text-button', '重新读取策略');
    for (const button of [change, revoke, retry]) button.type = 'button';
    change.addEventListener('click', edit); revoke.addEventListener('click', () => { void update({ mode: 'smart' }, key).catch(cause => { error = cause.message; paint(); }); });
    retry.addEventListener('click', () => sync({ refresh: true }));
    controls.append(change, revoke, retry);
    const status = node('p', 'context-note command-policy-status'); status.setAttribute('role', 'status');
    root.append(heading, identity, label, description, controls, status);
    views.push({ root, identity, label, description, change, revoke, retry, status, settings });
    return root;
  }
  const taskNode = createView(false), settingsNode = createView(true);
  const current = token => { const value = context(); return token === value.key && value.available && value.sessionId && value.toolsAvailable; };
  function paint() {
    const value = context(), supported = value.supported;
    for (const view of views) {
      view.root.hidden = !supported;
      view.identity.textContent = view.settings && value.sessionId ? `当前任务：${value.title || '未命名任务'}` : '';
      view.identity.hidden = !view.identity.textContent;
      view.label.textContent = policy && key === value.key ? modes[policy.mode].label : value.sessionId ? '策略尚未确认' : '尚未选择任务';
      view.description.textContent = !value.sessionId ? '先打开一个任务，再为该任务设置命令策略。授权不会应用到其他任务。' : !value.toolsAvailable ? '当前连接为仅对话模式，不执行命令。' : policy && key === value.key ? modes[policy.mode].description + (policy.mode === 'trusted' ? ' 本轮结束后自动恢复智能审批。' : '') : '策略确认前不会授予本轮命令授权。';
      view.change.disabled = !current(key) || !policy || loading || changing;
      view.revoke.hidden = policy?.mode !== 'trusted' || key !== value.key;
      view.revoke.disabled = !current(key) || changing;
      view.retry.hidden = !error; view.retry.disabled = !current(key) || loading || changing;
      view.status.textContent = error || (changing ? '正在保存命令策略…' : loading ? '正在读取命令策略…' : !value.available && supported ? '连接就绪后可查看和调整策略。' : '');
      view.status.hidden = !view.status.textContent;
    }
  }
  function accept(value, token) {
    if (!current(token)) return false;
    const checked = validPolicy(value, context().sessionId);
    if (policy && checked.revision < policy.revision) return false;
    const changed = JSON.stringify(policy) !== JSON.stringify(checked); policy = checked; error = ''; paint();
    if (changed) onUpdate(); return true;
  }
  async function read() {
    if (loading || changing) { again = true; return; }
    const value = context(), token = key;
    if (!current(token)) return;
    loading = true; controller = new AbortController(); const signal = controller.signal, sequence = ++requestId; paint();
    try {
      const result = await request(`/api/sessions/${encodeURIComponent(value.sessionId)}/command-policy`, { signal });
      if (sequence === requestId && !signal.aborted) accept(result, token);
    } catch (cause) {
      if (sequence === requestId && current(token) && !signal.aborted) { policy = null; error = cause.message || '无法读取命令策略。'; onUpdate(); }
    } finally {
      if (sequence === requestId) { loading = false; controller = null; paint(); if (again) { again = false; void read(); } }
    }
  }
  function sync({ refresh = false } = {}) {
    const value = context();
    if (key !== value.key || !value.available) {
      controller?.abort(); ++requestId; controller = null; key = value.key; policy = null; loading = false; changing = false; again = false; error = ''; onUpdate();
    }
    paint();
    if (current(key) && value.visible && (refresh || !policy) && !error && (!loading || refresh)) void read();
    else if (refresh && error && current(key)) { error = ''; void read(); }
  }
  async function update(body, token) {
    if (!current(token) || changing) throw new Error('任务或连接已变化，请重新打开命令策略后操作。');
    controller?.abort(); ++requestId; controller = null; loading = false; changing = true; again = false; error = ''; paint();
    try {
      const result = await request(`/api/sessions/${encodeURIComponent(context().sessionId)}/command-policy`, { method: 'PUT', body });
      if (!current(token)) return;
      accept(result, token); await onChanged();
    } catch (cause) {
      if (current(token)) { policy = null; error = '无法确认策略是否已保存，请重新读取后核对；不会自动重试授权。'; onUpdate(); }
      throw cause;
    } finally { if (token === key) { changing = false; paint(); if (again) { again = false; void read(); } } }
  }
  function confirmation() {
    const label = node('label', 'check-field command-policy-risk');
    const input = node('input'); input.type = 'checkbox'; input.required = true;
    label.append(input, node('span', '', '我理解命令会使用当前系统账户权限，并授权此任务本轮的限定开发命令。'));
    return { label, input };
  }
  function edit() {
    const value = context(), token = key;
    if (!current(token) || !policy) return;
    const body = node('div', 'command-policy-editor'), choices = node('fieldset', 'command-policy-options');
    choices.append(node('legend', '', '选择此任务的命令策略'));
    let selected = policy.mode;
    const confirm = confirmation();
    const refresh = () => { confirm.label.hidden = selected !== 'trusted'; confirm.input.required = selected === 'trusted'; if (selected !== 'trusted') confirm.input.checked = false; };
    for (const [mode, option] of Object.entries(modes)) {
      const label = node('label', 'command-policy-option'), input = node('input'); input.type = 'radio'; input.name = 'command-policy'; input.value = mode; input.checked = selected === mode;
      const copy = node('span'); copy.append(node('strong', '', option.label), node('small', '', option.description)); label.append(input, copy); choices.append(label);
      input.addEventListener('change', () => { if (input.checked) { selected = mode; refresh(); } });
    }
    body.append(node('p', 'dialog-description', `仅针对任务「${value.title || '未命名任务'}」。`), choices, node('p', 'dialog-description', risk), confirm.label); refresh();
    openDialog('命令执行策略', body, '保存策略', async () => {
      if (selected === 'trusted' && !confirm.input.checked) throw new Error('请先阅读并确认本轮授权的风险。');
      await update({ mode: selected, ...(selected === 'trusted' ? { confirmRisk: true } : {}) }, token);
    });
  }
  function pendingEligibility(approvalId) { return current(key) && policy ? policy.pending.find(item => item.approvalId === approvalId) ?? null : null; }
  function approveForRun(approvalId, handler) {
    const token = key;
    if (pendingEligibility(approvalId)?.sessionEligible !== true) throw new Error('此命令不支持本轮授权，请逐次核对批准。');
    const confirm = confirmation(), body = node('div');
    body.append(node('p', 'dialog-description', '批准当前命令，并为当前任务本轮的限定开发命令授予权限。危险、复杂或范围外命令仍需单独批准。'), node('p', 'dialog-description', risk), confirm.label);
    openDialog('批准并授权本轮', body, '确认批准并授权本轮', async () => {
      if (!current(token) || pendingEligibility(approvalId)?.sessionEligible !== true) throw new Error('任务或审批范围已变化，请关闭窗口并重新核对。');
      if (!confirm.input.checked) throw new Error('请先确认本轮授权的风险。');
      await handler(); sync({ refresh: true });
    });
  }
  return { taskNode, settingsNode, sync, pendingEligibility, approveForRun, signature: () => JSON.stringify([key, policy?.revision, policy?.pending]) };
}
