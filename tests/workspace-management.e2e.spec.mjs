// SPDX-License-Identifier: Apache-2.0
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startWorkspaceHost } from '../server/workspace-host.mjs';

const test = base.extend({ host: async ({}, use) => {
  const parent = await fs.realpath(tmpdir()), root = await fs.mkdtemp(path.join(parent, 'openaster-v42-workspace-ui-'));
  const identity = await fs.lstat(root, { bigint: true }), owner = randomUUID();
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx' });
  const service = await startWorkspaceHost({ port: 0, dataDir: path.join(root, 'data'), workspace: path.join(root, 'original'), homeDirectory: root, projectsRoot: path.join(root, 'projects') });
  try { await use({ service, root }); }
  finally {
    await service.close();
    const actual = await fs.lstat(root, { bigint: true });
    expect(await fs.realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent);
    expect(actual.isSymbolicLink()).toBe(false); expect(actual.ino).toBe(identity.ino); expect(actual.dev).toBe(identity.dev);
    expect(await fs.readFile(path.join(root, '.owner'), 'utf8')).toBe(owner);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
} });
test.use({ serviceWorkers: 'block' });

test('workspace manager creates and switches real projects while preserving the original text draft', async ({ page, host }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(host.service.url); await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await page.locator('#prompt-input').fill('保留在原项目的草稿');
  await page.locator('.nav-item[data-action=workspace]').click();
  await expect(page.locator('#workspace-full-path')).toHaveText(path.join(host.root, 'original'));
  await page.locator('#create-workspace-project').click();
  const dialog = page.locator('.project-manager'); await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('服务的主机');
  await dialog.getByRole('textbox', { name: '新项目名称' }).fill('浏览器项目');
  await dialog.getByRole('button', { name: '新建并打开' }).click();
  await expect(page.locator('#workspace-label')).toHaveText('浏览器项目');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#prompt-input')).toHaveValue('');
  await page.locator('.nav-item[data-action=workspace]').click();
  await expect(page.locator('#workspace-full-path')).toHaveText(path.join(host.root, 'projects', '浏览器项目'));
  await page.locator('#open-workspace-project').click();
  await expect(dialog).toBeVisible();
  await dialog.locator('.project-recent').filter({ hasText: '默认工作区' }).click();
  await expect(page.locator('#workspace-label')).toHaveText('默认工作区');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#prompt-input')).toHaveValue('保留在原项目的草稿');
  expect(errors).toEqual([]);
});

test('workspace manager fits mobile width and retains invalid project input without creating a directory', async ({ page, host }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(host.service.url); await expect(page.locator('#top-status')).toHaveText('本地已连接');
  await page.locator('[data-action=sidebar]').click();
  await page.locator('.nav-item[data-action=workspace]').click();
  await page.locator('#create-workspace-project').click();
  const dialog = page.locator('.project-manager');
  await expect(dialog.getByRole('textbox', { name: '新项目名称' })).toBeVisible();
  await dialog.getByRole('textbox', { name: '新项目名称' }).fill('../invalid');
  await dialog.getByRole('button', { name: '新建并打开' }).click();
  await expect(dialog.locator('[role=alert]')).toContainText('项目名称');
  await expect(dialog.getByRole('textbox', { name: '新项目名称' })).toHaveValue('../invalid');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(dialog).toContainText('不会访问手机本地磁盘');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(fs.stat(path.join(host.root, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
});
