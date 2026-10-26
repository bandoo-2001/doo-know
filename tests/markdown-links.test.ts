import { expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { knowledgeMarkdown } from '../shared/knowledge-markdown';
import { markdownDestination, markdownAnchorLines } from '../apps/web/markdown-links';

it('classifies fragments and external identities before resolving local paths', () => {
  expect(markdownDestination('#%E7%AB%A0%E8%8A%82', 'notes/one.md')).toEqual({
    kind: 'fragment',
    fragment: '#%E7%AB%A0%E8%8A%82',
  });
  expect(markdownDestination('https://example.org/notes/two.md#chapter', 'notes/one.md')).toEqual({
    kind: 'external',
    url: 'https://example.org/notes/two.md#chapter',
  });
  expect(markdownDestination('//example.org/notes/two.md', 'notes/one.md')).toEqual({
    kind: 'external',
    url: '//example.org/notes/two.md',
  });
  expect(markdownDestination('../other/two%20words.md?view=1#part%202', 'notes/one.md')).toEqual({
    kind: 'local',
    path: 'other/two words.md',
    fragment: '#part%202',
  });
  expect(markdownDestination('bad%path.md', 'notes/one.md')).toBeUndefined();
  expect(markdownDestination('folder/%5cfile.md', 'notes/one.md')).toBeUndefined();
});

it('gives formatted duplicate Unicode headings stable distinct destinations and maps rendered footnotes to source lines', () => {
  const markdown = new MarkdownIt().use(knowledgeMarkdown);
  const tokens = markdown.parse(
    '# **章节** `code`\n\n## 章节 code\n\n## 章节 code-1\n\n## 章节 code\n\n正文[^a]\n\n[^a]: 实际脚注目标',
    {},
  );
  expect([...markdownAnchorLines(tokens)]).toEqual([
    ['章节-code', 1],
    ['章节-code-1', 3],
    ['章节-code-1-1', 5],
    ['章节-code-2', 7],
    ['fnref1', 9],
    ['fn1', 11],
  ]);
  const html = markdown.renderer.render(tokens, markdown.options, {});
  expect(html).toContain('id="章节-code-2"');
  expect(html).toContain('id="fn1"');
});

it('does not reinterpret browser-trimmed external URLs as local attachment paths', () => {
  expect(markdownDestination(' https://example.org/notes/two.md', 'notes/one.md')).toEqual({
    kind: 'external',
    url: ' https://example.org/notes/two.md',
  });
});

it('reserves genuine footnote definition and reference IDs before assigning heading destinations', () => {
  const markdown = new MarkdownIt().use(knowledgeMarkdown);
  const tokens = markdown.parse(
    '# fn1\n\n# fnref1\n\nText[^a] and again[^a]\n\n[^a]: Definition',
    {},
  );
  const anchors = markdownAnchorLines(tokens);
  const html = markdown.renderer.render(tokens, markdown.options, {});
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(anchors.get('fn1-1')).toBe(1);
  expect(anchors.get('fnref1-1')).toBe(3);
  expect(anchors.get('fn1')).toBe(7);
  expect(anchors.get('fnref1')).toBe(5);
  expect(anchors.get('fnref1:1')).toBe(5);
  expect(html).toContain('<h1 id="fn1-1">fn1</h1>');
  expect(html).toContain('<h1 id="fnref1-1">fnref1</h1>');
});
