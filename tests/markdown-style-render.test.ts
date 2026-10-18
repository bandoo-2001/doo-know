import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { markdownStyles } from '../shared/markdown-styles.js';
import { references, renderMarkdown } from '../packages/core/render.js';
import { outlineFromTokens } from '../apps/web/document-outline';

describe('restricted style renderer edge cases', () => {
  const md = new MarkdownIt({ html: false }).use(markdownStyles);

  it('renders nested safe styles with ordinary Markdown children', () => {
    const content =
      '<div style="text-align:left">\n\n<div style="text-align:right">\n\n# <span style="color:#AABBCC">**Title** [link](note.md)</span>\n\n</div>\n\n</div>';
    const tokens = md.parse(content, {});
    const html = renderMarkdown(content, (url) =>
      url === 'note.md' ? '/notes/mapped' : undefined,
    ).html;
    expect(html).toContain('<div style="text-align:left">');
    expect(html).toContain('<div style="text-align:right">');
    expect(html).toContain(
      '<span style="color:#AABBCC"><strong>Title</strong> <a href="/notes/mapped">link</a></span>',
    );
    expect(outlineFromTokens(tokens)).toEqual([{ line: 5, level: 1, title: 'Title link' }]);
    expect(references(content)).toEqual(['note.md']);
  });

  it('retains style-looking strings inside fenced, inline and indented code', () => {
    const content =
      '<div style="text-align:center">\n\n~~~html\n</div>\n<span style="color:#123456">literal</span>\n~~~\n\n    <span style="color:#123456">indented</span>\n\n`</div>`\n\n</div>';
    const html = md.render(content);
    expect(html.match(/<div /g)).toHaveLength(1);
    expect(html.match(/<\/div>/g)).toHaveLength(1);
    expect(html).not.toContain('<span');
    expect(html).toContain('<code>&lt;/div&gt;</code>');
    expect(html).toContain('&lt;span style=&quot;color:#123456&quot;&gt;indented&lt;/span&gt;');
  });

  it.each([
    '<span style="color:#123">bad</span>',
    '<span style="color:#12345678">bad</span>',
    '<span style="color:var(--x)">bad</span>',
    '<span style="color:#123456;display:none">bad</span>',
    '<span style="color:#123456" onclick="evil()">bad</span>',
    '<span class="x" style="color:#123456">bad</span>',
    '<span style="color:&#35;123456">bad</span>',
    '<div style="text-align:justify">\n\nbad\n\n</div>',
    '<div style="text-align:center;color:#123456">\n\nbad\n\n</div>',
    '<div style="text-align:center" onmouseover="evil()">\n\nbad\n\n</div>',
  ])('escapes every non-allowlisted source tag: %s', (content) => {
    const html = md.render(content);
    expect(html).not.toMatch(/<(?:div|span)[ >]/);
    expect(html).toContain('&lt;');
  });

  it('escapes orphan closers without leaking parser state between documents', () => {
    md.render('<div style="text-align:center">\n\n<span style="color:#123456">text');
    expect(md.render('</div>\n\n</span>')).toBe('<p>&lt;/div&gt;</p>\n<p>&lt;/span&gt;</p>\n');
  });

  it('uses visible text for styled server heading labels', () => {
    expect(
      renderMarkdown('# <span style="color:#123456">**Title** `code`</span>').headings,
    ).toEqual([{ id: 'heading-0', text: 'Title code' }]);
  });
});
