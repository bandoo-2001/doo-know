import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import {
  closeToDooDirectory,
  goToToDooSection,
  openToDooDirectory,
} from '../support/to-doo-navigation';

async function expectSelectedEntry(page: Page, name: string) {
  const directory = await openToDooDirectory(page);
  await expect(directory.getByRole('button', { name, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await closeToDooDirectory(page);
}

async function createList(page: Page, name: string) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: { kind: 'list', entity: { name, kind: 'list' } },
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).ids[0] as string;
}

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 390, height: 844 });
});

test('mobile navigation opens personal lists and quick capture inherits the selected list', async ({
  page,
}, info) => {
  const suffix = info.project.name + '-' + Date.now();
  const listAName = '手机工作清单 ' + suffix;
  const listBName = '手机生活清单 ' + suffix;
  const listA = await createList(page, listAName);
  const listB = await createList(page, listBName);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  const form = app.getByRole('form', { name: '快速添加任务', exact: true });
  const input = form.getByRole('textbox', { name: '快速添加任务', exact: true });
  const directory = await openToDooDirectory(page);
  await expect(directory.getByRole('button', { name: listAName, exact: true })).toBeVisible();
  await expect(directory.getByRole('button', { name: listBName, exact: true })).toBeVisible();
  await closeToDooDirectory(page);

  for (const [listId, name] of [
    [listA, listAName],
    [listB, listBName],
  ]) {
    const directory = await openToDooDirectory(page);
    await directory.getByRole('button', { name, exact: true }).click();
    await expect(app.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('list')).toBe(listId);
    await expectSelectedEntry(page, name);
    const title = '清单中的快速行动 ' + name;
    await input.fill(title);
    await form.getByRole('button', { name: '添加任务', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(app.getByRole('button', { name: title, exact: true })).toBeVisible();
    const state = await (
      await page.request.get(
        '/api/to-doo/state?filter=' + encodeURIComponent(JSON.stringify({ query: title })),
      )
    ).json();
    expect(state.tasks.filter((task: any) => task.title === title)).toHaveLength(1);
    expect(state.tasks.find((task: any) => task.title === title)?.listId).toBe(listId);
  }

  await page.reload();
  await expect(app.getByRole('heading', { name: listBName, exact: true })).toBeVisible();
  await expectSelectedEntry(page, listBName);
  for (const [filter, name] of [
    ['today', '今天'],
    ['upcoming', '近七天'],
    ['inbox', '收集箱'],
  ]) {
    const directory = await openToDooDirectory(page);
    await directory.getByRole('button', { name, exact: true }).click();
    await expect(app.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe(filter);
    expect(new URL(page.url()).searchParams.get('list')).toBeNull();
    await expectSelectedEntry(page, name);
  }
  await goToToDooSection(page, 'calendar');
  await expect(app.locator('.todo-page h1')).toHaveText('日历');
  await goToToDooSection(page, 'tasks');
  await expect(app.getByRole('heading', { name: '所有任务', exact: true })).toBeVisible();
  await expectSelectedEntry(page, '所有任务');
});

test('closing mobile new-list creation keeps the current list selected', async ({ page }, info) => {
  const name = '手机清单创建入口 ' + info.project.name + '-' + Date.now();
  const listId = await createList(page, name);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listId);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  await expect(app.getByRole('heading', { name, exact: true })).toBeVisible();
  const directory = await openToDooDirectory(page);
  await directory.getByRole('button', { name: '新建清单', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建目标与清单', exact: true });
  await expect(editor.getByLabel('名称', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expectSelectedEntry(page, name);
  expect(new URL(page.url()).searchParams.get('list')).toBe(listId);
});
