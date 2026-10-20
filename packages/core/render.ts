import {markdownTasks} from '../../shared/markdown-tasks.js';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { dirname, posix } from 'node:path';
import { markdownStyles } from '../../shared/markdown-styles.js';
export const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false }).use(
  markdownStyles,
).use(markdownTasks);
export function localReference(notePath: string, url: string): string | undefined {
  try {
    const decoded = decodeURIComponent(url.split('#')[0].split('?')[0]);
    if (
      !decoded ||
      decoded.startsWith('/') ||
      decoded.includes('\\') ||
      /^[a-z][a-z0-9+.-]*:/i.test(decoded)
    )
      return;
    const path = posix.normalize(posix.join(dirname(notePath), decoded));
    if (path.startsWith('../') || path.split('/').some((p) => p.startsWith('.'))) return;
    return path;
  } catch {
    return;
  }
}
export function references(content: string): string[] {
  const urls: string[] = [];
  const visit = (tokens: ReturnType<typeof markdown.parse>) => {
    for (const token of tokens) {
      if (token.type === 'image') {
        const u = String(token.attrGet('src') || '');
        if (u) urls.push(u);
      }
      if (token.type === 'link_open') {
        const u = String(token.attrGet('href') || '');
        if (u) urls.push(u);
      }
      if (token.children) visit(token.children);
    }
  };
  visit(markdown.parse(content, {}));
  return urls;
}
export function renderMarkdown(
  content: string,
  mapUrl: (url: string) => string | undefined = () => undefined,
) {
  const tokens = markdown.parse(content, {});
  const headings: { id: string; text: string }[] = [];
  let headingIndex = 0;
  const visit = (list: typeof tokens) => {
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t.type === 'heading_open') {
        const id = `heading-${headingIndex++}`;
        t.attrSet('id', id);
        const inline = list[i + 1];
        const text = inline?.children?.some((child) => child.type === 'span_open')
          ? inline.children
              .map((child) =>
                ['text', 'code_inline', 'image'].includes(child.type)
                  ? child.content
                  : ['softbreak', 'hardbreak'].includes(child.type)
                    ? ' '
                    : '',
              )
              .join('')
          : inline?.content || '';
        headings.push({ id, text });
      }
      if (t.type === 'image' || t.type === 'link_open') {
        const attr = t.type === 'image' ? 'src' : 'href',
          url = String(t.attrGet(attr) || '');
        const mapped = mapUrl(url);
        if (mapped) t.attrSet(attr, mapped);
        else if (url.startsWith('#') && t.type === 'link_open') {
        } else if (/^https?:\/\//i.test(url) && t.type === 'link_open') {
          t.attrSet('rel', 'noopener noreferrer');
          t.attrSet('target', '_blank');
        } else t.attrSet(attr, '');
      }
      if (t.children) visit(t.children);
    }
  };
  visit(tokens);
  const html = sanitizeHtml(markdown.renderer.render(tokens, markdown.options, {}), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'],
    allowedAttributes: {
      a: ['href', 'rel', 'target'],
      img: ['src', 'alt', 'title'],
      td: ['style'],
      th: ['style'],
      div: ['style'],
      span: ['style'],
      h1: ['id'],
      h2: ['id'],
      h3: ['id'],
      h4: ['id'],
      h5: ['id'],
      h6: ['id'],
    },
    allowedStyles: {
      td: { 'text-align': [/^(?:left|center|right)$/] },
      th: { 'text-align': [/^(?:left|center|right)$/] },
      div: { 'text-align': [/^(?:left|center|right)$/] },
      span: { color: [/^#[0-9a-fA-F]{6}$/] },
    },
    allowedSchemes: ['https', 'http'],
    allowProtocolRelative: false,
  });
  return { html, headings };
}
