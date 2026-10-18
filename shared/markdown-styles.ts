import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it';

// Keep HTML disabled: these rules recognize only the source forms emitted by
// the Markdown toolbar, and let Markdown-it parse their contents normally.
const alignmentOpen = /^<div[ \t]+style="text-align:[ \t]*(left|center|right)[ \t]*"[ \t]*>[ \t]*$/;
const alignmentClose = /^<\/div[ \t]*>[ \t]*$/;
const colorOpen = /^<span[ \t]+style="color:[ \t]*(#[0-9a-fA-F]{6})[ \t]*"[ \t]*>/;
const colorClose = /^<\/span[ \t]*>/;

export function markdownStyles(md: MarkdownIt) {
  const blockDepth = new WeakMap<StateBlock, number>();
  const inlineDepth = new WeakMap<StateInline, number>();

  md.block.ruler.before(
    'html_block',
    'markdown_alignment',
    (state, startLine, _endLine, silent) => {
      // An indented code block must never activate a style.
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const source = state.src.slice(
        state.bMarks[startLine] + state.tShift[startLine],
        state.eMarks[startLine],
      );
      const opening = alignmentOpen.exec(source);
      const depth = blockDepth.get(state) || 0;
      if (!opening && !(depth && alignmentClose.test(source))) return false;
      if (silent) return true;

      const token = state.push(opening ? 'div_open' : 'div_close', 'div', opening ? 1 : -1);
      token.map = [startLine, startLine + 1];
      if (opening) token.attrSet('style', `text-align:${opening[1]}`);
      blockDepth.set(state, depth + (opening ? 1 : -1));
      state.line = startLine + 1;
      return true;
    },
    { alt: ['paragraph', 'reference', 'blockquote'] },
  );

  md.inline.ruler.before('html_inline', 'markdown_color', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 60) return false;
    const source = state.src.slice(state.pos, state.posMax);
    const opening = colorOpen.exec(source);
    const closing = opening ? null : colorClose.exec(source);
    const depth = inlineDepth.get(state) || 0;
    if (!opening && !(closing && depth)) return false;
    if (!silent) {
      const token = state.push(opening ? 'span_open' : 'span_close', 'span', opening ? 1 : -1);
      if (opening) token.attrSet('style', `color:${opening[1]}`);
      inlineDepth.set(state, depth + (opening ? 1 : -1));
    }
    state.pos += (opening || closing)![0].length;
    return true;
  });
}
