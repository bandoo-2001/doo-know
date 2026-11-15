import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { openToDooTaskTools } from '../support/to-doo-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('task forms retain drafts and make saved edits clear without instructional banners', async ({
  page,
}, info) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  await page.getByLabel('新建任务', { exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  const title = '安静的任务表单 ' + crypto.randomUUID();
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  await expect(detail.getByLabel('初始状态', { exact: true })).not.toBeVisible();
  await expect(detail.locator('.todo-hint')).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('task-create.png'),
    animations: 'disabled',
  });
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByLabel('新建任务', { exact: true }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(detail.getByText('已保存', { exact: true })).toBeVisible();
  const edited = title + ' 已更新';
  await detail.getByLabel('任务标题', { exact: true }).fill(edited);
  await expect(detail.getByText('未保存的更改', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(detail.getByText('已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(edited);
  await expect(detail.getByText('已保存', { exact: true })).toBeVisible();
});

test('pages and forms have no instructional hint disclosures', async ({ page }, info) => {
  const markers: Record<string, string> = {
    focus: '.todo-focus-timer',
    calendar: '.todo-calendar-toolbar',
    matrix: '.todo-quadrants',
    habits: '.todo-habit-cards',
    stats: '.todo-review-grid',
    notifications: '.todo-notification-tabs',
    settings: '.todo-settings-tabs',
  };
  for (const [section, marker] of Object.entries(markers)) {
    await page.goto('/?view=apps&app=to-doo&appSection=' + section);
    const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
    await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
    await expect(app.locator(marker).first()).toBeVisible();
    await expect(app.locator('.todo-hint, .todo-focus-policy')).toHaveCount(0);
    await expect(app.getByText('使用说明', { exact: true })).toHaveCount(0);
    await expect(app.getByText('统计口径', { exact: true })).toHaveCount(0);
    if (section === 'focus')
      await page.screenshot({
        path: info.outputPath('focus-without-hints.png'),
        animations: 'disabled',
      });
  }
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  await page
    .locator('.todo-page-heading')
    .getByRole('button', { name: /新建习惯/ })
    .click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  await expect(editor.getByLabel('名称', { exact: true })).toBeVisible();
  await expect(editor.locator('.todo-hint')).toHaveCount(0);
  await expect(editor.getByText('使用说明', { exact: true })).toHaveCount(0);
});

test('clearing a search keeps the Today scope and removes only extra filters', async ({ page }) => {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=today');
  await expect(page.locator('.todo-page h1')).toHaveText('今天');
  await openToDooTaskTools(page);
  const search = page.getByRole('textbox', { name: '搜索任务', exact: true });
  await search.fill('不存在的任务 ' + crypto.randomUUID());
  await page.getByRole('button', { name: '执行搜索', exact: true }).click();
  await expect(page.locator('.todo-task-row')).toHaveCount(0);

  const filters = page.locator('.todo-task-scope');
  await filters.locator('summary').click();
  await filters.getByRole('button', { name: '清除筛选', exact: true }).click();

  await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe('today');
  await expect(page.locator('.todo-page h1')).toHaveText('今天');
  await openToDooTaskTools(page);
  await expect(search).toHaveValue('');
  await expect(filters).toHaveCount(0);
});
