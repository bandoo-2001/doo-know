import { readFile } from 'node:fs/promises';
import type { ToDooCommandResult, ToDooSnapshot } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';
import { fillToDooDate, expectToDooSelection } from '../support/to-doo-ant-controls';
import { completeToDooDetailProperty, openToDooDetailProperty, setToDooDetailPlanDate } from '../support/to-doo-detail-controls';

test('selected task keeps its execution after a bounded save beyond 500 background executions and 205 list tasks', async ({ page, context }, info) => {
  test.setTimeout(180_000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize(info.project.name === 'mobile'
    ? { width: 390, height: 844 } : { width: 1920, height: 1080 });
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token };
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers, data: { requestId: crypto.randomUUID(), action, payload }, timeout: 90_000,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<ToDooCommandResult>;
  }
  async function exact(id: string) {
    const response = await page.request.get('/api/to-doo/state?taskIds=' + id + '&includeTree=true');
    expect(response.ok()).toBe(true);
    return response.json() as Promise<ToDooSnapshot>;
  }
  const prefix = 'context-' + info.project.name + '-' + crypto.randomUUID().slice(0, 8);
  const background = await command('create_task', { title: prefix + ' background seed' });
  const backgroundState = await exact(background.ids[0]);
  const backgroundTask = backgroundState.tasks.find(row => row.id === background.ids[0])!;
  const backgroundOccurrence = backgroundState.occurrences.find(row => row.taskId === backgroundTask.id)!;
  await command('import_entities', { entities: Array.from({ length: 519 }, (_, index) => {
    const id = prefix + '-background-' + index;
    return [{ kind: 'task', entity: { ...backgroundTask, id, title: id } },
      { kind: 'occurrence', entity: { ...backgroundOccurrence, id: id + '-once', taskId: id } }];
  }).flat() });
  const list = await command('save_entity', { kind: 'list', entity: { name: '执行上下文分页 ' + prefix } });
  const listId = list.ids[0];
  const first = await command('create_task', { title: prefix + ' item 001', listId });
  const state = await exact(first.ids[0]);
  const task = state.tasks.find(row => row.id === first.ids[0])!;
  const occurrence = state.occurrences.find(row => row.taskId === task.id)!;
  const targetId = prefix + '-item-205', targetOccurrenceId = targetId + '-once';
  await command('import_entities', { entities: Array.from({ length: 204 }, (_, index) => {
    const number = index + 2, id = prefix + '-item-' + number;
    return [{ kind: 'task', entity: { ...task, id, title: id, orderKey: 'item-' + String(number).padStart(3, '0') } },
      { kind: 'occurrence', entity: { ...occurrence, id: id + '-once', taskId: id,
        due: number === 205 ? { date: '2030-12-31', time: '17:45', timeZone: state.settings.timeZone } : null } }];
  }).flat() });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&list=' + listId);
  await expect(page.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
  const target = page.getByRole('button', { name: targetId, exact: true });
  await target.scrollIntoViewIfNeeded();
  await target.click();
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(targetId);
  for (const name of ['编辑计划日期', '编辑截止日期', '标记完成', '专注'])
    await expect(detail.getByRole('button', { name, exact: true })).toBeEnabled();
  const title = targetId + ' renamed';
  await detail.getByLabel('任务标题', { exact: true }).fill(title);
  const reply = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/to-doo/commands' &&
    response.request().postDataJSON().action === 'update_task' &&
    response.request().postDataJSON().payload.id === targetId);
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  const receipt = await (await reply).json() as ToDooCommandResult;
  expect(receipt.snapshot.occurrences.some(row => row.id === targetOccurrenceId)).toBe(false);
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeDisabled();
  for (const name of ['编辑计划日期', '编辑截止日期', '标记完成', '专注'])
    await expect(detail.getByRole('button', { name, exact: true })).toBeEnabled();
  const due = await openToDooDetailProperty(page, 'due');
  await fillToDooDate(due.getByLabel('截止日期', { exact: true }), '2031-01-02');
  await completeToDooDetailProperty(page);
  await setToDooDetailPlanDate(page, '2030-12-30');
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeDisabled();
  let stored = await exact(targetId);
  expect(stored.tasks.find(row => row.id === targetId)).toMatchObject({ title, listId });
  expect(stored.occurrences.find(row => row.id === targetOccurrenceId)).toMatchObject({
    taskId: targetId, status: 'todo', due: { date: '2031-01-02', time: '17:45' },
  });
  expect(stored.timeBlocks.some(row => row.occurrenceId === targetOccurrenceId && row.start.date === '2030-12-30')).toBe(true);
  await detail.getByRole('button', { name: '专注', exact: true }).click();
  const timer = page.getByRole('region', { name: '专注计时器', exact: true });
  await expectToDooSelection(timer, '专注任务', title + ' · 执行上下文分页 ' + prefix);
  const start = page.waitForRequest(request => request.method() === 'POST' &&
    request.url().endsWith('/api/to-doo/commands') && request.postDataJSON().action === 'start_focus');
  await timer.getByRole('button', { name: '开始专注', exact: true }).click();
  expect((await start).postDataJSON().payload.occurrenceId).toBe(targetOccurrenceId);
  await timer.getByRole('button', { name: '结束并保存', exact: true }).click();
  const followUp = page.getByRole('region', { name: '专注后的任务', exact: true });
  await followUp.getByRole('button', { name: '查看任务', exact: true }).click();
  const completion = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/to-doo/commands' &&
    response.request().postDataJSON().action === 'set_occurrence_status' &&
    response.request().postDataJSON().payload.id === targetOccurrenceId);
  await detail.getByRole('button', { name: '标记完成', exact: true }).click();
  const acknowledgement = await completion;
  expect(acknowledgement.ok()).toBe(true);
  expect((await acknowledgement.json()).changed.some((row: { kind: string; id: string }) =>
    row.kind === 'occurrence' && row.id === targetOccurrenceId)).toBe(true);
  await expect(detail.getByRole('button', { name: '重新打开', exact: true })).toBeEnabled();
  stored = await exact(targetId);
  expect(stored.occurrences.find(row => row.id === targetOccurrenceId)?.status).toBe('done');
  expect(stored.tasks.find(row => row.id === targetId)).toMatchObject({ title, listId });
  await page.screenshot({ path: info.outputPath('selected-context-overflow.png'), animations: 'disabled' });
});
