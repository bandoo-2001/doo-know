import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { ToDooCommandResult, ToDooSnapshot } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as ToDooCommandResult;
}

async function goal(page: Page, name: string) {
  const created = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name, kind: 'goal', description: '把目标拆成可以执行的行动。' },
  });
  return created.ids[0];
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('.todo-page')).toBeVisible();
  expect(
    await page
      .locator('.todo-page')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
}

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const snapshot = (await (await page.request.get('/api/to-doo/state')).json()) as ToDooSnapshot;
  await page.clock.install({ time: new Date(snapshot.now) });
});

test('goal cards show their own completed action progress and open the matching list', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = '架构学习目标 ' + suffix;
  const listId = await goal(page, name);
  const completed = await command(page, 'create_task', {
    title: '已完成的行动 ' + suffix,
    listId,
  });
  const occurrence = completed.snapshot.occurrences.find(
    (item) => item.taskId === completed.ids[0],
  )!;
  await command(page, 'set_occurrence_status', {
    id: occurrence.id,
    expectedRevision: occurrence.revision,
    status: 'done',
  });
  const pendingTitle = '继续学习架构 ' + suffix;
  await command(page, 'create_task', { title: pendingTitle, listId });
  await page.goto('/?view=apps&app=to-doo&appSection=overview');
  const card = page.locator('.todo-goal').filter({
    has: page.getByRole('button', { name, exact: true }),
  });
  await expect(card).toHaveClass(/\bant-card\b/);
  await expect(card).toHaveAttribute('role', 'article');
  await expect(card.locator('.ant-tag').filter({ hasText: '进行中' })).toBeVisible();
  await expect(card).toContainText('进行中');
  await expect(card).toContainText('1 / 2');
  await expect(card).toContainText('50%');
  const progress = card.getByRole('progressbar', { name: name + '完成进度', exact: true });
  await expect(progress).toHaveClass(/\bant-progress\b/);
  await expect(progress).toHaveAttribute('aria-valuenow', '50');
  await expect(progress).toHaveAttribute('aria-valuemin', '0');
  await expect(progress).toHaveAttribute('aria-valuemax', '100');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await expect(progress).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  }
  await card.getByRole('button', { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp('list=' + listId));
  await expect(page.locator('.todo-page h1')).toHaveText(name);
  await expect(page.getByRole('button', { name: pendingTitle, exact: true })).toBeVisible();
});

test('an empty overview keeps its first goal and action controls available', async ({ page }) => {
  await page.route(/\/api\/to-doo\/state(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as ToDooSnapshot;
    await route.fulfill({
      response,
      json: {
        ...snapshot,
        lists: [],
        tasks: [],
        occurrences: [],
        timeBlocks: [],
        sections: [],
        page: { ...snapshot.page, total: 0, nextCursor: null, truncated: false },
        statistics: { ...snapshot.statistics, byList: {} },
      },
    });
  });
  await page.goto('/?view=apps&app=to-doo&appSection=overview');
  const actions = page.getByRole('region', { name: '今日行动', exact: true });
  const goals = page.getByRole('region', { name: '我的目标', exact: true });
  await expect(actions.locator('.ant-empty')).toBeVisible();
  await expect(actions.getByRole('button', { name: '添加一个行动', exact: true })).toBeVisible();
  await expect(goals.locator('.ant-empty')).toBeVisible();
  await expect(goals.getByRole('button', { name: '创建第一个目标', exact: true })).toBeVisible();
  await expect(goals.getByRole('progressbar')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('an unstarted goal creates its first action in that goal', async ({ page }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = '尚未开始的目标 ' + suffix;
  const listId = await goal(page, name);
  await page.goto('/?view=apps&app=to-doo&appSection=overview');
  const card = page.locator('.todo-goal').filter({
    has: page.getByRole('button', { name, exact: true }),
  });
  await expect(card).toContainText('未开始');
  await expect(card).not.toContainText('0 / 0');
  await expect(card.getByRole('progressbar')).toHaveCount(0);
  await card.getByRole('button', { name: '＋ 添加行动', exact: true }).click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  const title = '从这个目标开始 ' + suffix;
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  await detail.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expect(card).toContainText('0 / 1');
  const snapshot = (await (
    await page.request.get('/api/to-doo/state?kind=task&limit=1000')
  ).json()) as ToDooSnapshot;
  expect(snapshot.tasks.find((task) => task.title === title)).toMatchObject({ listId });
});

test('narrow task lists retain keyboard details and quick capture in both themes', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const name = '移动行动清单 ' + suffix;
  const created = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name, kind: 'list' },
  });
  const listId = created.ids[0];
  const title = '可以通过键盘打开的长任务标题，并在小屏幕上保留清晰的完成入口 ' + suffix;
  await command(page, 'create_task', {
    title,
    listId,
    due: { date: '2031-04-17', time: null, timeZone: 'UTC' },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listId);
  const task = page.getByRole('button', { name: title, exact: true });
  await expect(task).toBeVisible();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await expectNoHorizontalOverflow(page);
      await task.focus();
      await page.keyboard.press('Enter');
      await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
      await expect(detail.getByRole('button', { name: '标记完成', exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await detail.getByLabel('任务标题', { exact: true }).focus();
      await page.keyboard.press('Escape');
      await expect(detail).not.toBeVisible();
      await expect(task).toBeFocused();
    }
  }
  await page.keyboard.press('q');
  const capture = page.getByRole('textbox', { name: '快速添加任务', exact: true });
  await expect(capture).toBeFocused();
  const quickTitle = '键盘快速添加 ' + suffix;
  await capture.fill(quickTitle);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: quickTitle, exact: true })).toBeVisible();
  await expect(capture).toHaveValue('');
  const snapshot = (await (
    await page.request.get('/api/to-doo/state?kind=task&limit=1000')
  ).json()) as ToDooSnapshot;
  expect(snapshot.tasks.find((task) => task.title === quickTitle)).toMatchObject({ listId });
});

test('narrow task lists preserve increasing indentation for each subtask level', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const listId = await goal(page, '层级行动目标 ' + suffix);
  const titles = ['父任务 ', '子任务 ', '孙任务 '].map((label) => label + suffix);
  let parentTaskId: string | undefined;
  for (const title of titles) {
    const created = await command(page, 'create_task', { title, listId, parentTaskId });
    parentTaskId = created.ids[0];
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listId);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const positions: number[] = [];
    for (const title of titles) {
      const task = page.getByRole('button', { name: title, exact: true });
      await expect(task).toBeVisible();
      positions.push((await task.boundingBox())!.x);
    }
    expect(positions[1], `child indentation at ${width}px`).toBeGreaterThan(positions[0]);
    expect(positions[2], `grandchild indentation at ${width}px`).toBeGreaterThan(positions[1]);
  }
});
