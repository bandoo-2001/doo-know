import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import { readFileSync } from 'node:fs';
import { parseDiagramDocument, replaceDiagramPrimary } from '../shared/diagram-document';

const marker =
  '<!-- dooknow:document {"version":1,"type":"flowchart","engine":"mermaid","custom":{"中文":true}} -->';
const binding =
  '<!-- dooknow:primary-binding {"version":1,"sourceHash":"' +
  'a'.repeat(64) +
  '","renderHash":"' +
  'b'.repeat(64) +
  '","previewHash":"' +
  'c'.repeat(64) +
  '"} -->';
const body =
  '```mermaid\nflowchart TD\n  A[中文] --> B[结束]\n```\n\n![预览](assets/diagram.png)\n\n' +
  binding +
  '\n';
const document =
  marker +
  '\n\n# 架构\n\n<!-- dooknow:primary:start -->\n\n' +
  body +
  '\n<!-- dooknow:primary:end -->\n\n说明 **原样保留**。\n';

describe('diagram document format v1', () => {
  it('recognizes the explicit type and authoritative source separately from the Markdown bytes', () => {
    const result = parseDiagramDocument(document);
    expect(result.status).toBe('diagram');
    if (result.status !== 'diagram') throw Error('expected diagram');
    expect(result.type).toBe('flowchart');
    expect(result.title).toBe('架构');
    expect(result.metadata.custom).toEqual({ 中文: true });
    expect(result.primary.source).toEqual({
      format: 'mermaid',
      content: 'flowchart TD\n  A[中文] --> B[结束]\n',
    });
    expect(result.primary.previewPath).toBe('assets/diagram.png');
    expect(document.slice(result.primary.contentRange.from, result.primary.contentRange.to)).toBe(
      '\n' + body + '\n',
    );
  });

  it.each(['', '\uFEFF', '---\ntitle: frontmatter\n---\n', '\uFEFF---\r\ntitle: 中文\r\n---\r\n'])(
    'accepts BOM/frontmatter and locates untouched original ranges (%j)',
    (prefix) => {
      const input = prefix + document.replace(/\n/g, '\r\n');
      const result = parseDiagramDocument(input);
      expect(result.status).toBe('diagram');
      if (result.status !== 'diagram') throw Error('expected diagram');
      expect(input.slice(result.markerRange.from, result.markerRange.to).trim()).toBe(marker);
      expect(
        input.slice(result.primary.contentRange.from, result.primary.contentRange.to),
      ).toContain('A[中文] --> B[结束]\r\n');
    },
  );

  it.each([
    '# 笔记\n\n```mermaid\nflowchart TD\n A-->B\n```',
    '```md\n' + document + '```\n',
    '> ' + marker + '\n\n正文',
    '- ' + marker + '\n',
    '正文\n\n' + document,
    '`' + marker + '`',
  ])('does not promote ordinary Markdown or a sample to a dedicated document', (input) => {
    expect(parseDiagramDocument(input).status).toBe('ordinary');
    expect(() => replaceDiagramPrimary(input, body)).toThrow();
  });

  it.each([
    document.replace('"version":1', '"version":9'),
    document.replace('"flowchart"', '"unknown"'),
    document.replace('"mermaid"', '"excalidraw"'),
    document.replace('"version":1', '"version":"1"'),
    document.replace('"custom":', 'bad-json:'),
    document.replace('<!-- dooknow:primary:end -->', ''),
    document.replace('<!-- dooknow:primary:start -->', ''),
    document + '\n' + marker,
    document.replace('# 架构', marker + '\n\n# 架构'),
    document.replace(
      '<!-- dooknow:primary:end -->',
      '<!-- dooknow:primary:start -->\n\n<!-- dooknow:primary:end -->',
    ),
    document.replace('```mermaid', '```svg'),
    document.replace('assets/diagram.png', 'https://private.example/image.png'),
    document.replace('assets/diagram.png', '/srv/private.png'),
    document.replace(binding, ''),
    document.replace(binding, binding + '\n\n' + binding),
  ])('falls back without changing malformed or unsupported dedicated bytes', (input) => {
    expect(parseDiagramDocument(input).status).toBe('invalid');
    expect(() => replaceDiagramPrimary(input, body)).toThrow();
  });

  it('ignores fake duplicate markers inside fenced code and blockquotes', () => {
    const input =
      document +
      '\n```md\n' +
      marker +
      '\n<!-- dooknow:primary:start -->\n```\n\n> ' +
      marker +
      '\n';
    expect(parseDiagramDocument(input).status).toBe('diagram');
  });

  it('replaces only managed bytes, preserving metadata, frontmatter, descriptions and CRLF', () => {
    const input = '\uFEFF---\r\nfoo: untouched\r\n---\r\n' + document.replace(/\n/g, '\r\n');
    const result = parseDiagramDocument(input);
    if (result.status !== 'diagram') throw Error('expected diagram');
    const replacement = body.replace('A[中文]', 'A[更新]').replace(/\n/g, '\r\n');
    const output = replaceDiagramPrimary(input, replacement);
    expect(output).toBe(
      input.slice(0, result.primary.contentRange.from) +
        '\r\n' +
        replacement +
        '\r\n' +
        input.slice(result.primary.contentRange.to),
    );
    expect(parseDiagramDocument(output).status).toBe('diagram');
  });

  it('rejects a replacement that would break managed boundaries or the primary source type', () => {
    expect(() => replaceDiagramPrimary(document, '<!-- dooknow:primary:end -->')).toThrow();
    expect(() => replaceDiagramPrimary(document, body.replace('```mermaid', '```svg'))).toThrow();
  });

  it.each(['whiteboard', 'mindmap', 'flowchart'])(
    'renders complete %s examples as standard Markdown',
    (type) => {
      const input = readFileSync(
        new URL('./fixtures/diagram-documents/' + type + '.md', import.meta.url),
        'utf8',
      );
      const result = parseDiagramDocument(input);
      expect(result.status).toBe('diagram');
      if (result.status !== 'diagram') throw Error('expected diagram');
      expect(result.type).toBe(type);
      const html = new MarkdownIt({ html: true }).render(input);
      expect(html).toMatch(/<img src="assets\//);
      expect(html).toContain('说明');
      expect(html).not.toContain('/api/');
    },
  );
});

it('accepts a mindmap consisting of only the root title without inventing an empty child', () => {
  const input = readFileSync(
    new URL('./fixtures/diagram-documents/mindmap.md', import.meta.url),
    'utf8',
  ).replace('- 系统\n  - 知识库\n  - 工作区\n- 家庭服务\n', '');
  const result = parseDiagramDocument(input);
  expect(result.status).toBe('diagram');
  if (result.status !== 'diagram') throw Error('expected diagram');
  expect(result.primary.source).toEqual({ format: 'markdown-outline', content: '' });
});

it.each([
  '<video src="important.mp4"></video>\n',
  '<!-- dooknow:future important="data" -->\n',
  '## 未支持区域标题\n',
  '额外正文不应被忽略\n',
])(
  'refuses unsupported managed content rather than deleting it on a graphical save (%j)',
  (addition) => {
    const input = document.replace(
      '<!-- dooknow:primary:end -->',
      addition + '\n<!-- dooknow:primary:end -->',
    );
    expect(parseDiagramDocument(input).status).toBe('invalid');
    expect(() => replaceDiagramPrimary(input, body)).toThrow();
  },
);
it('refuses rich text in the managed mindmap subset', () => {
  const input = readFileSync(
    new URL('./fixtures/diagram-documents/mindmap.md', import.meta.url),
    'utf8',
  ).replace('- 系统', '- **系统**');
  expect(parseDiagramDocument(input).status).toBe('invalid');
});
