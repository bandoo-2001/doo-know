import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test('short paths stay direct on wide screens and remain reachable on narrow screens', async ({
  page,
  context,
}) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await expect(page.locator('.sidebar .brand')).toBeVisible();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `short-path-${crypto.randomUUID()}.md`,
      content: '# 浅层笔记',
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/?note=' + note.id);
  const nav = page.getByRole('navigation', { name: '笔记路径', exact: true });
  const toggle = nav.getByRole('button', { name: '展开完整路径', exact: true });
  await expect(nav).toBeVisible();
  await expect(toggle).toBeHidden();
  await expect(nav.locator('.breadcrumb-folder:visible')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 720 });
  await expect(nav.getByRole('heading')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(toggle).toBeVisible();
  await toggle.click();
  const menu = page.getByRole('dialog', { name: '完整笔记路径', exact: true });
  await menu.getByRole('button', { name: '打开目录 00-Inbox', exact: true }).click();
  await expect(page.locator('.folder-view')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('folder')).toBe('00-Inbox');
});

test('deep paths collapse into an accessible menu while preserving folder navigation and drafts', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  await expect(page.locator('.sidebar .brand')).toBeVisible();
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const folders = ['30-Knowledge'];
  for (let i = 1; i <= 7; i++) {
    const name = `第${i}层很长的目录名称`;
    const response = await page.request.post('/api/folders', {
      headers,
      data: { parent: folders.at(-1), name },
    });
    expect(response.status()).toBe(201);
    folders.push(`${folders.at(-1)}/${name}`);
  }
  const fileName = '这是一篇具有很长文件名的深层目录笔记.md';
  const response = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: folders.at(-1),
      fileName,
      content: '# 深层笔记\n\n原始内容。',
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/?note=' + note.id);
  const nav = page.getByRole('navigation', { name: '笔记路径', exact: true });
  await expect(nav).toBeVisible();
  await expect(nav.locator('.breadcrumb-folder:visible')).toHaveCount(1);
  await expect(nav.locator('.breadcrumb-folder')).toHaveAttribute('title', folders.at(-1)!);
  await expect(nav.getByRole('heading')).toHaveAttribute('title', note.relativePath);
  await expect(nav.getByRole('heading')).toHaveText(fileName.replace(/\.md$/, ''));
  const root = nav.getByRole('button', { name: '返回笔记本', exact: true });
  expect(await root.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect((await nav.getByRole('heading').boundingBox())!.width).toBeGreaterThan(120);

  const toggle = nav.getByRole('button', { name: '展开完整路径', exact: true });
  const menu = page.getByRole('dialog', { name: '完整笔记路径', exact: true });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button')).toHaveCount(folders.length);
  await expect(menu.getByRole('button').first()).toBeFocused();
  for (const path of folders)
    await expect(
      menu.getByRole('button', { name: '打开目录 ' + path, exact: true }),
    ).toHaveAttribute('title', path);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.click();
  await menu.getByRole('button', { name: '打开目录 ' + folders[3], exact: true }).click();
  await expect(page.locator('.folder-view')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('folder')).toBe(folders[3]);
  await page.goBack();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('未保存的编辑');
  await toggle.click();
  await menu.getByRole('button').first().click();
  await expect(
    page.getByText('离开前，请选择如何处理当前编辑内容。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('未保存的编辑');
  await expect(page).toHaveURL(new RegExp('note=' + note.id));

  for (const width of [743, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await expect(toggle).toBeVisible();
    await expect(nav.locator('.breadcrumb-folder')).toBeHidden();
    await expect(nav.getByRole('heading')).toBeVisible();
    expect((await nav.getByRole('heading').boundingBox())!.width).toBeGreaterThan(25);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await toggle.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button')).toHaveCount(folders.length);
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: info.outputPath(`deep-path-${width}.png`),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(
    '# 深层笔记\n\n原始内容。',
  );
});
