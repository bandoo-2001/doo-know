import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import { showSidebar } from '../support/settings-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

for (const entry of ['sidebar', 'page'] as const) {
  for (const reload of [false, true]) {
    test(`${entry} return exits ${reload ? 'reloaded' : 'directly opened'} settings`, async ({
      page,
    }) => {
      if (reload) {
        await page.goto('/?folder=30-Knowledge');
        await expect(page.locator('.folder-header')).toBeVisible();
        await showSidebar(page);
        await page
          .locator('.workspace-footer')
          .getByRole('button', { name: '设置', exact: true })
          .click();
        await expect(page.locator('.settings-workspace')).toBeVisible();
        await page.reload();
      } else {
        await page.goto('/?view=settings&section=editor');
      }
      await expect(page.locator('.settings-workspace')).toBeVisible();
      if (entry === 'sidebar') await showSidebar(page);
      const container = page.locator(
        entry === 'sidebar' ? '.settings-sidebar' : '.settings-workspace',
      );
      await container.getByRole('button', { name: '返回笔记', exact: true }).click();
      await expect(page.locator('.settings-workspace')).toHaveCount(0);
      await expect(page).toHaveURL('http://127.0.0.1:4179/');
      await expect(page.locator('.workspace-empty')).toBeVisible();
      await showSidebar(page);
      await expect(
        page.getByRole('textbox', { name: '搜索笔记与目录', exact: true }),
      ).toBeVisible();
    });
  }
}
