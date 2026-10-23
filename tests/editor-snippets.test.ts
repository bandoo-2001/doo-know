import { expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { createEditorSnippet, filterEditorSnippets } from '../shared/editor-snippets';

it('inserts standard Markdown for knowledge notes and common document blocks', () => {
  expect(createEditorSnippet('math').markdown).toBe('$$\nx^2 + y^2 = z^2\n$$\n');
  expect(createEditorSnippet('callout').markdown).toBe('> [!NOTE]\n> 在这里填写提示内容\n');
  expect(createEditorSnippet('wikilink').markdown).toBe('[[笔记名称]]');
  expect(createEditorSnippet('rule').markdown).toBe('---\n');
  const md = new MarkdownIt({ html: false });
  expect(md.render(createEditorSnippet('table').markdown)).toContain('<table>');
  expect(md.parse(createEditorSnippet('svg').markdown, {})[0]).toMatchObject({ type: 'fence', info: 'svg' });
  expect(md.parse(createEditorSnippet('mermaid').markdown, {})[0]).toMatchObject({ type: 'fence', info: 'mermaid' });
  expect(md.render(createEditorSnippet('link').markdown)).toContain('href="https://example.com"');
});

it('creates a distinct footnote identifier without colliding with the current note', () => {
  const snippet = createEditorSnippet('footnote', '原文[^note]\n\n[^note]: 已有\n\n[^note-2]: 另一个\n');
  expect(snippet.markdown).toBe('说明[^note-3]\n\n[^note-3]: 在这里填写脚注内容\n');
  expect(snippet.markdown.slice(snippet.selection.from, snippet.selection.to)).toBe('说明');
});

it('filters the slash menu using Chinese labels and familiar English names', () => {
  expect(filterEditorSnippets('/formula').map(x => x.id)).toEqual(['math']);
  expect(filterEditorSnippets('脚注').map(x => x.id)).toEqual(['footnote']);
  expect(filterEditorSnippets('mermaid').map(x => x.id)).toEqual(['mermaid']);
  expect(filterEditorSnippets('does-not-exist')).toEqual([]);
});
