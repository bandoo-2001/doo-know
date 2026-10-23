import { test, expect } from '../support/browser-test';
import type { Locator, Page } from '@playwright/test';
import { openDocumentNote, saveDocument } from '../support/document-editor';

test.use({ actionTimeout: 10000 });

const editorFor = (page: Page) => page.getByRole('textbox', { name: '文档正文', exact: true });
const formatFor = (page: Page) => page.getByRole('toolbar', { name: '正文格式', exact: true });
const imageFile = (name: string) => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII=',
    'base64',
  ),
});

async function uploadImage(page: Page, name: string) {
  const choosing = page.waitForEvent('filechooser');
  await formatFor(page).getByRole('button', { name: '上传附件', exact: true }).click();
  await (await choosing).setFiles(imageFile(name));
  await expect(editorFor(page).getByRole('img', { name, exact: true })).toHaveAttribute(
    'src',
    /^\/api\/assets\//,
  );
}

async function openOutline(page: Page) {
  const trigger = page.getByRole('button', { name: '章节目录', exact: true });
  if ((await trigger.isVisible()) && (await trigger.getAttribute('aria-expanded')) !== 'true')
    await trigger.click();
  return page.getByRole('navigation', { name: '本文章节', exact: true }).filter({ visible: true });
}

async function expectNoOverlap(first: Locator, second: Locator) {
  const a = await first.boundingBox(),
    b = await second.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(
    a!.x + a!.width <= b!.x + 1 ||
      b!.x + b!.width <= a!.x + 1 ||
      a!.y + a!.height <= b!.y + 1 ||
      b!.y + b!.height <= a!.y + 1,
  ).toBe(true);
}

async function expectToolsNear(tools: Locator, object: Locator) {
  await expect(tools).toBeVisible();
  await expect
    .poll(async () => {
      const a = await tools.boundingBox(),
        b = await object.boundingBox();
      if (!a || !b) return Infinity;
      return Math.min(Math.abs(a.y + a.height - b.y), Math.abs(b.y + b.height - a.y));
    })
    .toBeLessThanOrEqual(36);
}

test('章节目录将光标放到所选标题，而不是前一段', async ({ page, context }) => {
  await openDocumentNote(page, context, '# 第一章\n\n上一段正文。\n\n## 第二章\n\n下一段正文。');
  const outline = await openOutline(page);
  await outline.getByRole('button', { name: '第二章', exact: true }).click();
  await expect(editorFor(page)).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const node = window.getSelection()?.anchorNode;
        const element = node instanceof Element ? node : node?.parentElement;
        return element?.closest('h1,h2,h3,h4,h5')?.textContent || '';
      }),
    )
    .toBe('第二章');
  await page.keyboard.press('End');
  await page.keyboard.insertText('已定位');
  await expect(editorFor(page).locator('h2')).toHaveText('第二章已定位');
  await expect(editorFor(page).locator('p').first()).toHaveText('上一段正文。');
});

test('普通段落禁用无作用的列表缩进，进入列表后可缩进子项', async ({ page, context }) => {
  await openDocumentNote(page, context, '普通段落\n\n- 第一项\n- 第二项');
  const editor = editorFor(page),
    toolbar = formatFor(page);
  await editor.locator('p').first().click();
  for (const name of ['增加缩进', '减少缩进'])
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeDisabled();
  await editor.locator('li p').last().click();
  await expect(toolbar.getByRole('button', { name: '增加缩进', exact: true })).toBeEnabled();
  await toolbar.getByRole('button', { name: '增加缩进', exact: true }).click();
  await expect(editor.locator('li li')).toHaveText('第二项');
  await expect(toolbar.getByRole('button', { name: '减少缩进', exact: true })).toBeEnabled();
});

test('代码块禁用不可用的颜色、对齐和标题格式', async ({ page, context }) => {
  await openDocumentNote(page, context, '```js\nconst value = 1;\n```');
  await editorFor(page).locator('pre code').click();
  const toolbar = formatFor(page);
  await expect(toolbar.getByRole('combobox', { name: '段落格式', exact: true })).toBeDisabled();
  await expect(toolbar.getByRole('button', { name: '文字颜色', exact: true })).toBeDisabled();
  for (const name of ['左对齐', '居中对齐', '右对齐'])
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeDisabled();
});

test('插入表格先选择行列数，取消不修改正文，插入后可一次撤销', async ({ page, context }) => {
  await openDocumentNote(page, context, '保留正文');
  const editor = editorFor(page);
  await editor.click();
  await page.keyboard.press('End');
  await formatFor(page).getByRole('button', { name: '插入表格', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: '插入表格', exact: true });
  await expect(chooser).toBeVisible();
  await chooser.getByRole('spinbutton', { name: '表格行数', exact: true }).fill('4');
  await chooser.getByRole('spinbutton', { name: '表格列数', exact: true }).fill('2');
  await page.keyboard.press('Escape');
  await expect(chooser).toBeHidden();
  await expect(editor.locator('table')).toHaveCount(0);
  await expect(editor).toHaveText('保留正文');
  await formatFor(page).getByRole('button', { name: '插入表格', exact: true }).click();
  await chooser.getByRole('spinbutton', { name: '表格行数', exact: true }).fill('4');
  await chooser.getByRole('spinbutton', { name: '表格列数', exact: true }).fill('2');
  await chooser.getByRole('button', { name: '插入表格', exact: true }).click();
  await expect(editor.locator('tr')).toHaveCount(4);
  await expect(editor.locator('tr').first().locator('th')).toHaveCount(2);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('table')).toHaveCount(0);
  await expect(editor).toHaveText('保留正文');
});

test('无效链接错误显示在对话框地址字段附近，并保留输入供修正', async ({ page, context }) => {
  await openDocumentNote(page, context, '保留正文');
  await editorFor(page).click();
  await page.getByRole('button', { name: '插入链接', exact: true }).click();
  const dialog = page.locator('.editor-dialog:visible');
  await dialog.getByRole('textbox', { name: '链接文字', exact: true }).fill('错误链接');
  const address = dialog.getByRole('textbox', { name: '链接地址', exact: true });
  await address.fill('javascript:alert(1)');
  await dialog.getByRole('button', { name: '保存链接', exact: true }).click();
  await expect(dialog).toBeVisible();
  const error = dialog.getByRole('alert');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/链接|地址|https/i);
  await expect(address).toHaveValue('javascript:alert(1)');
  await expect(editorFor(page).locator('a')).toHaveCount(0);
  const fieldBox = (await address.boundingBox())!,
    errorBox = (await error.boundingBox())!;
  expect(Math.abs(errorBox.y - fieldBox.y)).toBeLessThan(180);
});

test('表格操作条不遮挡相邻标题、正文和正在编辑的单元格', async ({ page, context }) => {
  await openDocumentNote(
    page,
    context,
    '# 紧邻标题\n\n| A | B |\n| --- | --- |\n| 编辑单元格 | 保留 |\n\n紧邻正文。',
  );
  const editor = editorFor(page),
    cell = editor.locator('td p').first();
  await cell.click();
  const tools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  await expect(tools).toBeVisible();
  await expectNoOverlap(tools, editor.locator('h1'));
  await expectNoOverlap(tools, editor.locator(':scope > p').last());
  await expectNoOverlap(tools, cell);
  await page.keyboard.press('End');
  await page.keyboard.insertText('继续编辑');
  await expect(cell).toHaveText('编辑单元格继续编辑');
});

for (const kind of ['code', 'image', 'link'] as const) {
  test(`${kind} 操作条跟随文档中的选中对象`, async ({ page, context }) => {
    const object =
      kind === 'code'
        ? '```js\nconst target = 1;\n```'
        : kind === 'image'
          ? '![目标图片](https://example.invalid/target.png)'
          : '[目标链接](https://example.invalid/target)';
    await openDocumentNote(
      page,
      context,
      '# 开头\n\n' + '留出距离的正文。\n\n'.repeat(9) + object + '\n\n末尾正文。',
    );
    const editor = editorFor(page);
    const target =
      kind === 'image'
        ? editor.getByRole('img', { name: '目标图片', exact: true })
        : editor.locator(kind === 'code' ? 'pre' : 'a');
    await target.click();
    const tools = page.getByRole('group', {
      name: kind === 'code' ? '代码块设置' : kind === 'image' ? '图片设置' : '链接操作',
      exact: true,
    });
    await expectToolsNear(tools, target);
    await expectNoOverlap(tools, target);
  });
}

test('表格中的链接和图片显示自己的操作条，普通单元格恢复表格操作', async ({ page, context }) => {
  await openDocumentNote(
    page,
    context,
    '| [资源](https://example.invalid/docs) | ![图示](assets/diagram.png) |\n' +
      '| --- | --- |\n| 普通单元格 | 保留内容 |',
  );
  const editor = editorFor(page);
  const tableTools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  for (const [target, name] of [
    [editor.getByRole('link', { name: '资源', exact: true }), '链接操作'],
    [editor.getByRole('img', { name: '图示', exact: true }), '图片设置'],
  ] as const) {
    await target.click();
    const tools = page.getByRole('group', { name, exact: true });
    await expectToolsNear(tools, target);
    await expectNoOverlap(tools, target);
    await expect(tableTools).toBeHidden();
  }
  await editor.getByText('普通单元格', { exact: true }).click();
  await expect(tableTools).toBeVisible();
  await expect(page.getByRole('group', { name: '图片设置', exact: true })).toBeHidden();
  await expect(
    formatFor(page).getByRole('combobox', { name: '段落格式', exact: true }),
  ).toBeDisabled();
  for (const name of ['代码块', '引用', '无序列表', '有序列表', '任务列表', '分隔线'])
    await expect(formatFor(page).getByRole('button', { name, exact: true })).toBeDisabled();
});

test('窄屏编辑模式独占一行，章节目录使用可操作的弹出层', async ({ page, context }, info) => {
  const width = info.project.name === 'mobile' ? 390 : 743;
  await page.setViewportSize({ width, height: 700 });
  await openDocumentNote(page, context, '# 第一章\n\n正文。\n\n## 第二章\n\n章节正文。');
  const mode = page.getByRole('button', { name: '文档编辑', exact: true });
  const formats = formatFor(page);
  await expect(formats).toBeVisible();
  const modesBox = (await mode.boundingBox())!,
    formatsBox = (await formats.boundingBox())!;
  expect(modesBox.y + modesBox.height).toBeLessThanOrEqual(formatsBox.y + 1);
  await expect(page.locator('.document-outline')).toBeHidden();
  const trigger = page.getByRole('button', { name: '章节目录', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const popup = page.locator('.outline-popup:visible');
  await expect(popup).toBeVisible();
  const popupBox = (await popup.boundingBox())!;
  expect(popupBox.x).toBeGreaterThanOrEqual(0);
  expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(width + 1);
  await popup.getByRole('button', { name: '第二章', exact: true }).click();
  await expect(popup).toBeHidden();
  await expect(editorFor(page)).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('显示行号只出现在 Markdown 源码模式的更多操作中', async ({ page, context }) => {
  await openDocumentNote(page, context, '# 文档\n\n正文。');
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '笔记操作', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '显示行号', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('checkbox', { name: '显示行号', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cm-gutters')).toBeVisible();
});

test('宽屏章节目录可收起并展开，保留当前正文和草稿', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDocumentNote(page, context, '# 章节\n\n保留正文。');
  const editor = editorFor(page),
    trigger = page.getByRole('button', { name: '章节目录', exact: true });
  await editor.locator('p').click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('当前草稿');
  await expect(page.locator('.document-outline')).toBeVisible();
  const surface = page.locator('.document-surface');
  const before = (await surface.boundingBox())!.width;
  await trigger.click();
  await expect(page.locator('.document-outline')).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect((await surface.boundingBox())!.width).toBeGreaterThan(before);
  await trigger.click();
  await expect(page.locator('.document-outline')).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(editor).toContainText('保留正文。当前草稿');
  await expect(page.locator('.save-state')).toContainText('未保存');
});

test('复制代码只复制当前代码块内容，不修改正文', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const raw = '```typescript\nconst copied = 42;\nconsole.log(copied);\n```';
  const note = await openDocumentNote(page, context, raw);
  await editorFor(page).locator('pre code').click();
  const copy = page.getByRole('button', { name: '复制代码', exact: true });
  await copy.click();
  await expect(copy).toContainText('已复制');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('const copied = 42;\nconsole.log(copied);');
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(raw);
});

test('图片预览缩放只影响查看，关闭后 Markdown 和保存状态保持不变', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '图片前的正文');
  await editorFor(page).click();
  await page.keyboard.press('End');
  await uploadImage(page, 'preview.png');
  await saveDocument(page);
  const original = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  const image = editorFor(page).getByRole('img', { name: 'preview.png', exact: true });
  await image.click();
  await page.getByRole('button', { name: '预览图片', exact: true }).click();
  const preview = page.locator('.editor-dialog:visible');
  await expect(preview).toContainText('图片预览');
  await expect(preview.locator('img')).toHaveAttribute('src', (await image.getAttribute('src'))!);
  const zoom = preview.getByRole('slider', { name: '图片缩放', exact: true });
  await zoom.focus();
  const before = await zoom.inputValue();
  await page.keyboard.press('ArrowRight');
  await expect(zoom).not.toHaveValue(before);
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(page.locator('.save-state')).toContainText('已保存');
  await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
  const source = await page
    .locator('.cm-content')
    .evaluate((element) =>
      [...element.querySelectorAll('.cm-line')].map((line) => line.textContent).join('\n'),
    );
  expect(source).toBe(original);
});

test('上传期间显示文件名并禁用重复入口，失败后可重试原文件', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '上传前正文');
  const editor = editorFor(page);
  await editor.click();
  await page.keyboard.press('End');
  let release!: () => void,
    first = true;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/notes/${note.id}/assets`, async (route) => {
    if (route.request().method() === 'POST' && first) {
      first = false;
      await hold;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '附件暂不可用' }),
      });
    } else await route.continue();
  });
  const choosing = page.waitForEvent('filechooser');
  await formatFor(page).getByRole('button', { name: '上传附件', exact: true }).click();
  await (await choosing).setFiles(imageFile('retry-image.png'));
  try {
    await expect(
      page.getByRole('status').filter({ hasText: '上传中 · retry-image.png' }),
    ).toBeVisible();
    await expect(
      formatFor(page).getByRole('button', { name: '上传附件', exact: true }),
    ).toBeDisabled();
    await expect(editor).toHaveText('上传前正文');
  } finally {
    release();
  }
  await expect(
    page.getByRole('alert').filter({ hasText: 'retry-image.png 上传失败' }),
  ).toBeVisible();
  await expect(
    formatFor(page).getByRole('button', { name: '上传附件', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '重试上传', exact: true }).click();
  await expect(editor.locator('img[src]')).toHaveCount(1);
  await expect(editor.getByRole('img', { name: 'retry-image.png', exact: true })).toHaveAttribute(
    'src',
    /^\/api\/assets\//,
  );
  await expect(page.getByRole('button', { name: '重试上传', exact: true })).toHaveCount(0);
  await saveDocument(page);
  const saved = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(saved.match(/!\[retry-image\.png\]/g)).toHaveLength(1);
});

test('替换图片上传时正文发生修改，则保留原图并提供明确插入入口', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '保留正文');
  const editor = editorFor(page);
  await editor.click();
  await page.keyboard.press('End');
  await uploadImage(page, 'original.png');
  await saveDocument(page);
  const image = editor.getByRole('img', { name: 'original.png', exact: true });
  const originalSrc = await image.getAttribute('src');
  await image.click();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/notes/${note.id}/assets`, async (route) => {
    if (route.request().method() === 'POST') await hold;
    await route.continue();
  });
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '替换图片', exact: true }).click();
  await (await choosing).setFiles(imageFile('replacement.png'));
  try {
    await expect(
      page.getByRole('status').filter({ hasText: '上传中 · replacement.png' }),
    ).toBeVisible();
    await editor.locator('p').filter({ hasText: '保留正文' }).click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.insertText('新增内容');
  } finally {
    release();
  }
  await expect(page.getByRole('button', { name: '插入已上传附件', exact: true })).toBeVisible();
  await expect(image).toHaveAttribute('src', originalSrc!);
  await expect(editor.locator('img[src]')).toHaveCount(1);
  await saveDocument(page);
  const saved = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  expect(saved).toContain('新增内容保留正文');
  expect(saved).toContain('original.png');
  expect(saved).not.toContain('replacement.png');
});

test('替换图片仍修改最初选中的图片，移动光标后不误替换其他图片', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '第一段\n\n第二段');
  const editor = editorFor(page);
  await editor.locator('p').first().click();
  await page.keyboard.press('End');
  await uploadImage(page, 'first-image.png');
  await editor.locator('p').filter({ hasText: '第二段' }).click();
  await page.keyboard.press('End');
  await uploadImage(page, 'second-image.png');
  await saveDocument(page);
  const first = editor.getByRole('img', { name: 'first-image.png', exact: true });
  const second = editor.getByRole('img', { name: 'second-image.png', exact: true });
  const oldFirst = await first.getAttribute('src'),
    oldSecond = await second.getAttribute('src');
  await first.click();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/notes/${note.id}/assets`, async (route) => {
    if (route.request().method() === 'POST') await hold;
    await route.continue();
  });
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '替换图片', exact: true }).click();
  await (await choosing).setFiles(imageFile('new-first.png'));
  try {
    await expect(
      page.getByRole('status').filter({ hasText: '上传中 · new-first.png' }),
    ).toBeVisible();
    await second.click();
  } finally {
    release();
  }
  await expect(first).not.toHaveAttribute('src', oldFirst!);
  await expect(first).toHaveAttribute('src', /^\/api\/assets\//);
  await expect(second).toHaveAttribute('src', oldSecond!);
  await expect(editor.locator('img[src]')).toHaveCount(2);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(first).toHaveAttribute('src', oldFirst!);
  await expect(second).toHaveAttribute('src', oldSecond!);
});

test('替换图片选择 PDF 时保留原图，并提供附件的明确插入入口', async ({ page, context }) => {
  const note = await openDocumentNote(page, context, '保留原图和正文');
  const editor = editorFor(page);
  await editor.click();
  await page.keyboard.press('End');
  await uploadImage(page, 'keep-original.png');
  await saveDocument(page);
  const savedBefore = (await (await page.request.get('/api/notes/' + note.id)).json()).content;
  const image = editor.getByRole('img', { name: 'keep-original.png', exact: true });
  const originalSrc = await image.getAttribute('src');
  await image.click();
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '替换图片', exact: true }).click();
  // Native picker filtering is advisory; choosing a real PDF must never turn it into an image.
  await (
    await choosing
  ).setFiles({
    name: 'replacement-document.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nfixture\n%%EOF'),
  });
  await expect(page.getByRole('button', { name: '插入已上传附件', exact: true })).toBeVisible();
  await expect(
    page.getByText('所选附件不是受支持的图片，原图片已保留，可选择位置后插入附件链接', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(image).toHaveAttribute('src', originalSrc!);
  await expect(editor.locator('img[src]')).toHaveCount(1);
  await expect(editor.locator('a')).toHaveCount(0);
  await expect(page.locator('.save-state')).toContainText('已保存');
  expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(
    savedBefore,
  );
  await editor.locator('p').filter({ hasText: '保留原图和正文' }).click();
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: '插入已上传附件', exact: true }).click();
  await expect(
    editor.getByRole('link', { name: 'replacement-document.pdf', exact: true }),
  ).toBeVisible();
  await expect(image).toHaveAttribute('src', originalSrc!);
  await expect(editor.locator('img[src]')).toHaveCount(1);
});

for (const kind of ['image', 'link'] as const) {
  test(`长段落末尾的 ${kind} 操作条紧邻对象，打开后原文仍是同一段`, async ({ page, context }) => {
    const paragraph = '连续阅读的长段落需要自然换行并保持原文结构。'.repeat(75);
    const object =
      kind === 'image'
        ? '![段尾图片](assets/paragraph-image.png)'
        : '[段尾资源](https://example.invalid/paragraph)';
    const raw = paragraph + object;
    const note = await openDocumentNote(page, context, raw);
    const editor = editorFor(page);
    const target =
      kind === 'image'
        ? editor.getByRole('img', { name: '段尾图片', exact: true })
        : editor.getByRole('link', { name: '段尾资源', exact: true });
    await expect(editor.locator(':scope > p')).toHaveCount(1);
    await target.click();
    const tools = page.getByRole('group', {
      name: kind === 'image' ? '图片设置' : '链接操作',
      exact: true,
    });
    await expectToolsNear(tools, target);
    await expectNoOverlap(tools, target);
    await expect(editor.locator(':scope > p')).toHaveCount(1);
    await expect(page.locator('.save-state')).toContainText('已保存');
    expect((await (await page.request.get('/api/notes/' + note.id)).json()).content).toBe(raw);
    await page.getByRole('button', { name: 'Markdown 源码', exact: true }).click();
    const source = page.locator('.cm-content');
    await expect(source.locator('.cm-line')).toHaveCount(1);
    await expect(source).toHaveText(raw);
    await expect(page.locator('.save-state')).toContainText('已保存');
  });
}
