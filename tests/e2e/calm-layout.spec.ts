import { showSplit } from '../support/editor-navigation';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test.use({ sourceEditorPreference: true });

test('opens in focused editing and keeps a long document path and actions usable on narrow screens', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = await page.request.get('/api/security/csrf');
  const original =
    '# 一篇标题比较长、需要在窄屏中认真阅读的笔记\n\n这是独立测试库中的原文。' +
    '这是一段应该在编辑器内自然换行的中文正文。'.repeat(16);
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': (await csrf.json()).token },
    data: {
      folderPath: '00-Inbox',
      fileName: `一篇用于检查长标题和工具栏的笔记-${test.info().project.name}-${Date.now()}.md`,
      content: original,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + encodeURIComponent(note.id));
  await expect(page.locator('.cm-content')).toContainText('这是独立测试库中的原文。');
  await expect(page.locator('.preview-panel')).toHaveCount(0);
  expect(
    await page.locator('.cm-scroller').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const name of ['分享', '更多操作']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  for (const name of ['历史版本', '插入图片或 PDF', '删除笔记']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  const content = '# 本地草稿\n\n只有显式保存才写入原文。';
  await page.locator('.cm-content').fill(content);
  await expect(page.locator('.save-state')).toContainText('未保存');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(content);
  await showSplit(page);
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('.preview-panel')).toContainText('只有显式保存才写入原文。');
});
