import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expandToDooGroup } from '../support/to-doo-ant-controls';
import { selectToDooContext } from '../support/to-doo-navigation';

async function settings(page: Page) {
  const response = await page.request.get('/api/to-doo/settings');
  expect(response.ok()).toBe(true);
  return response.json();
}

test('long settings retain a reachable save action and clear modal hit targets in both themes', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180_000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const session = await (await page.request.get('/api/auth/get-session')).json();
  const key = 'dooknow.preferences.v1:' + encodeURIComponent(session.user.id);
  const viewports =
    info.project.name === 'desktop'
      ? [{ width: 1920, height: 1080 }]
      : [
          { width: 320, height: 700 },
          { width: 390, height: 700 },
        ];
  for (const viewport of viewports) {
    for (const theme of ['light', 'dark'] as const) {
      const before = await settings(page);
      try {
        await page.setViewportSize(viewport);
        await page.goto('/?view=apps&app=to-doo&appSection=settings');
        await page.evaluate(
          ({ key, theme }) => {
            const previous = JSON.parse(localStorage.getItem(key) || '{}');
            localStorage.setItem(key, JSON.stringify({ ...previous, theme }));
          },
          { key, theme },
        );
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
        await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
        const field = app.getByRole('spinbutton', { name: '默认安排分钟', exact: true });
        const next = before.defaultDurationMinutes === 1440 ? 1 : before.defaultDurationMinutes + 1;
        await field.fill(String(next));
        await expandToDooGroup(app, '日期与提醒');
        await expandToDooGroup(app, '任务规则');
        await expandToDooGroup(app, '专注节奏');
        await app
          .getByRole('spinbutton', { name: '长休息间隔（次）', exact: true })
          .scrollIntoViewIfNeeded();
        if (viewport.width < 768)
          expect(
            await app.locator('.todo-main').evaluate((element) => element.scrollTop),
          ).toBeGreaterThan(0);
        const save = app.getByRole('button', { name: '保存偏好', exact: true });
        await expect(save).toBeEnabled();
        await expect(save).toBeInViewport();
        expect((await app.locator('.todo-topbar').boundingBox())!.y).toBeCloseTo(0, 0);
        await page.screenshot({
          path: info.outputPath(`settings-sticky-${viewport.width}-${theme}.png`),
          animations: 'disabled',
        });
        const saved = page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/to-doo/commands') &&
            response.request().postDataJSON()?.payload?.kind === 'settings',
        );
        await save.click();
        expect((await saved).ok()).toBe(true);
        expect((await settings(page)).defaultDurationMinutes).toBe(next);
        await expect(save).toBeDisabled();
        await selectToDooContext(page, '清单管理');
        await app.getByRole('button', { name: '新建清单', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '新建清单', exact: true });
        for (const control of [
          dialog.getByRole('textbox', { name: '清单名称', exact: true }),
          dialog.getByRole('button', { name: '关闭编辑', exact: true }),
          dialog.getByRole('button', { name: '取消', exact: true }),
        ]) {
          await expect(control).toBeInViewport();
          expect(
            await control.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
              return !!hit && element.contains(hit);
            }),
          ).toBe(true);
        }
        await dialog.getByRole('button', { name: '取消', exact: true }).click();
        await expect(dialog).toBeHidden();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1);
      } finally {
        const current = await settings(page);
        const csrf = await (await page.request.get('/api/security/csrf')).json();
        const restored = await page.request.post('/api/to-doo/commands', {
          headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
          data: {
            requestId: crypto.randomUUID(),
            action: 'save_entity',
            payload: { kind: 'settings', entity: before, expectedRevision: current.revision },
          },
        });
        expect(restored.ok()).toBe(true);
      }
    }
  }
});
