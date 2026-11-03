import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as primary from '../shared/diagram-primary';
import { parseDiagramDocument } from '../shared/diagram-document';
import { emptyWhiteboard } from '../shared/whiteboard';
function prepared(
  type: 'whiteboard' | 'mindmap' | 'flowchart',
  title = '原始 [标题]',
): primary.PreparedDiagramPrimary {
  return {
    id: 'receipt',
    noteId: 'note',
    type,
    documentHash: 'a'.repeat(64),
    baselineSourceHash: 'b'.repeat(64),
    sourceHash: 'c'.repeat(64),
    renderHash: 'd'.repeat(64),
    previewHash: 'e'.repeat(64),
    title,
    renderer: primary.diagramRendererVersions[type],
    config: { layout: 'first' },
    preview: {
      id: 'preview',
      relativePath: '00-Inbox/_doo-assets/new.png',
      markdownPath: '_doo-assets/new.png',
      mime: 'image/png',
    },
    ...(type === 'whiteboard'
      ? {
          source: {
            id: 'source',
            relativePath: '00-Inbox/_doo-assets/new.excalidraw',
            markdownPath: '_doo-assets/new.excalidraw',
            mime: 'application/vnd.excalidraw+json',
          },
        }
      : {}),
    expiresAt: Date.now() + 60000,
  };
}
const source = (type: string) =>
  type === 'whiteboard'
    ? JSON.stringify({
        ...emptyWhiteboard(),
        elements: [{ id: 'label', type: 'text', text: '当前文字' }],
      })
    : type === 'mindmap'
      ? '- 当前子节点\n'
      : 'flowchart TD\n A[当前] --> B\n';
it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
  'replaces only %s managed bytes and render metadata, preserving user description and unknown fields',
  (type) => {
    const first = prepared(type),
      original = primary.renderPreparedDiagramDocument({
        prepared: first,
        title: first.title,
        source: source(type),
      }),
      metadata = {
        version: 1,
        type,
        engine: { whiteboard: 'excalidraw', mindmap: 'mind-elixir', flowchart: 'mermaid' }[type],
        custom: { keep: '未知字段' },
        render: { renderer: first.renderer, config: first.config, adapterFuture: { keep: 42 } },
      };
    const withMetadata = original.replace(
        /^<!-- dooknow:document .* -->/,
        `<!-- dooknow:document ${JSON.stringify(metadata)} -->`,
      ),
      preamble = '\uFEFF---\r\ncustom: exact\r\n---\r\n\r\n',
      description = '\r\n## 用户说明\r\n  保留 [链接](../其他.md) 和结尾空格  \r\n';
    const markdown = preamble + withMetadata + description,
      next = {
        ...prepared(type),
        sourceHash: createHash('sha256').update(source(type)).digest('hex'),
        preview: { ...first.preview, markdownPath: '_doo-assets/next.png' },
        config: { layout: 'next' },
      };
    const apply = primary.applyPreparedDiagramDocument;
    expect(apply).toBeTypeOf('function');
    const result = apply({ markdown, prepared: next, source: source(type) }),
      parsed = parseDiagramDocument(result);
    expect(result.startsWith(preamble)).toBe(true);
    expect(result.endsWith(description)).toBe(true);
    expect(parsed).toMatchObject({
      status: 'diagram',
      title: first.title,
      metadata: {
        custom: { keep: '未知字段' },
        render: { config: { layout: 'next' }, adapterFuture: { keep: 42 } },
      },
      primary: { previewPath: '_doo-assets/next.png', binding: { sourceHash: next.sourceHash } },
    });
    if (parsed.status === 'diagram' && parsed.primary.source.format !== 'excalidraw')
      expect(parsed.primary.source.content).toBe(source(type));
  },
);
it('does not silently convert a document type or repair unsupported Markdown', () => {
  const p = prepared('mindmap'),
    markdown = primary.renderPreparedDiagramDocument({
      prepared: p,
      title: p.title,
      source: source('mindmap'),
    }),
    apply = primary.applyPreparedDiagramDocument;
  expect(apply).toBeTypeOf('function');
  expect(() =>
    apply({ markdown, prepared: prepared('flowchart'), source: source('flowchart') }),
  ).toThrow();
  expect(() =>
    apply({ markdown: '# ordinary\n', prepared: p, source: source('mindmap') }),
  ).toThrow();
  expect(() =>
    apply({ markdown, prepared: { ...p, title: '不同快照' }, source: source('mindmap') }),
  ).toThrow();
});
