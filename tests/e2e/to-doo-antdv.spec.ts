import { readFile } from 'node:fs/promises';
import type { Locator, Page, Request } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { goToToDooSection } from '../support/to-doo-navigation';
import { fillToDooDate } from '../support/to-doo-ant-controls';

// Exercise calendar strings in a browser zone with a DST boundary, independently of the server zone.
test.use({ timezoneId: 'America/Los_Angeles' });

const workspace = (page: Page) =>
  page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
async function snapshot(page: Page, query = '') {
  const response = await page.request.get('/api/to-doo/state' + query);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
function watchCommands(page: Page) {
  const writes: any[] = [];
  const listener = (request: Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/to-doo/commands')
      writes.push(request.postDataJSON());
  };
  page.on('request', listener);
  return writes;
}
function mutation(page: Page, matches: (body: any) => boolean) {
  return page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === 'POST' &&
      new URL(response.url()).pathname === '/api/to-doo/commands' &&
      matches(request.postDataJSON())
    );
  });
}
function statsResponse(page: Page, from: string, to: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'GET' &&
      url.pathname === '/api/to-doo/state' &&
      url.searchParams.get('view') === 'stats' &&
      url.searchParams.get('from') === from &&
      url.searchParams.get('to') === to
    );
  });
}
function dateInZone(zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function shift(date: string, days: number) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
async function withinViewport(page: Page, element: Locator) {
  await expect(element).toBeVisible();
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('Ant statistics and progress follow real seven-day, thirty-day and custom date requests', async ({
  page,
}, info) => {
  const initial = await snapshot(page),
    today = dateInZone(initial.settings.timeZone);
  const name = 'Ant 统计目标 ' + info.project.name + '-' + crypto.randomUUID();
  const list = await command(page, 'save_entity', { kind: 'list', entity: { name, kind: 'goal' } });
  const created = await command(page, 'create_task', {
    title: name + ' 已完成',
    listId: list.ids[0],
  });
  await command(page, 'create_task', {
    title: name + ' 待完成',
    listId: list.ids[0],
    due: { date: today, timeZone: initial.settings.timeZone },
  });
  const occurrence = created.snapshot.occurrences.find(
    (item: any) => item.taskId === created.ids[0],
  );
  await command(page, 'set_occurrence_status', {
    id: occurrence.id,
    expectedRevision: occurrence.revision,
    status: 'done',
  });
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  const app = workspace(page);
  await expect(app.getByRole('heading', { name: '统计与复盘', exact: true })).toBeVisible();
  const completed = app.locator('.todo-stats article').filter({ hasText: '完成行动' });
  await expect(completed.locator('.ant-statistic-content-value')).not.toHaveText('0');
  const progress = app.locator('.todo-progress-row').filter({ hasText: name });
  await expect(progress).toContainText('1/2');
  await expect(
    progress.getByRole('progressbar', { name: name + '完成进度', exact: true }),
  ).toBeVisible();
  if (!initial.reviews.some((item: any) => !item.deletedAt))
    await expect(
      app.locator('.ant-empty').filter({ hasText: '写下做对的事与下一次调整' }),
    ).toBeVisible();
  const month = statsResponse(page, shift(today, -29), today);
  await app.getByText('近 30 天', { exact: true }).click();
  expect((await month).ok()).toBe(true);
  const week = statsResponse(page, shift(today, -6), today);
  await app.getByText('近 7 天', { exact: true }).click();
  expect((await week).ok()).toBe(true);
  await app.getByText('自定义', { exact: true }).click();
  const from = app.getByRole('textbox', { name: '统计开始日期', exact: true });
  const to = app.getByRole('textbox', { name: '统计结束日期', exact: true });
  await fillToDooDate(from, shift(today, -2));
  await fillToDooDate(to, shift(today, -1));
  const custom = statsResponse(page, shift(today, -2), shift(today, -1));
  await app.getByRole('button', { name: '查看区间', exact: true }).click();
  const result = await custom;
  expect(result.ok()).toBe(true);
  expect((await result.json()).statistics).toMatchObject({
    scope: 'period',
    from: shift(today, -2),
    to: shift(today, -1),
  });
  // Keyboard input cannot bypass the end-date bound or silently request a reversed interval.
  const requestedRanges: string[][] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/to-doo/state' && url.searchParams.get('view') === 'stats')
      requestedRanges.push([url.searchParams.get('from') || '', url.searchParams.get('to') || '']);
  });
  await from.click();
  await from.fill(today);
  await from.press('Enter');
  await expect(from).toHaveAttribute('aria-invalid', 'true');
  await from.press('Escape');
  await expect(from).toHaveValue(shift(today, -2));
  await from.click();
  await from.fill('');
  await from.press('Escape');
  await expect(from).toHaveValue(shift(today, -2));
  expect(requestedRanges.every(([start, end]) => !!start && !!end && start <= end)).toBe(true);
  await expect(app.locator('.todo-completion-chart')).toHaveAttribute('role', 'img');
});

test('Ant review modal preserves a canceled discard and saves a fresh local-date review once', async ({
  page,
}, info) => {
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  const app = workspace(page),
    writes = watchCommands(page);
  const name = 'Ant 复盘 ' + info.project.name + '-' + crypto.randomUUID();
  const content = '保留判断依据，再明确下一步行动。';
  await app.getByRole('button', { name: '＋ 写一篇复盘', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建复盘', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await editor.getByLabel('复盘内容', { exact: true }).fill(content);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认操作', exact: true });
  await expect(confirmation).toContainText('表单尚未保存');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(editor.getByLabel('复盘内容', { exact: true })).toHaveValue(content);
  expect(
    writes.filter((body) => body.action === 'save_entity' && body.payload.kind === 'review'),
  ).toHaveLength(0);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await snapshot(page)).reviews.some((item: any) => item.name === name)).toBe(false);
  await app.getByRole('button', { name: '＋ 写一篇复盘', exact: true }).click();
  await expect(editor.getByLabel('复盘内容', { exact: true })).toHaveValue('');
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await editor.getByLabel('复盘内容', { exact: true }).fill(content);
  // These straddle a DST transition; the persisted fields must remain calendar strings.
  await fillToDooDate(editor.getByLabel('开始日期', { exact: true }), '2026-03-07');
  await fillToDooDate(editor.getByLabel('结束日期', { exact: true }), '2026-03-10');
  const saved = mutation(
    page,
    (body) =>
      body.action === 'save_entity' &&
      body.payload.kind === 'review' &&
      body.payload.entity.name === name,
  );
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(editor).not.toBeVisible();
  expect(
    writes.filter((body) => body.action === 'save_entity' && body.payload.entity?.name === name),
  ).toHaveLength(1);
  expect((await snapshot(page)).reviews.find((item: any) => item.name === name)).toMatchObject({
    from: '2026-03-07',
    to: '2026-03-10',
    content,
  });
  await page.reload();
  await expect(app.getByRole('button').filter({ hasText: name })).toBeVisible();
});

test('focus and habit quantity modals cancel without writes and persist explicit numeric receipts', async ({
  page,
}, info) => {
  test.setTimeout(60000);
  const initial = await snapshot(page),
    today = dateInZone(initial.settings.timeZone);
  const name = 'Ant 数字记录 ' + info.project.name + '-' + crypto.randomUUID();
  const task = await command(page, 'create_task', { title: name });
  const occurrence = task.snapshot.occurrences.find((item: any) => item.taskId === task.ids[0]);
  const now = new Date().toISOString();
  const session = await command(page, 'save_entity', {
    kind: 'focusSession',
    entity: {
      mode: 'stopwatch',
      occurrenceId: occurrence.id,
      targetMinutes: null,
      status: 'finished',
      segments: [{ start: new Date(Date.now() - 600000).toISOString(), end: now }],
      note: '',
    },
  });
  const habit = await command(page, 'save_entity', {
    kind: 'habit',
    entity: { name, target: 1, unit: '页', startDate: today, timeZone: initial.settings.timeZone },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = workspace(page),
    writes = watchCommands(page);
  const row = app.locator('.todo-saved-row').filter({ hasText: name });
  await row.getByRole('button', { name: '修正', exact: true }).click();
  const correction = page.getByRole('dialog', { name: '修正实际专注时间', exact: true });
  await correction.getByRole('spinbutton', { name: '实际专注分钟数', exact: true }).fill('0');
  await correction.getByRole('button', { name: '取消', exact: true }).click();
  await expect(correction).not.toBeVisible();
  expect(
    writes.filter(
      (body) => body.action === 'control_focus' && body.payload.operation === 'correct',
    ),
  ).toHaveLength(0);
  await row.getByRole('button', { name: '修正', exact: true }).click();
  await correction.getByRole('spinbutton', { name: '实际专注分钟数', exact: true }).fill('0');
  const corrected = mutation(
    page,
    (body) =>
      body.action === 'control_focus' &&
      body.payload.id === session.ids[0] &&
      body.payload.correctedMinutes === 0,
  );
  await correction.getByRole('button', { name: '保存', exact: true }).click();
  expect((await corrected).ok()).toBe(true);
  await expect(correction).not.toBeVisible();
  expect(
    (await snapshot(page, '?kind=focusSession&ids=' + session.ids[0])).focusSessions.find(
      (item: any) => item.id === session.ids[0],
    ),
  ).toMatchObject({ correctedMinutes: 0 });
  await goToToDooSection(page, 'habits');
  const cell = app.getByRole('button', {
    name: name + ' ' + today + ' 打卡，当前 0 页',
    exact: true,
  });
  await cell.click();
  const checkin = page.getByRole('dialog', { name: '记录习惯数量', exact: true });
  await checkin.getByRole('spinbutton', { name: '习惯数量', exact: true }).fill('2.5');
  await checkin.getByRole('button', { name: '取消', exact: true }).click();
  await expect(checkin).not.toBeVisible();
  expect(
    writes.filter(
      (body) => body.action === 'checkin_habit' && body.payload.habitId === habit.ids[0],
    ),
  ).toHaveLength(0);
  await cell.click();
  await checkin.getByRole('spinbutton', { name: '习惯数量', exact: true }).fill('');
  await checkin.getByRole('button', { name: '保存', exact: true }).click();
  await expect(checkin.getByRole('alert')).toContainText('请输入大于 0 的数量');
  expect(writes.filter((body) => body.action === 'checkin_habit')).toHaveLength(0);
  await checkin.getByRole('spinbutton', { name: '习惯数量', exact: true }).fill('2.5');
  const checked = mutation(
    page,
    (body) =>
      body.action === 'checkin_habit' &&
      body.payload.habitId === habit.ids[0] &&
      body.payload.amount === 2.5,
  );
  await checkin.getByRole('button', { name: '保存', exact: true }).click();
  expect((await checked).ok()).toBe(true);
  await expect(checkin).not.toBeVisible();
  await page.reload();
  await expect(
    app.getByRole('button', { name: name + ' ' + today + ' 打卡，当前 2.5 页', exact: true }),
  ).toHaveText('✓');
  const persisted = await snapshot(page, '?kind=habitEntry&limit=500');
  expect(
    persisted.habitEntries.filter((item: any) => item.habitId === habit.ids[0] && !item.deletedAt),
  ).toEqual([expect.objectContaining({ amount: 2.5, localDate: today, skipped: false })]);
});

test('320px dark Ant calendar popup and review modal keep their controls inside the viewport', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('/?view=settings&section=editor');
  const appearance = page.getByRole('combobox', { name: '外观', exact: true });
  await page
    .locator('.ant-select')
    .filter({ has: appearance })
    .locator('.ant-select-selector')
    .click();
  await page.locator('.ant-select-dropdown:visible').getByText('深色', { exact: true }).click();
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '编辑器偏好已保存' })).toBeVisible();
  await page.goto('/?view=apps&app=to-doo&appSection=stats');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const app = workspace(page);
  await app.getByRole('textbox', { name: '统计开始日期', exact: true }).click();
  const popup = page.locator('.ant-picker-dropdown:visible');
  await withinViewport(page, popup);
  await expect(popup.getByRole('table')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await app.getByRole('button', { name: '＋ 写一篇复盘', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建复盘', exact: true });
  await withinViewport(page, editor);
  await editor.getByLabel('复盘内容', { exact: true }).fill('窄屏仍可编辑和取消');
  await editor.getByRole('button', { name: '取消', exact: true }).scrollIntoViewIfNeeded();
  await expect(editor.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 320);
  const image = info.outputPath('to-doo-antdv-320-dark.png');
  await page.screenshot({ path: image, animations: 'disabled' });
  await info.attach('320px dark Ant review', { path: image, contentType: 'image/png' });
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认操作', exact: true });
  await withinViewport(page, confirmation);
  await confirmation.getByRole('button', { name: '确认', exact: true }).click();
  await expect(editor).not.toBeVisible();
});
