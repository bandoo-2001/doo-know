import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { fillToDooDate, selectToDooOption } from '../support/to-doo-ant-controls';
import { openToDooDirectory, revealToDooTask } from '../support/to-doo-navigation';
import { openToDooDetailProperty } from '../support/to-doo-detail-controls';
import type { ToDooCommandResult, ToDooSnapshot } from '../../shared/to-doo-contracts';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as ToDooCommandResult;
}
async function snapshot(page: Page, taskId: string) {
  const response = await page.request.get('/api/to-doo/state?taskIds=' + taskId +
    '&includeTree=true&limit=500&filter=' + encodeURIComponent(JSON.stringify({ includeDeleted: true, includeArchived: true })));
  expect(response.ok()).toBe(true);
  return await response.json() as ToDooSnapshot;
}
const detail = (page: Page) => page.getByRole('complementary', { name: '任务详情', exact: true });
async function open(page: Page, id: string) {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + id);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
  await expect(app).toBeVisible({ timeout: 20000 });
  await expect(app.locator('.todo-main')).toHaveAttribute('aria-busy', 'false', { timeout: 20000 });
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toBeVisible({ timeout: 20000 });
}
async function save(page: Page) {
  const button = detail(page).getByRole('button', { name: '保存任务', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await detail(page).locator('.todo-detail-save .ant-btn-loading-icon').waitFor({ state: 'detached' });
  await expect(button).toBeDisabled();
  await expect(detail(page).getByText('已保存', { exact: true })).toBeVisible();
}
async function editPlan(page: Page, date: string) {
  await detail(page).getByRole('button', { name: '编辑计划日期', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '时间安排', exact: true });
  await fillToDooDate(modal.getByLabel('日期', { exact: true }), date);
  await modal.getByRole('button', { name: '完成设置', exact: true }).click();
  await expect(modal).not.toBeVisible();
}
async function changeList(page: Page, currentName: string, nextName: string) {
  await expect(detail(page).locator('.todo-detail-context')).toContainText(currentName);
  const modal = await openToDooDetailProperty(page, 'list');
  await selectToDooOption(modal, '所属目标或清单', nextName);
  await modal.getByRole('button', { name: '完成设置', exact: true }).click();
  await expect(modal).not.toBeVisible();
}
function recordWrites(page: Page) {
  const writes: any[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands'))
      writes.push(request.postDataJSON());
  });
  return writes;
}

test('an existing edit survives browser reload and remains local until the detail save', async ({ page }) => {
  const title = '刷新恢复 ' + crypto.randomUUID(), edited = title + ' 本地';
  const created = await command(page, 'create_task', { title, description: '服务端原说明' });
  const id = created.ids[0]; await open(page, id);
  const writes = recordWrites(page);
  await detail(page).getByLabel('任务标题', { exact: true }).fill(edited);
  await detail(page).getByLabel('任务说明', { exact: true }).fill('浏览器内保留，尚未提交');
  await expect.poll(() => page.evaluate((taskId) => Object.keys(localStorage)
    .filter((key) => key.startsWith('dooknow.to-doo.recovery:'))
    .some((key) => Object.values(JSON.parse(localStorage.getItem(key) || '{}').edits || {})
      .some((entry: any) => entry.draft?.task.id === taskId && entry.draft.task.description === '浏览器内保留，尚未提交')), id)).toBe(true);
  await page.reload();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue(edited);
  await expect(detail(page).getByLabel('任务说明', { exact: true })).toHaveValue('浏览器内保留，尚未提交');
  expect(writes).toEqual([]);
  expect((await snapshot(page, id)).tasks.find((task) => task.id === id)).toMatchObject({ title, description: '服务端原说明' });
  await save(page);
  expect((await snapshot(page, id)).tasks.find((task) => task.id === id)).toMatchObject({ title: edited, description: '浏览器内保留，尚未提交' });
  await page.reload();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue(edited);
  await expect(detail(page).getByRole('button', { name: '保存任务', exact: true })).toBeDisabled();
});

test('closing a task with invalid property input keeps the input until explicit cancellation', async ({ page }) => {
  const title = '无效输入保护 ' + crypto.randomUUID();
  const created = await command(page, 'create_task', { title, due: { date: '2030-05-17' } });
  await open(page, created.ids[0]);
  const writes = recordWrites(page);
  await detail(page).getByLabel('任务标题', { exact: true }).fill(title + ' 草稿');
  await detail(page).getByRole('button', { name: '编辑截止日期', exact: true }).click();
  const property = page.getByRole('dialog', { name: '截止日期', exact: true });
  const date = property.getByLabel('截止日期', { exact: true });
  await date.fill('2030-99-99'); await date.press('Tab');
  await property.locator('.ant-modal-close').click();
  await expect(property).not.toBeVisible();
  await detail(page).getByRole('button', { name: '标记完成', exact: true }).click();
  await expect(property).toBeVisible();
  expect(writes).toEqual([]);
  await property.locator('.ant-modal-close').click();
  await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(property).toBeVisible();
  await expect(date).toHaveValue('2030-99-99');
  await expect(property.getByRole('alert')).toContainText('请检查');
  expect(writes).toEqual([]);
  await property.getByRole('button', { name: '取消本次设置', exact: true }).click();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue(title + ' 草稿');
  await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await expect(detail(page)).not.toBeVisible();
  expect(writes).toEqual([]);
});

test('a real 409 requires comparison and honors explicit local and remote title choices', async ({ page }) => {
  for (const choice of ['local', 'remote'] as const) {
    const title = '冲突选择 ' + choice + ' ' + crypto.randomUUID();
    const created = await command(page, 'create_task', { title, description: '原说明' });
    const id = created.ids[0]; await open(page, id);
    await detail(page).getByLabel('任务标题', { exact: true }).fill(title + ' 我的');
    await detail(page).getByLabel('任务说明', { exact: true }).fill('保留本地独立说明');
    const original = (await snapshot(page, id)).tasks.find((task) => task.id === id)!;
    await command(page, 'update_task', { id, expectedRevision: original.revision, patch: { title: title + ' 远端', priority: 'high' } });
    const rejected = page.waitForResponse((response) => response.url().endsWith('/api/to-doo/commands') && response.status() === 409);
    await detail(page).getByRole('button', { name: '保存任务', exact: true }).click();
    await rejected;
    const comparison = detail(page).getByRole('alert', { name: '比较任务更新', exact: true });
    await expect(comparison).toBeVisible();
    await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue(title + ' 我的');
    await comparison.getByRole('button', { name: '载入最新并比较', exact: true }).click();
    const titleConflict = comparison.locator('.todo-conflict-field').filter({ has: page.getByText('标题', { exact: true }) });
    await expect(titleConflict).toContainText(title + ' 我的');
    await expect(titleConflict).toContainText(title + ' 远端');
    await titleConflict.getByRole('button', { name: choice === 'local' ? '保留我的输入' : '使用最新内容', exact: true }).click();
    await expect(comparison).not.toBeVisible();
    expect((await snapshot(page, id)).tasks.find((task) => task.id === id)?.title).toBe(title + ' 远端');
    await save(page);
    expect((await snapshot(page, id)).tasks.find((task) => task.id === id)).toMatchObject({
      title: title + (choice === 'local' ? ' 我的' : ' 远端'), description: '保留本地独立说明', priority: 'high',
    });
  }
});

test('invalid input blocks list changes and browser Back without changing the quick-add destination', async ({ page }) => {
  const suffix = crypto.randomUUID(), targetName = '未切换清单 ' + suffix;
  const target = await command(page, 'save_entity', { kind: 'list', entity: { name: targetName } });
  const first = await command(page, 'create_task', { title: '返回起点 ' + suffix });
  const secondTitle = '保留输入 ' + suffix;
  const second = await command(page, 'create_task', { title: secondTitle, due: { date: '2030-05-17' } });
  await open(page, first.ids[0]);
  await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await revealToDooTask(page, secondTitle);
  await page.getByRole('button', { name: secondTitle, exact: true }).click();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue(secondTitle);
  const beforeURL = page.url(), writes = recordWrites(page);
  await detail(page).getByRole('button', { name: '编辑截止日期', exact: true }).click();
  const property = page.getByRole('dialog', { name: '截止日期', exact: true });
  const date = property.getByLabel('截止日期', { exact: true });
  await date.fill('2030-99-99'); await date.press('Tab');
  await property.locator('.ant-modal-close').click();
  if ((page.viewportSize()?.width || 0) < 960) {
    // The mobile detail is a modal: background navigation is intentionally inert.
    // Attempt the detail's own list change, then exercise browser Back below.
    await detail(page).locator('.todo-detail-context').getByRole('button').click();
  } else {
    const directory = await openToDooDirectory(page);
    await directory.getByRole('button', { name: targetName, exact: true }).click();
  }
  await expect(property).toBeVisible(); await expect(page).toHaveURL(beforeURL);
  await expect(date).toHaveValue('2030-99-99'); expect(writes).toEqual([]);
  await property.locator('.ant-modal-close').click();
  await page.goBack();
  await expect(property).toBeVisible(); await expect(page).toHaveURL(beforeURL);
  await expect(date).toHaveValue('2030-99-99'); expect(writes).toEqual([]);
  await property.getByRole('button', { name: '取消本次设置', exact: true }).click();
  await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  const title = '仍属于收集箱 ' + suffix;
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/to-doo/commands') && response.request().postDataJSON()?.action === 'create_task');
  const capture = page.getByRole('textbox', { name: '快速添加任务', exact: true });
  await capture.fill(title); await capture.press('Enter');
  const created = await (await createdResponse).json();
  const after = await snapshot(page, created.ids[0]);
  expect(after.tasks.find(task => task.id === created.ids[0])).toMatchObject({ title, listId: null });
  expect(after.tasks.find(task => task.id === created.ids[0])?.listId).not.toBe(target.ids[0]);
});

test('a timed task arrangement can become all-day and still participate in scheduling', async ({ page }) => {
  const created = await command(page, 'create_task', { title: '全天归一 ' + crypto.randomUUID(), plan: { date: '2030-05-17', time: '09:00', timeZone: 'UTC' } });
  await open(page, created.ids[0]);
  await detail(page).getByRole('button', { name: '编辑计划日期', exact: true }).click();
  const property = page.getByRole('dialog', { name: '时间安排', exact: true });
  await property.getByRole('checkbox', { name: '全天安排', exact: true }).check();
  await expect(property.getByLabel('时间', { exact: true })).not.toBeVisible();
  await property.getByRole('button', { name: '完成设置', exact: true }).click(); await save(page);
  const after = await snapshot(page, created.ids[0]);
  const block = after.timeBlocks.find(value => !value.deletedAt)!;
  const occurrence = after.occurrences.find(value => value.id === block.occurrenceId)!;
  expect(block).toMatchObject({ allDay: true, start: { date: '2030-05-17', time: null } });
  const preview = await command(page, 'preview_plan', { name: '再次排程', changes: [{
    occurrenceId: occurrence.id, expectedRevision: occurrence.revision, blockId: block.id,
    expectedBlockRevision: block.revision, start: { ...block.start, date: '2030-05-18' },
    durationMinutes: block.durationMinutes, allDay: true, dateEndExclusive: null,
  }] });
  expect(preview.preview?.changes).toHaveLength(1);
  await command(page, 'apply_plan', { plan: preview.preview });
  const moved = await snapshot(page, created.ids[0]);
  expect(moved.timeBlocks.find(value => value.id === block.id)).toMatchObject({ allDay: true, start: { date: '2030-05-18', time: null } });
});

test('plan comparison preserves independent edits and explicitly resolves same-field date conflicts', async ({ page }) => {
  for (const sameField of [false, true]) {
    const created = await command(page, 'create_task', { title: '时间块比较 ' + crypto.randomUUID(),
      plan: { date: '2030-05-17', time: '09:00', timeZone: 'UTC' } });
    const id = created.ids[0]; await open(page, id);
    const before = await snapshot(page, id), plan = before.timeBlocks.find((block) => !block.deletedAt)!;
    const writes = recordWrites(page);
    await editPlan(page, '2030-05-18');
    expect(writes).toEqual([]);
    expect((await snapshot(page, id)).timeBlocks.find((block) => block.id === plan.id)?.start.date).toBe('2030-05-17');
    await command(page, 'save_entity', { kind: 'timeBlock', expectedRevision: plan.revision,
      entity: sameField ? { ...plan, start: { ...plan.start, date: '2030-05-19' } } : { ...plan, durationMinutes: 60 } });
    await detail(page).getByRole('button', { name: '保存任务', exact: true }).click();
    await detail(page).locator('.todo-detail-save .ant-btn-loading-icon').waitFor({ state: 'detached' });
    const comparison = detail(page).getByRole('alert', { name: '比较任务更新', exact: true });
    await expect(comparison).toBeVisible();
    await comparison.getByRole('button', { name: '载入最新并比较', exact: true }).click();
    if (sameField) {
      const conflict = comparison.locator('.todo-conflict-field').filter({ hasText: '时间安排 · 计划时间' });
      await expect(conflict).toContainText('2030-05-18'); await expect(conflict).toContainText('2030-05-19');
      await conflict.getByRole('button', { name: '保留我的输入', exact: true }).click();
    }
    await expect(comparison).not.toBeVisible();
    await detail(page).getByRole('button', { name: '编辑计划日期', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '时间安排', exact: true });
    await expect(modal.getByLabel('日期', { exact: true })).toHaveValue('2030-05-18');
    await expect(modal.getByRole('spinbutton', { name: '时长（分钟）', exact: true })).toHaveValue(String(sameField ? plan.durationMinutes : 60));
    await modal.getByRole('button', { name: '完成设置', exact: true }).click(); await save(page);
    const after = await snapshot(page, id), active = after.timeBlocks.filter((block) => !block.deletedAt);
    expect(active).toHaveLength(1); expect(active[0]).toMatchObject({ id: plan.id,
      start: { date: '2030-05-18', time: '09:00', timeZone: 'UTC' }, durationMinutes: sameField ? plan.durationMinutes : 60 });
    expect(active[0].revision).not.toBe(plan.revision);
  }
});

test('a hidden child draft blocks a parent move and the detail later moves the saved subtree atomically', async ({ page }) => {
  const suffix = crypto.randomUUID(), firstName = '原清单 ' + suffix, secondName = '目标清单 ' + suffix;
  const first = (await command(page, 'save_entity', { kind: 'list', entity: { name: firstName } })).ids[0];
  const second = (await command(page, 'save_entity', { kind: 'list', entity: { name: secondName } })).ids[0];
  const section = (await command(page, 'save_entity', { kind: 'section', entity: { listId: first, name: '原分组' } })).ids[0];
  const parentTitle = '父任务 ' + suffix, childTitle = '子任务 ' + suffix, editedChild = childTitle + ' 未保存';
  const parent = (await command(page, 'create_task', { title: parentTitle, listId: first, sectionId: section })).ids[0];
  const child = (await command(page, 'create_task', { title: childTitle, listId: first, parentTaskId: parent })).ids[0];
  await open(page, child); await detail(page).getByLabel('任务标题', { exact: true }).fill(editedChild);
  await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await revealToDooTask(page, parentTitle);
  await page.getByRole('button', { name: parentTitle, exact: true }).click();
  const writes = recordWrites(page);
  await changeList(page, firstName, secondName);
  expect(writes).toEqual([]);
  await detail(page).getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(page.getByText('移动范围内还有其他未保存的任务，请先处理这些草稿', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  const blocked = await snapshot(page, parent);
  for (const id of [parent, child]) expect(blocked.tasks.find((task) => task.id === id)?.listId).toBe(first);
  expect(blocked.tasks.find((task) => task.id === child)?.title).toBe(childTitle);
  await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByRole('button', { name: '任务草稿', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: editedChild }).click();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue(editedChild);
  await save(page); await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.getByRole('button', { name: parentTitle, exact: true }).click(); await save(page);
  const after = await snapshot(page, parent);
  expect(after.tasks.find((task) => task.id === parent)).toMatchObject({ listId: second, sectionId: null });
  expect(after.tasks.find((task) => task.id === child)).toMatchObject({ listId: second, parentTaskId: parent, title: editedChild });
  const move = writes.find((body) => body.action === 'batch_tasks' && body.payload.operation === 'move');
  expect(move?.payload).toMatchObject({ listId: second, includeDescendants: true });
  expect(move.payload.expectedRevisions[child]).toBeTruthy();
  expect(writes.filter((body) => body.action === 'update_task' && body.payload.id === parent).every((body) => !Object.hasOwn(body.payload.patch, 'listId'))).toBe(true);
});
