import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it';
import footnotes from 'markdown-it-footnote';
import alerts from 'markdown-it-github-alerts';
import { tex } from '@mdit/plugin-tex';
import { frontmatterRange } from './frontmatter-range.js';
import { parseDiagramBinding } from './diagram-binding.js';

export function hasKnowledgeSyntax(raw: string) {
  return /\[\^[^\]\n]+\]|\[\[[^\]\n]+\]\]|(^|\n)\s*>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]|(?<!\\)\$[^\s$][^\n$]*\$|(^|\n)\s*\$\$/i.test(
    raw,
  );
}

export type KnowledgeMarkdownOptions = {
  renderMath?: (source: string, display: boolean) => string;
};

/** Syntax only; the expensive math engine is loaded when a math surface mounts. */
export function knowledgeMarkdown(md: MarkdownItInstance, options: KnowledgeMarkdownOptions = {}) {
  if (!md.options.html) {
    md.block.ruler.before('paragraph', 'diagram_binding', (state, startLine, _endLine, silent) => {
      const line = state.src.slice(
        state.bMarks[startLine] + state.tShift[startLine],
        state.eMarks[startLine],
      );
      if (!parseDiagramBinding(line)) return false;
      if (!silent) {
        const token = state.push('diagram_binding', '', 0);
        token.content = line;
        token.map = [startLine, startLine + 1];
        state.line = startLine + 1;
      }
      return true;
    });
    md.renderer.rules.diagram_binding = () => '';
  }
  md.use(footnotes)
    .use(alerts, {
      icons: { note: '', tip: '', important: '', warning: '', caution: '' },
      titles: { note: '提示', tip: '建议', important: '重要', warning: '警告', caution: '注意' },
    })
    .use(tex, {
      delimiters: 'dollars',
      mathFence: true,
      render: (source: string, display: boolean) => {
        if (options.renderMath) return options.renderMath(source, display);
        const tag = display ? 'div' : 'span';
        return `<${tag} class="knowledge-math" data-math-display="${display ? 'block' : 'inline'}" data-math-source="${md.utils.escapeHtml(encodeURIComponent(source))}">${md.utils.escapeHtml(source)}</${tag}>`;
      },
    });
  md.inline.ruler.before('link', 'knowledge_wikilink', (state, silent) => {
    if (!state.src.startsWith('[[', state.pos)) return false;
    const end = state.src.indexOf(']]', state.pos + 2);
    if (end < 0) return false;
    const raw = state.src.slice(state.pos + 2, end);
    if (/[\n\r]/.test(raw)) return false;
    const [destination, ...label] = raw.split('|');
    if (
      !destination ||
      /^[a-z][a-z\d+.-]*:|^[\/\\]/i.test(destination) ||
      /[\\\u0000-\u001f]/.test(destination)
    )
      return false;
    const [path, ...fragment] = destination.split('#');
    const target =
      (path && !/\.[a-z\d]+$/i.test(path) ? path + '.md' : path)
        .split('/')
        .map(encodeURIComponent)
        .join('/') + (fragment.length ? '#' + encodeURIComponent(fragment.join('#')) : '');
    if (!silent) {
      state.push('link_open', 'a', 1).attrSet('href', target);
      state.push('text', '', 0).content = label.join('|') || destination;
      state.push('link_close', 'a', -1);
    }
    state.pos = end + 2;
    return true;
  });
}

/** One context scan per projection, so a reference can show its remote definition. */
export function createKnowledgePreviewer(markdown: string) {
  if (!hasKnowledgeSyntax(markdown)) return (_raw: string, _id: string) => '';
  const md = new MarkdownIt({ html: false, linkify: true }).use(knowledgeMarkdown);
  const source = markdown.slice(frontmatterRange(markdown)?.end ?? 0).replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const tokens: ReturnType<typeof md.parse> = [];
  md.block.parse(source, md, {}, tokens);
  const definitions: string[] = [];
  let from = Infinity,
    to = 0,
    inDefinition = false;
  for (const token of tokens) {
    if (token.type === 'footnote_reference_open') {
      inDefinition = true;
      from = Infinity;
      to = 0;
    } else if (token.type === 'footnote_reference_close') {
      if (Number.isFinite(from)) definitions.push(lines.slice(from, to).join('\n'));
      inDefinition = false;
    } else if (inDefinition && token.map) {
      from = Math.min(from, token.map[0]);
      to = Math.max(to, token.map[1]);
    }
  }
  return (raw: string, id: string) => {
    if (!hasKnowledgeSyntax(raw)) return '';
    // A definition itself has no visible reference. Supply its marker so the
    // preserved definition card still displays the explanation rather than blank.
    const definition = /^ {0,3}\[\^([^\]\s]+)\]:/.exec(raw);
    const prefix = definition ? `[^${definition[1]}]\n\n` : '';
    return md.render(prefix + raw + '\n\n' + definitions.join('\n\n'), { docId: `opaque-${id}` });
  };
}
