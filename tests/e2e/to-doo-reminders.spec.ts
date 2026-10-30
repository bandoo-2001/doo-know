import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { notificationPlans, reminderEventId } from '../../packages/core/to-doo/notifications';

test.use({ sourceEditorPreference: true });
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function headers(page: Page) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  return {
    origin: new URL((await import('../../playwright.config')).default.use!.baseURL!).origin,
    'x-csrf-token': csrf.token,
  };
}
async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const response = await page.request.post('/api/to-doo/commands', {
    headers: await headers(page),
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function seedReminder(page: Page, habit = false) {
  const title = (habit ? '提醒打卡 ' : '提醒任务 ') + crypto.randomUUID();
  const at = new Date(Date.now() - 60000).toISOString();
  const reminders = [{ id: crypto.randomUUID(), anchor: 'absolute', at }];
  const saved = habit
    ? await command(page, 'save_entity', {
        kind: 'habit',
        entity: {
          name: title,
          startDate: at.slice(0, 10),
          target: 10,
          unit: '次',
          timeZone: 'UTC',
          reminders,
        },
      })
    : await command(page, 'create_task', { title, reminders });
  const snapshot = await (
    await page.request.get(
      '/api/to-doo/state?kinds=task,occurrence,habit,habitEntry,anniversary&limit=1000',
    )
  ).json();
  const plan = notificationPlans(snapshot, new Date()).find((p) => p.sourceId === saved.ids[0]);
  expect(plan).toBeTruthy();
  const id = reminderEventId(plan!);
  // Seed the actual persisted event; the domain tests separately exercise the server scheduler.
  const existing = await page.request.get('/api/to-doo/reminders/' + id);
  if (!existing.ok())
    await command(page, 'save_entity', {
      kind: 'reminderEvent',
      entity: { ...plan, id, firstRaisedAt: new Date().toISOString() },
    });
  return { id, title, sourceId: saved.ids[0] };
}
const cards = (page: Page) => page.getByRole('region', { name: '到点提醒', exact: true });

test('workspace reminder card completes a real task and fits the viewport', async ({
  page,
}, info) => {
  const reminder = await seedReminder(page);
  await page.goto('/?view=apps');
  const card = cards(page);
  await expect(card.getByRole('heading', { name: reminder.title })).toBeVisible();
  const box = await card.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({ path: info.outputPath('reminder-card.png') });
  await card.getByRole('button', { name: '完成', exact: true }).click();
  await expect(card.getByRole('heading', { name: reminder.title })).not.toBeVisible();
  const state = await (
    await page.request.get('/api/to-doo/state?taskIds=' + reminder.sourceId)
  ).json();
  expect(state.occurrences.find((o: any) => o.taskId === reminder.sourceId)?.status).toBe('done');
  await page.reload();
  await expect(card.getByRole('heading', { name: reminder.title })).not.toBeVisible();
});

test('activating a desktop notification keeps the current unsaved note and opens its reminder', async ({
  page,
}) => {
  const created = await page.request.post('/api/notes', {
    headers: await headers(page),
    data: {
      folderPath: '00-Inbox',
      fileName: '提醒草稿-' + crypto.randomUUID() + '.md',
      content: '# 已保存正文',
      requestId: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const note = await created.json();
  const reminder = await seedReminder(page);
  await page.goto('/?note=' + note.id);
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.fill('# 尚未保存的提醒测试草稿');
  await expect(cards(page).getByRole('heading', { name: reminder.title })).toBeVisible();
  await cards(page).getByRole('button', { name: '关闭这条提醒', exact: true }).click();
  await expect(cards(page).getByRole('heading', { name: reminder.title })).not.toBeVisible();
  const url = page.url();
  await page.evaluate(
    (eventId) =>
      navigator.serviceWorker.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'dooknow-to-doo-open-reminder',
            eventId,
            url: '/?view=apps&app=to-doo&appSection=notifications',
          },
        }),
      ),
    reminder.id,
  );
  await expect(cards(page).getByRole('heading', { name: reminder.title })).toBeVisible();
  expect(page.url()).toBe(url);
  await expect(editor).toContainText('尚未保存的提醒测试草稿');
  await cards(page).getByRole('button', { name: '稍后提醒', exact: true }).click();
  await expect(cards(page).getByRole('heading', { name: reminder.title })).not.toBeVisible();
  const event = (
    await (await page.request.get('/api/to-doo/state?kind=reminderEvent&ids=' + reminder.id)).json()
  ).reminderEvents[0];
  expect(event.userState).toBe('snoozed');
  expect(Date.parse(event.snoozedUntil)).toBeGreaterThan(Date.now() + 14 * 60000);
  await expect(editor).toContainText('尚未保存的提醒测试草稿');
});

test('cold notification links open the right habit and record the entered amount once', async ({
  page,
}) => {
  const reminder = await seedReminder(page, true);
  await page.goto('/?view=apps&app=to-doo&appSection=notifications&reminder=' + reminder.id);
  const card = cards(page);
  await expect(card.getByRole('heading', { name: reminder.title })).toBeVisible();
  await card.getByRole('spinbutton', { name: '本次打卡数量', exact: true }).fill('3');
  await card.getByRole('button', { name: '打卡', exact: true }).click();
  await expect(card.getByRole('heading', { name: reminder.title })).not.toBeVisible();
  const state = await (
    await page.request.get('/api/to-doo/state?kind=habitEntry&limit=1000')
  ).json();
  expect(
    state.habitEntries
      .filter((e: any) => e.habitId === reminder.sourceId)
      .map((e: any) => e.amount),
  ).toEqual([3]);
});

test('closing a cold notification card prevents that generation from reopening on refresh', async ({
  page,
}) => {
  const reminder = await seedReminder(page);
  await page.goto('/?view=apps&app=to-doo&appSection=notifications&reminder=' + reminder.id);
  await expect(cards(page).getByRole('heading', { name: reminder.title })).toBeVisible();
  await cards(page).getByRole('button', { name: '关闭这条提醒', exact: true }).click();
  await expect(cards(page).getByRole('heading', { name: reminder.title })).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '通知中心', exact: true })).toBeVisible();
  await expect(cards(page).getByRole('heading', { name: reminder.title })).not.toBeVisible();
});

test('switching from an exact reminder occurrence to another task clears the old occurrence', async ({
  page,
}, info) => {
  const reminder = await seedReminder(page);
  const first = await (await page.request.get('/api/to-doo/reminders/' + reminder.id)).json();
  const title = '切换后的任务 ' + crypto.randomUUID();
  const second = await command(page, 'create_task', { title });
  const target = second.snapshot.occurrences.find((o: any) => o.taskId === second.ids[0]);
  await page.goto(
    '/?view=apps&app=to-doo&appSection=tasks&task=' +
      reminder.sourceId +
      '&occurrence=' +
      first.occurrenceId,
  );
  await cards(page).getByRole('button', { name: '关闭这条提醒', exact: true }).click();
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  if (info.project.name === 'mobile') {
    // Mobile task details cover the list; use its close control before selecting another task.
    await app.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    expect(new URL(page.url()).searchParams.has('occurrence')).toBe(false);
  }
  await app.getByRole('button', { name: title, exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('occurrence')).toBe(target.id);
  await page.reload();
  const detail = app.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  expect(new URL(page.url()).searchParams.has('occurrence')).toBe(false);
});
