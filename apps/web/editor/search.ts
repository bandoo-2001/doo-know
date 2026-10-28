import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export type TextMatch = { from: number; to: number };
export const documentSearchKey = new PluginKey<DecorationSet>('documentSearchHighlight');

// The find input keeps keyboard focus, so native editor selection alone cannot
// show the active result. Decorations keep it visible without touching Markdown.
export function documentSearchHighlightPlugin() {
  return new Plugin<DecorationSet>({
    key: documentSearchKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, previous) {
        const match: TextMatch | null | undefined = transaction.getMeta(documentSearchKey);
        if (match !== undefined) {
          if (!match || match.from < 0 || match.to <= match.from || match.to > transaction.doc.content.size)
            return DecorationSet.empty;
          return DecorationSet.create(transaction.doc, [
            Decoration.inline(match.from, match.to, { class: 'document-search-match' }),
          ]);
        }
        if (transaction.docChanged || transaction.selectionSet) return DecorationSet.empty;
        return previous;
      },
    },
    props: { decorations: (state) => documentSearchKey.getState(state) },
  });
}
export function findText(
  text: string,
  query: string,
  options: { caseSensitive: boolean },
): TextMatch[] {
  if (!query) return [];
  const expression = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    options.caseSensitive ? 'gu' : 'giu',
  );
  return Array.from(text.matchAll(expression), (match) => ({
    from: match.index!,
    to: match.index! + match[0].length,
  }));
}

/** Positions refer to the current PM document, never to serialized Markdown. */
export function documentMatches(
  doc: ProseMirrorNode,
  query: string,
  caseSensitive = false,
): TextMatch[] {
  const found: TextMatch[] = [];
  doc.descendants((node, pos) => {
    if (
      node.type.name === 'opaqueSource' ||
      (node.type.name === 'codeBlock' &&
        ['mermaid', 'excalidraw', 'svg'].includes(node.attrs.language))
    )
      return false;
    if (!node.isTextblock) return;
    const text = node.textBetween(0, node.content.size, '\n', '\uFFFC');
    for (const match of findText(text, query, { caseSensitive })) {
      if (!text.slice(match.from, match.to).includes('\uFFFC'))
        found.push({ from: pos + 1 + match.from, to: pos + 1 + match.to });
    }
    return false;
  });
  return found;
}

export function replaceDocumentMatches(
  doc: ProseMirrorNode,
  matches: readonly TextMatch[],
  replacement: string,
): ProseMirrorNode {
  const transform = new Transform(doc);
  for (const match of [...matches].sort((a, b) => b.from - a.from)) {
    if (match.from < 0 || match.to > doc.content.size || match.to < match.from)
      throw Error('查找结果已过期');
    if (replacement)
      transform.replaceWith(
        match.from,
        match.to,
        doc.type.schema.text(replacement, doc.resolve(match.from).marks()),
      );
    else transform.delete(match.from, match.to);
  }
  return transform.doc;
}
