import { readFile, mkdir } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(
    JSON.parse(
      await readFile(process.env.DOOKNOW_E2E_COOKIE_FILE || '.local/e2e-cookies.json', 'utf8'),
    ),
  );
});

test('脑图右键菜单新增和删除节点可保存，快捷键帮助适配窄屏', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建脑图', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建脑图', exact: true });
  await create.getByLabel('文件名', { exact: true }).fill('脑图操作菜单');
  await create.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('diagram-document-workspace');
  const root = workspace.locator('me-root me-tpc');
  await expect(root).toBeVisible();
  const id = new URL(page.url()).searchParams.get('note')!;
  await root.click({ button: 'right' });
  const menu = workspace.getByRole('menu', { name: '脑图节点操作', exact: true });
  await menu.getByRole('menuitem', { name: '新增子节点 Tab', exact: true }).click();
  await workspace.locator('#input-box').fill('菜单新增的节点');
  await page.keyboard.press('Enter');
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('status')).toContainText('已保存');
  expect((await (await page.request.get('/api/notes/' + id)).json()).content).toContain(
    '菜单新增的节点',
  );
  await page.reload();
  const node = workspace.locator('me-tpc').filter({ hasText: /^菜单新增的节点$/ });
  await expect(node).toBeVisible();
  await mkdir('.local/mindmap-controls', { recursive: true });
  await node.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.screenshot({
    path: '.local/mindmap-controls/context-menu.png',
    animations: 'disabled',
  });
  await menu.getByRole('menuitem', { name: '删除节点 Delete', exact: true }).click();
  await expect(node).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(node).toBeVisible();
  await workspace.getByRole('button', { name: '保存图形', exact: true }).click();
  await expect(workspace.getByRole('status')).toContainText('已保存');
  expect((await (await page.request.get('/api/notes/' + id)).json()).content).toContain(
    '菜单新增的节点',
  );
  await workspace.getByRole('button', { name: '脑图快捷键', exact: true }).click();
  const help = workspace.getByRole('dialog', { name: '脑图快捷键', exact: true });
  await expect(help).toBeVisible();
  await page.screenshot({ path: '.local/mindmap-controls/shortcuts.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await page.setViewportSize({ width: 320, height: 640 });
  await workspace.getByRole('button', { name: '脑图快捷键', exact: true }).click();
  const bounds = (await help.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: '.local/mindmap-controls/shortcuts-mobile.png',
    animations: 'disabled',
  });
});
