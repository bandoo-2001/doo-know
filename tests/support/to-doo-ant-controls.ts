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
  await expect(control).toBeEnabled();
  await selectContainer(scope, name).locator('.ant-select-selector').click();
  if (await control.isEditable()) await control.fill(label);
  const page = 'page' in scope ? scope.page() : scope;
  const dropdown = page.locator('.ant-select-dropdown:visible');
  const option = dropdown.getByText(label, { exact: true });
  if (name === '待安排任务') {
    const dialog = control.locator('xpath=ancestor::*[@role="dialog"][1]');
    const more = dialog.getByRole('button', { name: '载入更多任务', exact: true });
    const seenCursors = new Set<string>();
    let nextCursor: string | null | undefined;
    for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
      await expect
        .poll(
          async () =>
            (await option.isVisible()) ||
            (await dropdown.locator('.ant-select-item-empty').isVisible()),
        )
        .toBe(true);
      if ((await option.isVisible()) || nextCursor === null) break;
      await control.fill('');
      await control.press('Escape');
      await expect(dropdown).toHaveCount(0);
      if (nextCursor) await expect(more).toBeVisible();
      else if (!(await more.isVisible())) break;
      await expect(more).toBeEnabled();
      const pending = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'GET' &&
          url.pathname === '/api/to-doo/state' &&
          url.searchParams.get('view') === 'tasks' &&
          url.searchParams.has('cursor') &&
          JSON.parse(url.searchParams.get('filter') || '{}').unscheduled === true
        );
      });
      await more.click();
      const response = await pending;
      expect(response.ok(), await response.text()).toBe(true);
      const cursor = new URL(response.url()).searchParams.get('cursor')!;
      expect(seenCursors.has(cursor), 'Task picker must advance its pagination cursor').toBe(false);
      seenCursors.add(cursor);
      const data = await response.json();
      expect(data.page.nextCursor).not.toBe(cursor);
      nextCursor = data.page.nextCursor;
      await expect(control).toBeEnabled();
      await selectContainer(scope, name).locator('.ant-select-selector').click();
      if (await control.isEditable()) await control.fill(label);
    }
  }
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
  // Enter on an empty, open picker selects its active day rather than clearing it.
  if (display) await control.press('Enter');
  await control.press('Tab');
  await expect(control).toHaveValue(display);
}

export function toDooDisclosureHeader(scope: ToDooScope, title: string) {
  return scope.locator('.ant-collapse-header[role="button"]').filter({ hasText: title });
}

export async function expandToDooGroup(scope: ToDooScope, title: string) {
  const header = toDooDisclosureHeader(scope, title);
  if (!(await header.isVisible())) {
    const advanced = toDooDisclosureHeader(scope, '更多详情');
    if (await advanced.count()) {
      if ((await advanced.getAttribute('aria-expanded')) !== 'true') await advanced.click();
      await expect(advanced).toHaveAttribute('aria-expanded', 'true');
    }
  }
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
