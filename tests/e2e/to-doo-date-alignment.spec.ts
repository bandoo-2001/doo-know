import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function fixture(page: Page) {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = crypto.randomUUID().slice(0, 6);
  const titles = ['检查计划与截止日期 ', '检查单独截止日期 ', '检查子任务日期 '].map(
    (title) => title + suffix,
  );
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const command = async (action: string, payload: any) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).ids[0] as string;
  };
  const listId = await command('save_entity', {
    kind: 'list',
    entity: { name: '日期对齐 ' + suffix },
  });
  const parent = await command('create_task', {
    listId,
    title: titles[0],
    priority: 'high',
    plan: { date, time: '10:00', timeZone: 'UTC' },
    due: { date, time: '17:30', timeZone: 'UTC' },
  });
  await command('create_task', { listId, title: titles[1], due: { date, timeZone: 'UTC' } });
  await command('create_task', {
    listId,
    parentTaskId: parent,
    title: titles[2],
    due: { date, time: '18:00', timeZone: 'UTC' },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listId);
  await expect(page.getByRole('button', { name: titles[0], exact: true })).toBeVisible();
  return titles.map((title) =>
    page
      .locator('.todo-task-row')
      .filter({ has: page.getByRole('button', { name: title, exact: true }) }),
  );
}
async function rightAligned(row: Locator) {
  const dates = row.locator('.todo-task-date');
  const last = (await dates.last().boundingBox())!;
  const menu = (await row.locator('.todo-task-menu-trigger').boundingBox())!;
  const body = (await row.locator('.todo-task-body').boundingBox())!;
  const group = (await row.locator('.todo-task-dates').boundingBox())!;
  const gap = await row.evaluate((element) => parseFloat(getComputedStyle(element).columnGap));
  expect(menu.x - last.x - last.width).toBeCloseTo(gap, 0);
  expect(body.x + body.width).toBeLessThanOrEqual(group.x + 1);
  expect(last.x + last.width).toBeLessThanOrEqual(menu.x);
}
test('wide list dates align with the right action column for single, dual and nested dates', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop');
  const rows = await fixture(page);
  for (const [width, height] of [
    [1920, 1080],
    [2560, 1440],
    [1530, 1165],
  ]) {
    await page.setViewportSize({ width, height });
    for (const row of rows) await rightAligned(row);
    if (width === 1920)
      await page.screenshot({
        path: info.outputPath('date-right-aligned-1920.png'),
        animations: 'disabled',
      });
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await rows[0].locator('.todo-task-body').click();
  await expect(page.getByRole('complementary', { name: '任务详情', exact: true })).toBeVisible();
  for (const row of rows) await rightAligned(row);
});
test('mobile dates retain their separate row and fit inside the task', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile');
  const rows = await fixture(page);
  for (const row of rows) {
    const body = (await row.locator('.todo-task-body').boundingBox())!;
    const dates = (await row.locator('.todo-task-dates').boundingBox())!;
    const bounds = (await row.boundingBox())!;
    expect(dates.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
    expect(dates.x + dates.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    await expect(row.locator('.todo-task-dates')).toHaveCSS('justify-content', 'flex-start');
  }
});
