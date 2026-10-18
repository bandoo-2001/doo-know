import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
/** Contextual settings hide notebook navigation; use the visible sidebar for each transition. */
export async function showSidebar(page: Page) {
  const trigger = page.getByRole('button', { name: '打开侧栏', exact: true });
  if (
    (await trigger.isVisible()) &&
    !(await page.locator('.sidebar').evaluate((el) => el.classList.contains('open')))
  )
    await trigger.click();
}
export async function closeSidebar(page: Page) {
  const trigger = page.getByRole('button', { name: '关闭侧栏', exact: true });
  if (
    (await trigger.isVisible()) &&
    (await page.locator('.sidebar').evaluate((el) => el.classList.contains('open')))
  )
    await trigger.click();
}
export async function openSettingsSection(page: Page, label: string) {
  await showSidebar(page);
  await page.locator('.sidebar-footer').getByRole('button', { name: '设置', exact: true }).click();
  await showSidebar(page);
  await page
    .getByRole('navigation', { name: '设置分类', exact: true })
    .getByRole('button', { name: label, exact: true })
    .click();
  await expect(page.locator('.settings-workspace')).toBeVisible();
}
export async function configurePlugin(page: Page, title: string) {
  await openSettingsSection(page, '插件与连接');
  await expect(page.getByRole('button', { name: '刷新插件状态', exact: true })).toBeEnabled();
  const card = page.locator('.plugin-card').filter({ hasText: title });
  if (await card.isVisible()) await card.getByRole('button', { name: '配置', exact: true }).click();
  else {
    await page.getByRole('tab', { name: '添加插件', exact: true }).click();
    await page.getByRole('button', { name: '安装' + title, exact: true }).click();
  }
  await expect(
    page.locator('.plugin-settings').getByRole('heading', { name: title + '设置', exact: true }),
  ).toBeVisible();
}
export async function returnToNotes(page: Page) {
  await page
    .locator('.settings-workspace')
    .getByRole('button', { name: '返回笔记', exact: true })
    .click();
  await expect(page.locator('.settings-workspace')).toHaveCount(0);
}
