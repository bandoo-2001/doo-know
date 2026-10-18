import type { Page } from '@playwright/test';

/** Open only the ancestors needed for an action in the default-collapsed tree. */
export async function expandFolderPath(page: Page, folder: string) {
  let path = '';
  for (const segment of folder.split('/').filter(Boolean)) {
    path = path ? `${path}/${segment}` : segment;
    const folderButton = page.locator('.tree-select').and(page.getByTitle(path, { exact: true }));
    const toggle = folderButton.locator('..').locator('.tree-toggle');
    await toggle.waitFor({ state: 'visible' });
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  }
}
