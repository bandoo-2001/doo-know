import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expandToDooGroup, selectToDooOption } from '../support/to-doo-ant-controls';
import { selectToDooContext } from '../support/to-doo-navigation';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function command(page: Page, action: string, payload: unknown) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
test('primary management action has readable contrast in light and dark themes at 320px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=settings&appPage=lists');
  const action = page
    .locator('.todo-content')
    .getByRole('button', { name: '新建清单', exact: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(async (theme) => {
      const path = '/preferences.ts';
      (await import(path)).setEditorPreferences({ theme });
    }, theme);
    await page.reload();
    await expect(action).toBeVisible();
    const contrast = await action.evaluate((element) => {
      const style = getComputedStyle(element);
      const luminance = (color: string) => {
        const rgb = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((x) => x / 255)
          .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      };
      const a = luminance(style.color),
        b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(contrast, theme + ' normal-size action label contrast').toBeGreaterThanOrEqual(4.5);
  }
});
test('a new tag exposes its real color field and persists the selected value', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=settings&appPage=lists');
  await page
    .locator('.todo-content')
    .getByRole('button', { name: '新建标签', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '新建标签', exact: true });
  const name = '颜色标签 ' + crypto.randomUUID();
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByLabel('颜色', { exact: true }).fill('#336699');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeInViewport();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const snapshot = await (await page.request.get('/api/to-doo/state?kind=tag&limit=200')).json();
  expect(snapshot.tags.find((tag: any) => tag.name === name)?.color).toBe('#336699');
});
test('review creation displays actual metrics and saves a server-captured snapshot', async ({
  page,
}) => {
  const created = await command(page, 'create_task', { title: '复盘事实 ' + crypto.randomUUID() });
  const occurrence = created.snapshot.occurrences.find(
    (item: any) => item.taskId === created.ids[0],
  );
  await command(page, 'set_occurrence_status', {
    id: occurrence.id,
    expectedRevision: occurrence.revision,
    status: 'done',
  });
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  await page.getByRole('button', { name: '＋ 写一篇复盘', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建复盘', exact: true });
  const snapshot = dialog.getByRole('region', { name: '统计快照', exact: true });
  await expect(snapshot).toBeVisible();
  await expect(snapshot).toContainText('1');
  const name = '统计快照验收 ' + crypto.randomUUID();
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const result = await (await page.request.get('/api/to-doo/state?kind=review&limit=200')).json();
  const saved = result.reviews.find((review: any) => review.name === name);
  expect(saved.metrics.completed).toBe(1);
  expect(saved.capturedAt).toBeTruthy();
});

for (const width of [1440, 320])
  test(`long import preview keeps navigation and confirmation reachable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width > 700 ? 1000 : 844 });
    await page.goto('/?view=apps&app=to-doo&appSection=settings&appPage=data');
    const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
    await expandToDooGroup(app, '导入选项');
    await selectToDooOption(app, '格式', '滴答 CSV');
    await app
      .getByLabel('或粘贴文件内容', { exact: true })
      .fill(
        'Title,Due Date,List Name\n' +
          Array.from({ length: 23 }, (_, i) => `预览核对 ${i + 1},2026-11-05 09:00,工作清单`).join(
            '\n',
          ),
      );
    await app.getByRole('button', { name: '预览导入', exact: true }).click();
    const preview = app.locator('.todo-import-preview');
    await preview.scrollIntoViewIfNeeded();
    await test.info().attach('import-layout-geometry', {
      contentType: 'application/json',
      body: JSON.stringify(
        await page.evaluate(() =>
          [
            '.to-doo-workspace',
            '.todo-main',
            '.todo-topbar',
            '.todo-page',
            '.todo-import-preview',
            '.workspace-main',
            '.workspace-content',
          ].map((selector) => {
            const el = document.querySelector<HTMLElement>(selector);
            if (!el) return { selector };
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
              selector,
              y: r.y,
              height: r.height,
              clientHeight: el.clientHeight,
              scrollHeight: el.scrollHeight,
              scrollTop: el.scrollTop,
              position: s.position,
              rows: s.gridTemplateRows,
              overflowY: s.overflowY,
              alignSelf: s.alignSelf,
              parent: el.parentElement?.className,
            };
          }),
        ),
        null,
        2,
      ),
    });
    await expect(app.locator('.todo-topbar')).toBeInViewport();
    if (width > 1000)
      await expect(
        app
          .getByRole('navigation', { name: '设置目录', exact: true })
          .getByRole('button', { name: '数据与恢复', exact: true }),
      ).toBeInViewport();
    await expect(preview.getByRole('button', { name: '下一页预览', exact: true })).toBeInViewport();
    await expect(preview.getByRole('button', { name: /^确认导入/ })).toBeInViewport();
    await preview.getByRole('button', { name: '下一页预览', exact: true }).click();
    await expect(preview.getByText(/第 2 \//)).toBeVisible();
    if (width === 320) {
      await selectToDooContext(page, '清单管理');
      await expect(app.locator('.todo-page-heading h1')).toHaveText('清单管理');
    }
  });
