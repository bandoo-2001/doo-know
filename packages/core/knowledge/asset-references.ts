import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import { localReference } from '../render.js';
import { markdownStyles } from '../../../shared/markdown-styles.js';
import { markdownTasks } from '../../../shared/markdown-tasks.js';
import { knowledgeMarkdown } from '../../../shared/knowledge-markdown.js';
import { diagramFences } from '../../../shared/diagram-fences.js';
import { readBlocks, stableStat, sameFile } from './file-reader.js';
import { fail } from './errors.js';
import { limits } from './limits.js';

const paragraphBudget = 32768;
// Match the reading parser, with a private rule wrapper that records actual
// footnote boundaries without mutating the renderer's shared parser.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false })
  .use(markdownStyles).use(markdownTasks).use(knowledgeMarkdown).use(diagramFences);
type Tokens = ReturnType<typeof markdown.parse>;
type FootnoteRange = { label: string; from: number; to: number };
const footnoteDefinition = (markdown.block.ruler as any).__rules__
  .find((rule: any) => rule.name === 'footnote_def').fn;
markdown.block.ruler.at('footnote_def', (state: any, start: number, end: number, silent: boolean) => {
  const tokenStart = state.tokens.length;
  const accepted = footnoteDefinition(state, start, end, silent);
  if (accepted && !silent) {
    const label = state.tokens[tokenStart]?.meta?.label;
    if (typeof label !== 'string') fail(413, 'ASSET_REFERENCE_TOO_COMPLEX');
    state.env.sourceFootnotes.push({ label, from: start, to: state.line });
  }
  return accepted;
}, { alt: ['paragraph', 'reference'] });

function mathLineEnd(text: string) {
  let end = text.length;
  while (end && markdown.utils.isWhiteSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(0, end);
}

/** A bounded parser unit is always a complete paragraph, never a guessed long-line window.
 * Footnote continuations stay in the same bounded unit. Display math is opaque
 * across blank lines, like fences. Container math/fences are refused when their
 * CommonMark state cannot be established within a unit. A prior closed proof is safe.
 */
async function scan(file: string, block: (text: string) => void, proven: () => boolean) {
  const hash = createHash('sha256'),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    line = '',
    paragraph = '',
    paragraphBytes = 0,
    previousCR = false,
    footnote = false,
    footnoteBlank = false,
    math = false,
    mathEnd = '',
    mathRawEnd = '';
  let fence: { marker: string; length: number } | undefined,
    discardedNonWhitespace = false;
  const flush = () => {
    const text = paragraph;
    paragraph = '';
    paragraphBytes = 0;
    footnote = footnoteBlank = false;
    if (text && !proven()) block(text);
  };
  const append = (current: string) => {
    const size = Buffer.byteLength(current) + 1;
    if (paragraphBytes + size > paragraphBudget) fail(413, 'ASSET_REFERENCE_TOO_COMPLEX');
    paragraph += current + '\n';
    paragraphBytes += size;
  };
  const completeLine = () => {
    const current = line;
    line = '';
    if (math) {
      if (mathEnd === '$$') math = false;
      mathEnd = mathRawEnd = '';
      return;
    }
    if (fence) {
      const close = current.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (
        !discardedNonWhitespace &&
        close &&
        close[1][0] === fence.marker &&
        close[1].length >= fence.length
      )
        fence = undefined;
      discardedNonWhitespace = false;
      return;
    }
    if (footnote && footnoteBlank && current.trim() && !/^(?: {4}|\t)/.test(current)) {
      flush();
      if (proven()) return;
    }
    if (
      /^[ \t]+(?:`{3,}|~{3,})/.test(current) ||
      /^(?: {0,3}>[ \t]?)+.*(?:`{3,}|~{3,})/.test(current) ||
      /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+(?:`{3,}|~{3,})/.test(current) ||
      /^(?: {0,3}>[ \t]?)+.*(?:\$\$|\[\^[^\] ]+\]:)/.test(current) ||
      /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+(?:\$\$|\[\^[^\] ]+\]:)/.test(current)
    )
      fail(413, 'ASSET_REFERENCE_TOO_COMPLEX');
    const open = current.match(/^(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      if (open[1].length > 128) fail(413, 'ASSET_REFERENCE_TOO_COMPLEX');
      flush();
      if (!proven()) fence = { marker: open[1][0], length: open[1].length };
      return;
    }
    if (/^ {0,3}\$\$/.test(current)) {
      // Ask the actual rule whether this is a block opener; inline dollar
      // pairs followed by more text must retain their ordinary link semantics.
      const tokens = markdown.parse(current + '\n', { sourceFootnotes: [] });
      if (tokens[0]?.type === 'math_block') {
        if (footnote) fail(413, 'ASSET_REFERENCE_TOO_COMPLEX');
        flush();
        if (!proven()) math = mathLineEnd(current).trimStart().length < 4 || !mathLineEnd(current).endsWith('$$');
        return;
      }
    }
    if (/^ {0,3}\[\^[^\] ]+\]:/.test(current)) footnote = true;
    if (!current.trim()) {
      if (footnote) {
        append(current);
        footnoteBlank = true;
      } else flush();
      return;
    }
    footnoteBlank = false;
    append(current);
  };
  const piece = (text: string) => {
    if (math) {
      const ending = mathLineEnd(text);
      if (ending) mathEnd = (mathRawEnd + ending).slice(-2);
      mathRawEnd = (mathRawEnd + text).slice(-2);
    } else if (fence) {
      const keep = Math.max(0, 256 - line.length);
      line += text.slice(0, keep);
      if (/[^ \t]/.test(text.slice(keep))) discardedNonWhitespace = true;
    } else {
      if (Buffer.byteLength(line) + Buffer.byteLength(text) > paragraphBudget)
        fail(413, 'ASSET_REFERENCE_TOO_COMPLEX');
      line += text;
    }
  };
  const consume = (decoded: string) => {
    if (proven()) return;
    if (previousCR && decoded.startsWith('\n')) decoded = decoded.slice(1);
    previousCR = decoded.endsWith('\r');
    const text = decoded.replace(/\r\n?/g, '\n');
    let start = 0,
      end: number;
    while (!proven() && (end = text.indexOf('\n', start)) !== -1) {
      piece(text.slice(start, end));
      completeLine();
      start = end + 1;
    }
    if (!proven()) piece(text.slice(start));
  };
  for await (const data of readBlocks(file)) {
    bytes += data.length;
    if (bytes > limits.file) fail(413, 'FILE_TOO_LARGE');
    hash.update(data);
    let decoded: string;
    try {
      decoded = decoder.decode(data, { stream: true });
    } catch {
      return fail(400, 'INVALID_UTF8');
    }
    consume(decoded);
  }
  let tail: string;
  try {
    tail = decoder.decode();
  } catch {
    return fail(400, 'INVALID_UTF8');
  }
  consume(tail);
  if (!proven()) {
    if (line) completeLine();
    flush();
  }
  return hash.digest('hex');
}

/** Proves a reference in this current source version. Never caches another note's proof.
 * Full file: <=20MiB, I/O:64KiB, paragraph:32KiB, SQLite page cache:1MiB.
 * Future syntax cannot change an already closed inline/previously resolved reference;
 * after that proof, later complex body syntax is skipped while UTF-8/hash checks continue.
 */
export async function hasSavedAssetReference(
  file: string,
  notePath: string,
  assetPath: string,
): Promise<boolean> {
  const before = await stableStat(file),
    root = await mkdtemp(join(tmpdir(), 'dooknow-asset-references-'));
  let db: Database.Database | undefined;
  try {
    const path = join(root, 'definitions.sqlite');
    db = new Database(path);
    await chmod(path, 0o600);
    db.pragma('journal_mode = OFF');
    db.pragma('cache_size = -1024');
    db.pragma('temp_store = FILE');
    db.exec(
      `CREATE TABLE definitions(label TEXT PRIMARY KEY,href TEXT NOT NULL,title TEXT NOT NULL);
       CREATE TABLE footnotes(label TEXT PRIMARY KEY,source TEXT NOT NULL,pending INTEGER NOT NULL DEFAULT 0,visited INTEGER NOT NULL DEFAULT 0);
       CREATE INDEX pending_footnotes ON footnotes(pending,visited)`,
    );
    const lookup = db.prepare('SELECT href,title FROM definitions WHERE label=?'),
      insert = db.prepare('INSERT OR IGNORE INTO definitions VALUES(?,?,?)'),
      footnoteLookup = db.prepare('SELECT source FROM footnotes WHERE label=?'),
      footnoteInsert = db.prepare('INSERT OR REPLACE INTO footnotes(label,source) VALUES(?,?)'),
      needFootnote = db.prepare('UPDATE footnotes SET pending=1 WHERE label=?'),
      nextFootnote = db.prepare('SELECT label,source FROM footnotes WHERE pending=1 AND visited=0 LIMIT 1'),
      visitedFootnote = db.prepare('UPDATE footnotes SET visited=1 WHERE label=?');
    let found = false, collecting = true;
    const referenceTable = new Proxy(Object.create(null), {
      get: (_target, key) => (typeof key === 'string' ? lookup.get(key) : undefined),
      set: (_target, key, value) => {
        if (typeof key === 'string' && value?.href)
          insert.run(key, String(value.href), String(value.title || ''));
        return true;
      },
    });
    const matching = (url: string) => localReference(notePath, url) === assetPath;
    const visit = (tokens: Tokens, activeFootnote?: string): boolean => {
      let skippedFootnote = false;
      for (const token of tokens) {
        if (token.type === 'footnote_open' && token.meta?.label) {
          const label = String(token.meta.label);
          if (!collecting) needFootnote.run(label);
          skippedFootnote = collecting || label !== activeFootnote;
          continue;
        }
        if (token.type === 'footnote_close') { skippedFootnote = false; continue; }
        if (skippedFootnote) continue;
        if (!collecting && token.type === 'footnote_ref' && token.meta?.label)
          needFootnote.run(String(token.meta.label));
        if (
          (token.type === 'image' && matching(String(token.attrGet('src') || ''))) ||
          (token.type === 'link_open' && matching(String(token.attrGet('href') || '')))
        )
          return true;
        if (token.children && visit(token.children, activeFootnote)) return true;
      }
      return false;
    };
    const parse = (text: string, activeFootnote?: string) => {
      if (!text.includes('[')) return;
      const sourceFootnotes: FootnoteRange[] = [];
      const ids = new Map<string, number>();
      const refs = new Proxy(Object.create(null), {
        get: (_target, key) => typeof key === 'string' && (ids.has(key)
          ? ids.get(key) : footnoteLookup.get(key.slice(1)) ? -1 : undefined),
        set: (_target, key, value) => { if (typeof key === 'string') ids.set(key, value); return true; },
      });
      const tokens = markdown.parse(text, { references: referenceTable, footnotes: { refs }, sourceFootnotes });
      if (collecting && sourceFootnotes.length) {
        const lines = text.split('\n');
        // Last definition wins, matching markdown-it-footnote. Only resolve
        // these references after the complete first scan has fixed that choice.
        for (const range of sourceFootnotes) {
          const source = lines.slice(range.from, range.to).join('\n');
          if (!/^ {0,3}\[\^/.test(source)) fail(413, 'ASSET_REFERENCE_TOO_COMPLEX');
          footnoteInsert.run(range.label, source);
        }
      }
      found = visit(tokens, activeFootnote);
    };
    const firstHash = await scan(file, parse, () => found);
    if (!sameFile(before, await stableStat(file))) fail(409, 'SOURCE_CHANGED');
    collecting = false;
    const secondHash = await scan(file, parse, () => found);
    if (!sameFile(before, await stableStat(file)) || firstHash !== secondHash)
      fail(409, 'SOURCE_CHANGED');
    while (!found) {
      const footnote = nextFootnote.get() as { label: string; source: string } | undefined;
      if (!footnote) break;
      visitedFootnote.run(footnote.label);
      parse(`[^${footnote.label}]\n\n${footnote.source}`, footnote.label);
    }
    if (!sameFile(before, await stableStat(file))) fail(409, 'SOURCE_CHANGED');
    return found;
  } finally {
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
}
