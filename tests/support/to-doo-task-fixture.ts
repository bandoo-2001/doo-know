import type { Page } from '@playwright/test';
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
