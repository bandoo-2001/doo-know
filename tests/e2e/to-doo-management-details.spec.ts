import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { toDooEntitySchemas } from '../../shared/to-doo-contracts';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('long goal and review content keeps icons, counts and progress inside its row', async ({
  page,
}, info) => {
  const now = new Date().toISOString();
  const stamp = { revision: 'fixture', createdAt: now, updatedAt: now };
  const goal = toDooEntitySchemas.list.parse({
    ...stamp,
    id: 'management-detail-goal',
    name: '统一设计与交付体验'.repeat(15),
    kind: 'goal',
    icon: '🎨',
    color: '#9470b8',
  });
  const review = toDooEntitySchemas.review.parse({
    ...stamp,
    id: 'management-detail-review',
    name: '本周经验与下一步行动'.repeat(15),
    from: '2026-11-10',
    to: '2026-11-16',
    capturedAt: now,
    content: 'LongUnbrokenReviewSummary'.repeat(20),
  });
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  // Render long-content edge cases without altering the shared task dataset.
  await page.route('**/api/to-doo/state?**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    data.lists = [...(data.lists || []).filter((list: any) => list.id !== goal.id), goal];
    data.reviews = [review];
    data.statistics = {
      ...data.statistics,
      byList: { ...data.statistics?.byList, [goal.id]: { total: 23456, completed: 1234 } },
    };
    await route.fulfill({ response, json: data });
  });
  await page.goto('/?view=apps&app=to-doo&appSection=stats&appPage=goals');
  const row = page
    .locator('.todo-progress-row')
    .filter({ has: page.getByRole('button', { name: '查看目标任务 ' + goal.name, exact: true }) });
  await expect(row.locator('.todo-list-icon')).toHaveText('🎨');
  await expect(row.locator('.todo-review-goal-count')).toHaveText('1234/23456');
  await expect(row.locator('.todo-review-goal-count')).toHaveCSS('white-space', 'nowrap');
  const bounds = (await row.boundingBox())!,
    count = (await row.locator('.todo-review-goal-count').boundingBox())!;
  const inset = await row.evaluate(element => {
    const style = getComputedStyle(element);
    return parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
  });
  expect(count.x + count.width).toBeCloseTo(bounds.x + bounds.width - inset, 0);
  expect(
    await row.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    await page
      .locator('.todo-review')
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('long-goal-progress.png'),
    animations: 'disabled',
  });
  await page.goto('/?view=apps&app=to-doo&appSection=stats&appPage=reviews');
  const article = page.getByRole('article', { name: '复盘 ' + review.name, exact: true });
  const button = article.getByRole('button', { name: '打开复盘 ' + review.name, exact: true });
  const icon = button.locator(':scope > svg');
  await expect(icon).toBeVisible();
  const buttonBounds = (await button.boundingBox())!,
    iconBounds = (await icon.boundingBox())!;
  expect(iconBounds.width).toBeGreaterThanOrEqual(15.5);
  expect(
    Math.abs(buttonBounds.y + buttonBounds.height / 2 - iconBounds.y - iconBounds.height / 2),
  ).toBeLessThanOrEqual(1);
  expect(
    await article.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await expect(
    article.getByRole('button', { name: '＋ 添加下一步任务', exact: true }).locator('svg'),
  ).toBeVisible();
  await page.goto('/?view=apps&app=to-doo&appSection=settings&appPage=lists');
  for (const name of ['查看已归档任务', '查看任务回收站']) {
    const link = page.getByRole('button', { name, exact: true });
    await expect(link.locator('svg')).toBeVisible();
    const linkBox = (await link.boundingBox())!,
      arrowBox = (await link.locator('svg').boundingBox())!;
    expect(
      Math.abs(linkBox.y + linkBox.height / 2 - arrowBox.y - arrowBox.height / 2),
    ).toBeLessThanOrEqual(1);
  }
  expect(writes).toBe(0);
});

test('notification date picker closes before its filter and returns focus to the trigger', async ({
  page,
}) => {
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=notifications&appPage=all');
  const trigger = page.getByRole('button', { name: '打开通知筛选', exact: true });
  await trigger.click();
  const filter = page.getByRole('form', { name: '通知筛选', exact: true });
  await expect(filter).toBeVisible();
  const date = filter.getByRole('textbox', { name: '通知开始日期', exact: true });
  await date.click();
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeVisible();
  await date.press('Escape');
  await expect(page.locator('.ant-picker-dropdown:visible')).toBeHidden();
  await expect(filter).toBeVisible();
  await filter.getByRole('searchbox', { name: '搜索通知', exact: true }).press('Escape');
  await expect(filter).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(writes).toBe(0);
});
