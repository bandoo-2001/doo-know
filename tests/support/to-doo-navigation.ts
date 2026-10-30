import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { showMainMenu, closeSidebar } from './settings-navigation';

export async function openToDooDirectory(page: Page, name: '任务目录' | '日历目录' = '任务目录') {
  await expect(page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: '功能导航', exact: true });
  const dialog = page.getByRole('dialog', { name: '功能导航', exact: true });
  if ((await trigger.isVisible()) && (await trigger.getAttribute('aria-expanded')) !== 'true') {
    // A directory choice closes the drawer; let that transition finish before reopening it.
    await expect(dialog).not.toBeVisible();
    await trigger.click();
  }
  const directory = page.getByRole('navigation', { name, exact: true });
  await expect(directory).toBeVisible();
  return directory;
}

export async function closeToDooDirectory(page: Page) {
  const dialog = page.getByRole('dialog', { name: '功能导航', exact: true });
  if (await dialog.isVisible()) {
    if (
      (await page
        .getByRole('button', { name: '功能导航', exact: true })
        .getAttribute('aria-expanded')) === 'true'
    )
      await dialog.getByRole('button', { name: '关闭功能导航', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
}

/** Follow the same primary menu, contextual directory and view controls available to the user. */
export async function goToToDooSection(page: Page, section: string) {
  const primary: Record<string, string> = {
    overview: '任务',
    tasks: '任务',
    board: '任务',
    calendar: '日历',
    timeline: '日历',
    matrix: '四象限',
    focus: '专注',
    habits: '习惯',
    anniversaries: '纪念日',
    stats: '复盘',
  };
  const utility: Record<string, string> = { notifications: '通知', settings: '设置' };
  const label = primary[section] || utility[section];
  if (!label) throw Error('Unknown To Doo section: ' + section);
  await showMainMenu(page);
  await page
    .getByRole('navigation', {
      name: utility[section] ? 'To Doo 工具' : 'To Doo 主菜单',
      exact: true,
    })
    .getByRole('button', { name: label, exact: true })
    .click();
  await closeSidebar(page);
  if (section === 'overview') {
    const directory = await openToDooDirectory(page);
    await directory.getByRole('button', { name: '目标总览', exact: true }).click();
  } else if (section === 'board') {
    await page.locator('.todo-view-switch').getByText('看板', { exact: true }).click();
  } else if (section === 'timeline') {
    const directory = await openToDooDirectory(page, '日历目录');
    await directory.getByRole('button', { name: '时间线', exact: true }).click();
  }
  await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe(section);
}
