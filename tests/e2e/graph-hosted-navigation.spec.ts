import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { showSidebar, closeSidebar } from '../support/settings-navigation';
import { openGraphPanel } from '../support/graph-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function enterGraph(page: import('@playwright/test').Page) {
  await page.goto('/?view=apps');
  await page
    .locator('.app-card')
    .filter({ has: page.getByRole('heading', { name: '知识图谱', exact: true }) })
    .click();
  await expect(page.locator('.graph-workspace')).toBeVisible();
}

test('graph owns the shared menu and opens its own model settings from the bottom tools', async ({
  page,
}) => {
  await enterGraph(page);
  await showSidebar(page);
  const menu = page.getByRole('navigation', { name: '知识图谱 主菜单', exact: true });
  await expect(menu.getByRole('button', { name: '笔记图谱', exact: true })).toBeVisible();
  await menu.getByRole('button', { name: '笔记图谱', exact: true }).click();
  await closeSidebar(page);
  await expect(
    page
      .getByRole('group', { name: '图谱类型', exact: true })
      .getByRole('radio', { name: '笔记', exact: true }),
  ).toBeChecked();
  await showSidebar(page);
  await page
    .getByRole('navigation', { name: '知识图谱 工具', exact: true })
    .getByRole('button', { name: '模型设置', exact: true })
    .click();
  const settings = page.getByRole('dialog', { name: '模型设置', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('switch', { name: '自动分析内容变化' })).toBeVisible();
  await settings.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await showSidebar(page);
  await page
    .locator('.workspace-footer')
    .getByRole('button', { name: '返回 DooKnow', exact: true })
    .click();
  await closeSidebar(page);
  await expect(page.getByRole('navigation', { name: '知识图谱 主菜单', exact: true })).toHaveCount(
    0,
  );
});

test('cancelled browser back keeps the model draft and URL, a later discard permits leaving', async ({
  page,
}) => {
  await enterGraph(page);
  await openGraphPanel(page, '模型');
  const settings = page.getByRole('dialog', { name: '模型设置', exact: true });
  const automatic = settings.getByRole('switch', { name: '自动分析内容变化' });
  const initial = await automatic.isChecked();
  await automatic.click();
  const original = page.url();
  await page.goBack();
  await expect(settings.getByText('有未保存的更改', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page).toHaveURL(original);
  await expect(automatic).toBeChecked({ checked: !initial });
  const protectedReload = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(protectedReload).toBe(true);
  const prompt = page.waitForEvent('dialog');
  // A dismissed reload never reaches the load event awaited by page.reload().
  const reload = page.evaluate(() => location.reload());
  const dialog = await prompt;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await reload;
  await expect(page).toHaveURL(original);
  await expect(automatic).toBeChecked({ checked: !initial });
  await page.goBack();
  await expect(settings.getByText('有未保存的更改', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: '放弃更改', exact: true }).click();
  await expect(page).toHaveURL(/\?view=apps$/);
  await expect(page.getByRole('heading', { name: '应用', exact: true })).toBeVisible();
});

test('saving model settings blocks back navigation until the request has completed', async ({
  page,
}) => {
  await enterGraph(page);
  await openGraphPanel(page, '模型');
  const settings = page.getByRole('dialog', { name: '模型设置', exact: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/graph/settings', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    started();
    await gate;
    await route.continue();
  });
  try {
    const original = page.url();
    await settings.getByRole('button', { name: '保存设置', exact: true }).click();
    await requestStarted;
    await page.goBack();
    await expect(page).toHaveURL(original);
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('button', { name: '关闭模型设置' })).toBeDisabled();
    release();
    await expect(settings.getByRole('status')).toContainText('设置已保存');
    await settings.getByRole('button', { name: '关闭模型设置' }).click();
    await page.goBack();
    await expect(page).toHaveURL(/\?view=apps$/);
  } finally {
    release();
  }
});
