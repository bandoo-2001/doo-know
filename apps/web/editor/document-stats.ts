import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export type DocumentStatistics = { characters: number; selectedCharacters: number };

/** Counts Unicode code points, including spaces and line breaks. */
export function countCharacters(text: string): number {
  return Array.from(text).length;
}

export function visibleDocumentText(doc: ProseMirrorNode, from = 0, to = doc.content.size): string {
  const blocks: string[] = [];
  doc.descendants((node, position) => {
    if (
      node.type.name === 'opaqueSource' ||
      (node.type.name === 'codeBlock' &&
        ['mermaid', 'excalidraw', 'svg'].includes(node.attrs.language))
    )
      return false;
    if (!node.isTextblock) return;
    const start = Math.max(0, from - position - 1),
      end = Math.min(node.content.size, to - position - 1);
    if (end > start) blocks.push(node.textBetween(start, end, '\n', ''));
    return false;
  });
  return blocks.join('\n');
}
