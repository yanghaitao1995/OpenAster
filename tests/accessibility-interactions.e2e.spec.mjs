import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { startServer } from '../server/index.mjs';

const test=base.extend({local:async({browser},use)=>{
  await mkdir(resolve('test-results'),{recursive:true});const dataDir=await mkdtemp(resolve('test-results','accessibility-ui-'));
  const store=new Store(dataDir);let first,second;try{first=store.createSession({title:'键盘任务甲'});second=store.createSession({title:'键盘任务乙'});}finally{store.close();}
  const app=await startServer({dataDir}),context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block'}),page=await context.newPage();
  try{await page.goto(app.url);await expect(page.locator('#top-status')).toHaveText('本地已连接');await use({page,app,first,second});}finally{await context.close();await app.close();}
}});
async function audit(page,info,name){const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();await info.attach(name,{body:JSON.stringify({violations:result.violations,incomplete:result.incomplete}),contentType:'application/json'});expect(result.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)}))).toEqual([]);}
async function capture(page,info,name){const path=info.outputPath(name);await page.screenshot({path,animations:'disabled'});await mkdir(resolve('test-results/screenshots'),{recursive:true});await copyFile(path,resolve('test-results/screenshots',name));}
async function refresh(page){const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await(await response).finished();await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));}

test('accessibility interactions: task refresh and pin regroup preserve focused controls and expanded groups',async({local},info)=>{
  const {page,first}=local,list=page.getByRole('region',{name:'任务列表',exact:true}),row=list.locator(`[data-action="open-session"][data-id="${first.id}"]`),pin=list.locator(`[data-action="pin-session"][data-id="${first.id}"]`);
  await expect(list).toBeVisible();await row.focus();await page.evaluate(()=>{globalThis.__a11yTaskControl=document.activeElement;});await refresh(page);await expect(row).toBeFocused();expect(await row.evaluate(node=>node===globalThis.__a11yTaskControl)).toBe(true);
  await page.keyboard.press('Tab');await expect(pin).toBeFocused();await page.keyboard.press('Enter');await expect(pin).toHaveAttribute('aria-pressed','true');await expect(pin).toBeFocused();await expect(pin.locator('xpath=ancestor::details')).toHaveAttribute('data-group','pinned');
  const summary=pin.locator('xpath=ancestor::details').locator(':scope>summary');await summary.focus();await page.keyboard.press('Enter');await expect(summary.locator('..')).not.toHaveAttribute('open','');await refresh(page);await expect(summary).toBeFocused();await expect(summary.locator('..')).not.toHaveAttribute('open','');await page.keyboard.press('Enter');
  await row.focus();await page.keyboard.press('Enter');await expect(page.locator('#chat-title')).toHaveText('键盘任务甲');await expect(page.locator('#chat-title')).toBeFocused();await expect(row).toHaveAttribute('aria-current','page');
  await row.focus();await audit(page,info,'interaction-task-list');await capture(page,info,'accessibility-task-list-focus-desktop.png');
});

test('accessibility interactions: command combobox keeps real controlled IDs through empty results and returns keyboard focus',async({local},info)=>{
  const {page}=local,opener=page.locator('.quick-search'),input=page.getByRole('combobox',{name:'搜索命令'});await opener.focus();await page.keyboard.press('Enter');await expect(input).toBeFocused();
  const controlled=await input.getAttribute('aria-controls');await expect(page.locator(`[id="${controlled}"]`)).toHaveCount(1);await expect(page.locator(`[id="${controlled}"]`)).toHaveAttribute('role','listbox');expect(await input.evaluate(node=>node.closest('dialog').contains(document.getElementById(node.getAttribute('aria-controls'))))).toBe(true);
  const first=await input.getAttribute('aria-activedescendant');await page.keyboard.press('ArrowDown');const next=await input.getAttribute('aria-activedescendant');expect(next).not.toBe(first);await expect(page.locator(`[id="${next}"]`)).toHaveAttribute('aria-selected','true');await expect(input).toBeFocused();
  await input.fill('不存在的命令零结果');await expect(page.locator('.command-palette__empty')).toBeVisible();await expect(input).not.toHaveAttribute('aria-activedescendant',/.+/);await expect(page.locator(`[id="${controlled}"]`)).toHaveCount(1);await expect(page.locator(`[id="${controlled}"]`)).not.toBeVisible();await expect(input).toHaveAttribute('aria-expanded','false');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await expect(input).toBeFocused();await expect(page.locator('.command-palette')).toBeVisible();await audit(page,info,'interaction-command-empty');
  await input.fill('');await expect(page.locator(`[id="${controlled}"]`)).toBeVisible();await expect(input).toHaveAttribute('aria-expanded','true');await expect(page.locator('.command-palette__empty')).not.toBeVisible();await page.keyboard.press('ArrowDown');const restored=await input.getAttribute('aria-activedescendant');await expect(page.locator(`[id="${restored}"]`)).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('Escape');await expect(opener).toBeFocused();await page.keyboard.press('Enter');await input.fill('模型与连接');await page.keyboard.press('Enter');await expect(page.locator('#settings-view')).toBeVisible();await expect(page.locator('#settings-view h1')).toBeFocused();
});

test('accessibility interactions: modal keyboard focus stays inside and Escape returns to its actual opener',async({local})=>{
  const {page}=local;await page.locator('.nav-item[data-action=settings]').click();const opener=page.locator('[data-action=add-provider]');await opener.focus();await page.keyboard.press('Enter');await expect(page.locator('#field-name')).toBeFocused();
  for(let n=0;n<16;n++){await page.keyboard.press(n<8?'Tab':'Shift+Tab');expect(await page.evaluate(()=>document.querySelector('#app-dialog').contains(document.activeElement))).toBe(true);}
  await page.locator('.new-task').evaluate(node=>node.focus());expect(await page.evaluate(()=>document.querySelector('#app-dialog').contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');await expect(page.locator('#app-dialog')).not.toBeVisible();await expect(opener).toBeFocused();await page.keyboard.press('Enter');await page.locator('.dialog-actions [data-action=close-dialog]').focus();await page.keyboard.press('Enter');await expect(opener).toBeFocused();
});

test('accessibility interactions: mobile navigation contains Tab, preserves nested dialog focus and closes cleanly for new tasks',async({local},info)=>{
  const {page}=local;await page.setViewportSize({width:390,height:844});const menu=page.locator('.mobile-menu'),sidebar=page.locator('#sidebar'),brand=sidebar.locator('.brand'),theme=sidebar.locator('[data-action=theme]');
  for(const dark of [false,true]){
    await menu.focus();await page.keyboard.press('Enter');await expect(sidebar.locator('.new-task')).toBeFocused();await expect(page.locator('.main-shell')).toHaveAttribute('inert','');await page.keyboard.press('Shift+Tab');await expect(brand).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(theme).toBeFocused();await page.keyboard.press('Tab');await expect(brand).toBeFocused();
    if(dark){await theme.focus();await page.keyboard.press('Enter');await expect(page.locator('body')).toHaveClass('dark');}
    const command=sidebar.locator('.quick-search');await command.focus();await page.keyboard.press('Control+p');await expect(page.locator('.command-palette__input')).toBeFocused();await page.keyboard.press('Escape');await expect(sidebar).toHaveClass(/open/);await expect(command).toBeFocused();
    await audit(page,info,`interaction-navigation-mobile-${dark?'dark':'light'}`);await capture(page,info,`accessibility-navigation-focus-mobile-${dark?'dark':'light'}.png`);await page.keyboard.press('Escape');await expect(menu).toBeFocused();await expect(menu).toHaveAttribute('aria-expanded','false');await expect(sidebar).toHaveAttribute('inert','');await expect(page.locator('.main-shell')).not.toHaveAttribute('inert','');
    await page.keyboard.press('Enter');await page.keyboard.press('Control+k');await expect(page.locator('#prompt-input')).toBeFocused();await expect(sidebar).not.toHaveClass(/open/);expect(await page.locator('#prompt-input').evaluate(node=>!!node.closest('[inert]'))).toBe(false);
  }
  await menu.focus();await page.keyboard.press('Enter');await page.setViewportSize({width:1440,height:960});await expect(sidebar).not.toHaveClass(/open/);await expect(page.locator('#sidebar-scrim')).not.toBeVisible();await expect(page.locator('.main-shell')).not.toHaveAttribute('inert','');
});

test('accessibility interactions: timed notification remains while focused and close returns to the invoking control',async({local})=>{
  const {page}=local;await page.clock.install();const theme=page.locator('[data-action=theme]');await theme.focus();await page.keyboard.press('Enter');const close=page.getByRole('button',{name:'关闭提示',exact:true});await expect(close).toHaveCount(1);await expect(close.locator('svg')).toHaveCount(1);await close.focus();await page.clock.fastForward(11000);await expect(close).toBeFocused();await page.keyboard.press('Enter');await expect(close).toHaveCount(0);await expect(theme).toBeFocused();
  await page.keyboard.press('Enter');await expect(close).toHaveCount(1);await page.clock.fastForward(6000);await expect(close).toHaveCount(0);await expect(theme).toBeFocused();
  // A background notification can arrive while no actionable control has focus.
  await page.evaluate(()=>{document.activeElement.blur();document.querySelector('[data-action=theme]').click();});await expect(close).toHaveCount(1);await close.focus();await page.keyboard.press('Enter');await expect(page.locator('#prompt-input')).toBeFocused();
  // Merely moving the pointer toward an obscured composer control must not
  // make an unfocused notification permanent. Actual keyboard focus still
  // pauses its timer, as verified above.
  await page.route('**/api/sessions',route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_RETRY',message:'暂时无法提交。请保留输入内容，稍后再试；工作台没有发送这次请求，也没有创建新的任务。'}})}):route.continue());
  const prompt=page.locator('#prompt-input');await prompt.fill('查看工作空间中的文件');await page.keyboard.press('Enter');const error=page.locator('.toast.error');await expect(error).toContainText('暂时无法提交');await expect(prompt).toBeFocused();await error.hover();await expect(prompt).toBeFocused();await page.clock.fastForward(11000);await expect(error).toHaveCount(0);await expect(prompt).toBeFocused();await page.unroute('**/api/sessions');
  await page.locator('#send-button').click();await expect(page.locator('#chat-view')).toBeVisible();await expect(page.locator('#chat-meta .task-status-badge')).toHaveText('已完成');
});
