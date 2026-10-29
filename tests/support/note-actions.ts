import type { Page } from '@playwright/test';

export async function clickNoteAction(page: Page, name: string) {
  const action = page.getByRole('button', { name, exact: true });
  const trigger = page.getByRole('button', { name: '更多操作', exact: true });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await action.click();
}

async function selectVersion(page: Page, index: number, source: 'saved' | 'git') {
  const dialog = page.locator('.note-history-dialog');
  const label = source === 'git' ? '选择 Git 提交' : '选择历史版本';
  const row = source === 'git' ? '.note-history-git-version' : '.note-history-version';
  const picker = dialog.getByRole('combobox', {
    name: label,
    exact: true,
  });
  await dialog
    .locator(`select[aria-label="${label}"]:visible, ${row}:visible`)
    .first()
    .waitFor({ state: 'visible', timeout: 15000 });
  if (await picker.isVisible()) {
    const value = await picker.locator('option').nth(index).getAttribute('value');
    if (!value) throw new Error('History version is unavailable');
    await picker.selectOption(value);
  } else {
    await dialog.locator(row).nth(index).click();
  }
}

export async function selectHistoryVersion(page: Page, index: number) {
  await selectVersion(page, index, 'saved');
}

export async function selectGitHistoryVersion(page: Page, index: number) {
  await selectVersion(page, index, 'git');
}
