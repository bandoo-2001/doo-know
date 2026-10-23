import DOMPurify from 'dompurify';
import { generateJSON } from '@tiptap/core';
import { richExtensions, renderRichContent } from './rich-adapter';
export function plainTextMarkdown(text: string) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]<>#+|!~])/g, '\\$1')
    .replace(/^(\s*)(\d+)\./gm, '$1$2\\.')
    .replace(/^([ \t]*)([-+])/gm, '$1\\$2')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\n\n');
}
export function convertClipboard(input: {
  text: string;
  html?: string;
  mode?: 'plain' | 'markdown';
  resolveImage?: (url: string) => string | undefined;
}):
  | { kind: 'supported'; markdown: string }
  | { kind: 'plain-text-choice'; text: string; reason: string } {
  if (input.mode === 'markdown') return { kind: 'supported', markdown: input.text };
  if (input.mode === 'plain' || !input.html) return { kind: 'supported', markdown: plainTextMarkdown(input.text) };
  const choice = (reason: string) => ({
    kind: 'plain-text-choice' as const,
    text: input.text,
    reason,
  });
  if (
    /<(?:script|iframe|object|embed|svg|math)\b|\bon\w+\s*=|(?:href|src)\s*=\s*["']?\s*(?:javascript|data|vbscript):|\bdata-(?:source|opaque)/i.test(
      input.html,
    )
  )
    return choice('此内容包含不能直接粘贴的格式，可选择按普通文本粘贴');
  if (typeof DOMParser === 'undefined') return choice('请按普通文本粘贴');
  const parsed = new DOMParser().parseFromString(input.html, 'text/html');
  for (const image of parsed.body.querySelectorAll('img'))
    if (!input.resolveImage?.(image.getAttribute('src') || '') || image.hasAttribute('srcset'))
      return choice('图片需要先上传到此笔记，可先粘贴文字，再使用上传附件插入图片');
  const allowedTags = [
    'p', 'div', 'span', 'strong', 'b', 'em', 'i', 's', 'del', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'br', 'hr', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  ];
  // Judge the original structure before sanitization removes evidence of loss
  // (checkbox status, definitions, superscripts, reversed numbering, etc.).
  for (const element of parsed.body.querySelectorAll('*')) {
    if (!allowedTags.includes(element.tagName.toLowerCase()) ||
        element.hasAttribute('reversed') || element.hasAttribute('value') ||
        element.hasAttribute('dir'))
      return choice('此内容包含暂不支持的格式，可选择按普通文本粘贴');
  }
  for (const cell of parsed.querySelectorAll('td,th'))
    if (
      Number(cell.getAttribute('colspan') || 1) !== 1 ||
      Number(cell.getAttribute('rowspan') || 1) !== 1 ||
      cell.querySelector('table,ul,ol,div') ||
      cell.querySelectorAll('p').length > 1
    )
      return choice('Markdown 表格不支持合并或复杂单元格，可按普通文本粘贴');
  if (parsed.querySelector('video,audio,canvas,form'))
    return choice('此内容包含暂不支持的嵌入，可按普通文本粘贴');
  for (const el of parsed.querySelectorAll<HTMLElement>('[style]')) {
    const color = el.style.color,
      align = el.style.textAlign;
    if (Array.from(el.style).some((name) => !['color', 'text-align'].includes(name)) ||
        (align && !/^(left|center|right)$/.test(align)) ||
        (color && !/^#[0-9a-f]{6}$/i.test(color) && !/^rgb\(\d+,\s*\d+,\s*\d+\)$/.test(color)))
      return choice('此内容包含暂不支持的样式，可选择按普通文本粘贴');
    el.removeAttribute('style');
    if (/^#[0-9a-f]{6}$/i.test(color)) el.style.color = color;
    else {
      const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
      if (rgb)
        el.style.color =
          '#' +
          rgb
            .slice(1)
            .map((x) => Number(x).toString(16).padStart(2, '0'))
            .join('');
    }
    if (/^(left|center|right)$/.test(align)) el.style.textAlign = align;
  }
  const html = DOMPurify.sanitize(parsed.body.innerHTML, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'style', 'start'],
    ALLOW_DATA_ATTR: false,
  });
  try {
    const json = generateJSON(html, richExtensions());
    const result = renderRichContent(json);
    return result.ok ? { kind: 'supported', markdown: result.markdown } : choice(result.message);
  } catch {
    return choice('此格式无法安全转换，可选择按普通文本粘贴');
  }
}
