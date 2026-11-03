import { htmlResourceSpans } from './html-resources.js';
import MarkdownIt from 'markdown-it';
import { knowledgeMarkdown } from './knowledge-markdown.js';

export interface DestinationSpan {
  html?: true;
  media?: boolean;
  start: number;
  end: number;
  url: string;
  wiki?: { label: string; fragment: string; table: boolean };
}
/**
 * Parse destinations with Markdown's own rules, then edit only their original source spans.
 * A separate parser keeps this instrumentation out of the shared renderer. Block maps retain
 * fences/indented code as opaque tokens; inline rules keep backticks and escapes opaque too.
 */
export function markdownDestinationSpans(original: string): DestinationSpan[] {
  const parser = new MarkdownIt({ html: true, linkify: true, breaks: false }).use(
    knowledgeMarkdown,
  );
  parser.validateLink = () => true;
  const originalOffsets: number[] = [];
  let source = '';
  // Markdown normalizes newlines and NUL before parsing. Retain their original byte-for-byte
  // source positions so replacements do not normalize the user's document as a side effect.
  for (let n = 0; n < original.length; n++) {
    originalOffsets.push(n);
    const char = original[n];
    source += char === '\r' ? '\n' : char === '\0' ? '\ufffd' : char;
    if (char === '\r' && original[n + 1] === '\n') n++;
  }
  originalOffsets.push(original.length);
  const starts = [0];
  for (let n = 0; n < source.length; n++) if (source[n] === '\n') starts.push(n + 1);
  const spans: DestinationSpan[] = [];
  let active: { source: string; positions: number[]; table: boolean; rawText?: string } | undefined;

  function record(
    url: string,
    start: number,
    end: number,
    positions: number[],
    wiki?: DestinationSpan['wiki'],
    extra: Partial<DestinationSpan> = {},
  ) {
    if (active?.rawText) return;
    if (end <= start || positions[start] === undefined || positions[end - 1] === undefined) return;
    // A table removes backslashes before literal pipes. Those escapes belong to the
    // destination's physical span; stripped quote/list prefixes remain outside it.
    for (let n = start + 1; n < end; n++) {
      const previous = positions[n - 1],
        current = positions[n];
      if (
        current !== previous + 1 &&
        !(current === previous + 2 && source[current - 1] === '\\' && source[current] === '|')
      )
        return;
    }
    spans.push({
      url,
      ...extra,
      ...(wiki ? { wiki } : {}),
      start: originalOffsets[positions[start]],
      end: originalOffsets[positions[end - 1] + 1],
    });
  }
  const htmlRule = (parser.inline.ruler as any).__rules__.find(
    (r: any) => r.name === 'html_inline',
  ).fn;
  parser.inline.ruler.at('html_inline', (state: any, silent: boolean) => {
    const start = state.pos,
      context = active;
    const accepted = htmlRule(state, silent);
    if (accepted && !silent && context && state.src === context.source) {
      const tag = state.src.slice(start, state.pos);
      if (context.rawText) {
        if (new RegExp('</' + context.rawText + '\\s*>', 'i').test(tag))
          context.rawText = undefined;
        return accepted;
      }
      const raw = /^<(script|style|textarea|title)\b/i.exec(tag);
      if (raw) {
        context.rawText = raw[1].toLowerCase();
        return accepted;
      }
    }
    if (accepted && !silent && context && state.src === context.source)
      for (const span of htmlResourceSpans(
        state.src.slice(start, state.pos),
        parser.utils.unescapeAll,
      ))
        record(span.url, start + span.start, start + span.end, context.positions, undefined, {
          html: true,
          media: span.media,
        });
    return accepted;
  });
  // Instrument the same wiki rule used for reading. Its destination is encoded by that rule,
  // while its label remains plain text; retain both meanings when the target is renamed.
  const wikiRule = (parser.inline.ruler as any).__rules__.find(
    (r: any) => r.name === 'knowledge_wikilink',
  ).fn;
  parser.inline.ruler.at('knowledge_wikilink', (state: any, silent: boolean) => {
    const start = state.pos,
      tokenStart = state.tokens.length,
      context = active;
    const accepted = wikiRule(state, silent);
    if (accepted && !silent && context && state.src === context.source) {
      // A rule's first push may flush pending paragraph text before its own link tokens.
      const emitted = state.tokens.slice(tokenStart),
        link = emitted.findIndex((token: any) => token.type === 'link_open');
      const token = emitted[link],
        label = emitted[link + 1];
      const rawDestination = state.src.slice(start + 2, state.pos - 2).split('|')[0];
      const hash = rawDestination.indexOf('#');
      record(token.attrGet('href'), start, state.pos, context.positions, {
        label: label.content,
        fragment: hash < 0 ? '' : rawDestination.slice(hash),
        table: context.table,
      });
    }
    return accepted;
  });
  // Inline footnotes recursively parse a substring. Give their children the corresponding
  // source-position slice instead of losing ownership of their original physical spans.
  const inlineFootnoteRule = (parser.inline.ruler as any).__rules__.find(
    (r: any) => r.name === 'footnote_inline',
  ).fn;
  parser.inline.ruler.at('footnote_inline', (state: any, silent: boolean) => {
    const context = active,
      start = state.pos;
    if (silent || !context || state.src !== context.source || !state.src.startsWith('^[', start))
      return inlineFootnoteRule(state, silent);
    const end = parser.helpers.parseLinkLabel(state, start + 1);
    if (end < 0) return inlineFootnoteRule(state, silent);
    active = {
      source: state.src.slice(start + 2, end),
      positions: context.positions.slice(start + 2, end),
      table: context.table,
    };
    try {
      return inlineFootnoteRule(state, silent);
    } finally {
      active = context;
    }
  });
  function destination(text: string, start: number) {
    while (start < text.length && /[ \t\n]/.test(text[start])) start++;
    const parsed = parser.helpers.parseLinkDestination(text, start, text.length);
    if (!parsed.ok) return;
    const angled = text[start] === '<';
    return {
      url: parser.normalizeLink(parsed.str),
      start: start + (angled ? 1 : 0),
      end: parsed.pos - (angled ? 1 : 0),
    };
  }
  // Reference definitions are block syntax. Capture the block parser's exact logical source
  // before quote/list indentation is restored by its parent rules.
  const referenceRule = (parser.block.ruler as any).__rules__.find(
    (r: any) => r.name === 'reference',
  ).fn;
  parser.block.ruler.at(
    'reference',
    (state: any, startLine: number, endLine: number, silent: boolean) => {
      const accepted = referenceRule(state, startLine, endLine, silent);
      if (!accepted || silent) return accepted;
      let text = '';
      const positions: number[] = [];
      for (let line = startLine; line < state.line; line++) {
        const start = state.bMarks[line] + state.tShift[line],
          end = state.eMarks[line] + 1;
        for (let n = start; n < end && n < state.src.length; n++) {
          text += state.src[n];
          positions.push(n);
        }
      }
      let labelEnd = 1;
      for (; labelEnd < text.length; labelEnd++) {
        if (text[labelEnd] === '\\') {
          labelEnd++;
          continue;
        }
        if (text[labelEnd] === ']') break;
      }
      if (text[labelEnd + 1] === ':') {
        const parsed = destination(text, labelEnd + 2);
        if (parsed) record(parsed.url, parsed.start, parsed.end, positions);
      }
      return accepted;
    },
  );
  for (const name of ['link', 'image']) {
    const rule = (parser.inline.ruler as any).__rules__.find((r: any) => r.name === name).fn;
    parser.inline.ruler.at(name, (state: any, silent: boolean) => {
      const start = state.pos,
        tokenStart = state.tokens.length,
        context = active;
      let parsed: ReturnType<typeof destination>;
      if (!silent && context && state.src === context.source) {
        const bracket = start + (name === 'image' ? 1 : 0);
        const labelEnd = parser.helpers.parseLinkLabel(state, bracket, name === 'link');
        if (labelEnd >= 0 && state.src[labelEnd + 1] === '(')
          parsed = destination(state.src, labelEnd + 2);
      }
      const accepted = rule(state, silent);
      if (accepted && !silent && parsed && context && state.pos > parsed.end) {
        const token = state.tokens
          .slice(tokenStart)
          .find((t: any) => t.type === (name === 'link' ? 'link_open' : 'image'));
        if (token?.attrGet(name === 'link' ? 'href' : 'src') === parsed.url)
          record(parsed.url, parsed.start, parsed.end, context.positions);
      }
      return accepted;
    });
  }
  // Map each inline block's logical text back to its physical lines. This handles list and
  // quote prefixes without searching the rest of the document for repeated URL strings.
  function inlinePositions(text: string, range: [number, number], table: boolean, cursor: number) {
    const positions: number[] = [];
    let row = range[0],
      last = cursor;
    for (const line of text.split('\n')) {
      let found = false;
      for (; row < range[1]; row++) {
        const begin = starts[row],
          end = (starts[row + 1] ?? source.length + 1) - 1;
        let physical = '',
          offsets: number[] = [];
        for (let n = begin; n < end; n++) {
          if (table && source[n] === '\\' && source[n + 1] === '|') continue;
          physical += source[n];
          offsets.push(n);
        }
        const from = Math.max(
          0,
          offsets.findIndex((n) => n >= last),
        );
        const index = physical.indexOf(line, from);
        if (index < 0) continue;
        for (const offset of offsets.slice(index, index + line.length)) positions.push(offset);
        last = line.length ? offsets[index + line.length - 1] + 1 : begin;
        if (positions.length < text.length) {
          positions.push(end);
          last = end + 1;
        }
        row++;
        found = true;
        break;
      }
      if (!found) return;
    }
    return { positions, last };
  }
  parser.core.ruler.at('inline', (state: any) => {
    let tableRow: [number, number] | undefined,
      tableCursor = 0;
    for (const token of state.tokens) {
      if (token.type === 'tr_open') {
        tableRow = token.map;
        tableCursor = starts[token.map[0]];
      }
      if (token.type === 'tr_close') tableRow = undefined;
      if (token.type === 'html_block' && token.map) {
        const mapped = inlinePositions(
          token.content.replace(/\n$/, ''),
          token.map,
          false,
          starts[token.map[0]],
        );
        if (mapped)
          for (const span of htmlResourceSpans(token.content, parser.utils.unescapeAll))
            record(span.url, span.start, span.end, mapped.positions, undefined, {
              html: true,
              media: span.media,
            });
      }
      if (token.type !== 'inline') continue;
      const range = token.map || tableRow;
      const mapped =
        range &&
        inlinePositions(
          token.content,
          range,
          !token.map,
          token.map ? starts[range[0]] : tableCursor,
        );
      active = mapped
        ? { source: token.content, positions: mapped.positions, table: !token.map && !!tableRow }
        : undefined;
      if (!token.map && mapped) tableCursor = mapped.last;
      parser.inline.parse(token.content, parser, state.env, token.children);
      active = undefined;
    }
  });
  parser.parse(source, {});
  return [...new Map(spans.map((span) => [span.start + ':' + span.end, span])).values()];
}
