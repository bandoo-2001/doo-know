import {
  ChangeSet,
  EditorSelection,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';

export type Alignment = 'left' | 'center' | 'right';
export type StyleAction =
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'colorDefault'
  | `color:#${string}`;
export const textColors = [
  { name: '红色', value: '#dc2626' },
  { name: '橙色', value: '#ea580c' },
  { name: '金色', value: '#a16207' },
  { name: '绿色', value: '#16a34a' },
  { name: '青色', value: '#0891b2' },
  { name: '蓝色', value: '#2563eb' },
  { name: '紫色', value: '#9333ea' },
  { name: '灰色', value: '#64748b' },
];
export const isStyleAction = (action: string): action is StyleAction =>
  /^align(?:Left|Center|Right)$/.test(action) ||
  action === 'colorDefault' ||
  action.startsWith('color:');

type MarkdownTree = ReturnType<typeof syntaxTree>;
function inCode(
  state: EditorState,
  position: number,
  tree: MarkdownTree | null = ensureSyntaxTree(state, position, 30),
) {
  // Unknown source may still contain code. Wait for parsing before styling it.
  if (!tree) return true;
  let node = tree.resolveInner(position, -1);
  while (node.parent) {
    if (['InlineCode', 'FencedCode', 'CodeBlock'].includes(node.name)) return true;
    node = node.parent;
  }
  return false;
}
interface Region {
  from: number;
  bodyFrom: number;
  bodyTo: number;
  to: number;
  value: string;
}
function escapedAt(source: string, position: number) {
  let slashes = 0;
  while (position > 0 && source[--position] === '\\') slashes++;
  return slashes % 2 === 1;
}
const alignmentCache = new WeakMap<
  object,
  { tree: ReturnType<typeof syntaxTree>; regions: Region[] }
>();
function alignments(state: EditorState, tree?: MarkdownTree | null) {
  const source = state.doc.toString();
  if (!source.includes('<div') && !source.includes('</div>')) return [];
  if (tree === undefined) tree = ensureSyntaxTree(state, state.doc.length, 100);
  if (!tree) return;
  const cached = alignmentCache.get(state.doc);
  if (cached?.tree === tree) return cached.regions;
  const regions: Region[] = [],
    stack: { from: number; bodyFrom: number; value: string }[] = [];
  for (const match of source.matchAll(
    /^<div style="text-align:(left|center|right)">[ \t]*$|^<\/div>[ \t]*$/gm,
  )) {
    let node = tree.resolveInner(match.index! + 1, -1);
    let code = false;
    while (node.parent) {
      if (['InlineCode', 'FencedCode', 'CodeBlock'].includes(node.name)) {
        code = true;
        break;
      }
      node = node.parent;
    }
    if (code) continue;
    if (match[1]) {
      const end = match.index! + match[0].length;
      stack.push({
        from: match.index!,
        bodyFrom: end + (source.slice(end, end + 2) === '\n\n' ? 2 : 1),
        value: match[1],
      });
    } else {
      const start = stack.pop();
      if (start)
        regions.push({
          ...start,
          bodyTo: match.index! - (source.slice(match.index! - 2, match.index!) === '\n\n' ? 2 : 1),
          to: match.index! + match[0].length,
        });
    }
  }
  alignmentCache.set(state.doc, { tree, regions });
  return regions;
}
function coloredRegion(state: EditorState, from: number, to: number, tree?: MarkdownTree | null) {
  const line = state.doc.lineAt(from);
  if (to > line.to) return;
  const stack: { from: number; bodyFrom: number; value: string }[] = [];
  for (const match of line.text.matchAll(/<span style="color:(#[a-f\d]{6})">|<\/span>/gi)) {
    const start = line.from + match.index!;
    if (inCode(state, start + 1, tree) || escapedAt(line.text, match.index!)) continue;
    if (match[1])
      stack.push({ from: start, bodyFrom: start + match[0].length, value: match[1].toLowerCase() });
    else {
      const open = stack.pop();
      const end = start + match[0].length;
      if (open && ((from >= open.bodyFrom && to <= start) || (from === open.from && to === end)))
        return { ...open, bodyTo: start, to: end };
    }
  }
}
export function styleState(state: EditorState) {
  const range = state.selection.main;
  // Share one bounded parse attempt across toolbar helpers. A later complete
  // tree will refresh their caches without keeping unknown source editable.
  const tree = ensureSyntaxTree(state, state.doc.length, 100);
  return {
    alignment: (alignments(state, tree)?.find(
      (r) => r.bodyFrom <= range.from && r.bodyTo >= range.to,
    )?.value || 'left') as Alignment,
    color: range.empty
      ? coloredRegion(state, range.from, range.to, tree)?.value || null
      : selectedColor(state, range.from, range.to, tree),
    styleDisabled:
      !tree ||
      state.selection.ranges.some(
        (r) => inCode(state, r.head, tree) || inCode(state, r.anchor, tree),
      ),
  };
}
function blockAt(state: EditorState, position: number) {
  const tree = ensureSyntaxTree(state, position, 30);
  if (!tree) return;
  const line = state.doc.lineAt(position);
  let node = tree.resolveInner(position, position === line.from ? 1 : -1);
  if (node.name === 'Document') return { from: line.from, to: line.to };
  while (node.parent && node.parent.name !== 'Document') node = node.parent;
  return { from: node.from, to: node.to };
}
function alignTransaction(state: EditorState, alignment: Alignment): TransactionSpec | undefined {
  const from = Math.min(...state.selection.ranges.map((r) => r.from));
  const to = Math.max(...state.selection.ranges.map((r) => r.to));
  const regions = alignments(state);
  if (!regions) return;
  const enclosing = regions.find((r) => r.bodyFrom <= from && r.bodyTo >= to);
  const opening = `<div style="text-align:${alignment}">\n\n`;
  if (enclosing) {
    if (enclosing.value === alignment) return;
    const changes = state.changes({
      from: enclosing.from,
      to: enclosing.bodyFrom,
      insert: opening,
    });
    return { changes, selection: state.selection.map(changes) };
  }
  const first = blockAt(state, from),
    last = blockAt(state, to > from ? to - 1 : to);
  if (!first || !last) return;
  let start = first.from;
  let end = last.to;
  for (const region of regions) {
    if (region.from <= end && region.to >= start) {
      start = Math.min(start, region.from);
      end = Math.max(end, region.to);
    }
  }
  const remove = regions
    .filter((r) => r.from >= start && r.to <= end)
    .flatMap((r) => [
      { from: r.from, to: r.bodyFrom },
      { from: r.bodyTo, to: r.to },
    ])
    .sort((a, b) => a.from - b.from);
  const stripped = state.changes(remove);
  const body = stripped
    .apply(state.doc)
    .sliceString(stripped.mapPos(start, -1), stripped.mapPos(end, 1));
  const before =
    start > 0 && !state.sliceDoc(Math.max(0, start - 2), start).endsWith('\n\n')
      ? state.sliceDoc(start - 1, start) === '\n'
        ? '\n'
        : '\n\n'
      : '';
  const after =
    end < state.doc.length && !state.sliceDoc(end, end + 2).startsWith('\n\n')
      ? state.sliceDoc(end, end + 1) === '\n'
        ? '\n'
        : '\n\n'
      : '';
  const bodyStart = start + before.length + opening.length;
  const map = (pos: number) =>
    bodyStart +
    Math.max(0, Math.min(body.length, stripped.mapPos(pos, -1) - stripped.mapPos(start, -1)));
  const bodyFrom = stripped.mapPos(start, -1),
    bodyTo = stripped.mapPos(end, 1);
  const wrappers =
    bodyFrom === bodyTo
      ? [{ from: bodyFrom, insert: before + opening + '\n\n</div>' + after }]
      : [
          { from: bodyFrom, insert: before + opening },
          { from: bodyTo, insert: '\n\n</div>' + after },
        ];
  // Preserve body characters so undo/redo can map the text selection through
  // these insertions rather than through a replacement of the whole block.
  const changes = stripped.compose(ChangeSet.of(wrappers, stripped.newLength));
  return {
    changes,
    selection: EditorSelection.create(
      state.selection.ranges.map((r) => EditorSelection.range(map(r.anchor), map(r.head))),
      state.selection.mainIndex,
    ),
  };
}
interface SourceRange {
  from: number;
  to: number;
}
interface ColorAtom {
  text: string;
  source: number;
  color: string | null;
  selected?: boolean;
  placeholder?: number;
  outputFrom?: number;
  outputTo?: number;
}
const alignmentLine =
  /^\s*(?:<div[ \t]+style="text-align:[ \t]*(?:left|center|right)[ \t]*"[ \t]*>|<\/div[ \t]*>)\s*$/;
interface ColorExclusions {
  protected: SourceRange[];
  code: SourceRange[];
  tree: ReturnType<typeof syntaxTree> | null;
}
const exclusionCache = new WeakMap<object, ColorExclusions>();
function colorExclusions(
  state: EditorState,
  tree: MarkdownTree | null = ensureSyntaxTree(state, state.doc.length, 100),
) {
  // Never cache a partial tree. Protect all source until the requested parse
  // completes, then rebuild against the returned tree's identity.
  if (!tree) {
    const unknown = [{ from: 0, to: state.doc.length }];
    return { protected: unknown, code: unknown, tree: null };
  }
  const cached = exclusionCache.get(state.doc);
  if (cached?.tree === tree) return cached;
  const protectedRanges: SourceRange[] = [],
    code: SourceRange[] = [];
  tree.iterate({
    enter(node) {
      if (['InlineCode', 'FencedCode', 'CodeBlock'].includes(node.name)) {
        const range = { from: node.from, to: node.to };
        protectedRanges.push(range);
        code.push(range);
        return false;
      }
      if (
        [
          'HeaderMark',
          'QuoteMark',
          'ListMark',
          'TaskMarker',
          'TableDelimiter',
          'HorizontalRule',
          'LinkMark',
          'URL',
          'LinkTitle',
          'EmphasisMark',
          'StrikethroughMark',
          'HTMLTag',
          'LinkReference',
          'Escape',
        ].includes(node.name)
      )
        protectedRanges.push({ from: node.from, to: node.to });
    },
  });
  const merged: SourceRange[] = [];
  for (const range of protectedRanges.sort((a, b) => a.from - b.from)) {
    const previous = merged.at(-1);
    if (previous && previous.to >= range.from) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  const result = { protected: merged, code, tree };
  exclusionCache.set(state.doc, result);
  return result;
}
function contains(ranges: SourceRange[], position: number) {
  // Syntax ranges arrive in source order; nested ranges also count as protected.
  let low = 0,
    high = ranges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ranges[mid].from <= position) low = mid + 1;
    else high = mid;
  }
  return low > 0 && position < ranges[low - 1].to;
}
function colorAtoms(state: EditorState, line: { from: number; text: string }) {
  const code = colorExclusions(state).code;
  const tags = Array.from(
    line.text.matchAll(
      /<span[ \t]+style="color:[ \t]*(#[a-fA-F\d]{6})[ \t]*"[ \t]*>|<\/span[ \t]*>/g,
    ),
  ).filter(
    (match) => !contains(code, line.from + match.index!) && !escapedAt(line.text, match.index!),
  );
  const stack: number[] = [],
    paired = new Set<number>();
  tags.forEach((tag, index) => {
    if (tag[1]) stack.push(index);
    else {
      const opening = stack.pop();
      if (opening !== undefined) {
        paired.add(opening);
        paired.add(index);
      }
    }
  });
  const byStart = new Map(
    tags.flatMap((tag, index) => (paired.has(index) ? [[tag.index!, tag] as const] : [])),
  );
  const colors: string[] = [],
    atoms: ColorAtom[] = [];
  for (let index = 0; index < line.text.length; ) {
    const tag = byStart.get(index);
    if (tag) {
      if (tag[1]) colors.push(tag[1].toLowerCase());
      else colors.pop();
      index += tag[0].length;
    } else {
      atoms.push({
        text: line.text[index],
        source: line.from + index,
        color: colors.at(-1) || null,
      });
      index++;
    }
  }
  return atoms;
}
function selectedColor(state: EditorState, from: number, to: number, tree?: MarkdownTree | null) {
  const analysis = colorExclusions(state, tree);
  if (!analysis.tree) return null;
  const exclusions = analysis.protected;
  let color: string | null | undefined;
  for (
    let number = state.doc.lineAt(from).number;
    number <= state.doc.lineAt(to).number;
    number++
  ) {
    const line = state.doc.line(number);
    if (alignmentLine.test(line.text)) continue;
    for (const atom of colorAtoms(state, line)) {
      if (
        atom.source < from ||
        atom.source >= to ||
        !atom.text.trim() ||
        contains(exclusions, atom.source)
      )
        continue;
      if (color === undefined) color = atom.color;
      else if (color !== atom.color) return null;
    }
  }
  return color || null;
}
function colorTransaction(state: EditorState, color: string | null): TransactionSpec | undefined {
  const analysis = colorExclusions(state);
  if (!analysis.tree) return;
  const exclusions = analysis.protected;
  const plans = new Map<
    number,
    { targets: SourceRange[]; placeholders: { position: number; range: number }[] }
  >();
  const plan = (number: number) => {
    if (!plans.has(number)) plans.set(number, { targets: [], placeholders: [] });
    return plans.get(number)!;
  };
  state.selection.ranges.forEach((range, index) => {
    const enclosing = range.empty
      ? coloredRegion(state, range.from, range.to, analysis.tree)
      : undefined;
    if (range.empty && !enclosing) {
      const line = state.doc.lineAt(range.from);
      if (color && !contains(exclusions, range.from) && !alignmentLine.test(line.text))
        plan(line.number).placeholders.push({ position: range.from, range: index });
      return;
    }
    const from = enclosing?.bodyFrom ?? range.from,
      to = enclosing?.bodyTo ?? range.to;
    for (
      let number = state.doc.lineAt(from).number;
      number <= state.doc.lineAt(to).number;
      number++
    ) {
      const line = state.doc.line(number);
      if (Math.min(line.to, to) > Math.max(line.from, from))
        plan(number).targets.push({ from: Math.max(line.from, from), to: Math.min(line.to, to) });
    }
  });
  const edits: { from: number; to: number; insert: string }[] = [];
  const mappings = new Map<number, { atoms: ColorAtom[] }>();
  for (const [number, entry] of [...plans].sort((a, b) => a[0] - b[0])) {
    const line = state.doc.line(number);
    if (alignmentLine.test(line.text)) continue;
    const atoms = colorAtoms(state, line);
    for (const atom of atoms) {
      atom.selected =
        !contains(exclusions, atom.source) &&
        entry.targets.some((range) => range.from <= atom.source && atom.source < range.to);
      // Recreate structural marks outside spans even when old source wrapped
      // the entire Markdown expression in a color span.
      if (contains(exclusions, atom.source) && !contains(analysis.code, atom.source))
        atom.color = null;
    }
    let changed = false;
    for (let index = 0; index < atoms.length; ) {
      if (!atoms[index].selected) {
        index++;
        continue;
      }
      const start = index;
      while (index < atoms.length && atoms[index].selected) index++;
      let from = start,
        to = index;
      // Keep whitespace after Markdown markers outside newly inserted spans.
      if (color) {
        while (from < to && !atoms[from].text.trim() && !atoms[from].color) from++;
        while (to > from && !atoms[to - 1].text.trim() && !atoms[to - 1].color) to--;
      }
      for (let part = from; part < to; part++) {
        if (atoms[part].color !== color) changed = true;
        atoms[part].color = color;
      }
    }
    for (const placeholder of entry.placeholders) {
      let index = atoms.findIndex((atom) => atom.source >= placeholder.position);
      if (index < 0) index = atoms.length;
      atoms.splice(index, 0, {
        text: '文字',
        source: placeholder.position,
        color,
        placeholder: placeholder.range,
      });
      changed = true;
    }
    if (!changed) continue;
    let insert = '',
      active: string | null = null;
    for (const atom of atoms) {
      if (active !== atom.color) {
        if (active) insert += '</span>';
        if (atom.color) insert += `<span style="color:${atom.color}">`;
        active = atom.color;
      }
      atom.outputFrom = insert.length;
      insert += atom.text;
      atom.outputTo = insert.length;
    }
    if (active) insert += '</span>';
    // Keep every original non-style character in the change set. History can
    // then retain selections inside the text when markers are added or split.
    let sourcePosition = line.from,
      outputPosition = 0;
    const addGap = (to: number, outputTo: number) => {
      const gap = insert.slice(outputPosition, outputTo);
      if (state.sliceDoc(sourcePosition, to) !== gap)
        edits.push({ from: sourcePosition, to, insert: gap });
    };
    for (const atom of atoms) {
      if (atom.placeholder !== undefined) continue;
      addGap(atom.source, atom.outputFrom!);
      sourcePosition = atom.source + atom.text.length;
      outputPosition = atom.outputTo!;
    }
    addGap(line.to, insert.length);
    mappings.set(number, { atoms });
  }
  const changes = state.changes(edits);
  const map = (position: number, association: -1 | 1) => {
    const line = state.doc.lineAt(position),
      mapping = mappings.get(line.number);
    if (!mapping) return changes.mapPos(position, association);
    const atoms = mapping.atoms.filter((atom) => atom.placeholder === undefined);
    const next = atoms.find((atom) => atom.source >= position);
    let previous: ColorAtom | undefined;
    for (let index = atoms.length - 1; index >= 0; index--)
      if (atoms[index].source < position) {
        previous = atoms[index];
        break;
      }
    const offset =
      association > 0
        ? (next?.outputFrom ?? previous?.outputTo ?? 0)
        : (previous?.outputTo ?? next?.outputFrom ?? 0);
    return changes.mapPos(line.from, -1) + offset;
  };
  return {
    changes,
    selection: EditorSelection.create(
      state.selection.ranges.map((range, index) => {
        const line = state.doc.lineAt(range.from),
          mapping = mappings.get(line.number);
        const placeholder = mapping?.atoms.find((atom) => atom.placeholder === index);
        if (placeholder) {
          const start = changes.mapPos(line.from, -1);
          return EditorSelection.range(
            start + placeholder.outputFrom!,
            start + placeholder.outputTo!,
          );
        }
        if (range.empty) return EditorSelection.cursor(map(range.head, 1));
        const from = map(range.from, 1),
          to = map(range.to, -1);
        return range.anchor <= range.head
          ? EditorSelection.range(from, to)
          : EditorSelection.range(to, from);
      }),
      state.selection.mainIndex,
    ),
  };
}
export function styleTransaction(
  state: EditorState,
  action: StyleAction,
): TransactionSpec | undefined {
  if (
    state.selection.ranges.some((range) => inCode(state, range.head) || inCode(state, range.anchor))
  )
    return;
  if (action.startsWith('align'))
    return alignTransaction(state, action.slice(5).toLowerCase() as Alignment);
  if (action === 'colorDefault') return colorTransaction(state, null);
  const color = action.slice(6).toLowerCase();
  if (!/^#[a-f\d]{6}$/.test(color)) return;
  return colorTransaction(state, color);
}
