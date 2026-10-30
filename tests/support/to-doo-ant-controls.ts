import { expect, type Locator, type Page } from '@playwright/test';

type ToDooScope = Locator | Page;

function selectContainer(scope: ToDooScope, name: string) {
  return scope
    .getByRole('combobox', { name, exact: true })
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    );
}

/** Choose a visible domain label through the real, searchable Ant Select popup. */
export async function selectToDooOption(scope: ToDooScope, name: string, label: string) {
  const control = scope.getByRole('combobox', { name, exact: true });
  await selectContainer(scope, name).locator('.ant-select-selector').click();
  await control.fill(label);
  const page = 'page' in scope ? scope.page() : scope;
  const option = page.locator('.ant-select-dropdown:visible').getByText(label, { exact: true });
  await expect(option).toBeVisible();
  await option.click();
}

/** Ant Select's input holds its search query; assert the visible selected label. */
export async function expectToDooSelection(scope: ToDooScope, name: string, label: string) {
  const selection = selectContainer(scope, name).locator('.ant-select-selection-item');
  await expect(selection).toBeVisible();
  await expect(selection).toHaveText(label);
}

/** Commit the local date/time through the picker keyboard boundary. */
export async function fillToDooDate(control: Locator, value: string) {
  const display = value.replace('T', ' ');
  await control.click();
  await control.fill(display);
  await control.press('Enter');
  await control.press('Tab');
  await expect(control).toHaveValue(display);
}

export function toDooDisclosureHeader(scope: ToDooScope, title: string) {
  return scope.locator('.ant-collapse-header[role="button"]').filter({ hasText: title });
}

export async function expandToDooGroup(scope: ToDooScope, title: string) {
  const header = toDooDisclosureHeader(scope, title);
  await expect(header).toBeVisible();
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
}

/** Call after the action opens its confirmation, before awaiting its mutation. */
export async function confirmToDooAction(page: Page) {
  const dialog = page.getByRole('dialog', { name: '确认操作', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
