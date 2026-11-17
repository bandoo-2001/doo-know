import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { localDate } from '../../packages/core/to-doo/recurrence';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('overview aligns mixed task depths while identifying parents and retaining the task tree', async ({
  page,
}, info) => {
  const before = await (await page.request.get('/api/to-doo/state')).json();
  const today = localDate(new Date(before.now), before.settings.timeZone);
  const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000)
    .toISOString()
    .slice(0, 10);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const suffix = info.project.name + '-' + crypto.randomUUID().slice(0, 6);
  const names = {
    parent: '另一天的父任务 ' + suffix,
    child: '今天的子任务 ' + suffix,
    grandchild: '今天的孙任务 ' + suffix,
    root: '今天的普通任务 ' + suffix,
  };
  const create = async (title: string, date: string, parentTaskId?: string) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: {
        requestId: crypto.randomUUID(),
        action: 'create_task',
        payload: {
          title,
          ...(parentTaskId ? { parentTaskId } : {}),
          due: { date, time: null, timeZone: before.settings.timeZone },
        },
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).ids[0] as string;
  };
  const parent = await create(names.parent, yesterday);
  const child = await create(names.child, today, parent);
  const grandchild = await create(names.grandchild, today, child);
  const root = await create(names.root, today);
  let writes = 0;
  await page.route('**/api/to-doo/commands', async (route) => {
    writes++;
    await route.abort();
  });
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?view=apps&app=to-doo&appSection=overview');
  const overview = page.locator('.todo-overview-action-list');
  const row = (title: string) =>
    page
      .locator('.todo-task-row')
      .filter({ has: page.getByRole('button', { name: title, exact: true }) });
  const shown = [names.child, names.grandchild, names.root].map((title) =>
    overview
      .locator('.todo-task-row')
      .filter({ has: page.getByRole('button', { name: title, exact: true }) }),
  );
  for (const item of shown) await expect(item).toBeVisible();
  await expect(overview.getByRole('button', { name: names.parent, exact: true })).toHaveCount(0);
  await expect(shown[0].locator('.todo-row-parent')).toHaveText('子任务');
  await expect(shown[0].locator('.todo-row-parent')).toHaveAttribute(
    'title',
    '父任务：' + names.parent,
  );
  await expect(shown[0].locator('.todo-row-parent')).toHaveAttribute(
    'aria-label',
    '子任务，父任务：' + names.parent,
  );
  await expect(shown[1].locator('.todo-row-parent')).toHaveAttribute(
    'title',
    '父任务：' + names.child,
  );
  await expect(shown[2].locator('.todo-row-parent')).toHaveCount(0);
  const positions = await Promise.all(
    shown.map((item) =>
      item.evaluate((element) => {
        const checkbox = element.querySelector('.todo-check')!.getBoundingClientRect();
        const title = element.querySelector('.todo-task-name')!.getBoundingClientRect();
        return {
          checkbox: checkbox.left,
          title: title.left,
          depth: getComputedStyle(element).getPropertyValue('--depth').trim(),
        };
      }),
    ),
  );
  for (const position of positions) {
    expect(position.depth).toBe('0');
    expect(position.checkbox).toBeCloseTo(positions[0].checkbox, 0);
    expect(position.title).toBeCloseTo(positions[0].title, 0);
  }
  await page.screenshot({
    path: info.outputPath('overview-aligned-hierarchy.png'),
    animations: 'disabled',
  });
  await shown[0].getByRole('button', { name: names.child, exact: true }).click();
  await expect(
    page
      .getByRole('complementary', { name: '任务详情', exact: true })
      .getByRole('textbox', { name: '任务标题', exact: true }),
  ).toHaveValue(names.child);
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  await expect(row(names.child)).toBeVisible();
  const depth = (title: string) =>
    row(title).evaluate((element) => getComputedStyle(element).getPropertyValue('--depth').trim());
  expect(await depth(names.parent)).toBe('0');
  expect(await depth(names.child)).toBe('1');
  expect(await depth(names.grandchild)).toBe('2');
  expect(await depth(names.root)).toBe('0');
  await expect(row(names.child).locator('.todo-row-parent')).toHaveCount(0);
  const stored = await (
    await page.request.get(
      '/api/to-doo/state?taskIds=' + [parent, child, grandchild, root].join(','),
    )
  ).json();
  expect(stored.tasks.find((task: any) => task.id === child).parentTaskId).toBe(parent);
  expect(stored.tasks.find((task: any) => task.id === grandchild).parentTaskId).toBe(child);
  expect(writes).toBe(0);
});
