import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const fenced = 'const sample = `<img src=x onerror="globalThis.markdownExecuted=true">`;\n```\n  return sample;\n';
const longCode = 'const location = "' + 'a/very/long/local/path/'.repeat(9) + '";\n';
const answer = [
  '## 发布前检查',
  '已整理为三个检查项。文件读取与写入审批仍按原有流程执行，下面是可核对的结果。',
  '| 项目 | 当前状态 | 备注 | 数量 |',
  '| :--- | :---: | --- | ---: |',
  '| 任务记录 | 已完成 | 保留原始对话 | 12 |',
  '| 文件检查 | 待确认 | `src/main.js` | 3 |',
  '| 字面内容 | 已保留 | 管道 A\\|B 与 `x\\|y` | 1 |',
  '',
  '### 调整示例',
  '代码会保留缩进和换行；复制按钮取得完整内容。',
  '````javascript', fenced.replace(/\n$/, ''), '````',
  '', '无需将 `<img src=x>` 当作页面元素。**确认内容后再继续。**',
  '', '~~~text', '波浪线围栏也能完整显示。', '~~~',
  '', '## 宽内容', '```javascript', longCode.replace(/\n$/, ''), '```',
  '', '| 原始文本 | 检查结果 |', '| --- | --- |',
  '| <img src=x onerror="globalThis.markdownExecuted=true"> | [安全链接](https://example.com/check) |',
  '| [不安全](javascript:alert(1)) | `原样\\|反斜杠` |',
  '', '不完整的表格应保留原文：', '名称 | 数量', '--- | 不是分隔符',
  '', '内联代码中的反斜杠不应丢失：`a\\|b`。',
  '', '```text', '未闭合代码也保留最后一行',
].join('\r\n');

// Real Store + production page on an owned loopback port; no generated HTML,
// model endpoint or test-only renderer replaces the application's Markdown path.
const test = base.extend({ markdownAnswer: [answer, { option: true }], local: async ({ markdownAnswer }, use) => {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await mkdtemp(resolve('test-results', 'markdown-ui-'));
  const dataDir = join(root, 'data'), store = new Store(dataDir);
  const session = store.createSession({ title: '发布前检查与实现说明', providerId: 'demo' });
  session.messages = [
    { id: randomUUID(), role: 'user', content: '整理发布前检查，用表格说明结果，并给出代码示例。', createdAt: session.createdAt },
    { id: randomUUID(), role: 'assistant', content: markdownAnswer, createdAt: session.createdAt },
  ];
  session.run = { id: randomUUID(), status: 'completed', startedAt: session.createdAt, finishedAt: session.createdAt, output: null,
    steps: [
      { id: randomUUID(), type: 'tool', title: '读取项目文件', status: 'completed', detail: '已读取三个文件。\n原始记录仍可核对。' },
      { id: randomUUID(), type: 'tool', title: '检查目录结构', status: 'completed', detail: '检查已完成，没有写入文件。' },
    ],
  };
  store.putSession(session); store.close();
  const app = await startServer({ dataDir });
  try { await use({ app, session }); } finally { await app.close(); }
} });
test.use({ serviceWorkers: 'block' });

async function open(page, local) {
  await page.goto(local.app.url);
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
  if (await page.locator('.mobile-menu').isVisible()) await page.locator('.mobile-menu').click();
  await page.locator(`.session-link[data-id="${local.session.id}"]`).click();
  await expect(page.locator('#messages .message.assistant table')).toHaveCount(2);
  if (await page.locator('#context-toggle').getAttribute('aria-expanded') === 'true') await page.locator('#context-toggle').click();
  await page.locator('#messages').evaluate(node => node.scrollIntoView({ block: 'start' }));
}
async function audit(page, info, name) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  await info.attach(name + '-axe', { body: Buffer.from(JSON.stringify(result)), contentType: 'application/json' });
  expect(result.violations).toEqual([]);
}

test('Markdown: real conversation renders semantic tables, exact fenced code and inert model text', async ({ page, local }, info) => {
  await open(page, local);
  const markdown = page.locator('#messages .message.assistant .markdown');
  const table = markdown.locator('table').first();
  await expect(table.getByRole('columnheader')).toHaveText(['项目', '当前状态', '备注', '数量']);
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr').last().locator('td')).toHaveText(['字面内容', '已保留', '管道 A|B 与 x|y', '1']);
  await expect(table.locator('th').nth(1)).toHaveCSS('text-align', 'center');
  await expect(table.locator('th').last()).toHaveCSS('text-align', 'right');
  await expect(markdown.locator('.code-block')).toHaveCount(4);
  expect(await markdown.locator('.code-block pre code').nth(0).textContent()).toBe(fenced);
  expect(await markdown.locator('.code-block pre code').nth(1).textContent()).toBe('波浪线围栏也能完整显示。\n');
  expect(await markdown.locator('.code-block pre code').nth(2).textContent()).toBe(longCode);
  expect(await markdown.locator('.code-block pre code').nth(3).textContent()).toBe('未闭合代码也保留最后一行');
  await expect(markdown).toContainText('--- | 不是分隔符');
  await expect(markdown.locator('p code').last()).toHaveText('a\\|b');
  await expect(markdown.locator('img,script,iframe,style')).toHaveCount(0);
  await expect(markdown.getByRole('link')).toHaveCount(1);
  await expect(markdown.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await page.evaluate(() => globalThis.markdownExecuted)).toBeUndefined();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: local.app.url });
  await markdown.getByRole('button', { name: '复制代码', exact: true }).first().click();
  // Windows' system clipboard exposes CRLF; the rendered code above is checked
  // byte-for-byte. Only that platform newline representation may differ here.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(fenced);
  await page.locator('#messages').evaluate(node => node.scrollIntoView({ block: 'start' }));
  await audit(page, info, 'markdown-desktop-light');
  await page.screenshot({ path: info.outputPath('conversation-markdown-desktop.png'), animations: 'disabled' });
});

test('Conversation process: compact disclosures keep their open state and keyboard focus through a real refresh', async ({ page, local }, info) => {
  await open(page, local);
  await page.locator('#context-toggle').click();
  const step = page.locator('#run-panel .run-step').first(), summary = step.locator(':scope>summary');
  await expect(step).not.toHaveAttribute('open', '');
  await expect(step.locator('p')).not.toBeVisible();
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(step).toHaveAttribute('open', ''); await expect(step.locator('p')).toContainText('已读取三个文件');
  const { csrfToken } = await (await page.request.get(new URL('/api/bootstrap', local.app.url).href)).json();
  const renamed = await page.request.patch(new URL(`/api/sessions/${local.session.id}`, local.app.url).href, { headers: { 'X-CSRF-Token': csrfToken, Origin: local.app.url }, data: { title: '发布前检查 · 已核对' } });
  expect(renamed.ok()).toBe(true);
  await expect(page.locator('#chat-title')).toHaveText('发布前检查 · 已核对');
  await expect(step).toHaveAttribute('open', ''); await expect(summary).toBeFocused();
  await page.keyboard.press('Enter'); await expect(step.locator('p')).not.toBeVisible();
  await page.screenshot({ path: info.outputPath('conversation-process-desktop.png'), animations: 'disabled' });
});

for (const theme of ['light', 'dark']) test(`Markdown: mobile ${theme} keeps wide tables and code locally scrollable with keyboard access`, async ({ page, local }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(value => localStorage.setItem('openaster.theme', value), theme);
  await open(page, local);
  const table = page.locator('#messages .markdown-table-scroll').first();
  await table.focus();
  expect(await table.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => table.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const code = page.locator('#messages .code-block pre').nth(2);
  await code.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => code.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#messages .message.user').scrollIntoViewIfNeeded();
  await audit(page, info, `markdown-mobile-${theme}`);
  await page.screenshot({ path: info.outputPath(`conversation-markdown-mobile-${theme}.png`), animations: 'disabled' });
});


test.describe('Markdown table delimiter boundaries', () => {
  test.use({ markdownAnswer: [
    "| 情况 | 原文 | 结果 |",
    "| --- | --- | --- |",
    "| Windows | `C:\\` | 第三列 1 |",
    "| 未闭合 | `未闭合 | 第三列 2 |",
    "| 混合长度 | ``a`b`` | 第三列 3 |",
    "| 代码管道 | `a|b` | 第三列 4 |",
    "| 转义管道 | A\\|B | 第三列 5 |",
    "| 转义标记 | \\`原文 | 第三列 6 |",
    "| 代码反斜杠 | ``a\\`b`` | 第三列 7 |",
    "",
    "| `未闭合标题 | 结果 |",
    "| --- | --- |",
    "| 保留标题 | 已分列 |"
].join('\n') });

  test('Markdown: literal and unmatched backticks never consume later table columns', async ({ page, local }, info) => {
    await page.goto(local.app.url);
    await expect(page.locator('#top-status')).toHaveText('本地已连接');
    await page.locator('.session-link[data-id="' + local.session.id + '"]').click();
    const markdown = page.locator('#messages .message.assistant .markdown');
    await expect(markdown).toBeVisible();
    await info.attach('rendered-table-cells', { contentType: 'application/json', body: Buffer.from(JSON.stringify(await markdown.locator('table').evaluateAll(tables => tables.map(table => [...table.rows].map(row => [...row.cells].map(cell => cell.textContent)))), null, 2)) });
    const table = markdown.locator('table').first();
    const expected = [
      ['Windows', 'C:\\', '第三列 1'],
      ['未闭合', '`未闭合', '第三列 2'],
      ['混合长度', 'a`b', '第三列 3'],
      ['代码管道', 'a|b', '第三列 4'],
      ['转义管道', 'A|B', '第三列 5'],
      ['转义标记', '`原文', '第三列 6'],
      ['代码反斜杠', 'a\\`b', '第三列 7'],
    ];
    await expect(table.locator('tbody tr')).toHaveCount(expected.length);
    for (let index = 0; index < expected.length; index++) await expect(table.locator('tbody tr').nth(index).locator('td')).toHaveText(expected[index]);
    await expect(table.locator('tbody tr').nth(0).locator('code')).toHaveText('C:\\');
    await expect(table.locator('tbody tr').nth(1).locator('code')).toHaveCount(0);
    await expect(markdown.locator('table')).toHaveCount(2);
    await expect(markdown.locator('table').nth(1).getByRole('columnheader')).toHaveText(['`未闭合标题', '结果']);
    await expect(markdown.locator('table').nth(1).locator('tbody td')).toHaveText(['保留标题', '已分列']);
    await page.screenshot({ path: info.outputPath('markdown-table-delimiters-desktop.png'), animations: 'disabled' });
  });
});
