import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { selectToDooOption } from './to-doo-ant-controls';

/** Return the one visible navigation surface without choosing a destination. */
export async function openToDooDirectory(page: Page, _legacyDirectoryName?: string) {
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app).toBeVisible({ timeout: 20000 });
  const dialog = page.getByRole('dialog', { name: '功能导航', exact: true });
  if (await dialog.isVisible()) {
    const directory = dialog.getByRole('navigation', { name: 'To Doo 导航', exact: true });
    await expect(directory).toHaveCount(1);
    await expect(directory).toBeVisible();
    return directory;
  }
  // The desktop surface owns two different navigations. Keep their common
  // container for older flows that inspect both scopes, then choose precisely
  // between the module rail and task directory in the destination helpers.
  const split = app.locator('.todo-navigation-content:has(.todo-module-rail):visible');
  if (await split.count()) {
    await expect(split).toHaveCount(1);
    const section = new URL(page.url()).searchParams.get('appSection') || 'tasks';
    const tasks = split.getByRole('navigation', { name: 'To Doo 任务导航', exact: true });
    if (taskSections.has(section) && !(await tasks.isVisible())) {
      await split.getByRole('navigation', { name: 'To Doo 主菜单', exact: true })
        .getByRole('button', { name: '展开清单导航', exact: true }).click();
      if (await dialog.isVisible()) {
        const directory = dialog.getByRole('navigation', { name: 'To Doo 导航', exact: true });
        await expect(directory).toHaveCount(1);
        await expect(directory).toBeVisible();
        return directory;
      }
      await expect(tasks).toBeVisible();
    }
    return split;
  }
  await app.getByRole('button', { name: '功能导航', exact: true }).click();
  await expect(dialog).toBeVisible();
  const directory = dialog.getByRole('navigation', { name: 'To Doo 导航', exact: true });
  await expect(directory).toHaveCount(1);
  await expect(directory).toBeVisible();
  return directory;
}

const moduleLabels = new Set(['任务', '日历', '习惯', '专注', '目标总览', '统计与复盘', '纪念日', '通知', '通知中心', '设置']);
const taskSections = new Set(['tasks', 'board', 'matrix', 'timeline']);

async function openTaskDirectory(page: Page) {
  let directory = await openToDooDirectory(page);
  if ((await directory.getAttribute('aria-label')) === 'To Doo 导航') return directory;
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  if (!taskSections.has(new URL(page.url()).searchParams.get('appSection') || 'tasks')) {
    await directory.getByRole('navigation', { name: 'To Doo 主菜单', exact: true })
      .getByRole('button', { name: '任务', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe('tasks');
    await expect(app.getByRole('navigation', { name: 'To Doo 主菜单', exact: true })
      .getByRole('button', { name: '任务', exact: true })).toHaveAttribute('aria-current', 'page');
  }
  const taskDirectory = app.getByRole('navigation', { name: 'To Doo 任务导航', exact: true });
  if (!(await taskDirectory.isVisible())) {
    await app.getByRole('navigation', { name: 'To Doo 主菜单', exact: true })
      .getByRole('button', { name: '展开清单导航', exact: true }).click();
    // A manually folded directory expands in place. A width-constrained dock
    // opens the combined drawer, keeping the task content at its minimum width.
    directory = await openToDooDirectory(page);
    if ((await directory.getAttribute('aria-label')) === 'To Doo 导航') return directory;
  }
  await expect(taskDirectory).toHaveCount(1);
  await expect(taskDirectory).toBeVisible();
  return taskDirectory;
}

async function selectCombinedDestination(directory: Awaited<ReturnType<typeof openToDooDirectory>>, label: string) {
  const button = directory.getByRole('button', { name: label === '任务' ? '所有任务' : label, exact: true, includeHidden: true });
  await expect(button).toHaveCount(1);
  if (!(await button.isVisible())) {
    const more = directory.locator('details.todo-navigation-more');
    await expect(more).toHaveCount(1);
    await more.locator('summary').click();
  }
  await button.click();
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
  const destination = label === '通知中心' ? '通知' : label;
  const directory = await openToDooDirectory(page);
  if ((await directory.getAttribute('aria-label')) === 'To Doo 导航') {
    await selectCombinedDestination(directory, destination);
  } else if (moduleLabels.has(label)) {
    const rail = directory.getByRole('navigation', { name: 'To Doo 主菜单', exact: true });
    const button = rail.getByRole('button', { name: destination, exact: true });
    if (await button.isVisible()) {
      await expect(button).toHaveCount(1);
      await button.click();
    } else {
      await rail.getByRole('button', { name: '更多模块', exact: true }).click();
      const popup = page.getByRole('group', { name: '更多模块', exact: true });
      await expect(popup).toBeVisible();
      await popup.getByRole('button', { name: destination, exact: true }).click();
      await expect(popup).not.toBeVisible();
    }
  } else {
    const tasks = await openTaskDirectory(page);
    if ((await tasks.getAttribute('aria-label')) === 'To Doo 导航') {
      await selectCombinedDestination(tasks, destination);
    } else {
      const button = tasks.getByRole('button', { name: destination, exact: true });
      if (await button.isVisible()) {
        await expect(button).toHaveCount(1);
        await button.click();
      } else {
        await tasks.getByRole('button', { name: '更多任务范围', exact: true }).click();
        const popup = page.getByRole('group', { name: '更多任务范围', exact: true });
        await expect(popup).toBeVisible();
        await popup.getByRole('button', { name: destination, exact: true }).click();
        await expect(popup).not.toBeVisible();
      }
    }
  }
  await closeToDooDirectory(page);
}

export async function selectToDooList(page: Page, name: string) {
  const directory = await openTaskDirectory(page);
  await directory
    .getByRole('region', { name: '我的清单', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
  await closeToDooDirectory(page);
}

/** Follow real collection pagination before asserting a newly seeded task in a shared fixture. */
export async function revealToDooTask(page: Page, title: string) {
  const task = page.getByRole('button', { name: title, exact: true });
  await page.locator('.todo-main[aria-busy="false"]').waitFor({ state: 'visible' });
  await page.locator('.todo-load-more button:disabled').first().waitFor({ state: 'hidden' });
  for (let pageNumber = 0; pageNumber < 50 && !(await task.isVisible()); pageNumber++) {
    let advanced = false;
    for (const [kind, label] of [
      ['task', '任务'],
      ['occurrence', '执行实例'],
    ] as const) {
      const more = page.getByRole('button', { name: '继续载入' + label, exact: true });
      if (!(await more.isVisible())) continue;
      await expect(more).toBeEnabled();
      const response = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === '/api/to-doo/state' &&
          url.searchParams.get('kind') === kind &&
          url.searchParams.has('cursor')
        );
      });
      await more.click();
      expect((await response).ok()).toBe(true);
      await page.locator('.todo-load-more button:disabled').first().waitFor({ state: 'hidden' });
      advanced = true;
      if (await task.isVisible()) break;
    }
    if (!advanced) break;
  }
  await expect(task).toBeVisible();
  return task;
}

/** Return to the DooKnow location without reaching through its hidden application shell. */
export async function returnFromToDoo(page: Page) {
  const button = page
    .getByRole('region', { name: 'To Doo 行动工作空间', exact: true })
    .getByRole('button', { name: '返回 DooKnow', exact: true });
  await expect(button).toHaveCount(1);
  await button.click();
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
  const picker = page.getByRole('combobox', { name: '任务展示方式', exact: true });
  const display = page.getByRole('button', { name: '任务显示与管理', exact: true });
  if (await display.count()) {
    if ((await display.getAttribute('aria-expanded')) !== 'true') await display.click();
    await expect(display).toHaveAttribute('aria-expanded', 'true');
  }
  await expect(picker).toBeVisible();
  await selectToDooOption(page, '任务展示方式', label);
  const popup = page.locator('.todo-task-display-popup:visible');
  if (await display.count() && (await display.getAttribute('aria-expanded')) === 'true')
    await popup.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(popup).toHaveCount(0);
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
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: '任务显示与管理', exact: true })).toBeVisible();
}
