import Paragraph from '@tiptap/extension-paragraph';
function literalParagraph(text: string) {
  let out = '',
    i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text[i] === '`') {
      let n = 1;
      while (text[i + n] === '`') n++;
      let end = i + n;
      while ((end = text.indexOf('`'.repeat(n), end)) >= 0) {
        if (text[end - 1] !== '`' && text[end + n] !== '`') break;
        end += n;
      }
      if (end >= 0) {
        out += text.slice(i, end + n);
        i = end + n;
        continue;
      }
    }
    const scheme = /^(https?|mailto|tel):/i.exec(text.slice(i));
    if (scheme) {
      out += scheme[1] + '\\:';
      i += scheme[0].length;
      continue;
    }
    out += text[i++];
  }
  return out
    .replace(/^( {0,3})(#{1,6})(?=\s|$)/gm, '$1\\$2')
    .replace(/^( {0,3})([-+])(?=\s)/gm, '$1\\$2')
    .replace(/^( {0,3})(\d+)([.)])(?=\s)/gm, '$1$2\\$3')
    .replace(/^( {0,3})(-{3,}|_{3,})(?=\s*$)/gm, '$1\\$2');
}
export const DocumentParagraph = Paragraph.extend({
  renderMarkdown(node, helpers) {
    return literalParagraph(helpers.renderChildren(node.content || []));
  },
});
