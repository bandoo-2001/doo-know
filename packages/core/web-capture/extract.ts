import { DomHandler, DomUtils, Parser } from 'htmlparser2';
import { isDiagramKind } from '../../../shared/diagram-fences.js';
import { fail } from '../knowledge/errors.js';

type HtmlNode = DomHandler['dom'][number];
type HtmlElement = Extract<HtmlNode, { attribs: object }>;
const maxMarkdownBytes = 256 * 1024;

function isTag(node: HtmlNode): node is HtmlElement {
  return 'attribs' in node;
}

class BoundedDocument extends DomHandler {
  private nodes = 0;

  protected override addNode(node: HtmlNode) {
    if (++this.nodes > 25_000 || this.tagStack.length > 96)
      fail(413, 'WEB_CAPTURE_TOO_LARGE', '网页结构超出预览范围');
    super.addNode(node);
  }
}

const omittedTags = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'nav',
  'aside',
  'footer',
  'form',
  'input',
  'button',
  'select',
  'textarea',
]);
const omittedRoles = new Set(['banner', 'navigation', 'complementary', 'contentinfo', 'search']);
const blockTags = new Set([
  'address',
  'article',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul',
]);

function omitted(node: HtmlElement) {
  return (
    omittedTags.has(node.name) ||
    omittedRoles.has(node.attribs.role?.toLowerCase()) ||
    Object.hasOwn(node.attribs, 'hidden') ||
    node.attribs['aria-hidden']?.toLowerCase() === 'true' ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(
      node.attribs.style ?? '',
    )
  );
}

function cleanText(value: string) {
  return value
    .replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function plainText(node: HtmlNode): string {
  if (node.type === 'text') return node.data;
  if (!isTag(node) || omitted(node)) return '';
  if (node.name === 'br') return '\n';
  if (node.name === 'img') return node.attribs.alt ?? '';
  return node.children.map(plainText).join('');
}

function asMarkdownText(value: string) {
  return value
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/[\\`*_\[\]<>~$!]/g, '\\$&')
    .replace(/&(?=#?[\da-z]+;)/gi, '\\&');
}

function escapeBlockStart(value: string) {
  return value
    .replace(/^([ \t]*)#(?=#{0,5}(?:[ \t]|$))/gm, '$1\\#')
    .replace(/^([ \t]*)([+-])(?=[ \t]|$)/gm, '$1\\$2')
    .replace(/^([ \t]*)([-=])(?=\2*[ \t]*$)/gm, '$1\\$2')
    .replace(/^([ \t]*\d{1,9})([.)])(?=[ \t]|$)/gm, '$1\\$2');
}

function tickFence(value: string, min: number) {
  const longest = (value.match(/`+/g) ?? []).reduce((count, run) => Math.max(count, run.length), 0);
  return '`'.repeat(Math.max(min, longest + 1));
}

function wrapInline(value: string, marker: string) {
  const text = value.trim();
  if (!text) return value;
  return `${/^\s*/.exec(value)?.[0] ?? ''}${marker}${text}${marker}${/\s*$/.exec(value)?.[0] ?? ''}`;
}

function linkDestination(value: string | undefined, baseUrl: URL) {
  if (!value?.trim() || /[\p{Cc}\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value, baseUrl);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
      return `<${url.href.replace(/</g, '%3C').replace(/>/g, '%3E')}>`;
  } catch {
    // An invalid destination can still have useful link text.
  }
}

function renderInline(node: HtmlNode, baseUrl: URL): string {
  if (node.type === 'text') return asMarkdownText(node.data);
  if (!isTag(node) || omitted(node)) return '';
  switch (node.name) {
    case 'br':
      return '  \n';
    case 'img':
      return asMarkdownText(node.attribs.alt ?? '');
    case 'code': {
      const code = plainText(node).replace(/[\p{Cc}]/gu, ' ');
      if (!code.trim()) return code;
      const fence = tickFence(code, 1);
      const padded = /^[` ]|[` ]$/.test(code) ? ` ${code} ` : code;
      return `${fence}${padded}${fence}`;
    }
  }
  const value = node.children.map((child) => renderInline(child, baseUrl)).join('');
  switch (node.name) {
    case 'b':
    case 'strong':
      return wrapInline(value, '**');
    case 'i':
    case 'em':
      return wrapInline(value, '*');
    case 's':
    case 'del':
      return wrapInline(value, '~~');
    case 'a': {
      const destination = linkDestination(node.attribs.href, baseUrl);
      if (!destination || !value.trim()) return value;
      return `${/^\s*/.exec(value)?.[0] ?? ''}[${value.trim().replace(/\s*\n\s*/g, ' ')}](${destination})${/\s*$/.exec(value)?.[0] ?? ''}`;
    }
    default:
      return value;
  }
}

function renderList(node: HtmlElement, baseUrl: URL) {
  const start = Number(node.attribs.start ?? 1);
  let ordinal = Number.isInteger(start) && start >= 0 && start <= 99_999_999 ? start : 1;
  return node.children
    .filter((child): child is HtmlElement => isTag(child) && child.name === 'li' && !omitted(child))
    .map((child) => {
      const item = renderFlow(child.children, baseUrl);
      if (!item) return '';
      const prefix = node.name === 'ol' ? `${ordinal++}. ` : '- ';
      return prefix + item.replace(/\n(?=\S| +\S)/g, `\n${' '.repeat(prefix.length)}`);
    })
    .filter(Boolean)
    .join('\n');
}

function renderTable(node: HtmlElement, baseUrl: URL) {
  const rows = node.children
    .filter((child): child is HtmlElement => isTag(child) && !omitted(child))
    .flatMap((child) =>
      ['thead', 'tbody', 'tfoot'].includes(child.name) ? child.children : [child],
    );
  const cells = rows
    .filter((row): row is HtmlElement => isTag(row) && row.name === 'tr' && !omitted(row))
    .map((row) =>
      row.children
        .filter((cell) => isTag(cell) && ['th', 'td'].includes(cell.name) && !omitted(cell))
        .map((cell) =>
          renderInline(cell, baseUrl)
            .trim()
            .replace(/\s*\n\s*/g, ' ')
            .replace(/\|/g, '\\|'),
        ),
    );
  const width = cells.reduce((count, row) => Math.max(count, row.length), 0);
  if (!width) return '';
  // Avoid growing pathological ragged tables into a large rectangular result.
  if (width > 30 || cells.length * width > 10_000)
    return cells.map((row) => row.join(' · ')).join('\n\n');
  const rowText = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`;
  return [
    rowText(cells[0]),
    rowText(Array<string>(width).fill('---')),
    ...cells.slice(1).map(rowText),
  ].join('\n');
}

function renderBlock(node: HtmlElement, baseUrl: URL): string {
  if (/^h[1-6]$/.test(node.name)) {
    const text = node.children
      .map((child) => renderInline(child, baseUrl))
      .join('')
      .trim();
    return text
      ? `${'#'.repeat(Number(node.name[1]))} ${text.replace(/\s*\n\s*/g, ' ').replace(/#+$/, '\\$&')}`
      : '';
  }
  switch (node.name) {
    case 'pre': {
      const value = plainText(node)
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
      if (!value.trim()) return '';
      const code = node.children.find(
        (child): child is HtmlElement => isTag(child) && child.name === 'code',
      );
      const language =
        /(?:^|\s)(?:lang(?:uage)?-)([a-z\d_+-]{1,32})(?=$|\s)/i
          .exec(code?.attribs.class ?? node.attribs.class ?? '')?.[1]
          ?.toLowerCase() ?? '';
      const info = isDiagramKind(language) || language === 'math' ? '' : language;
      const fence = tickFence(value, 3);
      return `${fence}${info}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}`;
    }
    case 'ol':
    case 'ul':
      return renderList(node, baseUrl);
    case 'table':
      return renderTable(node, baseUrl);
    case 'hr':
      return '---';
    case 'blockquote': {
      const value = renderFlow(node.children, baseUrl);
      return value
        ? value
            .split('\n')
            .map((line) => (line ? `> ${line}` : '>'))
            .join('\n')
        : '';
    }
    default:
      return renderFlow(node.children, baseUrl);
  }
}

function renderFlow(nodes: HtmlNode[], baseUrl: URL): string {
  const blocks: string[] = [];
  let inline = '';
  function flush() {
    const text = inline.trim();
    if (text) blocks.push(escapeBlockStart(text));
    inline = '';
  }
  for (const node of nodes) {
    if (isTag(node) && omitted(node)) continue;
    if (isTag(node) && blockTags.has(node.name)) {
      flush();
      const block = renderBlock(node, baseUrl);
      if (block) blocks.push(block);
    } else {
      inline += renderInline(node, baseUrl);
    }
  }
  flush();
  return blocks.join('\n\n');
}

function selectContent(nodes: HtmlNode[]) {
  let selected = nodes;
  let bestScore = 0;
  const visit = (items: HtmlNode[]): number => {
    let length = 0;
    for (const node of items) {
      if (node.type === 'text') {
        length += node.data.trim().length;
      } else if (isTag(node) && !omitted(node)) {
        const textLength = visit(node.children);
        if (node.name === 'article' || node.name === 'main' || node.attribs.role === 'main') {
          const score = textLength * (node.name === 'article' ? 1.25 : 1);
          if (score > bestScore) {
            selected = node.children;
            bestScore = score;
          }
        }
        length += textLength;
      }
    }
    return length;
  };
  visit(nodes);
  return selected;
}

function firstVisibleHeading(nodes: HtmlNode[]): HtmlElement | undefined {
  for (const node of nodes) {
    if (!isTag(node) || omitted(node)) continue;
    if (node.name === 'h1') return node;
    const match = firstVisibleHeading(node.children);
    if (match) return match;
  }
}

export function extractWebPage(html: string, finalUrl: URL): { title: string; markdown: string } {
  const handler = new BoundedDocument();
  new Parser(handler).end(html);
  const page =
    DomUtils.findOne((node) => node.name === 'body', handler.dom)?.children ?? handler.dom;
  const content = selectContent(page);
  const heading = firstVisibleHeading(content);
  const openGraphTitle = DomUtils.findOne(
    (node) => node.name === 'meta' && node.attribs.property?.toLowerCase() === 'og:title',
    handler.dom,
  )?.attribs.content;
  const documentTitle = DomUtils.findOne((node) => node.name === 'title', handler.dom);
  const headingTitle = heading ? cleanText(plainText(heading)) : '';
  const title = (
    headingTitle ||
    cleanText(openGraphTitle ?? '') ||
    (documentTitle && cleanText(plainText(documentTitle))) ||
    finalUrl.hostname
  )
    .slice(0, 240)
    .replace(/[\ud800-\udbff]$/, '')
    .trimEnd();

  let markdown = renderFlow(content, finalUrl);
  if (heading && headingTitle === title) {
    const leadingHeading = renderBlock(heading, finalUrl);
    if (markdown === leadingHeading) markdown = '';
    else if (markdown.startsWith(`${leadingHeading}\n\n`))
      markdown = markdown.slice(leadingHeading.length + 2);
  }
  if (!markdown || markdown === '---')
    fail(422, 'WEB_CAPTURE_EMPTY', '网页未找到可收集的正文，部分网站需要登录或在浏览器中加载');
  if (Buffer.byteLength(markdown, 'utf8') > maxMarkdownBytes)
    fail(413, 'WEB_CAPTURE_TOO_LARGE', '网页正文超过 256 KiB，无法生成预览');
  return { title, markdown };
}
