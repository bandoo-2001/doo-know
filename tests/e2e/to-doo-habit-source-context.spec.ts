import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { isolateHabitTestReminderOverlays } from '../support/to-doo-habit-fixture';
import { localDate } from '../../packages/core/to-doo/recurrence';

test('a habit source opens the exact focus record and can return to all focus history', async ({
  page,
  context,
}, info) => {
  test.setTimeout(90_000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await isolateHabitTestReminderOverlays(context);
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 320, height: 844 } : { width: 1920, height: 1080 },
  );
  const stateResponse = await page.request.get('/api/to-doo/state?limit=200');
  expect(stateResponse.ok()).toBe(true);
  const snapshot = await stateResponse.json();
  const today = localDate(new Date(snapshot.now), snapshot.settings.timeZone);
  const suffix = info.project.name + '-' + crypto.randomUUID().slice(0, 8);
  const sourceId = 'habit-source-session-' + suffix;
  const otherId = 'habit-other-session-' + suffix;
  const habitId = 'habit-source-' + suffix;
  const name = '阅读与摘录 · 来源验证 ' + suffix;
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  for (const [index, id] of [sourceId, otherId].entries()) {
    const end = Date.parse(snapshot.now) - (1 + index * 30) * 60_000;
    await command('save_entity', {
      kind: 'focusSession',
      entity: {
        id,
        mode: 'stopwatch',
        status: 'finished',
        topicName: index ? '另一条专注 · ' + suffix : '习惯来源专注 · ' + suffix,
        segments: [
          { start: new Date(end - 15 * 60_000).toISOString(), end: new Date(end).toISOString() },
        ],
        note: index ? '用于确认解除来源筛选后恢复完整历史。' : '这次专注是习惯打卡的真实来源。',
      },
    });
  }
  await command('save_entity', {
    kind: 'habit',
    entity: {
      id: habitId,
      name,
      icon: '📚',
      goalMode: 'quantity',
      target: 60,
      unit: '分钟',
      startDate: today,
      timeZone: snapshot.settings.timeZone,
      reminders: [],
    },
  });
  await command('import_entities', {
    entities: [
      {
        kind: 'habitEntry',
        entity: {
          id: habitId + '-entry',
          habitId,
          localDate: today,
          occurredAt: snapshot.now,
          amount: 15,
          sourceSessionId: sourceId,
          note: '完成专注后记录了阅读投入。',
        },
      },
    ],
  });
  await page.goto('/?view=apps&app=to-doo&appSection=habits&appPage=today');
  await expect(page.locator('.todo-habit-cards')).toHaveAttribute('aria-busy', 'false');
  const habit = page.getByRole('article', { name: '习惯 ' + name, exact: true });
  await habit.getByRole('button', { name, exact: true }).click();
  const detail = page.getByRole('region', { name: '习惯详情 ' + name, exact: true });
  await expect(detail.locator('.todo-habit-detail-body')).toHaveAttribute('aria-busy', 'false');
  await detail.getByRole('button', { name: '查看来源专注记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '专注', exact: true }).first()).toBeVisible();
  const rows = page.locator('.todo-focus-history-item');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-session-id', sourceId);
  await expect(page.locator('.todo-focus-source-context')).toContainText('来自习惯的专注记录');
  await page.getByRole('button', { name: '查看全部专注记录', exact: true }).click();
  await expect(page.locator('.todo-focus-source-context')).toBeHidden();
  await expect(
    page.locator('.todo-focus-history-item[data-session-id="' + otherId + '"]'),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});
