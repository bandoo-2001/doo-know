import type { AppDatabase } from '../db.js';
import type { TokenizerClient } from './tokenizer-client.js';
import type { SourceVersion, Principal, SearchInput } from '../../../shared/knowledge-contracts.js';
import type { IndexedChunk } from './chunks.js';
import { requireScope } from '../agent/auth.js';
import { fail } from '../knowledge/errors.js';
import { recallFilter } from '../search/filters.js';
import {
  CONTENT_MATCH_RANK,
  filenameMatchRank,
  searchNeedle,
} from '../../../shared/search-matching.js';
export function pathFilter(p: Principal, column = 'c.path') {
  if (!p.allowedPrefixes.length) return { sql: '0', values: [] as string[] };
  const clauses: string[] = [],
    values: string[] = [];
  for (const prefix of p.allowedPrefixes) {
    clauses.push(`(${column}=? OR ${column} LIKE ? ESCAPE '\\')`);
    values.push(prefix, prefix.replace(/[\\%_]/g, '\\$&') + '/%');
  }
  return { sql: clauses.join(' OR '), values };
}
export function textIndexService(db: AppDatabase, tokenizer: TokenizerClient) {
  async function stage(
    version: SourceVersion,
    title: string,
    path: string,
    chunks: IndexedChunk[],
    valid: () => boolean = () => true,
  ) {
    if (chunks.length > 16) fail(413, 'INDEX_BATCH_TOO_LARGE');
    const fields = chunks.flatMap((c) => [title, path, c.headingPath.join(' / '), c.content]),
      terms = await tokenizer.tokenize(fields);
    db.transaction(() => {
      if (!valid()) fail(409, 'LEASE_LOST');
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        if (c.noteId !== version.noteId || c.sourceHash !== version.contentHash)
          fail(409, 'INDEX_VERSION_CONFLICT');
        db.prepare(
          'INSERT INTO chunks(chunk_id,note_id,source_hash,source_revision,chunker_id,ordinal,heading_path,start_line,end_line,content,input_hash,title,path,active,start_byte,end_byte) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(chunk_id) DO UPDATE SET source_revision=excluded.source_revision,content=excluded.content,input_hash=excluded.input_hash,title=excluded.title,path=excluded.path,active=0,start_byte=excluded.start_byte,end_byte=excluded.end_byte',
        ).run(
          c.chunkId,
          c.noteId,
          c.sourceHash,
          version.sourceRevision,
          c.chunkerId,
          c.ordinal,
          JSON.stringify(c.headingPath),
          c.startLine,
          c.endLine,
          c.content,
          c.embeddingInputHash,
          title,
          path,
          c.startByte,
          c.endByte,
        );
        const row = (db.prepare('SELECT rowid FROM chunks WHERE chunk_id=?').get(c.chunkId) as any)
          .rowid;
        db.prepare('DELETE FROM chunks_fts WHERE rowid=?').run(row);
        db.prepare('INSERT INTO chunks_fts(rowid,title,path,heading,body) VALUES(?,?,?,?,?)').run(
          row,
          ...terms.slice(i * 4, i * 4 + 4).map((t) => t.join(' ')),
        );
        db.prepare('DELETE FROM chunk_terms WHERE chunk_id=?').run(c.chunkId);
        const raw = [title, path, ...c.headingPath, c.content].join('\n').toLowerCase(),
          characters = [...raw],
          grams = new Set<string>();
        for (let j = 0; j < characters.length; j++) {
          if (!/\s/.test(characters[j])) grams.add(characters[j]);
          if (j + 1 < characters.length && !/\s/.test(characters[j] + characters[j + 1]))
            grams.add(characters[j] + characters[j + 1]);
        }
        const insert = db.prepare('INSERT OR IGNORE INTO chunk_terms VALUES(?,?)');
        for (const term of grams) insert.run(term, c.chunkId);
      }
    }).immediate();
  }
  function publish(version: SourceVersion, chunkerId: string, valid: () => boolean = () => true) {
    return db
      .transaction(() => {
        if (!valid()) return 'superseded';
        const state = db
          .prepare('SELECT * FROM document_state WHERE note_id=?')
          .get(version.noteId) as any;
        if (
          !state?.active ||
          state.conflict ||
          state.source_revision !== version.sourceRevision ||
          state.content_hash !== version.contentHash
        )
          return 'superseded';
        if (
          db
            .prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')")
            .get() ||
          (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any).active
        )
          fail(503, 'SYNC_IN_PROGRESS');
        let end = 0;
        for (const row of db
          .prepare(
            'SELECT start_byte,end_byte FROM chunks WHERE note_id=? AND source_hash=? AND source_revision=? AND chunker_id=? ORDER BY ordinal',
          )
          .iterate(
            version.noteId,
            version.contentHash,
            version.sourceRevision,
            chunkerId,
          ) as Iterable<any>) {
          if (row.start_byte > end) fail(409, 'INDEX_INCOMPLETE');
          end = Math.max(end, row.end_byte);
        }
        if (end !== state.size_bytes) fail(409, 'INDEX_INCOMPLETE');
        db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(version.noteId);
        db.prepare(
          'UPDATE chunks SET active=1 WHERE note_id=? AND source_hash=? AND source_revision=? AND chunker_id=?',
        ).run(version.noteId, version.contentHash, version.sourceRevision, chunkerId);
        db.prepare('UPDATE document_state SET text_indexed_hash=? WHERE note_id=?').run(
          version.contentHash,
          version.noteId,
        );
        db.prepare(
          "INSERT INTO index_meta VALUES('index_epoch','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
        ).run();
        return 'published';
      })
      .immediate();
  }
  async function search(p: Principal, query: string, limit = 50, filters?: SearchInput['filters']) {
    requireScope(p, 'knowledge:read');
    if (typeof query !== 'string' || [...query].length > 512) fail(400, 'INVALID_QUERY');
    const raw = query.trim(),
      phrase = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'),
      needle = searchNeedle(raw);
    if (!needle) return [];
    const allowed = recallFilter(p, filters);
    const literal =
      phrase ||
      [...needle].length <= 2 ||
      /^[a-z_][a-z0-9_]*$/i.test(needle) ||
      /\.md$|[/\\]/i.test(needle);
    // Verify literal filenames, paths and phrases before LIMIT. In particular,
    // the common "md" token must not qualify unrelated files by itself.
    const literalSql = literal
      ? ` AND (dooknow_search_contains(c.title,?) OR dooknow_search_contains(c.path,?) OR dooknow_search_contains((SELECT group_concat(value,' / ') FROM json_each(c.heading_path)),?) OR dooknow_search_contains(c.content,?))`
      : '';
    const values = [...allowed.values, ...(literal ? [needle, needle, needle, needle] : [])];
    const base = `FROM chunks c JOIN document_state d ON d.note_id=c.note_id JOIN notes n ON n.id=c.note_id WHERE c.active=1 AND d.active=1 AND n.active=1 AND d.conflict=0 AND c.source_hash=d.content_hash AND c.source_revision=d.source_revision AND (${allowed.sql})${literalSql}`;
    let candidates: any[] = [];
    if ([...needle].length <= 2) {
      candidates = db
        .prepare(
          `SELECT c.* ${base} AND EXISTS(SELECT 1 FROM chunk_terms t WHERE t.chunk_id=c.chunk_id AND t.term=?) ORDER BY dooknow_filename_rank(c.path,?),c.ordinal,c.chunk_id LIMIT ?`,
        )
        .all(...values, needle, raw, Math.min(limit, 500)) as any[];
    } else {
      const tokens = /^[a-z_][a-z0-9_]*$/i.test(needle)
        ? [needle]
        : (await tokenizer.tokenize([needle]))[0].filter((t) => /[\p{L}\p{N}_]/u.test(t));
      // Filename substrings need not align with tokenizer boundaries (e.g.
      // 测记录 inside 观测记录.md). Find names from note metadata independently,
      // then apply the same ACL, filters and version checks as content recall.
      // Materialize once per note instead of testing its path on every chunk.
      const named = db
        .prepare(
          `WITH named_notes AS MATERIALIZED (SELECT id FROM notes WHERE active=1 AND dooknow_search_contains(path,?)) SELECT c.* ${base} AND c.note_id IN (SELECT id FROM named_notes) ORDER BY dooknow_filename_rank(c.path,?),c.ordinal,c.chunk_id LIMIT ?`,
        )
        .all(needle, ...values, raw, Math.min(limit, 500)) as any[];
      if (tokens.length) {
        const expression = tokens.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' AND ');
        candidates = db
          .prepare(
            `SELECT c.*,bm25(chunks_fts,5,3,2,1) score FROM chunks_fts JOIN chunks c ON c.rowid=chunks_fts.rowid JOIN document_state d ON d.note_id=c.note_id JOIN notes n ON n.id=c.note_id WHERE chunks_fts MATCH ? AND c.active=1 AND d.active=1 AND n.active=1 AND d.conflict=0 AND c.source_hash=d.content_hash AND c.source_revision=d.source_revision AND (${allowed.sql})${literalSql} ORDER BY dooknow_filename_rank(c.path,?),score,c.chunk_id LIMIT ?`,
          )
          .all(expression, ...values, raw, Math.min(limit, 500)) as any[];
      }
      const merged = new Map(named.map((c) => [c.chunk_id, c]));
      for (const candidate of candidates) merged.set(candidate.chunk_id, candidate);
      candidates = [...merged.values()]
        .sort(
          (a, b) =>
            Math.min(filenameMatchRank(a.path, raw) ?? CONTENT_MATCH_RANK, CONTENT_MATCH_RANK) -
              Math.min(filenameMatchRank(b.path, raw) ?? CONTENT_MATCH_RANK, CONTENT_MATCH_RANK) ||
            (a.score ?? 0) - (b.score ?? 0) ||
            a.ordinal - b.ordinal ||
            a.chunk_id.localeCompare(b.chunk_id),
        )
        .slice(0, Math.min(limit, 500));
    }
    if (literal)
      candidates = candidates.filter((c) =>
        [c.title, c.path, JSON.parse(c.heading_path).join(' / '), c.content].some((value) =>
          String(value).toLowerCase().includes(needle),
        ),
      );
    return candidates.map((c, i) => ({
      ...c,
      chunkId: c.chunk_id,
      noteId: c.note_id,
      rank: i + 1,
      score: c.score ?? 0,
    }));
  }
  return { stage, publish, search };
}
