import { expandToDooGroup } from '../support/to-doo-ant-controls';
import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { goToToDooSection } from '../support/to-doo-navigation';

test('task entry skips other page modules and a failed page can retry without losing the task draft', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const modules: string[] = [];
  page.on('request', (request) => modules.push(new URL(request.url()).pathname));
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.locator('.todo-tree')).toBeVisible();
  expect(
    modules.filter((path) => /ToDoo(Calendar|Rhythm|Review|Settings)\.vue$/.test(path)),
  ).toEqual([]);
  const title = app.getByRole('textbox', { name: '快速添加任务', exact: true });
  await title.fill('功能重试后仍保留的任务草稿');
  await page.route(
    (url) => url.pathname.endsWith('/ToDooSettings.vue'),
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'text/javascript',
        body: 'temporarily unavailable',
      }),
    { times: 1 },
  );
  await goToToDooSection(page, 'settings');
  await expect(app.getByText('暂时无法加载此功能', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: '重试加载功能', exact: true }).click();
  await expandToDooGroup(app, '日期与提醒');
  await expect(app.getByLabel('显示时区', { exact: true })).toBeVisible();
  await goToToDooSection(page, 'tasks');
  await expect(title).toHaveValue('功能重试后仍保留的任务草稿');
});

test('page-header actions wait for a delayed review module', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=tasks');
  await expect(page.locator('.todo-tree')).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname.endsWith('/ToDooReview.vue'),
    async (route) => {
      await gate;
      await route.continue();
    },
  );
  try {
    await goToToDooSection(page, 'stats');
    await expect(page.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
    const create = page.getByRole('button', { name: '＋ 写一篇复盘', exact: true });
    await expect(create).toBeDisabled();
    release();
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page.getByRole('dialog', { name: '新建复盘', exact: true })).toBeVisible();
  } finally {
    release();
  }
});
