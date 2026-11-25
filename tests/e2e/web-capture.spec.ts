import { readFile } from 'node:fs/promises';
import { expect, test } from '../support/browser-test';
import { showSidebar } from '../support/settings-navigation';

test.use({ sourceEditorPreference: true });

test('previews a webpage before saving and opening its Markdown note', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const sourceUrl = 'https://example.com/guides/backup#verify';
  const body = '## 核对恢复结果\n\n先恢复到临时目录，再核对校验和。';
  const title = `网页备份指南-${crypto.randomUUID()}`;
  await page.route('**/api/web-capture/preview', async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ url: sourceUrl });
    await route.fulfill({ json: { title: '备份指南', sourceUrl, markdown: body } });
  });
  let saveRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/web-capture/save')
      saveRequests++;
  });

  await page.goto('/');
  await showSidebar(page);
  await page.getByRole('button', { name: '创建与导入', exact: true }).click();
  await page.getByRole('button', { name: '保存网页', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '保存网页', exact: true });
  await dialog.getByRole('textbox', { name: '网页链接', exact: true }).fill(sourceUrl);
  await dialog.getByRole('button', { name: '提取正文', exact: true }).click();
  const preview = dialog.getByRole('region', { name: '正文预览', exact: true });
  await expect(
    preview.getByText('先恢复到临时目录，再核对校验和。', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('link', { name: sourceUrl, exact: true })).toHaveAttribute(
    'href',
    sourceUrl,
  );
  const titleInput = dialog.getByRole('textbox', { name: '笔记标题', exact: true });
  await expect(titleInput).toHaveValue('备份指南');
  await titleInput.fill(title);
  expect(saveRequests).toBe(0);

  const saving = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/web-capture/save',
  );
  await dialog.getByRole('button', { name: '保存到收集箱', exact: true }).click();
  const saved = await saving;
  expect(saved.status(), await saved.text()).toBe(201);
  const { id } = await saved.json();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL((url) => url.searchParams.get('note') === id);
  await expect(page.locator('.cm-content')).toContainText('先恢复到临时目录，再核对校验和。');

  const note = await page.request.get(`/api/notes/${id}`);
  expect(note.ok()).toBe(true);
  const stored = await note.json();
  expect(stored.relativePath).toBe(`00-Inbox/${title}.md`);
  expect(stored.content).toContain(`# ${title}`);
  expect(stored.content).toContain(sourceUrl);
  expect(stored.content).toContain(body);
  expect(saveRequests).toBe(1);
});
