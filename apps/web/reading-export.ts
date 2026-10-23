import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it';
import type { renderToString as renderMathType } from 'katex';
import { knowledgeMarkdown } from '../../shared/knowledge-markdown';
import { markdownTasks } from '../../shared/markdown-tasks';
import { markdownStyles } from '../../shared/markdown-styles';
import { frontmatterRange } from '../../shared/frontmatter-range';
import { collectDiagramSaveNeeds, stripDiagramPreviews } from '../../shared/diagram-portability';
import { validateSvgSource, SVG_MIME } from '../../shared/svg-policy';
import { downloadBlob } from './whiteboards/download';

export type ReadingExportInput = {
  title: string;
  markdown: string;
  /** The caller owns attachment authorization; this helper never fetches URLs. */
  resolveImage?: (url: string) => Promise<Blob | string | undefined>;
  unavailablePreviews?: number;
};

const imageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  SVG_MIME,
]);
const maxImageBytes = 10 * 1024 * 1024;
const readingStyles = `
:root { color-scheme: light; }
body { margin: 0; color: #202735; background: #fff; font: 16px/1.8 system-ui, sans-serif; }
main { max-width: 820px; padding: 44px 24px 80px; margin: 0 auto; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
a { color: #245bb3; }
h1,h2,h3,h4,h5,h6 { line-height: 1.4; break-after: avoid; }
pre { padding: 16px; overflow: auto; background: #f4f6f9; border-radius: 6px; white-space: pre-wrap; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .9em; }
blockquote,.markdown-alert { margin: 1.2em 0; padding: 4px 16px; border-left: 4px solid #a8b8ce; }
.markdown-alert-note,.markdown-alert-tip { border-color: #2e76b8; }
.markdown-alert-important { border-color: #8250c4; }
.markdown-alert-warning,.markdown-alert-caution { border-color: #ad6800; }
.markdown-alert-title { font-weight: 650; }
table { border-collapse: collapse; width: 100%; }
th,td { border: 1px solid #d6dbe3; padding: 7px 10px; }
th { background: #f4f6f9; }
.footnotes { font-size: .88em; }
.reading-properties { color: #596579; font-size: .85em; }
.knowledge-math { overflow-x: auto; }
.knowledge-math[data-display='block'] { text-align: center; margin: 1em 0; }
.knowledge-math-error { font-family: ui-monospace, monospace; }
@media print { main { max-width: none; padding: 0; } body { font-size: 11pt; } pre,blockquote,table,img { break-inside: avoid; } a { color: inherit; } }
`;

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

async function embeddedImage(input: Blob | string): Promise<string> {
  let bytes: Uint8Array, mime: string;
  if (typeof input === 'string') {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i.exec(input);
    if (!match || match[2].length > Math.ceil((maxImageBytes * 4) / 3) + 4)
      throw Error('图片需要使用有效的内嵌数据');
    mime = match[1].toLowerCase();
    try {
      bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
    } catch {
      throw Error('图片数据无法读取');
    }
  } else {
    if (input.size > maxImageBytes) throw Error('图片超过 10 MiB，无法包含在阅读文件中');
    mime = input.type.toLowerCase().split(';')[0];
    bytes = new Uint8Array(await input.arrayBuffer());
  }
  if (!imageTypes.has(mime) || !bytes.length || bytes.length > maxImageBytes)
    throw Error('图片类型或大小不适合阅读导出');
  if (mime === SVG_MIME) {
    const svg = validateSvgSource(bytes);
    if (!svg.ok) throw Error(`SVG 无法导出：${svg.message}`);
    bytes = new TextEncoder().encode(svg.presentation);
  }
  return `data:${mime};base64,${toBase64(bytes)}`;
}

function readableLink(url: string) {
  if (url.startsWith('#')) return true;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    return !/^\/api(?:\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Produce script-free, self-contained HTML. Diagram fences remain readable source. */
export async function buildReadingHtml(input: ReadingExportInput): Promise<string> {
  const stale = await collectDiagramSaveNeeds(input.markdown, input.markdown);
  const markdown = stripDiagramPreviews(input.markdown, stale);
  let renderMath: typeof renderMathType | undefined;
  const md: MarkdownItInstance = new MarkdownIt({ html: false, linkify: true })
    .use(markdownStyles)
    .use(markdownTasks)
    .use(knowledgeMarkdown, {
      renderMath(source: string, display: boolean): string {
        const tag = display ? 'div' : 'span';
        try {
          if (!renderMath || source.length > 10_000) throw Error('公式暂时无法预览');
          return `<${tag} class="knowledge-math" data-display="${display ? 'block' : 'inline'}">${renderMath(source, { output: 'mathml', displayMode: display, trust: false, throwOnError: true, maxExpand: 1000, maxSize: 20 })}</${tag}>`;
        } catch {
          return `<${tag} class="knowledge-math-error">${md.utils.escapeHtml(source)}</${tag}>`;
        }
      },
    });
  const front = frontmatterRange(markdown);
  const content = markdown.slice(front?.end ?? 0);
  const env = {};
  const tokens = md.parse(content, env);
  const all: typeof tokens = [];
  const collect = (list: typeof tokens) => {
    for (const token of list) {
      all.push(token);
      if (token.children) collect(token.children);
    }
  };
  collect(tokens);
  if (
    all.some(
      (token) =>
        token.type === 'math_inline' ||
        token.type === 'math_block' ||
        (token.type === 'fence' && token.info.trim() === 'math'),
    )
  )
    renderMath = (await import('katex')).renderToString;
  const images = new Map<string, string>();
  for (const token of all) {
    if (token.type !== 'image') continue;
    const url = String(token.attrGet('src') || '');
    if (!images.has(url)) {
      const resource = url.startsWith('data:') ? url : await input.resolveImage?.(url);
      if (!resource) throw Error('有图片未能包含在阅读文件中，请确认附件可访问后重试');
      images.set(url, await embeddedImage(resource));
    }
    token.attrSet('src', images.get(url)!);
  }
  const stripLinks = (list: typeof tokens) => {
    const stack: boolean[] = [];
    for (const token of list) {
      if (token.type === 'link_open') {
        const allowed = readableLink(String(token.attrGet('href') || ''));
        stack.push(allowed);
        if (allowed) {
          token.attrSet('rel', 'noopener noreferrer');
        } else {
          token.tag = 'span';
          token.attrs = null;
        }
      } else if (token.type === 'link_close' && !stack.pop()) token.tag = 'span';
      if (token.children) stripLinks(token.children);
    }
  };
  stripLinks(tokens);
  const properties = front
    ? `<pre class="reading-properties" aria-label="笔记属性">${md.utils.escapeHtml(front.yaml)}</pre>\n`
    : '';
  const notice =
    stale.length || input.unavailablePreviews
      ? '<p class="reading-properties">部分图形的预览已过期，本文件保留当前源码。请在编辑器中生成通用预览后重新导出。</p>'
      : '';
  const body = notice + md.renderer.render(tokens, md.options, env);
  const title = md.utils.escapeHtml(input.title || '笔记');
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${title}</title><style>${readingStyles}</style></head><body><main>${properties}${body}</main></body></html>`;
}

export function downloadReadingHtml(html: string, title: string) {
  const name = (title || '笔记').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').slice(0, 150);
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${name}.html`);
}

/** Pass a synchronously opened window when preparation involved async work. */
export async function printReadingHtml(
  html: string,
  target: Window | null = window.open('', '_blank'),
) {
  if (!target) throw Error('打印窗口未能打开，请允许弹出窗口后重试');
  target.opener = null;
  target.document.open();
  target.document.write(html);
  target.document.close();
  await Promise.all([...target.document.images].map((image) => image.decode().catch(() => {})));
  if (target.closed) return;
  target.focus();
  target.addEventListener('afterprint', () => target.close(), { once: true });
  target.print();
}
