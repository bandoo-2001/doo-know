import { expandToDooGroup } from '../support/to-doo-ant-controls';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import {
  notificationPlans,
  reminderEventId,
  type ReminderPlan,
} from '../../packages/core/to-doo/notifications';

const seededReminders = new WeakMap<Page, Map<string, ReminderPlan>>();

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
test.afterEach(async ({ page }) => {
  const owned = seededReminders.get(page);
  if (!owned?.size) return;
  // Only retire this case's events, after its UI and generation assertions finish.
  const response = await page.request.get(
    '/api/to-doo/state?kind=reminderEvent&ids=' + [...owned.keys()].join(','),
  );
  expect(response.ok(), await response.text()).toBe(true);
  for (const event of (await response.json()).reminderEvents) {
    const plan = owned.get(event.id);
    expect(plan).toBeTruthy();
    expect(event).toMatchObject({ ...plan, id: reminderEventId(plan!), deletedAt: null });
    if (event.userState !== 'unread' && event.userState !== 'snoozed') continue;
    const closed = await page.request.post('/api/to-doo/reminders/' + event.id + '/action', {
      headers: await headers(page),
      data: {
        action: 'read',
        requestId: crypto.randomUUID(),
        expectedRevision: event.revision,
      },
    });
    expect(closed.ok(), await closed.text()).toBe(true);
    expect(await closed.json()).toMatchObject({
      ...plan,
      id: event.id,
      userState: 'read',
      snoozedUntil: null,
      deliveryGeneration: event.deliveryGeneration,
    });
  }
  seededReminders.delete(page);
});

async function seedReminder(page: Page, habit = false, minutesAgo = 1) {
  const title = (habit ? '提醒打卡 ' : '提醒任务 ') + crypto.randomUUID();
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
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
  const owned = seededReminders.get(page) ?? new Map<string, ReminderPlan>();
  owned.set(id, plan!);
  seededReminders.set(page, owned);
  // The live scheduler can create this same event after a missing read.
  const url = '/api/to-doo/reminders/' + id;
  let persisted = await page.request.get(url);
  if (!persisted.ok()) {
    expect(persisted.status(), await persisted.text()).toBe(404);
    const created = await page.request.post('/api/to-doo/commands', {
      headers: await headers(page),
      data: {
        requestId: crypto.randomUUID(),
        action: 'save_entity',
        payload: {
          kind: 'reminderEvent',
          entity: { ...plan, id, firstRaisedAt: new Date().toISOString() },
        },
      },
    });
    if (!created.ok())
      expect({ status: created.status(), body: await created.json() }).toEqual({
        status: 400,
        body: { error: '修改既有实体需要预期版本', code: 'TO_DOO_CONFLICT' },
      });
    persisted = await page.request.get(url);
  }
  expect(persisted.ok(), await persisted.text()).toBe(true);
  const { event } = await persisted.json();
  expect(event).toMatchObject({
    ...plan,
    id,
    deletedAt: null,
    userState: 'unread',
    snoozedUntil: null,
    deliveryGeneration: 0,
  });
  expect(event.revision).toBeTruthy();
  expect(Date.parse(event.firstRaisedAt)).toBeGreaterThanOrEqual(Date.parse(plan!.scheduledAt));
  expect(Date.parse(event.firstRaisedAt)).toBeLessThanOrEqual(Date.now());
  return { id, title, sourceId: saved.ids[0] };
}
const cards = (page: Page) => page.getByRole('region', { name: '到点提醒', exact: true });

async function showReminder(page: Page, reminder: { id: string; title: string }) {
  const feed = await (await page.request.get('/api/to-doo/reminders/pending')).json();
  expect(feed.reminders.map((card: any) => card.event.id)).toContain(reminder.id);
  const region = cards(page);
  await expect(region.getByRole('heading', { level: 2 })).toBeVisible();
  for (let visited = 0; visited < feed.reminders.length; visited++) {
    if (await region.getByRole('heading', { name: reminder.title, exact: true }).isVisible())
      return region;
    await region.getByRole('button', { name: '下一条提醒', exact: true }).click();
  }
  await expect(region.getByRole('heading', { name: reminder.title, exact: true })).toBeVisible();
  return region;
}


async function closeReminder(page: Page, reminder: { id: string; title: string }) {
  const region = await showReminder(page, reminder);
  const closed = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/to-doo/reminders/' + reminder.id + '/action' &&
    response.request().method() === 'POST',
  );
  await region.getByRole('button', { name: '关闭这条提醒', exact: true }).click();
  expect((await closed).ok()).toBe(true);
  await expect(region.getByRole('heading', { name: reminder.title, exact: true })).not.toBeVisible();
  expect((await (await page.request.get('/api/to-doo/reminders/' + reminder.id)).json()).event.userState).toBe('read');
}

test('older reminder summaries leave the phone document body available for editing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await seedReminder(page, false, 30);
  const created = await page.request.post('/api/notes', {
    headers: await headers(page),
    data: {
      folderPath: '00-Inbox',
      fileName: '提醒不遮挡正文-' + crypto.randomUUID() + '.md',
      content: '# 保留正文\n\n可以继续编辑的段落。',
      requestId: crypto.randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  await page.goto('/?note=' + (await created.json()).id);
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  const summary = page.locator('.reminder-missed');
  await expect(summary).toBeVisible();
  await expect(summary).toHaveAccessibleName(/还有 \d+ 条较早提醒，查看通知中心/);
  const bounds = (await summary.boundingBox())!;
  expect(bounds.x).toBeGreaterThan(page.viewportSize()!.width / 2);
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type('仍可输入');
  await expect(editor).toContainText('仍可输入');
  await summary.click();
  await expect(page.getByRole('heading', { name: '通知中心', exact: true })).toBeVisible();
  await page.goBack();
  await expect(editor).toContainText('仍可输入');
});

test('older reminder summaries use the app badge and live cards stay below edit dialogs', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const old = await seedReminder(page, false, 30);
  const pending = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/to-doo/reminders/pending',
  );
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  expect((await (await pending).json()).missedCount).toBeGreaterThan(0);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expandToDooGroup(app, '日期与提醒');
  await expect(app.getByLabel('显示时区', { exact: true })).toBeVisible();
  const feed = await (await page.request.get('/api/to-doo/reminders/pending')).json();
  expect(feed.missedCount).toBeGreaterThan(0);
  await expect(app.getByRole('button', { name: '打开通知中心', exact: true })).toContainText(/\d+/);
  await expect(page.locator('.reminder-missed')).not.toBeVisible();
  const stored = await (
    await page.request.get('/api/to-doo/state?kind=reminderEvent&ids=' + old.id)
  ).json();
  expect(stored.reminderEvents[0].userState).toBe('unread');
  await page.goto('/?view=apps');
  await expect(page.locator('.reminder-missed')).toBeVisible();
  const live = await seedReminder(page);
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  await expect(cards(page).getByRole('heading', { name: live.title, exact: true })).toBeVisible();
  await app.getByRole('button', { name: /新建习惯/ }).click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  await expect(editor).toBeVisible();
  const layers = await page.evaluate(() => ({
    reminder: Number(getComputedStyle(document.querySelector('.reminder-stack')!).zIndex),
    modal: Number(getComputedStyle(document.querySelector('.ant-modal-wrap')!).zIndex),
  }));
  expect(layers.reminder).toBeLessThan(layers.modal);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await closeReminder(page, live);
});

test('workspace reminder card completes a real task and fits the viewport', async ({
  page,
}, info) => {
  const earlier = await seedReminder(page, false, 2);
  const reminder = await seedReminder(page);
  const feed = await (await page.request.get('/api/to-doo/reminders/pending')).json();
  const ids = feed.reminders.map((card: any) => card.event.id);
  expect(ids).toContain(earlier.id);
  expect(ids.indexOf(reminder.id)).toBeGreaterThan(ids.indexOf(earlier.id));
  await page.goto('/?view=apps');
  const card = await showReminder(page, reminder);
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
  expect((await (await page.request.get('/api/to-doo/reminders/' + earlier.id)).json()).event.userState).toBe('unread');
  await page.reload();
  await expect(card.getByRole('heading', { name: reminder.title })).not.toBeVisible();
  await closeReminder(page, earlier);
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
  const earlier = await seedReminder(page, false, 2);
  const reminder = await seedReminder(page);
  const feed = await (await page.request.get('/api/to-doo/reminders/pending')).json();
  const ids = feed.reminders.map((card: any) => card.event.id);
  expect(ids).toContain(earlier.id);
  expect(ids.indexOf(reminder.id)).toBeGreaterThan(ids.indexOf(earlier.id));
  await page.goto('/?note=' + note.id);
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.fill('# 尚未保存的提醒测试草稿');
  await showReminder(page, reminder);
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
  await closeReminder(page, earlier);
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
  await closeReminder(page, reminder);
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
