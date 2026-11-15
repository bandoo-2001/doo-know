import type { Page } from '@playwright/test';
import { expect, test } from '../support/browser-test';
import { authenticateVisualContext } from '../support/to-doo-visual-fixture';

const screens = [
  [1024, 576], [1280, 720], [1366, 768], [1536, 864], [1920, 1080], [2560, 1440],
] as const;
const listName = '产品设计 · 本周交付';
const taskTitle = '梳理首页导航，确认用户最常访问的入口';

test.beforeEach(async ({ context }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC keyboard and pointer layouts');
  await authenticateVisualContext(context);
});

async function openList(page: Page) {
  const { token } = await (await page.request.get('/api/security/csrf')).json();
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': token },
      data: { action, requestId: crypto.randomUUID(), payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).ids[0] as string;
  }
  const listId = await command('save_entity', { kind: 'list', entity: { name: listName, color: '#477f73' } });
  const date = new Date().toISOString().slice(0, 10);
  await command('create_task', { listId, title: taskTitle, priority: 'high',
    plan: { date, time: '10:00', timeZone: 'UTC' },
    due: { date, time: '17:30', timeZone: 'UTC' },
    description: '结合上周访谈整理首屏入口，与开发一起确认交互细节。' });
  for (const title of [
    '核对表单的错误提示', '整理首轮访谈笔记', '复核无障碍键盘操作', '同步本次评审结论',
    '确认按钮的禁用状态', '更新移动端交付图', '补全搜索的空状态', '与团队确认上线清单',
    '检查日历的跨天安排', '复核暗色模式字色', '整理第二轮反馈', '更新周五的演示文稿',
  ]) await command('create_task', { listId, title });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listId);
  const main = page.locator('.todo-main');
  await expect(main).toHaveAttribute('aria-busy', 'false', { timeout: 20000 });
  await expect(main.getByRole('button', { name: taskTitle, exact: true })).toBeVisible();
  return main;
}

test('PC list, task reader and header share readable widths across laptop, scaled and large desktop viewports', async ({ page }, info) => {
  test.setTimeout(120000);
  const main = await openList(page);
  const capture = main.getByRole('form', { name: '快速添加任务' });
  const row = main.getByRole('button', { name: taskTitle, exact: true });
  for (const [width, height] of screens) {
    await page.setViewportSize({ width, height });
    await expect(main.getByRole('button', { name: '任务显示与管理' })).toBeInViewport({ ratio: 1 });
    const input = (await capture.boundingBox())!;
    const header = (await main.locator('.todo-page-heading').boundingBox())!;
    const pane = (await main.boundingBox())!;
    expect(input.width).toBeLessThanOrEqual(1665);
    if (width === 1920) {
      expect(input.width).toBeGreaterThanOrEqual(pane.width * .88);
      expect(input.x - pane.x).toBeLessThanOrEqual(96);
      const task = main.locator('.todo-task-row').filter({ has: page.getByRole('button', { name: taskTitle, exact: true }) });
      const dates = task.locator('.todo-task-date');
      await expect(dates).toHaveCount(2);
      const firstDate = (await dates.first().boundingBox())!;
      const secondDate = (await dates.last().boundingBox())!;
      expect(firstDate.x - input.x).toBeLessThan(input.width * .77);
      expect(secondDate.x).toBeGreaterThanOrEqual(firstDate.x + firstDate.width);
    }
    if (width === 2560) expect(input.width).toBeGreaterThanOrEqual(1600);
    expect(input.x).toBeCloseTo(header.x, 0);
    expect(input.width).toBeCloseTo(header.width, 0);
    expect(input.y + input.height).toBeLessThan(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 1920) await page.screenshot({ path: info.outputPath('pc-1920-list.png'), animations: 'disabled' });
  }
  await row.click();
  const reader = page.getByRole('complementary', { name: '任务详情', exact: true });
  for (const [width, height] of screens) {
    await page.setViewportSize({ width, height });
    await expect(reader.getByRole('textbox', { name: '任务标题' })).toHaveValue(taskTitle);
    await expect(reader.getByRole('button', { name: '保存任务' })).toBeInViewport({ ratio: 1 });
    const readerBox = (await reader.boundingBox())!;
    expect(readerBox.width).toBeCloseTo(Math.min(560, Math.max(400, width * 0.25)), 0);
    const input = (await capture.boundingBox())!;
    expect(input.width).toBeGreaterThanOrEqual(440);
    expect(input.x + input.width).toBeLessThanOrEqual(readerBox.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 1366 || width === 1920 || width === 2560)
      await page.screenshot({ path: info.outputPath('pc-' + width + '-reader.png'), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1024, height: 576 });
  await reader.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  const last = main.locator('.todo-task-row').last().locator('.todo-task-body');
  await last.focus();
  await last.scrollIntoViewIfNeeded();
  expect(await main.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await expect(main.getByRole('button', { name: '搜索任务' })).toBeInViewport({ ratio: 1 });
  await last.press('Home');
  const first = main.locator('.todo-task-body').first();
  await expect(first).toBeFocused();
  const header = (await main.locator('.todo-page-heading').boundingBox())!;
  expect((await first.boundingBox())!.y + 1).toBeGreaterThanOrEqual(header.y + header.height);
});

test('resizing from desktop to drawer keeps keyboard focus, the task draft and open navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const main = await openList(page);
  const directory = page.getByRole('navigation', { name: 'To Doo 任务导航', exact: true });
  const current = directory.locator('[aria-current="page"]');
  const menu = page.getByRole('button', { name: '功能导航', exact: true });
  await current.focus();
  await page.setViewportSize({ width: 991, height: 720 });
  await expect(menu).toBeFocused();
  await menu.press('Enter');
  const drawer = page.getByRole('dialog', { name: '功能导航', exact: true });
  await expect(drawer).toBeVisible();
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(drawer).toBeHidden();
  await expect(current).toBeFocused();
  await main.getByRole('button', { name: taskTitle, exact: true }).click();
  const title = page.getByRole('textbox', { name: '任务标题', exact: true });
  await title.fill('正在编辑的访谈摘要');
  await current.focus();
  await page.setViewportSize({ width: 1080, height: 720 });
  const expand = page.getByRole('button', { name: '展开清单导航', exact: true });
  await expect(expand).toBeFocused();
  await expand.press('Enter');
  const today = drawer.getByRole('button', { name: '今天', exact: true });
  await today.focus();
  await page.setViewportSize({ width: 1086, height: 720 });
  await expect(drawer).toBeInViewport();
  await expect(today).toBeFocused();
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(drawer).toBeHidden();
  await expect(current).toBeFocused();
  await expect(title).toHaveValue('正在编辑的访谈摘要');
  const more = page.getByRole('button', { name: '更多模块', exact: true });
  await more.press('Enter');
  const overview = page.getByRole('group', { name: '更多模块', exact: true }).getByRole('button', { name: '目标总览', exact: true });
  await overview.focus();
  await page.setViewportSize({ width: 1372, height: 768 });
  await expect(overview).toBeFocused();
  await overview.press('Escape');
  await expect(more).toBeFocused();
  await current.focus();
  await page.setViewportSize({ width: 1080, height: 720 });
  await expect(expand).toBeFocused();
  await page.setViewportSize({ width: 991, height: 720 });
  await expect(menu).toBeFocused();
});

test('scaled 1080p desktops keep popup controls and the reader within the CSS viewport', async ({ browser, page }, info) => {
  await openList(page);
  for (const scale of [1.25, 1.5]) {
    const viewport = { width: 1920 / scale, height: 1080 / scale };
    const scaled = await browser.newContext({ viewport, deviceScaleFactor: scale });
    try {
      await authenticateVisualContext(scaled);
      const tab = await scaled.newPage();
      await tab.goto(page.url());
      expect(await tab.evaluate(() => devicePixelRatio)).toBe(scale);
      const task = tab.locator('.todo-task-list-panel').getByRole('button', { name: taskTitle, exact: true });
      await task.click();
      const reader = tab.getByRole('complementary', { name: '任务详情', exact: true });
      await expect(reader.getByRole('button', { name: '保存任务' })).toBeInViewport({ ratio: 1 });
      const more = tab.getByRole('button', { name: '任务显示与管理' });
      await more.click();
      const form = tab.locator('.todo-task-display-form:visible');
      const bounds = (await form.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      await expect(form.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
      await form.getByRole('button', { name: '关闭', exact: true }).click();
      await expect(more).toBeFocused();
      await tab.screenshot({ path: info.outputPath('1080p-scale-' + scale + '.png'), animations: 'disabled' });
    } finally {
      await scaled.close();
    }
  }
});

test('wide focus puts the timer beside projects and leaves calendar and matrix canvases full width', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const timer = page.getByRole('region', { name: '专注计时器', exact: true });
  await expect(timer).toBeVisible();
  const projects = page.locator('.todo-focus-projects');
  const wideTimer = (await timer.boundingBox())!;
  const wideProjects = (await projects.boundingBox())!;
  expect(wideTimer.x + wideTimer.width).toBeLessThanOrEqual(wideProjects.x);
  const main = (await page.locator('.todo-main').boundingBox())!;
  const focusArea = (await page.locator('.todo-focus-workspace').boundingBox())!;
  expect(focusArea.width).toBeGreaterThanOrEqual(main.width * .85);
  expect(focusArea.x - main.x).toBeLessThanOrEqual(112);
  await page.setViewportSize({ width: 1366, height: 768 });
  const laptopTimer = (await timer.boundingBox())!;
  expect(laptopTimer.y + laptopTimer.height).toBeLessThanOrEqual((await projects.boundingBox())!.y);
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const [section, selector] of [['calendar', '.todo-month-day'], ['matrix', '.todo-quadrant']]) {
    await page.goto('/?view=apps&app=to-doo&appSection=' + section);
    await expect(page.locator(selector).first()).toBeVisible();
    expect((await page.locator('.todo-content').boundingBox())!.width).toBeGreaterThan(1200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1920);
  }
});
