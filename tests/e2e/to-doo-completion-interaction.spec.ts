import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { type ToDooCommandResult, type ToDooSnapshot, toDooEntitySchemas } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const reply = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(reply.ok(), await reply.text()).toBe(true);
  return await reply.json() as ToDooCommandResult;
}

test('undo stays in view after completing the last row and stays available while hovered or focused', async ({ page, context }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize(info.project.name === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 812 });
  const prefix = 'scroll-undo-' + crypto.randomUUID().slice(0, 8);
  const listId = (await command(page, 'save_entity', { kind: 'list', entity: { name: '可撤销的长清单 ' + prefix } })).ids[0]!;
  const seedId = (await command(page, 'create_task', { title: prefix + '-00', listId })).ids[0]!;
  const seed = await (await page.request.get('/api/to-doo/state?taskIds=' + seedId + '&includeTree=true')).json() as ToDooSnapshot;
  const task = seed.tasks.find(t => t.id === seedId)!;
  const occurrence = seed.occurrences.find(o => o.taskId === seedId)!;
  const executionByTitle = new Map([[task.title, occurrence.id]]);
  // Even at compact density the list must extend by more than a full main viewport.
  const entities = Array.from({ length: 47 }, (_, i) => {
    const key = prefix + '-' + String(i + 1).padStart(2, '0');
    const entry = toDooEntitySchemas.task.parse({ ...task, id: key, title: key, orderKey: key });
    const execution = toDooEntitySchemas.occurrence.parse({ ...occurrence, id: key + '-execution', taskId: key, scheduleRevision: crypto.randomUUID() });
    executionByTitle.set(entry.title, execution.id);
    return [{ kind: 'task', entity: entry }, { kind: 'occurrence', entity: execution }];
  }).flat();
  expect((await command(page, 'import_entities', { entities })).ids).toHaveLength(entities.length);
  async function readExecutions() {
    const query = new URLSearchParams({ kind: 'occurrence', ids: [...executionByTitle.values()].join(','), limit: '100' });
    const result = await page.request.get('/api/to-doo/state?' + query);
    expect(result.ok()).toBe(true);
    const entries = (await result.json() as ToDooSnapshot).occurrences;
    expect(entries).toHaveLength(executionByTitle.size);
    return entries;
  }
  const before = await readExecutions();
  const writes: { action: string; payload: { id?: string; status?: string } }[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/to-doo/commands')
      writes.push(request.postDataJSON());
  });
  await page.clock.install();
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&list=' + listId);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  const rows = app.locator('.todo-task-row');
  await expect(rows).toHaveCount(executionByTitle.size);
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  const scrolledPastFirstScreen = () => app.locator('.todo-main').evaluate(el => el.scrollTop > el.clientHeight);
  expect(await scrolledPastFirstScreen()).toBe(true);
  const title = (await last.locator('.todo-task-body').getAttribute('aria-label'))!;
  const target = executionByTitle.get(title)!;
  await last.getByRole('button', { name: '完成 ' + title, exact: true }).click();
  const feedback = page.getByRole('status').filter({ hasText: '已完成「' + title + '」' });
  const undo = feedback.getByRole('button', { name: '撤销', exact: true });
  // Assert visibility before any click, focus or hover can scroll the page to the toast.
  await expect(undo).toBeInViewport({ ratio: 1 });
  expect(await scrolledPastFirstScreen()).toBe(true);
  expect(await undo.evaluate(el => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  })).toBe(true);
  const completed = await readExecutions();
  expect(completed.find(o => o.id === target)?.status).toBe('done');
  await undo.hover();
  await page.clock.fastForward(7000);
  await expect(undo).toBeVisible();
  await undo.focus();
  await page.mouse.move(2, 2);
  await page.clock.fastForward(7000);
  await expect(undo).toBeFocused();
  await undo.hover();
  await undo.blur();
  await page.clock.fastForward(7000);
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(feedback).toBeHidden();
  await expect(rows).toHaveCount(executionByTitle.size);
  const restored = await readExecutions();
  expect(restored.find(o => o.id === target)?.status).toBe(before.find(o => o.id === target)?.status);
  for (const other of before.filter(o => o.id !== target)) {
    expect(completed.find(o => o.id === other.id)).toEqual(other);
    expect(restored.find(o => o.id === other.id)).toEqual(other);
  }
  expect(writes.map(({ action, payload }) => [action, payload.id, payload.status])).toEqual([
    ['set_occurrence_status', target, 'done'], ['set_occurrence_status', target, 'todo'],
  ]);
});
