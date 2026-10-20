import { EditorSelection, type EditorState, type Transaction } from '@codemirror/state';
import { isolateHistory, undoDepth, redoDepth } from '@codemirror/commands';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import {
  isStyleAction,
  styleState,
  styleTransaction,
  type StyleAction,
  type Alignment,
} from './markdown-style';

import {emptyToolbarState,type MarkdownAction,type MarkdownToolbarState} from './editor/toolbar-state';
export {emptyToolbarState,type MarkdownAction,type MarkdownToolbarState} from './editor/toolbar-state';
const markers = { bold: '**', italic: '*', strike: '~~', inlineCode: '`' };
const nodeNames = {
  bold: 'StrongEmphasis',
  italic: 'Emphasis',
  strike: 'Strikethrough',
  inlineCode: 'InlineCode',
};
type InlineAction = keyof typeof markers;

function enclosingInline(
  state: EditorState,
  action: InlineAction,
  position = state.selection.main.head,
) {
  let node = syntaxTree(state).resolveInner(position, -1);
  while (true) {
    if (node.name === nodeNames[action]) {
      const content = state.sliceDoc(node.from, node.to);
      const marker =
        action === 'inlineCode'
          ? content.match(/^`+/)?.[0]
          : action === 'bold'
            ? content.slice(0, 2)
            : action === 'italic'
              ? content.slice(0, 1)
              : markers[action];
      if (marker && content.endsWith(marker)) {
        const body = content.slice(marker.length, -marker.length);
        const padding =
          action === 'inlineCode' && body.startsWith(' ') && body.endsWith(' ') && body.trim()
            ? 1
            : 0;
        return { from: node.from, to: node.to, marker, trim: marker.length + padding };
      }
    }
    if (!node.parent) break;
    node = node.parent;
  }
}
function inlineTransaction(state: EditorState, action: InlineAction | 'link') {
  return state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (action === 'link') {
      const label = (text || '链接文字').replace(/[\\[\]]/g, '\\$&');
      const url = 'https://example.com';
      const insert = `[${label}](${url})`;
      const from = range.from + label.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(from, from + url.length),
      };
    }
    let marker = markers[action];
    const enclosing = enclosingInline(state, action, range.head);
    if (
      enclosing &&
      ((range.empty && state.selection.ranges.length === 1) ||
        (range.from === enclosing.from && range.to === enclosing.to) ||
        (range.from === enclosing.from + enclosing.trim &&
          range.to === enclosing.to - enclosing.trim))
    ) {
      const map = (position: number) =>
        Math.max(
          enclosing.from,
          Math.min(enclosing.to - enclosing.trim * 2, position - enclosing.trim),
        );
      return {
        changes: [
          { from: enclosing.from, to: enclosing.from + enclosing.trim },
          { from: enclosing.to - enclosing.trim, to: enclosing.to },
        ],
        range: EditorSelection.range(map(range.from), map(range.to)),
      };
    }
    const leading = action === 'inlineCode' ? '' : text.match(/^\s*/)?.[0] || '';
    const trailing = action === 'inlineCode' || !text.trim() ? '' : text.match(/\s*$/)?.[0] || '';
    const content =
      (action === 'inlineCode' ? text : text.trim()) || (action === 'inlineCode' ? '代码' : '文字');
    if (action === 'inlineCode')
      marker = '`'.repeat(
        Math.max(1, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length + 1)),
      );
    const padding =
      action === 'inlineCode' &&
      (/^`|`$/.test(content) ||
        (content.startsWith(' ') && content.endsWith(' ') && !!content.trim()))
        ? ' '
        : '';
    const insert = leading + marker + padding + content + padding + marker + trailing;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(
        range.from + leading.length + marker.length + padding.length,
        range.from + leading.length + marker.length + padding.length + content.length,
      ),
    };
  });
}
function selectedLines(state: EditorState) {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to);
    const end = !range.empty && last.from === range.to ? last.number - 1 : last.number;
    for (let number = first; number <= end; number++) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b).map((number) => state.doc.line(number));
}
function headingAtLine(state: EditorState, line: { from: number; to: number }, complete = false) {
  let found: { name: string; from: number; to: number } | undefined;
  const tree = (complete && ensureSyntaxTree(state, line.to, 50)) || syntaxTree(state);
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (/^(?:ATX|Setext)Heading[1-6]$/.test(node.type.name)) {
        found = { name: node.type.name, from: node.from, to: node.to };
        return false;
      }
    },
  });
  return found;
}
function contentStart(line: { from: number; text: string }) {
  // Retain Markdown containers when turning a paragraph into a heading.
  const prefix =
    line.text.match(
      /^(?:[ \t]*(?:>[ \t]?|[-+*][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+))*[ \t]*/,
    )?.[0] || '';
  return line.from + prefix.length;
}
function lineTransaction(state: EditorState, action: MarkdownAction) {
  const lines = selectedLines(state);
  const changes: { from: number; to?: number; insert?: string }[] = [];
  const handled = new Set<number>();
  const listPattern = /^([ \t]*)(?:[-+*][ \t]+\[[ xX]\][ \t]+|[-+*][ \t]+|\d+[.)][ \t]+)/;
  const patterns = {
    quote: /^[ \t]*>[ \t]?/,
    bulletList: /^[ \t]*[-+*](?![ \t]+\[[ xX]\])[ \t]+/,
    orderedList: /^[ \t]*\d+[.)][ \t]+/,
    taskList: /^[ \t]*[-+*][ \t]+\[[ xX]\][ \t]+/,
  };
  const eligible = lines.filter((line) => line.text.trim() || lines.length === 1);
  const toggleOff =
    action in patterns &&
    eligible.length > 0 &&
    eligible.every((line) => patterns[action as keyof typeof patterns].test(line.text));
  let ordinal = 0;
  for (const line of lines) {
    if (handled.has(line.number)) continue;
    const indent = line.text.match(/^[ \t]*/)![0];
    let remove = 0,
      insert = '';
    let editStart = line.from + indent.length;
    if (action === 'indent') {
      changes.push({ from: line.from, insert: '  ' });
      continue;
    }
    if (action === 'outdent') {
      const leading = line.text.match(/^(?: {1,2}|\t)/)?.[0];
      if (leading) changes.push({ from: line.from, to: line.from + leading.length });
      continue;
    }
    if (action === 'paragraph' || action.startsWith('heading')) {
      if (!line.text.trim() && lines.length > 1) continue;
      const node = headingAtLine(state, line, true);
      if (node?.name.startsWith('SetextHeading')) {
        const first = state.doc.lineAt(node.from),
          last = state.doc.lineAt(node.to);
        for (let number = first.number; number <= last.number; number++) handled.add(number);
        if (action === 'paragraph') changes.push({ from: last.from - 1, to: last.to });
        else if (last.number === first.number + 1) {
          changes.push({ from: node.from, insert: '#'.repeat(Number(action.slice(7))) + ' ' });
          changes.push({ from: last.from - 1, to: last.to });
        } else {
          const content = Array.from({ length: last.number - first.number }, (_, index) => {
            const part = state.doc.line(first.number + index);
            return state.sliceDoc(index === 0 ? node.from : contentStart(part), part.to).trim();
          }).join(' ');
          changes.push({
            from: node.from,
            to: last.to,
            insert: '#'.repeat(Number(action.slice(7))) + ' ' + content,
          });
        }
        continue;
      }

      editStart = node?.name.startsWith('ATXHeading') ? node.from : contentStart(line);
      const heading = node?.name.startsWith('ATXHeading')
        ? state.sliceDoc(editStart, line.to).match(/^#{1,6}(?:[ \t]+|$)/)?.[0] || ''
        : '';
      remove = heading.length;
      const closing = heading ? line.text.match(/[ \t]+#+[ \t]*$/)?.[0] : undefined;
      if (closing)
        changes.push({
          from: Math.max(editStart + heading.length, line.to - closing.length),
          to: line.to,
        });
      insert = action === 'paragraph' ? '' : '#'.repeat(Number(action.slice(7))) + ' ';
    } else if (action === 'quote') {
      remove = line.text.slice(indent.length).match(/^>[ \t]?/)?.[0].length || 0;
      insert = toggleOff ? '' : '> ';
    } else {
      if (!line.text.trim() && lines.length > 1) continue;
      remove = (line.text.match(listPattern)?.[0].length || indent.length) - indent.length;
      ordinal++;
      insert = toggleOff
        ? ''
        : action === 'bulletList'
          ? '- '
          : action === 'taskList'
            ? '- [ ] '
            : `${ordinal}. `;
    }
    if (remove || insert)
      changes.push({
        from: editStart,
        to: editStart + remove,
        insert,
      });
  }
  const set = state.changes(changes.sort((a, b) => a.from - b.from));
  return { changes: set, selection: state.selection.map(set) };
}
function blockTransaction(state: EditorState, action: 'codeBlock' | 'table' | 'rule') {
  return state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const before =
      range.from > 0 && state.sliceDoc(range.from - 1, range.from) !== '\n' ? '\n' : '';
    const after =
      range.to < state.doc.length && state.sliceDoc(range.to, range.to + 1) !== '\n' ? '\n' : '';
    if (action === 'codeBlock') {
      const content = (text || '代码').replace(/\n$/, '');
      const fence = '`'.repeat(
        Math.max(3, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length + 1)),
      );
      const insert = before + fence + '\n' + content + '\n' + fence + after;
      const start = range.from + before.length + fence.length + 1;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(start, start + content.length),
      };
    }
    const body = action === 'table' ? '| 标题 1 | 标题 2 |\n| --- | --- |\n| 内容 | 内容 |' : '---';
    const insert = before + '\n' + body + '\n' + after;
    const position = range.from + before.length + 1;
    return {
      changes: { from: range.from, to: range.to, insert },
      range:
        action === 'table'
          ? EditorSelection.range(position + 2, position + 6)
          : EditorSelection.cursor(range.from + insert.length),
    };
  });
}
export function markdownTransaction(
  state: EditorState,
  action: MarkdownAction,
): Transaction | undefined {
  if (
    state.readOnly ||
    (['bold', 'italic', 'strike', 'link'].includes(action) && enclosingInline(state, 'inlineCode'))
  )
    return;
  const spec = isStyleAction(action)
    ? styleTransaction(state, action)
    : action in markers || action === 'link'
      ? inlineTransaction(state, action as InlineAction | 'link')
      : action === 'codeBlock' || action === 'table' || action === 'rule'
        ? blockTransaction(state, action)
        : lineTransaction(state, action);
  if (!spec) return;
  return state.update({
    ...spec,
    userEvent: 'input.format',
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  });
}
export function toolbarState(state: EditorState): MarkdownToolbarState {
  const currentLine = state.doc.lineAt(state.selection.main.head);
  const line = currentLine.text;
  const active = (action: InlineAction) => !!enclosingInline(state, action);
  const node = headingAtLine(state, currentLine);
  const heading = node && Number(node.name.at(-1)) <= 5 ? Number(node.name.at(-1)) : 0;
  return {
    ...styleState(state),
    heading,
    bold: active('bold'),
    italic: active('italic'),
    strike: active('strike'),
    code: active('inlineCode'),
    quote: /^[ \t]*>/.test(line),
    bullet: /^[ \t]*[-+*](?![ \t]+\[[ xX]\])[ \t]+/.test(line),
    ordered: /^[ \t]*\d+[.)][ \t]+/.test(line),
    task: /^[ \t]*[-+*][ \t]+\[[ xX]\]/.test(line),
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
  };
}
