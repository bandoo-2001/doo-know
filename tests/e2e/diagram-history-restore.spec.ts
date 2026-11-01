import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import { selectHistoryVersion } from '../support/note-actions';
test.setTimeout(90000);
test.beforeEach(async ({ context }) =>
  context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8'))),
);
test('图形历史使用浏览器重新准备预览并恢复历史说明，刷新后仍可编辑', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '新建流程图', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建流程图', exact: true });
  await create.getByLabel('文件名', { exact: true }).fill('history-flow-' + crypto.randomUUID());
  await create.getByRole('button', { name: '创建', exact: true }).click();
  const workspace = page.getByTestId('diagram-document-workspace');
  await expect(workspace.getByRole('status')).toContainText('已保存');
  const id = new URL(page.url()).searchParams.get('note')!;
  const initial = await (await page.request.get('/api/notes/' + id)).json();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const later = await page.request.put('/api/notes/' + id, {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      content: initial.content + '\nLater history prose\n',
      expectedModifiedAt: initial.modifiedAt,
      requestId: crypto.randomUUID(),
    },
  });
  expect(later.status()).toBe(200);
  await page.reload();
  await expect(workspace.getByRole('status')).toContainText('已保存');
  const editor = workspace.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('flowchart TD\nLocal[未保存草稿]-->B\n');
  await workspace.getByRole('button', { name: '历史版本', exact: true }).click();
  const dialog = page.locator('.note-history-dialog');
  await selectHistoryVersion(page, 0);
  await dialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  const leave = page.locator('.n-modal').filter({ hasText: '离开前，请选择如何处理当前编辑内容' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toContainText('未保存草稿');
  let stopped = false;
  await page.route('**/api/diagram-history-restores/*/prepare', async (route) => {
    if (!stopped) {
      stopped = true;
      await route.abort('failed');
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await leave.getByRole('button', { name: '放弃修改', exact: true }).click();
  const check = dialog.getByRole('button', { name: '核对恢复结果', exact: true });
  await expect(check).toBeVisible();
  expect((await (await page.request.get('/api/notes/' + id)).json()).content).toContain(
    'Later history prose',
  );
  await check.click();
  await expect
    .poll(async () => (await (await page.request.get('/api/notes/' + id)).json()).content)
    .not.toContain('Later history prose');
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeEnabled();
  await expect(check).toHaveCount(0);
  const restored = await (await page.request.get('/api/notes/' + id)).json();
  expect(restored.content).not.toContain('Later history prose');
  expect(restored.content).toContain('dooknow:primary:start');
  expect(
    (await (await page.request.get('/api/notes/' + id + '/diagram')).json()).preview.state,
  ).toBe('ready');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(workspace.getByRole('status')).toContainText('已保存');
});
