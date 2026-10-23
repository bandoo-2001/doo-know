import {isDocument,isWhiteboard,MAX_WHITEBOARD_BYTES,parseWhiteboard} from '../../../shared/whiteboard.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, posix, extname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ImportRequest, ImportPreview } from '../../../shared/transfer-contracts.js';
import { safePath, validName, validateRelative } from '../../../packages/core/files.js';
import { HttpError } from '../../../packages/core/errors.js';
import { localReference, references } from '../../../packages/core/render.js';
import MarkdownIt from 'markdown-it';

export const IMPORT_BODY_LIMIT = 30 * 1024 ** 2;
const mimeTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function relativeInput(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2000 ||
    value.includes('%') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((p) => !validName(p))
  )
    throw new HttpError(400, '相对路径不允许');
  return value;
}
export function assetMime(path: string, bytes: Buffer) {
  const type = mimeTypes[extname(path).toLowerCase()];
  const actual = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())
        ? 'image/gif'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
          ? 'image/webp'
          : bytes.subarray(0, 5).toString() === '%PDF-'
            ? 'application/pdf'
            : undefined;
  if (!type || actual !== type) throw new HttpError(400, '附件只允许真实 PNG/JPEG/GIF/WebP/PDF');
  return type;
}
/** Check existing ancestors even when several descendants do not exist yet. */
export function targetPath(root: string, relative: string, kind: 'note' | 'asset' | 'folder') {
  validateRelative(relative, kind);
  const base = realpathSync(root);
  let current = base;
  const parts = relative.split('/');
  for (let n = 0; n < parts.length; n++) {
    current = join(current, parts[n]);
    try {
      const info = lstatSync(current);
      if (
        info.isSymbolicLink() ||
        (info.nlink > 1 && !info.isDirectory()) ||
        (n < parts.length - 1 && !info.isDirectory()) ||
        (n === parts.length - 1 &&
          (kind === 'folder' ? !info.isDirectory() : kind === 'note' ? !info.isFile() : false))
      )
        throw new HttpError(400, '路径包含链接或无效目录');
    } catch (e) {
      if ((e as any).code === 'ENOENT') break;
      throw e;
    }
  }
  return join(base, relative);
}
export function parseImport(input: unknown): ImportRequest {
  const b = input as ImportRequest;
  if (
    !b ||
    !Array.isArray(b.entries) ||
    !b.entries.length ||
    b.entries.length > 200 ||
    !['skip', 'rename'].includes(b.collision)
  )
    throw new HttpError(400, '请选择 1–200 个文件和冲突策略');
  const folder = b.folderPath === undefined ? '00-Inbox' : b.folderPath;
  if (folder !== '') {
    relativeInput(folder);
    validateRelative(folder, 'folder');
  }
  const seen = new Set<string>();
  let total = 0;
  const entries = b.entries.map((entry) => {
    if (!entry || typeof entry.content !== 'string' || !['utf8', 'base64'].includes(entry.encoding))
      throw new HttpError(400, '文件格式不正确');
    const path = relativeInput(entry.path);
    if (seen.has(path)) throw new HttpError(400, '文件路径重复');
    seen.add(path);
    const bytes = entryBytes(entry);
    const note = isDocument(path);
    if (bytes.length > (note ? (isWhiteboard(path) ? MAX_WHITEBOARD_BYTES : 1024 ** 2) : 10 * 1024 ** 2))
      throw new HttpError(413, '单个文件超过导入上限');
    if (note) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new HttpError(400, 'Markdown 必须是 UTF-8');
      }
    if (isWhiteboard(path)) { try { parseWhiteboard(bytes.toString('utf8')); } catch(e) { throw new HttpError(400, (e as Error).message); } }
    } else assetMime(path, bytes);
    total += bytes.length;
    if (total > 20 * 1024 ** 2) throw new HttpError(413, '导入总量不能超过 20 MiB');
    validateRelative(posix.join(folder, path), note ? 'note' : 'asset');
    return { path, encoding: entry.encoding, content: entry.content };
  });
  return { entries, folderPath: folder, collision: b.collision, requestId: b.requestId };
}
export function entryBytes(entry: ImportRequest['entries'][number]) {
  if (
    entry.encoding === 'base64' &&
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.content)
  )
    throw new HttpError(400, 'Base64 编码不正确');
  return Buffer.from(entry.content, entry.encoding === 'base64' ? 'base64' : 'utf8');
}
export function importPreview(root: string, b: ImportRequest): ImportPreview {
  const reserved = new Set<string>();
  let totalBytes = 0;
  const items = b.entries.map((entry) => {
    const kind = isDocument(entry.path) ? ('note' as const) : ('asset' as const);
    let path = posix.join(b.folderPath || '', entry.path);
    targetPath(root, path, kind);
    const collision = existsSync(join(root, path)) || reserved.has(path);
    if (collision && b.collision === 'rename') {
      const ext = extname(path),
        parent = posix.dirname(path),
        stem = Array.from(posix.basename(path).slice(0, -ext.length));
      let count = 2;
      do {
        const suffix = ` (${count++})${ext}`,
          name = [...stem];
        while (Buffer.byteLength(name.join('') + suffix) > 180) name.pop();
        path = posix.join(parent, name.join('') + suffix);
        if (count > 10000) throw new HttpError(409, '同名文件过多');
        targetPath(root, path, kind);
      } while (existsSync(join(root, path)) || reserved.has(path));
    }
    reserved.add(path);
    const bytes = entryBytes(entry).length;
    totalBytes += bytes;
    return {
      path: entry.path,
      targetPath: path,
      kind,
      bytes,
      decision: collision
        ? b.collision === 'skip'
          ? ('skip' as const)
          : ('rename' as const)
        : ('create' as const),
    };
  });
  const mapped = new Set(items.map((i) => i.path)),
    warnings: string[] = [];
  for (const entry of b.entries.filter((e) => e.path.toLowerCase().endsWith('.md')))
    for (const source of references(entryBytes(entry).toString('utf8'))) {
      const local = localReference(entry.path, source);
      if (local && !mapped.has(local)) warnings.push(`${entry.path}: 未随批次提供引用 ${local}`);
    }
  return { items, totalBytes, warnings: [...new Set(warnings)].slice(0, 100) };
}
interface DestinationSpan {
  start: number;
  end: number;
  url: string;
}
/**
 * Parse destinations with Markdown's own rules, then edit only their original source spans.
 * A separate parser keeps this instrumentation out of the shared renderer. Block maps retain
 * fences/indented code as opaque tokens; inline rules keep backticks and escapes opaque too.
 */
function markdownDestinationSpans(original: string): DestinationSpan[] {
  const parser = new MarkdownIt({ html: false, linkify: true, breaks: false });
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
  let active: { source: string; positions: number[] } | undefined;

  function record(url: string, start: number, end: number, positions: number[]) {
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
      start: originalOffsets[positions[start]],
      end: originalOffsets[positions[end - 1] + 1],
    });
  }
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
      active = mapped ? { source: token.content, positions: mapped.positions } : undefined;
      if (!token.map && mapped) tableCursor = mapped.last;
      parser.inline.parse(token.content, parser, state.env, token.children);
      active = undefined;
    }
  });
  parser.parse(source, {});
  return [...new Map(spans.map((span) => [span.start + ':' + span.end, span])).values()];
}

/** Rewrite only parsed link/image and reference-definition destination source spans. */
export function rewriteImportReferences(
  content: string,
  sourcePath: string,
  target: string,
  mapping: Map<string, string>,
) {
  const destinationFor = (url: string) => {
    const path = localReference(sourcePath, url),
      resolved = path && mapping.get(path);
    if (!resolved) return;
    const suffix = url.match(/[?#].*$/)?.[0] || '';
    return (
      posix.relative(posix.dirname(target), resolved).split('/').map(encodeURIComponent).join('/') +
      suffix
    );
  };
  if (
    !references(content).some((url) => {
      const next = destinationFor(url);
      return next !== undefined && next !== url;
    })
  )
    return content;
  const replacements = markdownDestinationSpans(content)
    .flatMap((span) => {
      const replacement = destinationFor(span.url);
      if (replacement === undefined || replacement === span.url) return [];
      return [{ ...span, replacement }];
    })
    .sort((a, b) => b.start - a.start);
  for (const span of replacements)
    content = content.slice(0, span.start) + span.replacement + content.slice(span.end);
  return content;
}
