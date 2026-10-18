import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { buildTextStyleDecorations, editorTextStyles } from '../apps/web/editor-text-styles';

function decorated(source: string) {
  const state = EditorState.create({
    doc: source,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const values: { from: number; to: number; text: string; class: string; style: string }[] = [];
  buildTextStyleDecorations(state).between(0, source.length, (from, to, value) => {
    const attributes = value.spec.attributes || {};
    values.push({
      from,
      to,
      text: source.slice(from, to),
      class: value.spec.class || attributes.class,
      style: attributes.style,
    });
  });
  return {
    state,
    values,
    color: values.filter((value) => value.class === 'cm-text-color'),
    lines: values.filter((value) => value.class === 'cm-text-aligned'),
  };
}

describe('source editor text styles', () => {
  it('nests user color marks inside the syntax highlighter, including headings and links', () => {
    const sourceStyleProvider = EditorState.create({ extensions: [editorTextStyles] }).facet(
      EditorView.decorations,
    )[0];
    const state = EditorState.create({
      doc: '# <span style="color:#dc2626">Heading</span>',
      extensions: [
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle),
        editorTextStyles,
      ],
    });
    const providers = state.facet(EditorView.decorations);
    expect(providers.length).toBeGreaterThan(1);
    // Earlier decoration providers have higher precedence and create the inner
    // DOM spans, where their explicit color overrides inherited syntax colors.
    expect(providers[0]).toBe(sourceStyleProvider);
  });
  it('colors body text while leaving all visible source markers outside decorations', () => {
    const source = '<span style="color:#dc2626">red **words**</span> plain';
    const { state, color } = decorated(source);
    expect(color.map((value) => [value.text, value.style])).toEqual([
      ['red **words**', 'color:#dc2626'],
    ]);
    expect(state.doc.toString()).toBe(source);
    expect(state.selection.main.from).toBe(0);
  });

  it('gives nested colors their own ranges and resumes the parent color', () => {
    const source =
      '<span style="color:#dc2626">red <span style="color:#2563EB">blue</span> red</span>';
    expect(decorated(source).color.map((value) => [value.text, value.style])).toEqual([
      ['red ', 'color:#dc2626'],
      ['blue', 'color:#2563eb'],
      [' red', 'color:#dc2626'],
    ]);
  });

  it('aligns paragraph body lines with the innermost alignment, without aligning markers', () => {
    const source =
      '<div style="text-align:center">\n\n# Heading\nparagraph\n\n<div style="text-align:right">\n\nright\n\n</div>\n\ncenter again\n\n</div>';
    const { lines } = decorated(source);
    expect(
      lines.map((value) => [
        source.slice(
          value.from,
          source.indexOf('\n', value.from) < 0 ? source.length : source.indexOf('\n', value.from),
        ),
        value.style,
      ]),
    ).toEqual([
      ['# Heading', 'text-align:center'],
      ['paragraph', 'text-align:center'],
      ['right', 'text-align:right'],
      ['center again', 'text-align:center'],
    ]);
  });

  it('ignores markers in inline, fenced and indented code and never colors code content', () => {
    const source =
      '<div style="text-align:center">\n\n<span style="color:#dc2626">before `literal` after</span>\n\n```html\n</div>\n<span style="color:#123456">fenced</span>\n```\n\n    <span style="color:#123456">indented</span>\n\n`<span style="color:#123456">inline</span>`\n\nplain\n\n</div>';
    const { color, lines } = decorated(source);
    expect(color.map((value) => value.text)).toEqual(['before ', ' after']);
    expect(
      lines.map((value) => source.slice(value.from, source.indexOf('\n', value.from))),
    ).toEqual(['<span style="color:#dc2626">before `literal` after</span>', 'plain']);
  });

  it.each([
    '<span style="color:#123">bad</span>',
    '<span style="color:#123456;display:none">bad</span>',
    '<span style="color:#123456" onclick="bad()">bad</span>',
    '<div style="text-align:justify">\n\nbad\n\n</div>',
    '<div style="text-align:center" onclick="bad()">\n\nbad\n\n</div>',
    '\\<span style="color:#123456">escaped</span>',
    '<span style="color:#123456">unclosed',
  ])('does not decorate unsafe, escaped or unpaired style source: %s', (source) => {
    expect(decorated(source).values).toEqual([]);
  });

  it('caches decorations for the same document and rebuilds after source edits', () => {
    const { state } = decorated('<span style="color:#dc2626">red</span>');
    expect(buildTextStyleDecorations(state)).toBe(buildTextStyleDecorations(state));
    const updated = state.update({ changes: { from: 19, to: 26, insert: '#2563eb' } }).state;
    const values: string[] = [];
    buildTextStyleDecorations(updated).between(0, updated.doc.length, (_from, _to, value) => {
      values.push(value.spec.attributes.style);
    });
    expect(values).toEqual(['color:#2563eb']);
  });
});
