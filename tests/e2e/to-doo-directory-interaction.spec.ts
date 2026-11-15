import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { ToDooCommandResult, ToDooSnapshot } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const result = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(result.ok(), await result.text()).toBe(true);
  return (await result.json() as ToDooCommandResult).ids[0]!;
}

test('folding only the list group preserves its scroll position, selected list and open task draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 812 });
  const name = '目录选择 ' + crypto.randomUUID();
  const list = await command(page, 'save_entity', { kind: 'list', entity: { name } });
  const task = await command(page, 'create_task', { title: '正在编辑的任务', listId: list });
  // Pad only the catalogue read; the selected list and task are real records.
  await page.route('**/api/to-doo/state?kind=list&limit=200', async route => {
    const response = await route.fetch();
    const data = await response.json() as ToDooSnapshot;
    const seed = data.lists[0]!;
    data.lists = [...Array.from({ length: 32 }, (_, i) => ({ ...seed, id: 'nav-padding-' + i, name: '目录条目 ' + i })), ...data.lists];
    await route.fulfill({ response, json: data });
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list + '&task=' + task);
  const nav = page.getByRole('navigation', { name: 'To Doo 任务导航', exact: true });
  const group = nav.getByRole('region', { name: '我的清单', exact: true });
  const toggle = group.getByRole('button', { name: '我的清单', exact: true });
  const current = group.getByRole('button', { name, exact: true });
  const rows = group.locator('.todo-navigation-list-items');
  const title = page.getByRole('complementary', { name: '任务详情' }).getByLabel('任务标题', { exact: true });
  await expect(title).toHaveValue('正在编辑的任务');
  await title.fill('还未保存的修改');
  await expect(rows.getByRole('button', { name: '目录条目 31', exact: true })).toBeVisible();
  await expect(current).toHaveAttribute('aria-current', 'page');
  await current.scrollIntoViewIfNeeded();
  const offset = await rows.evaluate(el => el.scrollTop);
  expect(offset).toBeGreaterThan(0);
  await expect(toggle).toHaveAttribute('aria-controls', (await rows.getAttribute('id'))!);
  const url = page.url();
  await toggle.press('Enter');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(rows).toBeHidden();
  await expect(nav.getByRole('button', { name: '今天', exact: true })).toBeInViewport();
  await page.keyboard.press('Tab');
  await expect(group.getByRole('button', { name: '新建清单', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('button', { name: '更多任务范围', exact: true })).toBeFocused();
  await toggle.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(current).toBeInViewport();
  await expect(current).toHaveAttribute('aria-current', 'page');
  expect(await rows.evaluate(el => el.scrollTop)).toBe(offset);
  await expect(title).toHaveValue('还未保存的修改');
  await expect(page).toHaveURL(url);
});

test('the folded mobile list group keeps quick navigation and single-click list creation available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  const opener = page.getByRole('button', { name: '功能导航', exact: true });
  const drawer = page.getByRole('dialog', { name: '功能导航', exact: true });
  const group = drawer.getByRole('region', { name: '我的清单', exact: true });
  const toggle = group.getByRole('button', { name: '我的清单', exact: true });
  await opener.click();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await drawer.getByRole('button', { name: '今天', exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
  await opener.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await group.getByRole('button', { name: '新建清单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建清单', exact: true });
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: '今天', exact: true })).toBeVisible();
});

test('the icon rail identifies actions on hover and keyboard focus without covering its More menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  const rail = page.getByRole('navigation', { name: 'To Doo 主菜单', exact: true });
  const task = rail.getByRole('button', { name: '任务', exact: true });
  const calendar = rail.getByRole('button', { name: '日历', exact: true });
  const hint = page.locator('.todo-module-hint');
  await calendar.hover();
  await expect(hint).toHaveText('日历');
  await hint.hover();
  await expect(hint).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hint).toBeHidden();
  await task.click();
  await page.keyboard.press('Tab');
  await expect(calendar).toBeFocused();
  await expect(hint).toHaveText('日历');
  await page.keyboard.press('Escape');
  await expect(hint).toBeHidden();
  await expect(calendar).toBeFocused();
  const more = rail.getByRole('button', { name: '更多模块', exact: true });
  await more.press('Enter');
  const menu = page.getByRole('group', { name: '更多模块', exact: true });
  await expect(menu).toBeVisible();
  await expect(hint).toBeHidden();
  await menu.getByRole('button', { name: '目标总览', exact: true }).press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
});
