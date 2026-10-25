import { expandFolderPath } from '../support/notebook-tree';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test.use({ sourceEditorPreference: true });

for (const viewport of [
  { width: 568, height: 240 },
  { width: 1024, height: 240 },
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
]) {
  test(`keeps navigation and note actions reachable at ${viewport.width}×${viewport.height} without scrolling the whole page`, async ({
    page,
    context,
  }) => {
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    await page.setViewportSize(viewport);
    await page.goto('/');
    if (viewport.width <= 720) {
      const closeSidebar = page.getByRole('button', { name: '关闭侧栏', exact: true });
      await expect(closeSidebar).toBeVisible();
      await closeSidebar.click();
      await expect(page.locator('.sidebar')).not.toHaveClass(/\bopen\b/);
      await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
      await expect(page.locator('.sidebar')).toHaveClass(/\bopen\b/);
    }
    await expandFolderPath(page, '30-Knowledge/个人知识管理/方法');
    await page.getByRole('button', { name: '入门指南.md', exact: true }).click();
    await expect(page.locator('.cm-content')).toBeVisible();
    const more = page.getByRole('button', { name: '更多操作', exact: true });
    await more.click();
    await expect(page.getByRole('button', { name: '移动或重命名', exact: true })).toBeFocused();
    const menu = page.getByRole('dialog', { name: '笔记操作', exact: true });
    for (const control of await menu.locator('button, input').all()) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 0.99 });
      if (await control.isEnabled()) await control.click({ trial: true });
    }
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
    await page.keyboard.press('Enter');
    const remove = page.getByRole('button', { name: '删除笔记', exact: true });
    await remove.scrollIntoViewIfNeeded();
    await expect(remove).toBeInViewport({ ratio: 0.99 });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
    ).toBe(true);
    await remove.click();
    await expect(page.getByText('移入回收站？', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('.cm-content')).toBeVisible();
  });
}
