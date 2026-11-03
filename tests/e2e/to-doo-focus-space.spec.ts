import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';
import { dateTimeInstant, localDate } from '../../packages/core/to-doo/recurrence';

test.beforeEach(async ({ context, page }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 720 },
  );
});
async function seed(page: import('@playwright/test').Page, label: string, recordCount = 84) {
  const response = await page.request.get('/api/to-doo/focus/history?trendPeriod=week&limit=1');
  expect(response.ok()).toBe(true);
  const { now, timeZone, trend } = await response.json();
  const date = localDate(new Date(now), timeZone);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const command = async (action: string, payload: Record<string, unknown>) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const prefix = crypto.randomUUID().slice(0, 8),
    a = 'space-a-' + prefix,
    b = 'space-b-' + prefix;
  const nameA = `阅读与学习 ${label} ${test.info().project.name}`,
    nameB = `工作与创造 ${label} ${test.info().project.name}`;
  await command('save_entity', { kind: 'focusTopic', entity: { id: a, name: nameA } });
  await command('save_entity', { kind: 'focusTopic', entity: { id: b, name: nameB } });
  const first = dateTimeInstant({ date, time: '08:00', timeZone }).getTime();
  expect(date >= trend.from && date <= trend.to).toBe(true);
  expect(localDate(new Date(first + (recordCount * 2 - 1) * 60000), timeZone)).toBe(date);
  await command('import_entities', {
    entities: Array.from({ length: recordCount }, (_, index) => ({
      kind: 'focusSession',
      entity: {
        id: a + '-' + index,
        topicId: a,
        mode: 'stopwatch',
        status: 'finished',
        note: `专注记录 ${index + 1}`,
        segments: [
          {
            start: new Date(first + index * 120000).toISOString(),
            end: new Date(first + index * 120000 + 60000).toISOString(),
          },
        ],
      },
    })),
  });
  await command('save_entity', {
    kind: 'focusSession',
    entity: {
      topicId: b,
      mode: 'stopwatch',
      status: 'finished',
      segments: [
        { start: new Date(first).toISOString(), end: new Date(first + 5 * 60000).toISOString() },
      ],
    },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app.getByRole('button', { name: '专注项目操作 ' + nameA, exact: true }).click();
  await page.getByRole('menuitem', { name: '时长趋势', exact: true }).click();
  const rows = app.locator('.todo-focus-history-item');
  await expect(rows).toHaveCount(50);
  const chart = app.getByRole('region', { name: '专注时长趋势', exact: true });
  await expect(chart.getByTestId('focus-trend-total')).toHaveText(
    recordCount === 134 ? '2 小时 14 分钟' : '1 小时 24 分钟',
  );
  await expect(page.locator('.ant-dropdown:visible')).toHaveCount(0);
  return { app, chart, rows, list: app.locator('.todo-focus-history'), a, b, nameB };
}
const bottom = (list: import('@playwright/test').Locator) =>
  list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });

test('compact focus overview leaves the first history record above the timer', async ({
  page,
}, info) => {
  const { app, chart, rows } = await seed(page, '');
  if (info.project.name === 'mobile')
    await page.evaluate(async () => {
      const modulePath = '/preferences.ts';
      const preferences = await import(modulePath);
      preferences.setEditorPreferences({ theme: 'dark' });
    });
  await app.getByRole('heading', { name: '专注', exact: true }).click();
  await expect(page.locator('.ant-dropdown:visible')).toHaveCount(0);
  await app.evaluate((element) => {
    for (let node: Element | null = element; node; node = node.parentElement) node.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const phase = process.env.DOOKNOW_FOCUS_SPACE_PHASE || 'after';
  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../..',
    'docs/design/to-doo/audit-fixes-2026-11-03',
    phase,
    'focus-space',
  );
  await mkdir(root, { recursive: true });
  await page.screenshot({
    path: resolve(root, info.project.name + '.png'),
    scale: 'css',
    animations: 'disabled',
  });
  const curveBox = await chart.boundingBox(),
    statsBox = await app.locator('.todo-focus-statistics').boundingBox();
  const rowBox = await rows.first().boundingBox(),
    timerBox = await app.getByRole('region', { name: '专注计时器', exact: true }).boundingBox();
  expect(curveBox!.height).toBeLessThanOrEqual(220);
  expect(statsBox!.height).toBeLessThanOrEqual(76);
  expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(timerBox!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});

test('scrolling loads the next page once and retries failures without clearing the curve or records', async ({
  page,
}) => {
  const { app, chart, rows, list } = await seed(page, '分页');
  let requests = 0;
  await page.route('**/api/to-doo/focus/history?*', async (route) => {
    if (new URL(route.request().url()).searchParams.has('cursor')) {
      requests++;
      if (requests === 1)
        return route.fulfill({ status: 503, json: { error: '记录暂时无法读取' } });
    }
    await route.continue();
  });
  await bottom(list);
  await expect(app.getByRole('button', { name: '重试加载', exact: true })).toBeVisible();
  await expect(rows).toHaveCount(50);
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('1 小时 24 分钟');
  await bottom(list);
  await bottom(list);
  expect(requests).toBe(1);
  await app.getByRole('button', { name: '重试加载', exact: true }).click();
  await expect(rows).toHaveCount(84);
  expect(requests).toBe(2);
  const ids = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-session-id')),
  );
  expect(new Set(ids).size).toBe(84);
  await bottom(list);
  await bottom(list);
  expect(requests).toBe(2);
  await expect(app.getByText('84 条记录 · 已全部载入', { exact: true })).toBeVisible();
});

test('changing the project during a pending page keeps the new scope and resets the record scroll', async ({
  page,
}) => {
  const { app, chart, rows, list, a, nameB } = await seed(page, '切换');
  let release!: () => void,
    started!: () => void,
    pageRequests = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/to-doo/focus/history?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('topicId') === a && query.has('cursor')) {
      pageRequests++;
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await bottom(list);
  await pending;
  await bottom(list);
  await bottom(list);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(pageRequests).toBe(1);
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('1 小时 24 分钟');
  await selectToDooOption(app, '专注记录项目', nameB);
  await expect(rows).toHaveCount(1);
  const stale = page.waitForResponse((response) => {
    const query = new URL(response.url()).searchParams;
    return (
      response.url().includes('/api/to-doo/focus/history?') &&
      query.get('topicId') === a &&
      query.has('cursor')
    );
  });
  release();
  await (await stale).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(rows).toHaveCount(1);
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('5 分钟');
  expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
});

test('keyboard scrolling appends successive pages and stops at the end', async ({ page }) => {
  const { app, chart, rows, list } = await seed(page, '连续分页', 134);
  const firstId = await rows.first().getAttribute('data-session-id');
  await list.focus();
  await list.press('End');
  await expect(rows).toHaveCount(100);
  await list.press('End');
  await expect(rows).toHaveCount(134);
  expect(await rows.first().getAttribute('data-session-id')).toBe(firstId);
  const ids = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-session-id')),
  );
  expect(new Set(ids).size).toBe(134);
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('2 小时 14 分钟');
  await expect(app.getByText('134 条记录 · 已全部载入', { exact: true })).toBeVisible();
  await expect(app.getByRole('button', { name: '加载更早记录', exact: true })).not.toBeVisible();
});

test('expanded statistics and manual paging stay reachable on shorter screens', async ({
  page,
}, info) => {
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 390, height: 664 } : { width: 1280, height: 600 },
  );
  const { app, chart, rows } = await seed(page, '小屏');
  await chart.getByText('月', { exact: true }).click();
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('1 小时 24 分钟');
  const details = chart.locator('details');
  await details.locator('summary').click();
  await details.getByRole('row').last().click();
  await expect(details.getByRole('row').last()).toBeInViewport({ ratio: 1 });
  await details.locator('summary').focus();
  await details.locator('summary').press('Enter');
  await expect(details).not.toHaveAttribute('open');
  const policy = app.locator('.todo-focus-policy');
  await policy.locator('summary').click();
  await expect(policy.locator('p')).toBeVisible();
  await app.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await expect(rows).toHaveCount(84);
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('1 小时 24 分钟');
});
