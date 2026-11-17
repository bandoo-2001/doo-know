import { readFile } from 'node:fs/promises';
import { toDooEntitySchemas } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
});

test.beforeEach(async ({ context, page }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
});

async function mockStatistics(page: import('@playwright/test').Page, populated: boolean) {
  const stamp = {
    revision: 'review-clarity',
    createdAt: '2026-11-17T00:00:00Z',
    updatedAt: '2026-11-17T00:00:00Z',
  };
  const goals = [
    toDooEntitySchemas.list.parse({
      ...stamp,
      id: 'clarity-goal-design',
      name: '完成产品的交互与视觉规范',
      icon: '🎨',
      color: '#9470b8',
      kind: 'goal',
      description: '把目标拆成具体行动，持续核对完成进度。',
    }),
    toDooEntitySchemas.list.parse({
      ...stamp,
      id: 'clarity-goal-course',
      name: '学完前端课程',
      icon: '💻',
      color: '#4566c6',
      kind: 'goal',
    }),
  ];
  const review = toDooEntitySchemas.review.parse({
    ...stamp,
    id: 'clarity-review',
    name: '本周项目迭代中的收获与下一步调整'.repeat(7),
    from: '2026-11-10',
    to: '2026-11-17',
    capturedAt: '2026-11-17T01:30:00Z',
    metrics: { completed: 12, focusMinutes: 95, outcomes: 2 },
    content:
      '# 本期收获\n完成了需求拆分和核心流程的验证。\n\n## 遇到的阻碍\n评审前还需要统一边界行为。\n\n## 下一步行动\n补充不同屏幕下的验收检查。'.repeat(
        10,
      ),
  });
  let writes = 0;
  await page.route('**/api/**', async (route) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      writes++;
      return route.abort();
    }
    if (new URL(route.request().url()).pathname !== '/api/to-doo/state') return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    data.lists = [
      ...(data.lists || []).filter((list: any) => list.kind !== 'goal'),
      ...(populated ? goals : []),
    ];
    data.reviews = populated ? [review] : [];
    data.outcomes = [];
    data.statistics = {
      ...data.statistics,
      byList: {
        ...(data.statistics?.byList || {}),
        [goals[0].id]: { completed: 8, total: 12 },
        [goals[1].id]: { completed: 0, total: 0 },
      },
    };
    await route.fulfill({ response, json: data });
  });
  return { goals, review, writes: () => writes };
}

test('empty goals explain cumulative progress while review dates and first-review action remain clear', async ({
  page,
}, info) => {
  const state = await mockStatistics(page, false);
  await page.goto('/?view=apps&app=to-doo&appSection=stats&appPage=goals');
  const goals = page.locator('#to-doo-stats-goals');
  await expect(goals).toBeVisible();
  await expect(page.getByRole('heading', { name: '目标进展', exact: true })).toHaveCount(0);
  const surface = page.getByRole('region', { name: '统计结果', exact: true });
  await expect(surface.locator('#to-doo-stats-goals')).toBeVisible();
  await expect(page.getByRole('form', { name: '统计区间', exact: true })).toBeHidden();
  await expect(goals).toContainText('累计进度');
  await expect(goals).toContainText('普通清单不会出现在这里');
  await expect(goals.getByRole('button', { name: '新建目标', exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath('goals-explained-empty.png'),
    animations: 'disabled',
  });
  await page.getByRole('tab', { name: '历史复盘', exact: true }).click();
  const reviews = page.locator('#to-doo-stats-reviews');
  await expect(reviews).toBeVisible();
  await expect(page.getByRole('heading', { name: '历史复盘', exact: true })).toHaveCount(0);
  const form = surface.getByRole('form', { name: '统计区间', exact: true });
  await expect(form).toHaveAttribute('aria-controls', 'to-doo-stats-reviews');
  await expect(form).toHaveCSS('border-bottom-width', '0px');
  await expect(surface.locator('#to-doo-stats-reviews')).toBeVisible();
  const heading = page.getByRole('heading', { name: '统计与复盘', exact: true });
  const headingBounds = (await heading.boundingBox())!;
  const globalHeader = (await page.locator('.todo-topbar').boundingBox())!;
  expect(headingBounds.y).toBeGreaterThanOrEqual(globalHeader.y + globalHeader.height);
  await expect(page.getByRole('form', { name: '统计区间', exact: true })).toBeVisible();
  await expect(page.getByText('复盘覆盖区间', { exact: true })).toBeVisible();
  await expect(reviews).toContainText('完成任务或专注计时不会自动生成复盘');
  await reviews.getByRole('button', { name: '写第一篇复盘', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '新建复盘', exact: true })).toBeVisible();
  expect(state.writes()).toBe(0);
});

test('goal cards describe remaining work and review cards separate saved metrics from the next action', async ({
  page,
}, info) => {
  const state = await mockStatistics(page, true);
  await page.goto('/?view=apps&app=to-doo&appSection=stats&appPage=goals');
  const goal = page.locator('.todo-progress-row').filter({
    has: page.getByRole('button', { name: '查看目标任务 ' + state.goals[0].name, exact: true }),
  });
  await expect(goal.locator('.todo-review-goal-count')).toHaveText('8/12');
  await expect(goal).toContainText('已完成 67%');
  await expect(goal).toContainText('剩余 4 项');
  await expect(
    page.locator('.todo-progress-row').filter({ hasText: state.goals[1].name }),
  ).toContainText('尚未添加行动');
  await expect(page.getByLabel('当前目标汇总', { exact: true })).toContainText('2');
  if (info.project.name === 'desktop') {
    const bars = await page.locator('.todo-goal-progress-list .ant-progress').all();
    const first = (await bars[0].boundingBox())!;
    const second = (await bars[1].boundingBox())!;
    expect(first.y).toBeCloseTo(second.y, 0);
  }
  expect(
    await goal.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('goals-readable-progress.png'),
    animations: 'disabled',
  });
  await page.getByRole('tab', { name: '历史复盘', exact: true }).click();
  await expect(page.getByRole('heading', { name: '历史复盘', exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: '统计结果', exact: true })
      .getByRole('form', { name: '统计区间', exact: true }),
  ).toBeVisible();
  const article = page.getByRole('article', { name: '复盘 ' + state.review.name, exact: true });
  await expect(article).toContainText('复盘区间 2026-11-10 — 2026-11-17');
  await expect(article.locator('.todo-review-snapshot')).toContainText('完成行动 12 项');
  await expect(article.locator('.todo-review-snapshot')).toContainText('专注时长 95 分钟');
  await expect(article.locator('.todo-review-snapshot')).toContainText('沉淀成果 2 份');
  await expect(article).toContainText('保存于 2026-11-17');
  await expect(
    article
      .getByRole('button', { name: '打开复盘 ' + state.review.name, exact: true })
      .locator(':scope > svg'),
  ).toBeVisible();
  expect(
    await article.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('reviews-readable-snapshot.png'),
    animations: 'disabled',
  });
  await article.getByRole('button', { name: '＋ 添加下一步任务', exact: true }).click();
  const task = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(task.getByRole('textbox', { name: '任务说明', exact: true })).toHaveValue(
    /来自复盘/,
  );
  expect(state.writes()).toBe(0);
});
