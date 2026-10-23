import { TextStyle, Color } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
export const ProjectTextStyle = TextStyle.extend({
  markdownTokenName: 'projectColor',
  markdownTokenizer: {
    name: 'projectColor',
    level: 'inline',
    start: (src: string) => src.indexOf('<span style="color:'),
    tokenize(src, _tokens, lexer) {
      const m =
        /^<span[ \t]+style="color:[ \t]*(#[0-9a-fA-F]{6})[ \t]*">([\s\S]*?)<\/span[ \t]*>/.exec(
          src,
        );
      if (!m) return;
      return { type: 'projectColor', raw: m[0], color: m[1], tokens: lexer.inlineTokens(m[2]) };
    },
  },
  parseMarkdown(token, helpers) {
    return helpers.applyMark('textStyle', helpers.parseInline(token.tokens || []), {
      color: token.color,
    });
  },
  renderMarkdown(node, helpers) {
    const content = helpers.renderChildren(node);
    const color = node.attrs?.color;
    return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
      ? `<span style="color:${color}">${content}</span>`
      : content;
  },
});
export const ProjectColor = Color.extend({
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          color: {
            default: null,
            parseHTML(element) {
              const value = element.style.color;
              const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
              if (rgb)
                return (
                  '#' +
                  rgb
                    .slice(1)
                    .map((v) => Number(v).toString(16).padStart(2, '0'))
                    .join('')
                );
              return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
            },
            renderHTML(attrs) {
              return typeof attrs.color === 'string' && /^#[0-9a-f]{6}$/i.test(attrs.color)
                ? { style: `color:${attrs.color}` }
                : {};
            },
          },
        },
      },
    ];
  },
}).configure({ types: ['textStyle'] });
export const ProjectAlignment = TextAlign.configure({
  types: ['heading', 'paragraph'],
  defaultAlignment: null,
});
