import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';
import type { Page } from '@playwright/test';
import type { TransferTask } from '../../shared/transfer-contracts';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function openStatus(page: Page) {
  await page.goto('/?view=settings&section=editor');
  await expect(page.locator('.settings-workspace')).toBeVisible();
  await showSidebar(page);
  await page.getByRole('button', { name: '后台状态', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '后台状态', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: '刷新状态', exact: true })).not.toHaveClass(
    /ant-btn-loading/,
  );
  return drawer;
}

function task(id: string, kind: TransferTask['kind'], state: TransferTask['state']): TransferTask {
  return {
    id,
    kind,
    state,
    createdAt: '2026-10-19T01:00:00Z',
    updatedAt: '2026-10-19T01:00:00Z',
    cancellable: state === 'running',
    progress: { completed: state === 'succeeded' ? 4 : 1, total: 4, phase: state },
    downloadAvailable: state === 'succeeded',
  };
}

test('idle drawer keeps tasks and management links visible while details remain expandable', async ({
  page,
}, info) => {
  await page.route('**/api/manage/tasks*', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/platform/search-runtime', (route) =>
    route.fulfill({
      json: {
        components: { tokenizerReady: true, vectorReady: false },
        distributionAvailable: true,
        externallyManaged: false,
      },
    }),
  );
  const drawer = await openStatus(page);
  await expect(drawer).toContainText('暂无进行中的任务');
  const tasks = drawer.getByRole('heading', { name: '任务与结果', exact: true });
  const search = drawer.getByRole('heading', { name: '搜索准备', exact: true });
  expect((await tasks.boundingBox())!.y).toBeLessThan((await search.boundingBox())!.y);
  for (const name of ['导入与导出', '备份与恢复']) {
    await expect(drawer.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  }
  await expect(drawer.getByRole('button', { name: '刷新任务', exact: true })).toHaveCount(0);
  const sizes =
    info.project.name === 'desktop'
      ? [
          { width: 1280, height: 800 },
          { width: 743, height: 700 },
        ]
      : [{ width: 390, height: 664 }];
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expect.poll(async () => (await drawer.boundingBox())!.width).toBeLessThanOrEqual(461);
    if (info.project.name === 'mobile')
      expect((await drawer.boundingBox())!.width).toBeGreaterThanOrEqual(389);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(drawer.getByRole('button', { name: '备份与恢复', exact: true })).toBeInViewport({
      ratio: 1,
    });
  }
  await page.screenshot({ path: info.outputPath('status-idle.png'), animations: 'disabled' });
  const settings = drawer.getByRole('button', { name: '打开搜索设置', exact: true });
  await expect(settings).toBeHidden();
  await drawer.locator('summary').filter({ hasText: '搜索准备' }).click();
  await expect(settings).toBeVisible();
  await settings.click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('.settings-workspace h1')).toHaveText('搜索');
});

test('running and failed tasks precede collapsed history and cancellation remains available', async ({
  page,
}, info) => {
  let items = [
    task('completed-export', 'export', 'succeeded'),
    task('failed-backup', 'backup', 'failed'),
    task('running-import', 'import', 'running'),
  ];
  await page.route('**/api/manage/tasks', (route) => route.fulfill({ json: { items } }));
  await page.route('**/api/manage/tasks/running-import/cancel', (route) => {
    items = items.map((item) =>
      item.id === 'running-import'
        ? { ...item, state: 'cancelled' as const, cancellable: false }
        : item,
    );
    return route.fulfill({ json: items[2] });
  });
  const drawer = await openStatus(page);
  const taskList = drawer.locator('.transfer-tasks > ul > li');
  await expect(taskList).toHaveCount(2);
  await expect(taskList.nth(0)).toContainText('导入');
  await expect(taskList.nth(1)).toContainText('加密备份');
  await expect(drawer.getByRole('link', { name: '下载结果', exact: true })).toBeHidden();
  await drawer.getByRole('button', { name: /已完成与已取消/ }).click();
  await expect(taskList).toHaveCount(3);
  await expect(taskList.nth(2)).toContainText('导出');
  await expect(drawer.getByRole('link', { name: '下载结果', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('status-tasks.png'), animations: 'disabled' });
  await drawer.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect(taskList.filter({ hasText: '导入' })).toContainText('已取消');
  await expect(drawer.getByRole('button', { name: '取消任务', exact: true })).toHaveCount(0);
});

test('polling and header refresh update tasks without closing details, and Escape returns focus', async ({
  page,
}) => {
  let items: TransferTask[] = [];
  await page.route('**/api/manage/tasks', (route) => route.fulfill({ json: { items } }));
  await page.route('**/api/index/status', (route) =>
    route.fulfill({
      json: { pending: 0, retrying: 0, failed: 0, conflicts: 0, sync: { status: 'idle' } },
    }),
  );
  const drawer = await openStatus(page);
  await expect(drawer).toContainText('暂无进行中的任务');
  const indexRow = drawer
    .locator('details.status-row')
    .filter({ has: page.getByRole('heading', { name: '索引更新', exact: true }) });
  if (!(await indexRow.evaluate((element) => (element as HTMLDetailsElement).open)))
    await indexRow.locator('summary').first().click();
  const updateIndex = drawer.getByRole('button', { name: '检查并更新索引', exact: true });
  await expect(updateIndex).toBeVisible();
  items = [task('polled-backup', 'backup', 'running')];
  await expect(drawer.locator('.transfer-tasks')).toContainText('加密备份', { timeout: 8000 });
  items = [
    task('refreshed-export', 'export', 'running'),
    task('polled-backup', 'backup', 'succeeded'),
  ];
  await drawer.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(drawer.locator('.transfer-tasks')).toContainText('导出');
  await expect(drawer.locator('.transfer-tasks')).not.toContainText('加密备份');
  await expect(updateIndex).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('button', { name: '后台状态', exact: true })).toBeFocused();
});

test('header refresh keeps an older failed task after loading more history', async ({ page }) => {
  let olderAvailable = true;
  await page.route('**/api/manage/tasks*', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    return route.fulfill({
      json: cursor
        ? { items: [task('older-failure', 'backup', 'failed')] }
        : {
            items: [task('recent-success', 'export', 'succeeded')],
            ...(olderAvailable ? { nextCursor: 'older' } : {}),
          },
    });
  });
  const drawer = await openStatus(page);
  await drawer.getByRole('button', { name: '加载更多任务', exact: true }).click();
  const failedTask = drawer.locator('.transfer-tasks > ul > li').filter({ hasText: '加密备份' });
  await expect(failedTask).toBeVisible();
  await drawer.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(failedTask).toBeVisible();
  await expect(drawer.getByRole('button', { name: '刷新状态', exact: true })).not.toHaveClass(
    /ant-btn-loading/,
  );
  await expect(failedTask).toBeVisible();
  // Retention can remove older rows. Keep the last confirmed result until an explicit reload.
  olderAvailable = false;
  await drawer.getByRole('button', { name: '刷新状态', exact: true }).click();
  const reload = drawer.getByRole('button', { name: '重新读取任务', exact: true });
  await expect(reload).toBeVisible();
  await expect(failedTask).toBeVisible();
  await reload.click();
  await expect(failedTask).toHaveCount(0);
  await expect(reload).toHaveCount(0);
});

test('unavailable statuses show uncertainty and reveal recovery actions automatically', async ({
  page,
}) => {
  await page.route('**/api/index/status', (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'INDEX_UNAVAILABLE' },
    }),
  );
  await page.route('**/api/maintenance/conflicts', (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'CONFLICTS_UNAVAILABLE' },
    }),
  );
  const drawer = await openStatus(page);
  await expect(drawer).toContainText('索引状态暂时无法确认');
  await expect(drawer).toContainText('写入状态暂时无法确认');
  await expect(drawer.getByRole('button', { name: '检查并更新索引', exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: '检查并更新索引', exact: true })).toBeDisabled();
  await expect(drawer).not.toContainText('没有需要人工核对的写入');
});
