import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expectToDooSelection, selectToDooOption } from '../support/to-doo-ant-controls';
import { goToToDooSection } from '../support/to-doo-navigation';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function cancelActive(page: Page) {
  const active = (await (await page.request.get('/api/to-doo/focus/history?limit=1')).json())
    .active;
  if (active)
    await command(page, 'control_focus', {
      id: active.id,
      expectedRevision: active.revision,
      operation: 'cancel',
    });
}
async function taskState(page: Page, id: string) {
  return (
    await (await page.request.get('/api/to-doo/state?taskIds=' + id + '&includeTree=true')).json()
  ).occurrences.find((row: any) => row.taskId === id);
}
test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await cancelActive(page);
});

test('a task enters focus and finishing saves time before an explicit task completion', async ({
  page,
}, info) => {
  const title = '专心整理一份读书记录 ' + crypto.randomUUID().slice(0, 8);
  const created = await command(page, 'create_task', { title, initialStatus: 'doing' });
  const taskId = created.ids[0];
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&task=' + taskId);
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await detail.getByRole('button', { name: '专注', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('appSection')).toBe('focus');
  const timer = page.getByRole('region', { name: '专注计时器', exact: true });
  await expectToDooSelection(timer, '专注任务', title);
  const started = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.action === 'start_focus',
  );
  await timer.getByRole('button', { name: '开始专注', exact: true }).click();
  expect((await started).postDataJSON().payload.occurrenceId).toBe(
    created.snapshot.occurrences.find((row: any) => row.taskId === taskId).id,
  );
  await expect(timer.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await timer.getByRole('button', { name: '结束并保存', exact: true }).click();
  const followUp = page.getByRole('region', { name: '专注后的任务', exact: true });
  await expect(followUp).toContainText(title);
  expect((await taskState(page, taskId)).status).toBe('doing');
  await followUp.getByRole('button', { name: '查看任务', exact: true }).click();
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await followUp.getByRole('button', { name: '完成任务', exact: true }).click();
  await expect(followUp).toHaveCount(0);
  expect((await taskState(page, taskId)).status).toBe('done');
  await page.screenshot({
    path: info.outputPath('focus-task-completed.png'),
    animations: 'disabled',
  });
});

test('the first-screen task picker and free focus do not carry a previous task or project', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const title = '处理当前阅读任务 ' + suffix;
  const topic = '可选阅读项目 ' + suffix;
  const created = await command(page, 'create_task', { title });
  await command(page, 'save_entity', { kind: 'focusTopic', entity: { name: topic } });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&task=' + created.ids[0]);
  await page
    .getByRole('complementary', { name: '任务详情', exact: true })
    .getByRole('button', { name: '专注', exact: true })
    .click();
  const timer = page.getByRole('region', { name: '专注计时器', exact: true });
  await expectToDooSelection(timer, '专注任务', title);
  await goToToDooSection(page, 'tasks');
  await goToToDooSection(page, 'focus');
  await expectToDooSelection(timer, '专注任务', '不关联任务');
  await expect(timer).toContainText('自由专注');
  await selectToDooOption(timer, '专注任务', title);
  await page.getByRole('button', { name: '选择专注项目 ' + topic, exact: true }).click();
  await expect(timer).toContainText(topic);
  await page.getByRole('button', { name: '自由专注', exact: true }).click();
  await expectToDooSelection(timer, '专注任务', '不关联任务');
  await expect(timer).toContainText('自由专注');
  const request = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.action === 'start_focus',
  );
  await timer.getByRole('button', { name: '开始专注', exact: true }).click();
  expect((await request).postDataJSON().payload).toMatchObject({
    occurrenceId: null,
    topicId: null,
  });
  await expect(timer.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await timer.getByRole('button', { name: '取消本次', exact: true }).click();
  const cancellation = page.getByRole('dialog', { name: '取消本次专注', exact: true });
  await expect(cancellation).toBeVisible();
  await cancellation.getByRole('button', { name: '确认', exact: true }).click();
  await expect(cancellation).not.toBeVisible();
  await expect(timer.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
});

test('the task picker distinguishes the same task title in different lists before starting focus', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const title = '整理阅读资料 ' + suffix;
  const listA = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '工作阅读 ' + suffix, kind: 'list' },
  });
  const listB = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: '个人阅读 ' + suffix, kind: 'list' },
  });
  await command(page, 'create_task', { title, listId: listA.ids[0] });
  const second = await command(page, 'create_task', { title, listId: listB.ids[0] });
  const occurrence = second.snapshot.occurrences.find((row: any) => row.taskId === second.ids[0]);
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const timer = page.getByRole('region', { name: '专注计时器', exact: true });
  await selectToDooOption(timer, '专注任务', title + ' · 个人阅读 ' + suffix);
  const started = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/to-doo/commands') &&
      request.postDataJSON()?.action === 'start_focus',
  );
  await timer.getByRole('button', { name: '开始专注', exact: true }).click();
  expect((await started).postDataJSON().payload).toMatchObject({
    occurrenceId: occurrence.id,
    listId: listB.ids[0],
  });
  await expect(timer.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await timer.getByRole('button', { name: '取消本次', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '取消本次专注', exact: true });
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(timer.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
});
