import MarkdownIt from 'markdown-it';
import { parseDiagramDocument, type SourceRange } from './diagram-document.js';
import { frontmatterRange } from './frontmatter-range.js';

export type DiagramTextSpan = SourceRange & {
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
};
const parser = new MarkdownIt({ html: true, maxNesting: 512 });
const encoder = new TextEncoder();
/** Classification is bounded; ordinary long notes never enter the Markdown tokenizer. */
export function diagramHeaderCandidate(prefix: string) {
  const base = frontmatterRange(prefix)?.end ?? (prefix.startsWith('\ufeff') ? 1 : 0);
  return /^[ \t\r\n]*<!-- dooknow:document\b/.test(prefix.slice(base));
}

/** Searchable text remains a collection of slices of the authoritative Markdown. */
export function diagramTextSpans(markdown: string): DiagramTextSpan[] | undefined {
  if (!diagramHeaderCandidate(markdown.slice(0, 16384))) return;
  const parsed = parseDiagramDocument(markdown);
  if (parsed.status !== 'diagram') return;
  const ranges: SourceRange[] = [];
  const start = frontmatterRange(markdown)?.end ?? (markdown.startsWith('\ufeff') ? 1 : 0);
  ranges.push({ from: start, to: parsed.markerRange.from });
  ranges.push({ from: parsed.markerRange.to, to: parsed.primary.range.from });
  // Parse only the managed region, retaining original CRLF and fence content offsets.
  const base = parsed.primary.contentRange.from;
  const managed = markdown.slice(base, parsed.primary.contentRange.to);
  const starts = [0];
  for (let i = 0; i < managed.length; i++) if (managed[i] === '\n') starts.push(i + 1);
  const tokens = parser.parse(managed, {});
  for (const token of tokens) {
    if (!token.map || token.level !== 0) continue;
    const [from, to] = token.map;
    if (token.type === 'fence') {
      ranges.push({ from: base + starts[from + 1], to: base + (starts[to - 1] ?? managed.length) });
    } else if (token.type === 'bullet_list_open' && parsed.type === 'mindmap') {
      ranges.push({ from: base + starts[from], to: base + (starts[to] ?? managed.length) });
    }
  }
  ranges.push({ from: parsed.primary.range.to, to: markdown.length });
  let char = 0,
    byte = 0,
    line = 1;
  return ranges
    .sort((a, b) => a.from - b.from)
    .filter((r) => markdown.slice(r.from, r.to).trim())
    .map((r) => {
      const before = markdown.slice(char, r.from);
      byte += encoder.encode(before).length;
      line += (before.match(/\n/g) ?? []).length;
      const content = markdown.slice(r.from, r.to),
        size = encoder.encode(content).length;
      const span = {
        ...r,
        startByte: byte,
        endByte: byte + size,
        startLine: line,
        endLine: line + (content.match(/\n/g) ?? []).length - (content.endsWith('\n') ? 1 : 0),
      };
      char = r.to;
      byte += size;
      line += (content.match(/\n/g) ?? []).length;
      return span;
    });
}

/** Same characters and line positions, with nonsemantic bytes hidden from graph/model input. */
export function diagramAnalysisText(markdown: string) {
  const spans = diagramTextSpans(markdown);
  if (!spans) return markdown;
  const parts: string[] = [];
  let offset = 0;
  for (const span of spans) {
    parts.push(
      markdown.slice(offset, span.from).replace(/[^\r\n]/g, ' '),
      markdown.slice(span.from, span.to),
    );
    offset = span.to;
  }
  parts.push(markdown.slice(offset).replace(/[^\r\n]/g, ' '));
  return parts.join('');
}
