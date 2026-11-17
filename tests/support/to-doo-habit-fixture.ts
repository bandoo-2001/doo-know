import type { BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { ToDooEntityMap } from '../../shared/to-doo-contracts';

/** Open a real completed/rest disclosure before interacting with its card. */
export async function revealHabitTestCard(page: Page, name: string) {
  await expect(page.locator('.todo-habit-cards')).toHaveAttribute('aria-busy', 'false');
  const card = page.getByRole('article', {
    name: '习惯 ' + name,
    exact: true,
    includeHidden: true,
  });
  await expect(card).toBeAttached();
  const disclosure = card.locator('xpath=ancestor::details[1]');
  if (await disclosure.count()) {
    if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)))
      await disclosure.locator(':scope > summary').click();
  }
  await expect(card).toBeVisible();
  return card;
}

export async function revealHabitTestDates(page: Page) {
  const disclosure = page.locator('.todo-habit-date-browser');
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)))
    await disclosure.locator(':scope > summary').click();
  const dates = page.getByRole('region', { name: '按日期查看习惯', exact: true });
  await expect(dates).toBeVisible();
  return dates;
}

// The shared browser app can deliver reminders created by an earlier case.
// Habit interaction tests leave reminder behavior to the dedicated reminder suite.
export async function isolateHabitTestReminderOverlays(context: BrowserContext) {
  await context.addInitScript(() => {
    const install = () => {
      if (!document.documentElement || document.getElementById('habit-test-reminder-isolation'))
        return;
      const style = document.createElement('style');
      style.id = 'habit-test-reminder-isolation';
      style.textContent = '.reminder-stack { display: none !important; }';
      (document.head || document.documentElement).append(style);
    };
    install();
    document.addEventListener('DOMContentLoaded', install, { once: true });
  });
}

// Assert against the full entity collection even after a preceding pagination
// regression has added hundreds of records to the temporary browser fixture.
export async function readHabitTestEntities<Kind extends 'habit' | 'habitEntry'>(
  page: Page,
  kind: Kind,
): Promise<ToDooEntityMap[Kind][]> {
  const collection = kind === 'habit' ? 'habits' : 'habitEntries';
  const values: ToDooEntityMap[Kind][] = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ kind, sort: 'recent', limit: '1000' });
    if (cursor) query.set('cursor', cursor);
    const response = await page.request.get('/api/to-doo/state?' + query);
    expect(response.ok()).toBe(true);
    const snapshot = await response.json();
    values.push(...snapshot[collection]);
    cursor = snapshot.page?.nextCursor || undefined;
  } while (cursor);
  return values;
}
