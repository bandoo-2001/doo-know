import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expectToDooSelection, selectToDooOption } from '../support/to-doo-ant-controls';
import { openToDooFocusHistory } from '../support/to-doo-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function commands(page: Page) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  return async (action: string, payload: Record<string, unknown>) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: {
        origin: `http://127.0.0.1:${process.env.DOOKNOW_E2E_WEB_PORT || 4179}`,
        'x-csrf-token': csrf.token,
      },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
}

test('focus settings retain their action and note while history secondary controls support the keyboard', async ({
  page,
}) => {
  const command = await commands(page);
  const before = await (await page.request.get('/api/to-doo/focus/history?limit=1')).json();
  if (before.active)
    await command('control_focus', {
      id: before.active.id,
      expectedRevision: before.active.revision,
      operation: 'cancel',
    });
  const suffix = crypto.randomUUID().slice(0, 8);
  const title = '专注关联行动 ' + suffix;
  const task = await command('create_task', { title });
  const snapshot = await (
    await page.request.get('/api/to-doo/state?taskIds=' + task.ids[0])
  ).json();
  const topicName = '简洁专注 ' + suffix;
  await command('save_entity', {
    kind: 'focusTopic',
    entity: { id: 'cohesion-' + suffix, name: topicName },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const timer = app.getByRole('region', { name: '专注计时器', exact: true });
  await app.getByRole('button', { name: '选择专注项目 ' + topicName, exact: true }).click();
  const settings = timer.getByRole('button', { name: '计时设置', exact: true });
  await expect(app.getByRole('combobox', { name: '关联行动', exact: true })).not.toBeVisible();
  await settings.click();
  const modes = app.locator('.todo-focus-timer-fields:visible');
  await modes.getByText('休息', { exact: true }).click();
  await expect(modes.getByRole('radio', { name: '休息', exact: true })).toBeChecked();
  await modes.getByText('番茄钟', { exact: true }).click();
  await expect(modes.getByRole('radio', { name: '番茄钟', exact: true })).toBeChecked();
  await selectToDooOption(app, '关联行动', title);
  await app.getByRole('spinbutton', { name: '本次时长', exact: true }).fill('42');
  await app.getByRole('button', { name: '收起计时设置', exact: true }).click();
  await expect(timer).toContainText(title);
  await expect(timer).toContainText('42 分钟');
  await settings.click();
  await expectToDooSelection(app, '关联行动', title);
  await expect(app.getByRole('spinbutton', { name: '本次时长', exact: true })).toHaveValue('42');
  await app.getByRole('button', { name: '收起计时设置', exact: true }).click();
  await timer.getByRole('button', { name: '开始专注', exact: true }).click();
  await expect(timer.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await settings.click();
  const note = app.getByRole('textbox', { name: '本次专注记录', exact: true });
  await note.fill('收起设置也保留的专注草稿 ' + suffix);
  await app.getByRole('button', { name: '收起计时设置', exact: true }).click();
  await expect(timer).toContainText('记录未保存');
  await settings.click();
  await expect(note).toHaveValue('收起设置也保留的专注草稿 ' + suffix);
  await app.getByRole('button', { name: '收起计时设置', exact: true }).click();
  await timer.getByRole('button', { name: '结束并保存', exact: true }).click();
  await openToDooFocusHistory(page);
  const record = app.locator('.todo-focus-history-item').filter({ hasText: suffix }).first();
  const more = record.locator('summary');
  await expect(record.getByRole('button', { name: '修正', exact: true })).not.toBeVisible();
  await more.focus();
  await more.press('Enter');
  await expect(record.getByRole('button', { name: '修正', exact: true })).toBeVisible();
  await more.press('Escape');
  await expect(record.getByRole('button', { name: '修正', exact: true })).not.toBeVisible();
  await expect(more).toBeFocused();
  await more.press('Enter');
  await record.getByRole('button', { name: '修正', exact: true }).click();
  await expect(record.locator('details')).not.toHaveAttribute('open');
  const correction = page.getByRole('dialog', { name: '修正专注时长', exact: true });
  await expect(correction).toBeVisible();
  await correction.getByRole('button', { name: '取消', exact: true }).click();
  const saved = await (await page.request.get('/api/to-doo/state?taskIds=' + task.ids[0])).json();
  expect(saved.occurrences.find((row: any) => row.id === snapshot.occurrences[0].id).status).toBe(
    'todo',
  );
});

test('anniversary details expand on demand while its original lunar date remains visible', async ({
  page,
}) => {
  const command = await commands(page);
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = '团圆纪念 ' + suffix;
  const description = '相约回家一起吃饭 ' + suffix;
  await command('save_entity', {
    kind: 'anniversary',
    entity: {
      id: 'cohesion-anniversary-' + suffix,
      name,
      date: '2001-08-15',
      calendar: 'lunar',
      repeatYearly: true,
      description,
    },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=anniversaries');
  const card = page
    .locator('.todo-anniversary')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card.getByText('农历原日期：2001-08-15', { exact: true })).toBeVisible();
  await expect(card.getByText(description, { exact: true })).not.toBeVisible();
  await expect(card.getByRole('button', { name: '编辑 ' + name, exact: true })).toBeVisible();
  const details = card.locator('summary');
  await details.focus();
  await details.press('Enter');
  await expect(card.getByText(description, { exact: true })).toBeVisible();
  await expect(card.getByText('每年重复', { exact: true })).toBeVisible();
  await details.press('Enter');
  await expect(card.getByText(description, { exact: true })).not.toBeVisible();
});
