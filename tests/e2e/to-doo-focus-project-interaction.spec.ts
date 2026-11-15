import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { ToDooCommandResult, ToDooFocusHistory } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const token = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': token.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as ToDooCommandResult;
}

async function activity(page: Page) {
  const response = await page.request.get('/api/to-doo/focus/history?limit=1');
  expect(response.ok()).toBe(true);
  return await response.json() as ToDooFocusHistory;
}

const focusUrl = '/?view=apps&app=to-doo&appSection=focus';
const timer = (page: Page) => page.getByRole('region', { name: '专注计时器', exact: true });
const play = (page: Page, name: string) => page.getByRole('button', { name: '开始项目专注 ' + name, exact: true });

async function topic(page: Page, archived = false) {
  const name = '行内专注 ' + crypto.randomUUID().slice(0, 8);
  const result = await command(page, 'save_entity', {
    kind: 'focusTopic', entity: { name, archivedAt: archived ? new Date().toISOString() : null },
  });
  return { id: result.ids[0]!, name };
}

async function settings(page: Page, mode: string, minutes?: string) {
  await timer(page).getByRole('button', { name: '计时设置', exact: true }).click();
  const fields = page.locator('.todo-focus-timer-fields:visible');
  await fields.getByText(mode, { exact: true }).click();
  if (minutes !== undefined) await fields.getByRole('spinbutton', { name: '本次时长', exact: true }).fill(minutes);
  await page.getByRole('button', { name: '收起计时设置', exact: true }).click();
}

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  // The isolated browser fixture shares one owner with the other timer scenarios.
  for (let session = (await activity(page)).active; session; session = (await activity(page)).active)
    await command(page, 'control_focus', { id: session.id, expectedRevision: session.revision, operation: 'cancel' });
});

test('one project play starts the chosen timer mode with the linked task and preserves the session through pause', async ({ page }) => {
  const project = await topic(page);
  const title = '行内计时的关联任务 ' + crypto.randomUUID().slice(0, 8);
  const task = await command(page, 'create_task', { title });
  const taskId = task.ids[0]!;
  const snapshot = await (await page.request.get('/api/to-doo/state?taskIds=' + taskId + '&includeTree=true')).json();
  const occurrence = snapshot.occurrences.find((row: { taskId: string }) => row.taskId === taskId);
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&task=' + taskId);
  await page.getByRole('complementary', { name: '任务详情', exact: true }).getByRole('button', { name: '专注', exact: true }).click();
  await settings(page, '正计时');
  const requested = page.waitForRequest(r => new URL(r.url()).pathname === '/api/to-doo/commands' && r.postDataJSON()?.action === 'start_focus');
  await play(page, project.name).press('Enter');
  expect((await requested).postDataJSON().payload).toMatchObject({
    mode: 'stopwatch', targetMinutes: null, topicId: project.id, occurrenceId: occurrence.id, requireIdle: true,
  });
  await expect(timer(page)).toContainText(title);
  await expect(timer(page).getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect(play(page, project.name)).toHaveCount(0);
  const running = (await activity(page)).active!;
  expect(running).toMatchObject({ status: 'running', topicId: project.id, occurrenceId: occurrence.id });
  await timer(page).getByRole('button', { name: '暂停', exact: true }).click();
  await expect(timer(page).getByRole('button', { name: '继续', exact: true })).toBeVisible();
  await expect(play(page, project.name)).toHaveCount(0);
  expect((await activity(page)).active).toMatchObject({ id: running.id, status: 'paused' });
  await timer(page).getByRole('button', { name: '结束并保存', exact: true }).click();
  await expect(page.getByRole('region', { name: '专注后的任务' })).toContainText(title);
  expect((await activity(page)).active).toBeNull();
});

test('breaks and archived projects have no play button, and an unconfirmed start blocks other projects', async ({ page }) => {
  const project = await topic(page);
  const other = await topic(page);
  const archived = await topic(page, true);
  const starts: Record<string, unknown>[] = [];
  page.on('request', r => {
    if (new URL(r.url()).pathname === '/api/to-doo/commands' && r.postDataJSON()?.action === 'start_focus')
      starts.push(r.postDataJSON().payload);
  });
  await page.goto(focusUrl);
  await expect(play(page, project.name)).toBeEnabled();
  await settings(page, '休息');
  await expect(play(page, project.name)).toHaveCount(0);
  await settings(page, '番茄钟', '');
  await play(page, project.name).click();
  await expect(page.getByRole('alert').filter({ hasText: '请输入 1 到 1440 分钟的专注时长' })).toBeVisible();
  expect(starts).toEqual([]);
  await settings(page, '番茄钟', '17');
  const menu = page.getByRole('button', { name: '专注项目更多', exact: true });
  await menu.click();
  await page.getByRole('menuitem', { name: '已归档项目', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择专注项目 ' + archived.name, exact: true })).toBeVisible();
  await expect(play(page, archived.name)).toHaveCount(0);
  await menu.click();
  await page.getByRole('menuitem', { name: '进行中项目', exact: true }).click();
  await page.route('**/api/to-doo/commands', route => route.abort('failed'), { times: 1 });
  await play(page, project.name).click();
  await expect(page.getByRole('button', { name: '重试原操作', exact: true })).toBeVisible();
  await expect(play(page, project.name)).toBeDisabled();
  await expect(play(page, other.name)).toBeDisabled();
  await expect(timer(page).getByRole('button', { name: '开始专注', exact: true })).toBeDisabled();
  expect(starts).toEqual([expect.objectContaining({ mode: 'pomodoro', targetMinutes: 17, topicId: project.id })]);
  expect((await activity(page)).active).toBeNull();
});

test('a project play from a stale tab refreshes a remotely paused session without replacing it', async ({ page }) => {
  const original = await topic(page);
  const next = await topic(page);
  const idle = await activity(page);
  let showIdle = true;
  await page.route('**/api/to-doo/focus/history?**', route =>
    showIdle ? route.fulfill({ json: idle }) : route.continue());
  page.on('request', r => {
    if (new URL(r.url()).pathname === '/api/to-doo/commands' && r.postDataJSON()?.action === 'start_focus') showIdle = false;
  });
  await page.goto(focusUrl);
  await expect(play(page, next.name)).toBeEnabled();
  await command(page, 'start_focus', { mode: 'stopwatch', topicId: original.id });
  const running = (await activity(page)).active!;
  await command(page, 'control_focus', { id: running.id, expectedRevision: running.revision, operation: 'pause' });
  const paused = await activity(page);
  try {
    const rejected = page.waitForResponse(r => new URL(r.url()).pathname === '/api/to-doo/commands');
    await play(page, next.name).click();
    expect((await rejected).status()).toBe(409);
    await expect(timer(page).getByRole('button', { name: '继续', exact: true })).toBeVisible();
    await expect(timer(page)).toContainText(original.name);
    await expect(play(page, next.name)).toHaveCount(0);
    const after = await activity(page);
    expect(after.active).toEqual(paused.active);
    expect(after.page.total).toBe(paused.page.total);
  } finally {
    const originalSession = paused.active!;
    await command(page, 'control_focus', { id: originalSession.id, expectedRevision: originalSession.revision, operation: 'cancel' });
  }
});
