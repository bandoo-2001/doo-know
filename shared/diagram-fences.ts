import type { MarkdownIt } from 'markdown-it';
export function diagramFences(md: MarkdownIt) {
  const original = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const token = tokens[index],
      kind = token.info.trim();
    return ['mermaid', 'excalidraw'].includes(kind)
      ? `<div data-diagram="${kind}" data-code="${md.utils.escapeHtml(encodeURIComponent(token.content))}"></div>\n`
      : original(tokens, index, options, env, renderer);
  };
}
