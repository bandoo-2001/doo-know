import type { MarkdownIt } from 'markdown-it';
import { parseDiagramBinding, type DiagramBinding } from './diagram-binding.js';
export const diagramKinds = ['svg', 'mermaid', 'excalidraw'] as const;
export function isDiagramKind(kind: unknown): kind is (typeof diagramKinds)[number] {
  return typeof kind === 'string' && (diagramKinds as readonly string[]).includes(kind);
}
export function diagramFences(md: MarkdownIt) {
  md.core.ruler.push('diagram_preview_binding', (state) => {
    for (let index = 0; index < state.tokens.length; index++) {
      const token = state.tokens[index];
      if (token.type !== 'fence' || !isDiagramKind(token.info.trim())) continue;
      const previous = state.tokens[index - 1];
      const binding =
        previous && ['diagram_binding', 'html_block'].includes(previous.type)
          ? parseDiagramBinding(previous.content)
          : undefined;
      if (binding) token.meta = { ...token.meta, previewBinding: binding };
    }
  });
  const original = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const token = tokens[index],
      kind = token.info.trim();
    const binding = token.meta?.previewBinding as DiagramBinding | undefined;
    return isDiagramKind(kind)
      ? `<div data-diagram="${kind}" data-code="${md.utils.escapeHtml(encodeURIComponent(token.content))}"${token.map ? ` data-source-line="${token.map[0] + 1}"` : ''}${binding ? ` data-preview-code-hash="${binding.codeHash}" data-preview-source-hash="${binding.sourceHash}"` : ''}></div>\n`
      : original(tokens, index, options, env, renderer);
  };
}
