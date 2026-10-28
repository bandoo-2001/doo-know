import MarkdownIt, { type Token } from 'markdown-it';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { markdownStyles } from '../../../shared/markdown-styles';
import type { SourceUnit } from './contracts';
import { parseSource } from './source-codec';

type SourceRange = Pick<SourceUnit, 'from' | 'to' | 'raw' | 'opaque' | 'kind'>;
type SourceBlock = { from: number; text: string; positions: number[] };
type PositionedBlock = SourceBlock & { position: number };
const parser = new MarkdownIt({ html: false, linkify: true }).use(markdownStyles);
const layouts = new WeakMap<ProseMirrorNode, { raw: string; blocks: PositionedBlock[] }>();

function lineOffsets(raw: string) {
  const starts = [0];
  for (let index = 0; index < raw.length; index++) if (raw[index] === '\n') starts.push(index + 1);
  return starts;
}

// Inline parser tokens retain visible text but remove escapes, entities and marks.
// Walk their source monotonically, so repeated labels keep their own positions.
function textPositions(raw: string, text: string, from: number, literal = false) {
  const positions: number[] = [];
  let cursor = from,
    index = 0;
  while (index < text.length && cursor < raw.length) {
    const escaped =
      raw[cursor] === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(raw[cursor + 1] || '');
    if (!literal && escaped && raw[cursor + 1] === text[index]) {
      positions.push(cursor + 1);
      cursor += 2;
      index++;
      continue;
    }
    if (!literal && raw[cursor] === '&') {
      const entity = /^&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][\dA-Za-z]+);/.exec(raw.slice(cursor));
      const decoded = entity && parser.utils.unescapeAll(entity[0]);
      if (decoded && text.startsWith(decoded, index)) {
        for (let part = 0; part < decoded.length; part++) positions.push(cursor);
        cursor += entity![0].length;
        index += decoded.length;
        continue;
      }
    }
    if (raw[cursor] === text[index] || (text[index] === ' ' && /[\r\n]/.test(raw[cursor]))) {
      positions.push(cursor);
      index++;
    }
    cursor++;
  }
  while (positions.length < text.length) positions.push(Math.max(from, cursor - 1));
  return { positions, cursor };
}

function afterLink(raw: string, cursor: number) {
  const close = raw.indexOf(']', cursor);
  if (close < 0) return cursor;
  let at = close + 1;
  if (raw[at] !== '(') return at;
  let depth = 1;
  for (at++; at < raw.length && depth; at++) {
    if (raw[at] === '\\') at++;
    else if (raw[at] === '(') depth++;
    else if (raw[at] === ')') depth--;
  }
  return at;
}

function inlineBlock(
  raw: string,
  children: Token[],
  from: number,
): SourceBlock & { cursor: number } {
  let cursor = from,
    text = '';
  const positions: number[] = [];
  const append = (value: string, at = cursor, literal = false) => {
    const mapped = textPositions(raw, value, at, literal);
    text += value;
    for (const position of mapped.positions) positions.push(position);
    cursor = mapped.cursor;
  };
  for (const child of children) {
    if (child.type === 'text') append(child.content);
    else if (child.type === 'code_inline') {
      const start = raw.indexOf(child.markup, cursor);
      const end = start < 0 ? -1 : raw.indexOf(child.markup, start + child.markup.length);
      append(child.content, start < 0 ? cursor : start + child.markup.length, true);
      if (end >= 0) cursor = end + child.markup.length;
    } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
      const newline = raw.indexOf('\n', cursor);
      text += '\n';
      positions.push(newline >= 0 ? newline : cursor);
      if (newline >= 0) cursor = newline + 1;
    } else if (child.type === 'image') {
      const start = raw.indexOf('![', cursor);
      text += '\uFFFC';
      positions.push(start >= 0 ? start : cursor);
      cursor = afterLink(raw, start >= 0 ? start + 2 : cursor);
    } else if (child.type === 'link_close' && child.markup !== 'linkify') {
      if (child.markup === 'autolink') {
        const end = raw.indexOf('>', cursor);
        if (end >= 0) cursor = end + 1;
      } else cursor = afterLink(raw, cursor);
    } else if (child.type === 'span_open' || child.type === 'span_close') {
      const end = raw.indexOf('>', cursor);
      if (end >= 0) cursor = end + 1;
    } else if (child.markup && child.nesting) {
      const marker = raw.indexOf(child.markup, cursor);
      if (marker >= 0) cursor = marker + child.markup.length;
    }
  }
  return { from, text, positions, cursor };
}

function sourceBlocks(raw: string) {
  const starts = lineOffsets(raw);
  const blocks: SourceBlock[] = [];
  let rowCursor = 0;
  for (const token of parser.parse(raw, {})) {
    if (token.type === 'tr_open' && token.map) rowCursor = starts[token.map[0]] ?? raw.length;
    if (token.type === 'inline') {
      const from = token.map ? (starts[token.map[0]] ?? raw.length) : rowCursor;
      const block = inlineBlock(raw, token.children || [], from);
      blocks.push(block);
      rowCursor = block.cursor;
    } else if ((token.type === 'fence' || token.type === 'code_block') && token.map) {
      const from = starts[token.map[0]] ?? raw.length;
      const contentStart = starts[token.map[0] + (token.type === 'fence' ? 1 : 0)] ?? raw.length;
      const content = token.content.replace(/\n$/, '');
      blocks.push({
        from,
        text: content,
        positions: textPositions(raw, content, contentStart, true).positions,
      });
    }
  }
  return blocks;
}

function positionedBlocks(node: ProseMirrorNode, raw: string): PositionedBlock[] {
  const cached = layouts.get(node);
  if (cached?.raw === raw) return cached.blocks;
  const textblocks: { node: ProseMirrorNode; position: number }[] = [];
  if (node.isTextblock) textblocks.push({ node, position: 1 });
  else
    node.descendants((child, position) => {
      if (!child.isTextblock) return;
      // Descendant positions are relative to this top-level node's content.
      textblocks.push({ node: child, position: position + 2 });
      return false;
    });
  const parsed = sourceBlocks(raw);
  const blocks = textblocks.map((block, index) => {
    const source = parsed[index] || { from: raw.length, text: '', positions: [] };
    const text = block.node.textBetween(0, block.node.content.size, '\n', '\uFFFC');
    // Task-list checkboxes are parsed as inline source text, but are node attrs in PM.
    const same = source.text.indexOf(text);
    const positions =
      same >= 0
        ? source.positions.slice(same, same + text.length)
        : (() => {
            let cursor = 0;
            return Array.from({ length: text.length }, (_, character) => {
              const found = source.text.indexOf(text[character], cursor);
              if (found >= 0) cursor = found + 1;
              return source.positions[Math.max(0, cursor - 1)] ?? source.from;
            });
          })();
    return { from: source.from, text, positions, position: block.position };
  });
  layouts.set(node, { raw, blocks });
  return blocks;
}

/** Map serialized source into the current rich document without relying on DOM focus. */
export function sourceOffsetPosition(
  doc: ProseMirrorNode,
  markdown: string,
  offset: number,
  sourceRange?: (sourceId: string) => SourceRange | undefined,
): number {
  const target = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, markdown.length));
  let selected: { node: ProseMirrorNode; position: number; range: SourceRange } | undefined;
  if (sourceRange)
    doc.forEach((node, position) => {
      const range = sourceRange(String(node.attrs.sourceId || ''));
      if (
        range &&
        target >= range.from &&
        (target < range.to || (target === markdown.length && target === range.to))
      )
        selected = { node, position, range };
    });
  if (!selected) {
    const source = parseSource(markdown);
    let index = source.units.findIndex((unit) => target >= unit.from && target < unit.to);
    if (index < 0) index = Math.max(0, source.units.length - 1);
    let position = 0;
    for (let child = 0; child < Math.min(index, doc.childCount - 1); child++)
      position += doc.child(child).nodeSize;
    const node = doc.maybeChild(Math.min(index, doc.childCount - 1));
    const range = source.units[index];
    if (!node || !range) return Math.min(doc.content.size, 1);
    selected = { node, position, range };
  }
  const { node, position, range } = selected;
  if (range.opaque || node.isAtom) return position;
  const blocks = positionedBlocks(node, range.raw);
  const local = target - range.from;
  const block = blocks.filter((block) => block.from <= local).at(-1) || blocks[0];
  if (!block) return position;
  const character = block.positions.findIndex((source) => source >= local);
  return Math.min(
    doc.content.size,
    position + block.position + (character >= 0 ? character : block.text.length),
  );
}
