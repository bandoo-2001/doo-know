import { showSidebar, returnToNotes } from '../support/settings-navigation';
import { expandFolderPath } from '../support/notebook-tree';
import { test, expect } from '../support/browser-test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

test('keeps navigation reachable and content scrolling inside the window with a long directory', async ({
  page,
  context,
}, info) => {
  const { knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const names = Array.from(
    { length: 36 },
    (_, i) => `布局滚动-${info.project.name}-${String(i + 1).padStart(2, '0')}.md`,
  );
  const content =
    '# 长目录与长文验收\n\n' + '这一行用于检查正文在自己的区域内滚动。\n\n'.repeat(250);
  await Promise.all(names.map((name) => writeFile(join(knowledgeRoot, '00-Inbox', name), content)));
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const sizes =
    info.project.name === 'desktop'
      ? [
          { width: 1536, height: 730 },
          { width: 1280, height: 600 },
          { width: 1280, height: 550 },
          { width: 844, height: 390 },
        ]
      : [
          { width: 390, height: 844 },
          { width: 390, height: 568 },
          { width: 568, height: 320 },
        ];
  const inWindow = async (selector: string) => {
    const box = await page.locator(selector).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  };
  try {
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.goto('/');
      await expect(page.locator('.main-content')).toBeVisible();
      await showSidebar(page);
      await page.getByRole('button', { name: '刷新目录', exact: true }).click();
      await expandFolderPath(page, '00-Inbox');
      const last = page
        .locator('.tree-scroll')
        .getByRole('button', { name: names.at(-1)!, exact: true });
      await expect(last).toBeAttached();
      if (await page.locator('.sidebar').evaluate((el) => el.scrollHeight <= el.clientHeight + 1))
        await inWindow('.sidebar-footer');
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      if (await page.locator('.sidebar').evaluate((el) => el.scrollHeight <= el.clientHeight + 1))
        await inWindow('.sidebar-footer');
      const settings = page
        .locator('.sidebar-footer')
        .getByRole('button', { name: '设置', exact: true });
      await settings.scrollIntoViewIfNeeded();
      await expect(settings).toBeInViewport();
      const status = page
        .locator('.sidebar-footer')
        .getByRole('button', { name: '后台状态', exact: true });
      await expect(status).toBeInViewport();
      await inWindow('.sidebar-footer');
      await expect(page.locator('.index-status')).toHaveCount(0);
      await status.click();
      const details = page.getByRole('dialog', { name: '后台状态', exact: true });
      await expect(details).toBeVisible();
      await inWindow('.n-drawer:visible');
      await expect(details.getByRole('heading', { name: '索引更新', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(details).toBeHidden();
      await expect(status).toBeFocused();
      await expect(page.locator('.index-status')).toHaveCount(0);
      await settings.click();
      await expect(page.locator('.settings-workspace h1')).toHaveText('编辑器与外观');
      await inWindow('.main-content');
      await returnToNotes(page);
      await showSidebar(page);
      await page
        .locator('.tree-scroll')
        .getByRole('button', { name: '00-Inbox', exact: true })
        .click();
      const folderLast = page
        .locator('.folder-view')
        .getByRole('button', { name: names.at(-1)!, exact: true });
      await folderLast.scrollIntoViewIfNeeded();
      await expect(folderLast).toBeInViewport();
      await inWindow('.main-content');
      await folderLast.click();
      await expect(page.locator('.cm-content')).toBeVisible();
      await inWindow('.note-header');
      const scroller = page.locator('.cm-scroller');
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await inWindow('.editor-panels');
      await page.getByRole('button', { name: '预览', exact: true }).click();
      await inWindow('.preview-panel');
      expect(
        await page.locator('.markdown').evaluate((el) => el.scrollHeight > el.clientHeight),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('button', { name: '分屏', exact: true }).click();
      await inWindow('.editor-panel');
      await inWindow('.preview-panel');
      expect(await page.locator('.cm-scroller').evaluate((el) => el.clientHeight)).toBeGreaterThan(
        0,
      );
      expect(await page.locator('.markdown').evaluate((el) => el.clientHeight)).toBeGreaterThan(0);
      await page.screenshot({ path: info.outputPath(`layout-${size.width}-${size.height}.png`) });
    }
  } finally {
    await Promise.all(
      names.map((name) => rm(join(knowledgeRoot, '00-Inbox', name), { force: true })),
    );
  }
});
