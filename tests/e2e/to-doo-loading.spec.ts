import type { Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { showMainMenu, closeSidebar } from '../support/settings-navigation';

const tasksUrl = '/?view=apps&app=to-doo&appSection=tasks';
const initialLabel = '正在载入 To Doo…';
const refreshLabel = '正在刷新 To Doo…';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function isTaskState(url: URL) {
  return (
    url.pathname === '/api/to-doo/state' &&
    url.searchParams.get('view') === 'tasks' &&
    !url.searchParams.has('kind')
  );
}

const workspace = (page: Page) =>
  page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
const status = (page: Page, name: string) => page.getByRole('status', { name, exact: true });

async function expectStaticMotion(root: Locator) {
  const animations = await root.evaluate((element) =>
    [element, ...element.querySelectorAll('*')].flatMap((node) =>
      [null, '::before', '::after']
        .map((pseudo) => {
          const css = getComputedStyle(node, pseudo);
          return {
            name: css.animationName,
            duration: css.animationDuration,
            iterations: css.animationIterationCount,
          };
        })
        .filter((value) => value.name !== 'none'),
    ),
  );
  for (const animation of animations) {
    for (const duration of animation.duration.split(',')) {
      const value = parseFloat(duration);
      const milliseconds = duration.trim().endsWith('ms') ? value : value * 1000;
      expect(milliseconds).toBeLessThanOrEqual(0.01);
    }
    for (const count of animation.iterations.split(','))
      expect(Number(count)).toBeLessThanOrEqual(1);
  }
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('an initial task request shows Ant skeletons until the usable task list arrives', async ({
  page,
}) => {
  const pending = gate(),
    requested = gate();
  await page.route(isTaskState, async (route) => {
    requested.release();
    await pending.promise;
    await route.continue();
  });
  try {
    await page.goto(tasksUrl);
    await requested.promise;
    const loading = status(page, initialLabel);
    await expect(loading).toBeVisible();
    await expect(loading.locator('.ant-skeleton').first()).toBeVisible();
    await expect(workspace(page).locator('.todo-main')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText('暂时无法载入工作空间。', { exact: true })).toHaveCount(0);
    pending.release();
    await expect(workspace(page).locator('.todo-tree')).toBeVisible();
    await expect(
      workspace(page).getByRole('textbox', { name: '搜索任务', exact: true }),
    ).toBeVisible();
    await expect(workspace(page).locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
    await expect(loading).toHaveCount(0);
  } finally {
    pending.release();
  }
});

test('a failed refresh retains the task DOM, search focus and content position', async ({
  page,
}) => {
  await page.goto(tasksUrl);
  const app = workspace(page),
    main = app.locator('.todo-main'),
    search = app.getByRole('textbox', { name: '搜索任务', exact: true }),
    tree = app.locator('.todo-tree');
  await expect(tree).toBeVisible();
  await expect(main).toHaveAttribute('aria-busy', 'false');
  await search.focus();
  const originalSearch = await search.elementHandle(),
    originalTree = await tree.elementHandle(),
    before = await search.boundingBox();
  const pending = gate(),
    requested = gate();
  await page.route(isTaskState, async (route) => {
    requested.release();
    await pending.promise;
    await route.fulfill({ status: 503, json: { error: '加载动画测试：刷新暂时不可用' } });
  });
  try {
    // Trigger the same refresh action without moving keyboard focus to its button.
    await app.getByRole('button', { name: '刷新 To Doo', exact: true }).dispatchEvent('click');
    await requested.promise;
    const refreshing = status(page, refreshLabel);
    await expect(refreshing).toBeVisible();
    await expect(main).toHaveAttribute('aria-busy', 'true');
    await expect(status(page, initialLabel)).toHaveCount(0);
    await expect(tree).toBeVisible();
    await expect(search).toBeFocused();
    expect(await originalSearch!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await originalTree!.evaluate((node) => node.isConnected)).toBe(true);
    const during = await search.boundingBox();
    expect(before).not.toBeNull();
    expect(during).not.toBeNull();
    expect(Math.abs(during!.x - before!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(during!.y - before!.y)).toBeLessThanOrEqual(1);
    pending.release();
    await expect(app.getByRole('alert')).toContainText('加载动画测试：刷新暂时不可用');
    await expect(refreshing).toHaveCount(0);
    await expect(main).toHaveAttribute('aria-busy', 'false');
    await expect(tree).toBeVisible();
    await expect(search).toBeFocused();
    expect(await originalSearch!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await originalTree!.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    pending.release();
    await originalSearch?.dispose();
    await originalTree?.dispose();
  }
});

test('reduced motion keeps the loading placeholder static and an initial failure can retry', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const pending = gate(),
    requested = gate();
  let failFirst = true;
  await page.route(isTaskState, async (route) => {
    if (!failFirst) return route.continue();
    failFirst = false;
    requested.release();
    await pending.promise;
    await route.fulfill({ status: 503, json: { error: '加载动画测试：首次读取失败' } });
  });
  try {
    await page.goto(tasksUrl);
    await requested.promise;
    const loading = status(page, initialLabel);
    await expect(loading).toBeVisible();
    await expect(loading.locator('.ant-skeleton').first()).toBeVisible();
    await expectStaticMotion(loading);
    pending.release();
    const retry = workspace(page).getByRole('button', { name: '重新载入', exact: true });
    await expect(retry).toBeVisible();
    await expect(loading).toHaveCount(0);
    await expect(workspace(page).locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
    await retry.click();
    await expect(workspace(page).locator('.todo-tree')).toBeVisible();
    await expect(workspace(page).locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
    await expect(retry).toHaveCount(0);
    await expect(workspace(page).getByRole('alert')).toHaveCount(0);
  } finally {
    pending.release();
  }
});

test('a cold To Doo component download has the same branded loading feedback', async ({ page }) => {
  const pending = gate(),
    requested = gate();
  await page.route(
    (url) =>
      url.pathname.endsWith('/components/ToDooWorkspace.vue') ||
      /\/assets\/ToDooWorkspace-[^/]+\.js$/.test(url.pathname),
    async (route) => {
      requested.release();
      await pending.promise;
      await route.continue();
    },
  );
  try {
    await page.goto(tasksUrl, { waitUntil: 'domcontentloaded' });
    await requested.promise;
    const loading = status(page, initialLabel);
    await expect(loading).toBeVisible();
    await expect(loading.locator('.ant-skeleton').first()).toBeVisible();
    await expect(workspace(page)).toHaveCount(0);
    pending.release();
    await expect(workspace(page).locator('.todo-tree')).toBeVisible();
    await expect(workspace(page).locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
    await expect(loading).toHaveCount(0);
  } finally {
    pending.release();
  }
});

test('returning during a cold To Doo download is safe and its late completion preserves the destination', async ({
  page,
}) => {
  const pending = gate(),
    requested = gate();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const isChunk = (url: URL) =>
    url.pathname.endsWith('/components/ToDooWorkspace.vue') ||
    /\/assets\/ToDooWorkspace-[^/]+\.js$/.test(url.pathname);
  await page.route(isChunk, async (route) => {
    requested.release();
    await pending.promise;
    await route.continue();
  });
  try {
    await page.goto(tasksUrl, { waitUntil: 'domcontentloaded' });
    await requested.promise;
    await expect(status(page, initialLabel)).toBeVisible();
    await showMainMenu(page);
    await page
      .locator('.workspace-footer.workspace-main-menu')
      .getByRole('button', { name: '返回 DooKnow', exact: true })
      .click();
    // Navigation calls the exposed leave guard while the ref still points at the fallback.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(errors).toEqual([]);
    await closeSidebar(page);
    await expect(page.locator('.workspace-main-menu')).toHaveAttribute('data-menu-id', 'dooknow');
    await expect.poll(() => new URL(page.url()).searchParams.get('app')).toBeNull();
    const destination = page.url();
    const lateChunk = page.waitForResponse((response) => isChunk(new URL(response.url())));
    pending.release();
    await (await lateChunk).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(page.locator('.workspace-main-menu')).toHaveAttribute('data-menu-id', 'dooknow');
    await expect(page).toHaveURL(destination);
    await expect(workspace(page)).toHaveCount(0);
    await expect(status(page, initialLabel)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    pending.release();
  }
});
