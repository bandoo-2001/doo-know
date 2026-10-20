import { expect, type Page, type BrowserContext } from '@playwright/test';
import { readFile } from 'node:fs/promises';
export async function openDocumentNote(
  page: Page,
  context: BrowserContext,
  content = '# 标题\n\n原文段落。\n',
) {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: { folderPath: '00-Inbox', fileName: `doc-${crypto.randomUUID()}.md`, content },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: '文档编辑', exact: true }).click();
  return note;
}
export async function saveDocument(page: Page) {
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
}
