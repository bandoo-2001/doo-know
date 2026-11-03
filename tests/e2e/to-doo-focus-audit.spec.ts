import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { selectToDooOption } from '../support/to-doo-ant-controls';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function fixture(page: Page, count: number) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const prefix = crypto.randomUUID().slice(0, 8),
    id = 'focus-audit-' + prefix,
    name = '专注审计 ' + prefix;
  const command = async (action: string, payload: Record<string, unknown>) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const current = await (await page.request.get('/api/to-doo/focus/history?limit=1')).json();
  if (current.active)
    await command('control_focus', {
      id: current.active.id,
      expectedRevision: current.active.revision,
      operation: 'cancel',
    });
  await command('save_entity', { kind: 'focusTopic', entity: { id, name } });
  const otherName = '独立计时 ' + prefix;
  await command('save_entity', {
    kind: 'focusTopic',
    entity: { id: id + '-timer', name: otherName },
  });
  const first = Date.parse('2026-10-01T08:00:00Z');
  const entity = (index: number, extra = false) => ({
    id: id + (extra ? '-extra-' : '-') + index,
    topicId: id,
    mode: 'stopwatch',
    status: 'finished',
    correctedMinutes: index === 0 && !extra ? 12 : null,
    segments: [
      {
        start: new Date(first + (index + (extra ? 300 : 0)) * 60000).toISOString(),
        end: new Date(first + (index + (extra ? 300 : 0) + 1) * 60000).toISOString(),
      },
    ],
    note: extra ? '其他设备新增' : '已加载记录 ' + index,
  });
  await command('import_entities', {
    entities: Array.from({ length: count }, (_, index) => ({
      kind: 'focusSession',
      entity: entity(index),
    })),
  });
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const showProjects = async () => {
    const panes = app.locator('.todo-focus-mobile-panes');
    if (await panes.isVisible()) await panes.getByText('项目', { exact: true }).click();
  };
  return { app, id, name, otherName, command, entity, showProjects };
}

test('cumulative action opens phone history independently of the timer and free focus submits null', async ({
  page,
}, info) => {
  const { app, name, otherName, showProjects } = await fixture(page, 4);
  await app.getByRole('button', { name: '选择专注项目 ' + otherName, exact: true }).click();
  const timer = app.getByRole('region', { name: '专注计时器', exact: true });
  await expect(timer).toContainText(otherName);
  if (info.project.name === 'mobile') {
    const cumulative = app.getByRole('button', { name: '查看累计 ' + name, exact: true });
    await expect(cumulative.getByText('15 分钟', { exact: true })).toBeVisible();
    expect(
      (await cumulative.getByText('15 分钟', { exact: true }).boundingBox())!.height,
    ).toBeLessThanOrEqual(20);
    const directory = resolve('docs/design/to-doo/audit-fixes-2026-11-03/after');
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: resolve(directory, 'phone-focus-projects.png'), scale: 'css' });
  }
  await app.getByRole('button', { name: '查看累计 ' + name, exact: true }).click();
  const records = app.getByRole('complementary', { name: '专注概览和历史', exact: true });
  await expect(records).toBeVisible();
  await expect(app.locator('.todo-focus-history-item')).toHaveCount(4);
  await expect(records).toContainText('已修正');
  await expect(timer).toContainText(otherName);
  if (info.project.name === 'mobile') {
    const directory = resolve('docs/design/to-doo/audit-fixes-2026-11-03/after');
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: resolve(directory, 'phone-focus-history.png'), scale: 'css' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  }
  await showProjects();
  await app.getByRole('button', { name: '自由专注', exact: true }).click();
  await expect(timer).toContainText('自由专注');
  const submitted = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.action === 'start_focus',
  );
  await timer.getByRole('button', { name: '开始专注', exact: true }).click();
  expect((await submitted).postDataJSON().payload.topicId).toBeNull();
  await expect(timer.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await timer.getByRole('button', { name: '取消本次', exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible())
    await dialog.getByRole('button', { name: '确认', exact: true }).click();
});

test('activity polling merges more than fifty new records and deletion while retaining loaded pages', async ({
  page,
}) => {
  await page.clock.install();
  const { app, id, name, command, entity } = await fixture(page, 130);
  await app.getByRole('button', { name: '查看累计 ' + name, exact: true }).click();
  const rows = app.locator('.todo-focus-history-item');
  await expect(rows).toHaveCount(50);
  await app.getByRole('button', { name: '加载更早记录', exact: true }).click();
  await expect(rows).toHaveCount(100);
  await command('import_entities', {
    entities: Array.from({ length: 65 }, (_, index) => ({
      kind: 'focusSession',
      entity: entity(index, true),
    })),
  });
  const saved = await (
    await page.request.get('/api/to-doo/state?kind=focusSession&ids=' + id + '-70')
  ).json();
  const deleted = saved.focusSessions[0];
  await command('save_entity', {
    kind: 'focusSession',
    entity: { ...deleted, deletedAt: new Date().toISOString() },
    expectedRevision: deleted.revision,
  });
  await page.clock.fastForward(10001);
  await expect(rows).toHaveCount(194);
  await expect(app.locator(`[data-session-id="${id}-30"]`)).toBeVisible();
  await expect(app.locator(`[data-session-id="${id}-70"]`)).toHaveCount(0);
  const ids = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-session-id')),
  );
  expect(new Set(ids).size).toBe(194);
  expect(ids[0]).toBe(id + '-extra-64');
  await expect(app.getByText('194 条记录 · 已全部载入', { exact: true })).toBeVisible();
});
