import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { confirmToDooAction } from '../support/to-doo-ant-controls';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function fixture(page: Page) {
  const state = await (await page.request.get('/api/to-doo/state?limit=1')).json();
  const timeZone = state.settings.timeZone;
  const startDate = new Intl.DateTimeFormat('sv-SE', { timeZone }).format(new Date(state.now));
  const suffix = crypto.randomUUID().slice(0, 6);
  const listId = 'habit-detail-list-' + suffix;
  const name = 'LongHabitName'.repeat(12) + suffix;
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  for (const [kind, entity] of [
    [
      'list',
      { id: listId, name: '阅读与成长 ' + suffix, kind: 'list', color: '#4f8c7a', icon: '📚' },
    ],
    [
      'habit',
      {
        name,
        listId,
        startDate,
        timeZone,
        goalMode: 'quantity',
        target: 10,
        unit: 'W'.repeat(40),
        icon: '📖',
      },
    ],
  ] as const) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action: 'save_entity', payload: { kind, entity } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  const card = page.getByRole('article', { name: '习惯 ' + name, exact: true });
  await expect(card.getByRole('spinbutton')).toBeEnabled();
  return { card, name };
}

test('habit names and units wrap without clipping and retain the associated list icon', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: info.project.name === 'mobile' ? 320 : 1920, height: 1080 });
  const { card } = await fixture(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  const title = card.locator('.todo-habit-card-heading .todo-task-title');
  const titleBounds = (await title.boundingBox())!;
  const schedule = (await card.locator('.todo-habit-card-heading small').first().boundingBox())!;
  expect(
    await title.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeLessThanOrEqual(1);
  expect(schedule.y).toBeGreaterThanOrEqual(titleBounds.y + titleBounds.height - 1);
  expect(
    await card.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  const field = card.locator('.todo-habit-addition .ant-input-number');
  expect((await field.boundingBox())!.width).toBeGreaterThanOrEqual(63);
  await expect(card.locator('.todo-habit-list-link .todo-list-icon')).toHaveText('📚');
  const menu = card.getByRole('button', { name: /^习惯操作 / });
  const bounds = (await menu.boundingBox())!,
    icon = (await menu.locator('svg').boundingBox())!;
  expect(Math.abs(bounds.y + bounds.height / 2 - icon.y - icon.height / 2)).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('habit-long-content.png'),
    animations: 'disabled',
  });
  expect(writes).toBe(0);
});

test('reminder remove buttons and history arrows use centered icons without submitting edits', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: info.project.name === 'mobile' ? 320 : 1920, height: 1080 });
  const { card, name } = await fixture(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await card.getByRole('button', { name, exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑习惯', exact: true });
  await editor.getByRole('button', { name: '添加提醒', exact: true }).click();
  const row = editor.locator('.todo-habit-reminder-time').first();
  const picker = (await row.locator('.ant-picker').boundingBox())!;
  const remove = row.getByRole('button', { name: '移除提醒时间 1', exact: true });
  const button = (await remove.boundingBox())!,
    icon = (await remove.locator('svg').boundingBox())!;
  expect(Math.abs(picker.y + picker.height / 2 - button.y - button.height / 2)).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(button.y + button.height / 2 - icon.y - icon.height / 2)).toBeLessThanOrEqual(1);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await confirmToDooAction(page);
  await expect(editor).toBeHidden();
  await page.goto('/?view=apps&app=to-doo&appSection=habits&appPage=history');
  for (const name of ['上一周', '下一周']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button.locator('svg')).toBeVisible();
    const control = (await button.boundingBox())!,
      icon = (await button.locator('svg').boundingBox())!;
    expect(Math.abs(control.y + control.height / 2 - icon.y - icon.height / 2)).toBeLessThanOrEqual(
      1,
    );
  }
  expect(writes).toBe(0);
});
