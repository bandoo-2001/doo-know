import { it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { getSchema } from '@tiptap/core';
import { richExtensions } from '../apps/web/editor/rich-adapter';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { markdownTransaction } from '../apps/web/markdown-format';
import { countCharacters, visibleDocumentText } from '../apps/web/editor/document-stats';
it('creates standard H6 and keeps Unicode character counts out of document changes', () => {
  const state = EditorState.create({
    doc: '标题',
    extensions: [markdown({ base: markdownLanguage })],
  });
  const transaction = markdownTransaction(state, 'heading6');
  expect(state.update(transaction!).state.doc.toString()).toBe('###### 标题');
  expect(countCharacters('A😀中')).toBe(3);
  expect(countCharacters('e\u0301\n')).toBe(3);
});
it('clears nested marks and selected color without altering linked destinations, images or opaque blocks', () => {
  const doc =
    '<span style="color:#dc2626">**粗*斜*体**</span> 与 [**链接**](note.md) ![**图**](asset.png)\n\n```md\n**代码**\n```\n\n<!-- **保留** -->';
  const state = EditorState.create({
    doc,
    selection: { anchor: 0, head: doc.length },
    extensions: [markdown({ base: markdownLanguage })],
  });
  const next = markdownTransaction(state, 'clearFormatting')!.state;
  expect(next.doc.toString()).toBe(
    '粗斜体 与 [链接](note.md) ![**图**](asset.png)\n\n```md\n**代码**\n```\n\n<!-- **保留** -->',
  );
});
it('clears only the selected part of emphasis and restores it with one undo', () => {
  const original = '**before selected after**';
  let current = EditorState.create({
    doc: original,
    selection: { anchor: 9, head: 17 },
    extensions: [markdown({ base: markdownLanguage }), history()],
  });
  current = markdownTransaction(current, 'clearFormatting')!.state;
  expect(current.doc.toString()).toBe('**before** selected **after**');
  expect(current.sliceDoc(current.selection.main.from, current.selection.main.to)).toBe('selected');
  expect(
    undo({
      get state() {
        return current;
      },
      dispatch(transaction) {
        current = transaction.state;
      },
    }),
  ).toBe(true);
  expect(current.doc.toString()).toBe(original);
});
it('refuses clearing in read only source and counts document text without hidden source or URLs', () => {
  const state = EditorState.create({
    doc: '**保持**',
    extensions: [markdown({ base: markdownLanguage }), EditorState.readOnly.of(true)],
  });
  expect(markdownTransaction(state, 'clearFormatting')).toBeUndefined();
  const schema = getSchema(richExtensions());
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'A😀中',
            marks: [{ type: 'link', attrs: { href: 'https://hidden/' } }],
          },
        ],
      },
      { type: 'opaqueSource', attrs: { sourceId: 'hidden' } },
      {
        type: 'codeBlock',
        attrs: { language: 'mermaid' },
        content: [{ type: 'text', text: 'hidden diagram' }],
      },
    ],
  });
  expect(visibleDocumentText(doc)).toBe('A😀中');
  expect(countCharacters(visibleDocumentText(doc))).toBe(3);
  expect(countCharacters(visibleDocumentText(doc, 2, 4))).toBe(1);
});
it('leaves style-looking text inside comments and opaque HTML byte-for-byte intact', () => {
  const opaque =
    '<!-- <span style="color:#dc2626">**raw**</span> -->\n\n<custom><span style="color:#dc2626">**raw**</span></custom>';
  const doc = opaque + '\n\n**edit**';
  const state = EditorState.create({
    doc,
    selection: { anchor: 0, head: doc.length },
    extensions: [markdown({ base: markdownLanguage })],
  });
  expect(markdownTransaction(state, 'clearFormatting')!.state.doc.toString()).toBe(
    opaque + '\n\nedit',
  );
});
it('clears a partial nested selection without leaking a mark onto the selected text', () => {
  const doc = '**before *selected* after**';
  const state = EditorState.create({
    doc,
    selection: { anchor: 10, head: 18 },
    extensions: [markdown({ base: markdownLanguage })],
  });
  expect(markdownTransaction(state, 'clearFormatting')!.state.doc.toString()).toBe(
    '**before** selected **after**',
  );
});
it('clears inline code while preserving its literal Markdown characters', () => {
  const doc = '**before** `a*b` after';
  const state = EditorState.create({
    doc,
    selection: { anchor: 0, head: doc.length },
    extensions: [markdown({ base: markdownLanguage })],
  });
  expect(markdownTransaction(state, 'clearFormatting')!.state.doc.toString()).toBe(
    'before a\\*b after',
  );
});
it('leaves a caret inside code delimiter padding unchanged', () => {
  const doc = '`` `x` ``';
  const state = EditorState.create({
    doc,
    selection: { anchor: 2 },
    extensions: [markdown({ base: markdownLanguage })],
  });
  expect(markdownTransaction(state, 'clearFormatting')!.state.doc.toString()).toBe(doc);
});
it('clears selected text marks while preserving text, links and untouched source', () => {
  const state = EditorState.create({
    doc: '**粗体** 与 [链接](note.md)\n\n<!-- 保留 -->',
    selection: { anchor: 0, head: 6 },
    extensions: [markdown({ base: markdownLanguage })],
  });
  const transaction = markdownTransaction(state, 'clearFormatting');
  expect(state.update(transaction!).state.doc.toString()).toBe(
    '粗体 与 [链接](note.md)\n\n<!-- 保留 -->',
  );
});
