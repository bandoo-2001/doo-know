import { posix } from 'node:path';
import { markdownDestinationSpans } from '../../../shared/markdown-destinations.js';
import { encodePortablePathSegment } from '../../../shared/portable-figure.js';
import { localReference } from '../render.js';
import { openSync, closeSync, readSync, constants, fstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { DestinationSpan } from '../../../shared/markdown-destinations.js';
import { limits } from './limits.js';
import { boundDiagramSources } from '../../../shared/diagram-portability.js';
import { frontmatterRange } from '../../../shared/frontmatter-range.js';
export type RevisionDestination = DestinationSpan & { startByte: number; endByte: number };
export type RevisionNativeGroup = {
  start: number;
  end: number;
  sourcePath: string;
  previewPath: string;
  sourceHash: string;
  code: string;
  codeHash: string;
  pair?: true;
};
/** Bounded paragraphs retain Markdown's syntax rules; giant reference-free lines never accumulate. */
export function scanRevisionDestinations(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    buffer = Buffer.allocUnsafe(limits.io),
    decoder = new StringDecoder('utf8');
  const size = fstatSync(fd).size;
  if (size <= limits.ordinary) {
    try {
      const chunks: Buffer[] = [];
      let count: number;
      while ((count = readSync(fd, buffer)) > 0)
        chunks.push(Buffer.from(buffer.subarray(0, count)));
      const bytes = Buffer.concat(chunks),
        content = bytes.toString('utf8'),
        front = frontmatterRange(content);
      return {
        complete: true,
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        spans: markdownDestinationSpans(content)
          .filter((span) => !front || span.start >= front.end)
          .map((span) => ({
            ...span,
            startByte: Buffer.byteLength(content.slice(0, span.start)),
            endByte: Buffer.byteLength(content.slice(0, span.end)),
          })),
        nativeGroups: boundDiagramSources(content)
          .filter((g) => g.kind === 'excalidraw' && (!front || g.prefixFrom >= front.end))
          .map((group) => ({
            start: Buffer.byteLength(content.slice(0, group.prefixFrom)),
            end: Buffer.byteLength(content.slice(0, group.to)),
            sourcePath: group.sourcePath,
            previewPath: group.previewPath,
            sourceHash: group.binding.sourceHash,
            code: group.code,
            codeHash: group.binding.codeHash,
          })),
      };
    } finally {
      closeSync(fd);
    }
  }
  const digest = createHash('sha256');
  const spans: RevisionDestination[] = [],
    nativeGroups: RevisionNativeGroup[] = [];
  let line = '',
    paragraph = '',
    recent = '',
    recentStart = 0,
    lineBytes = 0,
    paragraphStart = 0,
    offset = 0,
    overflow = false,
    complete = true,
    pendingCR = false,
    rawEnd: RegExp | undefined,
    fence: { char: string; length: number; native: boolean } | undefined,
    frontmatter = false,
    first = true;
  const bound = 256 * 1024;
  const flush = () => {
    if (/[\[<]/.test(paragraph))
      for (const span of markdownDestinationSpans(paragraph)) {
        if (spans.length >= 10000) {
          complete = false;
          break;
        }
        spans.push({
          ...span,
          startByte: paragraphStart + Buffer.byteLength(paragraph.slice(0, span.start)),
          endByte: paragraphStart + Buffer.byteLength(paragraph.slice(0, span.end)),
        });
      }
    paragraph = '';
  };
  const consume = (value: string, bytes: number, tooLong: boolean) => {
    const start = offset;
    offset += bytes;
    if (tooLong) {
      recent = '';
      recentStart = offset;
    } else {
      if (!recent) recentStart = start;
      recent += value;
      if (recent.length > bound) {
        const cut = recent.indexOf('\n', recent.length - bound);
        if (cut >= 0) {
          recentStart += Buffer.byteLength(recent.slice(0, cut + 1));
          recent = recent.slice(cut + 1);
        }
      }
    }
    if (first) {
      frontmatter = /^\ufeff?---\s*$/.test(value);
      first = false;
      if (frontmatter) return;
    }
    if (frontmatter) {
      if (/^(?:---|\.\.\.)\s*$/.test(value)) frontmatter = false;
      return;
    }
    if (tooLong) {
      flush();
      if (/[\[<]/.test(value)) complete = false;
      return;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(value);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        /^ {0,3}(?:`+|~+)\s*$/.test(value)
      ) {
        if (fence.native)
          for (const group of boundDiagramSources(recent).filter((g) => g.kind === 'excalidraw'))
            if (recentStart + Buffer.byteLength(recent.slice(0, group.to)) === offset)
              nativeGroups.push({
                start: recentStart + Buffer.byteLength(recent.slice(0, group.prefixFrom)),
                end: offset,
                sourcePath: group.sourcePath,
                previewPath: group.previewPath,
                sourceHash: group.binding.sourceHash,
                code: group.code,
                codeHash: group.binding.codeHash,
              });
        fence = undefined;
      }
      return;
    }
    if (rawEnd) {
      if (rawEnd.test(value)) rawEnd = undefined;
      return;
    }
    const raw = /^ {0,3}<(script|style|textarea|title|pre)\b/i.exec(value);
    if (raw) {
      flush();
      const end = new RegExp('</' + raw[1] + '\\s*>', 'i');
      if (!end.test(value)) rawEnd = end;
      return;
    }
    if (/^ {0,3}<!--/.test(value)) {
      flush();
      if (!value.includes('-->')) rawEnd = /-->/;
      return;
    }
    if (marker) {
      flush();
      fence = {
        char: marker[1][0],
        length: marker[1].length,
        native: value.slice(marker[0].length).trim() === 'excalidraw',
      };
      return;
    }
    if (paragraph.length + value.length > bound) {
      if (/[\[<]/.test(paragraph + value)) complete = false;
      flush();
    }
    if (!paragraph) paragraphStart = start;
    paragraph += value;
    if (!value.trim()) flush();
  };
  const appendPart = (part: string) => {
    lineBytes += Buffer.byteLength(part);
    if (!overflow && line.length + part.length <= bound) line += part;
    else {
      if (/[\[<]/.test(line + part)) complete = false;
      overflow = true;
    }
  };
  const endLine = () => {
    consume(line, lineBytes, overflow);
    line = '';
    lineBytes = 0;
    overflow = false;
  };
  const append = (text: string) => {
    let from = 0;
    if (pendingCR) {
      if (text.startsWith('\n')) {
        appendPart('\n');
        from = 1;
      }
      endLine();
      pendingCR = false;
    }
    while (from < text.length) {
      const cr = text.indexOf('\r', from),
        lf = text.indexOf('\n', from),
        end = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
      if (end < 0) {
        appendPart(text.slice(from));
        break;
      }
      let to = end + 1;
      if (text[end] === '\r' && text[to] === '\n') to++;
      appendPart(text.slice(from, to));
      from = to;
      if (text[end] === '\r' && to === end + 1 && to === text.length) {
        pendingCR = true;
        break;
      }
      endLine();
    }
  };
  try {
    let count: number;
    while ((count = readSync(fd, buffer)) > 0) {
      digest.update(buffer.subarray(0, count));
      append(decoder.write(buffer.subarray(0, count)));
    }
    append(decoder.end());
    if (pendingCR) {
      endLine();
      pendingCR = false;
    }
    if (lineBytes) consume(line, lineBytes, overflow);
    flush();
    return { spans, nativeGroups, complete, contentHash: digest.digest('hex') };
  } finally {
    closeSync(fd);
  }
}
export function revisionDestinationUrl(
  span: DestinationSpan,
  before: string,
  after: string,
  mapping: ReadonlyMap<string, string>,
) {
  const path = localReference(before, span.url);
  if (!path) return;
  const target = mapping.get(path) ?? path;
  if (target === path && posix.dirname(before) === posix.dirname(after)) return;
  const suffix = span.url.match(/[?#].*$/)?.[0] ?? '';
  let url =
    posix
      .relative(posix.dirname(after), target)
      .split('/')
      .map(encodePortablePathSegment)
      .join('/') + suffix;
  if (span.wiki) {
    const label = span.wiki.label.replace(/[\\\[\]*_`<>|]/g, '\\$&');
    url = `[${label}](<${url.replace(/[<>]/g, encodeURIComponent)}>)`;
  }
  return url;
}
/** Edit only destinations from the historical path; preserve code, metadata and prose bytes. */
export function rebaseRevisionMarkdown(
  markdown: string,
  before: string,
  after: string,
  mapping: ReadonlyMap<string, string> = new Map(),
  excluded: readonly { from: number; to: number }[] = [],
) {
  if (posix.dirname(before) === posix.dirname(after) && !mapping.size) return markdown;
  const front = frontmatterRange(markdown);
  for (const span of markdownDestinationSpans(markdown).sort((a, b) => b.start - a.start)) {
    if (front && span.start < front.end) continue;
    if (excluded.some((range) => span.start >= range.from && span.end <= range.to)) continue;
    const url = revisionDestinationUrl(span, before, after, mapping);
    if (url === undefined) continue;
    markdown = markdown.slice(0, span.start) + url + markdown.slice(span.end);
  }
  return markdown;
}
