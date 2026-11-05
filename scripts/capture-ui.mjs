import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startServer } from '../server/index.mjs';

const screenshots=resolve('test-results','screenshots');
await mkdir(screenshots,{recursive:true});
const dataDir=await mkdtemp(resolve('test-results','ui-v3-'));
const app=await startServer({dataDir});
let browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
const context=await browser.newContext({viewport:{width:1440,height:960},reducedMotion:'reduce'});
let page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
async function capture(name){for(const item of await page.getByRole('button',{name:'关闭提示',exact:true}).all())await item.click().catch(()=>{});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:resolve(screenshots,name),animations:'disabled'});}
async function ensureDetails(){if(await page.locator('#context-toggle').getAttribute('aria-expanded')==='false')await page.locator('#context-toggle').click();await expect(page.locator('#context-panel')).toBeVisible();}
async function send(text){await page.locator('#prompt-input').fill(text);await page.locator('#send-button').click();}
async function rename(title){await page.locator('[data-action=rename]').click();await page.locator('#field-title').fill(title);await page.locator('#dialog-submit').click();await expect(page.locator('#chat-title')).toHaveText(title);}
async function importText(path,content){await page.locator('.page-heading [data-action=import]').click();await page.locator('#field-path').fill(path);await page.locator('#field-content').fill(content);await page.locator('#dialog-submit').click();await expect(page.locator('#app-dialog')).not.toBeVisible();}
try{
  await page.goto(app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');await capture('desktop-empty.png');
  await page.locator('.nav-item[data-action=workspace]').click();
  await importText('notes/项目说明.md','# 项目说明\n\n这是一份用于本地界面演示的参考资料。\n\n## 工作目标\n\n整理工作区中的文档，核对文件清单，生成一份可审核的概览。\n\n## 处理要求\n\n- 保留原始资料\n- 在写入文件前检查完整内容\n- 记录已经完成的操作和仍待处理的事项\n');
  await importText('notes/待办事项.md','# 待办事项\n\n- 阅读现有参考资料\n- 核对工作区文件清单\n- 审核工作区报告内容\n');
  await page.locator('.file-row[data-path="notes/项目说明.md"]').click();await expect(page.locator('#selected-file-content')).toContainText('工作目标');await capture('desktop-workspace.png');
  await page.locator('.new-task').click();await send('生成工作区报告');await expect(page.locator('.approval-card')).toBeVisible();await page.locator('[data-action=approve]').click();await ensureDetails();await expect(page.locator('.run-status')).toHaveText('已完成');await rename('项目文件清单');await page.locator('#pin-current').click();await expect(page.locator('#artifact-list .artifact-file')).toHaveCount(1);await page.locator('#context-toggle').click();await expect(page.locator('#context-panel')).not.toBeVisible();await capture('desktop-task-focus.png');await ensureDetails();await capture('desktop-result.png');
  await page.locator('.new-task').click();await send('请阅读工作区中的参考资料，列出已有文件。');await ensureDetails();await expect(page.locator('.run-status')).toHaveText('已完成');await rename('参考资料检查');
  await page.locator('.new-task').click();await send('生成工作区报告');await expect(page.locator('.approval-card')).toBeVisible();await page.locator('.conversation-scroll').evaluate(node=>{node.scrollTop=0;});await capture('desktop-chat-top.png');await page.locator('[data-action=approve]').scrollIntoViewIfNeeded();await capture('desktop-chat.png');
  await page.locator('.brand[data-action=home]').click();await expect(page.locator('#home-view')).toBeVisible();await expect(page.locator('#session-list .session-link')).toHaveCount(3);await capture('desktop-home.png');
  await page.locator('[data-action=theme]').click();await capture('desktop-dark.png');await page.keyboard.press('Control+p');await page.getByRole('combobox',{name:'搜索命令'}).fill('工作');await capture('desktop-command.png');await page.keyboard.press('Escape');await page.locator('[data-action=theme]').click();
  await browser.close();browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
  const mobileContext=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});page=await mobileContext.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');await expect(page.locator('.mobile-menu')).toBeVisible();await expect(page.locator('.mobile-menu svg')).toHaveCount(1);await page.locator('.mobile-menu').click({trial:true});await page.locator('.mobile-menu').click();await expect(page.locator('#sidebar')).toHaveClass(/open/);await page.keyboard.press('Escape');await expect(page.locator('#sidebar')).not.toHaveClass(/open/);await expect(page.locator('#page-label')).toHaveText('新任务');await page.locator('#page-label').click();await capture('mobile-home.png');expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('.mobile-menu').click();await page.locator('.session-group[data-group=active] .session-link').click();await expect(page.locator('.approval-card')).toBeVisible();if(await page.locator('#context-panel').isVisible())await page.locator('#context-toggle').click();await capture('mobile-chat.png');expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('[data-action=deny]').click();await ensureDetails();await expect(page.locator('.run-status')).toHaveText('已完成');expect(errors).toEqual([]);
  console.log(JSON.stringify({screenshots,dataDir,viewportDesktop:[1440,960],viewportMobile:[390,844],sessions:3,mode:'actual local demo runs',pageErrors:errors}));
}finally{await browser.close();await app.close();}
