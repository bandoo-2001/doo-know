import MarkdownIt from 'markdown-it';
import { posix } from 'node:path';
import { markdownDestinationSpans } from '../../../shared/markdown-destinations.js';
import { localReference } from '../render.js';
import { fail } from '../knowledge/errors.js';
import { knowledgeMarkdown } from '../../../shared/knowledge-markdown.js';

const parser = new MarkdownIt({ html: true }).use(knowledgeMarkdown);
// Discovery is not rendering. Recognize unsupported schemes so they produce an
// explicit diagnostic instead of being mistaken for resource-free literal text.
parser.validateLink = () => true;
export function destinations(markdown: string) {
  const urls: { url: string; image: boolean }[] = [];
  function visit(tokens: ReturnType<typeof parser.parse>) {
    for (const token of tokens) {
      if (
        (token.type === 'html_block' || token.type === 'html_inline') &&
        /<(?:img|video|audio|source|iframe|object|embed)\b|\b(?:src|srcset|poster)\s*=/i.test(
          token.content,
        )
      )
        fail(422, 'PORTABLE_RESOURCE_UNSUPPORTED', 'HTML 媒体尚未支持完整便携交付');
      if (token.type === 'image' || token.type === 'link_open')
        urls.push({
          url: String(token.attrGet(token.type === 'image' ? 'src' : 'href') || ''),
          image: token.type === 'image',
        });
      if (token.children) visit(token.children);
    }
  }
  visit(parser.parse(markdown, {}));
  return urls;
}
export function rewriteDestinations(
  markdown: string,
  sourcePath: string,
  targetPath: string,
  mapping: Map<string, string>,
) {
  const replacements = markdownDestinationSpans(markdown)
    .flatMap((span) => {
      const local = localReference(sourcePath, span.url),
        mapped = local && mapping.get(local);
      if (!mapped) return [];
      const suffix = span.url.match(/[?#].*$/)?.[0] || '';
      const url =
        posix
          .relative(posix.dirname(targetPath), mapped)
          .split('/')
          .map(encodeURIComponent)
          .join('/') + suffix;
      if (span.wiki) {
        const label = span.wiki.label.replace(/[\\\[\]*_`]/g, '\\$&');
        return [{ ...span, replacement: `[${label}](<${url}>)` }];
      }
      return url === span.url ? [] : [{ ...span, replacement: url }];
    })
    .sort((a, b) => b.start - a.start);
  for (const span of replacements)
    markdown = markdown.slice(0, span.start) + span.replacement + markdown.slice(span.end);
  return markdown;
}
/** Native source bytes are authoritative. Never silently rebind an old PNG after relocation. */
export function checkNativeLinks(source: string, document: string) {
  const scene = JSON.parse(source);
  for (const element of scene.elements || [])
    if (typeof element.link === 'string' && element.link && !/^https?:\/\//i.test(element.link))
      fail(409, 'DIAGRAM_PREVIEW_REQUIRED', '原生场景链接重定位需要新的匹配预览', false, {
        documents: [{ document, role: 'primary' }],
        reason: 'native-link-relocation',
      });
}
