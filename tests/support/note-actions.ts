import type { Page } from '@playwright/test';

export async function clickNoteAction(page: Page, name: string) {
  const action = page.getByRole('button', { name, exact: true });
  const trigger = page.getByRole('button', { name: '更多操作', exact: true });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await action.click();
}
