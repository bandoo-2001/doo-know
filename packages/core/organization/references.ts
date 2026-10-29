import { posix } from 'node:path';
import { markdown } from '../render.js';
import { frontmatterRange } from '../../../shared/frontmatter-range.js';
import { fail } from '../knowledge/errors.js';

type Move = { from: string; to: string };
type Edit = { start: number; end: number; text: string };
const escaped = (source: string, at: number) => {
  let count = 0;
  for (let i = at - 1; i >= 0 && source[i] === '\\'; i--) count++;
  return count % 2 === 1;
};
const encodePath = (path: string) =>
  path
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join('/');
function unescapeUrl(source: string) {
  let value = '',
    at = 0;
  const offsets: number[] = [];
  for (const match of source.matchAll(
    /\\[^\p{L}\p{N}\s]|&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/gu,
  )) {
    const start = match.index!;
    for (; at < start; at++) {
      offsets.push(at);
      value += source[at];
    }
    const decoded = markdown.utils.unescapeAll(match[0]);
    for (let i = 0; i < decoded.length; i++) {
      offsets.push(start);
      value += decoded[i];
    }
    at = start + match[0].length;
  }
  for (; at < source.length; at++) {
    offsets.push(at);
    value += source[at];
  }
  return { value, offsets };
}

/** Rewrites syntax destinations only. Offsets index the original JS string, never a rendered document. */
export function rewriteLibraryReferences(
  content: string,
  sourcePath: string,
  targetPath: string,
  moves: Move[],
  whiteboard = false,
): { content: string; changed: boolean } {
  const ordered = [...moves].sort((a, b) => b.from.length - a.from.length);
  const edits: Edit[] = [];
  const rewrite = (url: string, wiki = false) => {
    if (!url || url.startsWith('#') || url.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(url))
      return url;
    const parsed = wiki || whiteboard ? { value: url, offsets: undefined } : unescapeUrl(url);
    const suffixAt = parsed.value.search(/[?#]/),
      suffix = suffixAt < 0 ? '' : url.slice(parsed.offsets?.[suffixAt] ?? suffixAt),
      rawPath = suffixAt < 0 ? parsed.value : parsed.value.slice(0, suffixAt);
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      if (sourcePath !== targetPath || ordered.length) fail(409, 'UNSUPPORTED_REFERENCE');
      return url;
    }
    if (!decoded || decoded.includes('\\') || /[\u0000-\u001f]/.test(decoded)) {
      if (sourcePath !== targetPath) fail(409, 'UNSUPPORTED_REFERENCE');
      return url;
    }
    const omittedExtension = wiki && !/\.[a-z\d]+$/i.test(decoded);
    if (omittedExtension) decoded += '.md';
    const old = posix.normalize(posix.join(posix.dirname(sourcePath), decoded));
    if (old === '..' || old.startsWith('../')) {
      if (sourcePath !== targetPath) fail(409, 'UNSUPPORTED_REFERENCE');
      return url;
    }
    const mapping = ordered.find((move) => old === move.from || old.startsWith(move.from + '/'));
    const next = mapping ? mapping.to + old.slice(mapping.from.length) : old;
    let relative = posix.relative(posix.dirname(targetPath), next);
    if (next === old && posix.dirname(sourcePath) === posix.dirname(targetPath)) return url;
    if (!relative) fail(409, 'UNSUPPORTED_REFERENCE');
    if (omittedExtension && relative.endsWith('.md')) relative = relative.slice(0, -3);
    return (wiki ? relative : encodePath(relative)) + suffix;
  };

  if (whiteboard) {
    try {
      JSON.parse(content);
    } catch {
      fail(409, 'UNSUPPORTED_REFERENCE');
    }
    let at = 0;
    const whitespace = () => {
      while (/\s/.test(content[at] || '') && at < content.length) at++;
    };
    const string = () => {
      const start = at++;
      while (at < content.length) {
        if (content[at] === '\\') {
          at += 2;
          continue;
        }
        if (content[at++] === '"')
          return { start, end: at, value: JSON.parse(content.slice(start, at)) as string };
      }
      return fail(409, 'UNSUPPORTED_REFERENCE');
    };
    const value = (path: (string | number)[]) => {
      whitespace();
      if (content[at] === '"') {
        const token = string();
        if (
          path.length === 3 &&
          path[0] === 'elements' &&
          typeof path[1] === 'number' &&
          path[2] === 'link'
        ) {
          const next = rewrite(token.value);
          if (next !== token.value)
            edits.push({ start: token.start, end: token.end, text: JSON.stringify(next) });
        }
      } else if (content[at] === '{') {
        at++;
        whitespace();
        while (content[at] !== '}') {
          const key = string().value;
          whitespace();
          at++;
          value([...path, key]);
          whitespace();
          if (content[at] !== ',') break;
          at++;
          whitespace();
        }
        at++;
      } else if (content[at] === '[') {
        at++;
        whitespace();
        let index = 0;
        while (content[at] !== ']') {
          value([...path, index++]);
          whitespace();
          if (content[at] !== ',') break;
          at++;
          whitespace();
        }
        at++;
      } else {
        while (at < content.length && !/[\s,\]}]/.test(content[at])) at++;
      }
    };
    value([]);
  } else {
    const excluded = new Uint8Array(content.length);
    const mark = (start: number, end: number) => excluded.fill(1, start, end);
    const front = frontmatterRange(content);
    if (front) mark(0, front.end);
    const lineStarts = [0];
    for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
    const source = content
      .split('')
      .map((c, i) => (excluded[i] && c !== '\n' && c !== '\r' ? ' ' : c))
      .join('');
    const env: { references?: Record<string, { href: string; title: string }> } = {};
    const tokens = markdown.parse(source, env);
    const urls = new Set<string>();
    const visit = (list: typeof tokens) => {
      for (const token of list) {
        if (
          ['fence', 'code_block', 'math_block', 'math_block_eqno'].includes(token.type) &&
          token.map
        )
          mark(lineStarts[token.map[0]] || 0, lineStarts[token.map[1]] ?? content.length);
        if (token.type === 'link_open') urls.add(String(token.attrGet('href') || ''));
        if (token.type === 'image') urls.add(String(token.attrGet('src') || ''));
        if (token.children) visit(token.children);
      }
    };
    visit(tokens);
    // Exclude inline code and math before parsing any destination, including reference definitions.
    for (let i = 0; i < content.length; i++) {
      if (excluded[i] || escaped(content, i)) continue;
      if (content[i] === '`') {
        let end = i + 1;
        while (content[end] === '`') end++;
        const delimiter = content.slice(i, end);
        let close = content.indexOf(delimiter, end);
        while (
          close >= 0 &&
          (content[close - 1] === '`' || content[close + delimiter.length] === '`')
        )
          close = content.indexOf(delimiter, close + delimiter.length);
        if (close >= 0) {
          mark(i, close + delimiter.length);
          i = close + delimiter.length - 1;
        }
      } else if (
        content[i] === '$' &&
        content[i + 1] !== '$' &&
        !/\s/.test(content[i + 1] || ' ')
      ) {
        let close = i + 1;
        while (
          close < content.length &&
          content[close] !== '\n' &&
          (content[close] !== '$' || escaped(content, close))
        )
          close++;
        if (content[close] === '$' && !/\s/.test(content[close - 1])) {
          mark(i, close + 1);
          i = close;
        }
      }
    }
    const canonical = (url: string) => markdown.normalizeLink(markdown.utils.unescapeAll(url));
    const covered = new Set<string>();
    const add = (start: number, end: number, wiki = false, force = false) => {
      const raw = content.slice(start, end);
      let normalized = canonical(raw);
      if (wiki) {
        const [path, ...fragment] = raw.split('#');
        const target =
          (path && !/\.[a-z\d]+$/i.test(path) ? path + '.md' : path)
            .split('/')
            .map(encodeURIComponent)
            .join('/') + (fragment.length ? '#' + encodeURIComponent(fragment.join('#')) : '');
        normalized = markdown.normalizeLink(target);
      }
      if (!force && !urls.has(normalized)) return;
      covered.add(normalized);
      const next = rewrite(raw, wiki);
      if (next !== raw) edits.push({ start, end, text: next });
    };
    // Definitions use the same destination parser as rendering. Duplicate definitions are not rewritten.
    const definition = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\r?\n[ \t]*)?/gm;
    for (const match of content.matchAll(definition)) {
      const start = match.index! + match[0].length;
      if (excluded[match.index!]) continue;
      const label = markdown.utils.normalizeReference(match[1]);
      const reference = env.references?.[label];
      if (!reference) continue;
      const destination = markdown.helpers.parseLinkDestination(content, start, content.length);
      if (destination.ok && canonical(destination.str) === reference.href) {
        const angle = content[start] === '<';
        add(start + Number(angle), destination.pos - Number(angle), false, true);
      }
    }
    const closeLabel = (start: number) => {
      let depth = 1;
      for (let i = start + 1; i < content.length; i++) {
        if (excluded[i] || escaped(content, i)) continue;
        if (content[i] === '[') depth++;
        if (content[i] === ']' && --depth === 0) return i;
      }
      return -1;
    };
    for (let i = 0; i < content.length; i++) {
      if (content[i] !== '[' || excluded[i] || escaped(content, i)) continue;
      if (content[i + 1] === '[') {
        const end = content.indexOf(']]', i + 2);
        if (end >= 0 && !/[\r\n]/.test(content.slice(i, end))) {
          const separator = content.indexOf('|', i + 2),
            stop = separator >= 0 && separator < end ? separator : end;
          add(i + 2, stop, true);
          i = end + 1;
          continue;
        }
      }
      const labelEnd = closeLabel(i);
      if (labelEnd < 0 || content[labelEnd + 1] !== '(') continue;
      let start = labelEnd + 2;
      while (/\s/.test(content[start] || '') && start < content.length) start++;
      const destination = markdown.helpers.parseLinkDestination(content, start, content.length);
      if (!destination.ok) continue;
      let end = destination.pos;
      while (/\s/.test(content[end] || '') && end < content.length) end++;
      if (content[end] !== ')') {
        const title = markdown.helpers.parseLinkTitle(content, end, content.length);
        if (!title.ok) continue;
        end = title.pos;
        while (/\s/.test(content[end] || '') && end < content.length) end++;
      }
      if (content[end] !== ')') continue;
      const angle = content[start] === '<';
      add(start + Number(angle), destination.pos - Number(angle));
      // A link may contain an image in its label; scan that label separately via its own iteration.
      mark(labelEnd + 1, end + 1);
    }
    for (const url of urls) {
      if (covered.has(url)) continue;
      if (rewrite(url) !== url) fail(409, 'UNSUPPORTED_REFERENCE');
    }
  }
  let output = content;
  let nextStart = content.length;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > nextStart) fail(409, 'UNSUPPORTED_REFERENCE');
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    nextStart = edit.start;
  }
  return { content: output, changed: output !== content };
}
