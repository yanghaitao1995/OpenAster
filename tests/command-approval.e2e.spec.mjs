import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';
import { readUtf8Body } from './helpers/http-body.mjs';

const shell = process.platform === 'win32' ? 'powershell' : 'sh';
const commandFor = filename => process.platform === 'win32'
  ? `[IO.File]::WriteAllText((Join-Path (Get-Location) '${filename}'), 'approved-by-user', [Text.UTF8Encoding]::new($false)); [Console]::WriteLine('owned-command-complete')`
  : `printf '%s' 'approved-by-user' > '${filename}'; printf '%s\\n' 'owned-command-complete'`;
const cwd = 'owned-space', timeoutMs = 15000;
// Approved-command outcomes include 15 s execution, 2 s supervisor cleanup,
// and 3 s state propagation; ordinary UI and denial waits keep their defaults.
const commandOutcomeWaitMs = 20000;
const failedCommand = process.platform === 'win32'
  ? '[Console]::Out.WriteLine("owned-failure-output"); [Console]::Error.WriteLine("owned-failure-detail"); exit 9'
  : 'printf "owned-failure-output\\n"; printf "owned-failure-detail\\n" >&2; exit 9';
const controlPoints = [0x200b, 0x202e, 0x202c, 0x2066, 0x2069, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x1b, 0x7f, 0x85, 0x9b, 0x0d, 0xfeff, 0xe0001];
const controlMarker = point => '⟦U+' + point.toString(16).toUpperCase().padStart(4, '0') + '⟧';
const controlPrefix = '中文-é-🙂-العربية-עברית|', controlSuffix = '|字面标记:⟦U+200B⟧';
const controlPayload = controlPrefix + controlPoints.map(point => String.fromCodePoint(point)).join('|') + controlSuffix;
const controlsCwd = 'owned-\u200b-\u202e-space-\u202c';
function controlsCommand() {
  const code = process.platform === 'win32'
    ? `[IO.File]::WriteAllText((Join-Path (Get-Location) 'controls-marker.txt'), '${controlPayload}', [Text.UTF8Encoding]::new($false));\n\t[Console]::WriteLine('owned-controls-complete')`
    : `printf '%s' '${controlPayload}' > 'controls-marker.txt';\n\tprintf '%s\\n' 'owned-controls-complete'`;
  const prefix = code + '\n# 普通中文代码与 tab\t、CRLF\r\n#';
  return prefix + 'p'.repeat(8000 - prefix.length);
}

// The model is an owned loopback HTTP fixture, without credentials. Approved
// shell code only creates a fixed marker in this fixture's temporary workspace.
// Execution, persistence, approval UI and original-result reading are real.
const test = base.extend({ local: async ({ page }, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results', 'command-approval-ui-'));
  const dataDir = join(root, 'data'), workspace = join(dataDir, 'workspace');
  await mkdir(join(workspace, cwd), { recursive: true });
  await mkdir(join(workspace, controlsCwd), { recursive: true });
  const calls = [];
  const provider = createServer(async (req, res) => {
    const body = JSON.parse(await readUtf8Body(req)); calls.push(body);
    const tools = body.messages.filter(message => message.role === 'tool');
    const request = JSON.stringify(body.messages.filter(message => message.role === 'user'));
    const denied = request.includes('拒绝验证'), controls = request.includes('控制字符验证'), recovery = request.includes('失败后分析验证');
    const command = controls ? controlsCommand() : commandFor(denied ? 'denied-marker.txt' : 'approved-marker.txt');
    let message = tools.length
      ? { role: 'assistant', content: denied ? '命令已被拒绝，未执行。' : '已取得命令结果，请核对原始记录。' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'owned-command-' + (controls ? 'controls' : denied ? 'denied' : 'approved'), type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command, cwd: controls ? controlsCwd : cwd, timeoutMs }) } }] };
    if (recovery) {
      message = tools.length === 2
        ? { role: 'assistant', content: '已分析退出码 9 和错误输出；后续命令被拒绝，未执行。' }
        : { role: 'assistant', content: tools.length ? '命令以退出码 9 结束，需要单独审核后续命令。' : null,
          tool_calls: [{ id: tools.length ? 'owned-command-replanned' : 'owned-command-failed', type: 'function',
            function: { name: 'run_command', arguments: JSON.stringify({ command: tools.length ? commandFor('replanned-marker.txt') : failedCommand, cwd, timeoutMs }) } }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }));
  });
  await new Promise(done => provider.listen(0, '127.0.0.1', done));
  let app;
  try {
    const store = new Store(dataDir), providerId = randomUUID();
    let approved, denied, controls, recovery;
    try {
      store.putProvider({ id: providerId, name: '本机命令审批测试', type: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'owned-command-fixture', enabled: true, streaming: false, toolMode: 'workspace', maxTokens: 512, tokenParameter: 'max_completion_tokens' });
      approved = store.createSession({ title: '批准一条测试命令', providerId });
      denied = store.createSession({ title: '拒绝另一条测试命令', providerId });
      controls = store.createSession({ title: '显示命令控制字符', providerId });
      recovery = store.createSession({ title: '命令失败后继续分析', providerId });
    } finally { store.close(); }
    app = await startServer({ dataDir });
    await use({ app, workspace, calls, approved, denied, controls, recovery, providerId,
      async read(id) { const response = await page.request.get(new URL(`/api/sessions/${id}`, app.url).href); expect(response.ok()).toBe(true); return (await response.json()).session; },
    });
  } finally {
    try { await app?.close(); }
    finally { provider.closeAllConnections(); await new Promise(done => provider.close(done)); }
  }
} });
test.use({ serviceWorkers: 'block' });

async function ready(page, local) {
  // Drain the initial SSE state refresh before selecting a task: it may otherwise
  // invalidate that task's full history between the ready check and Send.
  const initialState = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/state');
  await page.goto(local.app.url); await (await initialState).finished();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
}
async function propose(page, local, session, text) {
  await page.locator(`.session-link[data-id="${session.id}"]`).click();
  await expect(page.locator('#chat-title')).toHaveText(session.title);
  await expect(page.locator('#messages .empty-state')).toHaveAttribute('data-history-state', 'true');
  await page.locator('#model-select').selectOption(local.providerId);
  await page.locator('#prompt-input').fill(text);
  await page.locator('#send-button').click();
  await expect(page.locator('#approval-list .command-approval')).toHaveCount(1);
  await expect(page.locator('#chat-meta')).toContainText('等待你的批准');
  return page.locator('#approval-list .command-approval');
}

test('Command approval: exact proposal stays inert until approval, persists start and original result, and a separate denial never executes', async ({ page, local }, info) => {
  await ready(page, local);
  const card = await propose(page, local, local.approved, '批准验证：在自有临时目录写入测试标记。');
  const exactCommand = commandFor('approved-marker.txt');
  expect(await card.locator('.approval-command').textContent()).toBe(exactCommand);
  await expect(card).toContainText(shell === 'powershell' ? 'PowerShell' : 'POSIX sh');
  await expect(card).toContainText('工作目录：' + cwd); await expect(card).toContainText('最长 15 秒');
  await expect(card).toContainText('本机当前用户权限'); await expect(card).toContainText('不是安全沙箱');
  await expect(access(join(local.workspace, cwd, 'approved-marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  let persisted = await local.read(local.approved.id);
  expect(persisted.approvals.at(-1)).toMatchObject({ tool: 'run_command', status: 'pending', command: { command: exactCommand, shell, cwd, timeoutMs } });
  expect(persisted.approvals.at(-1).startedAt).toBeUndefined(); expect(local.calls).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('command-approval-desktop.png'), animations: 'disabled' });
  await card.getByRole('button', { name: '批准这次命令', exact: true }).click();
  await expect(page.locator('#chat-meta')).toContainText('已完成', { timeout: commandOutcomeWaitMs });
  expect(await readFile(join(local.workspace, cwd, 'approved-marker.txt'), 'utf8')).toBe('approved-by-user');
  persisted = await local.read(local.approved.id);
  const approval = persisted.approvals.at(-1);
  expect(approval.status).toBe('approved'); expect(new Date(approval.startedAt).toISOString()).toBe(approval.startedAt);
  const tool = persisted.run.steps.find(step => step.toolResultRef?.name === 'run_command');
  expect(tool.status).toBe('completed'); expect(local.calls).toHaveLength(2);
  if (await page.locator('#context-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#context-toggle').click();
  const original = page.locator(`#run-panel .timeline>li>.step-context-extra>.tool-artifact-view[data-artifact-id="${tool.toolResultRef.artifactId}"]`);
  await original.locator(':scope>summary').click();
  await expect(original.locator('pre')).toContainText('owned-command-complete');
  const record = JSON.parse(await original.locator('pre').textContent());
  expect(record.result).toMatchObject({ shell, cwd, exitCode: 0, timedOut: false, cancelled: false });
  expect(record.result.stdout).toContain('owned-command-complete');
  await page.reload(); await expect(page.locator('#chat-title')).toHaveText(local.approved.title);
  await page.locator('.approval-history>summary').click();
  await expect(page.locator('.approval-history')).toContainText('已记录进程启动');
  expect((await local.read(local.approved.id)).approvals.at(-1)).toEqual(approval);
  const refused = await propose(page, local, local.denied, '拒绝验证：这次不能写入测试标记。');
  await expect(access(join(local.workspace, cwd, 'denied-marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await refused.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.locator('#chat-meta')).toContainText('已完成');
  await expect(page.locator('#messages')).toContainText('命令已被拒绝，未执行。');
  const rejection = (await local.read(local.denied.id)).approvals.at(-1);
  expect(rejection.status).toBe('denied'); expect(rejection.startedAt).toBeUndefined();
  await expect(access(join(local.workspace, cwd, 'denied-marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(local.calls).toHaveLength(4);
});

test('Workspace path: the production workspace header exposes and copies the complete owned directory', async ({ page, local }) => {
  await ready(page, local); await page.locator('.nav-item[data-action="workspace"]').click();
  const path = page.locator('#workspace-full-path');
  await expect(path).toHaveText(local.workspace); await expect(path).toBeVisible();
  await path.focus(); await expect(path).toBeFocused();
  expect(await path.evaluate(node => getComputedStyle(node).userSelect)).toBe('text');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: local.app.url });
  await page.getByRole('button', { name: '复制路径：工作区完整路径', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(local.workspace);
  await expect(page.locator('#toast-region')).toContainText('工作空间完整路径已复制');
  expect(local.calls).toEqual([]);
});

test('Command approval: a failed tool step preserves output while analysis continues and the next command waits for a new approval', async ({ page, local }, info) => {
  await ready(page, local);
  const card = await propose(page, local, local.recovery, '失败后分析验证：核对非零退出结果，再单独审核后续命令。');
  expect(await card.locator('.approval-command').textContent()).toBe(failedCommand);
  const first = (await local.read(local.recovery.id)).approvals.at(-1);
  await card.getByRole('button', { name: '批准这次命令', exact: true }).click();
  await expect(card.locator('.approval-command')).toHaveText(commandFor('replanned-marker.txt'), { timeout: commandOutcomeWaitMs });
  await expect(page.locator('#chat-meta')).toContainText('等待你的批准');
  let persisted = await local.read(local.recovery.id);
  expect(persisted.run.status).toBe('awaiting_approval'); expect(local.calls).toHaveLength(2);
  expect(persisted.approvals).toHaveLength(2);
  expect(persisted.approvals[0]).toMatchObject({ id: first.id, status: 'approved' });
  expect(persisted.approvals[0].startedAt).toBeTruthy();
  const second = persisted.approvals.at(-1);
  expect(second.id).not.toBe(first.id); expect(second.status).toBe('pending'); expect(second.startedAt).toBeUndefined();
  await expect(access(join(local.workspace, cwd, 'replanned-marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  const received = JSON.parse(local.calls[1].messages.find(message => message.role === 'tool').content);
  expect(received.untrusted_data).toBe(true); expect(received.error.code).toBe('COMMAND_FAILED');
  expect(received.error.result).toMatchObject({ shell, cwd, exitCode: 9, signal: null, timedOut: false, cancelled: false });
  expect(received.error.result.stdout).toContain('owned-failure-output'); expect(received.error.result.stderr).toContain('owned-failure-detail');
  const failed = persisted.run.steps.find(step => step.toolResultRef?.name === 'run_command');
  expect(failed.status).toBe('failed'); expect(failed.toolResultRef.isError).toBe(true);
  await expect(page.locator(`#run-panel .timeline>li[data-step-id="${failed.id}"]`)).toHaveClass('failed');
  await expect(page.locator(`#run-panel .timeline>li[data-step-id="${failed.id}"] .run-step-status`)).toHaveText('执行失败');
  if (await page.locator('#context-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#context-toggle').click();
  const original = page.locator(`#run-panel .timeline>li>.step-context-extra>.tool-artifact-view[data-artifact-id="${failed.toolResultRef.artifactId}"]`);
  await original.locator(':scope>summary').click();
  await expect(original.locator('pre')).toContainText('owned-failure-detail');
  expect(JSON.parse(await original.locator('pre').textContent())).toEqual(received);
  await page.screenshot({ path: info.outputPath('command-failure-fresh-approval-desktop.png'), animations: 'disabled' });
  await card.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.locator('#chat-meta')).toContainText('已完成');
  await expect(page.locator('#messages')).toContainText('已分析退出码 9 和错误输出；后续命令被拒绝，未执行。');
  persisted = await local.read(local.recovery.id);
  expect(persisted.run.status).toBe('completed'); expect(persisted.run.error).toBeNull(); expect(local.calls).toHaveLength(3);
  expect(persisted.run.steps.find(step => step.id === failed.id).status).toBe('failed');
  expect(persisted.approvals.at(-1)).toMatchObject({ id: second.id, status: 'denied' });
  expect(persisted.approvals.at(-1).startedAt).toBeUndefined();
  await expect(access(join(local.workspace, cwd, 'replanned-marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('Command approval: control characters are visible in command and cwd previews while exact approved bytes execute and survive history', async ({ page, local }, info) => {
  await ready(page, local);
  const card = await propose(page, local, local.controls, '控制字符验证：只在自有临时目录写入原始测试字符串。');
  const exactCommand = controlsCommand(), displayedPayload = controlPrefix + controlPoints.map(controlMarker).join('|') + controlSuffix;
  const displayedCommand = exactCommand.replace(controlPayload, displayedPayload);
  const displayedCwd = 'owned-⟦U+200B⟧-⟦U+202E⟧-space-⟦U+202C⟧';
  expect(exactCommand).toHaveLength(8000);
  const preview = card.locator('.approval-command');
  expect(await preview.textContent()).toBe(displayedCommand);
  await expect(preview.locator('.command-control')).toHaveText(controlPoints.map(controlMarker));
  await expect(card.locator('.command-cwd')).toHaveText(displayedCwd);
  await expect(card.locator('.command-cwd .command-control')).toHaveText(['⟦U+200B⟧', '⟦U+202E⟧', '⟦U+202C⟧']);
  await expect(card.locator('.command-control-note')).toContainText('20 个控制或不可见格式字符（命令 17 个，工作目录 3 个）');
  await expect(card.locator('.command-control-note')).toContainText('带边框的 U+XXXX 标记');
  // The matching literal token remains plain text; only the actual code point gets a badge.
  expect((await preview.textContent()).split('⟦U+200B⟧')).toHaveLength(3);
  await expect(preview.locator('.command-control').filter({ hasText: 'U+200B' })).toHaveCount(1);
  const marker = preview.locator('.command-control').first();
  await expect(marker).toHaveAttribute('title', '原文实际包含字符 U+200B');
  expect(await marker.evaluate(node => getComputedStyle(node).borderTopStyle)).toBe('solid');
  // Paired CRLF, LF and tabs keep their original layout; no other raw controls enter the preview DOM.
  expect(await card.textContent()).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\r(?!\n)|\p{Cf}/u);
  await expect(card.getByRole('button', { name: '批准这次命令', exact: true })).toBeEnabled();
  await expect(access(join(local.workspace, controlsCwd, 'controls-marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  let persisted = await local.read(local.controls.id);
  expect(persisted.approvals.at(-1)).toMatchObject({ status: 'pending', command: { command: exactCommand, cwd: controlsCwd, shell, timeoutMs } });
  expect(local.calls).toHaveLength(1);
  const accessibility = await new AxeBuilder({ page }).include('#approval-list .command-approval').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(accessibility.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
  await page.screenshot({ path: info.outputPath('command-control-characters-desktop.png'), animations: 'disabled' });
  await card.getByRole('button', { name: '批准这次命令', exact: true }).click();
  await expect(page.locator('#chat-meta')).toContainText('已完成', { timeout: commandOutcomeWaitMs });
  expect(await readFile(join(local.workspace, controlsCwd, 'controls-marker.txt'))).toEqual(Buffer.from(controlPayload, 'utf8'));
  persisted = await local.read(local.controls.id);
  const approval = persisted.approvals.at(-1);
  expect(approval).toMatchObject({ status: 'approved', command: { command: exactCommand, cwd: controlsCwd, shell, timeoutMs } });
  expect(new Date(approval.startedAt).toISOString()).toBe(approval.startedAt);
  const tool = persisted.run.steps.find(step => step.toolResultRef?.name === 'run_command');
  expect(tool.status).toBe('completed'); expect(local.calls).toHaveLength(2);
  if (await page.locator('#context-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#context-toggle').click();
  const original = page.locator(`#run-panel .timeline>li>.step-context-extra>.tool-artifact-view[data-artifact-id="${tool.toolResultRef.artifactId}"]`);
  await original.locator(':scope>summary').click();
  await expect(original.locator('pre')).toContainText('owned-controls-complete');
  const result = JSON.parse(await original.locator('pre').textContent());
  expect(result.result).toMatchObject({ cwd: controlsCwd, shell, exitCode: 0, timedOut: false, cancelled: false });
  await page.reload(); await expect(page.locator('#chat-title')).toHaveText(local.controls.title);
  await page.locator('.approval-history>summary').click();
  await page.locator('.approval-history').getByText('查看当时的命令', { exact: true }).click();
  const history = page.locator('.approval-history');
  expect(await history.locator('.approval-command').textContent()).toBe(displayedCommand);
  await expect(history.locator('.command-control')).toHaveCount(20);
  await expect(history.locator('.command-cwd')).toHaveText(displayedCwd);
  expect((await local.read(local.controls.id)).approvals.at(-1)).toEqual(approval);
  if (await page.locator('#context-toggle').getAttribute('aria-expanded') !== 'true') await page.locator('#context-toggle').click();
  await page.locator('#run-history>summary').click();
  const entry = page.locator(`#run-history-list>.run-history-entry[data-run-id="${persisted.run.id}"]`);
  await entry.locator(':scope>summary').click();
  await expect(entry.locator('.history-approval .command-cwd')).toHaveText(displayedCwd);
  await expect(entry.locator('.history-approval .command-control')).toHaveCount(3);
  await expect(entry.locator('.history-approval .artifact-hash')).toHaveText('命令 SHA-256：' + createHash('sha256').update(exactCommand, 'utf8').digest('hex'));
  expect(local.calls).toHaveLength(2);
});
