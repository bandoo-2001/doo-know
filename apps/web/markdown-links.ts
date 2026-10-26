import type { Token } from 'markdown-it';
import { outlineFromTokens } from './document-outline';

export type MarkdownDestination =
  | { kind: 'fragment'; fragment: string }
  | { kind: 'external'; url: string }
  | { kind: 'local'; path: string; fragment: string };

/** Classify before resolving a path: an external URL can share a local pathname. */
export function markdownDestination(
  url: string,
  sourcePath: string,
): MarkdownDestination | undefined {
  const normalized = url.trim();
  if (normalized.startsWith('#')) return { kind: 'fragment', fragment: normalized };
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(normalized)) return { kind: 'external', url };
  if (/[\\\u0000-\u001f\u007f]/.test(url)) return;
  try {
    const target = new URL(url, `https://notes.invalid/${sourcePath}`);
    if (target.origin !== 'https://notes.invalid') return { kind: 'external', url };
    const path = decodeURIComponent(target.pathname.slice(1));
    if (/[\\\u0000-\u001f\u007f]/.test(path)) return;
    return { kind: 'local', path, fragment: target.hash };
  } catch {
    return;
  }
}

/** Assign stable heading IDs and return source lines for editor navigation too. */
export function markdownAnchorLines(tokens: Token[]): Map<string, number> {
  const anchors = new Map<string, number>();
  const footnotes = new Map<string, number>();
  const used = new Set<string>();
  // Footnote IDs belong to the plugin. Reserve both definitions and every
  // reference before allocating headings, regardless of document order.
  const reserveFootnotes = (items: Token[], sourceLine?: number) => {
    for (let index = 0; index < items.length; index++) {
      const token = items[index];
      if (token.map) sourceLine = token.map[0] + 1;
      if (token.type === 'footnote_open' || token.type === 'footnote_ref') {
        const number = Number(token.meta?.id) + 1;
        const subId = Number(token.meta?.subId);
        const suffix = subId > 0 ? `:${subId}` : '';
        const id = `${token.type === 'footnote_open' ? 'fn' : 'fnref'}${number}${suffix}`;
        used.add(id);
        const line = token.type === 'footnote_open' ? items[index + 1]?.map?.[0] : undefined;
        if (line !== undefined) footnotes.set(id, line + 1);
        else if (sourceLine !== undefined) footnotes.set(id, sourceLine);
      }
      if (token.children) reserveFootnotes(token.children, sourceLine);
      if (token.type === 'softbreak' || token.type === 'hardbreak')
        sourceLine = (sourceLine ?? 1) + 1;
    }
  };
  reserveFootnotes(tokens);
  const headingIds: string[] = [];
  const headings = outlineFromTokens(tokens);
  for (const heading of headings) {
    const base = heading.title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-');
    let id = base;
    for (let suffix = 1; used.has(id); suffix++) id = `${base}-${suffix}`;
    used.add(id);
    anchors.set(id, heading.line);
    headingIds.push(id);
  }
  let headingIndex = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === 'heading_open') token.attrSet('id', headingIds[headingIndex++]);
  }
  for (const [id, line] of footnotes) anchors.set(id, line);
  return anchors;
}
