import { stat } from 'node:fs/promises';
import type { AppConfig } from '../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type {
  Principal,
  SearchInput,
  SearchOutput,
  Hit,
} from '../../shared/knowledge-contracts.js';
import type { indexWorker } from '../indexing/worker.js';
import type { reconcileService } from '../indexing/reconcile.js';
import { safePath } from '../files.js';
import { requireScope, underPrefix } from '../agent/auth.js';
import { fail, KnowledgeError } from '../knowledge/errors.js';
import { boundedText, messageSize } from '../knowledge/limits.js';
import { sha256 } from '../knowledge/operations.js';
import { signCursor, decodeCursor } from '../agent/budgets.js';
import { rrf } from './fusion.js';
import { validateFilters } from './filters.js';
export function searchService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  indexing: ReturnType<typeof reconcileService>,
  worker: ReturnType<typeof indexWorker>,
) {
  const epoch = () =>
    String(
      (db.prepare("SELECT value FROM index_meta WHERE key='index_epoch'").get() as any)?.value ||
        '0',
    ) +
    ':' +
    (worker.vectors?.current() || 'none');
  async function fresh(p: Principal, input: SearchInput) {
    if (
      db.prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')").get()
    )
      fail(503, 'SYNC_IN_PROGRESS');
    const until = Date.now() + 10000;
    const scopes = p.allowedPrefixes
      .map((prefix) =>
        input.filters?.directory && underPrefix(input.filters.directory, prefix)
          ? input.filters.directory
          : prefix,
      )
      .filter(
        (prefix) =>
          !input.filters?.directory ||
          underPrefix(prefix, input.filters.directory) ||
          underPrefix(input.filters.directory, prefix),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await indexing.reconcile(scopes, true, AbortSignal.timeout(10000));
          if (
            db
              .prepare(
                'SELECT 1 FROM document_state d JOIN notes n ON n.id=d.note_id WHERE d.conflict=1 AND n.active=1',
              )
              .all().length &&
            indexing.status({ ...p, scopes: [...p.scopes, 'knowledge:index'] }).conflicts
          )
            fail(409, 'GIT_CONFLICT');
          await worker.drain();
          const rows = (
            db
              .prepare(
                'SELECT n.path,d.* FROM document_state d JOIN notes n ON n.id=d.note_id WHERE d.active=1 AND n.active=1',
              )
              .all() as any[]
          ).filter((n) => scopes.some((scope) => underPrefix(n.path, scope)));
          if (
            rows.some(
              (n) =>
                (input.mode !== 'semantic' && n.text_indexed_hash !== n.content_hash) ||
                (input.mode !== 'text' && n.vector_indexed_hash !== n.content_hash),
            )
          )
            fail(503, 'INDEX_NOT_READY', '索引尚未就绪', true);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new KnowledgeError(503, 'INDEX_NOT_READY', '严格刷新超时', true)),
            Math.max(0, until - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function runSearch(
    p: Principal,
    input: SearchInput,
    signal: AbortSignal,
  ): Promise<SearchOutput> {
    requireScope(p, 'knowledge:read');
    if (
      !input ||
      typeof input.query !== 'string' ||
      !input.query.trim() ||
      [...input.query].length > 512 ||
      !['text', 'semantic', 'hybrid'].includes(input.mode || 'hybrid') ||
      !['indexed', 'strict'].includes(input.freshness || 'indexed') ||
      (input.limit != null &&
        (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50))
    )
      fail(400, 'INVALID_QUERY');
    validateFilters(input.filters);
    const normalized = {
        ...input,
        query: input.query.trim(),
        mode: input.mode || 'hybrid',
        freshness: input.freshness || 'indexed',
        limit: input.limit || 10,
      },
      fingerprint = sha256(
        JSON.stringify({
          id: p.id,
          clientId: p.clientId,
          prefixes: p.allowedPrefixes,
          scopes: p.scopes,
          query: normalized.query,
          filters: normalized.filters || {},
          mode: normalized.mode,
        }),
      );
    let offset = 0;
    if (input.cursor) {
      const cursor = decodeCursor(config.secret, input.cursor);
      if (cursor.fingerprint !== fingerprint) fail(403, 'FORBIDDEN');
      if (cursor.expires <= Date.now() || cursor.epoch !== epoch()) fail(410, 'CURSOR_EXPIRED');
      offset = cursor.offset;
    }
    if (normalized.freshness === 'strict') await fresh(p, normalized);
    const reasons: string[] = [];
    let recall = 50,
      queryVector: Promise<number[]> | undefined;
    const lexical = () =>
      normalized.mode === 'semantic'
        ? Promise.resolve([])
        : worker.text.search(p, normalized.query, recall, normalized.filters);
    const semantic = () =>
      normalized.mode === 'text'
        ? Promise.resolve([])
        : (async () => {
            if (!worker.client || !worker.vectors) fail(503, 'VECTOR_NOT_CONFIGURED');
            queryVector ||= worker.client.query(normalized.query);
            const query = await queryVector;
            signal.throwIfAborted();
            return worker.vectors.search(query, p, recall, normalized.filters);
          })().catch((error) => {
            if (normalized.mode === 'semantic') throw error;
            reasons.push(error instanceof KnowledgeError ? error.code : 'VECTOR_UNAVAILABLE');
            return [];
          });
    let [textRanks, vectorRanks] = await Promise.all([lexical(), semantic()]);
    const document = db.prepare('SELECT note_id FROM chunks WHERE chunk_id=? AND active=1');
    const distinct = () =>
      new Set(
        [...textRanks, ...vectorRanks]
          .map((c) => (document.get(c.chunkId) as any)?.note_id)
          .filter(Boolean),
      ).size;
    while (
      distinct() < offset + normalized.limit + 1 &&
      (textRanks.length === recall || vectorRanks.length === recall) &&
      recall < 500
    ) {
      signal.throwIfAborted();
      recall = Math.min(500, recall * 3);
      [textRanks, vectorRanks] = await Promise.all([lexical(), semantic()]);
    }
    signal.throwIfAborted();
    const ranking = rrf(textRanks, vectorRanks),
      results: SearchOutput['results'] = [],
      grouped = new Map<string, SearchOutput['results'][number]>(),
      checked = new Map<string, boolean>();
    for (const ranked of ranking) {
      signal.throwIfAborted();
      if (results.length > offset + normalized.limit) break;
      const c = db
        .prepare(
          'SELECT c.*,d.mtime_ns,d.size_bytes,d.content_hash,d.source_revision AS current_revision,d.conflict,n.active AS note_active FROM chunks c JOIN document_state d ON d.note_id=c.note_id JOIN notes n ON n.id=c.note_id WHERE c.chunk_id=? AND c.active=1',
        )
        .get(ranked.chunkId) as any;
      if (
        !c ||
        !c.note_active ||
        c.conflict ||
        c.source_hash !== c.content_hash ||
        c.source_revision !== c.current_revision ||
        !p.allowedPrefixes.some((prefix) => underPrefix(c.path, prefix))
      )
        continue;
      if (
        (input.filters?.directory && !underPrefix(c.path, input.filters.directory)) ||
        (input.filters?.category && c.path.split('/')[0] !== input.filters.category) ||
        (input.filters?.updatedAfter &&
          Number(c.mtime_ns) / 1e6 <= Date.parse(input.filters.updatedAfter))
      )
        continue;
      if (!checked.has(c.note_id)) {
        try {
          const s = await stat(safePath(config.knowledgeRoot, c.path, 'note'), { bigint: true });
          checked.set(
            c.note_id,
            s.mtimeNs.toString() === c.mtime_ns && Number(s.size) === c.size_bytes,
          );
        } catch {
          checked.set(c.note_id, false);
        }
      }
      if (!checked.get(c.note_id)) {
        if (!reasons.includes('SOURCE_CHANGED')) reasons.push('SOURCE_CHANGED');
        continue;
      }
      let item = grouped.get(c.note_id);
      if (!item) {
        item = {
          noteId: c.note_id,
          title: [...c.title].slice(0, 256).join(''),
          relativePath: c.path,
          url: `${config.origin}/?note=${encodeURIComponent(c.note_id)}`,
          matches: [],
        };
        grouped.set(c.note_id, item);
        results.push(item);
      }
      if (item.matches.length >= 3) continue;
      const hit: Hit = {
        noteId: c.note_id,
        chunkId: c.chunk_id,
        title: item.title,
        relativePath: c.path,
        url: item.url + `#L${c.start_line}`,
        headingPath: JSON.parse(c.heading_path),
        startLine: c.start_line,
        endLine: c.end_line,
        snippet: boundedText(c.content, 512),
        sourceHash: c.source_hash,
        sourceRevision: c.source_revision,
        matchedBy: ranked.matchedBy,
      };
      item.matches.push(hit);
    }
    const status = indexing.status({ ...p, scopes: [...p.scopes, 'knowledge:index'] });
    if (status.pending || status.retrying || status.failed) reasons.push('INDEX_PENDING');
    if (status.conflicts) reasons.push('GIT_CONFLICT');
    if (status.error) reasons.push(status.error);
    let selected = results.slice(offset, offset + normalized.limit);
    const output = (): SearchOutput => ({
      results: selected,
      ...(offset + selected.length < results.length
        ? {
            nextCursor: signCursor(config.secret, {
              fingerprint,
              epoch: epoch(),
              offset: offset + selected.length,
              expires: Date.now() + 15 * 60000,
            }),
          }
        : {}),
      degraded: reasons.length > 0,
      reasons: [...new Set(reasons)],
      index: {
        checkedAt: status.lastReconciledAt,
        pending: status.pending + status.retrying,
        generation: status.generation,
      },
    });
    while (selected.length && messageSize(output()) > 65536) selected = selected.slice(0, -1);
    if (!selected.length && results.length > offset) fail(413, 'RESPONSE_TOO_LARGE');
    return output();
  }
  async function search(p: Principal, input: SearchInput): Promise<SearchOutput> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const strict = input?.freshness === 'strict';
    try {
      return await Promise.race([
        runSearch(p, input, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(
                new KnowledgeError(
                  503,
                  strict ? 'INDEX_NOT_READY' : 'SEARCH_TIMEOUT',
                  '检索未在时间内完成',
                  true,
                ),
              );
            },
            strict ? 10000 : 5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
  return { search, fresh };
}
