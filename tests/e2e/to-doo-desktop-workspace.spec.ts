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
    description: '结合上周访谈整理首屏入口，与开发一起确认交互细节。' });
  for (const title of [
    '核对表单的错误提示', '整理首轮访谈笔记', '复核无障碍键盘操作', '同步本次评审结论',
    '确认按钮的禁用状态', '更新移动端交付图', '补全搜索的空状态', '与团队确认上线清单',
    '检查日历的跨天安排', '复核暗色模式字色', '整理第二轮反馈', '更新周五的演示文稿',
  ]) await command('create_task', { listId, title });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listId);
  const main = page.locator('.todo-main');
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
    expect(input.width).toBeLessThanOrEqual(1201);
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
});
