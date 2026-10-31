import { posix } from 'node:path';
import { markdownDestinationSpans } from '../../../shared/markdown-destinations.js';
import { encodePortablePathSegment } from '../../../shared/portable-figure.js';
import { localReference } from '../render.js';
/** Edit only destinations from the historical path; preserve code, metadata and prose bytes. */
export function rebaseRevisionMarkdown(markdown: string, before: string, after: string) {
  if (posix.dirname(before) === posix.dirname(after)) return markdown;
  for (const span of markdownDestinationSpans(markdown).sort((a, b) => b.start - a.start)) {
    const path = localReference(before, span.url);
    if (!path) continue;
    const suffix = span.url.match(/[?#].*$/)?.[0] ?? '';
    let url =
      posix
        .relative(posix.dirname(after), path)
        .split('/')
        .map(encodePortablePathSegment)
        .join('/') + suffix;
    if (span.wiki) {
      const label = span.wiki.label.replace(/[\\\[\]*_`<>|]/g, '\\$&');
      url = `[${label}](<${url.replace(/[<>]/g, encodeURIComponent)}>)`;
    }
    markdown = markdown.slice(0, span.start) + url + markdown.slice(span.end);
  }
  return markdown;
}
