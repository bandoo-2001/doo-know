import { showSource, showRead, showSplit } from '../support/editor-navigation';
import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test.use({ sourceEditorPreference: true });

const content =
  '# 总览\n\n介绍。\n\n## 第一章\n\n正文。\n\n### 第一节\n\n细节。\n\n#### 子主题\n\n更多细节。\n\n##### 要点\n\n内容。\n\n###### 六级标题\n\n```md\n## 代码里的假标题\n```\n\n## 第二章\n\n' +
  '阅读段落。\n\n'.repeat(80) +
  '### 末尾章节\n\n最后的内容。';

test('document outline stays beside edit and preview, floats only in split, and navigates H1–H5', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `章节布局-${info.project.name}-${Date.now()}.md`,
      content,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + note.id);
  await expect(page.locator('.cm-content')).toBeVisible();
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  const chapterMenu = page.getByRole('button', { name: '章节目录', exact: true });
  const nav = page.getByRole('navigation', { name: '本文章节', exact: true });
  async function expectDockedOutline() {
    await expect(chapterMenu).toHaveCount(0);
    await expect(page.locator('.outline-popup:visible')).toHaveCount(0);
    await expect(page.locator('.document-outline')).toBeVisible();
    const article = (await page.locator('.document-surface').boundingBox())!;
    const outline = (await page.locator('.document-outline').boundingBox())!;
    const workspace = (await page.locator('.document-body').boundingBox())!;
    expect(outline.x).toBeGreaterThanOrEqual(article.x + article.width - 1);
    expect(outline.x + outline.width).toBeLessThanOrEqual(workspace.x + workspace.width + 1);
    expect(Math.abs(outline.y - article.y)).toBeLessThanOrEqual(1);
    expect(article.width).toBeGreaterThan(150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await expectDockedOutline();
  await expect(nav.locator('.outline-link')).toHaveCount(7);
  await page.screenshot({
    path: info.outputPath('document-edit.png'),
    animations: 'disabled',
  });
  await expect(nav.getByRole('button', { name: '六级标题', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: '代码里的假标题', exact: true })).toHaveCount(0);
  await expect(
    nav.locator(
      'li[data-level="1"] li[data-level="2"] li[data-level="3"] li[data-level="4"] li[data-level="5"]',
    ),
  ).toHaveCount(1);
  await nav.getByRole('button', { name: '要点', exact: true }).click();
  await expect(page).toHaveURL(/#L17$/);
  await expect(page.locator('.cm-content')).toBeFocused();
  await expect(nav.getByRole('button', { name: '要点', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await showRead(page);
  await expectDockedOutline();
  await nav.getByRole('button', { name: '末尾章节', exact: true }).click();
  await expect(page.locator('.preview-panel')).toBeVisible();
  await expect
    .poll(() => page.locator('.preview-panel .markdown').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(nav.getByRole('button', { name: '末尾章节', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await page.screenshot({ path: info.outputPath('document-preview.png'), animations: 'disabled' });
  await showSplit(page);
  await expect(page.locator('.document-outline')).toHaveCount(0);
  await expect(chapterMenu).toBeVisible();
  await expect(chapterMenu).toHaveAttribute('aria-expanded', 'false');
  const article = (await page.locator('.document-surface').boundingBox())!;
  const workspace = (await page.locator('.document-body').boundingBox())!;
  expect(article.width).toBeGreaterThanOrEqual(workspace.width - 1);
  await expect(nav).toBeHidden();
  await chapterMenu.click();
  await expect(nav).toBeVisible();
  await expect(chapterMenu).toHaveAttribute('aria-expanded', 'true');
  await nav.getByRole('button', { name: '第一章', exact: true }).click();
  await expect(page).toHaveURL(/#L5$/);
  await expect(page.locator('.cm-content')).toBeFocused();
  await expect(chapterMenu).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toBeHidden();
  await chapterMenu.click();
  await expect(nav).toBeVisible();
  await page.screenshot({ path: info.outputPath('document-split.png'), animations: 'disabled' });
  // Switching away with the popover open must leave only the persistent outline.
  await showSource(page);
  await expectDockedOutline();
  await expect(nav).toHaveCount(1);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('# 修改后的标题\n\n## 新的子章节\n\n未保存的正文。');
  await expect(nav.getByRole('button', { name: '新的子章节', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: '第一章', exact: true })).toHaveCount(0);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(content);
  await showSplit(page);
  await expect(chapterMenu).toHaveAttribute('aria-expanded', 'false');
  await chapterMenu.click();
  await expect(nav.getByRole('button', { name: '新的子章节', exact: true })).toBeVisible();
  await showRead(page);
  await expectDockedOutline();
  await expect(page.locator('.preview-panel')).toContainText('未保存的正文。');
  await page.setViewportSize({ width: 743, height: 604 });
  await expectDockedOutline();
  await showSource(page);
  await expectDockedOutline();
});
