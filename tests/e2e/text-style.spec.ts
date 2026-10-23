import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';

test('alignment and text colors preserve selections, undo, preview, saving and public reading', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const headers = { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token };
  const text = '需要改变颜色的文字';
  const original = `# 样式检查\n\n${text}\n\n下一段保持默认。`;
  const response = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `styles-${crypto.randomUUID()}.md`,
      content: original,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + note.id);
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const editor = page.locator('.cm-content');
  const tools = page.getByRole('toolbar', { name: '正文格式', exact: true });
  const source = () =>
    editor
      .locator('.cm-line')
      .allTextContents()
      .then((lines) => lines.join('\n'));
  const mode = (name: string) => page.getByRole('button', { name, exact: true });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  const colors = tools.getByRole('button', { name: '文字颜色', exact: true });
  const palette = () => page.getByRole('dialog', { name: '文字颜色面板', exact: true });
  async function chooseColor(name: string) {
    await colors.click();
    await palette().getByRole('button', { name, exact: true }).click();
  }
  await chooseColor('红色 #dc2626');
  await expect.poll(source).toContain(`<span style="color:#dc2626">${text}</span>`);
  await expect(editor.locator('.cm-text-color').filter({ hasText: text })).toHaveCSS(
    'color',
    'rgb(220, 38, 38)',
  );
  await tools.getByRole('button', { name: '居中对齐', exact: true }).click();
  await expect.poll(source).toContain('text-align:center');
  await expect(editor.locator('.cm-text-aligned').filter({ hasText: text })).toHaveCSS(
    'text-align',
    'center',
  );
  await expect(tools.getByRole('button', { name: '居中对齐', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await mode('撤销').click();
  await expect.poll(source).not.toContain('text-align:center');
  await mode('重做').click();
  await expect.poll(source).toContain('text-align:center');

  for (const [name, alignment] of [
    ['右对齐', 'right'],
    ['左对齐', 'left'],
    ['居中对齐', 'center'],
  ]) {
    await tools.getByRole('button', { name, exact: true }).click();
    await expect.poll(source).toContain(`text-align:${alignment}`);
    expect((await source()).match(/<div /g)).toHaveLength(1);
    await mode('阅读').click();
    await expect(page.locator('.preview-panel .markdown > h1')).toHaveText('样式检查');
    const paragraph = page.locator('.preview-panel p').filter({ hasText: text });
    await expect(paragraph).toHaveCSS('text-align', alignment);
    await expect(paragraph.locator('span[style*="color"]')).toHaveCSS('color', 'rgb(220, 38, 38)');
    await expect(colors).toBeDisabled();
    await expect(tools.getByRole('button', { name: '居中对齐', exact: true })).toBeDisabled();
    await mode('Markdown 源码').click();
  }
  await chooseColor('蓝色 #2563eb');
  await expect.poll(source).toContain('color:#2563eb');
  await expect(editor.locator('.cm-text-color').filter({ hasText: text })).toHaveCSS(
    'color',
    'rgb(37, 99, 235)',
  );
  await expect.poll(source).not.toContain('#dc2626');
  await chooseColor('默认颜色');
  await expect.poll(source).not.toContain('<span');
  await mode('撤销').click();
  await expect.poll(source).toContain('color:#2563eb');
  await colors.click();
  await palette().getByRole('button', { name: '自定义颜色', exact: true }).click();
  const custom = palette().getByRole('textbox', { name: 'HEX 色值', exact: true });
  const apply = palette().getByRole('button', { name: '应用颜色', exact: true });
  await custom.fill('#12');
  await expect(apply).toBeDisabled();
  await custom.fill('#087F8C');
  await expect.poll(source).toContain('color:#2563eb');
  await expect.poll(source).not.toContain('color:#087f8c');
  await apply.click();
  await expect.poll(source).toContain('color:#087f8c');
  await colors.focus();
  await page.keyboard.press('Enter');
  await expect(palette().getByRole('button', { name: '默认颜色', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette()).toBeHidden();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  await mode('阅读').click();
  await expect(
    page.locator('.preview-panel span[style*="color"]').filter({ hasText: text }),
  ).toHaveCSS('color', 'rgb(8, 127, 140)');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.save-state')).toContainText('已保存');
  const saved = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(saved).toContain('color:#087f8c');
  expect(saved).toContain('text-align:center');
  const share = await page.request.post(`/api/notes/${note.id}/share`, { headers, data: {} });
  expect(share.status()).toBe(200);
  const { token } = await share.json();
  const rendered = await (await page.request.get('/api/public/shares/' + token)).json();
  expect(rendered.html).toContain('color:#087f8c');
  expect(rendered.html).toContain('text-align:center');
  await page.reload();
  await mode('Markdown 源码').click();
  await expect(editor).toBeVisible();
  await expect.poll(source).toBe(saved);
  await mode('阅读').click();
  await expect(
    page.locator('.preview-panel span[style*="color"]').filter({ hasText: text }),
  ).toHaveCSS('color', 'rgb(8, 127, 140)');
  await page.screenshot({ path: info.outputPath('styled-document.png'), animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const publicContext = await context.browser()!.newContext({ baseURL: 'http://127.0.0.1:4179' });
  try {
    const publicPage = await publicContext.newPage();
    await publicPage.goto('/s/' + token);
    await expect(
      publicPage.locator('.markdown span[style*="color"]').filter({ hasText: text }),
    ).toHaveCSS('color', 'rgb(8, 127, 140)');
    await expect(publicPage.locator('.markdown p').filter({ hasText: text })).toHaveCSS(
      'text-align',
      'center',
    );
  } finally {
    await publicContext.close();
  }
  const highlighted = await page.request.post('/api/notes', {
    headers,
    data: {
      folderPath: '00-Inbox',
      fileName: `colored-heading-${crypto.randomUUID()}.md`,
      content:
        '# <span style="color:#dc2626">Colored title</span>\n\n<span style="color:#16a34a">[Colored link](https://example.com)</span>',
      requestId: crypto.randomUUID(),
    },
  });
  expect(highlighted.status()).toBe(201);
  await page.goto('/?note=' + (await highlighted.json()).id);
  await mode('Markdown 源码').click();
  await expect(editor).toBeVisible();
  await expect
    .poll(() =>
      editor.evaluate((el) => {
        const colors: Record<string, string> = {};
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.textContent === 'Colored title' || node.textContent === 'Colored link')
            colors[node.textContent] = getComputedStyle(node.parentElement!).color;
        }
        return colors;
      }),
    )
    .toEqual({ 'Colored title': 'rgb(220, 38, 38)', 'Colored link': 'rgb(22, 163, 74)' });
});

test('palette supports keyboard choices and stays inside a short viewport without changing canceled edits', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize({ width: info.project.name === 'mobile' ? 390 : 900, height: 390 });
  await page.goto('/');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const original = '# 调色板检查\n\n选中这段文字';
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `palette-${crypto.randomUUID()}.md`,
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
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  const button = page.getByRole('button', { name: '文字颜色', exact: true });
  await button.click();
  const palette = page.getByRole('dialog', { name: '文字颜色面板', exact: true });
  await expect(
    palette.getByRole('group', { name: '常用颜色', exact: true }).getByRole('button'),
  ).toHaveCount(36);
  await expect(async () => {
    const box = (await palette.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box.y + box.height).toBeLessThanOrEqual(390);
  }).toPass({ timeout: 3000 });
  await expect(palette.getByRole('button', { name: '默认颜色', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(button).toBeFocused();
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(original);
  await button.click();
  await expect(palette.getByRole('button', { name: '默认颜色', exact: true })).toBeFocused();
  await palette.getByRole('button', { name: '自定义颜色', exact: true }).click();
  await palette.getByRole('textbox', { name: 'HEX 色值', exact: true }).fill('#abc');
  await palette.getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(palette.getByRole('button', { name: '自定义颜色', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await button.click();
  await expect(palette.getByRole('button', { name: '默认颜色', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(palette.getByRole('button', { name: '黑色 #000000', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(editor).toContainText('color:#64748b');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor).not.toContainText('<span');
  await button.click();
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('button', { name: '默认颜色', exact: true })).toBeFocused();
  await expect(page.locator('.ant-popover').filter({ has: palette })).toHaveCSS('opacity', '1');
  await palette.screenshot({
    path: info.outputPath('text-color-palette.png'),
    animations: 'allow',
  });
});
