import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

function dateAfter(date: string, days: number) {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test('the opened recurring occurrence is active independently of batch selection', async ({
  page,
}, info) => {
  const snapshot = await (await page.request.get('/api/to-doo/state')).json();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: snapshot.settings.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const suffix = info.project.name + '-' + Date.now();
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '行选择验证 ' + suffix, kind: 'list' },
  });
  const title = '两次行动 ' + suffix;
  await command(page, 'create_task', {
    title,
    listId: list.ids[0],
    recurrence: { id: crypto.randomUUID(), frequency: 'daily', anchorDate: today, count: 2 },
  });
  const otherTitle = '批量选择的另一项 ' + suffix;
  await command(page, 'create_task', { title: otherTitle, listId: list.ids[0] });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list.ids[0]);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  const occurrences = app.locator('.todo-task-row').filter({
    has: page.getByRole('button', { name: title, exact: true }),
  });
  await expect(occurrences).toHaveCount(2);
  await occurrences.last().getByRole('button', { name: title, exact: true }).click();
  const detail = app.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expect(occurrences.last()).toHaveClass(/is-active/);
  await expect(occurrences.first()).not.toHaveClass(/is-active/);
  await expect(
    occurrences.last().getByRole('button', { name: title, exact: true }),
  ).toHaveAttribute('aria-current', 'true');
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await app.getByRole('button', { name: '任务管理', exact: true }).click();
  await page.getByRole('menuitem', { name: '多选', exact: true }).click();
  const other = app.locator('.todo-task-row').filter({
    has: page.getByRole('button', { name: otherTitle, exact: true }),
  });
  await other.getByRole('checkbox', { name: '选择 ' + otherTitle, exact: true }).check();
  await expect(other.getByRole('checkbox')).toBeChecked();
  await expect(other).not.toHaveClass(/is-active/);
  await expect(occurrences.last().getByRole('checkbox')).not.toBeChecked();
});

test('plan and deadline labels keep an overdue deadline separate from tomorrow’s plan', async ({
  page,
}, info) => {
  const snapshot = await (await page.request.get('/api/to-doo/state')).json();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: snapshot.settings.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const tomorrow = dateAfter(today, 1),
    yesterday = dateAfter(today, -1);
  await page.clock.install({ time: new Date(today + 'T12:00:00Z') });
  const suffix = info.project.name + '-' + Date.now();
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '日期语义验证 ' + suffix, kind: 'list' },
  });
  const title = '计划与截止不同 ' + suffix;
  const sameTitle = '计划与截止相同 ' + suffix;
  const quietTitle = '没有日期 ' + suffix;
  await command(page, 'create_task', {
    title,
    listId: list.ids[0],
    plan: { date: tomorrow, time: '09:00', timeZone: snapshot.settings.timeZone },
    due: { date: yesterday, time: '17:00', timeZone: snapshot.settings.timeZone },
  });
  await command(page, 'create_task', {
    title: sameTitle,
    listId: list.ids[0],
    plan: { date: tomorrow, time: null, timeZone: snapshot.settings.timeZone },
    due: { date: tomorrow, time: null, timeZone: snapshot.settings.timeZone },
  });
  await command(page, 'create_task', { title: quietTitle, listId: list.ids[0] });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + list.ids[0]);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  const row = app.locator('.todo-task-row').filter({
    has: page.getByRole('button', { name: title, exact: true }),
  });
  const plan = row.locator('.todo-task-plan');
  const deadline = row.locator('.todo-task-deadline');
  await expect(plan).toContainText('计划');
  await expect(plan).toContainText('明天');
  await expect(plan).toContainText('09:00');
  await expect(plan).not.toHaveClass(/todo-danger/);
  await expect(plan).toHaveAttribute('aria-label', '计划 ' + tomorrow + ' 09:00');
  await expect(deadline).toContainText('截止');
  await expect(deadline).toContainText('昨天');
  await expect(deadline).toContainText('17:00');
  await expect(deadline).toHaveClass(/todo-danger/);
  await expect(deadline).toHaveAttribute('title', '截止 ' + yesterday + ' 17:00（已逾期）');
  await expect(deadline).toHaveAttribute('aria-label', '截止 ' + yesterday + ' 17:00（已逾期）');
  const sameRow = app.locator('.todo-task-row').filter({
    has: page.getByRole('button', { name: sameTitle, exact: true }),
  });
  await expect(sameRow.locator('.todo-task-date')).toHaveCount(1);
  await expect(sameRow.locator('.todo-task-date')).toContainText('计划 / 截止');
  const quietRow = app.locator('.todo-task-row').filter({
    has: page.getByRole('button', { name: quietTitle, exact: true }),
  });
  await expect(quietRow.getByRole('button', { name: quietTitle, exact: true })).toBeVisible();
  await expect(quietRow.locator('.todo-task-date')).toHaveCount(0);
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: info.outputPath('task-date-clarity.png'),
    animations: 'disabled',
    fullPage: true,
  });
});
