import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 390, height: 844 });
});

test('a keyboard action from the portalled project menu focuses visible focus history', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=focus&appPage=projects');
  const opener = page.getByRole('button', { name: '专注项目更多', exact: true });
  await opener.focus();
  await opener.press('Enter');
  const action = page.getByRole('menuitem', { name: '查看全部记录', exact: true });
  await expect(action).toBeVisible();
  expect(await action.evaluate((element) => element.closest('.todo-focus-projects') === null)).toBe(
    true,
  );
  await action.focus();
  await action.press('Enter');
  const history = page.getByRole('complementary', { name: '专注概览和历史', exact: true });
  await expect(history).toBeVisible();
  await expect(history).toBeFocused();
  expect(new URL(page.url()).searchParams.get('appPage')).toBe('history');
});

test('an external context update does not move focus from the persistent timer controls', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=focus&appPage=projects');
  const settings = page.getByRole('button', { name: '计时设置', exact: true });
  await settings.focus();
  await page.evaluate(() => {
    const next = new URL(location.href);
    next.searchParams.set('appPage', 'history');
    history.replaceState(history.state, '', next);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  });
  await expect(
    page.getByRole('complementary', { name: '专注概览和历史', exact: true }),
  ).toBeVisible();
  await expect(settings).toBeFocused();
});
