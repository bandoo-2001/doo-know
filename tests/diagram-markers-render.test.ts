import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';
import { knowledgeMarkdown } from '../shared/knowledge-markdown';
import { parseDiagramDocument } from '../shared/diagram-document';
import { parseSource, validateUnitOperation } from '../apps/web/editor/source-codec';
const fixture = (type: string) =>
  readFileSync(new URL(`./fixtures/diagram-documents/${type}.md`, import.meta.url), 'utf8');
it.each(['whiteboard', 'mindmap', 'flowchart'])(
  'hides only supported machine comments when reading %s Markdown without enabling HTML',
  (type) => {
    const markdown = fixture(type),
      html = new MarkdownIt({ html: false }).use(knowledgeMarkdown).render(markdown);
    expect(html).not.toContain('dooknow:');
    expect(html).toContain('系统架构');
    expect(html).toContain('说明正文独立保存');
    expect(
      new MarkdownIt({ html: false }).use(knowledgeMarkdown).render('<script>alert(1)</script>'),
    ).not.toContain('<script>');
  },
);
it('preserves code examples and unknown comments as readable escaped text', () => {
  const marker = '<!-- dooknow:primary:start -->',
    header = '<!-- dooknow:document {"version":9,"type":"future","engine":"future"} -->';
  const md = new MarkdownIt({ html: false }).use(knowledgeMarkdown);
  expect(md.render('```md\n' + marker + '\n```\n')).toContain('dooknow:primary:start');
  expect(md.render('    ' + marker + '\n')).toContain('dooknow:primary:start');
  expect(md.render(header)).toContain('dooknow:document');
  expect(md.render('<!-- ordinary comment -->')).toContain('ordinary comment');
});
it.each(['whiteboard', 'mindmap', 'flowchart'])(
  'preserves the entire %s managed region as one protected original source unit',
  (type) => {
    const markdown = fixture(type),
      parsed = parseDiagramDocument(markdown);
    if (parsed.status !== 'diagram') throw Error('invalid fixture');
    const doc = parseSource(markdown),
      units = doc.units.filter(
        (unit) => unit.from <= parsed.primary.range.from && unit.to >= parsed.primary.range.to,
      );
    expect(units).toHaveLength(1);
    expect(units[0].opaque).toBe(true);
    expect(doc.units.map((unit) => unit.raw).join('')).toBe(markdown);
    for (const intent of ['edit', 'deleteOpaque'] as const) {
      expect(
        validateUnitOperation(doc, [{ from: units[0].from, to: units[0].to, insert: '' }], intent),
      ).toMatchObject({ ok: false, code: 'unsupported' });
      expect(
        validateUnitOperation(
          doc,
          [{ from: parsed.markerRange.from, to: parsed.markerRange.to, insert: '' }],
          intent,
        ),
      ).toMatchObject({ ok: false, code: 'unsupported' });
    }
    const from = markdown.indexOf('说明正文独立保存');
    expect(validateUnitOperation(doc, [{ from, to: from + 8, insert: '新说明' }], 'edit').ok).toBe(
      true,
    );
  },
);

it('protects zero-width insertions and preserves BOM/frontmatter/CRLF originals', () => {
  const markdown =
    '\uFEFF---\r\ncustom: keep\r\n---\r\n\r\n' + fixture('mindmap').replace(/\n/g, '\r\n');
  const parsed = parseDiagramDocument(markdown);
  if (parsed.status !== 'diagram') throw Error('invalid fixture');
  const doc = parseSource(markdown);
  expect(doc.units.map((unit) => unit.raw).join('')).toBe(markdown);
  for (const at of [
    parsed.markerRange.from + 8,
    parsed.primary.range.from + 8,
    markdown.indexOf('知识库'),
  ])
    for (const intent of ['edit', 'deleteOpaque'] as const)
      expect(
        validateUnitOperation(doc, [{ from: at, to: at, insert: '破坏' }], intent),
      ).toMatchObject({ ok: false, code: 'unsupported' });
  const rendered = new MarkdownIt({ html: false }).use(knowledgeMarkdown).render(markdown);
  expect(rendered).not.toContain('dooknow:');
});

it('hides actual machine comments next to paragraphs without a blank separator', () => {
  const markdown = '说明\n<!-- dooknow:primary:start -->\n正文\n<!-- dooknow:primary:end -->\n';
  const html = new MarkdownIt({ html: false }).use(knowledgeMarkdown).render(markdown);
  expect(html).not.toContain('dooknow:');
  expect(html).toContain('说明');
  expect(html).toContain('正文');
});
