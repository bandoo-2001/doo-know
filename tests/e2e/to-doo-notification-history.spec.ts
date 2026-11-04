import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { selectToDooContext } from '../support/to-doo-navigation';
import { notificationPlans, reminderEventId } from '../../packages/core/to-doo/notifications';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function command(page: any, action: string, payload: unknown) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    timeout: 60000,
    headers: {
      origin: `http://127.0.0.1:${process.env.DOOKNOW_E2E_WEB_PORT || 4179}`,
      'x-csrf-token': csrf.token,
    },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('recent notifications and mark-all include unread records beyond the first 200', async ({
  page,
}) => {
  test.setTimeout(120000);
  const source = await command(page, 'create_task', { title: '历史通知来源' });
  const snapshot = source.snapshot,
    at = Date.parse(snapshot.now),
    prefix = 'notice-' + crypto.randomUUID().slice(0, 8);
  const unreadBefore = snapshot.reminderUnreadCount;
  expect(unreadBefore).toBeGreaterThanOrEqual(0);
  const record = (id: string, time: number, extra = {}) => ({
    id,
    sourceType: 'task',
    sourceId: source.ids[0],
    occurrenceKey: 'once',
    scheduleRevision: 'old-rule',
    ruleId: 'old-rule',
    scheduledAt: new Date(time).toISOString(),
    firstRaisedAt: new Date(time).toISOString(),
    userState: 'unread',
    title: id,
    ...extra,
  });
  const ids = Array.from({ length: 205 }, (_, index) => prefix + '-' + index);
  ids.push(prefix + '-latest', prefix + '-future');
  await command(page, 'import_entities', {
    entities: [
      ...ids.slice(0, 205).map((id, index) => ({
        kind: 'reminderEvent',
        entity: record(id, at - (206 - index) * 60000),
      })),
      { kind: 'reminderEvent', entity: record(prefix + '-latest', at) },
      {
        kind: 'reminderEvent',
        entity: record(prefix + '-future', at + 86400000, { firstRaisedAt: null }),
      },
    ],
  });
  await page.goto('/?view=apps&app=to-doo&appSection=notifications');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.locator('.todo-notification').first()).toContainText(prefix + '-latest');
  await expect(app.getByRole('button', { name: '打开通知中心', exact: true })).toHaveText(
    String(unreadBefore + 206),
  );
  await app.getByRole('button', { name: '全部标为已读', exact: true }).click();
  await expect
    .poll(
      async () => {
        const data = await (
          await page.request.get(
            '/api/to-doo/state?kind=reminderEvent&limit=500&ids=' + ids.join(','),
          )
        ).json();
        return data.reminderEvents.filter(
          (row: any) => row.id !== prefix + '-future' && row.userState === 'unread',
        ).length;
      },
      { timeout: 45000 },
    )
    .toBe(0);
  const final = await (
    await page.request.get('/api/to-doo/state?kind=reminderEvent&ids=' + prefix + '-future')
  ).json();
  expect(final.reminderEvents[0].userState).toBe('unread');
  const latest = app.locator('.todo-notification').filter({ hasText: prefix + '-latest' });
  await expect(latest.getByRole('button', { name: '更多提醒操作', exact: true })).toBeVisible();
  await latest.getByRole('button', { name: '更多提醒操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '忽略提醒', exact: true }).click();
  await selectToDooContext(page, '忽略');
  await expect(app.locator('.todo-notification')).toHaveCount(1);
  await expect(app.locator('.todo-notification')).toContainText(prefix + '-latest');
  const ignored = await (
    await page.request.get('/api/to-doo/state?kind=reminderEvent&ids=' + prefix + '-latest')
  ).json();
  expect(ignored.reminderEvents[0].userState).toBe('dismissed');
  await selectToDooContext(page, '未读');
  await expect(app.locator('.todo-notification')).toHaveCount(0);
});

test('a recurring task notification opens its own execution rather than the first task execution', async ({
  page,
}) => {
  const state = await (await page.request.get('/api/to-doo/state')).json();
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: state.settings.timeZone }).format(
    new Date(state.now),
  );
  const shift = (days: number) =>
    new Date(Date.parse(today + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const created = await command(page, 'create_task', {
    title: '通知对应的重复任务',
    recurrence: {
      id: 'notice-series-' + crypto.randomUUID().slice(0, 8),
      frequency: 'daily',
      anchorDate: shift(-2),
      until: shift(-1),
      time: '10:00',
      timeZone: state.settings.timeZone,
    },
    reminders: [{ id: 'due-rule', anchor: 'due', offsetMinutes: 0 }],
  });
  const taskId = created.ids[0];
  const detail = await (
    await page.request.get('/api/to-doo/state?taskIds=' + taskId + '&includeTree=true')
  ).json();
  const target = detail.occurrences.find(
    (row: any) => row.taskId === taskId && row.scheduledDate === shift(-1),
  );
  expect(target).toBeTruthy();
  const plan = notificationPlans(detail, new Date(detail.now)).find(
    (row) =>
      row.sourceType === 'task' && row.sourceId === taskId && row.occurrenceKey === target.cycleKey,
  )!;
  expect(plan).toBeTruthy();
  const id = reminderEventId(plan),
    title = '对应第二次执行的通知';
  await command(page, 'save_entity', {
    kind: 'reminderEvent',
    entity: { ...plan, id, title, firstRaisedAt: detail.now, userState: 'acknowledged' },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=notifications');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app
    .locator('.todo-notification')
    .filter({ hasText: title })
    .getByRole('button', { name: '查看任务', exact: true })
    .click();
  await expect.poll(() => new URL(page.url()).searchParams.get('occurrence')).toBe(target.id);
  await expect(
    app
      .getByRole('complementary', { name: '任务详情', exact: true })
      .getByLabel('任务标题', { exact: true }),
  ).toHaveValue('通知对应的重复任务');
});
