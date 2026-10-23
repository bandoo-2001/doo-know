import { it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { richExtensions } from '../apps/web/editor/rich-adapter';
import { findText, documentMatches, replaceDocumentMatches } from '../apps/web/editor/search';

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
