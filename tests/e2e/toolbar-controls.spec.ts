import { test, expect } from '../support/browser-test';
import { readFile } from 'node:fs/promises';
import type { Page, BrowserContext } from '@playwright/test';
import { expandFolderPath } from '../support/notebook-tree';
import { clickNoteAction } from '../support/note-actions';

test.use({ actionTimeout: 10000 });
const original = '# Toolbar audit\n\nSaved original.';
async function createNote(page: Page, context: BrowserContext, label: string) {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.goto('/');
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `${label}-${test.info().project.name}-${crypto.randomUUID()}.md`,
      content: original,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  const note = await response.json();
  await page.goto('/?note=' + note.id);
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect(page.locator('.save-state')).toContainText('已保存');
  return note as { id: string; relativePath: string; content: string };
}
async function source(page: Page) {
  return page
    .locator('.cm-content')
    .evaluate((el) =>
      Array.from(el.querySelectorAll('.cm-line'), (line) => line.textContent).join('\n'),
    );
}
async function replaceAndSelect(page: Page, content: string, mod = 'ControlOrMeta') {
  await expect(page.locator('.cm-content')).toBeEditable();
  await page.locator('.cm-content').click();
  await page.keyboard.press(mod + '+a');
  await page.keyboard.insertText(content);
  await page.keyboard.press(mod + '+a');
  await expect.poll(() => source(page)).toBe(content);
}
async function disk(page: Page, id: string) {
  return (await (await page.request.get('/api/notes/' + id)).json()).content as string;
}
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Markdown 格式', exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function navigateToReadyNote(
  page: Page,
  note: { id: string; relativePath: string },
  navigate: () => Promise<unknown>,
) {
  const loaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/notes/${note.id}/assets` &&
      response.request().method() === 'GET',
  );
  await navigate();
  await expect(page).toHaveURL(new RegExp('note=' + note.id));
  expect((await loaded).status()).toBe(200);
  await expect(page.locator('.document-title')).toHaveAttribute('title', note.relativePath);
  await expect(page.locator('.cm-content')).toBeEditable();
}

test('every formatting button and heading level survives undo, redo, preview and explicit saving', async ({
  page,
  context,
}) => {
  test.setTimeout(150000);
  const note = await createNote(page, context, 'all-format-buttons');
  const cases = [
    { name: '加粗', expected: '**Alpha beta**', selector: 'strong' },
    { name: '斜体', expected: '*Alpha beta*', selector: 'em' },
    { name: '删除线', expected: '~~Alpha beta~~', selector: 's' },
    { name: '行内代码', expected: '`Alpha beta`', selector: 'code' },
    { name: '引用', expected: '> Alpha beta', selector: 'blockquote' },
    { name: '无序列表', expected: '- Alpha beta', selector: 'ul > li' },
    { name: '有序列表', expected: '1. Alpha beta', selector: 'ol > li' },
    { name: '任务列表', expected: '- [ ] Alpha beta', selector: 'ul > li' },
    { name: '增加缩进', expected: '  Alpha beta', selector: 'p' },
    { name: '减少缩进', base: '  Alpha beta', expected: 'Alpha beta', selector: 'p' },
    { name: '插入链接', expected: '[Alpha beta](https://example.com)', selector: 'a' },
    { name: '代码块', expected: '```\nAlpha beta\n```', selector: 'pre code' },
    {
      name: '插入表格',
      expected: '\n| 标题 1 | 标题 2 |\n| --- | --- |\n| 内容 | 内容 |\n',
      selector: 'table',
      preview: '标题 1',
    },
    { name: '分隔线', expected: '\n---\n', selector: 'hr' },
    ...Array.from({ length: 6 }, (_, level) => ({
      name: `段落格式 ${level}`,
      level,
      base: level ? 'Alpha beta' : '## Alpha beta',
      expected: level ? '#'.repeat(level) + ' Alpha beta' : 'Alpha beta',
      selector: level ? 'h' + level : 'p',
    })),
  ];
  let lastSaved = original;
  for (const item of cases)
    await test.step(item.name, async () => {
      const base = item.base || 'Alpha beta';
      await replaceAndSelect(page, base);
      if ('level' in item)
        await toolbar(page)
          .getByRole('combobox', { name: '段落格式', exact: true })
          .selectOption(String(item.level));
      else await toolbar(page).getByRole('button', { name: item.name, exact: true }).click();
      await expect.poll(() => source(page)).toBe(item.expected);
      await button(page, '撤销').click();
      await expect.poll(() => source(page)).toBe(base);
      await button(page, '重做').click();
      await expect.poll(() => source(page)).toBe(item.expected);
      await button(page, '预览').click();
      const rendered = page.locator('.preview-panel .markdown').locator(item.selector);
      await expect(rendered).toBeVisible();
      if (item.selector !== 'hr')
        await expect(rendered).toContainText('preview' in item ? item.preview! : 'Alpha beta');
      if (item.selector === 'a')
        await expect(rendered).toHaveAttribute('href', 'https://example.com');
      await expect(button(page, '撤销')).toBeDisabled();
      await expect(button(page, '重做')).toBeDisabled();
      for (const control of await toolbar(page).locator('button, select, input').all())
        await expect(control).toBeDisabled();
      expect(await disk(page, note.id)).toBe(lastSaved);
      await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.locator('.save-state')).toContainText('已保存');
      expect(await disk(page, note.id)).toBe(item.expected);
      await button(page, '编辑').click();
      await button(page, '撤销').click();
      await expect.poll(() => source(page)).toBe(base);
      await expect(page.locator('.save-state')).toContainText('未保存');
      expect(await disk(page, note.id)).toBe(item.expected);
      await button(page, '重做').click();
      await expect.poll(() => source(page)).toBe(item.expected);
      await expect(page.locator('.save-state')).toContainText('已保存');
      lastSaved = item.expected;
    });
  expect(await disk(page, note.id)).toBe(lastSaved);
  const formatted = await source(page);
  await page.reload();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect.poll(() => source(page)).toBe(formatted);
  await expect(button(page, '撤销')).toBeDisabled();
});

async function checkShortcuts(page: Page, context: BrowserContext, mod: string) {
  const note = await createNote(page, context, 'keyboard-shortcuts');
  await replaceAndSelect(page, 'Alpha beta', mod);
  for (const [key, expected] of [
    ['b', '**Alpha beta**'],
    ['i', '*Alpha beta*'],
  ]) {
    await page.keyboard.press(mod + '+' + key);
    await expect.poll(() => source(page)).toBe(expected);
    await page.keyboard.press(mod + '+' + key);
    await expect.poll(() => source(page)).toBe('Alpha beta');
  }
  await page.keyboard.press(mod + '+k');
  await expect.poll(() => source(page)).toBe('[Alpha beta](https://example.com)');
  await page.keyboard.insertText('https://example.org/audit');
  await expect.poll(() => source(page)).toBe('[Alpha beta](https://example.org/audit)');
  await page.keyboard.press(mod + '+z');
  await expect.poll(() => source(page)).toBe('[Alpha beta](https://example.com)');
  await page.keyboard.press(mod + '+z');
  await expect.poll(() => source(page)).toBe('Alpha beta');
  await page.keyboard.press(mod + '+Shift+Z');
  await expect.poll(() => source(page)).toBe('[Alpha beta](https://example.com)');
  await page.keyboard.press(mod + '+Shift+Z');
  await expect.poll(() => source(page)).toBe('[Alpha beta](https://example.org/audit)');
  if (mod === 'ControlOrMeta') {
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('Control+y');
    await expect.poll(() => source(page)).toBe('[Alpha beta](https://example.org/audit)');
  }
  expect(await disk(page, note.id)).toBe(original);
  let saves = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/api/notes/' + note.id)) saves++;
  });
  await button(page, '分屏').click();
  await expect(page.locator('.editor-panel')).toBeVisible();
  await expect(page.locator('.preview-panel a')).toHaveAttribute(
    'href',
    'https://example.org/audit',
  );
  await page.locator('.cm-content').click();
  await page.keyboard.press(mod + '+s');
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect(saves).toBe(1);
  expect(await disk(page, note.id)).toBe('[Alpha beta](https://example.org/audit)');
  await page.keyboard.press(mod + '+s');
  expect(await disk(page, note.id)).toBe('[Alpha beta](https://example.org/audit)');
  expect(saves).toBe(1);
}
test('Ctrl shortcuts cover formatting, link URL replacement, both redo keys, split preview and saving', async ({
  page,
  context,
}) => {
  await checkShortcuts(page, context, 'ControlOrMeta');
});
test('Cmd shortcut branch covers formatting, undo/redo and saving', async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Desktop platform branch simulation');
  await context.addInitScript(() =>
    Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }),
  );
  await checkShortcuts(page, context, 'Meta');
});

test('Windows shortcut branch covers Ctrl+Shift+Z and Ctrl+Y redo aliases', async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Desktop platform branch simulation');
  await context.addInitScript(() =>
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }),
  );
  await checkShortcuts(page, context, 'ControlOrMeta');
});

test('toolbar arrow/Home/End navigation skips disabled code-context controls and preview is read-only', async ({
  page,
  context,
}) => {
  await createNote(page, context, 'toolbar-key-navigation');
  const tools = toolbar(page),
    bold = tools.getByRole('button', { name: '加粗', exact: true });
  await bold.focus();
  await page.keyboard.press('ArrowRight');
  await expect(tools.getByRole('button', { name: '斜体', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(bold).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tools.getByRole('combobox', { name: '段落格式', exact: true })).toBeFocused();
  await bold.focus();
  await page.keyboard.press('End');
  await expect(tools.getByRole('button', { name: '上传附件', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tools.getByRole('combobox', { name: '段落格式', exact: true })).toBeFocused();
  await replaceAndSelect(page, 'literal');
  await tools.getByRole('button', { name: '行内代码', exact: true }).click();
  for (const name of ['加粗', '斜体', '删除线', '插入链接'])
    await expect(tools.getByRole('button', { name, exact: true })).toBeDisabled();
  const quote = tools.getByRole('button', { name: '引用', exact: true });
  await quote.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tools.getByRole('button', { name: '行内代码', exact: true })).toBeFocused();
  await button(page, '预览').click();
  const before = await page.locator('.preview-panel .markdown').innerHTML();
  await page.keyboard.press('ControlOrMeta+b');
  expect(await page.locator('.preview-panel .markdown').innerHTML()).toBe(before);
  await button(page, '编辑').click();
  await expect.poll(() => source(page)).toBe('`literal`');
});

test('upload button handles PNG and PDF, supports undo/redo and saves from preview without duplication', async ({
  page,
  context,
}) => {
  const note = await createNote(page, context, 'toolbar-uploads');
  const fixtures = [
    {
      name: 'toolbar.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
        'base64',
      ),
    },
    {
      name: 'toolbar.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\nfixture\n%%EOF'),
    },
  ];
  for (const file of fixtures) {
    const before = await source(page);
    const chooser = page.waitForEvent('filechooser');
    await toolbar(page).getByRole('button', { name: '上传附件', exact: true }).click();
    await (await chooser).setFiles(file);
    await expect.poll(() => source(page)).toContain(file.name);
    const after = await source(page);
    expect(await disk(page, note.id)).toBe(original);
    await button(page, '撤销').click();
    await expect.poll(() => source(page)).toBe(before);
    await button(page, '重做').click();
    await expect.poll(() => source(page)).toBe(after);
  }
  const final = await source(page);
  await button(page, '预览').click();
  const image = page.locator('.preview-panel img');
  await expect(image).toBeVisible();
  expect(await image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const pdf = page.locator('.preview-panel a').filter({ hasText: 'toolbar.pdf' });
  await expect(pdf).toBeVisible();
  const asset = await page.request.get((await pdf.getAttribute('href'))!);
  expect(asset.status()).toBe(200);
  expect(asset.headers()['content-type']).toContain('application/pdf');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect(await disk(page, note.id)).toBe(final);
  await page.reload();
  await expect(page.locator('.cm-content')).toBeVisible();
  await expect.poll(() => source(page)).toBe(final);
  expect(final.match(/toolbar.png/g)).toHaveLength(1);
  expect(final.match(/toolbar.pdf/g)).toHaveLength(1);
});

test('top navigation, share and more-actions preserve drafts and expose all built-in actions', async ({
  page,
  context,
}, info) => {
  test.setTimeout(90000);
  const a = await createNote(page, context, 'toolbar-nav-a');
  const b = await createNote(page, context, 'toolbar-nav-b');
  await page.goto('/?note=' + a.id);
  await expect(page.locator('.cm-content')).toContainText('Saved original.');
  if (info.project.name === 'mobile') await button(page, '打开侧栏').click();
  await expandFolderPath(page, '00-Inbox');
  await navigateToReadyNote(page, b, () =>
    page
      .locator('.tree-scroll')
      .getByRole('button', { name: b.relativePath.split('/').at(-1), exact: true })
      .click(),
  );
  await navigateToReadyNote(page, a, () =>
    info.project.name === 'mobile' ? page.goBack() : button(page, '后退').click(),
  );
  await navigateToReadyNote(page, b, () =>
    info.project.name === 'mobile' ? page.goForward() : button(page, '前进').click(),
  );
  await replaceAndSelect(page, '# Guarded draft');
  if (info.project.name === 'mobile') await page.goBack();
  else await button(page, '后退').click();
  await expect(
    page.getByText('离开前，请选择如何处理当前编辑内容。', { exact: true }),
  ).toBeVisible();
  await button(page, '取消').click();
  await expect(page).toHaveURL(new RegExp('note=' + b.id));
  await expect.poll(() => source(page)).toBe('# Guarded draft');
  await page.locator('.toolbar').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('已保存');
  if (info.project.name === 'desktop') {
    await button(page, '收起侧栏').click();
    await expect(page.locator('.sidebar')).toBeHidden();
    await button(page, '展开侧栏').click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await button(page, '打开目录 00-Inbox').click();
    await expect(page.locator('.folder-view')).toBeVisible();
    await page
      .locator('.folder-view')
      .getByRole('button', { name: b.relativePath.split('/').at(-1), exact: true })
      .click();
  }
  await page.setViewportSize({ width: 743, height: 604 });
  await button(page, '分屏').click();
  await button(page, '章节目录').click();
  await page
    .getByRole('navigation', { name: '本文章节', exact: true })
    .getByRole('button', { name: 'Guarded draft', exact: true })
    .click();
  await expect(page).toHaveURL(/#L1$/);
  await button(page, '分享').click();
  await button(page, '生成分享链接').click();
  await expect(page.getByRole('textbox', { name: '公开链接', exact: true })).not.toHaveValue('');
  await button(page, '取消分享').click();
  await button(page, '完成').click();
  await button(page, '更多操作').click();
  for (const name of ['移动或重命名', '下载 Markdown', '历史版本', '插入图片或 PDF', '删除笔记'])
    await expect(
      page
        .getByRole('dialog', { name: '笔记操作', exact: true })
        .getByRole('button', { name, exact: true }),
    ).toBeVisible();
  const numbers = page.getByRole('checkbox', { name: '显示行号', exact: true });
  await numbers.check();
  await expect(page.locator('.cm-gutters')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(button(page, '更多操作')).toBeFocused();
  const download = page.waitForEvent('download');
  await clickNoteAction(page, '下载 Markdown');
  const file = await download;
  expect(file.suggestedFilename()).toBe(b.relativePath.split('/').at(-1));
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toBe('# Guarded draft');
  await clickNoteAction(page, '历史版本');
  await expect(page.locator('.n-modal:visible')).toContainText('历史版本');
  await expect(page.locator('.n-modal:visible')).toHaveCSS('opacity', '1');
  await page.keyboard.press('Escape');
  await expect(page.locator('.n-modal:visible')).toHaveCount(0);
  await clickNoteAction(page, '移动或重命名');
  await expect(page.getByRole('textbox', { name: '文件名', exact: true })).toBeVisible();
  await button(page, '取消').click();
  await expect(page.locator('.n-modal:visible')).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser');
  await clickNoteAction(page, '插入图片或 PDF');
  await (await chooser).setFiles([]);
  await clickNoteAction(page, '删除笔记');
  await expect(page.getByText('移入回收站？', { exact: true })).toBeVisible();
  await button(page, '取消').click();
  expect(await disk(page, b.id)).toBe('# Guarded draft');
  await expect(page.locator('.n-modal:visible')).toHaveCount(0);
  await button(page, '返回笔记本').click();
  await expect(page.getByRole('heading', { name: '选择一篇笔记', exact: true })).toBeVisible();
});
