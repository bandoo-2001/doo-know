import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createRichProjection } from '../apps/web/editor/rich-adapter';

let browser: Browser, page: Page, source: string;
const original = '正文\r\n\r\n````ts\r\nconst before = `中文😀`;\r\n````\r\n\r\n~~~unknown-lang\r\nuntouched ```\r\n~~~\r\n\r\n<!-- 保留原文 -->\r\n';

beforeAll(async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import { Editor } from '@tiptap/core';
      import { TextSelection } from '@tiptap/pm/state';
      import { createRichProjection, richExtensions } from './apps/web/editor/rich-adapter.ts';
      import { createEditorSession } from './apps/web/editor/session.ts';
      import { textEdit } from './apps/web/editor/source-codec.ts';
      import { languages } from '@codemirror/language-data';
      import { LanguageDescription } from '@codemirror/language';
      let editor, session, projection, loading = false, previousContext = '';
      const languageGates = new Map();
      function holdLanguage(name) {
        const description = LanguageDescription.matchLanguageName(languages, name, false);
        const originalLoad = description.load;
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const pending = [];
        description.load = function() {
          // Keep the real import/cache/parser; only delay its completion at the boundary.
          const loaded = originalLoad.call(this).then(async support => { await gate; return support; });
          pending.push(loaded);
          return loaded;
        };
        languageGates.set(name, { description, originalLoad, release, pending });
      }
      async function releaseLanguage(name) {
        const entry = languageGates.get(name);
        entry.description.load = entry.originalLoad;
        entry.release();
        await Promise.all(entry.pending);
      }
      function selection() {
        const s = editor.state.selection;
        return { anchor: 0, head: 0, affinity: 'after', document: { id: 'fixture', anchor: s.anchor, head: s.head } };
      }
      function editingBoundary() {
        const at = editor.state.selection.$from;
        const context = at.parent.type.name === 'codeBlock' ? 'code:' + at.start() : 'body';
        if (context !== previousContext) session.sealHistory();
        previousContext = context;
      }
      function report() {
        editingBoundary();
        session.setSelection(selection());
      }
      function publish() {
        if (loading) return;
        const result = projection.serialize(editor.getJSON());
        if (!result.ok) throw Error(result.message);
        const snap = session.snapshot();
        const changed = session.apply({ ...snap, baseRevision: snap.revision, origin: 'document',
          edits: textEdit(snap.markdown, result.markdown), selection: selection() });
        if (!changed.ok) throw Error(changed.message);
      }
      function history(action) {
        if (!editor.isEditable || session.composing) return;
        const result = session[action]();
        if (!result.ok) return;
        loading = true;
        projection = createRichProjection(result.markdown);
        editor.commands.setContent(projection.json, { emitUpdate: false });
        loading = false;
        const s = result.selection.document;
        if (s) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, s.anchor, s.head)));
        editor.view.focus();
      }
      function reset(markdown) {
        editor?.destroy();
        document.body.replaceChildren();
        session = createEditorSession({ noteId: 'fixture', generation: 1, markdown });
        projection = createRichProjection(markdown);
        previousContext = '';
        const mount = document.body.appendChild(document.createElement('div'));
        editor = new Editor({ element: mount, extensions: richExtensions(), content: projection.json,
          injectCSS: false,
          onTransaction: ({ transaction }) => {
            if (loading) return;
            if (transaction.getMeta('codeBlockAction')) session.sealHistory();
            editingBoundary();
          },
          onSelectionUpdate: ({ transaction }) => { if (!transaction.docChanged) report(); },
          onUpdate: () => { if (!session.composing) publish(); } });
        mount.addEventListener('keydown', event => {
          if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
            event.preventDefault(); history(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo');
          }
        }, true);
        mount.addEventListener('compositionstart', () => session.setComposing(true));
        mount.addEventListener('compositionend', () => setTimeout(() => { publish(); session.setComposing(false); }));
        report();
      }
      window.fixture = { reset, get editor() { return editor; }, get session() { return session; },
        get projection() { return projection; }, history, publish, holdLanguage, releaseLanguage,
        languageLoads: name => languageGates.get(name)?.pending.length || 0 };
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', external: ['*.vue'],
    define: { 'import.meta.env': '{}' },
  });
  source = bundle.outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  page = await browser.newPage();
  page.setDefaultTimeout(2000);
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: source });
  await page.evaluate(markdown => (window as any).fixture.reset(markdown), original);
});
afterEach(async () => { await page?.close(); });

it('creates a CodeMirror only when entering a code block and leaves the other blocks lightweight', async () => {
  expect(await page.locator('.cm-editor').count()).toBe(0);
  await page.locator('pre code').first().click();
  expect(await page.locator('.cm-editor').count()).toBe(1);
  expect(await page.locator('pre code').last().textContent()).toBe('untouched ```');
});

it('highlights visible idle JavaScript keywords without creating an editor or changing Markdown', async () => {
  const raw = '正文\r\n\r\n~~~javascript\r\nconst html = "<img src=x onerror=alert(1)>"; // 中文😀\r\n~~~\r\n\r\n<!-- 保留原文 -->\r\n';
  await page.evaluate(markdown => (window as any).fixture.reset(markdown), raw);
  const preview = page.locator('.document-code-preview code');
  await expect.poll(() => preview.locator('.tok-keyword').count()).toBe(1);
  expect(await preview.locator('.tok-keyword').textContent()).toBe('const');
  expect(await preview.textContent()).toBe('const html = "<img src=x onerror=alert(1)>"; // 中文😀');
  expect(await preview.locator('.tok-comment').textContent()).toBe('// 中文😀');
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.locator('.cm-editor').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(raw);
  expect(await page.evaluate(() => (window as any).fixture.session.canUndo)).toBe(false);
});

it('waits until an idle block reaches the viewport before highlighting it', async () => {
  await page.evaluate(() => {
    (window as any).fixture.reset('正文\n\n```javascript\nconst first = 1;\n```\n\n```javascript\nconst second = 2;\n```');
    (document.querySelectorAll('.document-code-block')[1] as HTMLElement).style.marginTop = '1800px';
  });
  const previews = page.locator('.document-code-preview code');
  await expect.poll(() => previews.first().locator('.tok-keyword').textContent()).toBe('const');
  expect(await previews.last().locator('span').count()).toBe(0);
  expect(await page.locator('.cm-editor').count()).toBe(0);
  await previews.last().scrollIntoViewIfNeeded();
  await expect.poll(() => previews.last().locator('.tok-keyword').textContent()).toBe('const');
  expect(await page.locator('.cm-editor').count()).toBe(0);
});

it('keeps more than 64 KiB of idle preview source intact as plain text', async () => {
  const body = 'const value = "' + '😀'.repeat(17000) + '";';
  const raw = '正文\n\n```javascript\n' + body + '\n```\n\n```javascript\nconst small = 1;\n```';
  await page.evaluate(markdown => (window as any).fixture.reset(markdown), raw);
  const previews = page.locator('.document-code-preview code');
  await expect.poll(() => previews.last().locator('.tok-keyword').textContent()).toBe('const');
  expect(await previews.first().locator('span').count()).toBe(0);
  expect(await previews.first().textContent()).toBe(body);
  expect(await page.locator('.cm-editor').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(raw);
});

it('discards delayed idle highlighting after language changes and after the note is disposed', async () => {
  const errors: string[] = [];
  page.on('pageerror', cause => errors.push(cause.message));
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.holdLanguage('javascript');
    f.reset('正文\n\n```javascript\nconst current = 1;\n```');
  });
  await expect.poll(() => page.evaluate(() => (window as any).fixture.languageLoads('javascript'))).toBeGreaterThan(0);
  await page.evaluate(async () => {
    const f = (window as any).fixture;
    const pos = f.editor.state.doc.firstChild.nodeSize;
    const node = f.editor.state.doc.nodeAt(pos);
    f.editor.view.dispatch(f.editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: 'unknown-syntax' }));
    await f.releaseLanguage('javascript');
    await new Promise(requestAnimationFrame);
  });
  expect(await page.locator('.document-code-preview code span').count()).toBe(0);
  expect(await page.locator('.document-code-preview code').textContent()).toBe('const current = 1;');
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.holdLanguage('python');
    const pos = f.editor.state.doc.firstChild.nodeSize;
    const node = f.editor.state.doc.nodeAt(pos);
    f.editor.view.dispatch(f.editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: 'python' }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).fixture.languageLoads('python'))).toBeGreaterThan(0);
  const detachedSpans = await page.evaluate(async () => {
    const f = (window as any).fixture;
    const oldPreview = document.querySelector('.document-code-preview code')!;
    f.reset('后来打开的正文');
    await f.releaseLanguage('python');
    await new Promise(requestAnimationFrame);
    return oldPreview.querySelectorAll('span').length;
  });
  expect(detachedSpans).toBe(0);
  expect(await page.locator('.tiptap').textContent()).toBe('后来打开的正文');
  expect(await page.locator('.cm-editor').count()).toBe(0);
  expect(errors).toEqual([]);
});

it('preserves wide fences, CRLF, unknown languages and neighboring opaque source across an untouched projection', () => {
  const projection = createRichProjection(original);
  const result = projection.serialize(structuredClone(projection.json));
  expect(result).toEqual({ ok: true, markdown: original });
});

it('publishes code as ProseMirror changes and globally undoes body then code without touching adjacent source', async () => {
  await page.locator('pre code').first().click();
  const code = page.getByRole('textbox', { name: '代码内容', exact: true });
  await code.press('ControlOrMeta+End');
  await page.keyboard.insertText(' // 修改');
  const afterCode = await page.evaluate(() => (window as any).fixture.session.snapshot().markdown);
  expect(afterCode).toContain('const before = `中文😀`; // 修改');
  expect(afterCode.slice(afterCode.indexOf('~~~unknown-lang'))).toBe('~~~unknown-lang\r\nuntouched ```\r\n~~~\r\n\r\n<!-- 保留原文 -->\r\n');
  await page.locator('.tiptap > p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.insertText('补充');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(afterCode);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(original);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(afterCode);
});

it('updates an existing code editor when the document becomes read only', async () => {
  await page.locator('pre code').first().click();
  await page.evaluate(() => (window as any).fixture.editor.setEditable(false));
  const code = page.getByRole('textbox', { name: '代码内容', exact: true });
  expect(await code.getAttribute('contenteditable')).not.toBe('true');
  await code.focus();
  await page.keyboard.insertText('禁止修改');
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(original);
  await page.evaluate(() => (window as any).fixture.editor.setEditable(true));
  expect(await code.getAttribute('contenteditable')).toBe('true');
  await code.press('ControlOrMeta+End');
  await page.keyboard.insertText('可编辑');
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toContain('可编辑');
});

it('enters from document navigation, preserves a backward code selection and exits at the boundary', async () => {
  await page.evaluate(() => {
    const editor = (window as any).fixture.editor;
    // "正文" occupies a four-position paragraph, then the code text starts at five.
    editor.commands.setTextSelection({ from: 10, to: 5 });
    editor.view.focus();
  });
  const code = page.getByRole('textbox', { name: '代码内容', exact: true });
  expect(await code.count()).toBe(1);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('const');
  await code.press('ControlOrMeta+Home');
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => (window as any).fixture.editor.state.selection.$from.parent.type.name)).toBe('paragraph');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.evaluate(() => (window as any).fixture.editor.state.selection.$from.parent.type.name)).toBe('codeBlock');
});

it('keeps wrap, line numbers, folding and copying out of Markdown history', async () => {
  await page.locator('pre code').first().click();
  const block = page.locator('.document-code-block').first();
  const lines = block.getByRole('button', { name: '代码行号', exact: true });
  await lines.click();
  expect(await lines.getAttribute('aria-pressed')).toBe('false');
  const wrap = block.getByRole('button', { name: '代码自动折行', exact: true });
  await wrap.click();
  expect(await wrap.getAttribute('aria-pressed')).toBe('false');
  await block.getByRole('button', { name: '折叠代码', exact: true }).click();
  await block.getByRole('button', { name: '复制代码', exact: true }).click();
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(original);
  expect(await page.evaluate(() => (window as any).fixture.session.canUndo)).toBe(false);
});

it('applies a searchable code language through the shared document and falls back to plain unknown syntax', async () => {
  await page.locator('pre code').first().click();
  const block = page.locator('.document-code-block').first();
  const language = block.getByRole('combobox', { name: '代码语言', exact: true });
  await language.fill('javascript');
  await language.press('Enter');
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toContain('```javascript\r\n');
  await expect.poll(() => block.locator('.cm-content span').count()).toBeGreaterThan(0);
  await language.fill('unknown-syntax');
  await language.press('Enter');
  await expect.poll(() => block.locator('.cm-content span').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toContain('```unknown-syntax\r\n');
});

it('keeps IME edits under the document composition guard until composition ends', async () => {
  await page.locator('pre code').first().click();
  const code = page.getByRole('textbox', { name: '代码内容', exact: true });
  await code.press('ControlOrMeta+End');
  await code.dispatchEvent('compositionstart', { data: '' });
  await page.keyboard.insertText('中文组合');
  const during = await page.evaluate(() => ({
    composing: (window as any).fixture.session.composing,
    markdown: (window as any).fixture.session.snapshot().markdown,
  }));
  expect(during.composing).toBe(true);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(during.markdown);
  await code.dispatchEvent('compositionend', { data: '中文组合' });
  await expect.poll(() => page.evaluate(() => (window as any).fixture.session.composing)).toBe(false);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => (window as any).fixture.session.snapshot().markdown)).toBe(original);
});

it('undo restores the code caret from before the edit rather than the new code offset', async () => {
  await page.locator('pre code').first().click();
  const code = page.getByRole('textbox', { name: '代码内容', exact: true });
  await code.press('ControlOrMeta+Home');
  await code.press('ArrowRight');
  await code.press('ArrowRight');
  await code.press('ArrowRight');
  await page.keyboard.insertText('中文');
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(() => (window as any).fixture.editor.state.selection.toJSON())).toEqual({ type: 'text', anchor: 8, head: 8 });
});

it('ignores an old parser when language changes rapidly and when its note is closed', async () => {
  const errors: string[] = [];
  page.on('pageerror', cause => errors.push(cause.message));
  await page.locator('pre code').first().click();
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.editor.commands.updateAttributes('codeBlock', { language: 'javascript' });
    f.editor.commands.updateAttributes('codeBlock', { language: 'unknown-syntax' });
  });
  await expect.poll(() => page.locator('.cm-content').getAttribute('data-language')).not.toBe('javascript');
  expect(await page.locator('.cm-content span').count()).toBe(0);
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.editor.commands.updateAttributes('codeBlock', { language: 'python' });
    f.reset('后来打开的正文');
  });
  await expect.poll(() => page.locator('.tiptap').textContent()).toBe('后来打开的正文');
  expect(await page.locator('.cm-editor').count()).toBe(0);
  expect(errors).toEqual([]);
});
