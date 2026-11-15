import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/browser-test';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('dates and row padding open the same task while selection and row controls keep their actions', async ({ page }) => {
  const list = await command(page, 'save_entity', {
    kind: 'list', entity: { name: '任务行点击 ' + crypto.randomUUID() },
  });
  const title = '点击日期打开任务';
  const today = new Date().toISOString().slice(0, 10);
  await command(page, 'create_task', { listId: list.ids[0], title, due: { date: today, timeZone: 'UTC' } });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list.ids[0]);
  const row = page.locator('.todo-task-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  const date = row.locator('.todo-task-date-value');
  const detail = page.getByLabel('任务标题', { exact: true });
  await date.click();
  await expect(detail).toHaveValue(title);
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(row.getByRole('button', { name: title, exact: true })).toBeFocused();
  const height = await row.evaluate(element => element.clientHeight);
  await row.click({ position: { x: 2, y: Math.floor(height / 2) } });
  await expect(detail).toHaveValue(title);
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await date.evaluate(element => {
    const selection = window.getSelection()!;
    selection.selectAllChildren(element);
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  });
  await expect(detail).not.toBeVisible();
  await row.getByRole('button', { name: '任务操作 ' + title, exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '安排时间', exact: true })).toBeVisible();
  await expect(detail).not.toBeVisible();
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: '完成 ' + title, exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(detail).not.toBeVisible();
});

test('row keys follow visible groups and leave detail, inputs and IME in control', async ({ page }) => {
  const list = await command(page, 'save_entity', {
    kind: 'list', entity: { name: '键盘行导航 ' + crypto.randomUUID() },
  });
  const listId = list.ids[0];
  const titles = ['起点', '隐藏的中项', '终点'];
  for (const [index, title] of titles.entries()) {
    const section = await command(page, 'save_entity', {
      kind: 'section', entity: { listId, name: title, orderKey: String(index) },
    });
    await command(page, 'create_task', { title, listId, sectionId: section.ids[0] });
  }
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listId);
  const listPanel = page.locator('.todo-task-list-panel');
  await listPanel.getByRole('button', { name: '折叠分组 隐藏的中项', exact: true }).click();
  const first = listPanel.getByRole('button', { name: titles[0], exact: true });
  const last = listPanel.getByRole('button', { name: titles[2], exact: true });
  await first.focus();
  await first.dispatchEvent('keydown', { key: 'ArrowDown', isComposing: true });
  await expect(first).toBeFocused();
  await first.press('ArrowUp');
  await expect(first).toBeFocused();
  await first.press('ArrowDown');
  await expect(last).toBeFocused();
  await last.press('Home');
  await expect(first).toBeFocused();
  await first.press('End');
  await expect(last).toBeFocused();
  await expect(page.locator('.todo-detail-layer')).toHaveCount(0);
  await last.press('Enter');
  const detail = page.getByLabel('任务标题', { exact: true });
  await expect(detail).toHaveValue(titles[2]);
  await detail.press('End');
  await detail.press('/');
  await expect(detail).toHaveValue(titles[2] + '/');
  await expect(page.getByRole('search')).not.toBeVisible();
});

test('slash opens search and typed shortcut characters stay in the active field', async ({ page }) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const button = page.getByRole('button', { name: '搜索任务', exact: true });
  await button.focus();
  await button.dispatchEvent('keydown', { key: '/', isComposing: true });
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.press('/');
  const input = page.getByRole('textbox', { name: '搜索任务', exact: true });
  await expect(input).toBeFocused();
  await input.pressSequentially('q/');
  await expect(input).toHaveValue('q/');
  await input.press('Escape');
  await expect(button).toBeFocused();
  await button.press('q');
  await expect(page.getByRole('textbox', { name: '快速添加任务', exact: true })).toBeFocused();
});

test('matrix context and keyboard menus use the target row and keep the button available', async ({ page }) => {
  const list = await command(page, 'save_entity', {
    kind: 'list', entity: { name: '象限操作 ' + crypto.randomUUID() },
  });
  const title = '从行打开菜单';
  await command(page, 'create_task', { listId: list.ids[0], title, importance: 'important', urgentOverride: false });
  await page.goto('/?view=apps&app=to-doo&appSection=matrix&list=' + list.ids[0]);
  const row = page.locator('.todo-quadrant-item').filter({ hasText: title });
  const name = row.getByRole('button', { name: title, exact: true });
  const actions = row.getByRole('button', { name: '任务操作 ' + title, exact: true });
  await name.click({ button: 'right' });
  await expect(actions).toHaveAttribute('aria-expanded', 'true');
  await page.getByText('归类象限', { exact: true }).filter({ visible: true }).click();
  await page.getByRole('menuitem', { name: '紧急不重要', exact: true }).click();
  await expect(page.locator('.todo-quadrant-delegate')).toContainText(title);
  await name.press('Shift+F10');
  const schedule = page.getByRole('menuitem', { name: '安排时间', exact: true });
  await expect(schedule).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  const high = page.getByRole('menuitem', { name: '高优先级', exact: true });
  await expect(high).toBeVisible();
  await page.keyboard.press('End');
  await expect(high).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(high).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(name).toBeFocused();
  await actions.click();
  await expect(schedule).toBeVisible();
});
