import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import { showSidebar } from '../support/settings-navigation';
import { expandFolderPath } from '../support/notebook-tree';

const content =
  '# 总览\n\n介绍。\n\n## 第一章\n\n### 重复子节\n\n#### 要点\n\n正文。\n\n## 第二章\n\n### 重复子节\n\n另一段正文。\n\n## 独立末章\n';

test('outline parents fold independently without navigation and retain their state across display modes', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const notes = [];
  for (const label of ['折叠目录', '另一篇目录']) {
    const response = await page.request.post('/api/notes', {
      headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
      data: {
        folderPath: '00-Inbox',
        fileName: `${label}-${info.project.name}-${crypto.randomUUID()}.md`,
        content,
        requestId: crypto.randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
    notes.push(await response.json());
  }
  await page.goto('/?note=' + notes[0].id);
  await expect(page.locator('.cm-content')).toBeVisible();
  if (info.project.name === 'desktop') await page.setViewportSize({ width: 1440, height: 900 });
  const nav = page.getByRole('navigation', { name: '本文章节', exact: true });
  const first = nav
    .locator('li[data-level="2"]')
    .filter({ has: page.getByRole('button', { name: '第一章', exact: true }) });
  const second = nav
    .locator('li[data-level="2"]')
    .filter({ has: page.getByRole('button', { name: '第二章', exact: true }) });
  const title = (name: string) => nav.getByRole('button', { name, exact: true });
  await expect(first.getByRole('button', { name: '要点', exact: true })).toBeVisible();
  const collapseFirst = title('收起 第一章');
  await expect(collapseFirst).toHaveAttribute('aria-expanded', 'true');
  const before = page.url();
  await collapseFirst.click();
  await expect(title('展开 第一章')).toHaveAttribute('aria-expanded', 'false');
  await expect(first.getByRole('button', { name: '重复子节', exact: true })).toBeHidden();
  await expect(second.getByRole('button', { name: '重复子节', exact: true })).toBeVisible();
  expect(page.url()).toBe(before);
  await expect(title('收起 独立末章')).toHaveCount(0);
  await expect(title('展开 独立末章')).toHaveCount(0);

  // Native disclosure buttons remain usable with Enter and Space.
  await title('展开 第一章').focus();
  await page.keyboard.press('Enter');
  await expect(first.getByRole('button', { name: '要点', exact: true })).toBeVisible();
  await first.getByRole('button', { name: '收起 重复子节', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(first.getByRole('button', { name: '要点', exact: true })).toBeHidden();
  await title('收起 第一章').click();
  await title('展开 第一章').click();
  await expect(first.getByRole('button', { name: '展开 重复子节', exact: true })).toBeVisible();
  await expect(first.getByRole('button', { name: '要点', exact: true })).toBeHidden();
  await title('第一章').click();
  await expect(page).toHaveURL(/#L5$/);
  await expect(page.locator('.cm-content')).toBeFocused();
  await title('收起 第一章').click();
  await expect
    .poll(async () => (await page.locator('.document-outline').boundingBox())!.width)
    .toBe(info.project.name === 'desktop' ? 228 : 132);
  await page.screenshot({
    path: info.outputPath('outline-folded-edit.png'),
    animations: 'disabled',
  });

  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(title('展开 第一章')).toBeVisible();
  await expect(second.getByRole('button', { name: '重复子节', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '分屏', exact: true }).click();
  const menu = page.getByRole('button', { name: '章节目录', exact: true });
  await menu.click();
  await expect(title('展开 第一章')).toBeVisible();
  const splitURL = page.url();
  await title('展开 第一章').click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  expect(page.url()).toBe(splitURL);
  await expect(first.getByRole('button', { name: '展开 重复子节', exact: true })).toBeVisible();
  await expect
    .poll(async () => (await page.locator('.outline-popup:visible').boundingBox())!.width)
    .toBe(312);
  await title('收起 第二章').click();
  await title('独立末章').click();
  await expect(page).toHaveURL(/#L19$/);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(title('展开 第二章')).toBeVisible();
  await expect(page.locator('.ant-popover:visible')).toHaveCSS('opacity', '1');
  await page.screenshot({
    path: info.outputPath('outline-folded-split.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(title('展开 第二章')).toBeVisible();
  await expect(first.getByRole('button', { name: '展开 重复子节', exact: true })).toBeVisible();
  await expect(page.locator('.outline-popup:visible')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // A different note with identical headings must not inherit the previous note's folds.
  await showSidebar(page);
  await expandFolderPath(page, '00-Inbox');
  await page
    .locator('.tree-scroll')
    .getByRole('button', { name: notes[1].relativePath.split('/').at(-1), exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp('note=' + notes[1].id));
  await expect(page.locator('.document-title')).toHaveAttribute('title', notes[1].relativePath);
  await expect(page.locator('.cm-content')).toBeEditable();
  await expect(title('收起 第一章')).toBeVisible();
  await expect(title('收起 第二章')).toBeVisible();
  await expect(first.getByRole('button', { name: '要点', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp('note=' + notes[0].id));
  await expect(page.locator('.document-title')).toHaveAttribute('title', notes[0].relativePath);
  await expect(page.locator('.cm-content')).toBeEditable();
  await expect(title('收起 第一章')).toBeVisible();

  // Replacing a folded heading with a new draft heading cannot hide its children.
  await title('收起 第一章').click();
  await page.getByRole('button', { name: '分屏', exact: true }).click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText('# 草稿总览\n\n介绍。\n\n## 新章节\n\n### 新子节\n');
  await menu.click();
  await expect(title('收起 新章节')).toBeVisible();
  await expect(title('新子节')).toBeVisible();
  await title('收起 新章节').click();
  await expect(title('新子节')).toBeHidden();
  expect((await (await page.request.get('/api/notes/' + notes[0].id)).json()).content).toBe(
    content,
  );
});
