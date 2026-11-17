import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { goToToDooSection, selectToDooList, selectToDooQuickView, revealToDooTask } from '../support/to-doo-navigation';
import { toDooEntitySchemas, type ToDooCommandResult, type ToDooSnapshot } from '../../shared/to-doo-contracts';

test.setTimeout(120000);
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

const app = (page: Page) => page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
const rail = (page: Page) => app(page).getByRole('navigation', { name: 'To Doo 主菜单', exact: true });
const directory = (page: Page) => app(page).getByRole('navigation', { name: 'To Doo 任务导航', exact: true });
const detail = (page: Page) => app(page).getByRole('complementary', { name: '任务详情', exact: true });
const sectionOf = (page: Page) => new URL(page.url()).searchParams.get('appSection');

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as ToDooCommandResult;
}

async function ready(page: Page) {
  await expect(app(page)).toBeVisible({ timeout: 20000 });
  await expect(app(page).locator('.todo-main')).toHaveAttribute('aria-busy', 'false', { timeout: 20000 });
}

async function tasks(page: Page, selection = '') {
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all' + selection);
  await ready(page);
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}

async function insideViewport(control: Locator, height: number) {
  const box = (await control.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
  return box;
}

test('an empty list catalogue reserves the remaining task directory space instead of placing global modules below it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The browser owner is shared by test files. Model an empty directory read
  // without deleting another scenario's real lists, tasks or other entities.
  await page.route('**/api/to-doo/state?**', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const data = await response.json() as ToDooSnapshot;
    data.lists = [];
    if (new URL(route.request().url()).searchParams.get('kind') === 'list')
      data.page = { ...data.page, total: 0, nextCursor: null, truncated: false };
    if (data.collectionPages?.list)
      data.collectionPages.list = { ...data.collectionPages.list, total: 0, nextCursor: null, truncated: false };
    await route.fulfill({ response, json: data });
  });
  await tasks(page);
  await expect(rail(page)).toBeVisible();
  await expect(directory(page)).toBeVisible();
  const lists = directory(page).getByRole('region', { name: '我的清单', exact: true });
  await expect(lists).toBeVisible();
  await expect(lists.getByText('暂无清单', { exact: true })).toBeVisible();
  await expect(lists.getByRole('button', { name: '新建清单', exact: true })).toHaveCount(1);
  expect((await lists.boundingBox())!.height).toBeGreaterThanOrEqual(350);
  await expect(directory(page).getByRole('button', { name: '日历', exact: true })).toHaveCount(0);
  await expect(directory(page).getByRole('button', { name: '设置', exact: true })).toHaveCount(0);
  await insideViewport(directory(page).getByRole('button', { name: '更多任务范围', exact: true }), 900);
  await insideViewport(rail(page).getByRole('button', { name: '设置', exact: true }), 900);
  await noHorizontalOverflow(page);
});

test('thirty-one real long-name lists scroll independently while task ranges and module utilities stay in place', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 812 });
  const prefix = 'main-nav-scroll-' + info.project.name + '-' + crypto.randomUUID().slice(0, 8);
  const nameFor = (number: number) => '主菜单滚动 ' + prefix + ' ' + String(number).padStart(2, '0') + ' 长清单名称：保留完整可访问名称并核对独立滚动区域';
  const created = await command(page, 'save_entity', { kind: 'list', entity: { name: nameFor(1), kind: 'list' } });
  const seed = await (await page.request.get('/api/to-doo/state?kind=list&ids=' + created.ids[0])).json() as ToDooSnapshot;
  const seedList = seed.lists.find(list => list.id === created.ids[0])!;
  expect(seedList).toBeDefined();
  const entries = Array.from({ length: 30 }, (_, offset) => {
    const number = offset + 2;
    return { kind: 'list', entity: toDooEntitySchemas.list.parse({
      ...seedList, id: prefix + '-list-' + number, name: nameFor(number),
      orderKey: 'main-navigation-' + String(number).padStart(3, '0'),
    }) };
  });
  expect((await command(page, 'import_entities', { entities: entries })).ids).toHaveLength(30);
  await tasks(page);
  const lists = directory(page).getByRole('region', { name: '我的清单', exact: true });
  const scroll = lists.locator('.todo-navigation-list-items');
  const last = scroll.getByRole('button', { name: nameFor(31), exact: true });
  await expect(last).toHaveCount(1);
  await expect(last).toHaveAttribute('title', nameFor(31));
  expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const before = {
    scope: (await directory(page).getByRole('button', { name: '今天', exact: true }).boundingBox())!,
    more: (await directory(page).getByRole('button', { name: '更多任务范围', exact: true }).boundingBox())!,
    settings: (await rail(page).getByRole('button', { name: '设置', exact: true }).boundingBox())!,
    windowY: await page.evaluate(() => scrollY),
  };
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect((await directory(page).getByRole('button', { name: '今天', exact: true }).boundingBox())!.y).toBeCloseTo(before.scope.y, 0);
  expect((await directory(page).getByRole('button', { name: '更多任务范围', exact: true }).boundingBox())!.y).toBeCloseTo(before.more.y, 0);
  expect((await rail(page).getByRole('button', { name: '设置', exact: true }).boundingBox())!.y).toBeCloseTo(before.settings.y, 0);
  expect(await page.evaluate(() => scrollY)).toBe(before.windowY);
  await insideViewport(rail(page).getByRole('button', { name: '通知', exact: true }), 812);
  await insideViewport(rail(page).getByRole('button', { name: '设置', exact: true }), 812);
  await last.click();
  await expect.poll(() => new URL(page.url()).searchParams.get('list')).toBe(prefix + '-list-31');
  await expect(directory(page).getByRole('button', { name: nameFor(31), exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(app(page).getByRole('heading', { level: 1 })).toHaveText(nameFor(31));
  await noHorizontalOverflow(page);
});

test('a short desktop with every pinned task scope keeps a usable list area and reachable archive and trash actions', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 480 });
  // Exercise the saved pre-rail preference format, including all three extra
  // ranges. None of these valid preferences may be dropped to make the layout fit.
  await page.addInitScript(() => localStorage.setItem('to-doo.navigation-pins.v1',
    JSON.stringify(['calendar', 'habits', 'focus', 'overdue', 'unscheduled', 'blocked'])));
  const name = '矮窗口清单仍可用 ' + info.project.name + '-' + crypto.randomUUID().slice(0, 8);
  await command(page, 'save_entity', { kind: 'list', entity: { name } });
  await tasks(page);
  await expect(rail(page)).toBeVisible();
  await expect(directory(page)).toBeVisible();
  const scopes = directory(page).locator('.todo-task-scope-items');
  await expect(scopes).toBeVisible();
  for (const label of ['今天', '收集箱', '近七天', '所有任务', '已完成', '逾期', '未安排', '受阻'])
    await expect(scopes.getByRole('button', { name: label, exact: true })).toHaveCount(1);
  expect(await scopes.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const lists = directory(page).getByRole('region', { name: '我的清单', exact: true });
  const listItems = lists.locator('.todo-navigation-list-items');
  expect((await listItems.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const more = directory(page).getByRole('button', { name: '更多任务范围', exact: true });
  const before = await insideViewport(more, 480);
  await scopes.getByRole('button', { name: '受阻', exact: true }).scrollIntoViewIfNeeded();
  await expect(scopes.getByRole('button', { name: '受阻', exact: true })).toBeInViewport();
  expect(await scopes.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const list = listItems.getByRole('button', { name, exact: true });
  await list.scrollIntoViewIfNeeded();
  await expect(list).toBeInViewport();
  expect((await more.boundingBox())!.y).toBeCloseTo(before.y, 0);
  await insideViewport(rail(page).getByRole('button', { name: '设置', exact: true }), 480);
  for (const [label, filter] of [['已归档', 'archived'], ['回收站', 'trash']] as const) {
    await more.click();
    const popup = page.getByRole('group', { name: '更多任务范围', exact: true });
    await expect(popup.getByRole('button', { name: label, exact: true })).toBeVisible();
    await popup.getByRole('button', { name: label, exact: true }).click();
    await expect(popup).not.toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe(filter);
    await ready(page);
    await insideViewport(more, 480);
    expect((await listItems.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await noHorizontalOverflow(page);
});

test('the module rail and its More popup keep every module reachable without a task directory on other pages', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await tasks(page);
  for (const section of ['calendar', 'habits', 'focus', 'overview', 'stats', 'anniversaries', 'notifications', 'settings']) {
    await goToToDooSection(page, section);
    await ready(page);
    await expect(rail(page)).toHaveCount(1);
    await expect(rail(page)).toBeVisible();
    await expect(directory(page)).toHaveCount(0);
    await noHorizontalOverflow(page);
  }
  await goToToDooSection(page, 'tasks');
  await expect(directory(page)).toBeVisible();
  await expect(rail(page).getByRole('button', { name: '任务', exact: true })).toHaveAttribute('aria-current', 'page');
  for (const [label, filter] of [['逾期', 'overdue'], ['未安排', 'unscheduled'], ['受阻', 'blocked'], ['已归档', 'archived'], ['回收站', 'trash']]) {
    await selectToDooQuickView(page, label!);
    await expect.poll(() => new URL(page.url()).searchParams.get('taskFilter')).toBe(filter);
    await expect(rail(page).getByRole('button', { name: '任务', exact: true })).toHaveAttribute('aria-current', 'page');
  }
});

test('manual collapse and expand restore the selected task list instead of losing its context', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = '折叠后保留清单 ' + info.project.name + '-' + crypto.randomUUID().slice(0, 8);
  const created = await command(page, 'save_entity', { kind: 'list', entity: { name } });
  await tasks(page);
  await selectToDooList(page, name);
  const beforeURL = page.url();
  await rail(page).getByRole('button', { name: '任务', exact: true }).click();
  await expect(page).toHaveURL(beforeURL);
  await expect(directory(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
  await directory(page).getByRole('button', { name: '折叠清单导航', exact: true }).click();
  await expect(directory(page)).not.toBeVisible();
  await expect(rail(page)).toBeVisible();
  await expect(page).toHaveURL(beforeURL);
  await rail(page).getByRole('button', { name: '展开清单导航', exact: true }).click();
  await expect(directory(page)).toBeVisible();
  await expect(directory(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(beforeURL);
  expect(new URL(page.url()).searchParams.get('list')).toBe(created.ids[0]);
});

test('a 1080px dock keeps the module rail and sufficient task width while the list directory opens in a drawer', async ({ page }, info) => {
  await page.setViewportSize({ width: 1080, height: 812 });
  const title = '1080主菜单与详情 ' + info.project.name + '-' + crypto.randomUUID().slice(0, 8);
  const created = await command(page, 'create_task', { title });
  await tasks(page, '&task=' + created.ids[0]);
  await expect(detail(page)).toBeVisible();
  await expect(app(page)).toHaveClass(/todo-detail-docked/);
  await expect(rail(page)).toBeVisible();
  await expect(directory(page)).not.toBeVisible();
  const content = (await app(page).locator('.todo-content').boundingBox())!;
  expect(content.width).toBeGreaterThanOrEqual(440);
  await rail(page).getByRole('button', { name: '展开清单导航', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '功能导航', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('navigation', { name: 'To Doo 导航', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue(title);
  expect((await app(page).locator('.todo-content').boundingBox())!.width).toBeGreaterThanOrEqual(440);
  await noHorizontalOverflow(page);
});

test('module keyboard actions and Escape retain a local task draft without implicitly saving it', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = '主菜单草稿保护 ' + info.project.name + '-' + crypto.randomUUID().slice(0, 8);
  const edited = title + ' 尚未保存';
  const created = await command(page, 'create_task', { title, description: '服务端原说明' });
  await tasks(page, '&task=' + created.ids[0]);
  const writes: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/to-doo/commands')
      writes.push(request.postDataJSON());
  });
  await detail(page).getByLabel('任务标题', { exact: true }).fill(edited);
  const more = rail(page).getByRole('button', { name: '更多模块', exact: true });
  await more.focus(); await page.keyboard.press('Enter');
  const popup = page.getByRole('group', { name: '更多模块', exact: true });
  await expect(popup).toBeVisible();
  const overview = popup.getByRole('button', { name: '目标总览', exact: true });
  await overview.focus(); await page.keyboard.press('Tab');
  expect(await popup.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await expect(more).toBeFocused();
  const calendar = rail(page).getByRole('button', { name: '日历', exact: true });
  await calendar.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => sectionOf(page)).toBe('calendar');
  await ready(page);
  await expect(directory(page)).toHaveCount(0);
  await goToToDooSection(page, 'tasks');
  await revealToDooTask(page, title);
  const row = app(page).locator('.todo-task-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });
  await row.getByRole('button', { name: title, exact: true }).click();
  await expect(detail(page).getByLabel('任务标题', { exact: true })).toHaveValue(edited);
  expect(writes).toEqual([]);
  const stored = await (await page.request.get('/api/to-doo/state?taskIds=' + created.ids[0])).json() as ToDooSnapshot;
  expect(stored.tasks.find(task => task.id === created.ids[0])).toMatchObject({ title, description: '服务端原说明' });
});

test('a 390px phone keeps the single bottom navigation and the complete keyboard-accessible drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await tasks(page);
  await expect(rail(page)).not.toBeVisible();
  await expect(directory(page)).not.toBeVisible();
  const bottom = app(page).getByRole('navigation', { name: 'To Doo 快捷导航', exact: true });
  await expect(bottom).toBeVisible();
  await expect(bottom.getByRole('button')).toHaveCount(4);
  const trigger = app(page).getByRole('button', { name: '功能导航', exact: true });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: '功能导航', exact: true });
  await expect(drawer).toBeVisible();
  const close = drawer.getByRole('button', { name: '关闭功能导航', exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await drawer.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const combined = drawer.getByRole('navigation', { name: 'To Doo 导航', exact: true });
  await combined.getByRole('button', { name: '日历', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect.poll(() => sectionOf(page)).toBe('calendar');
  await ready(page);
  await expect(app(page).getByRole('heading', { name: '日历', exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});
