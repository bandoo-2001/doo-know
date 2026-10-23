import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test('settings pages isolate content, show persistent tools, and restore the note editor', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/?view=settings&section=search');
  await expect(page.locator('.settings-workspace h1')).toHaveText('搜索');
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '设置分类', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '常用工具', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '个人账户', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByLabel('当前密码', { exact: true })).toHaveCount(0);
  await expect(page.locator('.settings-workspace h1')).toHaveText('搜索');
  const editorSettings = page
    .getByRole('navigation', { name: '设置分类', exact: true })
    .getByRole('button', { name: '通用与编辑', exact: true });
  await editorSettings.click();
  await expect(page.locator('.settings-workspace h1')).toHaveText('编辑器与外观');
  await expect(page.getByLabel('当前密码', { exact: true })).toHaveCount(0);
  await expect(page.locator('.search-runtime-settings')).toHaveCount(0);
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类', exact: true })
    .getByRole('button', { name: '账号与安全', exact: true })
    .click();
  await expect(page.getByLabel('确认新密码', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  const passwordDialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  await expect(passwordDialog.getByLabel('确认新密码', { exact: true })).toBeVisible();
  await passwordDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(passwordDialog).toBeHidden();
  await expect(page.locator('.plugin-manager')).toHaveCount(0);
  await page
    .locator('.settings-workspace')
    .getByRole('button', { name: '返回笔记', exact: true })
    .click();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `return-settings-${crypto.randomUUID()}.md`,
      content: '# Keep context\n\nselected words',
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' draft kept');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await page
    .getByRole('navigation', { name: '常用工具', exact: true })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await expect(editor).toBeHidden();
  await page.keyboard.press('ControlOrMeta+s');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(
    '# Keep context\n\nselected words',
  );
  await expect(page.getByText('有未保存的修改', { exact: true })).toHaveCount(0);
  await page
    .locator('.settings-workspace')
    .getByRole('button', { name: '返回笔记', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp('note=' + note.id));
  await expect(editor).toBeVisible();
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(editor).toContainText('**selected words draft kept**');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(
    '# Keep context\n\nselected words',
  );
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await page
    .getByRole('navigation', { name: '常用工具', exact: true })
    .getByRole('button', { name: '回收站', exact: true })
    .click();
  await expect(editor).toBeHidden();
  await page.goBack();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('**selected words draft kept**');
  await page.goForward();
  await expect(editor).toBeHidden();
  await page
    .locator('.trash-workspace')
    .getByRole('button', { name: '返回笔记', exact: true })
    .click();
  await expect(editor).toContainText('**selected words draft kept**');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor).toContainText('selected words draft kept');
  await expect(editor).not.toContainText('**selected words');
  await page.screenshot({ path: info.outputPath('management-shell.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
