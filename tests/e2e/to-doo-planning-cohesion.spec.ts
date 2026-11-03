import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('calendar display settings fold without resetting layers or manual week position', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=week&date=2030-01-01');
  const viewport = page.getByRole('region', {
    name: '每周时间安排，包含全部 24 小时',
    exact: true,
  });
  await expect(viewport).toBeVisible();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(8 * 46);
  await expect(page.locator('.todo-week-slot')).toHaveCount(7 * 24);
  await viewport.evaluate((element) => {
    element.scrollTop = 100;
  });
  await expect(page.getByLabel('跳转日期', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '显示内容', exact: true }).click();
  await expect(page.getByLabel('跳转日期', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '外部日历', exact: true }).uncheck();
  await page.getByRole('button', { name: '显示内容', exact: true }).click();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(100);
  await page.getByRole('button', { name: '显示内容', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '外部日历', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '下一周期', exact: true }).click();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(8 * 46);
  await viewport.focus();
  await page.keyboard.press('Home');
  await expect(page.locator('.todo-week-head')).toBeVisible();
});

test('a narrow calendar hides empty dates while keeping every date and creation reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=month&date=2030-01-15');
  const agenda = page.locator('.todo-mobile-agenda');
  await expect(agenda).toBeVisible();
  await expect(agenda.locator('.todo-agenda-day[data-date="2030-01-15"]')).toBeVisible();
  const initial = await agenda.locator('.todo-agenda-day').count();
  await agenda.getByRole('button', { name: '显示空白日期', exact: true }).click();
  await expect(agenda.locator('.todo-agenda-day')).toHaveCount(31);
  const emptyDay = agenda.locator('.todo-agenda-day[data-date="2030-01-02"]');
  await emptyDay.getByRole('button', { name: '＋ 添加安排', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '新建时间安排', exact: true })).toBeVisible();
  await page
    .getByRole('dialog', { name: '新建时间安排', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await agenda.getByRole('button', { name: '隐藏空白日期', exact: true }).click();
  await expect(agenda.locator('.todo-agenda-day')).toHaveCount(initial);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});

test('a crowded all-day area keeps every row and timed events reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const id = 'calendar-crowded-' + crypto.randomUUID();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const stamp = {
    revision: 'r1',
    createdAt: '2026-11-01T12:00:00Z',
    updatedAt: '2026-11-01T12:00:00Z',
  };
  const entities: { kind: 'timeBlock'; entity: Record<string, unknown> }[] = Array.from(
    { length: 28 },
    (_, index) => ({
      kind: 'timeBlock',
      entity: {
        ...stamp,
        id: `${id}-${index}`,
        title: `全天安排 ${id} ${index}`,
        allDay: true,
        start: { date: '2031-05-05', time: null, timeZone: 'UTC' },
        durationMinutes: 1440,
      },
    }),
  );
  entities.push({
    kind: 'timeBlock',
    entity: {
      ...stamp,
      id: id + '-timed',
      title: '可点击的定时安排 ' + id,
      allDay: false,
      start: { date: '2031-05-05', time: '13:00', timeZone: 'UTC' },
      durationMinutes: 60,
    },
  });
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action: 'import_entities', payload: { entities } },
  });
  expect(response.ok()).toBe(true);
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=week&date=2031-05-05');
  const viewport = page.getByRole('region', {
    name: '每周时间安排，包含全部 24 小时',
    exact: true,
  });
  const allDay = page.getByRole('region', { name: '全天安排与截止', exact: true });
  await expect(allDay).toBeVisible();
  await expect(allDay.locator('.todo-calendar-event')).toHaveCount(28);
  await allDay
    .getByRole('button', { name: `全天 · 全天安排 ${id} 27`, exact: true })
    .scrollIntoViewIfNeeded();
  await expect.poll(() => allDay.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const header = await page.locator('.todo-week-head').boundingBox();
  const frame = await viewport.boundingBox();
  expect(header!.height).toBeLessThan(frame!.height / 2);
  const timed = page.locator('.todo-week-event').filter({ hasText: '可点击的定时安排 ' + id });
  await timed.click();
  await expect(page.getByRole('dialog', { name: '编辑时间安排', exact: true })).toBeVisible();
});
