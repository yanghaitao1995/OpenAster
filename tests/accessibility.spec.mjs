import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#top-status')).toHaveText('本地已连接');
}
async function audit(page, testInfo, state) {
  const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
  await testInfo.attach(`accessibility-${state}`,{body:JSON.stringify({state,violations:results.violations,incomplete:results.incomplete},null,2),contentType:'application/json'});
  const violations=results.violations.map(({id,impact,nodes})=>({id,impact,nodes:nodes.map(({target,failureSummary})=>({target,failureSummary}))}));
  expect.soft(violations,`${state} accessibility violations`).toEqual([]);
}

test('accessibility: light and dark workbench, command dialog and model form',async({page},testInfo)=>{
  test.setTimeout(90000);
  await ready(page);await audit(page,testInfo,'home-light');
  await page.locator('[data-action="theme"]').click();await expect(page.locator('body')).toHaveClass('dark');await audit(page,testInfo,'home-dark');
  await page.keyboard.press('Control+p');await expect(page.locator('.command-palette')).toBeVisible();await audit(page,testInfo,'command-dark');
  await page.keyboard.press('Escape');await expect(page.locator('.command-palette')).not.toBeVisible();
  await page.locator('[data-action="theme"]').click();
  await page.locator('.nav-item[data-action="settings"]').click();await audit(page,testInfo,'settings-light');
  await page.locator('[data-action="add-provider"]').click();await expect(page.locator('#app-dialog')).toBeVisible();await audit(page,testInfo,'model-form-light');
  await page.locator('.dialog-heading [data-action="close-dialog"]').click();
  for(const view of ['workspace','skills','security']) {
    await page.locator(`.nav-item[data-action="${view}"]`).click();
    await expect(page.locator(`#${view}-view`)).toBeVisible();
    await audit(page,testInfo,`${view}-light`);
  }
});

test('accessibility: approval controls and mobile navigation remain usable',async({page},testInfo)=>{
  test.setTimeout(90000);
  await ready(page);await page.locator('#prompt-input').fill('生成工作区报告');await page.locator('#send-button').click();await expect(page.locator('.approval-card')).toBeVisible();
  try {
    await expect(page.locator('#context-toggle')).toHaveAttribute('aria-expanded','false');await audit(page,testInfo,'approval-light');
    await page.locator('#context-toggle').click();await expect(page.locator('#context-panel')).toBeVisible();await audit(page,testInfo,'approval-details-light');await page.locator('#context-toggle').click();
    await page.setViewportSize({width:1100,height:960});
    const details=page.locator('#context-toggle');
    await expect(details).toHaveAccessibleName('任务详情');await expect(details).toHaveAttribute('aria-expanded','false');await expect(page.locator('#context-panel')).not.toBeVisible();await audit(page,testInfo,'approval-compact-light');
    await details.click();await expect(details).toHaveAccessibleName('任务详情');await expect(details).toHaveAttribute('aria-expanded','true');await expect(page.locator('#context-panel')).toBeVisible();await audit(page,testInfo,'approval-compact-details-light');
    await details.click();await expect(details).toHaveAttribute('aria-expanded','false');await page.setViewportSize({width:1440,height:960});
    await page.locator('[data-action="theme"]').click();await audit(page,testInfo,'approval-dark');
    await page.setViewportSize({width:390,height:844});await expect(page.locator('[data-action="sidebar"]')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await audit(page,testInfo,'approval-mobile-dark');
    await page.locator('[data-action="sidebar"]').click();await expect(page.locator('#sidebar')).toHaveClass(/open/);await audit(page,testInfo,'navigation-mobile-dark');
    await page.keyboard.press('Escape');await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
  }finally{
    const stop=page.locator('#cancel-button');if(await stop.isVisible())await stop.click();
  }
});
