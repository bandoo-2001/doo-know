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
        try {
          const asset = new URL(url, origin);
          if (
            asset.origin === new URL(origin).origin &&
            /^\/api\/assets\/[A-Za-z0-9-]+$/.test(asset.pathname)
          )
            return url;
        } catch {
          /* Invalid links grant no app resource capability. */
        }
      }
      if (token.children) {
        const url = visit(token.children);
        if (url) return url;
      }
    }
  }
  return visit(navigationParser.parse(markdown, {}));
}
/** Passive navigation never becomes a fetched package resource. App-owned API and
 * identity URLs are resolved separately, while relative file references remain dependencies. */
export function externalNavigation(value: string, origin: string) {
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value, origin);
    if (/^(?:mailto|tel):$/i.test(url.protocol)) return true;
    if (!/^(?:https?:)?\/\//i.test(value) || !/^https?:$/.test(url.protocol)) return false;
    return (
      url.origin !== new URL(origin).origin ||
      (!/^\/api(?:\/|$)/i.test(url.pathname) && !internalNoteNavigation(value, origin))
    );
  } catch {
    return false;
  }
}
/** Enumerate only Excalidraw element navigation, never text, appState or embedded file data. */
export function nativeLinks(source: string): string[] {
  const scene = JSON.parse(source);
  return (scene.elements ?? []).flatMap((element: any) =>
    typeof element.link === 'string' && element.link ? [element.link] : [],
  );
}
/** Edit JSON string token ranges, retaining every unrelated source byte. */
export function rewriteNativeLinks(source: string, rewrite: (link: string) => string) {
  JSON.parse(source);
  let at = 0;
  const edits: { start: number; end: number; text: string }[] = [];
  const ws = () => {
    while (at < source.length && /\s/.test(source[at])) at++;
  };
  const string = () => {
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') {
        at += 2;
        continue;
      }
      if (source[at++] === '"')
        return { start, end: at, value: JSON.parse(source.slice(start, at)) as string };
    }
    return fail(400, 'INVALID_DIAGRAM_SOURCE');
  };
  const value = (path: (string | number)[]) => {
    if (path.length > 64) fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED', '原生场景 JSON 嵌套超限');
    ws();
    if (source[at] === '"') {
      const token = string();
      if (
        path.length === 3 &&
        path[0] === 'elements' &&
        typeof path[1] === 'number' &&
        path[2] === 'link'
      ) {
        const next = rewrite(token.value);
        if (next !== token.value) edits.push({ ...token, text: JSON.stringify(next) });
      }
    } else if (source[at] === '{') {
      at++;
      ws();
      while (source[at] !== '}') {
        const key = string().value;
        ws();
        at++;
        value([...path, key]);
        ws();
        if (source[at] !== ',') break;
        at++;
        ws();
      }
      at++;
    } else if (source[at] === '[') {
      at++;
      ws();
      let i = 0;
      while (source[at] !== ']') {
        value([...path, i++]);
        ws();
        if (source[at] !== ',') break;
        at++;
        ws();
      }
      at++;
    } else while (at < source.length && !/[\s,\]}]/.test(source[at])) at++;
  };
  value([]);
  for (const edit of edits.reverse())
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
/** A preserved package tree needs no new PNG when all relative native links retain their meaning. */
export function checkNativeLinks(source: string, document: string, origin?: string) {
  for (const link of nativeLinks(source)) {
    if (!link || link.startsWith('#')) continue;
    let appApi = false;
    if (origin)
      try {
        const url = new URL(link, origin);
        appApi = url.origin === new URL(origin).origin && /^\/api(?:\/|$)/i.test(url.pathname);
      } catch {}
    if (externalNavigation(link, origin ?? 'https://portable.invalid')) continue;
    const local = localReference(document, link);
    if (local && !appApi) continue;
    fail(409, 'PORTABLE_DEPENDENCY_UNAVAILABLE', '原生场景引用需要完整的包内目标', false, {
      diagnostics: [{ document, resource: link }],
    });
  }
}
