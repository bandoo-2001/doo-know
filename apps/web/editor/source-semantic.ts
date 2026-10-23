import MarkdownIt from 'markdown-it';
import { markdownStyles } from '../../../shared/markdown-styles';
import type { JSONContent } from '@tiptap/core';
const parser = new MarkdownIt({ html: false, linkify: true }).use(markdownStyles);
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
export function sourceVisibleText(markdown: string) {
  const tokens = parser.parse(markdown, {});
  const parts: string[] = [];
  const inline = (items: typeof tokens) => {
    for (const t of items) {
      if (t.type === 'text' || t.type === 'code_inline') parts.push(t.content);
      else if (t.type === 'image') {
        if (t.children) inline(t.children);
        else parts.push(t.content);
      } else if (t.type === 'softbreak' || t.type === 'hardbreak') parts.push('\n');
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'fence' || t.type === 'code_block') parts.push(t.content.replace(/\n$/, ''));
    else if (t.type === 'inline' && t.children) {
      const children = t.children.map((c) => ({ ...c }));
      if (tokens[i - 2]?.type === 'list_item_open' && children[0]?.type === 'text')
        children[0].content = children[0].content.replace(/^\[[ xX]\][ \t]+/, '');
      inline(children as typeof tokens);
    }
  }
  return normalize(parts.join(''));
}
export function richVisibleText(node: JSONContent): string {
  function text(n: JSONContent): string {
    if (n.type === 'text') return n.text || '';
    if (n.type === 'image') return n.attrs?.alt || '';
    if (n.type === 'hardBreak') return '\n';
    return (n.content || []).map(text).join('');
  }
  return normalize(text(node));
}
