import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { fillToDooDate, selectToDooOption } from '../support/to-doo-ant-controls';

test.beforeEach(async ({ page, context }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 844 });
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.clock.install({ time: new Date('2026-11-01T12:00:00Z') });
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
});

test('ordinary habits create without quantities and complete with one click', async ({
  page,
}, info) => {
  const name = '早睡 ' + info.project.name + crypto.randomUUID().slice(0, 6);
  await page
    .getByRole('button', { name: /新建习惯/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await editor.getByRole('button', { name: '选择习惯图标', exact: true }).click();
  await page.getByRole('button', { name: '选择图标 🌙', exact: true }).click();
  await expect(editor.getByRole('spinbutton', { name: '目标数量', exact: true })).not.toBeVisible();
  await expect(editor.getByLabel('开始日期', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '添加提醒', exact: true }).click();
  await expect(editor.getByLabel('提醒时间 1', { exact: true })).toBeVisible();
  await expect(editor.getByText('提前或延后（分钟）', { exact: true })).not.toBeVisible();
  await page.screenshot({
    path: info.outputPath('habit-create-simple.png'),
    animations: 'disabled',
  });
  await editor.screenshot({
    path: info.outputPath('habit-form-light.png'),
    animations: 'disabled',
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('habit-create-dark.png'), animations: 'disabled' });
  await editor.screenshot({ path: info.outputPath('habit-form-dark.png'), animations: 'disabled' });
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const card = page.getByRole('article', { name: '习惯 ' + name, exact: true });
  await expect(card.getByRole('spinbutton')).toHaveCount(0);
  await card.getByRole('button', { name: '打卡 ' + name, exact: true }).click();
  await expect(card.getByRole('button', { name: '打卡 ' + name, exact: true })).toBeDisabled();
  await expect(card).toContainText('已打卡');
  await page.reload();
  await expect(card).toContainText('已打卡');
  await page.getByText('历史', { exact: true }).click();
  await page
    .getByRole('button', { name: name + ' 2026-11-01 打卡，当前 1 次', exact: true })
    .click();
  const history = page.getByRole('dialog', { name: '习惯打卡', exact: true });
  await expect(history.getByRole('spinbutton')).toHaveCount(0);
  await history.getByRole('button', { name: '撤销当天记录', exact: true }).click();
  await page
    .getByRole('dialog', { name: '撤销习惯记录', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click();
  await expect(history).not.toBeVisible();
  await page.getByText('今天', { exact: true }).click();
  await expect(card.getByRole('button', { name: '打卡 ' + name, exact: true })).toBeEnabled();
  await card.getByRole('button', { name: '打卡 ' + name, exact: true }).click();
  await expect(card).toContainText('已打卡');
  const state = await (
    await page.request.get('/api/to-doo/state?kinds=habit,habitEntry&limit=1000')
  ).json();
  const habit = state.habits.find((h: any) => h.name === name);
  expect(habit).toMatchObject({ goalMode: 'checkin', target: 1, unit: '次', icon: '🌙' });
  expect(
    state.habitEntries.filter((e: any) => e.habitId === habit.id && !e.deletedAt),
  ).toHaveLength(1);
});

test('editing a basic reminder retains the existing custom reminder rules', async ({
  page,
}, info) => {
  const id = 'reminder-edit-' + crypto.randomUUID();
  const name = '保留提醒 ' + info.project.name + id;
  const reminders = [
    { id: 'basic', anchor: 'occurrence', offsetMinutes: 0, allDayTime: '09:00' },
    { id: 'offset', anchor: 'occurrence', offsetMinutes: -15, allDayTime: '20:00' },
    {
      id: 'absolute',
      anchor: 'absolute',
      at: '2030-01-01T08:00:00Z',
      offsetMinutes: 0,
      allDayTime: '09:00',
    },
  ];
  // Avoid historical reminder backfill changing the revision during this reminder-edit case.
  const serverResponse = await page.request.get('/api/to-doo/state?kind=habit&limit=1');
  expect(serverResponse.ok()).toBe(true);
  const serverState = await serverResponse.json();
  const timeZone = serverState.settings.timeZone;
  const startDate = new Intl.DateTimeFormat('sv-SE', { timeZone }).format(
    new Date(serverState.now),
  );
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const created = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: { id, name, startDate, timeZone, reminders },
      },
    },
  });
  expect(created.ok()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name, exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑习惯', exact: true });
  await fillToDooDate(editor.getByLabel('提醒时间 1', { exact: true }), '10:30');
  await expect(editor.getByText('自定义提醒', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const response = await page.request.get('/api/to-doo/state?kind=habit&ids=' + id);
  expect(response.ok()).toBe(true);
  const state = await response.json();
  expect(state.habits[0].reminders).toMatchObject([
    { ...reminders[0], allDayTime: '10:30' },
    reminders[1],
    reminders[2],
  ]);
});

test('converting a restricted weekly quantity shows its allowed dates and a reachable day target', async ({
  page,
}, info) => {
  const id = 'weekly-mode-' + crypto.randomUUID();
  const name = '每周运动 ' + info.project.name + id;
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const created = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: {
        kind: 'habit',
        entity: {
          id,
          name,
          startDate: '2026-10-26',
          frequency: 'weekly',
          weekdays: [1],
          target: 3,
        },
      },
    },
  });
  expect(created.ok()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name, exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑习惯', exact: true });
  await selectToDooOption(editor, '目标', '完成后打卡');
  await expect(editor.getByRole('button', { name: '星期一', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(editor.getByRole('button', { name: '星期二', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(editor.getByRole('spinbutton', { name: '打卡天数', exact: true })).toHaveValue('1');
  await expect(editor).toContainText('最多可打卡 1 天');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const stored = await (await page.request.get('/api/to-doo/state?kind=habit&ids=' + id)).json();
  expect(stored.habits[0]).toMatchObject({
    goalMode: 'checkin',
    frequency: 'weekly',
    weekdays: [1],
    target: 1,
  });
  expect(stored.habits[0].ruleVersions[0].goalMode).toBeUndefined();
});

test('a quantitative target adds only the remaining amount and labels the input as an addition', async ({
  page,
}, info) => {
  const name = '阅读 ' + info.project.name + crypto.randomUUID().slice(0, 6);
  await page
    .getByRole('button', { name: /新建习惯/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await selectToDooOption(editor, '目标', '完成一定数量');
  await editor.getByRole('spinbutton', { name: '目标数量', exact: true }).fill('20');
  await editor.getByLabel('单位', { exact: true }).fill('页');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  const card = page.getByRole('article', { name: '习惯 ' + name, exact: true });
  const input = card.getByRole('spinbutton', { name: '记录数量 ' + name, exact: true });
  await expect(card).toContainText('本次新增');
  await input.fill('10');
  await card.getByRole('button', { name: '记录数量 ' + name, exact: true }).click();
  await expect(card).toContainText('今天 10 / 20 页');
  await expect(input).toHaveValue('10');
  await card.getByRole('button', { name: '记录数量 ' + name, exact: true }).click();
  await expect(card).toContainText('今天 20 / 20 页');
  await expect(card.getByRole('button', { name: '记录数量 ' + name, exact: true })).not.toHaveClass(
    /ant-btn-primary/,
  );
  await expect(input).toHaveValue('');
});

test('weekday and interval choices save an explicit schedule', async ({ page }, info) => {
  const name = '间隔习惯 ' + info.project.name + crypto.randomUUID().slice(0, 6);
  await page
    .getByRole('button', { name: /新建习惯/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await selectToDooOption(editor, '频率', '指定星期');
  await expect(editor.getByRole('button', { name: '星期一', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await selectToDooOption(editor, '频率', '每隔几天');
  await editor.getByRole('spinbutton', { name: '间隔天数', exact: true }).fill('3');
  await fillToDooDate(editor.getByLabel('开始日期', { exact: true }), '2026-10-30');
  await expect(editor).toContainText('每隔 3 天');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  const card = page.getByRole('article', { name: '习惯 ' + name, exact: true });
  await expect(card).toContainText('今天无需记录');
  await expect(card.getByRole('button', { name: '打卡 ' + name, exact: true })).toBeDisabled();
  const state = await (await page.request.get('/api/to-doo/state?kind=habit&limit=500')).json();
  expect(state.habits.find((h: any) => h.name === name)).toMatchObject({
    intervalDays: 3,
    weekdays: [],
    startDate: '2026-10-30',
  });
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.setViewportSize({ width: info.project.name === 'mobile' ? 320 : 1440, height: 960 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath('habits-' + theme + '.png'),
      fullPage: true,
      animations: 'disabled',
    });
  }
});
