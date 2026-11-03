import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import {
  expandToDooGroup,
  fillToDooDate,
  selectToDooOption,
  toDooDisclosureHeader,
} from '../support/to-doo-ant-controls';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}
async function state(page: Page, kind: string, id: string) {
  const response = await page.request.get(
    '/api/to-doo/state?' + new URLSearchParams({ kind, ids: id }),
  );
  expect(response.ok()).toBe(true);
  return response.json();
}
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('a short habit form saves its optional settings and retains them when reopened', async ({
  page,
}, info) => {
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  await page
    .getByRole('button', { name: /新建习惯/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  const name = '轻松阅读 ' + info.project.name + '-' + crypto.randomUUID();
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await selectToDooOption(editor, '目标', '完成一定数量');
  await editor.getByRole('spinbutton', { name: '目标数量', exact: true }).fill('5');
  await editor.getByLabel('单位', { exact: true }).fill('页');
  await expect(editor.getByLabel('开始日期', { exact: true })).toBeVisible();
  await expect(editor.getByLabel('规则生效日期', { exact: true })).not.toBeVisible();
  await page.screenshot({
    path: info.outputPath('habit-short-form.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await expandToDooGroup(editor, '补充信息');
  await editor.getByLabel('说明', { exact: true }).fill('每天读一点');
  await selectToDooOption(editor, '跳过的计算方式', '免除本期，不中断');
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      r.url().endsWith('/api/to-doo/commands') &&
      r.request().postDataJSON()?.payload.kind === 'habit',
  );
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  const result = await (await saved).json();
  const id = result.ids[0];
  await expect(editor).not.toBeVisible();
  await page.getByRole('button', { name, exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '编辑习惯', exact: true });
  await expect(reopened.getByLabel('说明', { exact: true })).not.toBeVisible();
  await reopened.getByRole('button', { name: '保存', exact: true }).click();
  await expect(reopened).not.toBeVisible();
  const stored = (await state(page, 'habit', id)).habits.find((h: any) => h.id === id);
  expect(stored).toMatchObject({
    target: 5,
    unit: '页',
    description: '每天读一点',
    skipPolicy: 'exempt',
  });
});

test('an entity form locks the submitted fields while saving and restores them after failure', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  await page
    .getByRole('button', { name: /新建习惯/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  const name = editor.getByLabel('名称', { exact: true });
  await name.fill('等待保存时保留的习惯');
  await selectToDooOption(editor, '目标', '完成一定数量');
  const quantity = editor.getByRole('spinbutton', { name: '目标数量', exact: true });
  await quantity.fill('2.5');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/to-doo/commands', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'save_entity' && body.payload.kind === 'habit') {
      await gate;
      await route.fulfill({ status: 503, json: { error: '习惯暂时无法保存' } });
    } else await route.continue();
  });
  const request = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.payload.kind === 'habit',
  );
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await request;
  try {
    await expect(name).toBeDisabled();
    await expect(quantity).toBeDisabled();
  } finally {
    release();
  }
  await expect(editor.getByRole('alert')).toContainText('习惯暂时无法保存');
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue('等待保存时保留的习惯');
  await expect(quantity).toHaveValue('2.5');
});

test('a valid lunar day outside the Gregorian month can be saved and reopened as its original date', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=anniversaries');
  await page
    .getByRole('button', { name: /新建纪念日/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建纪念日', exact: true });
  const name = '农历二月三十 ' + crypto.randomUUID().slice(0, 8);
  await editor.getByLabel('名称', { exact: true }).fill(name);
  await selectToDooOption(editor, '历法', '农历');
  await editor.getByRole('spinbutton', { name: '农历年', exact: true }).fill('2024');
  await selectToDooOption(editor, '农历月', '二月');
  await editor.getByRole('spinbutton', { name: '农历日', exact: true }).fill('30');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const card = page
    .locator('.todo-anniversary')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card).toContainText('农历原日期：2024-02-30');
  await page.reload();
  await card.getByRole('button', { name: '编辑 ' + name, exact: true }).click();
  const reopened = page.getByRole('dialog', { name: '编辑纪念日', exact: true });
  await expect(reopened.getByRole('spinbutton', { name: '农历年', exact: true })).toHaveValue(
    '2024',
  );
  await expect(reopened.getByRole('spinbutton', { name: '农历日', exact: true })).toHaveValue('30');
  await page
    .getByRole('dialog', { name: '编辑纪念日', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  for (const view of ['month', 'week']) {
    await page.goto(
      '/?view=apps&app=to-doo&appSection=calendar&calendarView=' + view + '&date=2027-04-06',
    );
    const marker = page.locator('[data-anniversary-id]:visible').filter({ hasText: name });
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAttribute('data-date', '2027-04-06');
  }
});

test('invalid Gregorian input stays visible and cannot silently save the previous date', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=anniversaries');
  await page
    .getByRole('button', { name: /新建纪念日/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建纪念日', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill('公历日期校验');
  const date = editor.getByRole('textbox', { name: '日期', exact: true });
  await date.click();
  await date.fill('2026-02-30');
  await date.press('Tab');
  await editor.getByText('新建纪念日', { exact: true }).click();
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(date).toHaveValue('2026-02-30');
  await expect(editor.getByRole('alert')).toContainText('请检查');
  expect(writes).toBe(0);
  await fillToDooDate(date, '2026-11-12');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(writes).toBe(1);
});

test('all-day schedule hides irrelevant controls, restores the timed draft and persists a valid day', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.getByRole('button', { name: '＋ 时间安排', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建时间安排', exact: true });
  await editor.getByLabel('安排标题', { exact: true }).fill('全天安排 ' + info.project.name);
  await fillToDooDate(editor.getByLabel('时间', { exact: true }), '10:30');
  await editor.getByRole('checkbox', { name: '全天安排', exact: true }).check();
  await expect(editor.getByLabel('时间', { exact: true })).not.toBeVisible();
  await expect(
    editor.getByRole('spinbutton', { name: '时长（分钟）', exact: true }),
  ).not.toBeVisible();
  await editor.getByRole('checkbox', { name: '全天安排', exact: true }).uncheck();
  await expect(editor.getByLabel('时间', { exact: true })).toHaveValue('10:30');
  await editor.getByRole('checkbox', { name: '全天安排', exact: true }).check();
  await page.screenshot({
    path: info.outputPath('schedule-320-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      r.url().endsWith('/api/to-doo/commands') &&
      r.request().postDataJSON()?.payload.kind === 'timeBlock',
  );
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.snapshot.timeBlocks.find((b: any) => b.id === result.ids[0])).toMatchObject({
    allDay: true,
    start: { time: null },
  });
});

test('changing list type does not erase its hidden goal fields', async ({ page }, info) => {
  const name = '轻量清单 ' + info.project.name + '-' + crypto.randomUUID();
  const created = await command(page, 'save_entity', {
    kind: 'list',
    entity: {
      name,
      kind: 'list',
      description: '保留说明',
      criteria: '保留标准',
      goalDate: '2030-04-03',
    },
  });
  const id = created.ids[0];
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + id);
  await page.getByRole('button', { name: '编辑当前清单', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑目标与清单', exact: true });
  await expect(editor.getByLabel('说明', { exact: true })).not.toBeVisible();
  await expect(editor.getByLabel('目标日期', { exact: true })).not.toBeVisible();
  await editor.getByText('目标', { exact: true }).click();
  await expect(editor.getByLabel('目标日期', { exact: true })).toHaveValue('2030-04-03');
  await editor.getByText('清单', { exact: true }).click();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect((await state(page, 'list', id)).lists.find((l: any) => l.id === id)).toMatchObject({
    kind: 'list',
    description: '保留说明',
    criteria: '保留标准',
    goalDate: '2030-04-03',
  });
});

test('invalid required settings inside a closed group are revealed on save', async ({ page }) => {
  await page.goto('/?view=apps&app=to-doo&appSection=calendar');
  await page.getByRole('button', { name: '＋ 时间安排', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建时间安排', exact: true });
  await expandToDooGroup(editor, '补充信息');
  await editor.getByLabel('时区', { exact: true }).fill('');
  await toDooDisclosureHeader(editor, '补充信息').click();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor.getByLabel('时区', { exact: true })).toBeVisible();
  await expect(editor.getByLabel('时区', { exact: true })).toBeFocused();
  await expect(editor.getByRole('alert')).toContainText('请检查');
  await editor.getByLabel('时区', { exact: true }).fill('Asia/Shanghai');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
});

test('task settings shortcuts open the existing editors with one click', async ({ page }) => {
  const created = await command(page, 'create_task', { title: '直接设置提醒' });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&task=' + created.ids[0]);
  const detail = page.getByRole('complementary', { name: '任务详情' });
  await detail.getByRole('button', { name: '添加属性', exact: true }).click();
  await page.getByRole('button', { name: '编辑任务提醒', exact: true }).click();
  await expect(detail.getByRole('button', { name: '＋ 添加提醒', exact: true })).toBeInViewport();
  await detail.getByRole('button', { name: '＋ 添加提醒', exact: true }).click();
  await expect(detail.getByRole('combobox', { name: '提醒依据', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '添加属性', exact: true }).click();
  await page.getByRole('button', { name: '编辑重复规则', exact: true }).click();
  await expect(detail.getByRole('combobox', { name: '重复', exact: true })).toBeFocused();
  await detail.getByRole('button', { name: '添加属性', exact: true }).click();
  await page.getByRole('button', { name: '编辑关联资料', exact: true }).click();
  await expect(detail.getByRole('button', { name: '+ 关联资料', exact: true })).toBeInViewport();
});

test('preference groups preserve folded values while saving a common setting', async ({ page }) => {
  const before = await (await page.request.get('/api/to-doo/state')).json();
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  await expect(
    app.getByRole('spinbutton', { name: '任务层级上限', exact: true }),
  ).not.toBeVisible();
  await app.getByRole('spinbutton', { name: '默认安排分钟', exact: true }).fill('45');
  await expandToDooGroup(app, '任务规则');
  await app.getByRole('spinbutton', { name: '任务层级上限', exact: true }).fill('24');
  await toDooDisclosureHeader(app, '任务规则').click();
  await app.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(app.getByRole('status')).toContainText('偏好已保存');
  const saved = await (await page.request.get('/api/to-doo/state')).json();
  expect(saved.settings).toMatchObject({ maxDepth: 24, defaultDurationMinutes: 45 });
  await command(page, 'save_entity', {
    kind: 'settings',
    entity: before.settings,
    expectedRevision: saved.settings.revision,
  });
});

test('settings tabs preserve drafts and keep unrelated forms out of preferences', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  await expect(app.getByRole('tab', { name: '偏好', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(app.getByRole('heading', { name: '数据与备份', exact: true })).not.toBeVisible();
  const duration = app.getByRole('spinbutton', { name: '默认安排分钟', exact: true });
  await duration.fill('47');
  await app.getByRole('tab', { name: '数据与恢复', exact: true }).click();
  await expect(duration).not.toBeVisible();
  const importContent = app.getByLabel('或粘贴文件内容', { exact: true });
  await importContent.fill('尚未预览的导入草稿');
  await app.getByRole('tab', { name: '提醒与连接', exact: true }).click();
  await expect(app.getByRole('heading', { name: '桌面提醒', exact: true })).toBeVisible();
  await app.getByRole('tab', { name: '偏好', exact: true }).click();
  await expect(duration).toHaveValue('47');
  await app.getByRole('tab', { name: '数据与恢复', exact: true }).click();
  await expect(importContent).toHaveValue('尚未预览的导入草稿');
  await expect(app.getByRole('dialog')).toHaveCount(0);
});

test('header save reveals a folded invalid preference and accepts a zero break', async ({
  page,
}) => {
  const before = await (await page.request.get('/api/to-doo/state')).json();
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  await expandToDooGroup(app, '专注节奏');
  const shortBreak = app.getByRole('spinbutton', { name: '短休息分钟', exact: true });
  await shortBreak.fill('');
  await toDooDisclosureHeader(app, '专注节奏').click();
  await app.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(shortBreak).toBeVisible();
  await expect(shortBreak).toBeFocused();
  await expect(app.getByRole('alert')).toContainText('短休息分钟');
  await shortBreak.fill('0');
  await app.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(app.getByRole('status')).toContainText('偏好已保存');
  const saved = await (await page.request.get('/api/to-doo/state')).json();
  expect(saved.settings.shortBreakMinutes).toBe(0);
  await command(page, 'save_entity', {
    kind: 'settings',
    entity: before.settings,
    expectedRevision: saved.settings.revision,
  });
});

for (const restoreOriginal of [false, true]) {
  test(
    'preferences typed while a save is pending remain as the next draft: ' +
      (restoreOriginal ? 'return to original value' : 'new value'),
    async ({ page }) => {
      const before = await (await page.request.get('/api/to-doo/state')).json();
      const nextValue = restoreOriginal ? before.settings.defaultDurationMinutes : 47;
      await page.goto('/?view=apps&app=to-doo&appSection=settings');
      const field = page.getByRole('spinbutton', { name: '默认安排分钟', exact: true });
      await field.fill('43');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/to-doo/commands', async (route) => {
        const body = route.request().postDataJSON();
        if (body.action === 'save_entity' && body.payload.kind === 'settings') await gate;
        await route.continue();
      });
      const pending = page.waitForRequest(
        (request) =>
          request.url().endsWith('/api/to-doo/commands') &&
          request.postDataJSON()?.payload.kind === 'settings',
      );
      await page.getByRole('button', { name: '保存偏好', exact: true }).click();
      await pending;
      try {
        await field.fill(String(nextValue));
      } finally {
        release();
      }
      await expect(page.getByRole('status')).toContainText('偏好已保存');
      await expect(field).toHaveValue(String(nextValue));
      expect(
        (await (await page.request.get('/api/to-doo/settings')).json()).defaultDurationMinutes,
      ).toBe(43);
      await page.getByRole('button', { name: '保存偏好', exact: true }).click();
      await expect(page.getByText('有未保存的更改', { exact: true })).not.toBeVisible();
      const saved = await (await page.request.get('/api/to-doo/settings')).json();
      expect(saved.defaultDurationMinutes).toBe(nextValue);
      await command(page, 'save_entity', {
        kind: 'settings',
        entity: before.settings,
        expectedRevision: saved.revision,
      });
    },
  );
}
