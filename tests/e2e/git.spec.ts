import { configurePlugin, returnToNotes } from '../support/settings-navigation';
import { expandFolderPath } from '../support/notebook-tree';
import { clickNoteAction } from '../support/note-actions';
import { test, expect } from '../support/browser-test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
test('installs Git interactions, initializes, previews all changes and displays real history', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const mobile = info.project.name === 'mobile';
  await page.goto('/');
  await configurePlugin(page, 'Git 版本管理');
  await page.getByLabel('提交作者', { exact: true }).fill('Browser Fixture');
  await page.getByLabel('作者邮箱', { exact: true }).fill('browser@example.invalid');
  await page.getByRole('button', { name: '保存插件配置', exact: true }).click();
  const enable = page
    .locator('.plugin-settings')
    .getByRole('button', { name: '启用插件', exact: true });
  if (await enable.isVisible()) await enable.click();
  await page.getByRole('button', { name: '初始化 Git 仓库（main）', exact: true }).click();
  await expect(page.getByText('当前分支：main', { exact: true })).toBeVisible({ timeout: 10000 });
  await returnToNotes(page);
  if (mobile) await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await expandFolderPath(page, '30-Knowledge/个人知识管理/方法');
  await page.getByRole('button', { name: '入门指南.md', exact: true }).click();
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Git 版本', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  if (mobile) await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await page.getByRole('button', { name: '提交全部变更', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Git 提交说明', exact: true })
    .fill('Browser first commit');
  await page.getByRole('button', { name: '预览全部变更', exact: true }).click();
  await expect(
    page.getByText('A · 30-Knowledge/个人知识管理/方法/入门指南.md', { exact: true }),
  ).toBeVisible({ timeout: 10000 });
  const fixture = JSON.parse(await readFile('.local/e2e-config.json', 'utf8')),
    file = join(fixture.knowledgeRoot, '30-Knowledge/个人知识管理/方法/入门指南.md');
  await writeFile(file, (await readFile(file, 'utf8')) + '\n\n# External change before confirm\n');
  await page.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(
    page.getByText('预览后文件或暂存区发生变化，请重新预览', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '预览全部变更', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认提交', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(page.getByText(/提交 [a-f0-9]{40} 已完成/)).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  if (mobile) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
  await clickNoteAction(page, 'Git 版本');
  await expect(page.getByText(/Browser Fixture · Browser first commit/)).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole('button', { name: '查看差异', exact: true }).click();
  await expect(page.locator('.dooknow-git-history pre')).toContainText('搭建自己的知识库', {
    timeout: 10000,
  });
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
});
