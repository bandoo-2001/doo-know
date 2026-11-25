import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { HttpError } from '../errors.js';
import { readKnowledgeRootIdentity } from '../indexing/root-identity.js';
import { listKnowledgeDataDirectories } from '../knowledge-data.js';
import { fail } from '../knowledge/errors.js';
import { boundedText } from '../knowledge/limits.js';
import { officeDigest, readOfficeDocument } from './documents.js';
import { extractIndexedOfficeText } from './extract.js';
import type { OfficeFormat } from './formats.js';
import { pdfOcrConfiguration } from './pdf-ocr.js';

const extractorVersion = 1;
const pdfExtractorVersion = 2;
const segmentBytes = 8 * 1024;
const documentTextBytes = 1024 * 1024;
const documentSegments = 512;
const shortSearchRows = 4096;
const searchVerificationBytes = 40 * 1024 * 1024;
const searchVerificationDocuments = 24;
const officeDirectory = 'apps/onlyoffice/documents';
const documentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Source = {
  revision: number;
  hash: string | null;
  title: string | null;
  file_type: OfficeFormat | null;
  status: 'pending' | 'ready' | 'failed' | 'missing';
  extractor_version: number;
  extractor_profile: string;
};
type Original = ReturnType<typeof readOfficeDocument>;
type Segment = { heading: string; text: string };
type Reference = {
  documentId: string;
  segment: number;
  sourceHash: string;
  sourceRevision: number;
};
type SearchHit = Reference & { title: string; url: string };
type Candidate = {
  document_id: string;
  segment: number;
  revision: number;
  hash: string;
  title: string;
  heading: string;
};

function splitSegments(parts: Segment[]) {
  const segments: Segment[] = [];
  let remaining = documentTextBytes;
  for (const { heading, text } of parts) {
    const location =
      boundedText(heading.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim(), 256) || '正文';
    const input = Buffer.from(
      text
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .trim()
        .normalize('NFC'),
    );
    for (let start = 0; start < input.length; ) {
      if (!remaining || segments.length === documentSegments) return { segments, truncated: true };
      let end = Math.min(start + segmentBytes, start + remaining, input.length);
      while (end < input.length && end > start && (input[end] & 0xc0) === 0x80) end--;
      if (end === start) return { segments, truncated: true };
      const lineEnd = input.subarray(start, end).lastIndexOf(10);
      if (end < input.length && lineEnd >= Math.floor(segmentBytes * 0.8))
        end = start + lineEnd + 1;
      const piece = input.subarray(start, end).toString('utf8').trim();
      if (piece) segments.push({ heading: location, text: piece });
      remaining -= end - start;
      start = end;
    }
  }
  return { segments, truncated: false };
}

function searchTerms(query: string) {
  const normalized = query.trim().normalize('NFC');
  if (!normalized || [...normalized].length > 512) fail(400, 'INVALID_QUERY');
  if (normalized.includes('\0')) return;
  const phrase = /^"([\s\S]+)"$/.exec(normalized)?.[1]?.trim();
  const words = normalized.match(/[\p{L}\p{M}\p{N}]+/gu);
  const terms = Array.from(
    new Set((phrase ? [phrase] : (words ?? [normalized])).map((word) => word.toLowerCase())),
  );
  return terms.length <= 32 ? terms : undefined;
}

export function officeSearchIndex(
  config: Pick<AppConfig, 'knowledgeRoot' | 'origin'>,
  db: AppDatabase,
) {
  const rootPath = config.knowledgeRoot;
  const root = officeDigest(readKnowledgeRootIdentity(rootPath));
  db.exec(`
    CREATE TABLE IF NOT EXISTS onlyoffice_search_sequence(
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO onlyoffice_search_sequence VALUES(1,0);
    CREATE TABLE IF NOT EXISTS onlyoffice_search_sources(
      root TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL,
      hash TEXT, title TEXT, file_type TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','ready','failed','missing')),
      extractor_version INTEGER NOT NULL, truncated INTEGER NOT NULL DEFAULT 0,
      extractor_profile TEXT NOT NULL DEFAULT '', ocr_status TEXT NOT NULL DEFAULT 'complete',
      PRIMARY KEY(root, document_id)
    );
    CREATE INDEX IF NOT EXISTS onlyoffice_search_status ON onlyoffice_search_sources(root,status);
    CREATE TABLE IF NOT EXISTS onlyoffice_search_segments(
      id INTEGER PRIMARY KEY, root TEXT NOT NULL, document_id TEXT NOT NULL, segment INTEGER NOT NULL,
      title TEXT NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL,
      UNIQUE(root, document_id, segment)
    );
    CREATE INDEX IF NOT EXISTS onlyoffice_search_segment_order ON onlyoffice_search_segments(root,id);
    CREATE VIRTUAL TABLE IF NOT EXISTS onlyoffice_search_fts USING fts5(
      title,heading,text,tokenize='trigram',content='onlyoffice_search_segments',content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS onlyoffice_search_segment_after_insert
    AFTER INSERT ON onlyoffice_search_segments BEGIN
      INSERT INTO onlyoffice_search_fts(rowid,title,heading,text)
      VALUES(new.id,new.title,new.heading,new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS onlyoffice_search_segment_after_delete
    AFTER DELETE ON onlyoffice_search_segments BEGIN
      INSERT INTO onlyoffice_search_fts(onlyoffice_search_fts,rowid,title,heading,text)
      VALUES('delete',old.id,old.title,old.heading,old.text);
    END;
  `);
  db.transaction(() => {
    const columns = new Set(
      (db.pragma('table_info(onlyoffice_search_sources)') as { name: string }[]).map(
        ({ name }) => name,
      ),
    );
    if (!columns.has('extractor_profile'))
      db.exec(
        "ALTER TABLE onlyoffice_search_sources ADD COLUMN extractor_profile TEXT NOT NULL DEFAULT ''",
      );
    if (!columns.has('ocr_status'))
      db.exec(
        "ALTER TABLE onlyoffice_search_sources ADD COLUMN ocr_status TEXT NOT NULL DEFAULT 'complete'",
      );
  }).immediate();

  const sourceRow = db.prepare(
    'SELECT * FROM onlyoffice_search_sources WHERE root=? AND document_id=?',
  );
  const revision = db.prepare(
    'UPDATE onlyoffice_search_sequence SET revision=revision+1 RETURNING revision',
  );
  const deleteSegments = db.prepare(
    'DELETE FROM onlyoffice_search_segments WHERE root=? AND document_id=?',
  );
  const get = (id: string) => sourceRow.get(root, id) as Source | undefined;
  const saveSource = db.prepare(`
    INSERT INTO onlyoffice_search_sources(root,document_id,revision,hash,title,file_type,status,extractor_version,extractor_profile)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(root,document_id) DO UPDATE SET
    revision=excluded.revision,hash=excluded.hash,title=excluded.title,file_type=excluded.file_type,
    status=excluded.status,extractor_version=excluded.extractor_version,extractor_profile=excluded.extractor_profile,
    truncated=0,ocr_status='complete'
  `);
  const segmentInsert = db.prepare(`
    INSERT INTO onlyoffice_search_segments(root,document_id,segment,title,heading,text)
    VALUES(?,?,?,?,?,?)
  `);
  const queue = new Set<string>();
  let scanRequested = false;
  let scan: Iterator<string> | undefined;
  let worker: Promise<void> | undefined;
  let closed = false;
  let unavailable = false;
  let ocrConfiguration: ReturnType<typeof pdfOcrConfiguration> | undefined;
  const cancellation = new AbortController();

  function rootIsCurrent() {
    if (closed) return false;
    try {
      return (
        config.knowledgeRoot === rootPath &&
        officeDigest(readKnowledgeRootIdentity(rootPath)) === root
      );
    } catch {
      return false;
    }
  }

  const observe = db.transaction(
    (id: string, original?: Original, error?: 'missing' | 'failed') => {
      const current = get(id);
      const hash = original?.digest ?? null;
      const title = original?.metadata.name ?? null;
      const format = original?.metadata.fileType ?? null;
      const version = format === 'pdf' ? pdfExtractorVersion : extractorVersion;
      const profile = format === 'pdf' ? (ocrConfiguration ??= pdfOcrConfiguration()).cacheKey : '';
      const same =
        current?.hash === hash &&
        current.title === title &&
        current.file_type === format &&
        current.extractor_version === version &&
        current.extractor_profile === profile;
      if (same && (!error || current.status === error)) return current;
      if (!current && error === 'missing') return;
      const next = (revision.get() as { revision: number }).revision;
      deleteSegments.run(root, id);
      saveSource.run(root, id, next, hash, title, format, error ?? 'pending', version, profile);
      return get(id);
    },
  );

  function inspect(id: string) {
    let original: Original;
    try {
      original = readOfficeDocument(rootPath, id);
    } catch (error) {
      const state = observe.immediate(
        id,
        undefined,
        error instanceof HttpError && error.statusCode === 404 ? 'missing' : 'failed',
      );
      return { state };
    }
    return { original, state: observe.immediate(id, original) };
  }

  type IndexedResult = ReturnType<typeof splitSegments> & {
    ocrStatus: 'complete' | 'unavailable' | 'incomplete';
  };
  const publish = db.transaction((id: string, row: Source, result: IndexedResult | undefined) => {
    const current = get(id);
    if (current?.revision !== row.revision || current.status !== 'pending') return;
    if (result) {
      for (const [index, segment] of result.segments.entries())
        segmentInsert.run(root, id, index, row.title!, segment.heading, segment.text);
    }
    db.prepare(
      `
        UPDATE onlyoffice_search_sources SET status=?,truncated=?,ocr_status=? WHERE root=? AND document_id=?
      `,
    ).run(
      result ? 'ready' : 'failed',
      result?.truncated ? 1 : 0,
      result?.ocrStatus ?? 'complete',
      root,
      id,
    );
  });

  async function indexOne(id: string) {
    const { original, state } = inspect(id);
    if (!original || state?.status !== 'pending') return;
    let result: IndexedResult | undefined;
    try {
      const extraction = await extractIndexedOfficeText(
        original.bytes,
        original.metadata.fileType,
        {
          signal: cancellation.signal,
          ocrConfiguration,
        },
      );
      result = {
        ...splitSegments(extraction.segments),
        ocrStatus: extraction.ocrPending
          ? 'unavailable'
          : extraction.ocrIncomplete
            ? 'incomplete'
            : 'complete',
      };
    } catch {
      // An unsupported or corrupt original must not publish cached text.
    }
    if (!rootIsCurrent()) return;
    if (inspect(id).state?.revision === state.revision) publish.immediate(id, state, result);
  }

  function nativeIds() {
    return listKnowledgeDataDirectories(rootPath, officeDirectory).filter((id) =>
      documentIdPattern.test(id),
    );
  }

  function inventory() {
    const ids = nativeIds();
    const tracked = db
      .prepare(
        `
      SELECT document_id FROM onlyoffice_search_sources WHERE root=? AND status<>'missing'
    `,
      )
      .all(root) as { document_id: string }[];
    return new Set([...ids, ...tracked.map((item) => item.document_id)]).values();
  }

  async function drain() {
    while (!closed) {
      await yieldTurn();
      if (!rootIsCurrent()) {
        scanRequested = false;
        scan = undefined;
        queue.clear();
        return;
      }
      const next = queue.values().next();
      if (!next.done) {
        queue.delete(next.value);
        await indexOne(next.value);
        continue;
      }
      if (!scan && scanRequested) {
        scanRequested = false;
        scan = inventory();
      }
      const entry = scan?.next();
      if (!entry || entry.done) {
        scan = undefined;
        if (!scanRequested) return;
      } else {
        await indexOne(entry.value);
      }
    }
  }

  function start() {
    if (worker || closed) return;
    unavailable = false;
    worker = drain()
      .catch(() => {
        unavailable = true;
        scanRequested = false;
        scan = undefined;
        queue.clear();
      })
      .finally(() => {
        worker = undefined;
        if (queue.size || scanRequested) start();
      });
  }

  function schedule(documentId?: string) {
    if (!rootIsCurrent()) return;
    if (documentId !== undefined) {
      if (!documentIdPattern.test(documentId)) return;
      try {
        if (inspect(documentId).state?.status === 'pending') queue.add(documentId);
      } catch {
        unavailable = true;
        return;
      }
      if (!queue.size) return;
    } else {
      scanRequested = true;
    }
    start();
  }

  function pending() {
    return db
      .prepare(
        `
      SELECT document_id FROM onlyoffice_search_sources
      WHERE root=? AND status='pending' LIMIT 64
    `,
      )
      .all(root) as { document_id: string }[];
  }

  function candidates(terms: string[]) {
    const long = terms.filter((term) => [...term].length >= 3);
    const short = terms.filter((term) => [...term].length < 3);
    const filters = short.map(
      () =>
        '(dooknow_search_contains(s.title,?) OR dooknow_search_contains(s.heading,?) OR dooknow_search_contains(s.text,?))',
    );
    const filterSql = filters.length ? ' AND ' + filters.join(' AND ') : '';
    const fields = 's.document_id,s.segment,d.revision,d.hash,d.title,s.heading';
    const args = short.flatMap((term) => [term, term, term]);
    const match = long.map((term) => '"' + term.replaceAll('"', '""') + '"').join(' AND ');
    const maxCandidateSegments = (searchVerificationDocuments + 1) * documentSegments;
    const matching = match
      ? db
          .prepare(
            `
          SELECT ${fields} FROM onlyoffice_search_fts
          JOIN onlyoffice_search_segments s ON s.id=onlyoffice_search_fts.rowid
          JOIN onlyoffice_search_sources d ON d.root=s.root AND d.document_id=s.document_id
          WHERE onlyoffice_search_fts MATCH ? AND s.root=? AND d.status='ready'${filterSql}
          ORDER BY bm25(onlyoffice_search_fts,3,2,1),s.id LIMIT ?
        `,
          )
          .iterate(match, root, ...args, maxCandidateSegments)
      : db
          .prepare(
            `
        WITH s AS MATERIALIZED (
          SELECT * FROM onlyoffice_search_segments WHERE root=? ORDER BY id LIMIT ?
        )
        SELECT ${fields} FROM s
        JOIN onlyoffice_search_sources d ON d.root=s.root AND d.document_id=s.document_id
        WHERE d.status='ready'${filterSql} ORDER BY s.id
      `,
          )
          .iterate(root, shortSearchRows, ...args);
    const unique = new Map<string, Candidate>();
    for (const row of matching as IterableIterator<Candidate>) {
      if (!unique.has(row.document_id)) unique.set(row.document_id, row);
      if (unique.size > searchVerificationDocuments) break;
    }
    const truncated =
      !match &&
      !!db
        .prepare(
          `
        SELECT 1 FROM onlyoffice_search_segments WHERE root=? LIMIT 1 OFFSET ?
      `,
        )
        .get(root, shortSearchRows);
    return { rows: [...unique.values()], truncated };
  }

  function url(id: string, fileType: OfficeFormat | null, heading: string) {
    const page = fileType === 'pdf' ? /^第 ([1-9][0-9]*) 页$/.exec(heading)?.[1] : undefined;
    const path = `/api/office/documents/${id}/${page ? 'view#page=' + page : 'download'}`;
    return new URL(path, config.origin).href;
  }

  async function search({ query, limit = 10 }: { query: string; limit?: number }) {
    if (typeof query !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 50)
      fail(400, 'INVALID_QUERY');
    const terms = searchTerms(query);
    if (!rootIsCurrent())
      return { results: [], degraded: true, reasons: ['OFFICE_INDEX_UNAVAILABLE'] };
    const reasons = new Set<string>();
    const { rows, truncated } = terms ? candidates(terms) : { rows: [], truncated: true };
    const results: SearchHit[] = [];
    let checked = 0;
    let total = 0;
    if (truncated) reasons.add('OFFICE_SEARCH_LIMIT');
    for (const row of rows) {
      if (total >= searchVerificationBytes || checked >= searchVerificationDocuments) {
        reasons.add('OFFICE_SEARCH_LIMIT');
        break;
      }
      const { original, state: current } = inspect(row.document_id);
      total += original?.bytes.length ?? 0;
      checked++;
      if (
        current?.status !== 'ready' ||
        current.revision !== row.revision ||
        current.hash !== row.hash
      )
        continue;
      results.push({
        documentId: row.document_id,
        segment: row.segment,
        sourceHash: row.hash,
        sourceRevision: row.revision,
        title: row.title,
        url: url(row.document_id, current.file_type, row.heading),
      });
      if (results.length === limit) break;
    }
    if (!rootIsCurrent())
      return { results: [], degraded: true, reasons: ['OFFICE_INDEX_UNAVAILABLE'] };
    const pendingRows = pending();
    if (pendingRows.length || scan) reasons.add('OFFICE_INDEX_PENDING');
    else if (scanRequested) {
      try {
        if (nativeIds().length) reasons.add('OFFICE_INDEX_PENDING');
      } catch {
        reasons.add('OFFICE_INDEX_UNAVAILABLE');
      }
    }
    if (
      db
        .prepare(
          `
      SELECT 1 FROM onlyoffice_search_sources WHERE root=? AND status='failed' LIMIT 1
    `,
        )
        .get(root)
    )
      reasons.add('OFFICE_INDEX_FAILED');
    if (
      db
        .prepare(
          `
      SELECT 1 FROM onlyoffice_search_sources WHERE root=? AND truncated=1 LIMIT 1
    `,
        )
        .get(root)
    )
      reasons.add('OFFICE_INDEX_TRUNCATED');
    const ocrStates = db
      .prepare(
        `
      SELECT DISTINCT ocr_status FROM onlyoffice_search_sources WHERE root=? AND ocr_status<>'complete'
    `,
      )
      .all(root) as { ocr_status: string }[];
    for (const { ocr_status } of ocrStates)
      reasons.add(
        ocr_status === 'unavailable' ? 'OFFICE_OCR_UNAVAILABLE' : 'OFFICE_OCR_INCOMPLETE',
      );
    if (unavailable) reasons.add('OFFICE_INDEX_UNAVAILABLE');
    for (const { document_id } of pendingRows) queue.add(document_id);
    if (queue.size) start();
    return { results, degraded: reasons.size > 0, reasons: [...reasons] };
  }

  async function fetch(ref: Reference) {
    if (!rootIsCurrent()) fail(409, 'RESULT_STALE');
    const { state } = inspect(ref.documentId);
    if (state?.status === 'pending') {
      queue.add(ref.documentId);
      start();
    }
    if (
      !rootIsCurrent() ||
      state?.status !== 'ready' ||
      state.revision !== ref.sourceRevision ||
      state.hash !== ref.sourceHash
    )
      fail(409, 'RESULT_STALE');
    const segment = db
      .prepare(
        `
      SELECT heading,text FROM onlyoffice_search_segments
      WHERE root=? AND document_id=? AND segment=?
    `,
      )
      .get(root, ref.documentId, ref.segment) as Segment | undefined;
    if (!segment) fail(404, 'NOT_FOUND');
    return {
      title: state.title!,
      text: segment.text,
      url: url(ref.documentId, state.file_type, segment.heading),
      metadata: {
        objectType: 'office' as const,
        documentId: ref.documentId,
        fileType: state.file_type!,
        location: segment.heading,
        sourceHash: ref.sourceHash,
        sourceRevision: ref.sourceRevision,
      },
    };
  }

  async function close() {
    closed = true;
    cancellation.abort();
    queue.clear();
    scanRequested = false;
    scan = undefined;
    await worker;
  }

  return { schedule, search, fetch, close };
}
