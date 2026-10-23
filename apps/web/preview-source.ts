import type { MarkdownIt } from 'markdown-it';

// Retain source positions inside long paragraphs and code blocks, rather than
// locating every hit at the enclosing block's first line.
export function previewSource(md: MarkdownIt) {
  const text = md.renderer.rules.text!;
  md.renderer.rules.text = (tokens, index, options, env, renderer) => {
    const html = text(tokens, index, options, env, renderer);
    const line = tokens[index].attrGet('data-source-line');
    return line ? `<span data-source-line="${line}">${html}</span>` : html;
  };
  for (const name of ['fence', 'code_block']) {
    const render = md.renderer.rules[name]!;
    md.renderer.rules[name] = (tokens, index, options, env, renderer) => {
      const token = tokens[index];
      const html = render(tokens, index, options, env, renderer);
      if (!token.map) return html;
      const firstLine = token.map[0] + (name === 'fence' ? 2 : 1);
      const content = token.content
        .split('\n')
        .map((line, offset, lines) =>
          offset === lines.length - 1 && !line
            ? ''
            : `<span data-source-line="${firstLine + offset}">${md.utils.escapeHtml(line)}</span>`,
        )
        .join('\n');
      return html.replace(
        /(<code\b[^>]*>)[\s\S]*?(<\/code>)/,
        (_all, open, close) => open + content + close,
      );
    };
  }
  md.core.ruler.push('preview_source_lines', (state) => {
    for (const token of state.tokens) {
      if (!token.map || !token.block || token.nesting === -1) continue;
      token.attrSet('data-source-line', String(token.map[0] + 1));
      if (token.type !== 'inline' || !token.children) continue;
      let line = token.map[0] + 1;
      let sourceOffset = 0;
      let sourceLine = line;
      for (const child of token.children) {
        if (child.type === 'softbreak' || child.type === 'hardbreak') line++;
        else {
          if (child.type === 'text' || child.type === 'code_inline') {
            // Inline code and link destinations can consume raw newlines that
            // disappear from child.content. Re-anchor literal text to the source.
            const at = token.content.indexOf(child.content, sourceOffset);
            if (at >= 0) {
              sourceLine += (token.content.slice(sourceOffset, at).match(/\n/g) || []).length;
              line = sourceLine;
              sourceOffset = at + child.content.length;
              sourceLine += (child.content.match(/\n/g) || []).length;
            }
            child.attrSet('data-source-line', String(line));
          }
          line += (child.content.match(/\n/g) || []).length;
        }
      }
    }
  });
}
