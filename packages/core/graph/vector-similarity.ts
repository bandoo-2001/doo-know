import { dirname } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type {
  GraphEvidence,
  GraphExploreQuery,
  GraphKnowledgeEdge,
  GraphKnowledgeNode,
  GraphSimilarityStatus,
} from '../../../shared/graph-semantic-contracts.js';
import type { AppDatabase } from '../db.js';
import { sourceAccess, hash, type SourceVersion } from './analysis-source.js';
import { desiredSpace } from '../indexing/space.js';
import { fail } from '../knowledge/errors.js';

const DIMENSIONS = 512,
  VECTOR_BYTES = 2048;
const MAX_NOTES = 2048,
  MAX_CHUNKS = 32768,
  MAX_NOTE_CHUNKS = 4096;
const MAX_SOURCE_READ_BYTES = 64 * 1024 * 1024,
  MAX_COMPARISONS = 262144;
const MAX_SEEDS = 32,
  MAX_QUEUE = 4,
  MAX_MS = 5000;
type Chunk = {
  chunk_id: string;
  note_id: string;
  source_hash: string;
  source_revision: number;
  ordinal: number;
  chunker_id: string;
  input_hash: string;
  path: string;
  start_byte: number;
  end_byte: number;
  start_line: number;
  end_line: number;
  content_bytes: number;
  cache_bytes: number | null;
  linked: number;
  point_segment: string | null;
  point_row: number | null;
  weight?: number;
};
type Note = SourceVersion & {
  title: string;
  content_hash: string;
  mtime_ns: string;
  size_bytes: number;
  text_indexed_hash: string | null;
  vector_indexed_hash: string | null;
  source_active: number;
  conflict: number;
  chunks: Chunk[];
  signature: string;
  readiness: 'ready' | 'pending' | 'invalid';
};
type EmbeddedNote = {
  note: Note;
  vector: Float64Array;
  chunks: { chunk: Chunk; vector: Float32Array }[];
  fingerprint: string;
};
type Fence = {
  space: string;
  generation: string;
  epoch: string;
  changes: number;
  dataVersion: number;
};
export type GraphVectorSimilarityPlan = {
  nodes: GraphKnowledgeNode[];
  edges: GraphKnowledgeEdge[];
  noteIds: string[];
  status: GraphSimilarityStatus;
  truncated: boolean;
};
type InternalPlan = {
  fence: Fence;
  sources: (SourceVersion & { fingerprint: string })[];
  principal: string;
};
const metadata = `n.id,n.path,COALESCE(d.title,n.path) title,d.source_revision,d.content_hash AS managed_hash,
 d.content_hash,d.mtime_ns,d.size_bytes,d.text_indexed_hash,d.vector_indexed_hash,d.active AS source_active,d.conflict`;
function scope(p: Principal) {
  if (p.knowledgeAll) return { sql: '1', args: [] as string[] };
  const refs =
    p.knowledgeResourcePaths ??
    p.allowedPrefixes.filter(Boolean).map((path) => ({ kind: 'directory', path }));
  const args: string[] = [];
  const clauses = refs.map((ref) => {
    args.push(ref.path);
    if (ref.kind === 'note') return 'n.path=? COLLATE BINARY';
    args.push(ref.path + '/');
    return '(n.path=? COLLATE BINARY OR instr(n.path,?)=1)';
  });
  return { sql: clauses.join(' OR ') || '0', args };
}
function cosine(a: ArrayLike<number>, b: ArrayLike<number>) {
  let dot = 0;
  for (let i = 0; i < DIMENSIONS; i++) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}
function decode(bytes: Buffer) {
  if (bytes.length !== VECTOR_BYTES) return;
  const vector = new Float32Array(DIMENSIONS);
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    const n = bytes.readFloatLE(i * 4);
    if (!Number.isFinite(n)) return;
    vector[i] = n;
    norm += n * n;
  }
  if (Math.abs(norm - 1) > 0.001) return;
  return vector;
}
function principalKey(p: Principal) {
  return hash(
    JSON.stringify([
      p.id,
      p.clientId,
      p.scopes,
      p.knowledgeAll,
      p.knowledgeResourcePaths,
      p.allowedPrefixes,
    ]),
  );
}

/** Read published document embeddings. This adapter never starts or calls an embedding runtime. */
export function createGraphVectorSimilarity(config: AppConfig, db: AppDatabase) {
  const access = sourceAccess(config, db),
    plans = new WeakMap<GraphVectorSimilarityPlan, InternalPlan>();
  // Numerical failures discovered during prepare are reflected by subsequent metadata-only polls.
  const invalid = new Map<string, string>();
  let closed = false,
    queued = 0,
    tail: Promise<unknown> = Promise.resolve();
  function authorize(p: Principal) {
    if (closed) fail(503, 'GRAPH_CLOSED');
    access.authorize(p);
  }
  function context(): Fence {
    return {
      space: desiredSpace(db, config.embeddingSpaceId || ''),
      generation:
        (
          db.prepare("SELECT value FROM index_meta WHERE key='active_generation'").get() as
            | { value: string }
            | undefined
        )?.value || '',
      epoch:
        (
          db.prepare("SELECT value FROM index_meta WHERE key='index_epoch'").get() as
            | { value: string }
            | undefined
        )?.value || '0',
      changes: (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n,
      dataVersion: db.pragma('data_version', { simple: true }) as number,
    };
  }
  function current(fence: Fence) {
    return JSON.stringify(context()) === JSON.stringify(fence);
  }
  function tablesReady() {
    return (
      (
        db
          .prepare(
            "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('vector_points','vector_cache','vector_segments','vector_segment_rows','generation_segments')",
          )
          .get() as { n: number }
      ).n === 5
    );
  }
  function active(fence: Fence) {
    return (
      !!fence.space &&
      !!db
        .prepare("SELECT 1 FROM vector_generations WHERE id=? AND space_id=? AND status='active'")
        .get(fence.generation, fence.space)
    );
  }
  function rows(p: Principal, id?: string) {
    const filter = scope(p);
    return db
      .prepare(
        `SELECT ${metadata} FROM notes n LEFT JOIN document_state d ON d.note_id=n.id
      WHERE n.active=1 AND lower(substr(n.path,-3))='.md' AND n.path<>'_data' AND instr(n.path,'_data/')<>1
      AND (${filter.sql}) ${id === undefined ? '' : 'AND n.id=?'} ORDER BY n.id LIMIT ?`,
      )
      .all(
        ...filter.args,
        ...(id === undefined ? [] : [id]),
        id === undefined ? MAX_NOTES + 1 : 1,
      ) as Note[];
  }
  function describe(
    note: Note,
    fence: Fence,
    enabled: boolean,
    remaining: number,
    rowCount: number,
  ) {
    note.chunks = [];
    note.readiness = 'pending';
    const source = access.current(note.id);
    if (
      !source ||
      !note.content_hash ||
      note.text_indexed_hash !== note.content_hash ||
      note.vector_indexed_hash !== note.content_hash ||
      !enabled
    ) {
      note.signature = hash(
        JSON.stringify([
          note.id,
          note.path,
          note.content_hash,
          note.source_revision,
          note.text_indexed_hash,
          note.vector_indexed_hash,
          !!source,
        ]),
      );
      return false;
    }
    const limit = Math.min(MAX_NOTE_CHUNKS, remaining);
    note.chunks = db
      .prepare(
        `SELECT c.chunk_id,c.note_id,c.source_hash,c.source_revision,c.ordinal,c.chunker_id,c.input_hash,c.path,
      c.start_byte,c.end_byte,c.start_line,c.end_line,p.segment_id AS point_segment,p.row AS point_row,length(CAST(c.content AS BLOB)) AS content_bytes,length(v.value) AS cache_bytes,
      CASE WHEN p.note_id=c.note_id AND p.source_hash=c.source_hash AND p.source_revision=c.source_revision
        AND p.input_hash=c.input_hash AND EXISTS(SELECT 1 FROM vector_rows r WHERE r.generation=? AND r.chunk_id=c.chunk_id AND r.note_id=c.note_id AND r.source_hash=c.source_hash)
        AND EXISTS(SELECT 1 FROM generation_segments g JOIN vector_segments s ON s.id=g.segment_id
          JOIN vector_segment_rows sr ON sr.segment_id=s.id AND sr.row=p.row
          WHERE g.generation=? AND s.id=p.segment_id AND s.space_id=p.space_id AND sr.chunk_id=c.chunk_id
          AND sr.note_id=c.note_id AND sr.source_hash=c.source_hash AND sr.input_hash=c.input_hash AND p.row>=0 AND p.row<s.row_count)
        THEN 1 ELSE 0 END AS linked
      FROM chunks c LEFT JOIN vector_points p ON p.chunk_id=c.chunk_id AND p.space_id=?
      LEFT JOIN vector_cache v ON v.space_id=p.space_id AND v.input_hash=p.input_hash
      WHERE c.note_id=? AND c.active=1 ORDER BY c.start_byte,c.end_byte,c.ordinal LIMIT ?`,
      )
      .all(fence.generation, fence.generation, fence.space, note.id, limit + 1) as Chunk[];
    if (note.chunks.length > limit) {
      note.chunks = [];
      note.signature = hash(JSON.stringify([note.id, note.content_hash, 'budget']));
      return true;
    }
    let covered = 0,
      damaged = false,
      missing = !note.chunks.length;
    for (let i = 0; i < note.chunks.length; i++) {
      const c = note.chunks[i];
      if (
        c.source_hash !== note.content_hash ||
        c.source_revision !== note.source_revision ||
        c.path !== note.path ||
        c.ordinal !== i ||
        c.chunker_id !== note.chunks[0].chunker_id ||
        !Number.isSafeInteger(c.start_byte) ||
        !Number.isSafeInteger(c.end_byte) ||
        c.start_byte < 0 ||
        c.start_byte > covered ||
        c.end_byte <= c.start_byte ||
        c.end_byte > note.size_bytes ||
        c.content_bytes !== c.end_byte - c.start_byte ||
        !Number.isSafeInteger(c.start_line) ||
        !Number.isSafeInteger(c.end_line) ||
        c.start_line < 1 ||
        c.end_line < c.start_line
      )
        damaged = true;
      if (!c.linked || c.cache_bytes === null) missing = true;
      else if (c.cache_bytes !== VECTOR_BYTES) damaged = true;
      c.weight = Math.max(0, c.end_byte - covered);
      covered = Math.max(covered, c.end_byte);
    }
    if (covered !== note.size_bytes) missing = true;
    if (rowCount !== note.chunks.length) missing = true;
    note.signature = hash(
      JSON.stringify([
        note.id,
        note.path,
        note.content_hash,
        note.source_revision,
        note.mtime_ns,
        note.size_bytes,
        note.text_indexed_hash,
        note.vector_indexed_hash,
        note.chunks,
        rowCount,
      ]),
    );
    note.readiness =
      damaged || invalid.get(note.id) === note.signature
        ? 'invalid'
        : missing
          ? 'pending'
          : 'ready';
    return false;
  }
  function scan(p: Principal, seedIds: string[] = []) {
    authorize(p);
    const fence = context();
    const dimensions =
      (
        db.prepare('SELECT dimensions FROM embedding_spaces WHERE id=?').get(fence.space) as
          | { dimensions: number }
          | undefined
      )?.dimensions ?? DIMENSIONS;
    const available = dimensions === DIMENSIONS && active(fence) && tablesReady();
    const filter = scope(p);
    const candidates = rows(p).filter((n) => access.allowed(p, n.path));
    let truncated = candidates.length > MAX_NOTES,
      count = 0;
    const notes = candidates.slice(0, MAX_NOTES);
    // One generation scan, scoped before grouping: never rescan every vector row for each note.
    const counts = new Map(
      (available
        ? (db
            .prepare(
              `SELECT r.note_id,count(*) n FROM vector_rows r
      JOIN notes n ON n.id=r.note_id JOIN document_state d ON d.note_id=n.id
      WHERE r.generation=? AND r.source_hash=d.content_hash AND n.active=1 AND (${filter.sql})
      AND (n.id<=? ${seedIds.length ? `OR n.id IN (${seedIds.map(() => '?').join(',')})` : ''})
      GROUP BY r.note_id`,
            )
            .all(fence.generation, ...filter.args, notes.at(-1)?.id || '', ...seedIds) as {
            note_id: string;
            n: number;
          }[])
        : []
      ).map((r) => [r.note_id, r.n]),
    );
    for (const n of notes) {
      truncated =
        describe(n, fence, available, MAX_CHUNKS - count, counts.get(n.id) || 0) || truncated;
      count += n.chunks.length;
    }
    return { fence, notes, truncated, available, dimensions, counts };
  }
  function statusOf(
    snapshot: ReturnType<typeof scan>,
    overrides = new Map<string, Note['readiness']>(),
  ): GraphSimilarityStatus {
    const { fence, notes, truncated } = snapshot;
    let readyNotes = 0,
      invalidNotes = 0;
    for (const note of notes) {
      const readiness = overrides.get(note.id) ?? note.readiness;
      if (readiness === 'ready') readyNotes++;
      else if (readiness === 'invalid') invalidNotes++;
    }
    const totalNotes = notes.length;
    let pendingNotes = totalNotes - readyNotes - invalidNotes;
    if (snapshot.dimensions !== DIMENSIONS) {
      invalidNotes = totalNotes;
      readyNotes = 0;
      pendingNotes = 0;
    }
    const state = !fence.space
      ? 'unconfigured'
      : snapshot.dimensions !== DIMENSIONS
        ? 'invalid'
        : readyNotes > 0
          ? pendingNotes || invalidNotes || truncated
            ? 'partial'
            : 'ready'
          : invalidNotes > 0
            ? 'invalid'
            : 'pending';
    return {
      state,
      method: 'embedding',
      ...(fence.space ? { spaceId: fence.space, dimensions: snapshot.dimensions } : {}),
      readyNotes,
      totalNotes,
      pendingNotes,
      invalidNotes,
      truncated,
      ...(snapshot.dimensions !== DIMENSIONS
        ? { reason: '当前向量空间维度不受支持，需要 512 维文档嵌入。' }
        : state === 'unconfigured'
          ? { reason: '请在设置 → 搜索与索引配置向量索引。' }
          : state === 'pending'
            ? { reason: '等待当前模型空间的完整笔记向量索引。' }
            : state === 'invalid' || state === 'partial'
              ? { reason: '部分笔记索引缺失、过期、损坏或超出本次读取预算。' }
              : {}),
      revision: hash(
        JSON.stringify([
          fence.space,
          snapshot.dimensions,
          notes.map((n) => [n.id, n.signature, overrides.get(n.id) ?? n.readiness]),
          truncated,
        ]),
      ),
    };
  }
  function status(p: Principal) {
    return statusOf(scan(p));
  }

  async function build(
    p: Principal,
    query: GraphExploreQuery,
    seedNoteIds: readonly string[],
  ): Promise<GraphVectorSimilarityPlan> {
    await yieldTurn();
    authorize(p);
    const requested = [...new Set([...(query.focus ? [query.focus] : []), ...seedNoteIds])];
    const seeds = requested.slice(0, MAX_SEEDS);
    const started = Date.now(),
      snapshot = scan(p, seeds),
      fence = snapshot.fence;
    const overrides = new Map<string, Note['readiness']>();
    let truncated = snapshot.truncated,
      loaded = 0,
      comparisons = 0,
      sourceBytes = 0;
    if (requested.length > MAX_SEEDS) truncated = true;
    const prioritized: Note[] = [];
    for (const id of seeds) {
      let n = snapshot.notes.find((n) => n.id === id);
      if (!n) {
        n = rows(p, id).find((n) => access.allowed(p, n.path));
        if (n) {
          describe(n, fence, snapshot.available, MAX_CHUNKS, snapshot.counts.get(n.id) || 0);
          truncated = true;
        }
      }
      if (n) prioritized.push(n);
    }
    prioritized.push(...snapshot.notes.filter((n) => !seeds.includes(n.id)));
    const embedded = new Map<string, EmbeddedNote>();
    for (let index = 0; index < prioritized.length; index++) {
      const note = prioritized[index];
      if (query.folder && !note.path.startsWith(query.folder + '/')) continue;
      // Previously invalid blobs may have been repaired without changing their metadata.
      if (note.readiness === 'invalid' && invalid.get(note.id) === note.signature) {
        invalid.delete(note.id);
        describe(note, fence, snapshot.available, MAX_CHUNKS, snapshot.counts.get(note.id) || 0);
      }
      if (note.readiness !== 'ready') continue;
      if (loaded + note.chunks.length > MAX_CHUNKS || Date.now() - started > MAX_MS) {
        truncated = true;
        overrides.set(note.id, 'pending');
        continue;
      }
      let fingerprint: string;
      try {
        const file = access.inspect(note.path);
        if (file.size !== note.size_bytes || file.fingerprint.split(':')[3] !== note.mtime_ns)
          throw Error('SOURCE_CHANGED');
        fingerprint = file.fingerprint;
      } catch {
        overrides.set(note.id, 'pending');
        continue;
      }
      const sum = new Float64Array(DIMENSIONS),
        chunks: EmbeddedNote['chunks'] = [];
      let damaged = false;
      for (const chunk of note.chunks) {
        const cached = db
          .prepare(
            'SELECT value FROM vector_cache WHERE space_id=? AND input_hash=? AND length(value)=?',
          )
          .get(fence.space, chunk.input_hash, VECTOR_BYTES) as { value: Buffer } | undefined;
        loaded++;
        const vector = cached && decode(cached.value);
        if (!vector) {
          damaged = true;
          break;
        }
        for (let i = 0; i < DIMENSIONS; i++) sum[i] += vector[i] * chunk.weight!;
        chunks.push({ chunk, vector });
        if (loaded % 128 === 0) {
          await yieldTurn();
          authorize(p);
          if (!current(fence)) fail(409, 'GRAPH_SOURCE_CHANGED');
        }
      }
      const norm = Math.sqrt(sum.reduce((total, n) => total + n * n, 0));
      if (damaged || !Number.isFinite(norm) || norm === 0) {
        invalid.set(note.id, note.signature);
        overrides.set(note.id, 'invalid');
        continue;
      }
      for (let i = 0; i < DIMENSIONS; i++) sum[i] /= norm;
      invalid.delete(note.id);
      overrides.set(note.id, 'ready');
      embedded.set(note.id, { note, vector: sum, chunks, fingerprint });
      if (index % 32 === 0) {
        await yieldTurn();
        authorize(p);
        if (!current(fence)) fail(409, 'GRAPH_SOURCE_CHANGED');
      }
    }
    while (invalid.size > MAX_NOTES) invalid.delete(invalid.keys().next().value!);
    const threshold = query.similarityThreshold ?? 0.65;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
      fail(400, 'INVALID_GRAPH_QUERY');
    const starting = seeds.length
      ? seeds.filter((id) => embedded.has(id))
      : [...embedded.keys()].slice(0, MAX_SEEDS);
    if (!seeds.length && embedded.size > MAX_SEEDS) truncated = true;
    const selected = new Set(starting),
      pairs = new Map<string, { a: EmbeddedNote; b: EmbeddedNote; score: number }>();
    const degrees = new Map<string, number>();
    let frontier = starting;
    for (let depth = 0; depth < (query.focus ? (query.depth ?? 1) : 1); depth++) {
      const next = new Set<string>();
      for (const id of frontier) {
        const a = embedded.get(id)!;
        const neighbors: { b: EmbeddedNote; score: number }[] = [];
        for (const b of embedded.values()) {
          if (a === b) continue;
          if (++comparisons > MAX_COMPARISONS || Date.now() - started > MAX_MS) {
            truncated = true;
            break;
          }
          const score = cosine(a.vector, b.vector);
          if (score >= threshold) {
            neighbors.push({ b, score });
            neighbors.sort((x, y) => y.score - x.score || x.b.note.id.localeCompare(y.b.note.id));
            if (neighbors.length > 3) neighbors.pop();
          }
          if (comparisons % 4096 === 0) {
            await yieldTurn();
            authorize(p);
            if (!current(fence)) fail(409, 'GRAPH_SOURCE_CHANGED');
          }
        }
        for (const { b, score } of neighbors) {
          const key = [a.note.id, b.note.id].sort().join('\0');
          if (
            pairs.has(key) ||
            (degrees.get(a.note.id) || 0) >= 3 ||
            (degrees.get(b.note.id) || 0) >= 3
          )
            continue;
          pairs.set(key, { a, b, score });
          degrees.set(a.note.id, (degrees.get(a.note.id) || 0) + 1);
          degrees.set(b.note.id, (degrees.get(b.note.id) || 0) + 1);
          if (!selected.has(b.note.id)) next.add(b.note.id);
          selected.add(b.note.id);
        }
      }
      frontier = [...next].slice(0, MAX_SEEDS);
      if (next.size > MAX_SEEDS) truncated = true;
    }
    const valid = new Map<string, { entry: EmbeddedNote; bytes: Buffer }>();
    for (const id of selected) {
      const entry = embedded.get(id)!;
      const readBytes =
        entry.note.size_bytes + entry.chunks.reduce((total, c) => total + c.chunk.content_bytes, 0);
      if (sourceBytes + readBytes > MAX_SOURCE_READ_BYTES || Date.now() - started > MAX_MS) {
        truncated = true;
        overrides.set(id, 'pending');
        continue;
      }
      // Reserve before reading so rejected or concurrently modified sources still consume the budget.
      sourceBytes += readBytes;
      try {
        const file = access.read(entry.note.path);
        if (file.fingerprint !== entry.fingerprint || hash(file.text) !== entry.note.content_hash)
          throw Error('SOURCE_CHANGED');
        const bytes = Buffer.from(file.text);
        // Count newlines once in source order, including overlapping chunk boundaries.
        const positions = [
          ...new Set(entry.chunks.flatMap(({ chunk }) => [chunk.start_byte, chunk.end_byte])),
        ].sort((a, b) => a - b);
        const lines = new Map<number, number>();
        let cursor = 0,
          lineCount = 1;
        for (const position of positions) {
          let newline = bytes.indexOf(10, cursor);
          while (newline >= 0 && newline < position) {
            lineCount++;
            cursor = newline + 1;
            newline = bytes.indexOf(10, cursor);
          }
          lines.set(position, lineCount);
          cursor = position;
        }
        for (const { chunk } of entry.chunks) {
          const content = db
            .prepare(
              'SELECT content FROM chunks WHERE chunk_id=? AND active=1 AND length(CAST(content AS BLOB))=?',
            )
            .get(chunk.chunk_id, chunk.content_bytes) as { content: string } | undefined;
          if (
            !content ||
            !Buffer.from(content.content).equals(bytes.subarray(chunk.start_byte, chunk.end_byte))
          )
            throw Error('INVALID_CHUNK');
          const line = lines.get(chunk.start_byte)!;
          const endLine = Math.max(
            line,
            lines.get(chunk.end_byte)! - (bytes[chunk.end_byte - 1] === 10 ? 1 : 0),
          );
          if (line !== chunk.start_line || endLine !== chunk.end_line) throw Error('INVALID_CHUNK');
        }
        valid.set(id, { entry, bytes });
      } catch {
        overrides.set(id, 'invalid');
        invalid.set(id, entry.note.signature);
      }
      await yieldTurn();
      authorize(p);
      if (!current(fence)) fail(409, 'GRAPH_SOURCE_CHANGED');
    }
    function evidence(entry: EmbeddedNote, toward: Float64Array): GraphEvidence {
      const best = entry.chunks
        .filter((c) => c.chunk.weight! > 0)
        .reduce((best, candidate) =>
          cosine(candidate.vector, toward) > cosine(best.vector, toward) ? candidate : best,
        );
      const chunk = best.chunk,
        bytes = valid.get(entry.note.id)!.bytes;
      // A character bound retains valid UTF-8 and line numbers refer to the exact returned quote.
      let quote = bytes.subarray(chunk.start_byte, chunk.end_byte).toString('utf8').slice(0, 1200);
      if (/[\uD800-\uDBFF]$/.test(quote)) quote = quote.slice(0, -1);
      const endLine = Math.max(
        chunk.start_line,
        chunk.start_line + (quote.match(/\n/g)?.length || 0) - (quote.endsWith('\n') ? 1 : 0),
      );
      return {
        id: 'embedding-evidence:' + hash([entry.note.id, chunk.chunk_id, fence.space].join('\0')),
        noteId: entry.note.id,
        title: entry.note.title,
        relativePath: entry.note.path,
        sourceHash: entry.note.content_hash,
        sourceRevision: entry.note.source_revision!,
        startLine: chunk.start_line,
        endLine,
        quote,
        method: 'embedding',
        embeddingSpaceId: fence.space,
        chunkId: chunk.chunk_id,
      };
    }
    const edges: GraphKnowledgeEdge[] = [];
    for (const { a, b, score } of pairs.values()) {
      if (!valid.has(a.note.id) || !valid.has(b.note.id)) continue;
      const [source, target] = [a.note.id, b.note.id].sort();
      edges.push({
        id: 'similarity:' + hash([source, target].join('\0')),
        source,
        target,
        kind: 'similarity',
        label: '语义相似（向量）',
        status: 'suggested',
        confidence: score,
        similarity: {
          method: 'embedding-cosine',
          score,
          spaceId: fence.space,
          dimensions: DIMENSIONS,
          aggregation: 'overlap-weighted-mean',
        },
        evidence: [evidence(a, b.vector), evidence(b, a.vector)],
      });
    }
    const nodes = [...valid.values()].map(
      ({ entry }): GraphKnowledgeNode => ({
        id: entry.note.id,
        title: entry.note.title,
        relativePath: entry.note.path,
        directory: dirname(entry.note.path) === '.' ? '' : dirname(entry.note.path),
        incoming: 0,
        outgoing: 0,
        kind: 'note',
        sourceCount: 1,
        evidence: [],
      }),
    );
    const similarity = statusOf(snapshot, overrides);
    if (truncated) similarity.truncated = true;
    const plan: GraphVectorSimilarityPlan = {
      nodes,
      edges,
      noteIds: nodes.map((n) => n.id),
      status: similarity,
      truncated,
    };
    plans.set(plan, {
      fence,
      principal: principalKey(p),
      sources: [...valid.values()].map(({ entry }) => ({
        ...entry.note,
        fingerprint: entry.fingerprint,
      })),
    });
    assertFresh(p, plan);
    return plan;
  }
  function assertFresh(p: Principal, plan: GraphVectorSimilarityPlan) {
    authorize(p);
    const internal = plans.get(plan);
    if (
      !internal ||
      internal.principal !== principalKey(p) ||
      !current(internal.fence) ||
      internal.sources.some((n) => !access.allowed(p, n.path) || !access.valid(n))
    )
      fail(409, 'GRAPH_SOURCE_CHANGED');
  }
  function prepare(p: Principal, query: GraphExploreQuery, seedNoteIds: readonly string[] = []) {
    if (closed)
      return Promise.reject(
        Object.assign(new Error('GRAPH_CLOSED'), { statusCode: 503, code: 'GRAPH_CLOSED' }),
      );
    if (queued >= MAX_QUEUE)
      return Promise.reject(
        Object.assign(new Error('GRAPH_BUSY'), { statusCode: 503, code: 'GRAPH_BUSY' }),
      );
    queued++;
    const run = tail.then(() => build(p, query, seedNoteIds));
    tail = run
      .catch(() => {})
      .finally(() => {
        queued--;
      });
    return run;
  }
  async function close() {
    closed = true;
    await tail;
    invalid.clear();
  }
  return { status, prepare, assertFresh, close };
}
