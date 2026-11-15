import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context, page }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
  );
});

async function expectEntryTimer(page: Page) {
  const timer = page.getByRole('region', { name: '专注计时器', exact: true });
  await expect(timer).toBeInViewport({ ratio: 1 });
  const timerBox = await timer.boundingBox();
  const projects = await page.locator('.todo-focus-projects').boundingBox();
  expect(timerBox!.y + timerBox!.height).toBeLessThanOrEqual(projects!.y);
}

test('focus opens with a visible timer before project management on large and short screens', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  await page.locator('.todo-focus-projects').getByText('已归档', { exact: true }).click();
  await expectEntryTimer(page);
  await page.setViewportSize({ width: 390, height: 664 });
  await expectEntryTimer(page);
});

test('long project lists remain reachable and selecting a project updates the first timer', async ({
  page,
}) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const prefix = 'bottom-' + crypto.randomUUID().slice(0, 8);
  const lastName = prefix + ' 项目 39';
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'import_entities',
      payload: {
        entities: Array.from({ length: 40 }, (_, index) => ({
          kind: 'focusTopic',
          entity: { id: prefix + '-' + index, name: prefix + ' 项目 ' + index },
        })),
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  await expectEntryTimer(page);
  const last = page.getByRole('button', { name: '选择专注项目 ' + lastName, exact: true });
  await last.click();
  await expect(last).toBeInViewport({ ratio: 1 });
  const timer = page.getByRole('region', { name: '专注计时器', exact: true });
  await expect(timer).toContainText(lastName);
  await timer.scrollIntoViewIfNeeded();
  await expectEntryTimer(page);
});
