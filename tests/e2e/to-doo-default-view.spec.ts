import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';
import { goToToDooSection } from '../support/to-doo-navigation';
import { showMainMenu, closeSidebar } from '../support/settings-navigation';

test('saved default view applies to a fresh opening while explicit navigation and return memory win', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const before = await (await page.request.get('/api/to-doo/state')).json();
  const fresh = await context.newPage();
  try {
    await page.goto('/?view=apps&app=to-doo&appSection=settings');
    await selectToDooOption(page, '默认视图', '专注');
    await page.getByRole('button', { name: '保存偏好', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('偏好已保存');
    await fresh.goto('/?view=apps');
    await fresh
      .locator('.app-card')
      .filter({ has: fresh.getByRole('heading', { name: 'To Doo', exact: true }) })
      .click();
    await expect(fresh).toHaveURL(/appSection=focus/);
    await expect(
      fresh.locator('.todo-page-heading').getByRole('heading', { name: '专注', exact: true }),
    ).toBeVisible();
    await fresh.goto('/?view=apps&app=to-doo&appSection=tasks');
    await expect(
      fresh.locator('.todo-page-heading').getByRole('heading', { name: '所有任务', exact: true }),
    ).toBeVisible();
    await goToToDooSection(fresh, 'habits');
    await showMainMenu(fresh);
    await fresh
      .locator('.workspace-footer')
      .getByRole('button', { name: '返回 DooKnow', exact: true })
      .click();
    await showMainMenu(fresh);
    await fresh
      .getByRole('navigation', { name: '工作区', exact: true })
      .getByRole('button', { name: '应用', exact: true })
      .click();
    await closeSidebar(fresh);
    await fresh
      .locator('.app-card')
      .filter({ has: fresh.getByRole('heading', { name: 'To Doo', exact: true }) })
      .click();
    await expect(fresh).toHaveURL(/appSection=habits/);
    await fresh.goto('/?view=apps&app=to-doo');
    await expect(
      fresh.locator('.todo-page-heading').getByRole('heading', { name: '专注', exact: true }),
    ).toBeVisible();
  } finally {
    await fresh.close();
    const latest = (await (await page.request.get('/api/to-doo/state')).json()).settings;
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const restored = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
      data: {
        requestId: crypto.randomUUID(),
        action: 'save_entity',
        payload: { kind: 'settings', entity: before.settings, expectedRevision: latest.revision },
      },
    });
    expect(restored.ok()).toBe(true);
  }
});
