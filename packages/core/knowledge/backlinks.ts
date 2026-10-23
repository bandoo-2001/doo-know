import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import { extractNoteLinks, type NoteBacklinksPage } from '../../../shared/note-links.js';
import { documentTitle } from '../../../shared/whiteboard.js';
import { authorizePath } from '../agent/auth.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { assertRoot } from '../indexing/reconcile.js';
import type { NoteService } from '../notes.js';
import { fail } from './errors.js';
import { sameFile } from './file-reader.js';

const pageSize = 50;
const maxSourceBytes = 256 * 1024;
type CatalogRow = { sequence: number; id: string; path: string };
type Cursor = { v: 1; target: string; path: string; scope: string; after: number; high: number };

/** Read one pinned normal file, including an extra byte to detect growth without loading it. */
function readSource(root: string, path: string) {
  const file = safePath(root, path, 'note');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxSourceBytes)) return;
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(safePath(root, path, 'note'), { bigint: true });
    if (length !== Number(before.size) || !sameFile(before, after) || !sameFile(before, named) ||
        before.ctimeNs !== after.ctimeNs || named.isSymbolicLink()) return;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { closeSync(fd); }
}

/** Explicit, read-only catalog pages. It never walks the library or creates an index. */
export function backlinkService(config: AppConfig, db: AppDatabase, notes: NoteService, principal: Principal) {
  const sign = (value: string) => createHmac('sha256', config.secret).update(value).digest('base64url');
  function page(noteId: string, cursor?: unknown): NoteBacklinksPage {
    if (principal.id.startsWith('share:')) fail(403, 'FORBIDDEN');
    const target = notes.row(noteId);
    authorizePath(principal, target.path, 'knowledge:read');
    if (!/\.md$/i.test(target.path)) fail(400, 'INVALID_INPUT', '提及查询仅适用于 Markdown 笔记');
    safePath(config.knowledgeRoot, target.path, 'note');
    const scope = createHash('sha256').update(JSON.stringify([
      principal.id, principal.clientId, [...principal.allowedPrefixes].sort(), config.knowledgeRoot,
    ])).digest('hex');
    const scopeSql = principal.allowedPrefixes.map(() => '(path=? OR instr(path,?)=1)').join(' OR ');
    const scopeArgs = principal.allowedPrefixes.flatMap(prefix => [prefix, prefix + '/']);
    const where = `active=1 AND id<>? AND (${scopeSql})`;
    let after = 0;
    let high = (db.prepare(`SELECT coalesce(max(rowid),0) AS high FROM notes WHERE ${where}`)
      .get(noteId, ...scopeArgs) as { high: number }).high;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 8192 || !/^[A-Za-z\d_-]+\.[A-Za-z\d_-]+$/.test(cursor)) throw Error();
        const [encoded, signature] = cursor.split('.');
        const expected = Buffer.from(sign(encoded)), supplied = Buffer.from(signature);
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw Error();
        const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Cursor;
        if (value.v !== 1 || value.target !== noteId || value.path !== target.path || value.scope !== scope ||
            !Number.isSafeInteger(value.after) || !Number.isSafeInteger(value.high) || value.after < 0 || value.high < value.after) throw Error();
        after = value.after; high = value.high;
      } catch { fail(400, 'INVALID_CURSOR', '查询位置已失效，请重新查找'); }
    }
    const rows = db.prepare(`SELECT rowid AS sequence,id,path FROM notes WHERE ${where} AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`)
      .all(noteId, ...scopeArgs, after, high, pageSize + 1) as CatalogRow[];
    const candidates = rows.slice(0, pageSize);
    const result: NoteBacklinksPage = { matches: [], checked: 0, skipped: 0, incomplete: rows.length > pageSize };
    for (const source of candidates) {
      try {
        authorizePath(principal, source.path, 'knowledge:read');
        if (!/\.md$/i.test(source.path)) { result.skipped++; continue; }
        const content = readSource(config.knowledgeRoot, source.path);
        if (content === undefined) { result.skipped++; continue; }
        const current = db.prepare('SELECT path,active FROM notes WHERE id=?').get(source.id) as { path: string; active: number } | undefined;
        if (!current?.active || current.path !== source.path) { result.skipped++; continue; }
        const links = extractNoteLinks(content, source.path);
        result.checked++;
        if (links.includes(target.path)) result.matches.push({ id: source.id, title: documentTitle(source.path, content), relativePath: source.path });
      } catch { result.skipped++; }
    }
    assertRoot(config, db);
    if (notes.row(noteId).path !== target.path) fail(409, 'SOURCE_CHANGED', '笔记位置已变化，请重新查找');
    if (rows.length > pageSize) {
      const value: Cursor = { v: 1, target: noteId, path: target.path, scope, after: candidates.at(-1)!.sequence, high };
      const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
      result.nextCursor = encoded + '.' + sign(encoded);
    }
    result.incomplete ||= result.skipped > 0;
    return result;
  }
  return { page };
}
