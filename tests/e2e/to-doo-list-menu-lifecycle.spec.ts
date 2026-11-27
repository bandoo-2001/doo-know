import { readFile } from 'node:fs/promises';
import { expect, test } from '../support/browser-test';
import { openToDooDirectory } from '../support/to-doo-navigation';

test('a list can be renamed and moved to trash from the sidebar with its tasks', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=apps&app=to-doo&appSection=tasks&taskFilter=all');
  let nav = await openToDooDirectory(page);
  await nav.locator('button[aria-label="新建清单"]').click();
  const create = page.getByRole('dialog', { name: '新建清单' });
  const name = '菜单回归 ' + crypto.randomUUID().slice(0, 8);
  await create.getByLabel('清单名称').fill(name);
  await create.getByRole('button', { name: '保存', exact: true }).click();
  await expect(create).toBeHidden();
  async function menu(label: string) {
    nav = await openToDooDirectory(page);
    const url = page.url();
    if (info.project.name === 'mobile')
      await nav.getByRole('button', { name: label + '的更多操作' }).click();
    else await nav.getByRole('button', { name: label, exact: true }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: label + '清单操作' });
    await expect(menu).toBeVisible();
    expect(page.url()).toBe(url);
    return menu;
  }
  await (await menu(name)).getByRole('menuitem', { name: '编辑清单' }).click();
  const edit = page.getByRole('dialog', { name: '编辑清单' });
  const renamed = name + ' 已修改';
  await edit.getByLabel('清单名称').fill(renamed);
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).toBeHidden();
  nav = await openToDooDirectory(page);
  const row = nav
    .locator('[data-list-id]')
    .filter({ has: page.getByRole('button', { name: renamed, exact: true }) });
  const id = await row.getAttribute('data-list-id');
  const headers = {
    origin: new URL(page.url()).origin,
    'x-csrf-token': (await (await page.request.get('/api/security/csrf')).json()).token,
  };
  const task = await page.request.post('/api/to-doo/commands', {
    headers,
    data: {
      action: 'create_task',
      payload: { title: '清单中的测试任务', listId: id },
      requestId: crypto.randomUUID(),
    },
  });
  expect(task.ok()).toBe(true);
  const taskId = (await task.json()).ids[0];
  await row.getByRole('button', { name: renamed, exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('list')).toBe(id);
  await expect(page.getByRole('dialog', { name: '功能导航' })).toBeHidden();
  await (await menu(renamed)).getByRole('menuitem', { name: '删除清单' }).click();
  const confirm = page.getByRole('dialog', { name: '删除清单' });
  await expect(confirm).toContainText(renamed);
  await confirm.getByRole('button', { name: '取消' }).click();
  await expect(confirm).toBeHidden();
  await (await menu(renamed)).getByRole('menuitem', { name: '删除清单' }).click();
  await confirm.getByRole('button', { name: '确认', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('list')).toBeNull();
  await page.reload();
  nav = await openToDooDirectory(page);
  await expect(nav.getByRole('button', { name: renamed, exact: true })).toHaveCount(0);
  const trash = await page.request.get('/api/to-doo/state', {
    params: {
      view: 'tasks',
      taskIds: taskId,
      filter: JSON.stringify({ taskScope: 'trash', includeDeleted: true }),
    },
  });
  expect(trash.ok()).toBe(true);
  expect(
    (await trash.json()).tasks.some(
      (item: { id: string; deletedAt?: string }) => item.id === taskId && item.deletedAt,
    ),
  ).toBe(true);
});
