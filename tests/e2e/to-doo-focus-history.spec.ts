import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';
import { goToToDooSection, openToDooFocusHistory } from '../support/to-doo-navigation';

test('leaving focus stops polling and returning reloads the kept page', async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/to-doo/focus/history') requests++;
  });
  const initialHistoryResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/to-doo/focus/history',
  );
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  await expect(page.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
  expect((await initialHistoryResponse).ok()).toBe(true);
  // The timer is visible before history loads; its pending load suppresses polling.
  await expect(
    page.getByRole('region', { name: '专注记录列表', exact: true, includeHidden: true }),
  ).toHaveAttribute('aria-busy', 'false');
  const initial = requests;
  await page.clock.fastForward(11000);
  await expect.poll(() => requests).toBeGreaterThan(initial);
  await goToToDooSection(page, 'tasks');
  const paused = requests;
  await page.clock.fastForward(60000);
  expect(requests).toBe(paused);
  await goToToDooSection(page, 'focus');
  await expect.poll(() => requests).toBeGreaterThan(paused);
  await expect(page.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
});

test.use({ actionTimeout: 10000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('break defaults follow the configured rhythm and zero skips without creating a session', async ({
  page,
}) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token };
  const before = await (await page.request.get('/api/to-doo/settings')).json();
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers,
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  try {
    const history = await (await page.request.get('/api/to-doo/focus/history?limit=1')).json();
    if (history.active)
      await command('control_focus', {
        id: history.active.id,
        expectedRevision: history.active.revision,
        operation: 'cancel',
      });
    await command('save_entity', {
      kind: 'settings',
      entity: { ...before, shortBreakMinutes: 3, longBreakMinutes: 7, longBreakAfter: 1 },
      expectedRevision: before.revision,
    });
    await command('save_entity', {
      kind: 'focusSession',
      entity: {
        mode: 'pomodoro',
        status: 'finished',
        segments: [{ start: '2025-10-01T08:00:00Z', end: '2025-10-01T08:25:00Z' }],
      },
    });
    const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
    async function selectBreak() {
      await expect(app.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
      const settings = app.getByRole('button', { name: '计时设置', exact: true });
      if (await settings.isVisible()) await settings.click();
      await app
        .locator('.todo-focus-timer-fields:visible')
        .getByText('休息', { exact: true })
        .click();
    }
    await page.goto('/?view=apps&app=to-doo&appSection=focus');
    await selectBreak();
    await expect(app.getByRole('spinbutton', { name: '本次时长', exact: true })).toHaveValue('7');
    const latest = await (await page.request.get('/api/to-doo/settings')).json();
    await command('save_entity', {
      kind: 'settings',
      entity: { ...latest, shortBreakMinutes: 0, longBreakMinutes: 0 },
      expectedRevision: latest.revision,
    });
    await page.reload();
    await selectBreak();
    await expect(app.getByRole('spinbutton', { name: '本次时长', exact: true })).toHaveValue('0');
    const close = app.getByRole('button', { name: '收起计时设置', exact: true });
    if (await close.isVisible()) await close.click();
    const count = (await (await page.request.get('/api/to-doo/focus/history?limit=1')).json()).page
      .total;
    await app.getByRole('button', { name: '跳过休息', exact: true }).click();
    await expect(app.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
    const after = await (await page.request.get('/api/to-doo/focus/history?limit=1')).json();
    expect(after.active).toBeNull();
    expect(after.page.total).toBe(count);
  } finally {
    const latest = await (await page.request.get('/api/to-doo/settings')).json();
    await command('save_entity', {
      kind: 'settings',
      entity: before,
      expectedRevision: latest.revision,
    });
  }
});

test('phone focus keeps one header and a compact timer with optional settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const timer = app.getByRole('region', { name: '专注计时器', exact: true });
  await expect(timer).toBeVisible();
  expect((await app.locator('.todo-topbar').boundingBox())!.y).toBeCloseTo(0, 0);
  expect((await timer.boundingBox())!.height).toBeLessThanOrEqual(140);
  await timer.getByRole('button', { name: '计时设置', exact: true }).click();
  await expect(app.getByRole('combobox', { name: '关联行动', exact: true })).toBeVisible();
  await app.getByRole('button', { name: '收起计时设置', exact: true }).click();
  await expect(app.getByRole('combobox', { name: '关联行动', exact: true })).not.toBeVisible();
});

test('a focus project saves records, survives refresh and archives without changing its linked task', async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = {
    origin: `http://127.0.0.1:${process.env.DOOKNOW_E2E_WEB_PORT || 4179}`,
    'x-csrf-token': csrf.token,
  };
  const title = '保留自己的专注记录 ' + info.project.name;
  const task = await page.request.post('/api/to-doo/commands', {
    headers,
    data: { requestId: crypto.randomUUID(), action: 'create_task', payload: { title } },
  });
  expect(task.ok()).toBe(true);
  const taskId = (await task.json()).ids[0];
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app.getByRole('button', { name: '新建专注项目', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建专注项目', exact: true });
  const topicName = '阅读与学习 ' + info.project.name;
  await editor.getByLabel('名称', { exact: true }).fill(topicName);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await app.getByRole('button', { name: '选择专注项目 ' + topicName, exact: true }).click();
  if (!(await app.getByRole('combobox', { name: '关联行动', exact: true }).isVisible()))
    await app.getByRole('button', { name: '计时设置', exact: true }).click();
  await selectToDooOption(app, '关联行动', title);
  const closeSettings = app.getByRole('button', { name: '收起计时设置', exact: true });
  if (await closeSettings.isVisible()) await closeSettings.click();
  await app.getByRole('button', { name: '开始专注', exact: true }).click();
  await expect(app.getByRole('timer', { name: '专注计时' })).toBeVisible();
  await app.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(app.getByRole('button', { name: '继续', exact: true })).toBeVisible();
  await page.reload();
  await expect(app.getByRole('button', { name: '继续', exact: true })).toBeVisible();
  const note = '今天读完一章，下次从练习开始。';
  if (!(await app.getByRole('textbox', { name: '本次专注记录', exact: true }).isVisible()))
    await app.getByRole('button', { name: '计时设置', exact: true }).click();
  await app.getByRole('textbox', { name: '本次专注记录', exact: true }).fill(note);
  if (await closeSettings.isVisible()) await closeSettings.click();
  await app.getByRole('button', { name: '结束并保存', exact: true }).click();
  const record = app.locator('.todo-focus-history-item').filter({ hasText: note });
  await expect(record).toBeVisible();
  await record.locator('summary').click();
  await record.getByRole('button', { name: '修正', exact: true }).click();
  const correction = page.getByRole('dialog', { name: '修正专注时长', exact: true });
  await correction.getByRole('spinbutton', { name: '实际专注分钟数', exact: true }).fill('25');
  await correction.getByRole('button', { name: '保存', exact: true }).click();
  await expect(record).toContainText('25 分钟');
  if (
    !(await app.getByRole('button', { name: '专注项目操作 ' + topicName, exact: true }).isVisible())
  )
    await app.locator('.todo-focus-mobile-panes').getByText('项目', { exact: true }).click();
  await app.getByRole('button', { name: '专注项目操作 ' + topicName, exact: true }).click();
  await page.getByRole('menuitem', { name: '归档项目', exact: true }).click();
  await app.getByText('已归档', { exact: true }).click();
  await expect(
    app.getByRole('button', { name: '选择专注项目 ' + topicName, exact: true }),
  ).toBeVisible();
  const saved = await (await page.request.get('/api/to-doo/state?taskIds=' + taskId)).json();
  expect(saved.occurrences.find((row: any) => row.taskId === taskId).status).toBe('todo');
  await page.reload();
  await expect(app.getByRole('region', { name: '专注计时器', exact: true })).toBeVisible();
  const historyPane = app.locator('.todo-focus-mobile-panes');
  if (await historyPane.isVisible()) {
    await historyPane.getByText('历史', { exact: true }).click();
    await expect(app.getByRole('radio', { name: '历史', exact: true })).toBeChecked();
  }
  await expect(app.locator('.todo-focus-history-item').filter({ hasText: note })).toBeVisible();
  await page.screenshot({ path: info.outputPath('focus-project-history.png'), fullPage: true });
});

test('1205 older records do not hide the current timer and history filters use real paging', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = {
    origin: `http://127.0.0.1:${process.env.DOOKNOW_E2E_WEB_PORT || 4179}`,
    'x-csrf-token': csrf.token,
  };
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers,
      timeout: 60000,
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  const id = 'history-project-' + info.project.name;
  const name = '长期记录 ' + info.project.name;
  await command('save_entity', { kind: 'focusTopic', entity: { id, name } });
  const first = Date.parse('2025-01-01T00:00:00Z');
  await command('import_entities', {
    entities: Array.from({ length: 1205 }, (_, index) => ({
      kind: 'focusSession',
      entity: {
        id: id + '-' + index,
        topicId: id,
        mode: 'stopwatch',
        status: 'finished',
        note: '历史片段 ' + index,
        segments: [
          {
            start: new Date(first + index * 60000).toISOString(),
            end: new Date(first + (index + 1) * 60000).toISOString(),
          },
        ],
      },
    })),
  });
  const started = await command('start_focus', { mode: 'stopwatch', topicId: id });
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  const historyPane = app.locator('.todo-focus-mobile-panes');
  if (await historyPane.isVisible()) {
    await historyPane.getByText('历史', { exact: true }).click();
    await expect(app.getByRole('radio', { name: '历史', exact: true })).toBeChecked();
  }
  await selectToDooOption(app, '专注记录项目', name);
  const rows = app.locator('.todo-focus-history-item');
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toHaveAttribute('data-session-id', started.ids[0]);
  await expect(rows.nth(1)).toContainText('历史片段 1204');
  await app.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await expect(rows).toHaveCount(100);
  const ids = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-session-id')),
  );
  expect(new Set(ids).size).toBe(100);
  await selectToDooOption(app, '专注记录日期范围', '今天');
  await expect(rows).toHaveCount(1);
  await expect(app.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await app.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(app.getByRole('button', { name: '继续', exact: true })).toBeVisible();
  await app.getByRole('button', { name: '结束并保存', exact: true }).click();
  const saved = await (
    await page.request.get('/api/to-doo/focus/history?topicId=' + id + '&limit=1')
  ).json();
  expect(saved.active).toBeNull();
  expect(saved.overview.lifetime.completed).toBe(1206);
});

test('another window can finish the timer while a local note survives read and save failures', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app.getByRole('button', { name: '开始专注', exact: true }).click();
  await expect(app.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  const note = '切换窗口后也不能丢失的专注记录';
  if (!(await app.getByRole('textbox', { name: '本次专注记录', exact: true }).isVisible()))
    await app.getByRole('button', { name: '计时设置', exact: true }).click();
  await app.getByRole('textbox', { name: '本次专注记录', exact: true }).fill(note);
  const close = app.getByRole('button', { name: '收起计时设置', exact: true });
  if (await close.isVisible()) await close.click();
  const other = await context.newPage();
  await other.goto('/?view=apps&app=to-doo&appSection=focus');
  await other.getByRole('button', { name: '结束并保存', exact: true }).click();
  await expect(other.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const retained = app.getByRole('textbox', { name: '尚未保存的专注记录', exact: true });
  await expect(retained).toHaveValue(note);
  await page.route(
    '**/api/to-doo/state?kind=focusSession&ids=*',
    (route) => route.fulfill({ status: 503, json: { error: '历史暂时无法读取，请重试' } }),
    { times: 1 },
  );
  await app.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(app.getByRole('alert')).toContainText('历史暂时无法读取');
  await expect(retained).toHaveValue(note);
  await page.route(
    '**/api/to-doo/commands',
    (route) => route.fulfill({ status: 503, json: { error: '专注记录暂时无法保存，请重试' } }),
    { times: 1 },
  );
  await app.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(app.getByRole('alert')).toContainText('专注记录暂时无法保存');
  await expect(retained).toHaveValue(note);
  await app.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(retained).not.toBeVisible();
  await expect(app.locator('.todo-focus-history-item').filter({ hasText: note })).toBeVisible();
  await other.close();
});

test('typing while finish is pending keeps the newer note after the receipt arrives', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app.getByRole('button', { name: '开始专注', exact: true }).click();
  await expect(app.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  const note = app.getByRole('textbox', { name: '本次专注记录', exact: true });
  const settings = app.getByRole('button', { name: '计时设置', exact: true });
  const close = app.getByRole('button', { name: '收起计时设置', exact: true });
  if (!(await note.isVisible())) await settings.click();
  await note.fill('结束时提交的记录');
  if (await close.isVisible()) await close.click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/to-doo/commands', async (route) => {
    const command = route.request().postDataJSON();
    if (command.action === 'control_focus' && command.payload.operation === 'finish') await gate;
    await route.continue();
  });
  const pending = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.payload.operation === 'finish',
  );
  await app.getByRole('button', { name: '结束并保存', exact: true }).click();
  await pending;
  try {
    if (!(await note.isVisible())) await settings.click();
    await note.fill('结束时提交的记录，等待时继续补写');
    if (await close.isVisible()) await close.click();
  } finally {
    release();
  }
  const retained = app.getByRole('textbox', { name: '尚未保存的专注记录', exact: true });
  await expect(retained).toHaveValue('结束时提交的记录，等待时继续补写');
  await app.getByRole('button', { name: '保存记录', exact: true }).click();
  await expect(retained).not.toBeVisible();
  await expect(
    app.locator('.todo-focus-history-item').filter({ hasText: '等待时继续补写' }),
  ).toBeVisible();
});

test('saving a retained note detects another window text and can preserve both versions', async ({
  page,
  context,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await app.getByRole('button', { name: '开始专注', exact: true }).click();
  await expect(app.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  const note = app.getByRole('textbox', { name: '本次专注记录', exact: true });
  if (!(await note.isVisible()))
    await app.getByRole('button', { name: '计时设置', exact: true }).click();
  await note.fill('本窗口补写的内容');
  const close = app.getByRole('button', { name: '收起计时设置', exact: true });
  if (await close.isVisible()) await close.click();
  const other = await context.newPage();
  try {
    await other.goto('/?view=apps&app=to-doo&appSection=focus');
    const otherNote = other.getByRole('textbox', { name: '本次专注记录', exact: true });
    await expect(other.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
    if (!(await otherNote.isVisible()))
      await other.getByRole('button', { name: '计时设置', exact: true }).click();
    await otherNote.fill('另一个窗口已经保存的内容');
    const otherClose = other.getByRole('button', { name: '收起计时设置', exact: true });
    if (await otherClose.isVisible()) await otherClose.click();
    await other.getByRole('button', { name: '结束并保存', exact: true }).click();
    await expect(other.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
    await page.bringToFront();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const retained = app.getByRole('textbox', { name: '尚未保存的专注记录', exact: true });
    await expect(retained).toHaveValue('本窗口补写的内容');
    await app.getByRole('button', { name: '保存记录', exact: true }).click();
    const conflict = page.getByRole('dialog', { name: '专注记录已在其他窗口更新', exact: true });
    await expect(conflict.getByLabel('已保存的记录', { exact: true })).toHaveValue(
      '另一个窗口已经保存的内容',
    );
    await conflict.getByRole('button', { name: '保留两份记录', exact: true }).click();
    await expect(conflict).not.toBeVisible();
    await expect(retained).not.toBeVisible();
    const record = app.locator('.todo-focus-history-item').filter({ hasText: '本窗口补写的内容' });
    await expect(record).toContainText('另一个窗口已经保存的内容');
  } finally {
    await other.close();
  }
});

test('an interrupted session resumes from history and active note conflicts preserve both versions', async ({
  page,
}) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token };
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers,
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  const topicId = 'interrupted-' + crypto.randomUUID();
  const topicName = '恢复中断记录项目';
  await command('save_entity', { kind: 'focusTopic', entity: { id: topicId, name: topicName } });
  const interrupted = await command('save_entity', {
    kind: 'focusSession',
    entity: {
      topicId,
      mode: 'pomodoro',
      status: 'interrupted',
      topicName: '恢复中断记录',
      note: '原始记录',
      segments: [{ start: '2026-10-01T08:00:00Z', end: '2026-10-01T08:10:00Z' }],
    },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await openToDooFocusHistory(page);
  await selectToDooOption(app, '专注记录项目', topicName);
  const row = app.locator('.todo-focus-history-item').filter({ hasText: '恢复中断记录' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '继续计时', exact: true }).click();
  await expect(app.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  const note = app.getByRole('textbox', { name: '本次专注记录', exact: true });
  if (!(await note.isVisible()))
    await app.getByRole('button', { name: '计时设置', exact: true }).click();
  await note.fill('本窗口尚未保存的记录');
  const close = app.getByRole('button', { name: '收起计时设置', exact: true });
  if (await close.isVisible()) await close.click();
  const current = (await (await page.request.get('/api/to-doo/focus/history?limit=1')).json())
    .active;
  expect(current.id).toBe(interrupted.ids[0]);
  await command('save_entity', {
    kind: 'focusSession',
    expectedRevision: current.revision,
    entity: { ...current, note: '另一窗口已经保存的记录' },
  });
  const refreshed = page.waitForResponse((response) =>
    response.url().includes('/api/to-doo/focus/history'),
  );
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refreshed;
  await app.getByRole('button', { name: '结束并保存', exact: true }).click();
  const conflict = page.getByRole('dialog', { name: '专注记录已在其他窗口更新', exact: true });
  await expect(conflict).toBeVisible();
  await expect(conflict.getByLabel('已保存的记录', { exact: true })).toHaveValue(
    '另一窗口已经保存的记录',
  );
  const beforeMerge = (await (await page.request.get('/api/to-doo/focus/history?limit=1')).json())
    .active;
  expect(beforeMerge.note).toBe('另一窗口已经保存的记录');
  await conflict.getByRole('button', { name: '保留两份记录', exact: true }).click();
  await expect(conflict).not.toBeVisible();
  await expect(app.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
  const result = await (
    await page.request.get('/api/to-doo/state?kind=focusSession&ids=' + current.id)
  ).json();
  expect(result.focusSessions[0]).toMatchObject({
    status: 'finished',
    note: '另一窗口已经保存的记录\n\n本窗口尚未保存的记录',
  });
});
