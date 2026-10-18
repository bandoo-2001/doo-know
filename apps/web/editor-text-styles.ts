import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { Prec, type EditorState, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, ViewPlugin, type ViewUpdate } from '@codemirror/view';

interface SourceRange {
  from: number;
  to: number;
}
interface StyleMarker extends SourceRange {
  kind: 'color' | 'alignment';
  value?: string;
  paired?: boolean;
}
const sourceMarkers =
  /^ {0,3}<div[ \t]+style="text-align:[ \t]*(left|center|right)[ \t]*"[ \t]*>[ \t]*$|^ {0,3}<\/div[ \t]*>[ \t]*$|<span[ \t]+style="color:[ \t]*(#[\da-fA-F]{6})[ \t]*"[ \t]*>|<\/span[ \t]*>/gm;
const cache = new WeakMap<
  object,
  { tree: ReturnType<typeof syntaxTree>; decorations: DecorationSet }
>();

/** Visual styling only: source, selections and history stay entirely in CodeMirror's document. */
export function buildTextStyleDecorations(state: EditorState): DecorationSet {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) || syntaxTree(state);
  const cached = cache.get(state.doc);
  if (cached?.tree === tree) return cached.decorations;
  const source = state.doc.toString();
  const code: SourceRange[] = [];
  tree.iterate({
    enter(node) {
      if (['InlineCode', 'FencedCode', 'CodeBlock'].includes(node.name)) {
        code.push({ from: node.from, to: node.to });
        return false;
      }
    },
  });
  const markers: StyleMarker[] = [];
  const stacks: Record<StyleMarker['kind'], StyleMarker[]> = { color: [], alignment: [] };
  let codeIndex = 0;
  for (const match of source.matchAll(sourceMarkers)) {
    const from = match.index!;
    // A background parse may not yet have reached the document's tail. Wait
    // for its next tree update instead of mistaking unparsed code for styles.
    if (from + match[0].length > tree.length) break;
    while (code[codeIndex] && code[codeIndex].to <= from) codeIndex++;
    if (code[codeIndex] && code[codeIndex].from <= from) continue;
    let slashes = 0;
    for (let index = from - 1; index >= 0 && source[index] === '\\'; index--) slashes++;
    if (slashes % 2) continue;
    const kind =
      match[0].trimStart().startsWith('<div') || match[0].trimStart().startsWith('</div')
        ? 'alignment'
        : 'color';
    const marker: StyleMarker = {
      from,
      to: from + match[0].length,
      kind,
      value: match[1] || match[2]?.toLowerCase(),
    };
    markers.push(marker);
    if (marker.value) stacks[kind].push(marker);
    else {
      const opening = stacks[kind].pop();
      if (opening) {
        opening.paired = true;
        marker.paired = true;
      }
    }
  }
  const decorations: Range<Decoration>[] = [];
  // Exclude all source markers and code literals even when enclosed by a color.
  const excluded = [...code, ...markers].sort((a, b) => a.from - b.from);
  let excludedIndex = 0;
  const addColor = (from: number, to: number, color: string) => {
    while (excluded[excludedIndex] && excluded[excludedIndex].to <= from) excludedIndex++;
    for (let index = excludedIndex; index < excluded.length && excluded[index].from < to; index++) {
      const range = excluded[index];
      if (range.from > from)
        decorations.push(
          Decoration.mark({
            class: 'cm-text-color',
            attributes: { style: `color:${color}` },
          }).range(from, Math.min(to, range.from)),
        );
      from = Math.max(from, range.to);
      if (from >= to) return;
    }
    if (from < to)
      decorations.push(
        Decoration.mark({ class: 'cm-text-color', attributes: { style: `color:${color}` } }).range(
          from,
          to,
        ),
      );
  };
  const colors: string[] = [];
  let previous = 0;
  for (const marker of markers.filter((marker) => marker.kind === 'color' && marker.paired)) {
    const color = colors.at(-1);
    if (color) addColor(previous, marker.from, color);
    if (marker.value) colors.push(marker.value);
    else colors.pop();
    previous = marker.to;
  }
  const alignmentMarkers = new Map(
    markers.filter((marker) => marker.kind === 'alignment').map((marker) => [marker.from, marker]),
  );
  const alignments: string[] = [];
  codeIndex = 0;
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const marker = alignmentMarkers.get(line.from);
    if (marker) {
      if (marker.paired) {
        if (marker.value) alignments.push(marker.value);
        else alignments.pop();
      }
      continue;
    }
    const alignment = alignments.at(-1);
    if (!alignment || !line.text.trim()) continue;
    const contentFrom = line.from + line.text.search(/\S/);
    while (code[codeIndex] && code[codeIndex].to <= contentFrom) codeIndex++;
    if (code[codeIndex] && code[codeIndex].from <= contentFrom && code[codeIndex].to >= line.to)
      continue;
    decorations.push(
      Decoration.line({
        attributes: { class: 'cm-text-aligned', style: `text-align:${alignment}` },
      }).range(line.from),
    );
  }
  const result = Decoration.set(decorations, true);
  cache.set(state.doc, { tree, decorations: result });
  return result;
}

// Explicit source colors must nest inside syntax highlighting marks, whose
// plugin uses Prec.high, so heading and link colors cannot override them.
export const editorTextStyles = Prec.highest(
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: { state: EditorState }) {
        this.decorations = buildTextStyleDecorations(view.state);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state))
          this.decorations = buildTextStyleDecorations(update.state);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
);
