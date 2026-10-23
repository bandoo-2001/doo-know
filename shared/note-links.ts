import MarkdownIt from 'markdown-it';
import { knowledgeMarkdown } from './knowledge-markdown.js';
import { markdownStyles } from './markdown-styles.js';
import { markdownTasks } from './markdown-tasks.js';
import { frontmatterRange } from './frontmatter-range.js';

export type NoteBacklink = { id: string; title: string; relativePath: string };
export type NoteBacklinksPage = {
  matches: NoteBacklink[];
  /** Counts for this page, not the entire library. */
  checked: number;
  skipped: number;
  nextCursor?: string;
  incomplete: boolean;
};

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false })
  .use(markdownStyles)
  .use(markdownTasks)
  .use(knowledgeMarkdown);

/** Resolve a rendered link with the same relative-file convention as ordinary Markdown. */
export function resolveNoteLink(sourcePath: string, url: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.split('#')[0].split('?')[0]);
  } catch {
    return;
  }
  if (
    !decoded ||
    decoded.startsWith('/') ||
    decoded.endsWith('/') ||
    /[\\\u0000-\u001f\u007f]/.test(decoded) ||
    /^[a-z][a-z\d+.-]*:/i.test(decoded)
  )
    return;
  const parts = sourcePath.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return;
      parts.pop();
    } else {
      if (part.startsWith('.')) return;
      parts.push(part);
    }
  }
  const path = parts.join('/');
  return /\.md$/i.test(path) ? path : undefined;
}

/** Only actual rendered links count: code, math, images and unused footnotes stay opaque. */
export function extractNoteLinks(content: string, sourcePath: string): string[] {
  const targets = new Set<string>();
  const tokens = markdown.parse(content.slice(frontmatterRange(content)?.end ?? 0), {});
  const visit = (items: typeof tokens) => {
    for (const token of items) {
      // Markdown image children form an alt label, never active anchors.
      if (token.type === 'image') continue;
      if (token.type === 'link_open') {
        const target = resolveNoteLink(sourcePath, String(token.attrGet('href') || ''));
        if (target && target !== sourcePath) targets.add(target);
      }
      if (token.children) visit(token.children);
    }
  };
  visit(tokens);
  return [...targets];
}
