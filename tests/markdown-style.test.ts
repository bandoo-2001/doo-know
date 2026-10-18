import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import MarkdownIt from 'markdown-it';
import { markdownStyles } from '../shared/markdown-styles.js';
import {
  markdownTransaction,
  toolbarState,
  type MarkdownAction,
} from '../apps/web/markdown-format';
import { renderMarkdown, references } from '../packages/core/render.js';
import { outlineFromTokens } from '../apps/web/document-outline';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';

function state(doc: string, from = 0, to = from) {
  return EditorState.create({
    doc,
    selection: { anchor: from, head: to },
    extensions: [markdown({ base: markdownLanguage }), history()],
  });
}
const apply = (s: EditorState, action: MarkdownAction) => markdownTransaction(s, action)!.state;
describe('document alignment and text colors', () => {
  it('rebuilds code exclusions after a bounded parse finishes on the same large document', () => {
    const prefix = Array.from(
      { length: 15000 },
      (_, index) => `Line ${index} [label](https://example.com) **bold** *em* ~~strike~~.\n\n`,
    ).join('');
    const code = '```txt\nconst secret = 42;\n```';
    const doc = prefix + `before\n\n${code}\n\nafter`;
    let s = state(doc, 0, 4);
    expect(syntaxTree(s).length).toBeLessThan(doc.length);
    let now = Date.now();
    // A real parser with a deterministically exhausted budget, independent of CPU speed.
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
    try {
      toolbarState(s);
    } finally {
      clock.mockRestore();
    }
    expect(ensureSyntaxTree(s, doc.length, 10000)?.length).toBe(doc.length);
    const originalDoc = s.doc;
    s = s.update({ selection: { anchor: prefix.length, head: doc.length } }).state;
    expect(s.doc).toBe(originalDoc);
    const next = apply(s, 'color:#dc2626');
    expect(next.doc.toString().slice(prefix.length)).toContain(code);
    expect(next.doc.toString().slice(prefix.length)).toContain(
      '<span style="color:#dc2626">before</span>',
    );
  });
  it('leaves unparsed source untouched when a bounded parse cannot reach code at the tail', () => {
    const prefix = 'Paragraph **words** and [link](other.md).\n\n'.repeat(2000);
    const tail = 'before\n\n```txt\nprotected\n```\n\nafter';
    const s = state(prefix + tail, prefix.length, prefix.length + tail.length);
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
    try {
      const transaction = markdownTransaction(s, 'color:#dc2626');
      expect(transaction?.newDoc.toString().slice(prefix.length) || tail).toBe(tail);
    } finally {
      clock.mockRestore();
    }
  });
  it('uses the ensured tree to disable styles in code before the state publishes that tree', () => {
    const prefix = 'Paragraph\n\n'.repeat(1000);
    const doc = prefix + '```txt\nprotected\n```';
    const s = state(doc, doc.indexOf('protected') + 1);
    expect(syntaxTree(s).length).toBeLessThan(doc.length);
    expect(ensureSyntaxTree(s, doc.length, 10000)?.length).toBe(doc.length);
    expect(toolbarState(s).styleDisabled).toBe(true);
    expect(markdownTransaction(s, 'alignCenter')).toBeUndefined();
  });
  it('refreshes alignment regions after a partial parse without interpreting fenced markers', () => {
    const prefix = 'Paragraph **words** and [link](other.md).\n\n'.repeat(2000);
    const tail =
      '<div style="text-align:center">\n\nbody\n\n```html\n<div style="text-align:right">\n\nfenced\n\n</div>\n```\n\n</div>';
    let s = state(prefix + tail);
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 1000));
    try {
      toolbarState(s);
    } finally {
      clock.mockRestore();
    }
    expect(ensureSyntaxTree(s, s.doc.length, 10000)?.length).toBe(s.doc.length);
    s = s.update({ selection: { anchor: prefix.length + tail.indexOf('body') + 1 } }).state;
    expect(toolbarState(s).alignment).toBe('center');
    const next = apply(s, 'alignLeft');
    expect(next.doc.toString()).toContain(
      '```html\n<div style="text-align:right">\n\nfenced\n\n</div>\n```',
    );
    expect(next.doc.toString()).toContain('<div style="text-align:left">');
  });
  it('keeps valid text selections through style history and subsequent color changes', () => {
    const doc = '# 样式检查\n\n需要改变颜色的文字\n\n下一段保持默认。';
    const text = '需要改变颜色的文字';
    let s = apply(state(doc, 8, 17), 'color:#dc2626');
    s = apply(s, 'alignCenter');
    const target = {
      get state() {
        return s;
      },
      dispatch(t: import('@codemirror/state').Transaction) {
        s = t.state;
      },
    };
    expect(undo(target)).toBe(true);
    expect(redo(target)).toBe(true);
    expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe(text);
    for (const action of ['alignRight', 'alignLeft', 'alignCenter', 'color:#2563eb'] as const) {
      s = apply(s, action);
      expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe(text);
    }
    expect(s.doc.toString()).toContain('#2563eb');
    expect(undo(target)).toBe(true);
    expect(redo(target)).toBe(true);
    expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe(text);
  });
  it('keeps code blocks and literal span source intact in a larger color selection', () => {
    const code = '```html\n<span style="color:#dc2626">literal</span>\n```';
    const inline = '`<span style="color:#dc2626">inline</span>`';
    const doc = `Before\n\n${code}\n\nAfter ${inline} end`;
    const s = apply(state(doc, 0, doc.length), 'color:#2563eb');
    expect(s.doc.toString()).toContain(code);
    expect(s.doc.toString()).toContain(inline);
    expect(renderMarkdown(s.doc.toString()).html).toContain('<pre><code>');
    expect(renderMarkdown(s.doc.toString()).html).toContain('literal&lt;/span&gt;');
  });
  it('recolors a reversed selection of the canonical aligned source and reports its current color', () => {
    const doc =
      '# 样式检查\n\n<div style="text-align:center">\n\n<span style="color:#dc2626">需要改变颜色的文字</span>\n\n</div>\n\n下一段保持默认。';
    const s = state(doc, 93, 8);
    expect(toolbarState(s).color).toBe('#dc2626');
    const next = apply(s, 'color:#2563eb');
    expect(next.doc.toString()).toContain('<span style="color:#2563eb">需要改变颜色的文字</span>');
    expect(next.doc.toString()).not.toContain('#dc2626');
    expect(next.selection.main.anchor).toBeGreaterThan(next.selection.main.head);
    expect(next.doc.toString()).toContain('下一段保持默认。');
  });
  it('resets existing color around Markdown emphasis without changing the emphasis', () => {
    const doc = '<span style="color:#dc2626">**bold** [link](other.md)</span>';
    const next = apply(state(doc, 0, doc.length), 'colorDefault');
    expect(next.doc.toString()).toBe('**bold** [link](other.md)');
    expect(renderMarkdown(next.doc.toString(), () => '/other').html).toContain(
      '<strong>bold</strong> <a href="/other">link</a>',
    );
  });
  it('keeps alignment tags intact when coloring the entire aligned source', () => {
    const doc = '<div style="text-align:center">\n\nWords\n\n</div>';
    const s = apply(state(doc, 0, doc.length), 'color:#2563eb');
    expect(s.doc.toString()).toBe(
      '<div style="text-align:center">\n\n<span style="color:#2563eb">Words</span>\n\n</div>',
    );
    expect(renderMarkdown(s.doc.toString()).html).toContain('<div style="text-align:center">');
  });
  it('preserves heading, table, list and horizontal-rule syntax when coloring a document', () => {
    const doc = '# ATX #\n\nSetext\n======\n\n- Item\n\n| A | B |\n| --- | --- |\n| x | y |\n\n---';
    const s = apply(state(doc, 0, doc.length), 'color:#2563eb');
    const html = renderMarkdown(s.doc.toString()).html;
    expect(html.match(/<h1 /g)).toHaveLength(2);
    expect(html).toContain('<ul>');
    expect(html).toContain('<table>');
    expect(html).toContain('<hr />');
    expect(html).toContain('<th><span style="color:#2563eb">A</span></th>');
  });
  it('changes a partial selection across colored paragraphs without corrupting suffix colors', () => {
    const doc =
      '<span style="color:#dc2626">first second</span>\n\n<span style="color:#dc2626">third fourth</span>';
    const s = apply(state(doc, doc.indexOf('second'), doc.indexOf('third') + 5), 'color:#2563eb');
    expect(s.doc.toString()).toBe(
      '<span style="color:#dc2626">first </span><span style="color:#2563eb">second</span>\n\n<span style="color:#2563eb">third</span><span style="color:#dc2626"> fourth</span>',
    );
    expect(renderMarkdown(s.doc.toString()).html).not.toContain('&lt;/span&gt;');
  });
  it('resets only selected colors across multiple paragraphs', () => {
    const doc =
      '<span style="color:#dc2626">first second</span>\n\n<span style="color:#dc2626">third fourth</span>';
    const s = apply(state(doc, doc.indexOf('second'), doc.indexOf('third') + 5), 'colorDefault');
    expect(s.doc.toString()).toBe(
      '<span style="color:#dc2626">first </span>second\n\nthird<span style="color:#dc2626"> fourth</span>',
    );
  });
  it('colors two selections in the same span without duplicating text', () => {
    const doc = '<span style="color:#dc2626">first second third</span>';
    const s = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.range(doc.indexOf('first'), doc.indexOf('first') + 5),
        EditorSelection.range(doc.indexOf('third'), doc.indexOf('third') + 5),
      ]),
      extensions: [
        markdown({ base: markdownLanguage }),
        EditorState.allowMultipleSelections.of(true),
      ],
    });
    const next = apply(s, 'color:#2563eb');
    expect(next.doc.toString()).toBe(
      '<span style="color:#2563eb">first</span><span style="color:#dc2626"> second </span><span style="color:#2563eb">third</span>',
    );
    expect(next.selection.ranges.map((range) => next.sliceDoc(range.from, range.to))).toEqual([
      'first',
      'third',
    ]);
  });
  it('does not mistake an escaped literal span opener for an existing color', () => {
    const doc = '\\<span style="color:#dc2626">literal</span>';
    const next = apply(state(doc, 0, doc.length), 'color:#2563eb');
    expect(next.doc.toString()).toContain('#dc2626');
    expect(next.doc.toString()).toContain('literal');
  });
  it('retains the text selection while changing both alignment and color', () => {
    const doc = '# Heading\n\nWords\n\nAfter';
    let s = apply(state(doc, 11, 16), 'color:#dc2626');
    for (const action of ['alignCenter', 'alignRight', 'alignLeft', 'alignCenter'] as const) {
      s = apply(s, action);
      expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe('Words');
      expect(toolbarState(s).color).toBe('#dc2626');
    }
    s = apply(s, 'color:#2563eb');
    expect(s.doc.toString()).toContain('color:#2563eb');
    expect(s.doc.toString()).not.toContain('#dc2626');
  });
  it('aligns only the selected paragraph at a block boundary', () => {
    const doc = '# Heading\n\nParagraph\n\nAfter';
    const s = apply(state(doc, 11, 20), 'alignCenter');
    expect(s.doc.toString()).toBe(
      '# Heading\n\n<div style="text-align:center">\n\nParagraph\n\n</div>\n\nAfter',
    );
    const first = apply(state('First\n\nSecond', 0), 'alignRight');
    expect(first.doc.toString()).toBe(
      '<div style="text-align:right">\n\nFirst\n\n</div>\n\nSecond',
    );
  });
  it('aligns a whole paragraph and switches alignment without nesting wrappers', () => {
    let s = apply(state('before\n\nfirst\nsecond\n\nafter', 10), 'alignCenter');
    expect(s.doc.toString()).toBe(
      'before\n\n<div style="text-align:center">\n\nfirst\nsecond\n\n</div>\n\nafter',
    );
    expect(toolbarState(s).alignment).toBe('center');
    s = apply(s, 'alignRight');
    expect(s.doc.toString().match(/<div/g)).toHaveLength(1);
    expect(toolbarState(s).alignment).toBe('right');
    s = apply(s, 'alignLeft');
    expect(toolbarState(s).alignment).toBe('left');
  });
  it('colors a selection, replaces its color and restores the original text', () => {
    let s = apply(state('before words after', 7, 12), 'color:#dc2626');
    expect(s.doc.toString()).toBe('before <span style="color:#dc2626">words</span> after');
    expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe('words');
    expect(toolbarState(s).color).toBe('#dc2626');
    s = apply(s, 'color:#2563eb');
    expect(s.doc.toString()).not.toContain('#dc2626');
    expect(s.doc.toString().match(/<span/g)).toHaveLength(1);
    s = apply(s, 'colorDefault');
    expect(s.doc.toString()).toBe('before words after');
  });
  it('changes only part of an existing colored selection and can reset that part', () => {
    const doc = '<span style="color:#dc2626">first second third</span>';
    const from = doc.indexOf('second');
    const colored = apply(state(doc, from, from + 6), 'color:#2563eb');
    const html = renderMarkdown(colored.doc.toString()).html;
    expect(html).toContain('color:#2563eb');
    expect(html).toContain('first ');
    const reset = apply(state(doc, from, from + 6), 'colorDefault');
    expect(reset.doc.toString()).toBe(
      '<span style="color:#dc2626">first </span>second<span style="color:#dc2626"> third</span>',
    );
  });
  it('keeps headings, blank paragraphs and code intact when coloring several lines', () => {
    const doc = '# Heading\n\nParagraph\n\n`literal`';
    const s = apply(state(doc, 0, doc.indexOf('`literal`') - 1), 'color:#16a34a');
    const result = renderMarkdown(s.doc.toString());
    expect(result.html).toContain('<h1');
    expect(result.html).toContain('Heading</span></h1>');
    expect(result.html).toContain('<p><span style="color:#16a34a">Paragraph</span></p>');
    expect(result.html).toContain('<code>literal</code>');
  });
  it('supports undo/redo, rejects invalid styles and protects inline and fenced code', () => {
    let s = apply(state('text', 0, 4), 'color:#dc2626');
    const target = {
      get state() {
        return s;
      },
      dispatch(t: import('@codemirror/state').Transaction) {
        s = t.state;
      },
    };
    expect(undo(target)).toBe(true);
    expect(s.doc.toString()).toBe('text');
    expect(redo(target)).toBe(true);
    expect(s.doc.toString()).toContain('color:#dc2626');
    for (const doc of ['`code`', '```\ncode\n```']) {
      const s = state(doc, doc.indexOf('code') + 1);
      expect(markdownTransaction(s, 'color:#dc2626')).toBeUndefined();
      expect(markdownTransaction(s, 'alignCenter')).toBeUndefined();
    }
    expect(
      markdownTransaction(state('text'), 'color:#bad;position:fixed' as MarkdownAction),
    ).toBeUndefined();
    expect(
      markdownTransaction(
        EditorState.create({ doc: 'text', extensions: EditorState.readOnly.of(true) }),
        'alignRight',
      ),
    ).toBeUndefined();
  });
});

describe('restricted Markdown style rendering', () => {
  const md = new MarkdownIt({ html: false }).use(markdownStyles);
  it('keeps headings, links and source lines inside an aligned document', () => {
    const content =
      '<div style="text-align:center">\n\n# <span style="color:#2563eb">Heading</span>\n\n[Link](other.md)\n\n</div>';
    const html = renderMarkdown(content, () => '/safe-note').html;
    expect(html).toContain('<div style="text-align:center">');
    expect(html).toContain('<span style="color:#2563eb">Heading</span>');
    expect(html).toContain('href="/safe-note"');
    expect(references(content)).toEqual(['other.md']);
    expect(outlineFromTokens(md.parse(content, {}))).toEqual([
      { line: 3, level: 1, title: 'Heading' },
    ]);
  });
  it('escapes arbitrary HTML, event handlers and non-color CSS', () => {
    for (const content of [
      '<script>alert(1)</script>',
      '<span style="color:#dc2626" onclick="alert(1)">text</span>',
      '<span style="color:red;position:fixed">text</span>',
      '<div style="text-align:center;background:url(javascript:x)">text</div>',
    ]) {
      const html = md.render(content);
      expect(html).not.toMatch(/<(?:script|span|div)[ >]/);
      expect(html).toContain('&lt;');
    }
  });
  it('preserves style markup as text inside inline and fenced code', () => {
    const content =
      '<div style="text-align:right">\n\n```html\n</div>\n<span style="color:#dc2626">code</span>\n```\n\n`<span style="color:#2563eb">literal</span>`\n\n</div>';
    const html = md.render(content);
    expect(html.match(/<div /g)).toHaveLength(1);
    expect(html).not.toContain('<span style=');
    expect(html).toContain('&lt;/div&gt;');
    expect(html).toContain('&lt;span');
  });
});
