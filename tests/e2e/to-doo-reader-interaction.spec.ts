import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import type { ToDooCommandResult, ToDooSnapshot } from '../../shared/to-doo-contracts';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function openTaskList(page: Page) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json() as ToDooCommandResult;
  }
  const list = await command('save_entity', { kind: 'list', entity: { name: '逐项检查 ' + crypto.randomUUID(), kind: 'list' } });
  for (const title of ['核对预算', '更新排期', '确认交付'])
    await command('create_task', { title, listId: list.ids[0], due: { date: '2034-03-23' } });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&list=' + list.ids[0]);
  const rows = page.locator('.todo-task-list-panel .todo-task-body');
  await expect(rows).toHaveCount(3);
  return rows;
}

test('read adjacent tasks in list order, keep the unsaved note and return to the active row', async ({ page }) => {
  const rows = await openTaskList(page);
  const titles = await rows.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')!));
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes.push(request.postData()!);
  });
  await rows.nth(0).click();
  const reader = page.getByRole('complementary', { name: '任务详情', exact: true });
  const title = reader.getByRole('textbox', { name: '任务标题' });
  const previous = reader.getByRole('button', { name: '上一个任务' });
  const next = reader.getByRole('button', { name: '下一个任务' });
  await expect(previous).toBeDisabled();
  await reader.getByRole('button', { name: '＋ 添加说明', exact: true }).click();
  const note = reader.getByRole('textbox', { name: '任务说明' });
  await expect(note).toBeFocused();
  await page.keyboard.type('draft note');
  const firstId = new URL(page.url()).searchParams.get('task')!;
  await next.click();
  await expect(title).toHaveValue(titles[1]);
  await expect(next).toBeFocused();
  await next.press('Enter');
  await expect(title).toHaveValue(titles[2]);
  await expect(next).toBeDisabled();
  await expect(previous).toBeFocused();
  await previous.click();
  await previous.press('Enter');
  await expect(title).toHaveValue(titles[0]);
  await expect(note).toHaveValue('draft note');
  await next.click();
  await expect(title).toHaveValue(titles[1]);
  await page.keyboard.press('Escape');
  await expect(reader).toBeHidden();
  await expect(rows.nth(1)).toBeFocused();
  expect(writes).toEqual([]);
  const saved: ToDooSnapshot = await (await page.request.get('/api/to-doo/state?taskIds=' + firstId)).json();
  expect(saved.tasks.find(task => task.id === firstId)?.description).toBe('');
});

test('an invalid date stays with its task when trying to advance from the reader', async ({ page }) => {
  const rows = await openTaskList(page);
  await rows.nth(0).click();
  const reader = page.getByRole('complementary', { name: '任务详情', exact: true });
  const original = page.url();
  await reader.getByRole('button', { name: '编辑截止日期' }).click();
  const property = page.getByRole('dialog', { name: '截止日期', exact: true });
  const date = property.getByLabel('截止日期', { exact: true });
  await date.fill('2034-99-99');
  await date.press('Tab');
  await property.locator('.ant-modal-close').click();
  await expect(property).toBeHidden();
  await reader.getByRole('button', { name: '下一个任务' }).click();
  await expect(property).toBeVisible();
  await expect(date).toHaveValue('2034-99-99');
  expect(page.url()).toBe(original);
  await property.getByRole('button', { name: '取消本次设置' }).click();
  await reader.getByRole('button', { name: '下一个任务' }).click();
  await expect(page).not.toHaveURL(original);
});
