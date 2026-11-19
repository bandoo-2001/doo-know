import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { toDooEntitySchemas, type ToDooFocusHistory } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';
import { openToDooFocusHistory } from '../support/to-doo-navigation';

const focusUrl = '/?view=apps&app=to-doo&appSection=focus';
const timer = (page: Page) => page.getByRole('region', { name: '专注计时器', exact: true });

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function history(page: Page): Promise<ToDooFocusHistory> {
  const response = await page.request.get('/api/to-doo/focus/history?limit=50');
  expect(response.ok()).toBe(true);
  return response.json();
}

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const active = (await history(page)).active;
  if (active)
    await command(page, 'control_focus', {
      id: active.id,
      expectedRevision: active.revision,
      operation: 'cancel',
    });
});

test('large focus settings share their draft with the drawer and history scope stays independent', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Inline controls belong to the large desktop layout.');
  await page.setViewportSize({ width: 1920, height: 1080 });
  const baseline = await history(page);
  const stamp = { revision: 'desktop-focus', createdAt: baseline.now, updatedAt: baseline.now };
  const names = ['工作与创作 · '.repeat(8) + '当前项目', '阅读与学习 · 历史筛选'];
  const topics = names.map((name, index) =>
    toDooEntitySchemas.focusTopic.parse({
      ...stamp,
      id: 'desktop-polish-topic-' + index,
      name,
      color: index ? '#438674' : '#4566c6',
    }),
  );
  const records = topics.map((topic, index) =>
    toDooEntitySchemas.focusSession.parse({
      ...stamp,
      id: 'desktop-polish-session-' + index,
      topicId: topic.id,
      topicName: topic.name,
      mode: 'stopwatch',
      status: 'finished',
      correctedMinutes: index ? 7 : 14,
      segments: [
        {
          start: new Date(Date.parse(baseline.now) - 15 * 60000).toISOString(),
          end: new Date(Date.parse(baseline.now) - 60000).toISOString(),
        },
      ],
      note: '用于核对长项目名称和记录布局',
    }),
  );
  let populated = false;
  await page.route('**/api/to-doo/state?**', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.focusTopics = populated ? topics : [];
    if (new URL(route.request().url()).searchParams.get('kind') === 'focusTopic')
      snapshot.page = { ...snapshot.page, nextCursor: null, hasMore: false };
    await route.fulfill({ response, json: snapshot });
  });
  await page.route('**/api/to-doo/focus/history?**', async (route) => {
    const topicId = new URL(route.request().url()).searchParams.get('topicId');
    const index = topics.findIndex((topic) => topic.id === topicId);
    const total = populated
      ? { completed: index < 0 ? 2 : 1, minutes: index < 0 ? 21 : index ? 7 : 14 }
      : { completed: 0, minutes: 0 };
    const items = populated ? (index < 0 ? records : [records[index]]) : [];
    await route.fulfill({
      json: {
        ...baseline,
        active: null,
        items,
        trend: undefined,
        overview: {
          today: total,
          lifetime: total,
          filtered: total,
          byTopic: {},
          nextBreak: { kind: 'short', minutes: 5 },
        },
        page: { total: items.length, limit: 50, hasMore: false, nextCursor: null },
      },
    });
  });
  let starts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.action === 'start_focus'
    )
      starts++;
  });
  await page.goto(focusUrl);
  const console = timer(page);
  const quick = console.locator('.todo-focus-quick-settings');
  await expect(console).toBeInViewport({ ratio: 1 });
  await expect(console.getByRole('button', { name: '开始专注', exact: true })).toBeInViewport();
  await expect(quick).toBeVisible();
  await expect(quick.getByRole('combobox', { name: '关联行动', exact: true })).toHaveCount(0);
  const minutes = quick.getByRole('spinbutton', { name: '本次时长', exact: true });
  const aligned = [
    quick.locator('.ant-segmented'),
    quick.locator('.ant-input-number-group-wrapper'),
    console.locator('.todo-focus-primary-task .ant-select'),
    console.getByRole('button', { name: '开始专注', exact: true }),
  ];
  const bounds = await Promise.all(aligned.map((control) => control.boundingBox()));
  for (const box of bounds) {
    expect(box!.x).toBeCloseTo(bounds[0]!.x, 0);
    expect(box!.width).toBeCloseTo(bounds[0]!.width, 0);
  }
  const caption = (await console.locator('.todo-focus-timer-caption').boundingBox())!;
  const settings = (await console
    .getByRole('button', { name: '计时设置', exact: true })
    .boundingBox())!;
  expect(
    Math.abs(caption.y + caption.height / 2 - settings.y - settings.height / 2),
  ).toBeLessThanOrEqual(1);
  const defaultMinutes = await minutes.inputValue();
  await minutes.fill('42');
  await expect(console.getByRole('timer', { name: '专注计时', exact: true })).toHaveText('42:00');
  await console.getByRole('button', { name: '计时设置', exact: true }).click();
  await expect(quick).toBeHidden();
  const drawer = page.locator('.todo-focus-timer-fields:visible');
  await expect(drawer.getByRole('spinbutton', { name: '本次时长', exact: true })).toHaveValue('42');
  await page.getByRole('button', { name: '收起计时设置', exact: true }).click();
  await expect(minutes).toHaveValue('42');
  await quick.getByText('正计时', { exact: true }).click();
  await expect(minutes).toBeHidden();
  await expect(console).toHaveAttribute('data-mode', 'stopwatch');
  await quick.getByText('休息', { exact: true }).click();
  await minutes.fill('0');
  await console.getByRole('button', { name: '跳过休息', exact: true }).click();
  await expect(console).toHaveAttribute('data-mode', 'pomodoro');
  await expect(minutes).toHaveValue(defaultMinutes);
  expect(starts).toBe(0);
  await expect(page.locator('.todo-focus-today-summary')).toBeVisible();
  await expect(page.locator('.todo-focus-today-summary')).toContainText('全部项目');
  await expect(page.getByRole('button', { name: '新建专注项目', exact: true })).toBeVisible();

  populated = true;
  await page.reload();
  await page.getByRole('button', { name: '选择专注项目 ' + names[0], exact: true }).click();
  await expect(console).toContainText(names[0]);
  const mountedTimer = await console.elementHandle();
  const recordsPanel = await openToDooFocusHistory(page);
  await selectToDooOption(recordsPanel, '专注记录项目', names[1]);
  await expect(recordsPanel.locator('.todo-focus-history-item')).toHaveCount(1);
  await expect(recordsPanel.locator('.todo-focus-history-item')).toContainText(names[1]);
  await expect(page.locator('.todo-focus-today-summary')).toContainText(names[1]);
  await expect(console).toContainText(names[0]);
  expect(await mountedTimer!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(console).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('desktop-focus-scope.png'),
    animations: 'disabled',
  });
});

test('running focus retains inline notes through drawer, pause and history, then saves them once', async ({
  page,
}, info) => {
  await page.setViewportSize(
    info.project.name === 'desktop' ? { width: 1920, height: 1080 } : { width: 390, height: 844 },
  );
  const name = '保持专注并完成记录 · '.repeat(7) + info.project.name;
  const topic = await command(page, 'save_entity', { kind: 'focusTopic', entity: { name } });
  await command(page, 'start_focus', { mode: 'stopwatch', topicId: topic.ids[0] });
  const session = (await history(page)).active!;
  expect(session).not.toBeNull();
  let finishes = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.action === 'control_focus' &&
      request.postDataJSON()?.payload.operation === 'finish'
    )
      finishes++;
  });
  await page.goto(focusUrl);
  await page.evaluate(async () => {
    const path = '/preferences.ts';
    (await import(path)).setEditorPreferences({ theme: 'dark' });
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const console = timer(page);
  await expect(console).toHaveAttribute('data-status', 'running');
  await expect(console).toBeInViewport({ ratio: 1 });
  await expect(console.getByRole('button', { name: '暂停', exact: true })).toBeInViewport();
  const mountedTimer = await console.elementHandle();
  const inline = console.getByRole('textbox', { name: '当前专注随手记录', exact: true });
  const original = '保留内联输入和打开抽屉前的草稿';
  const finalNote = original + '，并保留抽屉中的补充。';
  if (info.project.name === 'desktop') {
    await expect(inline).toBeVisible();
    await inline.fill(original);
  } else await expect(inline).toBeHidden();
  await console.getByRole('button', { name: '计时设置', exact: true }).click();
  await expect(inline).toBeHidden();
  const drawerNote = page.getByRole('textbox', { name: '本次专注记录', exact: true });
  await expect(drawerNote).toBeVisible();
  if (info.project.name === 'desktop') await expect(drawerNote).toHaveValue(original);
  await drawerNote.fill(finalNote);
  await page.getByRole('button', { name: '收起计时设置', exact: true }).click();
  if (info.project.name === 'desktop') await expect(inline).toHaveValue(finalNote);
  await console.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(console).toHaveAttribute('data-status', 'paused');
  expect((await history(page)).active).toMatchObject({ id: session.id, status: 'paused' });
  await openToDooFocusHistory(page);
  expect(await mountedTimer!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(console).toHaveCount(1);
  await expect(console).toContainText(name);
  await console.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('active-focus-' + info.project.name + '.png'),
    animations: 'disabled',
  });
  const finished = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.action === 'control_focus' &&
      request.postDataJSON()?.payload.operation === 'finish',
  );
  await console.getByRole('button', { name: '结束并保存', exact: true }).click();
  expect((await finished).postDataJSON().payload).toMatchObject({
    id: session.id,
    note: finalNote,
  });
  await expect(console.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
  const after = await history(page);
  expect(after.active).toBeNull();
  expect(after.items.find((item) => item.id === session.id)).toMatchObject({
    status: 'finished',
    note: finalNote,
  });
  expect(finishes).toBe(1);
  await expect(inline).toBeHidden();
});

test('a correction keeps its editor stable while saving and retains the value after a failed write', async ({
  page,
}, info) => {
  await page.setViewportSize(
    info.project.name === 'desktop' ? { width: 1920, height: 1080 } : { width: 320, height: 844 },
  );
  const before = await history(page);
  const id = 'focus-correction-release-' + crypto.randomUUID();
  const end = Date.parse(before.now) - 60_000;
  await command(page, 'save_entity', {
    kind: 'focusSession',
    entity: {
      id,
      mode: 'stopwatch',
      status: 'finished',
      topicName: '核对修正保存',
      segments: [
        { start: new Date(end - 119.6 * 60_000).toISOString(), end: new Date(end).toISOString() },
      ],
    },
  });
  await page.goto(focusUrl);
  const panel = await openToDooFocusHistory(page);
  const row = panel.locator('.todo-focus-history-item[data-session-id="' + id + '"]');
  await expect(row).toContainText('2 小时');
  await row.locator('summary').click();
  await row.getByRole('button', { name: '修正', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修正专注时长', exact: true });
  const field = editor.getByRole('spinbutton', { name: '实际专注分钟数', exact: true });
  await field.fill('42');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route('**/api/to-doo/commands', async (route) => {
    const body = route.request().postDataJSON();
    if (
      body.action === 'control_focus' &&
      body.payload.id === id &&
      body.payload.operation === 'correct' &&
      ++attempts === 1
    ) {
      await gate;
      return route.fulfill({ status: 503, json: { error: '暂时无法保存修正，请重试。' } });
    }
    await route.continue();
  });
  const started = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.payload?.id === id,
  );
  try {
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await started;
    await expect(field).toBeDisabled();
    await expect(editor.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
  } finally {
    release();
  }
  await expect(editor.getByRole('alert')).toContainText('暂时无法保存修正');
  await expect(field).toHaveValue('42');
  await expect(field).toBeEnabled();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(row).toContainText('42 分钟');
  const saved = await history(page);
  expect(saved.items.find((session) => session.id === id)?.correctedMinutes).toBe(42);
  expect(attempts).toBe(2);
});
