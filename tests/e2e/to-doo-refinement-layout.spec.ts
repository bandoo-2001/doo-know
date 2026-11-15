import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

for (const size of [{ width: 1440, height: 900 }, { width: 1080, height: 812 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  test(`task and planning content fits ${size.width}×${size.height}`, async ({ page }, info) => {
    test.setTimeout(120000);
    await page.setViewportSize(size);
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action: 'create_task', payload: { title: '布局验证 ' + info.project.name + '-' + size.width } },
    });
    expect(response.ok()).toBe(true);
    const created = await response.json();
    await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
    const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
    await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
    const first = app.locator('.todo-task-row').first();
    await expect(first).toBeVisible();
    const top = (await first.boundingBox())!.y;
    expect(top).toBeLessThanOrEqual(size.width >= 1080 ? 180 : 216);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
    expect((await first.boundingBox())!.height).toBeCloseTo(touch ? 44 : 40, 0);
    await app.getByRole('button', { name: '任务显示与管理', exact: true }).click();
    await selectToDooOption(page, '任务密度', '紧凑');
    await page.keyboard.press('Escape');
    expect((await first.boundingBox())!.height).toBeCloseTo(touch ? 44 : 36, 0);
    expect(await first.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
    await app.getByRole('button', { name: '任务显示与管理', exact: true }).click();
    await selectToDooOption(page, '任务密度', '舒适');
    await page.keyboard.press('Escape');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async mode => {
        const modulePath = '/preferences.ts';
        const preferences = await import(modulePath);
        preferences.setEditorPreferences({ theme: mode });
        await document.fonts.ready;
      }, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await first.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
      await page.screenshot({ path: info.outputPath(`tasks-${size.width}-${theme}.png`), animations: 'disabled' });
    }
    await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + created.ids[0]);
    const detail = page.getByRole('complementary', { name: '任务详情' });
    await expect(detail).toBeVisible();
    if (size.width >= 1080) {
      await expect(app).toHaveClass(/todo-detail-docked/);
      expect((await app.locator('.todo-main').boundingBox())!.width).toBeGreaterThanOrEqual(440);
    }
    await detail.getByRole('button', { name: '编辑任务提醒', exact: true }).click();
    const reminders = page.getByRole('dialog', { name: '任务提醒', exact: true });
    await expect(reminders).toBeVisible();
    await expect(reminders.getByRole('button', { name: '完成设置', exact: true })).toBeVisible();
    await reminders.getByRole('button', { name: '取消本次设置', exact: true }).click();
    await expect(reminders).not.toBeVisible();
    for (const section of ['calendar', 'matrix']) {
      await page.goto('/?view=apps&app=to-doo&appSection=' + section);
      await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
      if (section === 'calendar') {
        if (await app.locator('.todo-mobile-agenda').isVisible()) await app.getByText('网格', { exact: true }).click();
        const cells = app.locator('.todo-month-day');
        // Date grids keep every date reachable; the grid itself fits the viewport.
        await expect(cells).toHaveCount(42);
        expect((await cells.last().boundingBox())!.y + (await cells.last().boundingBox())!.height).toBeLessThanOrEqual(size.height + 1);
      } else {
        const quadrants = app.locator('.todo-quadrant');
        await expect(quadrants).toHaveCount(4);
        for (const quadrant of await quadrants.all()) {
          const rect = (await quadrant.boundingBox())!;
          expect(rect.y + rect.height).toBeLessThanOrEqual(size.height + 1);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${section}-${size.width}.png`), animations: 'disabled' });
    }
  });
}
