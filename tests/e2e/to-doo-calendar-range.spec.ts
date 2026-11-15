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


test('month geometry stays within the viewport and settings never move the date grid', async ({ page }, info) => {
  const initial = await (await page.request.get('/api/to-doo/state')).json();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const prefix = '月格滚动验收 ' + info.project.name + ' ' + crypto.randomUUID().slice(0, 6);
  for (let index = 0; index < 8; index++) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: {
        origin: 'http://127.0.0.1:' + (process.env.DOOKNOW_E2E_WEB_PORT || 4179),
        'x-csrf-token': csrf.token,
      },
      data: {
        requestId: crypto.randomUUID(), action: 'save_entity',
        payload: { kind: 'timeBlock', entity: {
          title: prefix + ' ' + index,
          start: { date: '2026-10-01', time: String(9 + index).padStart(2, '0') + ':00', timeZone: initial.settings.timeZone },
          durationMinutes: 30,
        } },
      },
    });
    expect(response.ok()).toBe(true);
  }
  for (const size of [{ width: 1440, height: 900 }, { width: 1080, height: 812 }, { width: 768, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=month&date=2026-10-30');
    const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
    // This can be the first cold workspace load in the browser project.
    await expect(app).toBeVisible({ timeout: 20000 });
    if (size.width === 390) {
      await expect(app.locator('.todo-mobile-agenda')).toBeVisible();
      await app.getByText('网格', { exact: true }).click();
    }
    const month = app.locator('.todo-month');
    await expect(month).toBeVisible();
    await expect(month.locator('.todo-month-day')).toHaveCount(42);
    const lastDay = await month.locator('.todo-month-day').last().boundingBox();
    expect(lastDay).not.toBeNull();
    const bottomNavigation = app.locator('.todo-bottom-navigation');
    const contentBottom = await bottomNavigation.isVisible() ? (await bottomNavigation.boundingBox())!.y : size.height;
    expect(lastDay!.y + lastDay!.height).toBeLessThanOrEqual(contentBottom + 1);
    const firstDay = await month.locator('.todo-month-day').first().boundingBox();
    expect(firstDay!.y).toBeGreaterThanOrEqual(0);
    const events = month.locator('.todo-month-day[aria-label="2026-10-01 日程"] .todo-month-day-events');
    expect(await events.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const lastEvent = events.getByRole('button').filter({ hasText: prefix }).last();
    await lastEvent.focus();
    await expect(lastEvent).toBeInViewport();
    expect(await events.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const before = await month.boundingBox();
    const display = app.getByRole('button', { name: '显示内容', exact: true });
    await display.click();
    await expect(page.getByLabel('跳转日期', { exact: true })).toBeVisible();
    const after = await month.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('跳转日期', { exact: true })).not.toBeVisible();
    await expect(display).toBeFocused();
  }
});
