import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { ToDooSnapshot } from '../../shared/to-doo-contracts';

/** A command receipt contains a bounded page, so follow its IDs for fixture assertions. */
export async function readToDooTaskContext(page: Page, taskIds: string | string[]) {
  const query = new URLSearchParams({
    taskIds: (Array.isArray(taskIds) ? taskIds : [taskIds]).join(','),
    includeTree: 'true',
    limit: '500',
  });
  const response = await page.request.get('/api/to-doo/state?' + query);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<ToDooSnapshot>;
}

/** Page through the visible workspace; never inject a command receipt into picker options. */
export async function loadToDooTaskOptionThroughUi(page: Page, control: Locator, label: string) {
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const select = control.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
  );
  const dropdown = page.locator('.ant-select-dropdown:visible');
  const option = dropdown.getByText(label, { exact: true });
  const cursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
    await expect(control).toBeEnabled();
    await select.locator('.ant-select-selector').click();
    if (await control.isEditable()) await control.fill(label);
    await expect.poll(async () => (await option.isVisible()) ||
      (await dropdown.locator('.ant-select-item-empty').isVisible())).toBe(true);
    const found = await option.isVisible();
    if (await control.isEditable()) await control.fill('');
    await control.press('Escape');
    await expect(dropdown).toHaveCount(0);
    if (found) return;
    const occurrenceMore = app.getByRole('button', { name: '继续载入执行实例', exact: true });
    const taskMore = app.getByRole('button', { name: '继续载入任务', exact: true });
    const kind = (await occurrenceMore.isVisible()) ? 'occurrence' : 'task';
    const more = kind === 'occurrence' ? occurrenceMore : taskMore;
    await expect(more).toBeVisible();
    await expect(more).toBeEnabled();
    const nextRead = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/to-doo/state' &&
        url.searchParams.get('kind') === kind && url.searchParams.has('cursor');
    });
    const [, response] = await Promise.all([more.click(), nextRead]);
    expect(response.ok(), await response.text()).toBe(true);
    const cursor = new URL(response.url()).searchParams.get('cursor')!;
    const key = kind + ':' + cursor;
    expect(cursors.has(key), 'Workspace pagination must advance').toBe(false);
    cursors.add(key);
    const data = await response.json() as ToDooSnapshot;
    expect((data.collectionPages?.[kind] || data.page).nextCursor).not.toBe(cursor);
    // The acknowledged collection page can still be hydrating its related task rows.
    await expect(app.locator('.todo-load-more button:disabled')).toHaveCount(0);
  }
  throw new Error('Task option was not found within the workspace pagination budget');
}
