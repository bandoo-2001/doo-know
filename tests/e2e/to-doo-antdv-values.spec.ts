import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { showMainMenu } from '../support/settings-navigation';
import {
  expandToDooGroup,
  expectToDooSelection,
  selectToDooOption,
} from '../support/to-doo-ant-controls';

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function taskState(page: Page, taskId: string) {
  const response = await page.request.get(
    '/api/to-doo/state?' + new URLSearchParams({ taskIds: taskId, includeTree: 'true' }),
  );
  expect(response.ok()).toBe(true);
  return response.json();
}

async function saveDetail(page: Page, detail: Locator, taskId: string) {
  const saved = page.waitForResponse((response) => {
    if (response.request().method() !== 'POST' || !response.url().endsWith('/api/to-doo/commands'))
      return false;
    const body = response.request().postDataJSON();
    return body.action === 'update_task' && body.payload?.id === taskId;
  });
  await detail.getByRole('button', { name: '保存任务', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(
    page.getByRole('region', { name: 'To Doo 行动工作空间' }).getByRole('status'),
  ).toContainText('任务已保存');
}

async function selectAnotherTag(page: Page, detail: Locator, label: string) {
  const control = detail.getByRole('combobox', { name: '标签', exact: true });
  if ((await control.getAttribute('aria-expanded')) !== 'true') {
    await selectToDooOption(detail, '标签', label);
    return;
  }
  // Multiple Select keeps its popup open after the first choice. Clicking its
  // selector again would close it, so search the already open popup directly.
  await control.fill(label);
  const option = page.locator('.ant-select-dropdown:visible').getByText(label, { exact: true });
  await expect(option).toBeVisible();
  await option.click();
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('real Ant Select saves null, false, two tag identifiers and numeric zero', async ({
  page,
}, info) => {
  const suffix = info.project.name + '-' + crypto.randomUUID();
  const listName = '控件值清单 ' + suffix;
  const tagNames = ['控件值标签甲 ' + suffix, '控件值标签乙 ' + suffix];
  const list = await command(page, 'save_entity', {
    kind: 'list',
    entity: { name: listName, kind: 'list' },
  });
  const tags = [] as string[];
  for (const name of tagNames) {
    const result = await command(page, 'save_entity', { kind: 'tag', entity: { name } });
    tags.push(result.ids[0]);
  }
  const title = '保留实际控件值 ' + suffix;
  const created = await command(page, 'create_task', { title });
  const taskId = created.ids[0];
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + taskId);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  const detail = app.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);

  await selectToDooOption(detail, '所属目标或清单', listName);
  await expectToDooSelection(detail, '所属目标或清单', listName);
  await selectToDooOption(detail, '所属目标或清单', '收集箱');
  await expectToDooSelection(detail, '所属目标或清单', '收集箱');
  await selectToDooOption(detail, '紧急程度', '设为不紧急');
  await expectToDooSelection(detail, '紧急程度', '设为不紧急');
  await expandToDooGroup(detail, '更多选项：标签、提醒、依赖与来源');
  for (const name of tagNames) await selectAnotherTag(page, detail, name);
  const selectedTags = detail
    .getByRole('combobox', { name: '标签', exact: true })
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    )
    .locator('.ant-select-selection-item');
  await expect(selectedTags).toHaveCount(2);
  for (const name of tagNames) await expect(selectedTags.filter({ hasText: name })).toBeVisible();
  await detail.getByLabel('预计分钟', { exact: true }).fill('0');
  await detail.getByLabel('预计分钟', { exact: true }).press('Tab');
  await saveDetail(page, detail, taskId);

  let saved = (await taskState(page, taskId)).tasks.find((task: any) => task.id === taskId);
  expect(saved.listId).toBeNull();
  expect(saved.urgentOverride).toBe(false);
  expect(saved.estimateMinutes).toBe(0);
  expect([...saved.tagIds].sort()).toEqual([...tags].sort());

  await selectToDooOption(detail, '紧急程度', '根据截止时间判断');
  await expectToDooSelection(detail, '紧急程度', '根据截止时间判断');
  await saveDetail(page, detail, taskId);
  saved = (await taskState(page, taskId)).tasks.find((task: any) => task.id === taskId);
  expect(saved.urgentOverride).toBeNull();
  expect(saved.listId).toBeNull();
  expect(saved.estimateMinutes).toBe(0);
  expect([...saved.tagIds].sort()).toEqual([...tags].sort());
});

test('closing the portaled outcome Modal hides it and reopening preserves the unsaved draft', async ({
  page,
}, info) => {
  const suffix = info.project.name + '-' + crypto.randomUUID();
  const title = '成果草稿关闭重开 ' + suffix;
  const created = await command(page, 'create_task', { title });
  const taskId = created.ids[0];
  const before = await taskState(page, taskId);
  const originalTask = before.tasks.find((task: any) => task.id === taskId);
  const originalOccurrence = before.occurrences.find(
    (occurrence: any) => occurrence.taskId === taskId,
  );
  expect(originalOccurrence).toBeTruthy();
  const originalNotes = await (await page.request.get('/api/notes')).json();
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) &&
      /\/api\/(?:to-doo\/(?:commands|outcome-note)|notes)(?:[/?]|$)/.test(
        new URL(request.url()).pathname,
      )
    )
      writes.push(request.url());
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + taskId);
  const app = page.getByRole('region', { name: 'To Doo 行动工作空间' });
  const detail = app.getByRole('complementary', { name: '任务详情' });
  await expect(detail.getByLabel('任务标题', { exact: true })).toHaveValue(title);
  await expandToDooGroup(detail, '完成标准与成果');
  const open = detail.getByRole('button', { name: '创建成果笔记并关联', exact: true });
  await open.click();
  const outcome = page.getByRole('dialog', { name: '创建成果笔记', exact: true });
  await expect(outcome).toBeVisible();
  const noteTitle = '尚未提交的成果 ' + suffix;
  const content = '# 尚未提交\n\n收起和重新打开都应该保留这份输入。\n';
  await outcome.getByLabel('笔记标题', { exact: true }).fill(noteTitle);
  await outcome.getByLabel('成果正文（Markdown）', { exact: true }).fill(content);
  await outcome.getByRole('button', { name: '收起成果笔记表单并保留输入', exact: true }).click();
  await expect(outcome).not.toBeVisible();

  await open.click();
  await expect(outcome).toBeVisible();
  await expect(outcome.getByLabel('笔记标题', { exact: true })).toHaveValue(noteTitle);
  await expect(outcome.getByLabel('成果正文（Markdown）', { exact: true })).toHaveValue(content);
  await outcome.getByRole('button', { name: '收起并保留输入', exact: true }).click();
  await expect(outcome).not.toBeVisible();

  await detail.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await showMainMenu(page);
  await page
    .locator('.workspace-footer')
    .getByRole('button', { name: '返回 DooKnow', exact: true })
    .click();
  const leave = page.getByRole('dialog', { name: '尚有未保存内容', exact: true });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: '放弃更改并离开', exact: true }).click();
  await expect(leave).not.toBeVisible();
  await expect(app).not.toBeVisible();

  const after = await taskState(page, taskId);
  expect(after.tasks.find((task: any) => task.id === taskId)).toEqual(originalTask);
  expect(
    after.occurrences.find((occurrence: any) => occurrence.id === originalOccurrence.id),
  ).toEqual(originalOccurrence);
  expect(
    after.outcomes.filter((outcome: any) => outcome.occurrenceId === originalOccurrence.id),
  ).toEqual([]);
  const afterNotes = await (await page.request.get('/api/notes')).json();
  expect(afterNotes.map((note: any) => note.id).sort()).toEqual(
    originalNotes.map((note: any) => note.id).sort(),
  );
  expect(writes).toEqual([]);
});
