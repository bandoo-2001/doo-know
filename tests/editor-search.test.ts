import { it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { richExtensions } from '../apps/web/editor/rich-adapter';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { findText, documentMatches, replaceDocumentMatches, documentSearchHighlightPlugin, documentSearchKey } from '../apps/web/editor/search';

it('finds literal Unicode matches with UTF-16 offsets and an empty query has no matches', () => {
  expect(findText('A😀中a', 'a', { caseSensitive: false })).toEqual([{from:0,to:1},{from:4,to:5}]);
  expect(findText('İi', 'i', { caseSensitive: false })).toEqual([{from:1,to:2}]);
  expect(findText('.*', '.*', {caseSensitive: true})).toEqual([{from:0,to:2}]);
  expect(findText('abc', '', {caseSensitive:false})).toEqual([]);
});

it('searches visible text across marks without changing hidden URLs, diagrams, or preserved source', () => {
  const schema = getSchema(richExtensions());
  const doc = schema.nodeFromJSON({type:'doc',content:[
    {type:'paragraph',content:[{type:'text',text:'前正文'},{type:'text',text:'正文',marks:[{type:'bold'}]},
      {type:'text',text:'链接',marks:[{type:'link',attrs:{href:'https://host/正文'}}]}]},
    {type:'codeBlock',attrs:{language:'mermaid'},content:[{type:'text',text:'正文'}]},
    {type:'codeBlock',attrs:{language:'ts'},content:[{type:'text',text:'正文'}]},
  ]});
  const matches = documentMatches(doc, '正文正文', false);
  expect(matches).toEqual([{from:2,to:6}]);
  expect(documentMatches(doc,'正文',false)).toHaveLength(3);
  const next = replaceDocumentMatches(doc, matches, '新正文');
  expect(next.textContent).toContain('前新正文链接');
  expect(next.child(0).lastChild?.marks[0].attrs.href).toBe('https://host/正文');
  expect(next.child(1).textContent).toBe('正文');
});

it('highlights the current result without editing the document and clears it when the caret moves', () => {
  const schema = getSchema(richExtensions());
  const doc = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'before target after' }] },
  ] });
  let state = EditorState.create({ schema, doc, plugins: [documentSearchHighlightPlugin()] });
  state = state.apply(state.tr.setMeta(documentSearchKey, { from: 8, to: 14 }));
  expect(documentSearchKey.getState(state)?.find().map(({ from, to }) => ({ from, to })))
    .toEqual([{ from: 8, to: 14 }]);
  expect(state.doc.eq(doc)).toBe(true);
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
  expect(documentSearchKey.getState(state)?.find()).toEqual([]);
});

it('drops a stale search highlight after replacement or an explicit close', () => {
  const schema = getSchema(richExtensions());
  const doc = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'target' }] },
  ] });
  let state = EditorState.create({ schema, doc, plugins: [documentSearchHighlightPlugin()] });
  state = state.apply(state.tr.setMeta(documentSearchKey, { from: 1, to: 7 }));
  state = state.apply(state.tr.insertText('new', 1, 7));
  expect(documentSearchKey.getState(state)?.find()).toEqual([]);
  state = state.apply(state.tr.setMeta(documentSearchKey, { from: 1, to: 4 }));
  state = state.apply(state.tr.setMeta(documentSearchKey, null));
  expect(documentSearchKey.getState(state)?.find()).toEqual([]);
});
