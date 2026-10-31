import { expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history, undo, redo, undoDepth } from '@codemirror/commands';
import { externalMarkdownUpdate } from '../apps/web/editor/external-markdown';
it('retains real CodeMirror user undo when autosave changes only preview and binding bytes', () => {
  const original = '# 根😀\n\n用户说明。\n\n![PG](preview-old.png)\n\n<!-- binding:old-hash -->\n';
  let state = EditorState.create({ doc: original, extensions: [history()] });
  const position = original.indexOf('用户说明。') + '用户说明。'.length;
  state = state.update({ changes: { from: position, insert: '新增说明。' } }).state;
  const next = state.doc
    .toString()
    .replace('preview-old.png', 'preview-new.png')
    .replace('binding:old-hash', 'binding:new-hash');
  state = state.update(externalMarkdownUpdate(state, next)).state;
  expect(
    undo({
      state,
      dispatch: (transaction) => {
        state = transaction.state;
      },
    }),
  ).toBe(true);
  expect(state.doc.toString()).toBe(
    original
      .replace('preview-old.png', 'preview-new.png')
      .replace('binding:old-hash', 'binding:new-hash'),
  );
  expect(undoDepth(state)).toBe(0);
  expect(
    redo({
      state,
      dispatch: (transaction) => {
        state = transaction.state;
      },
    }),
  ).toBe(true);
  expect(state.doc.toString()).toBe(next);
});
it('maps undo through longer derived text before a user edit without undoing the new metadata', () => {
  const original = '![PG](old.png)\r\n<!-- old -->\r\n\r\n说明😀';
  let state = EditorState.create({ doc: original, extensions: [history()] });
  state = state.update({ changes: { from: state.doc.length, insert: '。新增' } }).state;
  const next = state.doc
    .toString()
    .replace('old.png', 'a-much-longer-new-artifact.png')
    .replace('<!-- old -->', '<!-- verified new metadata -->');
  state = state.update(externalMarkdownUpdate(state, next)).state;
  expect(
    undo({
      state,
      dispatch: (transaction) => {
        state = transaction.state;
      },
    }),
  ).toBe(true);
  expect(state.doc.toString()).toBe(
    EditorState.create({
      doc: original
        .replace('old.png', 'a-much-longer-new-artifact.png')
        .replace('<!-- old -->', '<!-- verified new metadata -->'),
    }).doc.toString(),
  );
});
