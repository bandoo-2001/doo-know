import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.use({ timezoneId: 'Pacific/Kiritimati' });
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('a month query includes the entire displayed grid rather than only the anchor week', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const initial = await (await page.request.get('/api/to-doo/state')).json();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const title = '月初的真实安排 ' + info.project.name;
  const created = await page.request.post('/api/to-doo/commands', {
    headers: {
      origin: `http://127.0.0.1:${process.env.DOOKNOW_E2E_WEB_PORT || 4179}`,
      'x-csrf-token': csrf.token,
    },
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: {
        kind: 'timeBlock',
        entity: {
          title,
          start: { date: '2026-10-01', time: '10:00', timeZone: initial.settings.timeZone },
          durationMinutes: 30,
        },
      },
    },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=month&date=2026-10-30');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.locator('.todo-month')).toBeVisible();
  await expect(
    app.locator('.todo-month').getByRole('button').filter({ hasText: title }),
  ).toBeVisible();
});

test('the initial review interval uses dataset time rather than a different browser day', async ({
  page,
}) => {
  const initial = await (await page.request.get('/api/to-doo/state')).json();
  const point = new Date(initial.now);
  point.setUTCHours(23, 30, 0, 0);
  await page.clock.setFixedTime(point);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const changed = await page.request.post('/api/to-doo/commands', {
    headers: {
      origin: `http://127.0.0.1:${process.env.DOOKNOW_E2E_WEB_PORT || 4179}`,
      'x-csrf-token': csrf.token,
    },
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: {
        kind: 'settings',
        entity: { ...initial.settings, timeZone: 'UTC' },
        expectedRevision: initial.settings.revision,
      },
    },
  });
  expect(changed.ok()).toBe(true);
  const to = point.toISOString().slice(0, 10),
    from = new Date(point.getTime() - 6 * 86400000).toISOString().slice(0, 10);
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.locator('.todo-completion-chart')).toHaveAttribute(
    'aria-label',
    new RegExp('^' + from + ' — ' + to),
  );
  await expect(app.getByLabel('统计开始日期', { exact: true })).toHaveValue(from);
  await expect(app.getByLabel('统计结束日期', { exact: true })).toHaveValue(to);
});
