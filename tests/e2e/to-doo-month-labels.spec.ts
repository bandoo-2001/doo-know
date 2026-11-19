import { readFile } from 'node:fs/promises';
import { toDooEntitySchemas } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('month cards show names in time order while tooltips, details, week and agenda retain times', async ({
  page,
}, info) => {
  const date = '2032-05-03';
  const stamp = {
    revision: 'month-display',
    createdAt: date + 'T00:00:00Z',
    updatedAt: date + 'T00:00:00Z',
  };
  const block = (
    id: string,
    title: string,
    time: string | null,
    extra: Record<string, unknown> = {},
  ) =>
    toDooEntitySchemas.timeBlock.parse({
      ...stamp,
      id,
      title,
      start: { date, time, timeZone: 'UTC' },
      durationMinutes: 45,
      ...extra,
    });
  const blocks = [
    block('late', '下午安排', '16:00'),
    block('untimed', '待定安排', null),
    block('early', '早间安排', '08:00'),
    block('all-day', '整日安排', null, { allDay: true, durationMinutes: 1440 }),
    block('overnight', '夜间延续', '23:45', {
      start: { date: '2032-05-02', time: '23:45', timeZone: 'UTC' },
    }),
  ];
  const external = toDooEntitySchemas.calendarEvent.parse({
    ...stamp,
    id: 'external',
    uid: 'external',
    title: '外部会议',
    readOnly: true,
    start: { date, time: '10:00', timeZone: 'UTC' },
    end: { date, time: '10:30', timeZone: 'UTC' },
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
    snapshot.settings = { ...snapshot.settings, timeZone: 'UTC' };
    snapshot.timeBlocks = blocks;
    snapshot.calendarEvents = [external];
    snapshot.tasks = [];
    snapshot.occurrences = [];
    await route.fulfill({ response, json: snapshot });
  });
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=month&date=' + date);
  if (info.project.name === 'mobile') await page.getByText('网格', { exact: true }).click();
  const day = page.locator('.todo-month-day[aria-label="' + date + ' 日程"]');
  const cards = day.locator('.todo-calendar-event');
  await expect(cards).toHaveCount(6);
  await expect(cards).toHaveText([
    '整日安排',
    '夜间延续',
    '早间安排',
    '外部会议',
    '下午安排',
    '待定安排',
  ]);
  const early = cards.filter({ hasText: '早间安排' });
  await expect(early).toHaveAttribute('title', /08:00/);
  await expect(early).toHaveAttribute('title', /08:45/);
  await expect(early).toHaveAttribute('aria-label', /早间安排/);
  const meeting = cards.filter({ hasText: '外部会议' });
  await expect(meeting).toHaveAttribute('title', /10:00/);
  await expect(meeting).toHaveAttribute('title', /10:30/);
  await expect(meeting).toHaveAttribute('title', /只读/);
  await expect(cards.filter({ hasText: '待定安排' })).toHaveAttribute('title', /未指定时刻/);
  await page.screenshot({
    path: info.outputPath('month-clean-labels.png'),
    animations: 'disabled',
  });
  await meeting.click({ timeout: 5000 });
  const detail = page.getByRole('dialog', { name: '外部日历事件', exact: true });
  await expect(detail).toContainText('10:00');
  await expect(detail).toContainText('10:30');
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=week&date=' + date);
  await expect(
    page.locator('.todo-week-event').filter({ hasText: '早间安排' }).locator('small'),
  ).toContainText('08:00');
  if (info.project.name === 'mobile') {
    await expect(page.locator('.todo-mobile-agenda')).toBeVisible();
    await expect(
      page.locator('.todo-mobile-agenda').getByRole('button').filter({ hasText: '早间安排' }),
    ).toContainText('08:00');
  }
  expect(writes).toBe(0);
});
