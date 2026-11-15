import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expectToDooSelection, selectToDooOption } from '../support/to-doo-ant-controls';
import {
  goToToDooSection,
  openToDooDirectory,
  selectToDooQuickView,
} from '../support/to-doo-navigation';

async function list(page: Page, name: string) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: { kind: 'list', entity: { name } },
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).ids[0] as string;
}

test('continue restores the original draft after changing destination while another list draft survives reload', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const suffix = info.project.name + '-' + crypto.randomUUID();
  const nameA = '草稿来源A ' + suffix,
    nameB = '草稿目的B ' + suffix;
  const listA = await list(page, nameA);
  await list(page, nameB);
  const titleA = 'A中保留的任务 ' + suffix,
    titleB = 'B中另一份草稿 ' + suffix;
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listA);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
  await app.getByLabel('新建任务', { exact: true }).click();
  const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
  await detail.getByLabel('任务标题', { exact: true }).fill(titleA);
  await selectToDooOption(detail, '目标或清单', nameB);
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  const directory = await openToDooDirectory(page);
  await directory.getByRole('button', { name: nameB, exact: true }).click();
  const quick = app.getByRole('textbox', { name: '快速添加任务', exact: true });
  await quick.fill(titleB);
  await page.reload();
  await expect(quick).toHaveValue(titleB);
  await app.getByRole('button', { name: '任务草稿', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: titleA }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(titleA);
  await expectToDooSelection(detail, '目标或清单', nameB);
  await selectToDooOption(detail, '目标或清单', '收集箱');
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(quick).toHaveValue(titleB);
  await page.reload();
  await expect(quick).toHaveValue(titleB);
  await app.getByRole('button', { name: '任务草稿', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: titleA }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(titleA);
  await expectToDooSelection(detail, '目标或清单', '收集箱');
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(quick).toHaveValue(titleB);
  await app.getByRole('button', { name: '任务草稿', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: titleB }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(titleB);
});

test('retained task drafts stay quiet across other pages and reopen from task actions', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=inbox');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app.getByLabel('新建任务', { exact: true }).click();
  const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
  const title = '安静保留的任务 ' + info.project.name + '-' + crypto.randomUUID();
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(app.locator('.todo-notice')).toHaveCount(0);
  await expect(app.getByRole('button', { name: '任务草稿', exact: true })).toBeVisible();
  const markers: Record<string, string> = {
    focus: '.todo-focus-timer',
    habits: '.todo-habit-cards',
    calendar: '.todo-calendar-toolbar',
    stats: '.todo-review-grid',
    notifications: '.todo-notification-tabs',
    settings: '.todo-settings-tabs',
  };
  for (const [section, marker] of Object.entries(markers)) {
    await goToToDooSection(page, section);
    await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
    await expect(app.locator(marker).first()).toBeVisible();
    await expect(app.getByText(/新建草稿|继续新建任务草稿|已继续保留/)).toHaveCount(0);
    await expect(app.getByRole('button', { name: '任务草稿', exact: true })).toHaveCount(0);
    await expect(app.locator('.todo-notice')).toHaveCount(0);
    if (section === 'focus')
      await page.screenshot({
        path: info.outputPath('focus-with-retained-draft.png'),
        animations: 'disabled',
      });
  }
  await page.reload();
  await selectToDooQuickView(page, '收集箱');
  await app.getByRole('button', { name: '任务草稿', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: title }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expect(detail.locator('[role="status"]')).toHaveCount(0);
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await app.getByLabel('新建任务', { exact: true }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
});
