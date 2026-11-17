import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';
import { openToDooDirectory } from '../support/to-doo-navigation';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function openListEditor(page: Page) {
  const navigation = await openToDooDirectory(page);
  await navigation.locator('button[aria-label="新建清单"]').click();
  const dialog = page.getByRole('dialog', { name: '新建清单', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function saveList(page: Page, dialog: Locator) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/to-doo/commands') &&
      response.request().postDataJSON()?.payload.kind === 'list',
  );
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json();
  await expect(dialog).toBeHidden();
  return result.ids[0] as string;
}
async function inside(page: Page, element: Locator) {
  const box = (await element.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('a parent and child list persist their appearance and the navigation can fold the branch', async ({
  page,
}, info) => {
  const suffix = info.project.name + '-' + crypto.randomUUID().slice(0, 6);
  const parentName = '工作与创作 ' + suffix;
  const childName = '阅读计划 ' + suffix;
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  let editor = await openListEditor(page);
  await editor.getByLabel('清单名称', { exact: true }).fill(parentName);
  await editor.getByRole('button', { name: '文件夹', exact: true }).click();
  await editor.getByRole('button', { name: '松绿色', exact: true }).click();
  const parentId = await saveList(page, editor);
  editor = await openListEditor(page);
  await editor.getByLabel('清单名称', { exact: true }).fill(childName);
  await selectToDooOption(editor, '上级清单', parentName);
  await editor.getByRole('button', { name: '阅读图标', exact: true }).click();
  await editor.getByRole('button', { name: '雾紫色', exact: true }).click();
  await inside(page, editor.locator('.ant-modal-content'));
  await page.screenshot({ path: info.outputPath('child-list-editor.png'), animations: 'disabled' });
  const childId = await saveList(page, editor);
  const data = await (await page.request.get('/api/to-doo/state?kind=list&limit=1000')).json();
  expect(data.lists.find((list: any) => list.id === parentId)).toMatchObject({
    icon: 'folder',
    color: '#4f8c7a',
    parentId: null,
  });
  expect(data.lists.find((list: any) => list.id === childId)).toMatchObject({
    parentId,
    icon: '📚',
    color: '#9470b8',
  });
  const nav = await openToDooDirectory(page);
  const child = nav.getByRole('button', { name: childName, exact: true });
  await expect(child).toBeVisible();
  await expect(child.locator('.todo-list-icon')).toHaveText('📚');
  const before = page.url();
  await nav.getByRole('button', { name: '折叠清单 ' + parentName, exact: true }).click();
  await expect(child).toBeHidden();
  expect(page.url()).toBe(before);
  await nav.getByRole('button', { name: '展开清单 ' + parentName, exact: true }).click();
  await expect(child).toBeVisible();
  await page.reload();
  await openToDooDirectory(page);
  await expect(
    nav.getByRole('button', { name: childName, exact: true }).locator('.todo-list-icon'),
  ).toHaveText('📚');
});

test('the list editor keeps color choices and its actions usable on a narrow dark screen', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const session = await (await page.request.get('/api/auth/get-session')).json();
  await page.addInitScript((ownerId) => {
    localStorage.setItem(
      'dooknow.preferences.v1:' + encodeURIComponent(ownerId),
      JSON.stringify({ theme: 'dark' }),
    );
  }, session.user.id);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const editor = await openListEditor(page);
  await editor.getByLabel('清单名称', { exact: true }).fill('夜间阅读');
  await editor.getByRole('button', { name: '彩色圆点', exact: true }).click();
  await editor.getByRole('button', { name: '珊瑚色', exact: true }).click();
  await expect(editor.getByRole('button', { name: '彩色圆点', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const body = editor.locator('.ant-modal-body');
  expect(await body.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await inside(page, editor.locator('.ant-modal-content'));
  const save = editor.getByRole('button', { name: '保存', exact: true });
  await save.scrollIntoViewIfNeeded();
  await inside(page, save);
  await page.screenshot({
    path: info.outputPath('narrow-list-editor.png'),
    animations: 'disabled',
  });
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '确认操作', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '确认', exact: true }).click();
  await expect(editor).toBeHidden();
});
