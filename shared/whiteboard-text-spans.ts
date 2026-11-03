import { parseWhiteboard } from './whiteboard.js';

/** Locate string values in valid JSON without rebuilding or searching for serialized labels. */
export function whiteboardTextSpans(source: string) {
  const scene = parseWhiteboard(source);
  const whitespace = (from: number) => {
    while (/\s/.test(source[from] ?? '') && from < source.length) from++;
    return from;
  };
  const stringEnd = (from: number) => {
    for (let i = from + 1; i < source.length; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === '"') return i + 1;
    }
    throw Error('INVALID_WHITEBOARD_STRING');
  };
  const valueEnd = (from: number) => {
    if (source[from] === '"') return stringEnd(from);
    if (source[from] === '{' || source[from] === '[') {
      let depth = 0;
      for (let i = from; i < source.length; i++) {
        if (source[i] === '"') i = stringEnd(i) - 1;
        else if (source[i] === '{' || source[i] === '[') depth++;
        else if ((source[i] === '}' || source[i] === ']') && --depth === 0) return i + 1;
      }
      throw Error('INVALID_WHITEBOARD_VALUE');
    }
    let to = from;
    while (to < source.length && !/[\s,}\]]/.test(source[to])) to++;
    return to;
  };
  const fields = (from: number) => {
    const result = new Map<string, { from: number; to: number }>();
    let cursor = whitespace(from + 1);
    while (source[cursor] !== '}') {
      const end = stringEnd(cursor),
        key = JSON.parse(source.slice(cursor, end));
      const start = whitespace(whitespace(end) + 1),
        to = valueEnd(start);
      // JSON.parse uses the last occurrence of a duplicate key, including elements/text.
      result.set(key, { from: start, to });
      cursor = whitespace(to);
      if (source[cursor] !== ',') break;
      cursor = whitespace(cursor + 1);
    }
    return result;
  };
  const elements = fields(whitespace(0)).get('elements')!;
  const spans: { from: number; to: number; text: string }[] = [];
  let cursor = whitespace(elements.from + 1),
    index = 0;
  while (source[cursor] !== ']') {
    const to = valueEnd(cursor),
      element = scene.elements[index++];
    if (
      element.type === 'text' &&
      !element.isDeleted &&
      typeof element.text === 'string' &&
      element.text
    ) {
      const value = fields(cursor).get('text')!;
      spans.push({ from: value.from + 1, to: value.to - 1, text: element.text });
    }
    cursor = whitespace(to);
    if (source[cursor] !== ',') break;
    cursor = whitespace(cursor + 1);
  }
  let char = 0,
    byte = 0,
    line = 1;
  return spans.map((span) => {
    const before = source.slice(char, span.from);
    byte += new TextEncoder().encode(before).length;
    line += (before.match(/\n/g) ?? []).length;
    const startByte = byte;
    byte += new TextEncoder().encode(source.slice(span.from, span.to)).length;
    char = span.to;
    return { ...span, startByte, endByte: byte, startLine: line, endLine: line };
  });
}

/** Chunks are original inner JSON string slices; decode only for search/model input. */
export function whiteboardChunkText(raw: string): string {
  return JSON.parse('"' + raw + '"');
}
