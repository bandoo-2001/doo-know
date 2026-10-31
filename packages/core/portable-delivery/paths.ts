import { htmlResourceSpans } from '../../../shared/html-resources.js';
import MarkdownIt from 'markdown-it';
import { posix } from 'node:path';
import { markdownDestinationSpans } from '../../../shared/markdown-destinations.js';
import { localReference } from '../render.js';
import { fail } from '../knowledge/errors.js';
import { knowledgeMarkdown } from '../../../shared/knowledge-markdown.js';
import { encodePortablePathSegment } from '../../../shared/portable-figure.js';

const parser = new MarkdownIt({ html: true }).use(knowledgeMarkdown);
const navigationParser = new MarkdownIt({ html: false, linkify: true }).use(knowledgeMarkdown);
// Discovery is not rendering. Recognize unsupported schemes so they produce an
// explicit diagnostic instead of being mistaken for resource-free literal text.
parser.validateLink = () => true;
export function destinations(markdown: string) {
  const urls: { url: string; image: boolean }[] = [];
  const htmlUrls: string[] = [];
  function visit(tokens: ReturnType<typeof parser.parse>) {
    let rawText: string | undefined;
    for (const token of tokens) {
      if (rawText) {
        if (
          token.type === 'html_inline' &&
          new RegExp('</' + rawText + '\\s*>', 'i').test(token.content)
        )
          rawText = undefined;
        continue;
      }
      if (token.type === 'html_inline') {
        const raw = /^<(script|style|textarea|title)\b/i.exec(token.content);
        if (raw) {
          rawText = raw[1].toLowerCase();
          continue;
        }
      }

      if (
        (token.type === 'html_block' || token.type === 'html_inline') &&
        /<(?:iframe|object|embed)\b/i.test(token.content)
      )
        fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED', 'HTML 活动嵌入不能完整离线导出');
      if (token.type === 'html_block' || token.type === 'html_inline')
        for (const span of htmlResourceSpans(token.content, parser.utils.unescapeAll))
          htmlUrls.push(span.url);
      if (token.type === 'image' || token.type === 'link_open')
        urls.push({
          url: String(token.attrGet(token.type === 'image' ? 'src' : 'href') || ''),
          image: token.type === 'image',
        });
      if (token.children) visit(token.children);
    }
  }
  visit(parser.parse(markdown, {}));
  const htmlSpans = markdownDestinationSpans(markdown).filter((span) => span.html);
  if (htmlSpans.length !== htmlUrls.length)
    fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED', 'HTML 资源源码范围无法安全改写');
  for (const span of htmlSpans) urls.push({ url: span.url, image: true });
  return urls;
}
export function rewriteDestinations(
  markdown: string,
  sourcePath: string,
  targetPath: string,
  mapping: Map<string, string>,
  navigation?: { origin: string; notePaths: Map<string, string> },
) {
  const mediaLinks = new Set<string>();
  const replacements = markdownDestinationSpans(markdown)
    .flatMap((span) => {
      const own = navigation && internalNoteNavigation(span.url, navigation.origin);
      const local = own
          ? navigation!.notePaths.get(own.noteId)
          : localReference(sourcePath, span.url),
        mapped = (local && mapping.get(local)) || mapping.get(span.url);
      if (!mapped) return [];
      const suffix = (
        own ? own.fragment : mapping.has(span.url) ? '' : span.url.match(/[?#].*$/)?.[0] || ''
      ).replace(/[!'()*]/g, encodePortablePathSegment);
      const url =
        posix
          .relative(posix.dirname(targetPath), mapped)
          .split('/')
          .map(encodePortablePathSegment)
          .join('/') + suffix;
      if (span.media || /\.(?:mp4|webm|mp3|wav)$/i.test(mapped)) mediaLinks.add(url);
      if (span.wiki) {
        const label = span.wiki.label.replace(/[\\\[\]*_`]/g, '\\$&');
        return [{ ...span, replacement: `[${label}](<${url}>)` }];
      }
      return url === span.url ? [] : [{ ...span, replacement: url }];
    })
    .sort((a, b) => b.start - a.start);
  for (const span of replacements)
    markdown = markdown.slice(0, span.start) + span.replacement + markdown.slice(span.end);
  const fallbacks = [...mediaLinks].filter((url) => !markdown.includes(`[媒体文件](<${url}>)`));
  if (fallbacks.length)
    markdown += '\n\n' + fallbacks.map((url) => `[媒体文件](<${url}>)`).join('\n\n') + '\n';
  return markdown;
}
/** Only the app's own root navigation is an identity reference. External query
 * parameters never authorize following another site's similarly named links. */
export function internalNoteNavigation(
  value: string,
  origin: string,
): { noteId: string; fragment: string } | undefined {
  try {
    const base = new URL(origin),
      url = new URL(value, base);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.origin !== base.origin ||
      url.pathname !== '/' ||
      !url.searchParams.has('note')
    )
      return;
    return { noteId: url.searchParams.get('note')!, fragment: url.hash };
  } catch {
    return;
  }
}
/** Catch app-owned autolinks/other navigation forms for which no safe source
 * destination span was available. Code examples remain opaque. */
export function unresolvedInternalNavigation(markdown: string, origin: string): string | undefined {
  function visit(tokens: ReturnType<typeof navigationParser.parse>): string | undefined {
    for (const token of tokens) {
      if (token.type === 'link_open') {
        const url = String(token.attrGet('href') || '');
        if (internalNoteNavigation(url, origin)) return url;
      }
      if (token.children) {
        const url = visit(token.children);
        if (url) return url;
      }
    }
  }
  return visit(navigationParser.parse(markdown, {}));
}
/** Native source bytes are authoritative. Never silently rebind an old PNG after relocation. */
export function checkNativeLinks(source: string, document: string, origin?: string) {
  const scene = JSON.parse(source);
  for (const element of scene.elements || [])
    if (
      typeof element.link === 'string' &&
      element.link &&
      (!/^https?:\/\//i.test(element.link) ||
        !!(origin && internalNoteNavigation(element.link, origin)))
    )
      fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '原生场景链接重定位需要新的匹配预览', false, {
        documents: [{ document, role: 'primary' }],
        reason: 'native-link-relocation',
      });
}
