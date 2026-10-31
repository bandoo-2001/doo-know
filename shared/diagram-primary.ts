import { parseDiagramDocument, type DiagramDocumentType } from './diagram-document.js';
import { inertJson, serializePrimaryBinding } from './diagram-document-binding.js';
import { serializeMindmapOutline } from './mindmap-outline.js';
import { renderPortableFigure, renderPortableImage } from './portable-figure.js';
import { whiteboardText } from './whiteboard.js';

/** Include the adapter version: a library version alone does not identify the rendering policy. */
export const diagramRendererVersions = {
  whiteboard: 'excalidraw@0.18.1+dooknow@1',
  mindmap: 'mind-elixir@5.15.1+snapdom@3.7.0+dooknow@1',
  flowchart: 'mermaid@12.2.0+dooknow@1',
} as const;
export type PreparedDiagramAsset = {
  id: string;
  relativePath: string;
  markdownPath: string;
  mime: string;
};
export type PreparedDiagramPrimary = {
  id: string;
  noteId: string;
  creationIntentId?: string;
  type: DiagramDocumentType;
  documentHash: string | null;
  baselineSourceHash: string | null;
  sourceHash: string;
  renderHash: string;
  previewHash: string;
  title: string;
  renderer: string;
  config: Record<string, unknown>;
  preview: PreparedDiagramAsset;
  source?: PreparedDiagramAsset;
  expiresAt: number;
};
export function diagramPlainTitle(title: string) {
  return serializeMindmapOutline({ id: 'title', topic: title, children: [] }).trimEnd();
}
export function primaryRenderDescriptor(
  parsed: Extract<ReturnType<typeof parseDiagramDocument>, { status: 'diagram' }>,
) {
  return parsed.metadata.render || { renderer: diagramRendererVersions[parsed.type], config: {} };
}
/** Construct a first complete main file; ordinary description bytes stay outside the managed region. */
export function renderPreparedDiagramDocument(input: {
  prepared: PreparedDiagramPrimary;
  title: string;
  source: string;
  description?: string;
}): string {
  const { prepared: p, source, title } = input;
  if (title !== p.title) throw Error('图形标题已变化，请重新准备预览');
  const binding = serializePrimaryBinding({
    version: 1,
    sourceHash: p.sourceHash,
    renderHash: p.renderHash,
    previewHash: p.previewHash,
  });
  let body: string;
  if (p.type === 'whiteboard') {
    if (!p.source) throw Error('白板源附件缺失');
    const summary = whiteboardText(source);
    const longest = (char: string) => {
      let maximum = 0;
      for (const match of summary.matchAll(new RegExp(char + '+', 'g')))
        maximum = Math.max(maximum, match[0].length);
      return maximum;
    };
    const backticks = longest('`'),
      tildes = longest('~');
    const fence = (backticks <= tildes ? '`' : '~').repeat(
      Math.max(3, Math.min(backticks, tildes) + 1),
    );
    body =
      renderPortableFigure({
        alt: title + ' 预览',
        previewPath: p.preview.markdownPath,
        source: { type: 'file', path: p.source.markdownPath },
      }) +
      '\n' +
      binding +
      '\n' +
      (summary
        ? '\n白板文字摘要：\n\n' +
          fence +
          'text\n' +
          summary +
          (summary.endsWith('\n') ? '' : '\n') +
          fence +
          '\n'
        : '');
  } else if (p.type === 'flowchart') {
    if (!source.endsWith('\n')) throw Error('流程图权威源必须包含结束换行');
    body =
      renderPortableFigure({
        alt: title + ' 预览',
        previewPath: p.preview.markdownPath,
        source: { type: 'fence', language: 'mermaid', code: source },
      }) +
      '\n' +
      binding +
      '\n';
  } else {
    if (source && !source.endsWith('\n')) throw Error('脑图权威源必须包含结束换行');
    body =
      source +
      '\n' +
      renderPortableImage(title + ' 预览', p.preview.markdownPath) +
      '\n\n' +
      binding +
      '\n';
  }
  const metadata = {
    version: 1,
    type: p.type,
    engine: { whiteboard: 'excalidraw', mindmap: 'mind-elixir', flowchart: 'mermaid' }[p.type],
    render: { renderer: p.renderer, config: p.config },
  };
  const result =
    '<!-- dooknow:document ' +
    inertJson(metadata) +
    ' -->\n\n' +
    diagramPlainTitle(title) +
    '\n\n<!-- dooknow:primary:start -->\n\n' +
    body +
    '\n<!-- dooknow:primary:end -->\n' +
    (input.description ? '\n' + input.description : '');
  const parsed = parseDiagramDocument(result);
  if (parsed.status !== 'diagram') throw Error('图形文档内容无法安全序列化');
  if (parsed.primary.source.format !== 'excalidraw' && parsed.primary.source.content !== source)
    throw Error('图形权威源的字节范围无法原样保存，请移除受管大纲首尾的分隔空行');
  return result;
}

/** Replace one prepared primary without rewriting frontmatter, title spelling or user prose. */
export function applyPreparedDiagramDocument(input: {
  markdown: string;
  prepared: PreparedDiagramPrimary;
  source: string;
}): string {
  const current = parseDiagramDocument(input.markdown),
    p = input.prepared;
  if (current.status !== 'diagram' || current.type !== p.type)
    throw Error('文档类型无法安全替换，请使用明确的转换或源码恢复操作');
  if (current.title !== p.title) throw Error('图形标题与准备快照不同，请重新准备预览');
  const complete = renderPreparedDiagramDocument({
      prepared: p,
      title: p.title,
      source: input.source,
    }),
    next = parseDiagramDocument(complete);
  if (next.status !== 'diagram') throw Error('准备后的主图无法解析');
  const metadata = {
    ...current.metadata,
    render: { ...current.metadata.render, renderer: p.renderer, config: p.config },
  };
  const oldHeader = input.markdown.slice(current.markerRange.from, current.markerRange.to),
    indentation = oldHeader.match(/^[ \t]*/)?.[0] ?? '',
    header =
      indentation +
      '<!-- dooknow:document ' +
      inertJson(metadata) +
      ' -->' +
      oldHeader.slice(oldHeader.lastIndexOf('-->') + 3);
  const managed = complete.slice(next.primary.range.from, next.primary.range.to),
    updated =
      input.markdown.slice(0, current.primary.range.from) +
      managed +
      input.markdown.slice(current.primary.range.to);
  return (
    updated.slice(0, current.markerRange.from) + header + updated.slice(current.markerRange.to)
  );
}
