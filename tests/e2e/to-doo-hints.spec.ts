import { mkdir, readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function createTask(page: Page) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'create_task',
      payload: { title: '提示独立关闭 ' + crypto.randomUUID() },
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).ids[0];
}

const hint = (page: Page, id: string) => page.locator('[data-todo-hint="' + id + '"]');

test('closing task creation guidance survives reopening and reload without hiding edit guidance', async ({
  page,
}, info) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  await page.getByLabel('新建任务', { exact: true }).click();
  const creation = hint(page, 'task-create-save');
  await expect(creation).toBeVisible();
  await expect(creation).toHaveClass(/ant-alert/);
  const screenshots = 'docs/design/to-doo/two-level-implementation-2026-11-04/regression-screenshots/card-polish';
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: screenshots + '/' + info.project.name + '-task-hint.png',
    fullPage: true,
    animations: 'disabled',
  });
  await creation.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(creation).not.toBeVisible();
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByLabel('新建任务', { exact: true }).click();
  await expect(creation).not.toBeVisible();
  await page.reload();
  await page.getByLabel('新建任务', { exact: true }).click();
  await expect(creation).not.toBeVisible();

  const taskId = await createTask(page);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + taskId);
  const editing = hint(page, 'task-edit-save');
  await expect(editing).toBeVisible();
  await editing.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('complementary', { name: '任务详情', exact: true })).toBeVisible();
  await expect(editing).not.toBeVisible();
});

test('dismissing entity save guidance persists and does not dismiss a different page hint', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  await page
    .getByRole('button', { name: /新建习惯/ })
    .first()
    .click();
  const entity = hint(page, 'entity-save-policy');
  await expect(entity).toBeVisible();
  await entity.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.reload();
  await page
    .getByRole('button', { name: /新建习惯/ })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: '新建习惯', exact: true })).toBeVisible();
  await expect(entity).not.toBeVisible();
  await page.goto('/?view=apps&app=to-doo&appSection=matrix');
  await expect(hint(page, 'matrix-placement')).toBeVisible();
  await hint(page, 'matrix-placement')
    .getByRole('button', { name: '关闭提示', exact: true })
    .click();
  await page.reload();
  await expect(page.locator('.todo-quadrants')).toBeVisible();
  await expect(hint(page, 'matrix-placement')).not.toBeVisible();
});
