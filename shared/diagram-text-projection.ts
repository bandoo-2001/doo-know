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
/** Constant-memory classification, even when YAML or leading blank lines span many reads. */
export function diagramHeaderProbe() {
  const marker = '<!-- dooknow:document';
  let phase: 'start' | 'opening' | 'yaml' | 'body' | 'marker' = 'start',
    first = true,
    position = 0,
    delimiter = '',
    count = 0,
    invalid = false,
    carriageReturn = false,
    result: boolean | undefined;
  const resetLine = () => {
    delimiter = '';
    count = 0;
    invalid = false;
    carriageReturn = false;
  };
  const delimiterCharacter = (char: string) => {
    if (invalid) return;
    if (carriageReturn) {
      invalid = true;
      return;
    }
    if (!count) {
      if (char !== '-' && (phase !== 'yaml' || char !== '.')) {
        invalid = true;
        return;
      }
      delimiter = char;
      count = 1;
    } else if (count < 3) {
      if (char === delimiter) count++;
      else invalid = true;
    } else if (char === '\r') carriageReturn = true;
    else if (char !== ' ' && char !== '\t') invalid = true;
  };
  return {
    push(text: string): boolean | undefined {
      for (const char of text) {
        if (result !== undefined) break;
        if (first) {
          first = false;
          if (char === '\ufeff') continue;
        }
        if (phase === 'start') {
          phase = char === '-' ? 'opening' : 'body';
        }
        // Its multiline anchors also recognize lone CR and Unicode line separators.
        if (phase === 'yaml' && /[\r\u2028\u2029]/.test(char)) {
          if (!invalid && count === 3) phase = 'body';
          else {
            resetLine();
            continue;
          }
        }
        if (phase === 'opening' || phase === 'yaml') {
          if (char === '\n') {
            if (!invalid && count === 3) phase = phase === 'opening' ? 'yaml' : 'body';
            else if (phase === 'opening') result = false;
            resetLine();
          } else {
            delimiterCharacter(char);
            if (phase === 'opening' && invalid) result = false;
          }
          continue;
        }
        if (phase === 'body') {
          if (/[ \t\r\n]/.test(char)) continue;
          phase = 'marker';
        }
        if (position < marker.length) {
          if (char !== marker[position++]) result = false;
        } else result = !/\w/.test(char);
      }
      return result;
    },
    finish() {
      return result ?? (phase === 'marker' && position === marker.length);
    },
  };
}
/** Ordinary notes never enter the Markdown tokenizer merely for classification. */
export function diagramHeaderCandidate(markdown: string) {
  const probe = diagramHeaderProbe();
  return probe.push(markdown) ?? probe.finish();
}

/** Searchable text remains a collection of slices of the authoritative Markdown. */
export function diagramTextSpans(markdown: string): DiagramTextSpan[] | undefined {
  if (!diagramHeaderCandidate(markdown)) return;
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
