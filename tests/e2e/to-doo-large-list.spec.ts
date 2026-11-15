import { readFile } from 'node:fs/promises';
import type { Page, Response } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { toDooEntitySchemas, type ToDooSnapshot } from '../../shared/to-doo-contracts';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    timeout: 90000,
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function stateQuery(response: Response) {
  const url = new URL(response.url());
  return response.request().method() === 'GET' && url.pathname === '/api/to-doo/state'
    ? url.searchParams
    : null;
}

test('a 205-task list keeps real pagination, complete rows and editable long-title tasks on both layouts', async ({ page }, info) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 1080, height: 812 });
  const prefix = 'large-' + info.project.name + '-' + crypto.randomUUID().slice(0, 8);
  const list = await command(page, 'save_entity', {
    kind: 'list', entity: { name: '205条任务分页验收 ' + prefix, kind: 'list' },
  });
  const listId = list.ids[0];
  const titleFor = (number: number) => number === 205
    ? `${prefix} 第205条 长标题仍需完整读取：` + '核对分页末尾的任务说明与完成结果。'.repeat(7)
    : `${prefix} 第${String(number).padStart(3, '0')}条`;
  const seed = await command(page, 'create_task', { title: titleFor(1), listId });
  const seedState = await (await page.request.get('/api/to-doo/state?taskIds=' + seed.ids[0] + '&includeTree=true')).json() as ToDooSnapshot;
  const seedTask = seedState.tasks.find(task => task.id === seed.ids[0])!;
  const seedOccurrence = seedState.occurrences.find(occurrence => occurrence.taskId === seedTask.id)!;
  expect(seedOccurrence.status).toBe('todo');
  const entities = Array.from({ length: 204 }, (_, offset) => {
    const number = offset + 2, taskId = prefix + '-task-' + number;
    return [
      { kind: 'task', entity: toDooEntitySchemas.task.parse({
        ...seedTask, id: taskId, title: titleFor(number), orderKey: 'bulk-' + String(number).padStart(3, '0'),
        priority: number === 205 ? 'high' : 'none',
      }) },
      { kind: 'occurrence', entity: toDooEntitySchemas.occurrence.parse({
        ...seedOccurrence, id: prefix + '-execution-' + number, taskId,
        scheduleRevision: crypto.randomUUID(),
        due: number === 205 ? { date: '2030-12-31', time: '17:45', timeZone: seedState.settings.timeZone } : null,
      }) },
    ];
  }).flat();
  const imported = await command(page, 'import_entities', { entities });
  expect(imported.ids).toHaveLength(408);
  const lastTaskId = prefix + '-task-205', lastOccurrenceId = prefix + '-execution-205';
  const allTaskIds = [seedTask.id, ...Array.from({ length: 204 }, (_, offset) => prefix + '-task-' + (offset + 2))];
  const taskIds = new Set(allTaskIds);
  const firstRead = page.waitForResponse(response => {
    const query = stateQuery(response);
    return !!query && query.get('view') === 'tasks' && !query.has('kind') && !query.has('cursor') &&
      JSON.parse(query.get('filter') || '{}').listIds?.includes(listId) === true;
  });
  // The mixed workset returns up to 500 executions. The client resolves task
  // definitions missing from its first 200-row task page through a real GET.
  const hydrationRead = page.waitForResponse(response => {
    const query = stateQuery(response);
    return !!query && query.get('kind') === 'task' &&
      !!query.get('ids') && (query.get('ids') || '').split(',').every(id => taskIds.has(id));
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&list=' + listId);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app).toBeVisible({ timeout: 20000 });
  await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false');
  const first = await (await firstRead).json() as ToDooSnapshot;
  expect(first.tasks).toHaveLength(200);
  expect(first.collectionPages?.task).toMatchObject({ total: 205, limit: 200, truncated: true });
  const cursor = first.collectionPages!.task!.nextCursor;
  expect(cursor).toEqual(expect.any(String));
  expect(first.occurrences).toHaveLength(205);
  const initialTaskIds = new Set(first.tasks.map(task => task.id));
  const remainingTaskIds = allTaskIds.filter(id => !initialTaskIds.has(id)).sort();
  expect(remainingTaskIds).toHaveLength(5);
  const hydrated = await (await hydrationRead).json() as ToDooSnapshot;
  expect(hydrated.tasks.map(task => task.id).sort()).toEqual(remainingTaskIds);
  const rows = app.locator('.todo-task-row');
  await expect(rows).toHaveCount(205);
  const expectedTitles = Array.from({ length: 205 }, (_, index) => titleFor(index + 1)).sort();
  expect((await rows.locator('.todo-task-body').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')!))).sort()).toEqual(expectedTitles);

  const continuation = app.getByRole('button', { name: '继续载入任务', exact: true });
  await expect(continuation).toBeVisible();
  const nextRead = page.waitForResponse(response => {
    const query = stateQuery(response);
    return !!query && query.get('kind') === 'task' && query.get('cursor') === cursor;
  });
  await continuation.click();
  const next = await (await nextRead).json() as ToDooSnapshot;
  expect(next.tasks).toHaveLength(5);
  expect(next.tasks.map(task => task.id).sort()).toEqual(remainingTaskIds);
  expect(next.collectionPages?.task).toMatchObject({ total: 205, nextCursor: null, truncated: false });
  await expect(continuation).toHaveCount(0);
  await expect(rows).toHaveCount(205);
  expect((await rows.locator('.todo-task-body').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')!))).sort()).toEqual(expectedTitles);

  const lastTitle = titleFor(205);
  expect(lastTitle.length).toBeLessThanOrEqual(256);
  await expect(rows.last().locator('.todo-task-body')).toHaveAttribute('aria-label', lastTitle);
  const last = rows.filter({ has: page.getByRole('button', { name: lastTitle, exact: true }) });
  for (const size of [{ width: 1080, height: 812 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await last.scrollIntoViewIfNeeded();
    await expect(last.getByRole('button', { name: lastTitle, exact: true })).toHaveAttribute('aria-label', lastTitle);
    await expect(last.getByRole('button', { name: '完成 ' + lastTitle, exact: true })).toBeEnabled();
    await expect(last.getByText('高优先级', { exact: true })).toBeInViewport();
    const deadline = last.locator('.todo-task-deadline');
    await expect(deadline).toHaveAttribute('aria-label', '截止 2030-12-31 17:45');
    await expect(deadline).toBeInViewport();
    const bounds = (await last.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`large-list-${size.width}.png`), animations: 'disabled' });
  }
  await last.getByRole('button', { name: lastTitle, exact: true }).click();
  const detail = app.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(lastTitle);
  const changedTitle = lastTitle + ' 已核对保存';
  await detail.getByLabel('任务标题', { exact: true }).fill(changedTitle);
  const saveReply = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/to-doo/commands' &&
    response.request().postDataJSON().action === 'update_task' &&
    response.request().postDataJSON().payload.id === lastTaskId);
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  expect((await saveReply).ok()).toBe(true);
  await expect(detail.getByRole('button', { name: '保存任务', exact: true })).toBeDisabled();
  let stored = await (await page.request.get('/api/to-doo/state?taskIds=' + lastTaskId + '&includeTree=true')).json() as ToDooSnapshot;
  expect(stored.tasks.find(task => task.id === lastTaskId)).toMatchObject({ title: changedTitle, listId, priority: 'high' });
  expect(stored.occurrences.find(occurrence => occurrence.id === lastOccurrenceId)).toMatchObject({ status: 'todo', due: { date: '2030-12-31', time: '17:45' } });
  const completionReply = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/to-doo/commands' &&
    response.request().postDataJSON().action === 'set_occurrence_status' &&
    response.request().postDataJSON().payload.id === lastOccurrenceId);
  await detail.getByRole('button', { name: '标记完成', exact: true }).click();
  expect((await completionReply).ok()).toBe(true);
  stored = await (await page.request.get('/api/to-doo/state?taskIds=' + lastTaskId + '&includeTree=true')).json() as ToDooSnapshot;
  expect(stored.occurrences.find(occurrence => occurrence.id === lastOccurrenceId)?.status).toBe('done');
});
