import MarkdownIt from 'markdown-it';
import { parseMindmapOutline } from './mindmap-outline.js';
import { z } from 'zod';
import { frontmatterRange } from './frontmatter-range.js';
import { parsePrimaryBinding, type PrimaryBinding } from './diagram-document-binding.js';

export type DiagramDocumentType = 'whiteboard' | 'mindmap' | 'flowchart';
export type SourceRange = { from: number; to: number };
export const diagramDocumentMetadataSchema = z
  .object({
    version: z.literal(1),
    type: z.enum(['whiteboard', 'mindmap', 'flowchart']),
    engine: z.enum(['excalidraw', 'mind-elixir', 'mermaid']),
    render: z
      .object({ renderer: z.string().min(1).max(160), config: z.record(z.string(), z.unknown()) })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine(
    (value) =>
      ({ whiteboard: 'excalidraw', mindmap: 'mind-elixir', flowchart: 'mermaid' })[value.type] ===
      value.engine,
  );
export type DiagramDocumentMetadata = z.infer<typeof diagramDocumentMetadataSchema>;
export type DiagramPrimary = {
  role: 'primary';
  contentRange: SourceRange;
  range: SourceRange;
  source:
    | { format: 'excalidraw'; path: string }
    | { format: 'markdown-outline' | 'mermaid'; content: string };
  previewPath: string;
  summary?: string;
  binding: PrimaryBinding;
};
export type DiagramDocumentParse =
  | { status: 'ordinary' }
  | { status: 'invalid'; reason: string; unsupported?: true }
  | {
      status: 'diagram';
      type: DiagramDocumentType;
      metadata: DiagramDocumentMetadata;
      markerRange: SourceRange;
      title: string;
      primary: DiagramPrimary;
    };
const parser = new MarkdownIt({ html: true, maxNesting: 512 });
const startMarker = '<!-- dooknow:primary:start -->';
const endMarker = '<!-- dooknow:primary:end -->';

/** Relative portable URL; resolution and workspace containment are checked by the resource service. */
export function isDiagramRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[?#]/.test(value)) return false;
  try {
    const decoded = decodeURIComponent(value);
    return (
      !/^[a-z][a-z\d+.-]*:|^[\/\\]|[\\\u0000-\u0020\u007f]/i.test(decoded.replace(/ /g, '')) &&
      !/[\r\n\u0000-\u001f]/.test(decoded) &&
      !decoded.startsWith(' ')
    );
  } catch {
    return false;
  }
}
function lineStarts(source: string) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\r') {
      if (source[index + 1] === '\n') index++;
      starts.push(index + 1);
    } else if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** Parse actual top-level tokens and retain ranges into the original, unnormalized string. */
export function parseDiagramDocument(markdown: string): DiagramDocumentParse {
  const base = frontmatterRange(markdown)?.end ?? (markdown.startsWith('\uFEFF') ? 1 : 0);
  const source = markdown.slice(base);
  // Ordinary notes need no full Markdown tokenization merely to discover their type.
  if (!/^[ \t\r\n]*<!-- dooknow:document\b/.test(source)) return { status: 'ordinary' };
  const starts = lineStarts(source);
  const tokens = parser.parse(source, {});
  const topComments = tokens.filter((token) => token.type === 'html_block' && token.level === 0);
  const first = tokens[0];
  if (
    !first ||
    first.type !== 'html_block' ||
    first.level !== 0 ||
    !/^<!-- dooknow:document\b/.test(first.content.trim())
  )
    return { status: 'ordinary' };
  const invalid = (reason: string): DiagramDocumentParse => ({ status: 'invalid', reason });
  const declarations = topComments.filter((token) =>
    /^<!-- dooknow:document\b/.test(token.content.trim()),
  );
  if (declarations.length !== 1) return invalid('文档类型标记重复');
  const match = /^<!-- dooknow:document (\{[^\r\n]*\}) -->$/.exec(first.content.trim());
  if (!match) return invalid('文档类型标记格式不正确');
  let metadata: DiagramDocumentMetadata;
  let rawMetadata: Record<string, unknown> | undefined;
  try {
    const value = JSON.parse(match[1]);
    if (value && typeof value === 'object' && !Array.isArray(value)) rawMetadata = value;
    metadata = diagramDocumentMetadataSchema.parse(value);
  } catch {
    if (
      rawMetadata &&
      (rawMetadata.version !== 1 ||
        !['whiteboard', 'mindmap', 'flowchart'].includes(String(rawMetadata.type)) ||
        !['excalidraw', 'mind-elixir', 'mermaid'].includes(String(rawMetadata.engine)))
    )
      return { status: 'invalid', reason: '文档类型、引擎或版本不受支持', unsupported: true };
    return invalid('文档类型、引擎或版本不受支持');
  }
  const range = (token: (typeof tokens)[number]): SourceRange => ({
    from: base + starts[token.map![0]],
    to: base + (starts[token.map![1]] ?? source.length),
  });
  const boundaries = topComments.filter((token) =>
    /^<!-- dooknow:primary:(?:start|end)\b/.test(token.content.trim()),
  );
  if (
    boundaries.length !== 2 ||
    boundaries[0].content.trim() !== startMarker ||
    boundaries[1].content.trim() !== endMarker
  )
    return invalid('主图受管区域缺失或重复');
  const opening = range(boundaries[0]),
    closing = range(boundaries[1]);
  const contentRange = { from: opening.to, to: closing.from };
  const within = tokens.filter(
    (token) =>
      token.map && range(token).from >= contentRange.from && range(token).to <= contentRange.to,
  );
  const headings = tokens.filter(
    (token) =>
      token.type === 'heading_open' &&
      token.level === 0 &&
      token.tag === 'h1' &&
      range(token).from < opening.from,
  );
  if (headings.length !== 1) return invalid('主图需要一个根标题');
  const titleToken = tokens[tokens.indexOf(headings[0]) + 1];
  const title = (titleToken.children || [])
    .filter((token) => ['text', 'code_inline'].includes(token.type))
    .map((token) => token.content)
    .join('');
  if (!title.trim()) return invalid('主图根标题为空');
  const bindings = within.filter(
    (token) =>
      token.type === 'html_block' &&
      token.level === 0 &&
      /^<!-- dooknow:primary-binding\b/.test(token.content.trim()),
  );
  if (bindings.length !== 1) return invalid('主图预览绑定缺失或重复');
  const binding = parsePrimaryBinding(bindings[0].content);
  if (!binding) return invalid('主图预览绑定不受支持');
  const paragraphs = within.filter(
    (token) =>
      token.type === 'inline' &&
      token.level === 1 &&
      tokens[tokens.indexOf(token) - 1]?.type === 'paragraph_open',
  );
  const images = paragraphs.flatMap((token) =>
    token.children?.length === 1 && token.children[0].type === 'image' ? [token.children[0]] : [],
  );
  const previewPath = images.length === 1 ? images[0].attrGet('src') : undefined;
  if (!isDiagramRelativePath(previewPath) || !/\.png$/i.test(previewPath))
    return invalid('主图需要一个相对路径 PNG 预览');
  const allowedBlocks = new Set(['paragraph_open', 'fence', 'bullet_list_open', 'html_block']);
  if (
    within.some(
      (token) =>
        token.level === 0 &&
        (!allowedBlocks.has(token.type) || (token.type === 'html_block' && token !== bindings[0])),
    )
  )
    return invalid('主图包含不受支持的内容');
  if (
    metadata.type !== 'whiteboard' &&
    paragraphs.some(
      (token) => !(token.children?.length === 1 && token.children[0].type === 'image'),
    )
  )
    return invalid('主图包含未受管的正文');
  const fences = within.filter((token) => token.type === 'fence' && token.level === 0);
  let primarySource: DiagramPrimary['source'];
  let summary: string | undefined;
  if (metadata.type === 'whiteboard') {
    const links = paragraphs.flatMap((token) => {
      const c = token.children;
      return c?.length === 3 &&
        c[0].type === 'link_open' &&
        c[1].type === 'text' &&
        c[2].type === 'link_close'
        ? [c[0].attrGet('href')]
        : [];
    });
    if (
      fences.length > 1 ||
      (fences.length === 1 && fences[0].info.trim() !== 'text') ||
      links.length !== 1 ||
      !isDiagramRelativePath(links[0]) ||
      !/\.excalidraw$/i.test(links[0])
    )
      return invalid('白板需要一个相对路径场景附件');
    primarySource = { format: 'excalidraw', path: links[0] };
    if (fences.length) {
      const fence = fences[0],
        [from, to] = fence.map!;
      const closingLine = source.slice(starts[to - 1], starts[to] ?? source.length).trim();
      if (!new RegExp('^' + fence.markup[0] + '{' + fence.markup.length + ',}$').test(closingLine))
        return invalid('白板摘要代码块未闭合');
      summary = source.slice(starts[from + 1], starts[to - 1]);
    }
  } else if (metadata.type === 'flowchart') {
    if (fences.length !== 1 || fences[0].info.trim() !== 'mermaid')
      return invalid('流程图需要一个 Mermaid 源码块');
    const fence = fences[0],
      [from, to] = fence.map!;
    const closingLine = source.slice(starts[to - 1], starts[to] ?? source.length).trim();
    if (!new RegExp('^' + fence.markup[0] + '{' + fence.markup.length + ',}$').test(closingLine))
      return invalid('流程图源码块未闭合');
    const content = source.slice(starts[from + 1], starts[to - 1]);
    if (!content.trim()) return invalid('流程图源码为空');
    primarySource = { format: 'mermaid', content };
  } else {
    const lists = within.filter((token) => token.type === 'bullet_list_open' && token.level === 0);
    if (fences.length || lists.length > 1) return invalid('脑图仅支持一个无序大纲');
    const r = lists.length ? range(lists[0]) : undefined;
    const lastNode = r
      ? within
          .filter(
            (token) =>
              token.type === 'inline' &&
              token.level > 1 &&
              range(token).from >= r.from &&
              range(token).to <= r.to,
          )
          .at(-1)
      : undefined;
    const content = r && lastNode ? markdown.slice(r.from, range(lastNode).to) : '';
    const headingRange = range(headings[0]);
    try {
      parseMindmapOutline(
        markdown.slice(headingRange.from, headingRange.to).trimEnd() + '\n\n' + content,
      );
    } catch {
      return invalid('脑图大纲包含不受支持的内容');
    }
    primarySource = { format: 'markdown-outline', content };
  }
  return {
    status: 'diagram',
    type: metadata.type,
    metadata,
    markerRange: range(first),
    title,
    primary: {
      role: 'primary',
      contentRange,
      range: { from: opening.from, to: closing.to },
      source: primarySource,
      ...(summary !== undefined ? { summary } : {}),
      previewPath,
      binding,
    },
  };
}

/** A failed parse is a recovery surface, never an invitation to overwrite unknown bytes. */
export function replaceDiagramPrimary(markdown: string, body: string) {
  const parsed = parseDiagramDocument(markdown);
  if (parsed.status !== 'diagram') throw Error('无法安全更新主图，请使用 Markdown 源码恢复');
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const { from, to } = parsed.primary.contentRange;
  const replacement = eol + body.replace(/(?:\r?\n)+$/, '') + eol + eol;
  const result = markdown.slice(0, from) + replacement + markdown.slice(to);
  if (parseDiagramDocument(result).status !== 'diagram') throw Error('主图更新格式不正确');
  return result;
}
