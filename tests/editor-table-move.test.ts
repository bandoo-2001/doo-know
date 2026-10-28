import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { compileScript, parse } from '@vue/compiler-sfc';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import MarkdownIt from 'markdown-it';
import { createRichProjection, richExtensions } from '../apps/web/editor/rich-adapter';
import { createEditorSession } from '../apps/web/editor/session';
import { textEdit } from '../apps/web/editor/source-codec';
import { moveMarkdownTable, tableMoveAvailability, type TableMoveAction } from '../apps/web/editor/table-move';

const original = '前文\r\n\r\n| 左列 | 中列 | 右列 |\r\n| :--- | :---: | ---: |\r\n| 左一 | 中一 | 右一 |\r\n| 左二 | 中二 | 右二 |\r\n| 左三 | 中三 | 右三 |\r\n\r\n<!-- 原样保留 -->\r\n';
let browser: Browser, page: Page, source: string, styles: string;

beforeAll(async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import { createApp, h, ref } from 'vue';
      import DocumentEditor from './apps/web/components/DocumentEditor.vue';
      import { createEditorSession } from './apps/web/editor/session.ts';
      const handle = ref();
      const session = createEditorSession({ noteId: 'table-fixture', generation: 1, markdown: ${JSON.stringify(original)} });
      const readOnly = ref(false);
      const root = document.body.appendChild(document.createElement('div'));
      const app = createApp({ setup: () => () => h(DocumentEditor, { ref: handle, session, readOnly: readOnly.value }) });
      app.mount(root);
      root.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
          event.preventDefault();
          handle.value.editHistory(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo');
        }
      }, true);
      window.fixture = { session, get handle() { return handle.value; }, setReadOnly(value) { readOnly.value = value; } };
    ` },
    plugins: [{ name: 'fixture-vue', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
        if (path.endsWith('/DiagramPreview.vue')) return { contents: 'export default { render() { return null; } }', loader: 'js' };
        const { descriptor } = parse(await readFile(path, 'utf8'), { filename: path });
        return { contents: compileScript(descriptor, { id: path, inlineTemplate: true }).content, loader: 'ts' };
      });
    } }],
    bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { 'import.meta.env': '{}' },
  });
  source = bundle.outputFiles[0].text;
  styles = await readFile('apps/web/document-editor.css', 'utf8');
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addStyleTag({ content: styles + '\n.document-editor {height:650px;} :root {--text:#343c4a;--panel:white;--surface:#f4f6f8;--border:#ccc;}' });
  await page.addScriptTag({ content: source });
});
afterEach(async () => { await page?.close(); });

it('shows table tools only while the table or its controls own focus', async () => {
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', '外部输入');
    document.body.prepend(input);
  });
  const tools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  const cell = page.locator('td').filter({ hasText: '中一' });
  await cell.click();
  await expect.poll(() => tools.isVisible()).toBe(true);
  const move = tools.getByRole('button', { name: '下移行', exact: true });
  await move.focus();
  await expect.poll(() => tools.isVisible()).toBe(true);
  expect(await move.evaluate(button => button === document.activeElement)).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('tr').nth(2).textContent()).toBe('左一中一右一');
  await page.getByRole('textbox', { name: '外部输入' }).focus();
  await expect.poll(() => tools.isVisible()).toBe(false);
  await cell.click();
  await expect.poll(() => tools.isVisible()).toBe(true);
  await page.locator('.tiptap > p').first().click();
  await expect.poll(() => tools.isVisible()).toBe(false);
});

it('floating table tools leave table geometry unchanged when focus enters and leaves', async () => {
  const table = page.locator('table');
  const offset = () => table.evaluate(table =>
    table.getBoundingClientRect().top - table.closest('.tiptap')!.getBoundingClientRect().top,
  );
  const before = await offset();
  await page.locator('td').filter({ hasText: '中一' }).click();
  const tools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  await expect.poll(() => tools.isVisible()).toBe(true);
  expect(await offset()).toBe(before);
  await page.locator('.tiptap > p').first().click();
  await expect.poll(() => tools.isVisible()).toBe(false);
  expect(await offset()).toBe(before);
});

it('moves the selected body row with the real document action and keeps the header first', async () => {
  await page.locator('td').filter({ hasText: '中一' }).click();
  const result = await page.evaluate(() => {
    try { return { ok: (window as any).fixture.handle.executeTable('moveRowDown') }; }
    catch (cause) { return { error: String(cause) }; }
  });
  expect(result).toEqual({ ok: true });
  expect(await page.locator('tr').allTextContents()).toEqual(['左列中列右列', '左二中二右二', '左一中一右一', '左三中三右三']);
  const afterMove = await page.evaluate(() => (window as any).fixture.session.snapshot().markdown);
  await page.locator('.tiptap > p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('补充正文');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(afterMove);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(original);
});

it('exposes labeled movement controls and disables each header/body/column boundary', async () => {
  await page.locator('th').filter({ hasText: '中列' }).click();
  const tools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  await expect.poll(() => tools.getByRole('button', { name: '上移行', exact: true }).isDisabled()).toBe(true);
  expect(await tools.getByRole('button', { name: '下移行', exact: true }).isDisabled()).toBe(true);
  expect(await tools.getByRole('button', { name: '左移列', exact: true }).isEnabled()).toBe(true);
  expect(await tools.getByRole('button', { name: '右移列', exact: true }).isEnabled()).toBe(true);
  await page.locator('td').filter({ hasText: '左一' }).click();
  expect(await tools.getByRole('button', { name: '上移行', exact: true }).isDisabled()).toBe(true);
  await expect.poll(() => tools.getByRole('button', { name: '下移行', exact: true }).isEnabled()).toBe(true);
  expect(await tools.getByRole('button', { name: '左移列', exact: true }).isDisabled()).toBe(true);
  await tools.getByRole('button', { name: '下移行', exact: true }).click();
  expect(await page.locator('tr').nth(2).textContent()).toBe('左一中一右一');
  await page.locator('td').filter({ hasText: '右三' }).click();
  await expect.poll(() => tools.getByRole('button', { name: '下移行', exact: true }).isDisabled()).toBe(true);
  expect(await tools.getByRole('button', { name: '右移列', exact: true }).isDisabled()).toBe(true);
});

it('moves columns from their header with all alignment and refuses actions after read only is enabled', async () => {
  await page.locator('th').filter({ hasText: '中列' }).click();
  const tools = page.getByRole('toolbar', { name: '表格操作', exact: true });
  await tools.getByRole('button', { name: '左移列', exact: true }).click();
  expect(await page.locator('tr').allTextContents()).toEqual(['中列左列右列', '中一左一右一', '中二左二右二', '中三左三右三']);
  expect(await page.locator('th').evaluateAll(cells => cells.map(cell => cell.style.textAlign))).toEqual(['center', 'left', 'right']);
  const before = await page.evaluate(() => (window as any).fixture.session.snapshot().markdown);
  await page.evaluate(() => (window as any).fixture.setReadOnly(true));
  await expect.poll(() => page.locator('.tiptap').getAttribute('contenteditable')).toBe('false');
  expect(await page.evaluate(() => (window as any).fixture.handle.executeTable('moveColumnRight'))).toBe(false);
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(before);
});

const schema = getSchema(richExtensions());
function selectedTable(row: number, column: number) {
  const projection = createRichProjection(original);
  const doc = schema.nodeFromJSON(projection.json);
  let table!: ProseMirrorNode, tableAt = 0;
  doc.descendants((node, position) => {
    if (node.type.name !== 'table') return;
    table = node; tableAt = position;
    return false;
  });
  const cellAt = tableAt + 1 + TableMap.get(table).positionAt(row, column, table);
  const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, cellAt + 2) });
  return { state, projection, cellAt, tableAt, table };
}

it('moves a body row in one transaction and round trips valid GFM through the shared undo session', () => {
  const f = selectedTable(1, 1);
  let next = f.state, transaction: Transaction | undefined, dispatched = 0;
  expect(moveMarkdownTable('moveRowDown')(f.state, tr => {
    transaction = tr; dispatched++; next = next.apply(tr);
  })).toBe(true);
  expect(dispatched).toBe(1);
  expect(transaction!.steps).toHaveLength(1);
  const result = f.projection.serialize(next.doc.toJSON());
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.message);
  const tokens = new MarkdownIt({ html: true }).parse(result.markdown, {});
  expect(tokens.filter(token => token.type === 'table_open')).toHaveLength(1);
  expect(tokens.filter(token => token.type === 'inline').map(token => token.content)).toEqual([
    '前文', '左列', '中列', '右列', '左二', '中二', '右二', '左一', '中一', '右一', '左三', '中三', '右三',
  ]);
  expect(result.markdown.endsWith('<!-- 原样保留 -->\r\n')).toBe(true);
  const session = createEditorSession({ noteId: 'table', generation: 1, markdown: original });
  session.sealHistory();
  expect(session.apply({
    noteId: 'table', generation: 1, baseRevision: 0, origin: 'document',
    edits: textEdit(original, result.markdown), selection: { anchor: 0, head: 0, affinity: 'after' },
  }).ok).toBe(true);
  session.sealHistory();
  expect(session.undo()).toMatchObject({ ok: true, markdown: original });
  expect(session.canUndo).toBe(false);
  expect(session.redo()).toMatchObject({ ok: true, markdown: result.markdown });
});

it.each([
  [0, 1, false, false, true, true],
  [1, 0, false, true, false, true],
  [3, 2, true, false, true, false],
] as const)('disables GFM header/body and outer boundaries at row %i column %i', (row, column, up, down, left, right) => {
  const { state } = selectedTable(row, column);
  expect(tableMoveAvailability(state)).toEqual({ moveRowUp: up, moveRowDown: down, moveColumnLeft: left, moveColumnRight: right });
  const actions: [TableMoveAction, boolean][] = [['moveRowUp', up], ['moveRowDown', down], ['moveColumnLeft', left], ['moveColumnRight', right]];
  for (const [action, allowed] of actions) {
    if (allowed) continue;
    let dispatched = false;
    expect(moveMarkdownTable(action)(state, () => { dispatched = true; })).toBe(false);
    expect(dispatched).toBe(false);
  }
});

it('moves the header and every body cell together with their column alignment', () => {
  const f = selectedTable(0, 1);
  let next = f.state;
  expect(moveMarkdownTable('moveColumnLeft')(f.state, tr => { next = next.apply(tr); })).toBe(true);
  const table = next.doc.child(1);
  const cells: { text: string; align: string }[][] = [];
  table.forEach(row => {
    const content: { text: string; align: string }[] = [];
    row.forEach(cell => { content.push({ text: cell.textContent, align: cell.attrs.align }); });
    cells.push(content);
  });
  expect(cells).toEqual([
    [{ text: '中列', align: 'center' }, { text: '左列', align: 'left' }, { text: '右列', align: 'right' }],
    [{ text: '中一', align: 'center' }, { text: '左一', align: 'left' }, { text: '右一', align: 'right' }],
    [{ text: '中二', align: 'center' }, { text: '左二', align: 'left' }, { text: '右二', align: 'right' }],
    [{ text: '中三', align: 'center' }, { text: '左三', align: 'left' }, { text: '右三', align: 'right' }],
  ]);
  const result = f.projection.serialize(next.doc.toJSON());
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.message);
  const tokens = new MarkdownIt({ html: true }).parse(result.markdown, {});
  expect(tokens.filter(token => token.type === 'th_open').map(token => token.attrGet('style'))).toEqual(['text-align:center', 'text-align:left', 'text-align:right']);
  expect(tokens.filter(token => token.type === 'inline').map(token => token.content)).toEqual([
    '前文', '中列', '左列', '右列', '中一', '左一', '右一', '中二', '左二', '右二', '中三', '左三', '右三',
  ]);
});

it('keeps repeat row moves inside the body when the moved row becomes a cell selection', () => {
  let { state } = selectedTable(1, 1);
  expect(moveMarkdownTable('moveRowDown')(state, tr => { state = state.apply(tr); })).toBe(true);
  expect(state.selection).toBeInstanceOf(CellSelection);
  expect(tableMoveAvailability(state)).toMatchObject({ moveRowUp: true, moveRowDown: true });
  expect(moveMarkdownTable('moveRowUp')(state, tr => { state = state.apply(tr); })).toBe(true);
  expect(tableMoveAvailability(state)).toMatchObject({ moveRowUp: false, moveRowDown: true });
  expect(moveMarkdownTable('moveRowUp')(state)).toBe(false);
});

it('rejects read only movement, outside selections and tables with merged cells', () => {
  const f = selectedTable(1, 1);
  let dispatched = false;
  expect(moveMarkdownTable('moveRowDown', { readOnly: true })(f.state, () => { dispatched = true; })).toBe(false);
  expect(dispatched).toBe(false);
  const outside = f.state.apply(f.state.tr.setSelection(TextSelection.create(f.state.doc, 1)));
  expect(tableMoveAvailability(outside)).toEqual({ moveRowUp: false, moveRowDown: false, moveColumnLeft: false, moveColumnRight: false });
  expect(moveMarkdownTable('moveColumnRight')(outside)).toBe(false);
  const merged = f.state.apply(f.state.tr.setNodeMarkup(f.cellAt, undefined, { ...f.state.doc.nodeAt(f.cellAt)!.attrs, colspan: 2 }));
  expect(moveMarkdownTable('moveRowDown')(merged)).toBe(false);
});
