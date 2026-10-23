import { test, expect } from '../support/browser-test';
import { openDocumentNote } from '../support/document-editor';

test('Wiki链接可打开目标，目标笔记也能查找并返回引用来源', async ({ page, context }) => {
  const target = await openDocumentNote(page, context, '# 双向关系目标\n\n目标正文。\n');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const name = target.relativePath.split('/').at(-1)!.replace(/\.md$/, '');
  const sourceTitle = '引用来源-' + crypto.randomUUID();
  const created = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: sourceTitle + '.md',
      content: '# ' + sourceTitle + '\n\n[[' + name + '|打开目标]]\n',
    },
  });
  expect(created.status()).toBe(201);
  const source = await created.json();
  await page.goto('/?note=' + source.id);
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  await page.getByRole('link', { name: '打开目标', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('note=' + target.id));
  await page.getByRole('button', { name: '反向引用', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '提及此笔记', exact: true });
  const match = dialog
    .getByRole('button')
    .filter({ has: page.locator('strong', { hasText: sourceTitle }) });
  for (let i = 0; i < 10; i++) {
    await expect(dialog.locator('.note-backlinks')).toHaveAttribute('aria-busy', 'false');
    if (await match.count()) break;
    const next = dialog.getByRole('button', { name: '继续查找', exact: true });
    if (!(await next.isVisible())) break;
    await next.click();
  }
  await expect(match).toBeVisible();
  await match.click();
  await expect(page).toHaveURL(new RegExp('note=' + source.id));
  await expect(dialog).toBeHidden();
  expect((await (await page.request.get('/api/notes/' + source.id)).json()).content).toContain(
    '[[' + name + '|打开目标]]',
  );
});
