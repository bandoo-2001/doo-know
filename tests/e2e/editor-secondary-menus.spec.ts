import { test, expect } from '../support/browser-test';
import type { Locator, Page } from '@playwright/test';
import { openDocumentNote } from '../support/document-editor';

async function expectTableToolsAbove(page: Page, table: Locator) {
  const tools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  await expect(tools).toBeVisible();
  await expect
    .poll(async () => {
      const toolbarBox = await tools.boundingBox();
      const tableBox = await table.boundingBox();
      return toolbarBox && tableBox ? tableBox.y - toolbarBox.y - toolbarBox.height : -1000;
    })
    .toBeGreaterThanOrEqual(-1);
  await expect
    .poll(async () => {
      const toolbarBox = await tools.boundingBox();
      const tableBox = await table.boundingBox();
      return toolbarBox && tableBox ? tableBox.y - toolbarBox.y - toolbarBox.height : 1000;
    })
    .toBeLessThanOrEqual(28);
  const toolbarBox = (await tools.boundingBox())!;
  const editorBox = (await page.locator('.document-editor').boundingBox())!;
  expect(toolbarBox.x).toBeGreaterThanOrEqual(Math.max(editorBox.x, 0) - 1);
  expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(
    Math.min(editorBox.x + editorBox.width, page.viewportSize()!.width) + 1,
  );
  expect(toolbarBox.y).toBeGreaterThanOrEqual(editorBox.y - 1);
  expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(editorBox.y + editorBox.height + 1);
}

test('段落菜单支持键盘浏览、保留选区、关闭与撤销', async ({ page, context }, info) => {
  await openDocumentNote(page, context, 'Alpha beta\n\n保持正文');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  await editor.locator('p').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('Alpha beta');
  const format = page.getByRole('combobox', { name: '段落格式', exact: true });
  await format.click();
  const list = page.getByRole('listbox', { name: '段落样式', exact: true });
  await expect(list).toBeVisible();
  await page.screenshot({ path: info.outputPath('heading-menu.png'), animations: 'disabled' });
  await expect(list.getByRole('option', { name: '正文', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(format).toBeFocused();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('Alpha beta');
  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await page.keyboard.press('End');
  await expect(list.getByRole('option', { name: '标题 5', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(list.getByRole('option', { name: '正文', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(list.getByRole('option', { name: '标题 1', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(list).toBeHidden();
  await expect(editor.locator('h1')).toHaveText('Alpha beta');
  await expect(editor.locator('p')).toHaveText('保持正文');
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('Alpha beta');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await expect(editor.locator('h1 strong')).toHaveText('Alpha beta');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('strong')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('h1')).toHaveCount(0);
  await expect(editor.locator('p')).toHaveText(['Alpha beta', '保持正文']);
});

test('表格工具紧邻当前表格、随滚动保持边界并只修改当前表格', async ({ page, context }, info) => {
  await openDocumentNote(
    page,
    context,
    [
      '# 表格操作验收',
      '前言一',
      '前言二',
      '前言三',
      '| 第一表头 | B |\n| --- | --- |\n| 第一内容 | C |',
      '两个表格之间的正文',
      '| 第二表头 | D |\n| --- | --- |\n| 第二内容 | E |',
      ...Array.from({ length: 18 }, (_, i) => `末尾段落 ${i + 1}`),
    ].join('\n\n'),
  );
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  const first = editor.locator('table').nth(0);
  const second = editor.locator('table').nth(1);
  const tools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  await first.getByText('第一内容', { exact: true }).click();
  await expectTableToolsAbove(page, first);
  await second.getByText('第二内容', { exact: true }).click();
  await expectTableToolsAbove(page, second);
  await page.screenshot({ path: info.outputPath('table-tools.png'), animations: 'disabled' });
  await page.locator('.document-editor-mount').evaluate((element) => {
    element.scrollTop += 72;
  });
  await expectTableToolsAbove(page, second);

  if (info.project.name === 'desktop') {
    const bounds = (await tools.boundingBox())!;
    for (const button of await tools.getByRole('button').all()) {
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
    }
  } else {
    await expect
      .poll(() => tools.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeGreaterThan(0);
    await tools.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(tools.getByRole('button', { name: '删除表格', exact: true })).toBeInViewport();
    await tools.evaluate((element) => {
      element.scrollLeft = 0;
    });
  }
  await tools.getByRole('button', { name: '上方插入行', exact: true }).click();
  await expect(first.locator('tr')).toHaveCount(2);
  await expect(second.locator('tr')).toHaveCount(3);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(second.locator('tr')).toHaveCount(2);
  await second.getByText('第二内容', { exact: true }).click();
  await tools.getByRole('button', { name: '列居中', exact: true }).click();
  await expect(second.locator('td').first()).toHaveCSS('text-align', 'center');
  await expect(first.locator('td').first()).not.toHaveCSS('text-align', 'center');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(second.locator('td').first()).not.toHaveCSS('text-align', 'center');
  await second.getByText('第二内容', { exact: true }).click();
  await tools.getByRole('button', { name: '删除表格', exact: true }).click();
  await expect(editor.locator('table')).toHaveCount(1);
  await expect(editor.locator('table')).toContainText('第一内容');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(editor.locator('table')).toHaveCount(2);
  await expect(second).toContainText('第二内容');
});

test('开头表格和长表格滚动时，浮条避开正在编辑的单元格', async ({ page, context }) => {
  await openDocumentNote(page, context, '| 表头 | B |\n| --- | --- |\n| 正在编辑 | C |\n');
  const editor = page.getByRole('textbox', { name: '文档正文', exact: true });
  const tools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  const header = editor.locator('th').first();
  await header.click();
  async function expectCellClear(cell: Locator) {
    await expect(tools).toBeVisible();
    await expect
      .poll(async () => {
        const a = (await tools.boundingBox())!;
        const b = (await cell.boundingBox())!;
        return Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      })
      .toBe(0);
  }
  await expectCellClear(header);
  await openDocumentNote(
    page,
    context,
    [
      '| 长表头 | B |',
      '| --- | --- |',
      ...Array.from({ length: 35 }, (_, i) => `| 第 ${i + 1} 行 | 内容 |`),
    ].join('\n'),
  );
  const cell = editor.locator('tr').nth(12).locator('td').first();
  await cell.click();
  await page.locator('.document-editor-mount').evaluate((mount) => {
    const target = [...mount.querySelectorAll('td')].find(
      (node) => node.textContent === '第 12 行',
    )!;
    mount.scrollTop += target.getBoundingClientRect().top - mount.getBoundingClientRect().top - 12;
  });
  await expectCellClear(cell);
  await page.keyboard.type('继续输入');
  await expect(cell).toContainText('继续输入');
});
