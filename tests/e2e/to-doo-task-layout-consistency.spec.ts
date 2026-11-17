import { readFile } from 'node:fs/promises';
import { localDate } from '../../packages/core/to-doo/recurrence';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('board names, dates and descriptions share a baseline without internal list dividers', async ({
  page,
}, info) => {
  const before = await (await page.request.get('/api/to-doo/state')).json();
  const today = localDate(new Date(before.now), before.settings.timeZone);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const command = async (action: string, payload: Record<string, unknown>) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).ids[0] as string;
  };
  const suffix = info.project.name + '-' + crypto.randomUUID().slice(0, 7);
  const list = await command('save_entity', {
    kind: 'list',
    entity: { name: '看板布局 ' + suffix },
  });
  const names = {
    parent: '同列父任务 ' + suffix,
    nested: '同列子任务 ' + suffix,
    orphan: '跨列子任务 ' + suffix,
  };
  const create = (title: string, initialStatus: string, parentTaskId?: string) =>
    command('create_task', {
      title,
      listId: list,
      initialStatus,
      ...(parentTaskId ? { parentTaskId } : {}),
      description: '说明与任务名称和时间使用相同的文字基线，不被列表行的分割线截断。',
      plan: { date: today, time: '10:00', timeZone: before.settings.timeZone },
      due: { date: today, time: '18:00', timeZone: before.settings.timeZone },
    });
  const parent = await create(names.parent, 'todo');
  await create(names.nested, 'todo', parent);
  await create(names.orphan, 'doing', parent);
  let writes = 0;
  await page.route('**/api/to-doo/commands', async (route) => {
    writes++;
    await route.abort();
  });
  await page.setViewportSize(
    info.project.name === 'desktop' ? { width: 1920, height: 1080 } : { width: 390, height: 844 },
  );
  await page.goto('/?view=apps&app=to-doo&appSection=board&list=' + list);
  const cards = [names.parent, names.orphan].map((title) =>
    page
      .locator('.todo-board-card')
      .filter({ has: page.getByRole('button', { name: title, exact: true }) }),
  );
  for (const card of cards) {
    await expect(card).toBeVisible();
    const row = card.locator(':scope > .todo-task-row');
    const title = (await row.locator('.todo-task-name').boundingBox())!;
    const dates = (await row.locator('.todo-task-dates').boundingBox())!;
    const description = (await card.locator(':scope > .todo-board-description').boundingBox())!;
    expect(description.x).toBeCloseTo(title.x, 0);
    expect(dates.x).toBeCloseTo(title.x, 0);
    expect(await row.evaluate((element) => getComputedStyle(element, '::after').display)).toBe(
      'none',
    );
    expect(
      await row.evaluate((element) => parseFloat(getComputedStyle(element).paddingInlineStart)),
    ).toBe(0);
    expect(
      await card.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  const orphanRow = cards[1].locator(':scope > .todo-task-row');
  expect(
    await orphanRow.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--depth').trim(),
    ),
  ).toBe('1');
  const nested = cards[0]
    .locator('.todo-board-subtask')
    .filter({ has: page.getByRole('button', { name: names.nested, exact: true }) });
  await expect(nested).toBeVisible();
  await expect(nested).toHaveCSS('border-left-width', '1px');
  await page.screenshot({
    path: info.outputPath('board-text-baselines.png'),
    animations: 'disabled',
  });
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all&list=' + list);
  const ordinary = page
    .locator('.todo-task-list-panel .todo-task-row')
    .filter({ has: page.getByRole('button', { name: names.parent, exact: true }) });
  await expect(ordinary).toBeVisible();
  expect(
    await ordinary.evaluate((element) => getComputedStyle(element, '::after').display),
  ).not.toBe('none');
  expect(writes).toBe(0);
});
