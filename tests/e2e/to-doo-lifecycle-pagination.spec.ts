import { readFile } from 'node:fs/promises';
import type { ToDooCommandResult, ToDooSnapshot } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';
import { selectToDooQuickView } from '../support/to-doo-navigation';

test('trash and archive find and recover tasks after more than 200 live tasks', async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token };
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers, data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<ToDooCommandResult>;
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  const list = await command('save_entity', { kind: 'list', entity: { name: '分页恢复验证 ' + suffix } });
  const listId = list.ids[0];
  await command('import_entities', { entities: Array.from({ length: 205 }, (_, index) => ({
    kind: 'task', entity: { id: 'lifecycle-live-' + suffix + '-' + index, title: '在用任务 ' + index, listId },
  })) });
  const deletedTitle = '排在两百条之后的待恢复任务 ' + suffix;
  const archivedTitle = '排在两百条之后的已归档任务 ' + suffix;
  const deleted = await command('create_task', { title: deletedTitle, listId, initialStatus: 'doing' });
  const archived = await command('create_task', { title: archivedTitle, listId, initialStatus: 'done' });
  const deletedId = deleted.ids[0], archivedId = archived.ids[0];
  await command('delete_entity', { kind: 'task', id: deletedId,
    expectedRevision: deleted.changed.find(row => row.kind === 'task' && row.id === deletedId)!.revision });
  await command('update_task', { id: archivedId,
    expectedRevision: archived.changed.find(row => row.kind === 'task' && row.id === archivedId)!.revision,
    patch: { archivedAt: new Date().toISOString() } });
  const scopeResponse = (scope: 'trash' | 'archived') => page.waitForResponse(response => {
    const url = new URL(response.url());
    if (url.pathname !== '/api/to-doo/state') return false;
    try { return JSON.parse(url.searchParams.get('filter') || '{}').taskScope === scope; }
    catch { return false; }
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  await expect(page.locator('.todo-task-list-panel')).toBeVisible();
  const trashRead = scopeResponse('trash');
  await selectToDooQuickView(page, '回收站');
  const trash = await (await trashRead).json() as ToDooSnapshot;
  expect(trash.tasks.some(task => task.id === deletedId)).toBe(true);
  await expect(page.getByRole('button', { name: deletedTitle, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '任务操作 ' + deletedTitle, exact: true }).click();
  await page.getByRole('menuitem', { name: '恢复任务', exact: true }).click();
  await expect(page.getByRole('button', { name: deletedTitle, exact: true })).not.toBeVisible();

  const archiveRead = scopeResponse('archived');
  await selectToDooQuickView(page, '已归档');
  const archive = await (await archiveRead).json() as ToDooSnapshot;
  expect(archive.tasks.some(task => task.id === archivedId)).toBe(true);
  await expect(page.getByRole('button', { name: archivedTitle, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '任务操作 ' + archivedTitle, exact: true }).click();
  await page.getByRole('menuitem', { name: '取消归档', exact: true }).click();
  await expect(page.getByRole('button', { name: archivedTitle, exact: true })).not.toBeVisible();

  const restored = await page.request.get('/api/to-doo/state?' + new URLSearchParams({
    taskIds: [deletedId, archivedId].join(','), limit: '20',
  }));
  expect(restored.ok()).toBe(true);
  const data = await restored.json() as ToDooSnapshot;
  expect(data.tasks).toHaveLength(2);
  expect(data.tasks.every(task => task.deletedAt === null && task.archivedAt === null && task.listId === listId)).toBe(true);
  expect(data.occurrences.find(row => row.taskId === deletedId)?.status).toBe('doing');
  expect(data.occurrences.find(row => row.taskId === archivedId)?.status).toBe('done');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});
