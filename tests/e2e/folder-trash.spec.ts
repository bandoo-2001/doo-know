import { test, expect } from '../support/browser-test';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expandFolderPath } from '../support/notebook-tree';
import { showSidebar } from '../support/settings-navigation';

test('folder menus confirm deletion and restore the whole folder after a name conflict', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const { knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const name = 'folder-trash-' + crypto.randomUUID();
  const path = '00-Inbox/' + name;
  await mkdir(join(knowledgeRoot, path, 'empty'), { recursive: true });
  await writeFile(join(knowledgeRoot, path, 'keep.md'), '# 文件夹内容');
  await page.goto('/');
  await expandFolderPath(page, path);
  await page.getByRole('button', { name: 'keep.md', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('文件夹内容');
  const originalNote = new URL(page.url()).searchParams.get('note');
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('待保存输入');
  await showSidebar(page);
  await page.getByRole('button', { name: name + ' 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  const leave = page.getByRole('dialog').filter({ hasText: '保存并继续' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('待保存输入');
  await page.getByRole('button', { name: name + ' 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  await leave.getByRole('button', { name: '放弃修改', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: '文件夹移入回收站' });
  await expect(dialog).toContainText(path);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect((await page.request.get('/api/notes/' + originalNote)).status()).toBe(200);
  await page.getByRole('button', { name: name + ' 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  const requests: string[] = [];
  await page.route('**/api/folders', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    requests.push(route.request().postDataJSON().requestId);
    if (requests.length === 1) {
      await route.fetch();
      return route.abort('failed');
    }
    return route.continue();
  });
  await dialog.getByRole('button', { name: '移入回收站', exact: true }).click();
  await dialog.getByRole('button', { name: '核对删除结果', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await showSidebar(page);
  await expect(page.getByTitle(path, { exact: true })).toHaveCount(0);
  await page.locator('.footer-tools').getByRole('button', { name: '回收站', exact: true }).click();
  const item = page
    .locator('.trash-item')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(item).toContainText('文件夹');
  await mkdir(join(knowledgeRoot, path));
  await item.getByRole('button', { name: '恢复文件夹', exact: true }).click();
  await expect(item.getByRole('textbox')).toBeVisible();
  await item.getByRole('textbox').fill(name + '-restored');
  await item.getByRole('button', { name: '恢复文件夹', exact: true }).click();
  await expect(item).toHaveCount(0);
  expect(await readdir(join(knowledgeRoot, path + '-restored'))).toEqual(['empty', 'keep.md']);
  const restored = await page.request.get('/api/notes/' + originalNote);
  expect(restored.status()).toBe(200);
  expect((await restored.json()).relativePath).toBe(path + '-restored/keep.md');
});
