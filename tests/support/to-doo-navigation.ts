import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { selectToDooOption } from './to-doo-ant-controls';

/** Desktop and mobile expose the same navigation; only its container changes. */
export async function openToDooDirectory(page: Page, _legacyDirectoryName?: string) {
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app).toBeVisible();
  const directory = app.getByRole('navigation', { name: 'To Doo 导航', exact: true });
  if (!(await directory.isVisible())) {
    const dialog = page.getByRole('dialog', { name: '功能导航', exact: true });
    await expect(dialog).not.toBeVisible();
    await app.getByRole('button', { name: '功能导航', exact: true }).click();
  }
  await expect(directory).toBeVisible();
  return directory;
}

/** Older flows use this name for controls that now live inside each page. */
export async function selectToDooContext(page: Page, label: string, _legacyDirectoryName?: string) {
  await closeToDooDirectory(page);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app).toBeVisible();
  const section = new URL(page.url()).searchParams.get('appSection');
  if (section === 'settings' || section === 'notifications') {
    await app.getByRole('tab', { name: label, exact: true }).click();
    return;
  }
  if (section === 'habits' || section === 'anniversaries') {
    await app
      .getByRole('radio', { name: label, exact: true })
      .locator('xpath=ancestor::label[1]')
      .click();
    return;
  }
  if (section === 'focus') {
    const panes = app.locator('.todo-focus-mobile-panes');
    if (await panes.isVisible())
      await panes.getByText(label === '项目' ? '专注' : label, { exact: true }).click();
    return;
  }
  if (section === 'calendar' || section === 'timeline') {
    if (label === '时间线') {
      await goToToDooSection(page, 'timeline');
    } else if (label === '月视图' || label === '周视图') {
      if (section === 'timeline') await goToToDooSection(page, 'calendar');
      await app
        .getByRole('radio', { name: label === '月视图' ? '月' : '周', exact: true })
        .locator('xpath=ancestor::label[1]')
        .click();
    } else await selectToDooQuickView(page, label);
    return;
  }
  await selectToDooQuickView(page, label);
}

export async function closeToDooDirectory(page: Page) {
  const dialog = page.getByRole('dialog', { name: '功能导航', exact: true });
  if (await dialog.isVisible()) {
    const trigger = page.getByRole('button', { name: '功能导航', exact: true });
    // A navigation choice already closes the drawer; wait for that animation instead of clicking a disappearing control.
    if ((await trigger.getAttribute('aria-expanded')) === 'true')
      await dialog.getByRole('button', { name: '关闭功能导航', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
}

/** Choose one stable task destination, regardless of the current tool or view. */
export async function selectToDooQuickView(page: Page, label: string) {
  const directory = await openToDooDirectory(page);
  const button = directory.getByRole('button', { name: label, exact: true, includeHidden: true });
  if (!(await button.isVisible())) {
    const more = directory.locator('details.todo-navigation-more');
    if (await more.count()) await more.locator('summary').click();
  }
  await button.click();
  await closeToDooDirectory(page);
}

export async function selectToDooList(page: Page, name: string) {
  const directory = await openToDooDirectory(page);
  await directory
    .getByRole('region', { name: '我的清单', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
  await closeToDooDirectory(page);
}

/** Return to the DooKnow location without reaching through its hidden application shell. */
export async function returnFromToDoo(page: Page) {
  await page
    .getByRole('region', { name: 'To Doo 行动工作空间', exact: true })
    .getByRole('button', { name: '返回 DooKnow', exact: true })
    .first()
    .click();
}

export async function openToDooFocusHistory(page: Page) {
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.getByRole('region', { name: '专注计时器', exact: true })).toBeVisible();
  const tabs = app.locator('.todo-focus-mobile-panes');
  if (await tabs.isVisible()) {
    await tabs.getByText('历史', { exact: true }).click();
    await expect(app.getByRole('radio', { name: '历史', exact: true })).toBeChecked();
  }
  const history = app.getByRole('complementary', { name: '专注概览和历史', exact: true });
  await expect(history).toBeVisible();
  return history;
}

/** Destinations belong to the app navigation; alternate task layouts stay in the view picker. */
export async function goToToDooSection(page: Page, section: string) {
  const taskViews: Record<string, '列表' | '看板' | '四象限' | '时间线'> = {
    tasks: '列表',
    board: '看板',
    matrix: '四象限',
    timeline: '时间线',
  };
  if (taskViews[section]) {
    await selectToDooQuickView(page, '所有任务');
    if (section !== 'tasks') await selectToDooTaskView(page, taskViews[section]);
  } else {
    const labels: Record<string, string> = {
      overview: '目标总览',
      calendar: '日历',
      focus: '专注',
      habits: '习惯',
      anniversaries: '纪念日',
      stats: '统计与复盘',
      notifications: '通知',
      settings: '设置',
    };
    if (!labels[section]) throw Error('Unknown To Doo section: ' + section);
    await selectToDooQuickView(page, labels[section]);
  }
  await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe(section);
}

/** Change the task presentation through the view picker. */
export async function selectToDooTaskView(
  page: Page,
  label: '列表' | '看板' | '四象限' | '时间线',
) {
  await expect(page.locator('.todo-task-toolbar')).toBeVisible();
  await selectToDooOption(page, '任务展示方式', label);
}

/** Expand task search when the compact phone toolbar is used. */
export async function openToDooTaskTools(page: Page) {
  // isVisible() is a snapshot: after goto/reload the toolbar may not have mounted yet.
  // Wait for its real owner before deciding whether the phone-only disclosure is needed.
  const toolbar = page.locator('.todo-task-toolbar');
  await expect(toolbar).toBeVisible();
  const toggle = toolbar.getByRole('button', { name: '搜索任务', exact: true });
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  await expect(toolbar.getByRole('textbox', { name: '搜索任务', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: '任务管理', exact: true })).toBeVisible();
}
