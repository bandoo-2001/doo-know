import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { goToToDooSection } from '../support/to-doo-navigation';
import { expandToDooGroup } from '../support/to-doo-ant-controls';

test('a long page title leaves the main action visible on a narrow screen', async ({ page }) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const name = '需要完整保留但不应占满屏幕的长清单名称'.repeat(12).slice(0, 240);
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: { kind: 'list', entity: { name } },
    },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).ids[0];
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + id);
  const heading = page.locator('.todo-page-heading h1');
  await expect(heading).toHaveText(name);
  const metrics = await heading.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(element).lineHeight),
  }));
  expect(metrics.height).toBeLessThanOrEqual(metrics.line * 2 + 1);
  await expect(heading).toHaveAttribute('title', name);
  await expect(page.getByRole('textbox', { name: '快速添加任务', exact: true })).toBeInViewport();
});

test('the shared header keeps save visible while a long settings form scrolls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expandToDooGroup(app, '日期与提醒');
  await expect(app.getByLabel('显示时区', { exact: true })).toBeVisible();
  await expandToDooGroup(app, '任务规则');
  await expandToDooGroup(app, '专注节奏');
  await app
    .getByRole('spinbutton', { name: '长休息间隔（次）', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(app.getByRole('button', { name: '保存偏好', exact: true })).toBeInViewport();
  expect((await app.locator('.todo-topbar').boundingBox())!.y).toBeCloseTo(0, 0);
});

test.use({ timezoneId: 'Asia/Shanghai' });
test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.clock.install({ time: new Date('2026-10-30T09:00:00Z') });
});

// Detects per-page header movement, duplicated host navigation and conflicting layout widths.
test('desktop pages share the global header and contextual layout boundaries', async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  for (const section of [
    'tasks',
    'board',
    'overview',
    'calendar',
    'timeline',
    'matrix',
    'focus',
    'habits',
    'anniversaries',
    'stats',
    'notifications',
    'settings',
  ]) {
    await goToToDooSection(page, section);
    const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
    await expect(app.locator('.todo-content')).toBeVisible();
    const createLabels: Record<string, string> = {
      habits: '＋ 新建习惯',
      anniversaries: '＋ 新建纪念日',
      stats: '＋ 写一篇复盘',
    };
    if (createLabels[section])
      await expect(
        app
          .locator('.todo-page-heading')
          .getByRole('button', { name: createLabels[section], exact: true }),
      ).toBeVisible();
    const rail = page.locator('.workspace-main-menu[data-menu-id="to-doo"]');
    await expect(rail).toBeVisible();
    const header = await app.locator('.todo-topbar').boundingBox();
    const menu = await rail.boundingBox();
    const title = await app.locator('.todo-page-heading h1').boundingBox();
    expect.soft(menu!.width, section + ': primary menu').toBeCloseTo(64, 0);
    expect.soft(header!.height, section + ': header height').toBeCloseTo(56, 0);
    expect
      .soft(header!.x, section + ': global header starts after primary menu')
      .toBeCloseTo(64, 0);
    expect
      .soft(title!.y - (header!.y + header!.height), section + ': title baseline')
      .toBeCloseTo(28, 0);
    const sidebar = app.locator(':scope > .todo-sidebar');
    await expect(sidebar).toHaveCount(1);
    const directory = await sidebar.boundingBox();
    expect.soft(directory!.width, section + ': context menu').toBeCloseTo(208, 0);
    expect
      .soft(directory!.y, section + ': directory below global header')
      .toBeCloseTo(header!.y + 56, 0);
    expect.soft(title!.x, section + ': content start').toBeCloseTo(64 + 208 + 28, 0);
    expect
      .soft(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        section + ': page overflow',
      )
      .toBe(true);
    await page.screenshot({ path: info.outputPath('shell-' + section + '.png'), fullPage: true });
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`the ${theme} shell and task detail fit all supported widths and the host navigation`, async ({
    context,
    page,
  }, info) => {
    test.setTimeout(120000);
    const session = await (await page.request.get('/api/auth/get-session')).json();
    await context.addInitScript(
      ({ ownerId, theme }) => {
        localStorage.setItem(
          'dooknow.preferences.v1:' + encodeURIComponent(ownerId),
          JSON.stringify({ theme }),
        );
      },
      { ownerId: session.user.id, theme },
    );
    const csrf = await (await page.request.get('/api/security/csrf')).json();
    const created = await page.request.post('/api/to-doo/commands', {
      headers: {
        origin: `http://127.0.0.1:${process.env.DOOKNOW_E2E_WEB_PORT || 4179}`,
        'x-csrf-token': csrf.token,
      },
      data: {
        requestId: crypto.randomUUID(),
        action: 'create_task',
        payload: {
          title: '统一布局与长标题的可读性验证 ' + theme,
          description: '窄屏中保留完整内容和任务操作。',
        },
      },
    });
    expect(created.ok()).toBe(true);
    const receipt = await created.json();
    await page.goto(
      '/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + receipt.ids[0],
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
    const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
    for (const width of [320, 390, 768, 1024, 1440, 1873]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(
        '统一布局与长标题的可读性验证 ' + theme,
      );
      const header = (await app.locator('.todo-topbar').boundingBox())!;
      const panel = (await detail.boundingBox())!;
      expect(header.height).toBeCloseTo(56, 0);
      expect(panel.width).toBeCloseTo(
        width >= 1280 ? Math.min(440, Math.max(360, width * 0.29)) : Math.min(width, 420),
        0,
      );
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(width + 1);
      const tabbar = page.getByRole('navigation', { name: 'To Doo 标签导航', exact: true });
      if (await tabbar.isVisible())
        expect(panel.y + panel.height).toBeLessThanOrEqual((await tabbar.boundingBox())!.y + 1);
      if (width >= 1280) expect(panel.y).toBeCloseTo(header.y + header.height, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: info.outputPath(`detail-${width}-${theme}.png`),
        fullPage: true,
      });
    }
  });
}
