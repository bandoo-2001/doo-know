import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/browser-test';

const tasksUrl = '/?view=apps&app=to-doo&appSection=tasks';
const capture = (page: Page) => page.getByRole('form', { name: '快速添加任务', exact: true });

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('consecutive entries keep their list and keyboard focus, including IME and repeated Enter', async ({ page }) => {
  const name = '本周采购 ' + crypto.randomUUID().slice(0, 8);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action: 'save_entity', payload: { kind: 'list', entity: { name, kind: 'list' } } },
  });
  expect(response.ok()).toBe(true);
  const listId = (await response.json()).ids[0];
  await page.goto(tasksUrl + '&list=' + listId);
  const form = capture(page);
  const input = form.getByRole('textbox', { name: '快速添加任务' });
  await expect(input).toHaveAttribute('placeholder', `添加任务至「${name}」`);
  const writes: { title: string; listId: string }[] = [];
  const first = '核对采购单', second = '领取包裹';
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/to-doo/commands', async (route) => {
    writes.push(route.request().postDataJSON().payload);
    if (writes.length === 1) await gate;
    await route.continue();
  });
  await input.fill(first);
  await input.dispatchEvent('compositionstart');
  await page.keyboard.press('Enter');
  await input.dispatchEvent('compositionend');
  await expect(input).toHaveValue(first);
  await expect(form.getByRole('button', { name: '添加任务', exact: true })).toBeEnabled();
  expect(writes).toHaveLength(0);
  await page.keyboard.press('Enter');
  try {
    await expect.poll(() => writes.length).toBe(1);
    await page.keyboard.press('Enter');
    await expect(input).toBeFocused();
  } finally { release(); }
  const feedback = form.locator('[aria-live="polite"]');
  await expect(feedback).toContainText(`已添加「${first}」`);
  await expect(input).toBeFocused();
  await page.keyboard.insertText(second);
  await page.keyboard.press('Enter');
  await expect(feedback).toContainText(`已添加「${second}」`);
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  expect(writes.map(({ title, listId }) => ({ title, listId }))).toEqual([{ title: first, listId }, { title: second, listId }]);
  await expect(page.getByRole('button', { name: first, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: second, exact: true })).toBeVisible();
});

test('a lost reply preserves the original dated input across reload and replays the same create', async ({ page }) => {
  const title = '核对账单 ' + crypto.randomUUID().slice(0, 8);
  const raw = '明天 ' + title;
  const writes: string[] = [];
  await page.route('**/api/to-doo/commands', async (route) => {
    writes.push(route.request().postDataJSON().requestId);
    if (writes.length > 1) return route.continue();
    expect((await route.fetch()).ok()).toBe(true);
    await route.fulfill({ status: 503, json: { error: '确认响应中断' } });
  });
  await page.goto(tasksUrl);
  const form = capture(page);
  const input = form.getByRole('textbox', { name: '快速添加任务' });
  await input.fill(raw);
  await input.press('Enter');
  const retry = form.getByRole('button', { name: '重试添加', exact: true });
  await expect(retry).toBeFocused();
  await expect(input).toHaveValue(raw);
  await page.reload();
  await expect(input).toHaveValue(raw);
  await expect(form.getByRole('button', { name: '纠正计划日期', exact: true })).toContainText('明天');
  await retry.click();
  await expect(form.locator('[aria-live="polite"]')).toContainText(`已添加「${title}」`);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  expect(writes).toHaveLength(2);
  expect(writes[1]).toBe(writes[0]);
  const query = new URLSearchParams({ filter: JSON.stringify({ query: title }) });
  const snapshot = await (await page.request.get('/api/to-doo/state?' + query)).json();
  expect(snapshot.tasks.filter((entry: { title: string }) => entry.title === title)).toHaveLength(1);
});

test('a rejected entry keeps the original text ready for keyboard correction', async ({ page }) => {
  const title = '修订会议记录 ' + crypto.randomUUID().slice(0, 8);
  await page.goto(tasksUrl);
  const form = capture(page);
  const input = form.getByRole('textbox', { name: '快速添加任务' });
  await page.route('**/api/to-doo/commands', (route) =>
    route.fulfill({ status: 422, json: { error: '请修改后重新添加' } }), { times: 1 });
  await input.fill('明天 ' + title);
  await form.getByRole('button', { name: '添加任务', exact: true }).click();
  await expect(form.locator('[aria-live="polite"]')).toContainText('输入已保留');
  await expect(input).toHaveValue('明天 ' + title);
  await expect(input).toBeFocused();
  await input.fill(title);
  await input.press('Enter');
  await expect(form.locator('[aria-live="polite"]')).toContainText(`已添加「${title}」`);
});

test('quick capture beside an open task keeps its reader, URL and unsaved note', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(tasksUrl + '&taskFilter=inbox');
  const suffix = crypto.randomUUID().slice(0, 8);
  const originalTitle = '核对账单 ' + suffix;
  const nextTitle = '取回收据 ' + suffix;
  const form = capture(page);
  const input = form.getByRole('textbox', { name: '快速添加任务' });
  await input.fill(originalTitle);
  await input.press('Enter');
  const row = page.getByRole('button', { name: originalTitle, exact: true });
  await row.click();
  const reader = page.getByRole('complementary', { name: '任务详情', exact: true });
  const title = reader.getByRole('textbox', { name: '任务标题' });
  await expect(title).toHaveValue(originalTitle);
  await expect(page).toHaveURL(/[?&]task=[^&]+/);
  const openedUrl = page.url();
  await reader.getByRole('button', { name: '＋ 添加说明', exact: true }).click();
  const note = reader.getByRole('textbox', { name: '任务说明' });
  await note.fill('等待财务核对后再保存');
  await input.fill(nextTitle);
  await input.press('Enter');
  await expect(form.locator('[aria-live="polite"]')).toContainText(`已添加「${nextTitle}」`);
  await expect(page.getByRole('button', { name: nextTitle, exact: true })).toBeVisible();
  await expect(page).toHaveURL(openedUrl);
  await expect(title).toHaveValue(originalTitle);
  await expect(note).toHaveValue('等待财务核对后再保存');
  await expect(reader.getByRole('button', { name: '保存任务', exact: true })).toBeEnabled();
});
