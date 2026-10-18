import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import MarkdownIt from 'markdown-it';
import {
  markdownTransaction,
  toolbarState,
  type MarkdownAction,
} from '../apps/web/markdown-format';
function state(doc: string, from = 0, to = from) {
  return EditorState.create({
    doc,
    selection: { anchor: from, head: to },
    extensions: [markdown({ base: markdownLanguage }), history()],
  });
}
function apply(s: EditorState, action: MarkdownAction) {
  return markdownTransaction(s, action)!.state;
}

describe('Markdown formatting commands', () => {
  it('wraps a selection, preserves it, and removes the same format on a second click', () => {
    let s = apply(state('before text after', 7, 11), 'bold');
    expect(s.doc.toString()).toBe('before **text** after');
    expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe('text');
    expect(toolbarState(s).bold).toBe(true);
    expect(toolbarState(s).italic).toBe(false);
    s = apply(s, 'bold');
    expect(s.doc.toString()).toBe('before text after');
  });
  it('removes an existing emphasis around a cursor and creates a selectable placeholder on an empty line', () => {
    expect(apply(state('**words**', 4), 'bold').doc.toString()).toBe('words');
    const s = apply(state(''), 'italic');
    expect(s.doc.toString()).toBe('*文字*');
    expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe('文字');
  });
  it('changes heading levels without accumulating prefixes or changing an unselected following line', () => {
    let s = apply(state('## First\nOther\nThird', 0, 15), 'heading3');
    expect(s.doc.toString()).toBe('### First\n### Other\nThird');
    s = apply(s, 'paragraph');
    expect(s.doc.toString()).toBe('First\nOther\nThird');
  });
  it('toggles and converts list markers while preserving indentation', () => {
    let s = apply(state('- first\n  - second', 0, 18), 'orderedList');
    expect(s.doc.toString()).toBe('1. first\n  2. second');
    s = apply(s, 'orderedList');
    expect(s.doc.toString()).toBe('first\n  second');
    s = apply(s, 'taskList');
    expect(s.doc.toString()).toBe('- [ ] first\n  - [ ] second');
    s = apply(s, 'bulletList');
    expect(s.doc.toString()).toBe('- first\n  - second');
  });
  it('quotes, indents and outdents whole selected lines without touching the next line', () => {
    let s = apply(state('one\ntwo\nthree', 0, 8), 'quote');
    expect(s.doc.toString()).toBe('> one\n> two\nthree');
    s = apply(s, 'quote');
    expect(s.doc.toString()).toBe('one\ntwo\nthree');
    s = apply(s, 'indent');
    expect(s.doc.toString()).toBe('  one\n  two\nthree');
    s = apply(s, 'outdent');
    expect(s.doc.toString()).toBe('one\ntwo\nthree');
  });
  it('inserts a link with the URL selected and a fenced code block around selected text', () => {
    let s = apply(state('name', 0, 4), 'link');
    expect(s.doc.toString()).toBe('[name](https://example.com)');
    expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe('https://example.com');
    s = apply(state('before\nconst x = 1\nafter', 7, 18), 'codeBlock');
    expect(s.doc.toString()).toBe('before\n```\nconst x = 1\n```\nafter');
  });
  it('formats multiple selections independently', () => {
    const s = EditorState.create({
      doc: 'one and two',
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(8, 11),
      ]),
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        markdown({ base: markdownLanguage }),
      ],
    });
    expect(apply(s, 'bold').doc.toString()).toBe('**one** and **two**');
  });
  it('keeps formatting as a single undoable transaction and refuses changes in read-only mode', () => {
    let s = apply(state('text', 0, 4), 'strike');
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
    expect(s.doc.toString()).toBe('~~text~~');
    const readonly = EditorState.create({ doc: 'safe', extensions: EditorState.readOnly.of(true) });
    expect(markdownTransaction(readonly, 'bold')).toBeUndefined();
  });
  it('preserves literal backticks in inline code and removes only its own delimiters', () => {
    let s = apply(state('`name` suffix`', 0, 14), 'inlineCode');
    expect(new MarkdownIt().render(s.doc.toString())).toContain('<code>`name` suffix`</code>');
    s = apply(s, 'inlineCode');
    expect(s.doc.toString()).toBe('`name` suffix`');
  });
  it('inserts valid Markdown tables and rules without merging them into neighboring paragraphs', () => {
    const md = new MarkdownIt();
    const table = apply(state('before\nafter', 7), 'table').doc.toString();
    expect(md.render(table)).toContain('<table>');
    expect(table).toContain('before');
    expect(table).toContain('after');
    const rule = apply(state('before\nafter', 7), 'rule').doc.toString();
    expect(md.render(rule)).toContain('<hr>');
    expect(md.render(rule)).not.toContain('<h2>');
  });
  it('keeps selected whitespace outside emphasis delimiters', () => {
    let s = apply(state(' hello ', 0, 7), 'bold');
    expect(s.doc.toString()).toBe(' **hello** ');
    expect(new MarkdownIt().render(s.doc.toString())).toContain('<strong>hello</strong>');
    s = apply(s, 'bold');
    expect(s.doc.toString()).toBe(' hello ');
  });
  it('converts complete setext and closed ATX headings rather than leaving heading markers in the text', () => {
    expect(apply(state('Title\n=====\n\nBody', 2), 'heading2').doc.toString()).toBe(
      '## Title\n\nBody',
    );
    expect(apply(state('## Title ##', 4), 'paragraph').doc.toString()).toBe('Title');
    expect(apply(state('Title\n-----', 2), 'paragraph').doc.toString()).toBe('Title');
    expect(toolbarState(state('Title\n=====', 2)).heading).toBe(1);
    expect(toolbarState(state('# Heading')).heading).toBe(1);
    expect(apply(state('## ##', 3), 'paragraph').doc.toString()).toBe('');
    expect(apply(state('First\nsecond\n=====', 2), 'heading2').doc.toString()).toBe(
      '## First second',
    );
  });
  it('does not treat literal or escaped strike markers as formatting', () => {
    const code = state('`~~literal~~`', 5);
    expect(toolbarState(code).strike).toBe(false);
    expect(markdownTransaction(code, 'strike')).toBeUndefined();
    const escaped = state('\\~\\~literal\\~\\~', 8);
    expect(toolbarState(escaped).strike).toBe(false);
  });
  it('changes heading syntax inside indentation, blockquotes and list items while retaining their containers', () => {
    expect(apply(state('   Title\n   =====', 5), 'heading2').doc.toString()).toBe('   ## Title');
    expect(apply(state('> Title\n> =====', 4), 'paragraph').doc.toString()).toBe('> Title');
    expect(apply(state('- Title\n  =====', 4), 'heading2').doc.toString()).toBe('- ## Title');
    expect(apply(state('> First\n> second\n> =====', 4), 'heading3').doc.toString()).toBe(
      '> ### First second',
    );
    expect(apply(state('- > ## Title ##', 8), 'paragraph').doc.toString()).toBe('- > Title');
    expect(apply(state('> Text', 4), 'heading2').doc.toString()).toBe('> ## Text');
  });
});
