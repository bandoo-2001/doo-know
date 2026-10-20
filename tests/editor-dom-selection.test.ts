import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';

let browser: Browser, page: Page, source: string;
beforeAll(async () => {
  const result = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import { Editor } from '@tiptap/core';
      import StarterKit from '@tiptap/starter-kit';
      import { NodeSelection } from '@tiptap/pm/state';
      import { syncDOMTextSelection } from './apps/web/editor/dom-selection.ts';
      const mount = document.createElement('div'); document.body.appendChild(mount);
      const editor = new Editor({ element: mount, extensions: [StarterKit], content: '<p>正文</p><hr>', injectCSS: false });
      editor.commands.setTextSelection(1); editor.view.focus();
      window.fixture = { editor, syncDOMTextSelection, NodeSelection };
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife',
  });
  source = result.outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: source });
});
afterEach(async () => { await page?.close(); });

it('keeps formatting on text typed after a pending native caret move', async () => {
  const caret = await page.evaluate(() => {
    const { editor, syncDOMTextSelection } = (window as any).fixture;
    const text = editor.view.dom.querySelector('p').firstChild;
    getSelection()!.setBaseAndExtent(text, 2, text, 2);
    syncDOMTextSelection(editor.view);
    editor.commands.toggleBold();
    return editor.state.selection.anchor;
  });
  expect(caret).toBe(3);
  await page.keyboard.type('加粗');
  expect(await page.locator('strong').textContent()).toBe('加粗');
});

it('retains backward range direction and formats the browser-selected text', async () => {
  const selection = await page.evaluate(() => {
    const { editor, syncDOMTextSelection } = (window as any).fixture;
    const text = editor.view.dom.querySelector('p').firstChild;
    getSelection()!.setBaseAndExtent(text, 2, text, 0);
    syncDOMTextSelection(editor.view);
    const selection = editor.state.selection.toJSON();
    editor.commands.toggleItalic();
    return selection;
  });
  expect(selection).toEqual({ type: 'text', anchor: 3, head: 1 });
  expect(await page.locator('em').textContent()).toBe('正文');
});

it('leaves a node selection intact when the native range differs', async () => {
  const selection = await page.evaluate(() => {
    const { editor, syncDOMTextSelection, NodeSelection } = (window as any).fixture;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 4)));
    const text = editor.view.dom.querySelector('p').firstChild;
    getSelection()!.setBaseAndExtent(text, 0, text, 2);
    syncDOMTextSelection(editor.view);
    return editor.state.selection.toJSON();
  });
  expect(selection).toEqual({ type: 'node', anchor: 4 });
});

it('does not remap an outside DOM selection into the document', async () => {
  const selection = await page.evaluate(() => {
    const { editor, syncDOMTextSelection } = (window as any).fixture;
    const outside = document.body.appendChild(document.createTextNode('outside'));
    getSelection()!.setBaseAndExtent(outside, 0, outside, 7);
    syncDOMTextSelection(editor.view);
    return editor.state.selection.toJSON();
  });
  expect(selection).toEqual({ type: 'text', anchor: 1, head: 1 });
});

it('keeps an active IME composition in control of its selection', async () => {
  const state = await page.evaluate(() => {
    const { editor, syncDOMTextSelection } = (window as any).fixture;
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    const text = editor.view.dom.querySelector('p').firstChild;
    getSelection()!.setBaseAndExtent(text, 2, text, 2);
    syncDOMTextSelection(editor.view);
    return { composing: editor.view.composing, selection: editor.state.selection.toJSON() };
  });
  expect(state).toEqual({ composing: true, selection: { type: 'text', anchor: 1, head: 1 } });
});
