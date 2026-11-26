import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

async function closeMainMenu(page: Page) {
  const trigger = page.locator('.workspace-tabbar [aria-label="更多导航"]');
  if ((await trigger.isVisible()) && (await trigger.getAttribute('aria-expanded')) === 'true') {
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }
}

async function closeDirectory(page: Page) {
  const trigger = page.getByRole('button', { name: '关闭侧栏', exact: true });
  if ((await trigger.isVisible()) && (await page.locator('.sidebar.open').count())) {
    try {
      await trigger.click({ timeout: 2000 });
    } catch (error) {
      // A route finishing startup can dismiss its directory before the click lands.
      if (await page.locator('.sidebar.open').count()) throw error;
    }
    await expect(page.locator('.sidebar.open')).toHaveCount(0);
  }
}

/** Open the shared app menu; portrait layouts expose the full menu through the bottom tabs. */
export async function showMainMenu(page: Page) {
  await expect(page.locator('.workspace')).toBeVisible();
  await closeDirectory(page);
  const trigger = page.locator('.workspace-tabbar [aria-label="更多导航"]');
  if ((await trigger.isVisible()) && (await trigger.getAttribute('aria-expanded')) !== 'true')
    await trigger.click();
  await expect(page.locator('.workspace-footer')).toBeVisible();
}

/** Notebook folders and settings categories remain in their own contextual sidebar. */
export async function showSidebar(page: Page) {
  await expect(page.locator('.workspace')).toBeVisible();
  await closeMainMenu(page);
  const trigger = page.getByRole('button', { name: '打开侧栏', exact: true });
  if (
    (await trigger.isVisible()) &&
    !(await page.locator('.sidebar').evaluate((el) => el.classList.contains('open')))
  )
    await trigger.click();
}
export async function closeSidebar(page: Page) {
  await closeMainMenu(page);
  await closeDirectory(page);
}
export async function openSettingsSection(page: Page, label: string) {
  await showMainMenu(page);
  await page.locator('.sidebar-footer').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.settings-workspace')).toBeVisible();
  await showSidebar(page);
  await page
    .getByRole('navigation', { name: '设置分类', exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
  await expect(page.locator('.settings-workspace')).toBeVisible();
}
export type FeatureTitle = 'MCP 服务' | 'Git 版本管理';

export async function openFeatureSettings(page: Page, title: FeatureTitle) {
  const mcp = title === 'MCP 服务';
  await openSettingsSection(page, mcp ? 'MCP 连接' : '知识库与存储');
  await expect(page.getByRole('switch', { name: '启用 ' + title, exact: true })).toBeVisible();
  await expect(mcp
    ? page.getByRole('switch', { name: '启用 OAuth 连接', exact: true })
    : page.getByLabel('提交作者', { exact: true })).toBeVisible();
  if (mcp) await openLegacyMcpSettings(page);
}

export async function setFeatureSwitch(page: Page, title: FeatureTitle, enabled: boolean) {
  const control = page.getByRole('switch', { name: '启用 ' + title, exact: true });
  await expect(control).toBeEnabled();
  if (await control.getAttribute('aria-checked') !== String(enabled)) await control.click();
  await expect(control).toHaveAttribute('aria-checked', String(enabled));
  await expect(control).toBeEnabled();
}
export async function returnToNotes(page: Page) {
  await page
    .locator('.settings-workspace')
    .getByRole('button', { name: '返回笔记', exact: true })
    .click();
  await expect(page.locator('.settings-workspace')).toHaveCount(0);
}

/** Legacy compatibility scenarios deliberately open the v1 form. New rights use domain cards. */
export async function openLegacyMcpSettings(page:Page){
  const summary=page.locator('summary').filter({hasText:'旧版兼容设置'});
  if(await summary.isVisible()){
    const open=await summary.evaluate(element=>(element.parentElement as HTMLDetailsElement).open);
    if(!open)await summary.click();
  }
}
