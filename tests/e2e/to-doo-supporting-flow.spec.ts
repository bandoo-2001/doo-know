import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type { ToDooCommandResult, ToDooSnapshot } from '../../shared/to-doo-contracts';
import { test, expect } from '../support/browser-test';
import { revealHabitTestCard } from '../support/to-doo-habit-fixture';

test.beforeEach(async ({ context, page }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const response = await page.request.get('/api/to-doo/state?kind=habit&limit=1');
  expect(response.ok()).toBe(true);
  const snapshot = (await response.json()) as ToDooSnapshot;
  await page.clock.install({ time: new Date(snapshot.now) });
});

async function command(page: Page, action: string, payload: Record<string, unknown>) {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: { requestId: crypto.randomUUID(), action, payload },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as ToDooCommandResult;
}

test('an empty focus page starts and saves free focus without creating a project', async ({
  page,
}, info) => {
  const previous = await (await page.request.get('/api/to-doo/focus/history?limit=1')).json();
  if (previous.active)
    await command(page, 'control_focus', {
      id: previous.active.id,
      expectedRevision: previous.active.revision,
      operation: 'cancel',
    });
  await page.route(/\/api\/to-doo\/state\?/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('kind') !== 'focusTopic')
      return route.continue();
    const response = await route.fetch();
    const snapshot = (await response.json()) as ToDooSnapshot;
    await route.fulfill({
      response,
      json: {
        ...snapshot,
        focusTopics: [],
        page: { ...snapshot.page, total: 0, nextCursor: null },
      },
    });
  });
  const projectWrites: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/to-doo/commands')) return;
    const body = request.postDataJSON();
    if (body.action === 'save_entity' && body.payload.kind === 'focusTopic')
      projectWrites.push(body.requestId);
  });
  await page.goto('/?view=apps&app=to-doo&appSection=focus');
  const timer = page.getByRole('region', { name: '专注计时器', exact: true });
  const projects = page.getByRole('region', { name: '专注项目', exact: true });
  await expect(timer).toBeInViewport({ ratio: 1 });
  await expect(timer).toContainText('自由专注');
  await expect(projects).toContainText('还没有专注项目');
  expect((await timer.boundingBox())!.y).toBeLessThan((await projects.boundingBox())!.y);

  const startedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/to-doo/commands') &&
      response.request().postDataJSON()?.action === 'start_focus',
  );
  await timer.getByRole('button', { name: '开始专注', exact: true }).click();
  const response = await startedResponse;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON().payload.topicId).toBeNull();
  const started = (await response.json()) as ToDooCommandResult;
  const sessionId = started.ids[0];
  try {
    await expect(timer.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
    await page.clock.fastForward(1000);
    await timer.getByRole('button', { name: '结束并保存', exact: true }).click();
    await expect(timer.getByRole('button', { name: '开始专注', exact: true })).toBeVisible();
    const saved = (await (
      await page.request.get('/api/to-doo/state?kind=focusSession&ids=' + sessionId)
    ).json()) as ToDooSnapshot;
    expect(saved.focusSessions.find((session) => session.id === sessionId)).toMatchObject({
      status: 'finished',
      topicId: null,
    });
    expect(projectWrites).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('focus-first-use.png'), animations: 'disabled' });
  } finally {
    const latest = await (await page.request.get('/api/to-doo/focus/history?limit=1')).json();
    if (latest.active?.id === sessionId)
      await command(page, 'control_focus', {
        id: latest.active.id,
        expectedRevision: latest.active.revision,
        operation: 'cancel',
      });
  }
});

test('the empty habit page creates a habit and moves a real check-in into completed', async ({
  page,
}, info) => {
  let empty = true;
  await page.route(/\/api\/to-doo\/state(?:\?|$)/, async (route) => {
    if (!empty) return route.continue();
    const response = await route.fetch();
    const snapshot = (await response.json()) as ToDooSnapshot;
    await route.fulfill({ response, json: { ...snapshot, habits: [], habitEntries: [] } });
  });
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  const cards = page.locator('.todo-habit-cards');
  await expect(cards.locator('.ant-empty')).toContainText('还没有习惯');
  await page.locator('.todo-page-heading').getByRole('button', { name: /新建习惯/ }).click();
  const editor = page.getByRole('dialog', { name: '新建习惯', exact: true });
  const name = '每天散步 ' + crypto.randomUUID().slice(0, 8);
  await editor.getByLabel('名称', { exact: true }).fill(name);
  empty = false;
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const pending = cards.locator('[data-group="pending"]');
  const completed = cards.locator('[data-group="done"]');
  const nameOfCard = '习惯 ' + name;
  await expect(pending.getByRole('article', { name: nameOfCard, exact: true })).toBeVisible();
  await pending.getByRole('button', { name: '打卡 ' + name, exact: true }).click();
  await expect(pending.getByRole('article', { name: nameOfCard, exact: true })).toHaveCount(0);
  await revealHabitTestCard(page, name);
  const card = completed.getByRole('article', { name: nameOfCard, exact: true });
  await expect(card.getByRole('button', { name: '打卡 ' + name, exact: true })).toContainText('已打卡');
  await expect(card.getByRole('button', { name: '打卡 ' + name, exact: true })).toBeDisabled();
  await page.reload();
  await revealHabitTestCard(page, name);
  await expect(card.getByRole('button', { name: '打卡 ' + name, exact: true })).toContainText('已打卡');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('habit-completed.png'), animations: 'disabled' });
});

test('a partial quantity stays actionable until its target is reached', async ({ page }) => {
  const initial = (await (
    await page.request.get('/api/to-doo/state?kind=habit&limit=1')
  ).json()) as ToDooSnapshot;
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: initial.settings.timeZone }).format(
    new Date(initial.now),
  );
  const id = 'grouped-quantity-' + crypto.randomUUID();
  const name = '读两页 ' + crypto.randomUUID().slice(0, 8);
  await command(page, 'save_entity', {
    kind: 'habit',
    entity: {
      id,
      name,
      startDate: date,
      timeZone: initial.settings.timeZone,
      goalMode: 'quantity',
      target: 2,
      unit: '页',
    },
  });
  await page.goto('/?view=apps&app=to-doo&appSection=habits');
  const pending = page
    .locator('.todo-habit-cards')
    .locator('[data-group="pending"]');
  const card = pending.getByRole('article', { name: '习惯 ' + name, exact: true });
  await card.getByRole('spinbutton', { name: '记录数量 ' + name, exact: true }).fill('1');
  await card.getByRole('button', { name: '记录数量 ' + name, exact: true }).click();
  await expect(card.locator('.todo-habit-card-progress')).toContainText(/1\s*\/\s*2/);
  await expect(card.getByRole('button', { name: '记录数量 ' + name, exact: true })).toBeEnabled();
  await card.getByRole('button', { name: '记录数量 ' + name, exact: true }).click();
  const completed = page
    .locator('.todo-habit-cards')
    .locator('[data-group="done"]');
  await revealHabitTestCard(page, name);
  await expect(completed.getByRole('article', { name: '习惯 ' + name, exact: true })).toContainText(
    /2\s*\/\s*2/,
  );
  await expect(pending.getByRole('article', { name: '习惯 ' + name, exact: true })).toHaveCount(0);
});
