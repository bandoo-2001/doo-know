import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';
import { openToDooFocusHistory } from '../support/to-doo-navigation';
import { addDays, dateTimeInstant, localDate } from '../../packages/core/to-doo/recurrence';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function seed(page: import('@playwright/test').Page) {
  const response = await page.request.get('/api/to-doo/focus/history?trendPeriod=week&limit=1');
  expect(response.ok()).toBe(true);
  const { now, timeZone, trend } = await response.json();
  const today = localDate(new Date(now), timeZone);
  const otherDate = addDays(today, today === trend.from ? 1 : -1);
  const previousMonth = new Date(today.slice(0, 7) + '-01T00:00:00Z');
  previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
  const previousMonthDate = previousMonth.toISOString().slice(0, 10);
  expect(otherDate >= trend.from && otherDate <= trend.to).toBe(true);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const prefix = crypto.randomUUID().slice(0, 8);
  const ids = { a: 'curve-a-' + prefix, b: 'curve-b-' + prefix };
  const command = async (kind: string, entity: Record<string, unknown>) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action: 'save_entity', payload: { kind, entity } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  };
  for (const [key, name] of [
    ['a', '阅读与学习'],
    ['b', '工作与创造'],
  ] as const)
    await command('focusTopic', { id: ids[key], name: name + ' ' + prefix });
  const sessions = [
    ['a', otherDate, 45],
    ['a', today, 60],
    ['a', previousMonthDate, 60],
    ['b', today, 120],
  ] as const;
  for (const [key, date, minutes] of sessions) {
    const start = dateTimeInstant({ date, time: '08:00', timeZone }).getTime();
    await command('focusSession', {
      topicId: ids[key],
      mode: 'stopwatch',
      status: 'finished',
      segments: [
        {
          start: new Date(start).toISOString(),
          end: new Date(start + minutes * 60000).toISOString(),
        },
      ],
    });
  }
  const totalWithin = (prefix: string) => {
    const minutes = sessions.reduce(
      (sum, [key, date, amount]) => sum + (key === 'a' && date.startsWith(prefix) ? amount : 0),
      0,
    );
    const labels: Record<number, string> = {
      0: '0 分钟',
      60: '1 小时',
      105: '1 小时 45 分钟',
      120: '2 小时',
      165: '2 小时 45 分钟',
    };
    expect(labels[minutes], 'exact total for fixture period ' + prefix).toBeDefined();
    return labels[minutes]!;
  };
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  return {
    app,
    ids,
    nameA: '阅读与学习 ' + prefix,
    nameB: '工作与创造 ' + prefix,
    today,
    otherDate,
    previousMonthDate,
    weekLabel: trend.from + ' — ' + trend.to,
    totalWithin,
  };
}

test('project duration curves support week, month and year without changing the history range', async ({
  page,
}, info) => {
  const { app, nameA, today, otherDate, previousMonthDate, weekLabel, totalWithin } = await seed(page);
  await expect(app.getByRole('region', { name: '专注时长趋势', exact: true })).not.toBeVisible();
  await app.getByRole('button', { name: '专注项目操作 ' + nameA, exact: true }).click();
  await page.getByRole('menuitem', { name: '时长趋势', exact: true }).click();
  const chart = app.getByRole('region', { name: '专注时长趋势', exact: true });
  await expect(chart).toBeVisible();
  await expect(chart).toContainText(weekLabel);
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('1 小时 45 分钟');
  await chart.getByText('查看数据', { exact: true }).click();
  await expect(chart.getByRole('row', { name: today + ' 60 分钟', exact: true })).toBeVisible();
  const point = chart.getByRole('button', { name: today + '：60 分钟', exact: true });
  await point.focus();
  await point.press(otherDate < today ? 'ArrowLeft' : 'ArrowRight');
  await expect(
    chart.getByRole('button', { name: otherDate + '：45 分钟', exact: true }),
  ).toBeFocused();
  await chart.getByText('查看数据', { exact: true }).click();
  await chart.getByRole('button', { name: '上一周', exact: true }).click();
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('0 分钟');
  await chart.getByRole('button', { name: '本周', exact: true }).click();
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('1 小时 45 分钟');
  await chart.getByText('月', { exact: true }).click();
  await expect(chart).toContainText(today.slice(0, 4) + '年' + Number(today.slice(5, 7)) + '月');
  await expect(chart.getByTestId('focus-trend-total')).toHaveText(totalWithin(today.slice(0, 7)));
  await chart.getByRole('button', { name: '上一月', exact: true }).click();
  await expect(chart).toContainText(
    previousMonthDate.slice(0, 4) + '年' + Number(previousMonthDate.slice(5, 7)) + '月',
  );
  await expect(chart.getByTestId('focus-trend-total')).toHaveText(totalWithin(previousMonthDate.slice(0, 7)));
  await chart.getByText('年', { exact: true }).click();
  await expect(chart.getByTestId('focus-trend-total')).toHaveText(totalWithin(previousMonthDate.slice(0, 4)));
  await chart.getByRole('button', { name: '上一年', exact: true }).click();
  await expect(chart).toContainText(String(Number(previousMonthDate.slice(0, 4)) - 1) + '年');
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('0 分钟');
  await chart.getByRole('button', { name: '本年', exact: true }).click();
  await expect(chart.getByTestId('focus-trend-total')).toHaveText(totalWithin(today.slice(0, 4)));
  await selectToDooOption(app, '专注记录日期范围', '今天');
  await expect(chart.getByTestId('focus-trend-total')).toHaveText(totalWithin(today.slice(0, 4)));
  await expect(app.locator('.todo-focus-history-item')).toHaveCount(1);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const directory = resolve(root, 'docs/design/to-doo/focus-trend-2026-11-01');
  await mkdir(directory, { recursive: true });
  if (info.project.name === 'mobile') {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(async () => {
      const modulePath = '/preferences.ts';
      const preferences = await import(modulePath);
      preferences.setEditorPreferences({ theme: 'dark' });
    });
  }
  await app.getByRole('heading', { name: '专注', exact: true }).click();
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  await page.setViewportSize(
    info.project.name === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
  );
  await app.evaluate((element) => {
    for (let node: Element | null = element; node; node = node.parentElement) node.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(directory, info.project.name + '.png'), scale: 'css' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
});

test('a slow previous project or period response cannot replace the current curve', async ({
  page,
}) => {
  const { app, ids, nameA, nameB, today } = await seed(page);
  await app.getByRole('button', { name: '选择专注项目 ' + nameA, exact: true }).click();
  const history = await openToDooFocusHistory(page);
  await history.getByRole('button', { name: '时长趋势', exact: true }).click();
  const chart = app.getByRole('region', { name: '专注时长趋势', exact: true });
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('1 小时 45 分钟');
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/to-doo/focus/history?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('topicId') === ids.a && query.get('trendPeriod') === 'month') {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await chart.getByText('月', { exact: true }).click();
  await pending;
  await chart.getByText('年', { exact: true }).click();
  await selectToDooOption(app, '专注记录项目', nameB);
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('2 小时');
  const staleResponse = page.waitForResponse((response) => {
    const query = new URL(response.url()).searchParams;
    return (
      response.url().includes('/api/to-doo/focus/history?') &&
      query.get('topicId') === ids.a &&
      query.get('trendPeriod') === 'month'
    );
  });
  release();
  const delivered = await staleResponse;
  await delivered.finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(chart).toContainText(today.slice(0, 4) + '年');
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('2 小时');
  await history.getByRole('button', { name: '收起趋势', exact: true }).click();
  await expect(chart).not.toBeVisible();
  await history.getByRole('button', { name: '时长趋势', exact: true }).click();
  await expect(chart.getByTestId('focus-trend-total')).toHaveText('2 小时');
});
