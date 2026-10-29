import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';

const names = Array.from(
  { length: 90 },
  (_, index) => `${String(index + 1).padStart(3, '0')}-用于验证目录滚动与长文件名省略的笔记.md`,
);
test.beforeEach(async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.route('**/api/tree', (route) =>
    route.fulfill({
      json: [
        {
          type: 'folder',
          name: '长目录',
          path: 'long',
          children: names.map((name, index) => ({
            type: 'note',
            id: `scroll-${index}`,
            name,
            path: `long/${name}`,
          })),
        },
        { type: 'folder', name: '空目录', path: 'empty', children: [] },
      ],
    }),
  );
  await page.route('**/api/search/advanced', (route) =>
    route.fulfill({
      json: {
        results: names.map((name, index) => ({
          noteId: `scroll-${index}`,
          title: name,
          relativePath: `long/${name}`,
          matches: [{ snippet: '内容搜索滚动检查', matchLine: 1 }],
        })),
        degraded: false,
        index: { pending: 0 },
      },
    }),
  );
});

for (const compact of [false, true]) {
  test(`${compact ? 'short' : 'normal'} windows keep long directory scrolling below the sidebar controls`, async ({
    page,
  }, info) => {
    await page.setViewportSize(
      info.project.name === 'mobile'
        ? { width: compact ? 568 : 390, height: compact ? 320 : 844 }
        : { width: compact ? 844 : 1890, height: compact ? 390 : 1000 },
    );
    await page.goto('/?folder=empty');
    await showSidebar(page);
    await page.getByRole('button', { name: '展开 长目录', exact: true }).click();
    const sidebar = page.locator('.sidebar'),
      tree = page.locator('.tree-scroll');
    const last = tree.getByRole('button', { name: names.at(-1)!, exact: true });
    await expect(last).toBeAttached();
    const original = await page.locator('.sidebar > .brand').boundingBox();
    await expect
      .poll(() => sidebar.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeLessThanOrEqual(1);
    await expect.poll(() => tree.evaluate((el) => el.clientHeight)).toBeGreaterThan(32);
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await expect.poll(() => tree.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await sidebar.evaluate((el) => el.scrollTop)).toBe(0);
    const after = await page.locator('.sidebar > .brand').boundingBox();
    expect(Math.abs(after!.y - original!.y)).toBeLessThan(1);
    await expect(page.getByPlaceholder('搜索笔记与目录')).toBeInViewport();
    await expect(
      page.getByRole('button', { name: '新建笔记', exact: true }).first(),
    ).toBeInViewport();
    await expect(
      page.locator('.sidebar-footer').getByRole('button', { name: '设置', exact: true }),
    ).toBeInViewport();
    await expect(
      page.locator('.sidebar-footer').getByRole('button', { name: '个人账户', exact: true }),
    ).toBeInViewport();
    expect(await tree.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight - innerHeight),
    ).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    if (compact) {
      await page.getByPlaceholder('搜索笔记与目录').fill('content-scroll-only');
      await expect(tree.locator('.search-result')).toHaveCount(names.length);
      await expect.poll(() => tree.evaluate((el) => el.clientHeight)).toBeGreaterThan(32);
      await tree.locator('.search-result').last().scrollIntoViewIfNeeded();
      await expect(tree.locator('.search-result').last()).toBeInViewport();
      await expect(page.getByPlaceholder('搜索笔记与目录')).toBeInViewport();
      expect(await sidebar.evaluate((el) => el.scrollTop)).toBe(0);
    }
    await page.screenshot({ path: info.outputPath(`sidebar-${compact ? 'short' : 'normal'}.png`) });
  });
}

test('native scrollbars share the active appearance while directory and settings stay independent', async ({
  page,
  context,
}, info) => {
  const { user } = await (await context.request.get('/api/auth/get-session')).json();
  await context.addInitScript(
    ({ key }) => {
      localStorage.setItem(key, JSON.stringify({ theme: 'system' }));
    },
    { key: 'dooknow.preferences.v1:' + encodeURIComponent(user.id) },
  );
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/?folder=long');
    await showSidebar(page);
    await page.getByRole('button', { name: '展开 长目录', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const tree = page.locator('.tree-scroll'),
      folder = page.locator('.folder-view');
    await expect(folder).toBeVisible();
    const styles = await tree.evaluate((el) => {
      const style = getComputedStyle(el);
      return { width: style.scrollbarWidth, color: style.scrollbarColor };
    });
    expect(styles.width).toBe('thin');
    expect(styles.color).not.toBe('auto');
    expect(await folder.evaluate((el) => getComputedStyle(el).scrollbarColor)).toBe(styles.color);
    const before = await folder.evaluate((el) => el.scrollTop);
    await tree.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect(await folder.evaluate((el) => el.scrollTop)).toBe(before);
    await page
      .locator('.sidebar-footer')
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await expect(page.locator('.settings-workspace')).toBeVisible();
    await showSidebar(page);
    const nav = page.getByRole('navigation', { name: '设置分类', exact: true });
    expect(await nav.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
    expect(await nav.evaluate((el) => getComputedStyle(el).scrollbarColor)).toBe(styles.color);
    expect(
      await page.locator('.sidebar').evaluate((el) => el.scrollHeight - el.clientHeight),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`settings-${theme}.png`) });
  }
});
