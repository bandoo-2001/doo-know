import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markdown, localReference, references } from '../render.js';
import { readBlocks, stableStat, sameFile } from './file-reader.js';
import { fail } from './errors.js';
import { limits } from './limits.js';

const paragraphBudget = 32768;
type Tokens = ReturnType<typeof markdown.parse>;

/** A bounded parser unit is always a complete paragraph, never a guessed long-line window.
 * Container/indented fences are intentionally refused: splitting their CommonMark container
 * state could turn fenced text into an apparent live reference. A prior closed proof is safe.
 */
async function scan(file: string, block: (text: string) => void, proven: () => boolean) {
  const hash = createHash('sha256'),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    line = '',
    paragraph = '',
    paragraphBytes = 0,
    previousCR = false;
  let fence: { marker: string; length: number } | undefined,
    discardedNonWhitespace = false;
  const flush = () => {
    const text = paragraph;
    paragraph = '';
    paragraphBytes = 0;
    if (text && !proven()) block(text);
  };
  const completeLine = () => {
    const current = line;
    line = '';
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
    if (
      /^[ \t]+(?:`{3,}|~{3,})/.test(current) ||
      /^(?: {0,3}>[ \t]?)+.*(?:`{3,}|~{3,})/.test(current) ||
      /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+(?:`{3,}|~{3,})/.test(current)
    )
      fail(413, 'ASSET_REFERENCE_TOO_COMPLEX');
    const open = current.match(/^(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      if (open[1].length > 128) fail(413, 'ASSET_REFERENCE_TOO_COMPLEX');
      flush();
      if (!proven()) fence = { marker: open[1][0], length: open[1].length };
      return;
    }
    if (!current.trim()) {
      flush();
      return;
    }
    const size = Buffer.byteLength(current) + 1;
    if (paragraphBytes + size > paragraphBudget) fail(413, 'ASSET_REFERENCE_TOO_COMPLEX');
    paragraph += current + '\n';
    paragraphBytes += size;
  };
  const piece = (text: string) => {
    if (fence) {
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
      'CREATE TABLE definitions(label TEXT PRIMARY KEY,href TEXT NOT NULL,title TEXT NOT NULL)',
    );
    const lookup = db.prepare('SELECT href,title FROM definitions WHERE label=?'),
      insert = db.prepare('INSERT OR IGNORE INTO definitions VALUES(?,?,?)');
    let definitions = 0,
      found = false;
    const referenceTable = new Proxy(Object.create(null), {
      get: (_target, key) => (typeof key === 'string' ? lookup.get(key) : undefined),
      set: (_target, key, value) => {
        if (typeof key === 'string' && value?.href)
          definitions += insert.run(key, String(value.href), String(value.title || '')).changes;
        return true;
      },
    });
    const matching = (url: string) => localReference(notePath, url) === assetPath;
    const visit = (tokens: Tokens): boolean => {
      for (const token of tokens) {
        if (
          (token.type === 'image' && matching(String(token.attrGet('src') || ''))) ||
          (token.type === 'link_open' && matching(String(token.attrGet('href') || '')))
        )
          return true;
        if (token.children && visit(token.children)) return true;
      }
      return false;
    };
    const parse = (text: string) => {
      if (!text.includes('[')) return;
      const tokens = markdown.parse(text, { references: referenceTable });
      // Existing helper is exact when no global definitions exist. With definitions,
      // use the same parser with the disk-backed first-definition environment.
      found = definitions ? visit(tokens) : references(text).some(matching);
    };
    const firstHash = await scan(file, parse, () => found);
    if (!sameFile(before, await stableStat(file))) fail(409, 'SOURCE_CHANGED');
    const secondHash = await scan(file, parse, () => found);
    if (!sameFile(before, await stableStat(file)) || firstHash !== secondHash)
      fail(409, 'SOURCE_CHANGED');
    return found;
  } finally {
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
}
