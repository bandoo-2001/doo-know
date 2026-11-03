import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { expandToDooGroup } from '../support/to-doo-ant-controls';

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('outcome preview renders Markdown safely and keeps the editable draft after closing', async ({
  page,
}) => {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/to-doo/commands', {
    headers: { origin: String(test.info().project.use.baseURL), 'x-csrf-token': csrf.token },
    data: {
      requestId: crypto.randomUUID(),
      action: 'create_task',
      payload: { title: '预览成果 ' + crypto.randomUUID() },
    },
  });
  expect(response.ok()).toBe(true);
  const taskId = (await response.json()).ids[0];
  await page.goto(
    '/?' + new URLSearchParams({ view: 'apps', app: 'to-doo', appSection: 'tasks', task: taskId }),
  );
  const detail = page.getByRole('complementary', { name: '任务详情', exact: true });
  await expect(detail.getByLabel('任务标题', { exact: true })).toBeVisible();
  await expandToDooGroup(detail, '完成标准与成果');
  await detail.getByRole('button', { name: '创建成果笔记并关联', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建成果笔记', exact: true });
  const body =
    '# 实际成果\n\n**已交付**\n\n<script>window.outcomePreviewUnsafe=true</script>\n\n<img src=x onerror="window.outcomePreviewUnsafe=true">\n\n[危险链接](javascript:alert(1))';
  await dialog.getByLabel('成果正文（Markdown）', { exact: true }).fill(body);
  await dialog.getByRole('button', { name: '预览成果正文', exact: true }).click();
  const preview = dialog.getByRole('region', { name: '成果正文预览', exact: true });
  await expect(preview.getByRole('heading', { name: '实际成果', exact: true })).toBeVisible();
  await expect(preview.locator('strong')).toHaveText('已交付');
  await expect(preview.locator('script, img[onerror], a[href^="javascript:"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as Window & { outcomePreviewUnsafe?: boolean }).outcomePreviewUnsafe,
    ),
  ).toBeUndefined();
  await dialog.getByRole('button', { name: '继续编辑成果正文', exact: true }).click();
  await expect(dialog.getByLabel('成果正文（Markdown）', { exact: true })).toHaveValue(body);
  await dialog.getByRole('button', { name: '收起并保留输入', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await detail.getByRole('button', { name: '创建成果笔记并关联', exact: true }).click();
  await expect(dialog.getByLabel('成果正文（Markdown）', { exact: true })).toHaveValue(body);
});
