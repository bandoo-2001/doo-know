import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test('the document formatting toolbar preserves selections, undo history, and explicit saving', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const original = '# 工具栏验收\n\n需要排版的文字';
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `格式工具-${info.project.name}-${Date.now()}.md`,
      content: original,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  const tools = page.getByRole('toolbar', { name: '正文格式', exact: true });
  await expect(tools).toBeVisible();
  const viewportHeight = page.viewportSize()!.height;
  expect((await page.locator('.note-header').boundingBox())!.height).toBeLessThanOrEqual(
    viewportHeight / 3,
  );
  expect((await page.locator('.editor-panel').boundingBox())!.height).toBeGreaterThanOrEqual(
    viewportHeight / 2,
  );
  const pathRow = (await page.locator('.document-breadcrumb').boundingBox())!;
  const formatRow = (await page.locator('.document-format-row').boundingBox())!;
  expect(formatRow.y).toBeGreaterThan(pathRow.y + pathRow.height);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await tools.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(editor).toContainText('**需要排版的文字**');
  await expect(tools.getByRole('button', { name: '加粗', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('ControlOrMeta+i');
  await expect(editor).toContainText('***需要排版的文字***');
  await expect(tools.getByRole('button', { name: '斜体', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).not.toContainText('***需要排版的文字***');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor).not.toContainText('**需要排版的文字**');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(editor).toContainText('**需要排版的文字**');
  await page.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(tools.getByRole('button', { name: '加粗', exact: true })).toBeDisabled();
  await expect(page.locator('.preview-panel strong')).toContainText('需要排版的文字');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor).toContainText('需要排版的文字');
  await expect(editor).not.toContainText('**');
  await tools.getByRole('combobox', { name: '段落格式', exact: true }).click();
  await page.getByRole('option', { name: '标题 2', exact: true }).click();
  await expect(editor).toContainText('## 需要排版的文字');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  await expect(page.locator('.save-state')).toContainText('未保存');
  await page.screenshot({ path: info.outputPath('two-row-toolbar.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.toolbar').getByRole('button', { name: /^保存/ }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toContain(
    '## 需要排版的文字',
  );
  if (info.project.name === 'desktop') {
    await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await expect(page.locator('.sidebar')).toBeVisible();
  }
});
