import type { Page } from '@playwright/test';

export async function clickNoteAction(page: Page, name: string) {
  const action = page.getByRole('button', { name, exact: true });
  if (!(await action.isVisible())) {
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
  }
  await action.click();
}
