import { readFile, mkdir } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.clock.setFixedTime(new Date('2032-05-03T12:00:00Z'));
});

const stamp = {
  revision: 'r1',
  createdAt: '2032-05-01T08:00:00Z',
  updatedAt: '2032-05-01T08:00:00Z',
};

test('overnight segments, short-event details, original editing and mobile grid remain reachable', async ({
  page,
}, info) => {
  const before = await (await page.request.get('/api/to-doo/state')).json();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const command = async (action: string, payload: unknown) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  await command('save_entity', {
    kind: 'settings',
    entity: { ...before.settings, timeZone: 'UTC', defaultDurationMinutes: 45 },
    expectedRevision: before.settings.revision,
  });
  const id = 'audit-calendar-' + crypto.randomUUID();
  await command('import_entities', {
    entities: [
      {
        kind: 'timeBlock',
        entity: {
          ...stamp,
          id: id + '-night',
          title: '跨午夜九十分钟',
          start: { date: '2032-05-03', time: '23:30', timeZone: 'UTC' },
          durationMinutes: 90,
        },
      },
      {
        kind: 'timeBlock',
        entity: {
          ...stamp,
          id: id + '-short',
          title: '五分钟完整长标题：审阅未来四周的任务安排并确认',
          start: { date: '2032-05-03', time: '09:00', timeZone: 'UTC' },
          durationMinutes: 5,
        },
      },
      {
        kind: 'timeBlock',
        entity: {
          ...stamp,
          id: id + '-overlap',
          title: '相交短事件',
          start: { date: '2032-05-03', time: '09:02', timeZone: 'UTC' },
          durationMinutes: 5,
        },
      },
      {
        kind: 'timeBlock',
        entity: {
          ...stamp,
          id: id + '-afternoon',
          title: '独立的下午安排',
          start: { date: '2032-05-03', time: '15:00', timeZone: 'UTC' },
          durationMinutes: 30,
        },
      },
      {
        kind: 'calendarEvent',
        entity: {
          ...stamp,
          id: id + '-external',
          uid: id,
          title: '外部会议有起止和时长',
          readOnly: true,
          start: { date: '2032-05-03', time: '10:00', timeZone: 'UTC' },
          end: { date: '2032-05-03', time: '10:45', timeZone: 'UTC' },
        },
      },
    ],
  });
  const shots = 'docs/design/to-doo/audit-fixes-2026-11-03/calendar';
  await mkdir(shots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=week&date=2032-05-03');
  const night = page.locator('.todo-week-event').filter({ hasText: '跨午夜九十分钟' });
  await expect(night).toHaveCount(2);
  await expect(night.nth(0)).toHaveAccessibleName('跨午夜九十分钟 23:30 30分钟');
  await expect(night.nth(1)).toHaveAccessibleName('跨午夜九十分钟 00:00 60分钟');
  const short = page.locator('.todo-week-event').filter({ hasText: '五分钟完整长标题' });
  await short.focus();
  await expect(page.getByRole('status').filter({ hasText: '五分钟完整长标题' })).toContainText(
    '09:00—09:05 · 5 分钟',
  );
  const afternoon = page.locator('.todo-week-event').filter({ hasText: '独立的下午安排' });
  expect(
    await afternoon.evaluate(
      (element) =>
        element.getBoundingClientRect().width /
        element.parentElement!.getBoundingClientRect().width,
    ),
  ).toBeGreaterThan(0.9);
  await page.screenshot({ path: `${shots}/${info.project.name}-desktop-week.png`, fullPage: true });
  await night.nth(1).click();
  const dialog = page.getByRole('dialog', { name: '编辑时间安排', exact: true });
  await expect(dialog.getByLabel('时长（分钟）', { exact: true })).toHaveValue('90');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(async () => {
    const modulePath = '/preferences.ts';
    const preferences = await import(modulePath);
    preferences.setEditorPreferences({ theme: 'dark' });
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const agenda = page.locator('.todo-mobile-agenda');
  await expect(agenda).toBeVisible();
  await expect(
    agenda.getByRole('button').filter({ hasText: '外部会议有起止和时长' }),
  ).toContainText('10:00—10:45 · 45 分钟');
  await page.screenshot({ path: `${shots}/${info.project.name}-phone-agenda.png`, fullPage: true });
  await page.getByText('网格', { exact: true }).click();
  const grid = page.getByRole('region', { name: '日历网格，可横向滚动', exact: true });
  await expect(grid).toBeVisible();
  await expect(agenda).not.toBeVisible();
  expect(await grid.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await grid.evaluate((element) => {
    element.scrollLeft = 300;
  });
  await grid.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await page.locator('.todo-week-viewport').evaluate((element) => {
    element.scrollTop = 8 * 46;
  });
  await page.screenshot({
    path: `${shots}/${info.project.name}-phone-week-grid.png`,
    fullPage: true,
  });
  await page.getByText('议程', { exact: true }).click();
  await expect(agenda).toBeVisible();
  await page.getByRole('button', { name: '＋ 时间安排', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建时间安排', exact: true });
  await expect(create.getByLabel('时长（分钟）', { exact: true })).toHaveValue('45');
  await create.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByText('网格', { exact: true }).click();
  await page.getByText('月', { exact: true }).click();
  await expect(page.locator('.todo-month')).toBeVisible();
  await page.screenshot({
    path: `${shots}/${info.project.name}-phone-month-grid.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});

test('phone timeline keeps day width and sticky task titles while scrolling', async ({
  page,
}, info) => {
  const initial = await (await page.request.get('/api/to-doo/state')).json();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token };
  const settings = await page.request.post('/api/to-doo/commands', {
    headers,
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: {
        kind: 'settings',
        expectedRevision: initial.settings.revision,
        entity: { ...initial.settings, timeZone: 'Asia/Shanghai' },
      },
    },
  });
  expect(settings.ok()).toBe(true);
  const id = 'audit-timeline-' + crypto.randomUUID();
  const imported = await page.request.post('/api/to-doo/commands', {
    headers,
    data: {
      requestId: crypto.randomUUID(),
      action: 'import_entities',
      payload: {
        entities: [
          {
            kind: 'task',
            entity: { ...stamp, id: id + '-task', title: '跨窗口全天安排与跨时区截止' },
          },
          {
            kind: 'occurrence',
            entity: {
              ...stamp,
              id: id + '-occ',
              taskId: id + '-task',
              cycleKey: 'once',
              scheduleRevision: 'r1',
              due: { date: '2032-05-03', time: '18:30', timeZone: 'UTC' },
            },
          },
          {
            kind: 'timeBlock',
            entity: {
              ...stamp,
              id: id + '-block',
              occurrenceId: id + '-occ',
              allDay: true,
              title: '跨窗口全天安排',
              start: { date: '2032-04-30', time: null, timeZone: 'UTC' },
              dateEndExclusive: '2032-05-06',
              durationMinutes: 30,
            },
          },
        ],
      },
    },
  });
  expect(imported.ok()).toBe(true);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=timeline&date=2032-05-03');
  const region = page.getByRole('region', { name: '任务时间线，可横向滚动', exact: true });
  await expect(region).toBeVisible();
  const bar = page.locator('.todo-timeline-bar').filter({ hasText: '2032-04-30' });
  await expect(bar).toHaveCount(1);
  expect(await bar.evaluate((element) => (element as HTMLElement).style.gridColumn)).toBe(
    '1 / span 3',
  );
  await expect(
    page.getByRole('button', {
      name: '截止 2032-05-04 02:30 跨窗口全天安排与跨时区截止',
      exact: true,
    }),
  ).toBeVisible();
  const title = page
    .locator('.todo-timeline-row > .todo-task-body')
    .filter({ hasText: '跨窗口全天安排与跨时区截止' });
  await page.screenshot({
    path: `docs/design/to-doo/audit-fixes-2026-11-03/calendar/${info.project.name}-phone-timeline-initial.png`,
    fullPage: true,
  });
  const before = await title.boundingBox();
  await region.evaluate((element) => {
    element.scrollLeft = 500;
  });
  const after = await title.boundingBox();
  expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1);
  expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.screenshot({
    path: `docs/design/to-doo/audit-fixes-2026-11-03/calendar/${info.project.name}-phone-timeline.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});
