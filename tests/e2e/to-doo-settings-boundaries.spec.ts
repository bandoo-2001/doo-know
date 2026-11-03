import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { expandToDooGroup, selectToDooOption } from '../support/to-doo-ant-controls';

const app = (page: Page) => page.getByRole('region', { name: 'To Doo 行动工作空间', exact: true });
async function dataTab(page: Page) {
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  await app(page).getByRole('tab', { name: '数据与恢复', exact: true }).click();
  await expandToDooGroup(app(page), '导入选项');
  await selectToDooOption(app(page), '格式', '滴答 CSV');
}
const csv = (count: number, prefix: string) =>
  'Title,Due Date,List Name\n' +
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1},2026-11-05 09:00,核对导入位置`).join(
    '\n',
  );

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('import preview reviews every item and revokes confirmation when content or destination changes', async ({
  page,
}) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const destination = '目标清单 ' + crypto.randomUUID();
  const created = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'save_entity',
      payload: { kind: 'list', entity: { name: destination } },
    },
  });
  expect(created.ok()).toBe(true);
  await dataTab(page);
  const workspace = app(page),
    content = workspace.getByLabel('或粘贴文件内容', { exact: true });
  await content.fill(csv(23, '核对记录'));
  await workspace.getByRole('button', { name: '预览导入', exact: true }).click();
  const preview = workspace.locator('.todo-import-preview');
  const confirm = workspace.getByRole('button', { name: /^确认导入/ });
  await expect(confirm).toBeVisible();
  const titles: string[] = [];
  for (let i = 0; i < 3; i++) {
    titles.push(...(await preview.getByRole('listitem').allTextContents()));
    const next = preview.getByRole('button', { name: '下一页预览', exact: true });
    if (!(await next.count()) || (await next.isDisabled())) break;
    await next.click();
    await expect(preview.getByText(new RegExp('第 ' + (i + 2) + ' /'))).toBeVisible();
  }
  for (let i = 1; i <= 23; i++)
    expect(titles.some((text) => text.includes('核对记录 ' + i))).toBe(true);
  expect(
    titles.some(
      (text) =>
        text.includes('2026-11-05') && text.includes('09:00') && text.includes('核对导入位置'),
    ),
  ).toBe(true);
  await content.fill(csv(1, '新正文'));
  await expect(confirm).not.toBeVisible();
  await workspace.getByRole('button', { name: '预览导入', exact: true }).click();
  await expect(confirm).toBeVisible();
  // Changing the parsed target is another part of the confirmed input snapshot.
  await selectToDooOption(workspace, '目标清单', destination);
  await expect(confirm).not.toBeVisible();
});

test('a lost import response retries the same request identity without duplicate records', async ({
  page,
}) => {
  await dataTab(page);
  const workspace = app(page),
    title = '重试导入 ' + crypto.randomUUID();
  await workspace.getByLabel('或粘贴文件内容', { exact: true }).fill(csv(1, title));
  await workspace.getByRole('button', { name: '预览导入', exact: true }).click();
  const confirm = workspace.getByRole('button', { name: /^确认导入/ });
  await expect(confirm).toBeVisible();
  const bodies: any[] = [];
  await page.route('**/api/to-doo/import/apply', async (route) => {
    bodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (bodies.length === 1)
      await route.fulfill({ status: 503, json: { error: '导入响应丢失，请重试' } });
    else await route.fulfill({ response });
  });
  await confirm.click();
  await expect(workspace.getByRole('alert')).toContainText('导入响应丢失');
  await confirm.click();
  await expect(confirm).not.toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  const savedResponse = await page.request.get(
    '/api/to-doo/state?' +
      new URLSearchParams({
        kind: 'task',
        filter: JSON.stringify({ query: title }),
        limit: '100',
      }),
  );
  expect(savedResponse.ok()).toBe(true);
  const saved = await savedResponse.json();
  expect(saved.tasks.filter((task: any) => task.title === title + ' 1')).toHaveLength(1);
});

test('save preferences is confined to its tab and quiet hours follow display timezone', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  const workspace = app(page),
    save = workspace.getByRole('button', { name: '保存偏好', exact: true });
  await expect(save).toBeVisible();
  for (const name of ['提醒与连接', '数据与恢复', '清单管理']) {
    await workspace.getByRole('tab', { name, exact: true }).click();
    await expect(save).not.toBeVisible();
  }
  await workspace.getByRole('tab', { name: '偏好', exact: true }).click();
  await expandToDooGroup(workspace, '日期与提醒');
  const zone = workspace.getByLabel('显示时区', { exact: true });
  const current = await zone.inputValue();
  const quiet = workspace.getByRole('checkbox', { name: '开启免打扰时段', exact: true });
  if (!(await quiet.isChecked())) await quiet.check();
  const next = current === 'Asia/Tokyo' ? 'Europe/Paris' : 'Asia/Tokyo';
  await zone.fill(next);
  await expect(workspace.getByText('免打扰实际时区：' + next, { exact: true })).toBeVisible();
  const list = await zone.getAttribute('list');
  expect(list).toBeTruthy();
  await expect(
    workspace.locator(`datalist[id="${list}"] option[value="Asia/Shanghai"]`),
  ).toHaveCount(1);
  // Arbitrary valid IANA names remain editable even when absent from suggestions.
  await zone.fill('Etc/GMT+3');
  await expect(workspace.getByText('免打扰实际时区：Etc/GMT+3', { exact: true })).toBeVisible();
});

test('name-only calendar and subscription drafts request confirmation before leaving', async ({
  page,
}) => {
  await page.goto('/?view=apps&app=to-doo&appSection=settings');
  const workspace = app(page);
  await workspace.getByRole('tab', { name: '提醒与连接', exact: true }).click();
  await expandToDooGroup(workspace, '连接外部只读日历');
  const name = workspace.getByRole('textbox', { name: '来源名称', exact: true });
  await name.fill('仅名称草稿');
  await page.getByRole('button', { name: '任务', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '尚有未保存内容', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(name).toHaveValue('仅名称草稿');
  await name.fill('');
  await expandToDooGroup(workspace, '创建 To Doo 只读订阅链接');
  const subscription = workspace.getByRole('textbox', { name: '订阅名称', exact: true });
  await subscription.fill('订阅草稿');
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(subscription).toHaveValue('订阅草稿');
});

test('file entry is Chinese and application warnings explain the affected row', async ({
  page,
}) => {
  await dataTab(page);
  const workspace = app(page);
  await expect(workspace.getByRole('button', { name: '选择导入文件', exact: true })).toBeVisible();
  await workspace.getByLabel('选择导入文件', { exact: true }).setInputFiles({
    name: '核对.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Title,Due Date\n日期待核对,not-a-date'),
  });
  await expect(workspace.getByText('核对.csv', { exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: '预览导入', exact: true }).click();
  await expect(workspace.locator('.todo-import-preview')).toContainText('第 2 行');
  await expect(workspace.locator('.todo-import-preview')).toContainText('日期无法识别');
  await expect(workspace.locator('.todo-import-preview')).not.toContainText('unrecognized date');
});
