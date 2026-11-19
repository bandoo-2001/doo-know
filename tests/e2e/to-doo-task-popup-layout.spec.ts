import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

test.setTimeout(90000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

async function openTask(page: Page) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'create_task',
      payload: { title: '弹窗布局 ' + crypto.randomUUID() },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { ids } = await response.json();
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&task=' + ids[0]);
  const reader = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(reader.getByLabel('任务标题', { exact: true })).toBeVisible({ timeout: 20000 });
  return { reader, id: ids[0] as string };
}

async function withinViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test('task settings stay inside the viewport and cancelled reminders remain unsaved', async ({
  page,
}) => {
  const { reader, id } = await openTask(page);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands'))
      writes.push(request.postData()!);
  });
  for (const [triggerName, title] of [
    ['编辑重复规则', '重复规则'],
    ['编辑任务提醒', '任务提醒'],
    ['编辑关联资料', '关联资料'],
  ]) {
    const trigger = reader.getByRole('button', { name: triggerName, exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await withinViewport(page, dialog.locator('.ant-modal-content'));
    if (title === '任务提醒') {
      await dialog.getByRole('button', { name: '添加提醒' }).click();
      await expect(dialog.getByLabel('提前或延后（分钟）', { exact: true })).toBeVisible();
      await dialog.getByLabel('提前或延后（分钟）', { exact: true }).fill('-15');
    }
    const cancel = dialog.getByRole('button', { name: '取消本次设置', exact: true });
    await withinViewport(page, cancel);
    await cancel.click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  const stored = await (await page.request.get('/api/to-doo/state?taskIds=' + id)).json();
  expect(stored.tasks.find((task: any) => task.id === id).reminders).toEqual([]);
  expect(writes).toEqual([]);
});

test('draft actions remain joined and the display menu keeps its actions reachable', async ({
  page,
}) => {
  const { reader } = await openTask(page);
  await reader.getByLabel('任务标题', { exact: true }).fill('尚未保存的任务修改');
  await reader.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  const group = page.getByRole('group', { name: '新建任务与草稿', exact: true });
  const create = group.getByRole('button', { name: '新建任务', exact: true });
  const drafts = group.getByRole('button', { name: '任务草稿', exact: true });
  await expect(drafts).toBeVisible();
  const first = (await create.boundingBox())!,
    last = (await drafts.boundingBox())!;
  expect(Math.abs(first.x + first.width - last.x)).toBeLessThanOrEqual(1.1);
  expect(first.y).toBeCloseTo(last.y, 0);
  expect(first.height).toBeCloseTo(last.height, 0);
  const radii = async (button: Locator) =>
    button.evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ];
    });
  const primaryRadii = await radii(create),
    draftRadii = await radii(drafts);
  expect(primaryRadii[1]).toBe('0px');
  expect(primaryRadii[2]).toBe('0px');
  expect(draftRadii[0]).toBe('0px');
  expect(draftRadii[3]).toBe('0px');
  expect(parseFloat(primaryRadii[0])).toBeGreaterThan(0);
  expect(draftRadii[1]).toBe(primaryRadii[0]);
  expect(draftRadii[2]).toBe(primaryRadii[3]);
  await drafts.hover();
  expect(await radii(drafts)).toEqual(draftRadii);
  await create.focus();
  expect(await radii(create)).toEqual(primaryRadii);
  await drafts.click();
  await expect(page.getByRole('menuitem').filter({ hasText: '尚未保存的任务修改' })).toBeVisible();
  await page.keyboard.press('Escape');
  const display = page.getByRole('button', { name: '任务显示与管理', exact: true });
  await display.click();
  const popup = page.locator('.todo-task-display-popup:visible');
  await expect(popup.getByText('显示与管理', { exact: true })).toBeVisible();
  await withinViewport(page, popup.locator('.ant-popover-inner'));
  const options = popup.locator('.todo-task-display-options');
  expect(await options.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await withinViewport(page, popup.getByRole('button', { name: '保存当前视图', exact: true }));
  await popup.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(display).toBeFocused();
});

test('outline arrows stay centered on task completion and section headings across row layouts', async ({
  page,
}) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  async function command(action: string, payload: Record<string, unknown>) {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).ids[0] as string;
  }
  const listId = await command('save_entity', {
    kind: 'list',
    entity: { name: '箭头对齐 ' + crypto.randomUUID() },
  });
  const mainSection = await command('save_entity', {
    kind: 'section',
    entity: { listId, name: '本周重点' },
  });
  const routineSection = await command('save_entity', {
    kind: 'section',
    entity: { listId, name: '例行维护' },
  });
  const title = '梳理任务页面并确认所有交互细节';
  const date = new Date().toISOString().slice(0, 10);
  const parentId = await command('create_task', {
    listId,
    sectionId: mainSection,
    title,
    priority: 'high',
    plan: { date, time: '10:00', timeZone: 'UTC' },
    due: { date, time: '17:00', timeZone: 'UTC' },
  });
  await command('create_task', {
    listId,
    sectionId: mainSection,
    parentTaskId: parentId,
    title: '核对手机布局',
  });
  await command('create_task', {
    listId,
    sectionId: routineSection,
    title: '检查备份记录',
    priority: 'normal',
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&list=' + listId);
  const outline = page.locator('.todo-task-list-panel');
  const parent = outline
    .locator('.todo-tree-row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });
  await expect(parent).toBeVisible({ timeout: 20000 });
  async function centerGap(first: Locator, second: Locator) {
    const a = (await first.boundingBox())!,
      b = (await second.boundingBox())!;
    return Math.abs(a.y + a.height / 2 - b.y - b.height / 2);
  }
  for (const viewport of [
    { width: 1530, height: 1165 },
    { width: 1080, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() => centerGap(parent.locator('.todo-collapse svg'), parent.locator('.todo-check')))
      .toBeLessThanOrEqual(1);
    for (const heading of await outline.locator('.todo-task-group-heading').all()) {
      await expect
        .poll(() => centerGap(heading.locator('.todo-group-toggle svg'), heading))
        .toBeLessThanOrEqual(1);
      await expect.poll(() => centerGap(heading.locator('h2'), heading)).toBeLessThanOrEqual(1);
    }
  }
  const url = page.url();
  await parent.getByRole('button', { name: '折叠 ' + title, exact: true }).click();
  await expect(outline.getByRole('button', { name: '核对手机布局', exact: true })).toBeHidden();
  expect(page.url()).toBe(url);
  await parent.getByRole('button', { name: '展开 ' + title, exact: true }).click();
  await expect(outline.getByRole('button', { name: '核对手机布局', exact: true })).toBeVisible();
});
