import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { notificationPlans, reminderEventId } from '../../packages/core/to-doo/notifications';

// Isolated fixtures only; no push permission or physical device delivery is required.
const createdReminders: string[] = [];
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function command(page: Page, action: string, payload: unknown) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: {
      origin: String(test.info().project.use.baseURL),
      'x-csrf-token': csrf.token,
    },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function snapshot(page: Page, query: Record<string, string>) {
  const response = await page.request.get(
    '/api/to-doo/state?' + new URLSearchParams({ limit: '100', ...query }),
  );
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
// Keep intentionally restored-unread and snoozed fixtures from opening cards in later specs.
test.afterEach(async ({ page }) => {
  for (const id of createdReminders.splice(0)) {
    const state = await snapshot(page, { kind: 'reminderEvent', ids: id });
    const event = state.reminderEvents.find((row: any) => row.id === id);
    if (!event || event.deletedAt) continue;
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const response = await page.request.post(
      '/api/to-doo/reminders/' + encodeURIComponent(id) + '/action',
      {
        headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
        data: {
          requestId: crypto.randomUUID(),
          expectedRevision: event.revision,
          action: 'dismiss',
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
  }
});
async function reminder(page: Page, sourceType: 'task' | 'habit' | 'anniversary') {
  const initial = await snapshot(page, { kind: 'settings' });
  const today =
    sourceType === 'anniversary'
      ? new Intl.DateTimeFormat('sv-SE', { timeZone: initial.settings.timeZone }).format(
          new Date(initial.now),
        )
      : initial.now.slice(0, 10);
  const title = '审核提醒-' + sourceType + '-' + crypto.randomUUID().slice(0, 8);
  const created =
    sourceType === 'task'
      ? await command(page, 'create_task', {
          title,
          reminders: [
            {
              id: 'audit-rule',
              anchor: 'absolute',
              at: new Date(Date.parse(initial.now) - 60000).toISOString(),
            },
          ],
        })
      : await command(page, 'save_entity', {
          kind: sourceType,
          entity: {
            name: title,
            ...(sourceType === 'habit' ? { startDate: today, timeZone: 'UTC' } : { date: today }),
            reminders: [{ id: 'audit-rule', allDayTime: '00:00' }],
          },
        });
  const state = await snapshot(
    page,
    sourceType === 'task'
      ? { kinds: 'task,occurrence', taskIds: created.ids[0] }
      : { kind: sourceType, ids: created.ids[0] },
  );
  const plan = notificationPlans(state, new Date(state.now)).find(
    (row) =>
      row.sourceType === sourceType &&
      row.sourceId === created.ids[0] &&
      !row.ruleId.startsWith('history_'),
  )!;
  expect(plan).toBeTruthy();
  const saved = await command(page, 'save_entity', {
    kind: 'reminderEvent',
    entity: {
      ...plan,
      id: reminderEventId(plan),
      title,
      userState: 'read',
      firstRaisedAt: state.now,
    },
  });
  createdReminders.push(saved.ids[0]);
  return { id: saved.ids[0], sourceId: created.ids[0], title, date: plan.occurrenceKey };
}
const workspace = (page: Page) =>
  page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });

test('confirming a notification keeps its task pending and handling or ignoring can be corrected', async ({
  page,
}) => {
  const created = await reminder(page, 'task');
  await page.goto('/?view=apps&app=to-doo&appSection=notifications');
  const app = workspace(page);
  const row = app.locator('[data-reminder-id="' + created.id + '"]');
  await expect(app).toContainText('不会自动完成');
  await row.getByRole('button', { name: '确认提醒', exact: true }).click();
  await expect(row).toContainText('已确认');
  expect(
    (await snapshot(page, { kind: 'occurrence', taskIds: created.sourceId })).occurrences.find(
      (value: any) => value.taskId === created.sourceId,
    ).status,
  ).toBe('todo');
  await row.getByRole('button', { name: '更多提醒操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '恢复未读', exact: true }).click();
  await expect(row).toContainText('未读');
  await row.getByRole('button', { name: '更多提醒操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '忽略提醒', exact: true }).click();
  await expect(row).toContainText('已忽略');
  await row.getByRole('button', { name: '更多提醒操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '恢复未读', exact: true }).click();
  await expect(row).toContainText('未读');
  const final = await snapshot(page, { kind: 'reminderEvent', ids: created.id });
  expect(
    (await snapshot(page, { kind: 'occurrence', taskIds: created.sourceId })).occurrences.find(
      (value: any) => value.taskId === created.sourceId,
    ).status,
  ).toBe('todo');
  expect(final.reminderEvents.find((value: any) => value.id === created.id)).toMatchObject({
    userState: 'unread',
    deliveryGeneration: 0,
    snoozedUntil: null,
  });
});

test('notification snooze offers 5/15/30/60 minutes and stores the selected 30-minute delay', async ({
  page,
}) => {
  const created = await reminder(page, 'task');
  await page.goto('/?view=apps&app=to-doo&appSection=notifications');
  const row = workspace(page).locator('[data-reminder-id="' + created.id + '"]');
  await row.getByRole('button', { name: '更多提醒操作', exact: true }).click();
  for (const minutes of [5, 15, 30, 60])
    await expect(
      page.getByRole('menuitem', { name: minutes + ' 分钟后提醒', exact: true }),
    ).toBeVisible();
  const before = Date.now();
  await page.getByRole('menuitem', { name: '30 分钟后提醒', exact: true }).click();
  await expect(row).toContainText('稍后提醒');
  const event = (
    await snapshot(page, { kind: 'reminderEvent', ids: created.id })
  ).reminderEvents.find((value: any) => value.id === created.id);
  expect(event).toMatchObject({ userState: 'snoozed', deliveryGeneration: 1 });
  expect(Date.parse(event.snoozedUntil)).toBeGreaterThanOrEqual(before + 30 * 60000);
  expect(Date.parse(event.snoozedUntil)).toBeLessThanOrEqual(Date.now() + 30 * 60000);
});

for (const [type, section, label] of [
  ['habit', 'habits', '查看习惯'],
  ['anniversary', 'anniversaries', '查看纪念日'],
] as const) {
  test(
    type + ' notification navigates to its source section and occurrence date',
    async ({ page }) => {
      const created = await reminder(page, type);
      await page.goto('/?view=apps&app=to-doo&appSection=notifications');
      await workspace(page)
        .locator('[data-reminder-id="' + created.id + '"]')
        .getByRole('button', { name: label, exact: true })
        .click();
      await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe(section);
      await expect.poll(() => new URL(page.url()).searchParams.get('date')).toBe(created.date);
      await expect(workspace(page)).toContainText(created.title);
    },
  );
}

test('archiving preserves the displayed historical completion and zero days have no positive column', async ({
  page,
}) => {
  const created = await command(page, 'create_task', { title: '归档后保留的历史完成' });
  const occurrence = created.snapshot.occurrences.find(
    (value: any) => value.taskId === created.ids[0],
  );
  await command(page, 'set_occurrence_status', {
    id: occurrence.id,
    expectedRevision: occurrence.revision,
    status: 'done',
  });
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  const app = workspace(page);
  const metric = app
    .getByRole('group', { name: '区间统计' })
    .locator('.ant-statistic')
    .filter({ hasText: '完成行动' })
    .locator('.ant-statistic-content-value');
  const before = await metric.innerText();
  const state = await snapshot(page, { kind: 'task', ids: created.ids[0] });
  const task = state.tasks.find((value: any) => value.id === created.ids[0]);
  await command(page, 'save_entity', {
    kind: 'task',
    entity: { ...task, archivedAt: state.now },
    expectedRevision: task.revision,
  });
  await app.getByRole('button', { name: '刷新 To Doo', exact: true }).click();
  await expect(metric).toHaveText(before);
  await expect(app).toContainText('归档');
  const zeros = app
    .locator('.todo-completion-chart > div')
    .filter({ has: page.locator('span', { hasText: /^0$/ }) });
  expect(await zeros.count()).toBeGreaterThan(0);
  for (const zero of await zeros.all()) await expect(zero.locator('i')).toHaveCSS('height', '0px');
});
