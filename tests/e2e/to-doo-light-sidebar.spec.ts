import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { ToDooCommandResult, ToDooSnapshot } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';
import { fillToDooDate } from '../support/to-doo-ant-controls';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: {
      origin: `http://127.0.0.1:${process.env.DOOKNOW_E2E_WEB_PORT || 4179}`,
      'x-csrf-token': csrf.token,
    },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as ToDooCommandResult;
}

async function taskState(page: Page, taskId: string) {
  const response = await page.request.get('/api/to-doo/state?taskIds=' + taskId);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ToDooSnapshot;
}

function commandResponse(page: Page, action: string, id: string) {
  return page.waitForResponse((response) => {
    if (response.request().method() !== 'POST' || !response.url().endsWith('/api/to-doo/commands'))
      return false;
    const body = response.request().postDataJSON();
    return body.action === action && (body.payload.id === id || body.payload.entity?.id === id);
  });
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('a clean narrow dark task shows its content and date summary without edit controls', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const initial = (await (await page.request.get('/api/to-doo/state')).json()) as ToDooSnapshot;
  const title = '在轻量侧栏中完整阅读这份较长的任务标题，并保留清晰的完成入口 ' + info.project.name;
  const created = await command(page, 'create_task', {
    title,
    description: '先阅读任务说明，再决定是否修改。',
    due: { date: '2031-04-17', time: '17:45', timeZone: initial.settings.timeZone },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + created.ids[0]);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(
    '先阅读任务说明，再决定是否修改。',
  );
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).not.toBeVisible();
  await expect(detail.getByLabel('截止日期', { exact: true })).not.toBeVisible();
  await expect(detail.getByLabel('截止时间', { exact: true })).not.toBeVisible();
  await expect(detail.getByRole('button', { name: '编辑截止日期', exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: '编辑截止日期', exact: true })).toContainText(
    '2031年4月17日 17:45',
  );
  await expect(
    detail.getByRole('button', { name: '编辑截止日期', exact: true }),
  ).toHaveAccessibleDescription(/4月17日 17:45/);
  await expect(detail.getByRole('button', { name: '标记完成', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('light-sidebar-320-dark.png'), fullPage: true });
});

test('explicit save preserves failed title and description edits and retries the same submission', async ({
  page,
}, info) => {
  const title = '手动保存 ' + info.project.name + '-' + crypto.randomUUID();
  const created = await command(page, 'create_task', { title, description: '原说明' });
  const taskId = created.ids[0];
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + taskId);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
  const save = detail.getByRole('button', { name: '保存任务', exact: true });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expect(save).not.toBeVisible();
  const nextTitle = title + ' 已修改';
  const description = '保存失败时保留这段说明。\n重试后也要完整保存。';
  await detail.getByLabel('任务标题', { exact: true }).fill(nextTitle);
  await detail.getByLabel('任务说明', { exact: true }).fill(description);
  await expect(save).toBeVisible();
  expect((await taskState(page, taskId)).tasks.find((task) => task.id === taskId)).toMatchObject({
    title,
    description: '原说明',
  });

  await page.route(
    '**/api/to-doo/commands',
    (route) => route.fulfill({ status: 503, json: { error: '侧栏保存暂时不可用，请重试' } }),
    { times: 1 },
  );
  const rejected = commandResponse(page, 'update_task', taskId);
  await save.click();
  const failed = await rejected;
  expect(failed.status()).toBe(503);
  await expect(app.getByRole('alert')).toContainText('侧栏保存暂时不可用');
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(nextTitle);
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(description);
  await expect(detail).toContainText('未保存的更改');
  await expect(save).toBeVisible();
  expect((await taskState(page, taskId)).tasks.find((task) => task.id === taskId)).toMatchObject({
    title,
    description: '原说明',
  });

  const saved = commandResponse(page, 'update_task', taskId);
  await save.click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON().requestId).toBe(
    failed.request().postDataJSON().requestId,
  );
  const receipt = (await response.json()) as ToDooCommandResult;
  expect(receipt.snapshot.tasks.find((task) => task.id === taskId)).toMatchObject({
    title: nextTitle,
    description,
  });
  await expect(app.getByRole('status')).toContainText('任务已保存');
  await expect(save).not.toBeVisible();
  await page.reload();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(nextTitle);
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(description);
  await expect(save).not.toBeVisible();
});

test('deadline editing updates the summary and stays closed after reopening or changing tasks', async ({
  page,
}, info) => {
  const suffix = info.project.name + '-' + crypto.randomUUID();
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '侧栏日期 ' + suffix, kind: 'list' },
  });
  const title = '调整截止时间 ' + suffix;
  const created = await command(page, 'create_task', { title, listId: list.ids[0] });
  const otherTitle = '保留阅读状态 ' + suffix;
  await command(page, 'create_task', { title: otherTitle, listId: list.ids[0] });
  const taskId = created.ids[0];
  const occurrenceId = created.snapshot.occurrences.find((item) => item.taskId === taskId)!.id;
  await page.goto(
    '/?view=apps&app=to-doo&appSection=tasks&list=' + list.ids[0] + '&task=' + taskId,
  );
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
  await detail.getByRole('button', { name: '添加属性', exact: true }).click();
  await page.getByRole('button', { name: '设置日期', exact: true }).click();
  await fillToDooDate(detail.getByLabel('截止日期', { exact: true }), '2031-04-19');
  await fillToDooDate(detail.getByLabel('截止时间', { exact: true }), '14:35');
  const saved = commandResponse(page, 'save_entity', occurrenceId);
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const receipt = (await response.json()) as ToDooCommandResult;
  expect(receipt.snapshot.occurrences.find((item) => item.id === occurrenceId)?.due).toMatchObject({
    date: '2031-04-19',
    time: '14:35',
  });
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).not.toBeVisible();
  await expect(detail.getByRole('button', { name: '编辑截止日期', exact: true })).toContainText(
    '2031年4月19日 14:35',
  );
  expect(
    (await taskState(page, taskId)).occurrences.find((item) => item.id === occurrenceId)?.due,
  ).toMatchObject({
    date: '2031-04-19',
    time: '14:35',
  });

  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await app.getByRole('button', { name: title, exact: true }).click();
  await expect(detail.getByLabel('截止日期', { exact: true })).not.toBeVisible();
  await expect(detail.getByRole('button', { name: '编辑截止日期', exact: true })).toContainText(
    '2031年4月19日 14:35',
  );
  await detail.getByRole('button', { name: '编辑截止日期', exact: true }).click();
  await expect(detail.getByLabel('截止日期', { exact: true })).toBeVisible();
  if (info.project.name === 'mobile')
    await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await app.getByRole('button', { name: otherTitle, exact: true }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(otherTitle);
  await expect(detail.getByLabel('截止日期', { exact: true })).not.toBeVisible();
  await expect(detail.getByLabel('截止时间', { exact: true })).not.toBeVisible();
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).not.toBeVisible();
});

test('title completion preserves an unsaved description and saving it keeps the task completed', async ({
  page,
}, info) => {
  const title = '保留完成时的草稿 ' + info.project.name + '-' + crypto.randomUUID();
  const created = await command(page, 'create_task', { title, description: '原说明' });
  const taskId = created.ids[0];
  const occurrenceId = created.snapshot.occurrences.find((item) => item.taskId === taskId)!.id;
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + taskId);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
  const description = '完成任务也要保留尚未保存的说明。';
  await detail.getByLabel('任务说明', { exact: true }).fill(description);
  const completed = commandResponse(page, 'set_occurrence_status', occurrenceId);
  await detail.getByRole('button', { name: '标记完成', exact: true }).click();
  const completion = await completed;
  expect(completion.ok()).toBe(true);
  const completionReceipt = (await completion.json()) as ToDooCommandResult;
  expect(
    completionReceipt.snapshot.occurrences.find((item) => item.id === occurrenceId)?.status,
  ).toBe('done');
  expect(completionReceipt.snapshot.tasks.find((task) => task.id === taskId)?.description).toBe(
    '原说明',
  );
  await expect(detail.getByRole('button', { name: '重新打开', exact: true })).toBeVisible();
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(description);
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeVisible();

  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  const showCompleted = app.getByRole('button', { name: '显示已完成任务', exact: true });
  if (await showCompleted.isVisible()) await showCompleted.click();
  await app.getByRole('button', { name: title, exact: true }).click();
  await expect(detail.getByLabel('任务说明', { exact: true })).toHaveValue(description);
  const saved = commandResponse(page, 'update_task', taskId);
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).not.toBeVisible();
  let state = await taskState(page, taskId);
  expect(state.tasks.find((task) => task.id === taskId)?.description).toBe(description);
  expect(state.occurrences.find((item) => item.id === occurrenceId)?.status).toBe('done');

  const reopened = commandResponse(page, 'set_occurrence_status', occurrenceId);
  await detail.getByRole('button', { name: '重新打开', exact: true }).click();
  expect((await reopened).ok()).toBe(true);
  await expect(detail.getByRole('button', { name: '标记完成', exact: true })).toBeVisible();
  state = await taskState(page, taskId);
  expect(state.occurrences.find((item) => item.id === occurrenceId)?.status).toBe('todo');
  expect(state.tasks.find((task) => task.id === taskId)?.description).toBe(description);
});
