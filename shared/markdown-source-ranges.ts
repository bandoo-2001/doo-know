import MarkdownIt from 'markdown-it';
import footnotes from 'markdown-it-footnote';
const parser = new MarkdownIt({ html: false }).use(footnotes);
const definition = (parser.block.ruler as any).__rules__.find(
  (rule: any) => rule.name === 'footnote_def',
).fn;
parser.block.ruler.at(
  'footnote_def',
  (state: any, startLine: number, endLine: number, silent: boolean) => {
    const accepted = definition(state, startLine, endLine, silent);
    if (accepted && !silent)
      state.env.sourceFootnoteRanges.push({ fromLine: startLine, toLine: state.line });
    return accepted;
  },
  { alt: ['paragraph', 'reference'] },
);
/** Let the actual footnote block parser decide indentation and continuation bounds. */
export function footnoteLineRanges(markdown: string): { fromLine: number; toLine: number }[] {
  if (!markdown.includes('[^')) return [];
  const env = { sourceFootnoteRanges: [] as { fromLine: number; toLine: number }[] };
  parser.parse(markdown, env);
  return env.sourceFootnoteRanges.sort((a, b) => a.fromLine - b.fromLine || b.toLine - a.toLine);
}
