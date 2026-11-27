import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { confirmToDooAction } from '../support/to-doo-ant-controls';

const settingsPath = '/?view=apps&app=to-doo&appSection=settings';
test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('To Doo settings navigate from a bare URL and undo only the preference draft', async ({
  page,
}, info) => {
  const phone = info.project.name === 'mobile';
  await page.setViewportSize({ width: phone ? 320 : 1440, height: phone ? 844 : 950 });
  const reads: string[] = [];
  page.on('request', (request) => reads.push(new URL(request.url()).pathname));
  await page.goto(settingsPath);
  const nav = page.getByRole('tablist', { name: 'To Doo 设置分类' });
  await expect(nav).toHaveAttribute('aria-orientation', phone ? 'horizontal' : 'vertical');
  for (const label of ['偏好', '提醒与连接', '数据与恢复', '清单管理'])
    await expect(nav.getByRole('tab', { name: label, exact: true })).toBeInViewport({ ratio: 1 });
  const duration = page.getByRole('spinbutton', { name: '默认安排分钟', exact: true });
  const saved = await duration.inputValue();
  await duration.fill(saved === '42' ? '43' : '42');
  await nav
    .getByRole('tab', { name: '偏好', exact: true })
    .press(phone ? 'ArrowRight' : 'ArrowDown');
  await expect(page).toHaveURL(/appPage=connections/);
  await expect(page.getByRole('heading', { name: '桌面提醒', exact: true })).toBeVisible();
  expect(reads).not.toContain('/api/to-doo/calendars/feeds');
  expect(reads).not.toContain('/api/to-doo/watch/devices');
  await page.getByRole('tab', { name: '日历', exact: true }).click();
  await page.getByText('连接外部只读日历', { exact: true }).click();
  const source = page.getByRole('textbox', { name: '来源名称', exact: true });
  await source.fill('未提交的日历来源');
  await nav.getByRole('tab', { name: '偏好', exact: true }).click();
  await page.getByRole('button', { name: '撤销更改', exact: true }).click();
  await expect(duration).toHaveValue(saved);
  await expect(page.getByRole('button', { name: '保存偏好', exact: true })).toBeDisabled();
  await page.goBack();
  await expect(nav.getByRole('tab', { name: '提醒与连接', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(source).toHaveValue('未提交的日历来源');
  await source.fill('');
  await page.reload();
  await expect(nav.getByRole('tab', { name: '提醒与连接', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('list management searches nested lists, edits a template and confirms deletion for the selected list', async ({
  page,
}) => {
  await page.goto(settingsPath + '&appPage=lists');
  const csrf = (await (await page.request.get('/api/security/csrf')).json()).token;
  const headers = { origin: new URL(page.url()).origin, 'x-csrf-token': csrf };
  const create = async (name: string, parentId?: string) => {
    const result = await page.request.post('/api/to-doo/commands', {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        action: 'save_entity',
        payload: { kind: 'list', entity: { name, kind: 'list', parentId: parentId || null } },
      },
    });
    expect(result.ok()).toBe(true);
    return (await result.json()).ids[0] as string;
  };
  const suffix = crypto.randomUUID().slice(0, 8),
    parent = '父清单 ' + suffix,
    child = '子清单 ' + suffix;
  await create(child, await create(parent));
  await page.reload();
  const search = page.getByRole('textbox', { name: '查找清单或目标', exact: true });
  await search.fill(child);
  const list = page.getByRole('tabpanel', { name: '清单与目标', exact: true });
  await expect(list.locator('.todo-managed-list')).toHaveCount(2);
  await expect(list.getByText(parent, { exact: true })).toBeVisible();
  await list.getByRole('button', { name: child + '的清单操作' }).click();
  await page.getByRole('menuitem', { name: '删除清单', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '删除清单' })).toContainText(child);
  await page
    .getByRole('dialog', { name: '删除清单' })
    .getByRole('button', { name: '取消' })
    .click();
  await list.getByRole('button', { name: child + '的清单操作' }).click();
  await page.getByRole('menuitem', { name: '删除清单', exact: true }).click();
  await confirmToDooAction(page, '删除清单');
  await expect(list.getByText('没有匹配的清单或目标。')).toBeVisible();
  await page.getByRole('tab', { name: '标签与分组', exact: true }).click();
  await page.getByRole('button', { name: '新建模板', exact: true }).click();
  const template = page.getByRole('dialog', { name: '新建任务模板' });
  await template.getByLabel('名称', { exact: true }).fill('模板 ' + suffix);
  await template.getByLabel('任务标题（每行一项）').fill('第一项');
  await template.getByRole('button', { name: '保存', exact: true }).click();
  await expect(template).toBeHidden();
  await page.getByRole('button', { name: '编辑模板：模板 ' + suffix }).click();
  await expect(
    page.getByRole('dialog', { name: '编辑任务模板' }).getByLabel('任务标题（每行一项）'),
  ).toHaveValue('第一项');
});
