import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { openToDooTaskTools } from '../support/to-doo-navigation';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function settings(page: Page, patch: Record<string, unknown>) {
  const state = await (await page.request.get('/api/to-doo/state')).json();
  await command(page, 'save_entity', {
    kind: 'settings',
    entity: { ...state.settings, ...patch },
    expectedRevision: state.settings.revision,
  });
}
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('saved direct conditions stay inspectable in board, matrix and timeline, then clear in place', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '筛选核对 ' + suffix },
  });
  const title = '符合附加条件 ' + suffix;
  await command(page, 'create_task', {
    title,
    listId: list.ids[0],
    priority: 'high',
    importance: 'important',
  });
  const other = '清除后恢复 ' + suffix;
  await command(page, 'create_task', { title: other, listId: list.ids[0] });
  for (const mode of ['board', 'matrix', 'timeline']) {
    const name = '已存条件 ' + mode + ' ' + suffix;
    const savedView = await command(page, 'save_entity', {
      kind: 'view',
      entity: {
        name,
        mode,
        filter: {
          listIds: [list.ids[0]],
          priorities: ['high'],
          importance: 'important',
          leafOnly: true,
          hasEvidence: false,
        },
      },
    });
    await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
    await page.getByRole('button', { name, exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe(mode);
    const scope =
      mode === 'timeline'
        ? page.getByLabel('当前任务范围', { exact: true })
        : page.getByLabel('附加筛选', { exact: true });
    if (mode === 'timeline') await scope.locator('summary').click();
    await expect(scope).toContainText('优先级：高');
    await expect(scope).toContainText('重要程度：重要');
    await expect(scope).toContainText('仅叶子任务');
    await expect(scope).toContainText('无成果证据');
    await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp('^' + other) })).not.toBeVisible();
    const request = page.waitForRequest((request) => {
      if (!request.url().includes('/api/to-doo/state?')) return false;
      const query = new URL(request.url()).searchParams;
      return query.get('view') === mode && query.get('filter') === '{}';
    });
    await scope.getByRole('button', { name: '清除筛选', exact: true }).click();
    await request;
    await expect(page.getByRole('button', { name: new RegExp('^' + other) })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('appSection')).toBe(mode);
    await command(page, 'delete_entity', {
      kind: 'view',
      id: savedView.ids[0],
      expectedRevision: savedView.changed.find((row: any) => row.kind === 'view').revision,
    });
  }
});

test('date-only creation keeps the configured duration through persistence and the phone agenda', async ({
  page,
}) => {
  await settings(page, { timeZone: 'UTC', defaultDurationMinutes: 45 });
  const title = '只选日期的安排 ' + crypto.randomUUID().slice(0, 8);
  const result = await command(page, 'create_task', {
    title,
    plan: { date: '2032-05-03', time: null, timeZone: 'UTC' },
  });
  const saved = await (await page.request.get('/api/to-doo/state?taskIds=' + result.ids[0])).json();
  expect(saved.timeBlocks[0]).toMatchObject({
    allDay: false,
    durationMinutes: 45,
    start: { date: '2032-05-03', time: null },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=month&date=2032-05-03');
  const arrangement = page
    .locator('.todo-mobile-agenda')
    .getByRole('button')
    .filter({ hasText: title });
  await expect(arrangement).toContainText('未指定时刻');
  await expect(arrangement).toContainText('45 分钟');
  await expect(arrangement).not.toContainText('1440');
});

test('mounted calendar requests the new week and reveals its boundary event after midnight', async ({
  page,
}) => {
  await settings(page, { timeZone: 'UTC', weekStartsOn: 1 });
  const title = '新周边界事件 ' + crypto.randomUUID().slice(0, 8);
  await command(page, 'save_entity', {
    kind: 'timeBlock',
    entity: {
      title,
      start: { date: '2032-05-09', time: '10:00', timeZone: 'UTC' },
      durationMinutes: 45,
    },
  });
  await page.clock.install({ time: new Date('2032-05-02T23:59:30Z') });
  await page.goto('/?view=apps&app=to-doo&appSection=calendar&calendarView=week');
  await expect(page.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button').filter({ hasText: title })).toHaveCount(0);
  const nextRange = page.waitForRequest((request) => {
    if (!request.url().includes('/api/to-doo/state?')) return false;
    const params = new URL(request.url()).searchParams;
    return params.get('from') === '2032-05-03' && params.get('to') === '2032-05-09';
  });
  await page.clock.fastForward(60000);
  await nextRange;
  await expect(page.getByRole('button').filter({ hasText: title }).first()).toBeVisible();
});

// The compact toolbar still opens its real phone controls after immediate navigation.
test('task first row and board first card remain compact while tools and grouping are reachable', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = '首屏几何验证 ' + crypto.randomUUID().slice(0, 8);
  await command(page, 'create_task', { title });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  const first = page.locator('.todo-task-row').first();
  await expect(first).toBeVisible();
  const row = await first.boundingBox();
  expect(row!.y).toBeLessThan(410);
  await page.screenshot({ path: info.outputPath('phone-tasks-final.png'), animations: 'disabled' });
  await page.locator('.todo-view-switch').getByText('看板', { exact: true }).click();
  const card = page.locator('.todo-board-card').first();
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.y).toBeLessThan(450);
  await page.screenshot({ path: info.outputPath('phone-board-final.png'), animations: 'disabled' });
  await openToDooTaskTools(page);
  await expect(page.getByRole('combobox', { name: '看板分组', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '看板列概览', exact: true })).toBeVisible();
});
