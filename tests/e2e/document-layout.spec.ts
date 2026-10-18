import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

const content =
  '# 总览\n\n介绍。\n\n## 第一章\n\n正文。\n\n### 第一节\n\n细节。\n\n#### 子主题\n\n更多细节。\n\n##### 要点\n\n内容。\n\n###### 六级标题\n\n```md\n## 代码里的假标题\n```\n\n## 第二章\n\n' +
  '阅读段落。\n\n'.repeat(80) +
  '### 末尾章节\n\n最后的内容。';

test('document layout keeps an H1–H5 outline beside the article and navigates in each mode', async ({
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
  if (info.project.name === 'desktop') {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.document-outline')).toBeVisible();
    const article = (await page.locator('.document-surface').boundingBox())!;
    const outline = (await page.locator('.document-outline').boundingBox())!;
    expect(outline.x).toBeGreaterThanOrEqual(article.x + article.width - 1);
  }
  const chapterMenu = page.getByRole('button', { name: '章节目录', exact: true });
  async function outline() {
    if (
      (await chapterMenu.isVisible()) &&
      (await chapterMenu.getAttribute('aria-expanded')) !== 'true'
    )
      await chapterMenu.click();
    return page.getByRole('navigation', { name: '本文章节', exact: true });
  }
  let nav = await outline();
  await expect(nav.getByRole('button')).toHaveCount(7);
  await page.screenshot({
    path: info.outputPath('document-layout.png'),
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
  nav = await outline();
  await expect(nav.getByRole('button', { name: '要点', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  if (await chapterMenu.isVisible()) {
    await chapterMenu.click();
    await expect(chapterMenu).toHaveAttribute('aria-expanded', 'false');
  }
  await page.getByRole('button', { name: '预览', exact: true }).click();
  nav = await outline();
  await nav.getByRole('button', { name: '末尾章节', exact: true }).click();
  await expect(page.locator('.preview-panel')).toBeVisible();
  await expect
    .poll(() => page.locator('.preview-panel .markdown').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  nav = await outline();
  await expect(nav.getByRole('button', { name: '末尾章节', exact: true })).toHaveAttribute(
    'aria-current',
    'location',
  );
  if (await chapterMenu.isVisible()) await chapterMenu.click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.cm-content').fill('# 修改后的标题\n\n## 新的子章节\n\n未保存的正文。');
  nav = await outline();
  await expect(nav.getByRole('button', { name: '新的子章节', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: '第一章', exact: true })).toHaveCount(0);
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(content);
  if (await chapterMenu.isVisible()) {
    await chapterMenu.click();
    await expect(chapterMenu).toHaveAttribute('aria-expanded', 'false');
  }
  await page.setViewportSize({ width: 743, height: 604 });
  await expect(chapterMenu).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
