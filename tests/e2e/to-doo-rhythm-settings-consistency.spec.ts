import { readFile } from 'node:fs/promises';
import { toDooEntitySchemas } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context, page }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize(
    info.project.name === 'desktop' ? { width: 1920, height: 1080 } : { width: 390, height: 844 },
  );
});

test('preference tabs avoid a repeated heading and keep dirty feedback from moving fields', async ({
  page,
}, info) => {
  let writes = 0;
  await page.route('**/api/to-doo/commands', async (route) => {
    writes++;
    await route.abort();
  });
  await page.goto('/?view=apps&app=to-doo&appSection=settings&appPage=preferences');
  await expect(page.getByRole('tab', { name: '偏好', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('heading', { name: '日常偏好', exact: true })).toHaveCount(0);
  const surface = page.locator('.todo-settings-preferences');
  const header = surface.locator('.todo-settings-preferences-heading');
  await expect(header).toContainText('修改后点击「保存偏好」生效。');
  await expect(header).toHaveCSS('border-bottom-width', '0px');
  const duration = surface.getByRole('spinbutton', { name: '默认安排分钟', exact: true });
  await expect(duration).toBeVisible();
  const original = await duration.inputValue();
  const before = (await duration.boundingBox())!;
  await duration.fill(original === '37' ? '38' : '37');
  await expect(header.getByRole('status')).toHaveText('有未保存的更改');
  const after = (await duration.boundingBox())!;
  expect(after.y).toBeCloseTo(before.y, 0);
  expect(after.x).toBeCloseTo(before.x, 0);
  await page.screenshot({
    path: info.outputPath('preferences-consistent.png'),
    animations: 'disabled',
  });
  await duration.fill(original);
  await expect(header.getByRole('status')).toHaveCount(0);
  expect(writes).toBe(0);
});

test('habit history dates stay with their controls and point at the corresponding result table', async ({
  page,
}, info) => {
  const stamp = {
    revision: 'grouping',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const habit = toDooEntitySchemas.habit.parse({
    ...stamp,
    id: 'habit-grouping-example',
    name: '核对习惯日期范围',
    startDate: '2026-01-01',
    timeZone: 'UTC',
  });
  let writes = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      writes++;
      return route.abort();
    }
    if (new URL(request.url()).pathname !== '/api/to-doo/state') return route.continue();
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.habits = [habit];
    snapshot.settings = { ...snapshot.settings, timeZone: 'UTC' };
    await route.fulfill({ response, json: snapshot });
  });
  await page.goto('/?view=apps&app=to-doo&appSection=habits&appPage=history');
  const range = page.locator('[aria-label="习惯历史区间"]');
  await expect(range).toBeVisible();
  expect(await range.evaluate((element) => element.tagName)).toBe('SPAN');
  const controls = page.locator('.todo-life-toolbar');
  await expect(controls).toHaveAttribute('aria-controls', 'to-doo-habit-results');
  const results = page.locator('#to-doo-habit-results');
  await expect(results).toBeVisible();
  await expect(results.locator('.todo-habit-row.head > span')).toHaveCount(8);
  const initial = await range.textContent();
  await controls.getByRole('button', { name: '上一周', exact: true }).click();
  await expect(range).not.toHaveText(initial!);
  await controls.getByRole('button', { name: '下一周', exact: true }).click();
  await expect(range).toHaveText(initial!);
  for (const name of ['上一周', '下一周']) {
    const button = controls.getByRole('button', { name, exact: true });
    const bounds = (await button.boundingBox())!,
      icon = (await button.locator('svg').boundingBox())!;
    expect(Math.abs(bounds.y + bounds.height / 2 - icon.y - icon.height / 2)).toBeLessThanOrEqual(
      1,
    );
  }
  const topbar = page.locator('.todo-topbar');
  await expect(topbar).toBeInViewport({ ratio: 1 });
  const top = (await topbar.boundingBox())!;
  const title = (await page.getByRole('heading', { name: '习惯', exact: true }).boundingBox())!;
  expect(title.y).toBeGreaterThanOrEqual(top.y + top.height);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('habit-history-grouping.png'),
    animations: 'disabled',
  });
  expect(writes).toBe(0);
});
