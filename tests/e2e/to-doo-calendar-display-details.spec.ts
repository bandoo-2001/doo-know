import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});
test('calendar and timeline close the date panel before their display popover', async ({
  page,
}) => {
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  for (const section of ['calendar', 'timeline']) {
    await page.goto('/?view=apps&app=to-doo&appSection=' + section);
    const trigger = page.getByRole('button', { name: '显示内容', exact: true });
    await trigger.click();
    const popup = page.locator('.todo-calendar-display-popup:visible');
    const input = popup.getByRole('textbox', { name: '跳转日期', exact: true });
    await input.click();
    await expect(page.locator('.ant-picker-dropdown:visible')).toBeVisible();
    await input.press('Escape');
    await expect(page.locator('.ant-picker-dropdown:visible')).toBeHidden();
    await expect(popup).toBeVisible();
    await input.press('Escape');
    await expect(popup).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  expect(writes).toBe(0);
});
test('timeline groups use the same expand icon and state as the task list', async ({
  page,
}, info) => {
  const suffix = crypto.randomUUID().slice(0, 7);
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const command = async (action: string, payload: any) => {
    const response = await page.request.post('/api/to-doo/commands', {
      headers: { origin: String(info.project.use.baseURL), 'x-csrf-token': csrf.token },
      data: { requestId: crypto.randomUUID(), action, payload },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).ids[0] as string;
  };
  const list = await command('save_entity', {
    kind: 'list',
    entity: { name: '时间线分组 ' + suffix },
  });
  const name = '本周重点 ' + suffix;
  const section = await command('save_entity', { kind: 'section', entity: { name, listId: list } });
  const title = '检查时间线折叠 ' + suffix;
  await command('create_task', { title, listId: list, sectionId: section });
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/to-doo/commands')) writes++;
  });
  await page.goto('/?view=apps&app=to-doo&appSection=timeline&list=' + list);
  const group = page.getByRole('button', { name: '折叠分组 ' + name, exact: true });
  await expect(group.locator('.todo-timeline-chevron')).toBeVisible();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await group.click();
  const expand = page.getByRole('button', { name: '展开分组 ' + name, exact: true });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: title, exact: true })).toBeHidden();
  await expand.click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  expect(writes).toBe(0);
});
