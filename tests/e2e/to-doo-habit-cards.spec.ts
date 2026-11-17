import { selectToDooContext } from '../support/to-doo-navigation';
import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import {
  isolateHabitTestReminderOverlays,
  readHabitTestEntities,
  revealHabitTestCard,
} from '../support/to-doo-habit-fixture';

test.beforeEach(async ({ context }) => {
  await isolateHabitTestReminderOverlays(context);
});

test('a failed quantity write retains the input and retries the same request once', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const id = 'quantity-retry-' + crypto.randomUUID();
  const created = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: { kind: 'habit', entity: { id, name: id, startDate: '2025-01-01' } },
    },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  const card = page.getByRole('article', { name: '习惯 ' + id, exact: true });
  const field = card.getByRole('spinbutton', { name: '记录数量 ' + id, exact: true });
  await expect(field).toBeEnabled();
  await field.fill('7');
  const requestIds: string[] = [];
  await page.route('**/api/to-doo/commands', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'checkin_habit' && body.payload.habitId === id) {
      requestIds.push(body.requestId);
      if (requestIds.length === 1)
        return route.fulfill({ status: 503, json: { error: '数量暂时无法保存' } });
    }
    await route.continue();
  });
  await card.getByRole('button', { name: '记录数量 ' + id, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('数量暂时无法保存');
  await expect(field).toHaveValue('7');
  await card.getByRole('button', { name: '记录数量 ' + id, exact: true }).click();
  await expect(card.locator('.todo-habit-day-amount')).toHaveText(/7\s*\/\s*1\s*次/);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
  const saved = await readHabitTestEntities(page, 'habitEntry');
  expect(saved.filter((entry) => entry.habitId === id)).toMatchObject([{ amount: 7 }]);
});

test('habit cards distinguish today from weekly achievement and include all pages before recording, skipping and pausing', async ({
  page,
  context,
}, info) => {
  test.setTimeout(90000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token };
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers,
      timeout: 60000,
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  const suffix = info.project.name + crypto.randomUUID().slice(0, 8);
  const reading = 'reading-' + suffix,
    exercise = 'exercise-' + suffix;
  await command('save_entity', {
    kind: 'habit',
    entity: {
      id: reading,
      name: '阅读 ' + suffix,
      unit: '页',
      target: 300,
      startDate: '2025-01-01',
    },
  });
  await command('save_entity', {
    kind: 'habit',
    entity: {
      id: exercise,
      name: '运动 ' + suffix,
      unit: '次',
      target: 3,
      frequency: 'weekly',
      startDate: '2025-01-01',
    },
  });
  await command('import_entities', {
    entities: [
      ...Array.from({ length: 450 }, (_, i) => ({
        kind: 'habitEntry',
        entity: {
          id: reading + '-' + i,
          habitId: reading,
          localDate: i < 200 ? '2025-01-01' : '2026-10-30',
          occurredAt: '2026-10-30T08:00:00Z',
          amount: 1,
        },
      })),
      {
        kind: 'habitEntry',
        entity: {
          id: exercise + '-yesterday',
          habitId: exercise,
          localDate: '2026-10-29',
          occurredAt: '2026-10-29T08:00:00Z',
          amount: 3,
        },
      },
    ],
  });
  await page.clock.install({ time: new Date('2026-10-30T12:00:00Z') });
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const readCard = app.getByRole('article', { name: '习惯 阅读 ' + suffix, exact: true });
  const exerciseCard = app.getByRole('article', { name: '习惯 运动 ' + suffix, exact: true });
  await expect(readCard.locator('.todo-habit-day-amount')).toHaveText(/250\s*\/\s*300\s*页/);
  await expect(
    page.getByRole('article', { name: '习惯 运动 ' + suffix, exact: true, includeHidden: true }),
  ).toBeHidden();
  await revealHabitTestCard(page, '运动 ' + suffix);
  await expect(exerciseCard.locator('.todo-habit-day-amount')).toHaveCount(0);
  await expect(exerciseCard.locator('.todo-habit-period-amount')).toHaveText(/3\s*\/\s*3\s*次/);
  await expect(exerciseCard.getByRole('img', { name: '本周达标', exact: true })).toBeVisible();
  await readCard
    .getByRole('spinbutton', { name: '记录数量 阅读 ' + suffix, exact: true })
    .fill('0');
  await readCard.getByRole('button', { name: '记录数量 阅读 ' + suffix, exact: true }).click();
  await expect(readCard.getByRole('alert')).toHaveText('请输入大于 0 的数量');
  await expect(readCard.locator('.todo-habit-day-amount')).toHaveText(/250\s*\/\s*300\s*页/);
  await readCard
    .getByRole('spinbutton', { name: '记录数量 阅读 ' + suffix, exact: true })
    .fill('2');
  await readCard.getByRole('button', { name: '记录数量 阅读 ' + suffix, exact: true }).click();
  await expect(readCard.locator('.todo-habit-day-amount')).toHaveText(/252\s*\/\s*300\s*页/);
  const menu = exerciseCard.getByRole('button', { name: '习惯操作 运动 ' + suffix, exact: true });
  await menu.click();
  await page.getByRole('menuitem', { name: '跳过今天', exact: true }).click();
  await expect(exerciseCard.getByRole('img', { name: '今天已跳过', exact: true })).toBeVisible();
  await menu.click();
  await page.getByRole('menuitem', { name: '撤销今天记录', exact: true }).click();
  const undo = page.getByRole('dialog', { name: '撤销习惯记录', exact: true });
  await expect(undo).toBeVisible();
  await undo.getByRole('button', { name: '确认', exact: true }).click();
  await expect(undo).not.toBeVisible();
  await expect(exerciseCard.getByRole('img', { name: '今天已跳过', exact: true })).toHaveCount(0);
  await expect(exerciseCard.locator('.todo-habit-period-amount')).toHaveText(/3\s*\/\s*3\s*次/);
  await menu.click();
  await page.getByRole('menuitem', { name: '今天休息', exact: true }).click();
  await expect(exerciseCard.getByRole('img', { name: '今天休息', exact: true })).toBeVisible();
  await expect(
    exerciseCard.getByRole('button', { name: '记录数量 运动 ' + suffix, exact: true }),
  ).toBeDisabled();
  await page.reload();
  await revealHabitTestCard(page, '运动 ' + suffix);
  await expect(readCard.locator('.todo-habit-day-amount')).toHaveText(/252\s*\/\s*300\s*页/);
  await expect(exerciseCard.getByRole('img', { name: '今天休息', exact: true })).toBeVisible();
  await readCard.getByRole('button', { name: '习惯操作 阅读 ' + suffix, exact: true }).click();
  await page.getByRole('menuitem', { name: '连续记录', exact: true }).click();
  const statistics = page.getByRole('region', {
    name: '习惯详情 阅读 ' + suffix,
    exact: true,
  });
  await statistics.locator('.todo-habit-detail-statistics > summary').click();
  await expect(statistics).toContainText('共 451 条记录');
  await statistics.getByRole('button', { name: '关闭习惯详情', exact: true }).click();
  await selectToDooContext(page, '历史', '习惯目录');
  await expect(app.getByRole('button', { name: '上一周', exact: true })).toBeVisible();
  await app.getByLabel('习惯视图', { exact: true }).getByText('今天', { exact: true }).click();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: info.outputPath('habit-today-320.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
