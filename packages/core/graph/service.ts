import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { GraphQuery, KnowledgeGraphResponse } from '../../../shared/graph-contracts.js';
import { extractNoteLinks } from '../../../shared/note-links.js';
import { documentTitle } from '../../../shared/whiteboard.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { safePath, validateRelative } from '../files.js';
import { canAccessPath, requireScope } from '../agent/auth.js';
import { assertRoot } from '../indexing/reconcile.js';
import { buildRelations, renderGraph } from './relations.js';
import {
  assertOrganizationReadable,
  workspaceRead,
  operationHasLiveWorkspaceWriter,
} from '../workspace/gate.js';
import { fail } from '../knowledge/errors.js';
import { migrateGraph } from './schema.js';

const ROUND_FILES = 128,
  ROUND_BYTES = 4 * 1024 * 1024,
  SOURCE_BYTES = 256 * 1024;
// Bound both filesystem probes and the in-memory induced graph independently of catalog size.
const GRAPH_CANDIDATES = 5000,
  TARGETS_PER_SOURCE = 512;
type Row = { sequence: number; id: string; path: string };
type Cached = Row & {
  fingerprint: string;
  title: string;
  source_revision: number | null;
  content_hash: string | null;
};
type Cycle = { after: number; high: number };
// instr is case-sensitive and counts Unicode code points itself, unlike LIKE
// or JS string-length based substr predicates. Keep this ACL local to graphs.
function graphPathFilter(principal: Principal) {
  if (principal.knowledgeAll) return { sql: '1', values: [] as string[] };
  const refs =
    principal.knowledgeResourcePaths ??
    principal.allowedPrefixes.filter(Boolean).map((path) => ({ kind: 'directory', path }));
  const values: string[] = [];
  const clauses = refs.map((ref) => {
    values.push(ref.path);
    if (ref.kind === 'note') return 'n.path = ? COLLATE BINARY';
    values.push(ref.path + '/');
    return '(n.path = ? COLLATE BINARY OR instr(n.path, ?) = 1)';
  });
  return { sql: clauses.join(' OR ') || '0', values };
}
const fingerprint = (s: ReturnType<typeof lstatSync> | any) =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].map(String).join(':');
function inspect(root: string, path: string) {
  const file = safePath(root, path, 'note');
  const stat = lstatSync(file, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size > BigInt(SOURCE_BYTES)
  )
    throw Error('unsupported source');
  return { file, stat, version: fingerprint(stat) };
}
/** A pinned, byte-bounded read; re-check named identity and all version fields. */
function readSource(root: string, path: string, expected: string) {
  const { file } = inspect(root, path);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (fingerprint(before) !== expected || !before.isFile() || before.size > BigInt(SOURCE_BYTES))
      throw Error('changed source');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (
      length !== Number(before.size) ||
      fingerprint(fstatSync(fd, { bigint: true })) !== expected ||
      inspect(root, path).version !== expected
    )
      throw Error('changed source');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    closeSync(fd);
  }
}
function validate(input: GraphQuery): GraphQuery {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !['folder', 'q', 'focus', 'depth', 'mode', 'limit'].includes(k))
  )
    fail(400, 'INVALID_INPUT');
  for (const field of ['folder', 'q', 'focus'] as const)
    if (
      input[field] !== undefined &&
      (typeof input[field] !== 'string' ||
        input[field]!.length > (field === 'folder' ? 1024 : 256) ||
        /[\u0000-\u001f\u007f]/.test(input[field]!))
    )
      fail(400, 'INVALID_INPUT');
  if (input.folder) validateRelative(input.folder, 'folder');
  if (input.focus !== undefined && !input.focus) fail(400, 'INVALID_INPUT');
  if (input.depth !== undefined && input.depth !== 1 && input.depth !== 2)
    fail(400, 'INVALID_INPUT');
  if (input.mode !== undefined && input.mode !== 'all' && input.mode !== 'orphans')
    fail(400, 'INVALID_INPUT');
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)
  )
    fail(400, 'INVALID_INPUT');
  return {
    ...input,
    depth: input.depth ?? 1,
    limit: input.limit ?? 300,
    mode: input.mode ?? 'all',
  };
}

export function createGraphService(config: AppConfig, db: AppDatabase, _notes: NoteService) {
  migrateGraph(db);
  const cycles = new Map<string, Cycle>();
  let tail = Promise.resolve(),
    closed = false,
    queued = 0;
  let hasWriteLeases = false;
  let writeLease: ReturnType<AppDatabase['prepare']> | undefined;
  const noteCurrent = db.prepare('SELECT active,path FROM notes WHERE id=?');
  const maintenance = db.prepare('SELECT active FROM maintenance WHERE id=1');
  const sync = db.prepare(
    "SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')",
  );
  const drop = db.prepare('DELETE FROM graph_sources WHERE note_id=?');
  const failure = db.prepare(
    'INSERT INTO graph_failures VALUES(?,?) ON CONFLICT(note_id) DO UPDATE SET path=excluded.path',
  );
  const clearFailure = db.prepare('DELETE FROM graph_failures WHERE note_id=?');
  const cached = db.prepare('SELECT fingerprint,path FROM graph_sources WHERE note_id=?');
  const publish = db.prepare(
    'INSERT INTO graph_sources VALUES(?,?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET path=excluded.path,fingerprint=excluded.fingerprint,title=excluded.title,targets=excluded.targets',
  );
  const blocked = db.prepare(`SELECT 1 FROM document_state WHERE note_id=? AND conflict<>0
    UNION ALL SELECT 1 FROM write_intents WHERE note_id=? AND status IN ('prepared','conflicted')
    UNION ALL SELECT 1 FROM file_operations WHERE note_id=? AND status IN ('queued','running','committing','needs_reconciliation') LIMIT 1`);
  function barrier() {
    assertOrganizationReadable(db);
    assertRoot(config, db);
    if ((maintenance.get() as { active: number } | undefined)?.active || sync.get())
      fail(503, 'SYNC_IN_PROGRESS', '工作区维护中', true);
  }
  const isBlocked = (id: string) => {
    if (blocked.get(id, id, id)) return true;
    if (!hasWriteLeases || !writeLease) return false;
    const lease = writeLease.get(id) as { owner: string; lease_until: number } | undefined;
    return (
      !!lease &&
      (lease.lease_until > Date.now() ||
        operationHasLiveWorkspaceWriter(db, lease.owner.split(':')[0]))
    );
  };
  function current(id: string, path: string) {
    const row = noteCurrent.get(id) as { active: number; path: string } | undefined;
    return !!row?.active && row.path === path && !isBlocked(id);
  }
  async function run(principal: Principal, input: GraphQuery): Promise<KnowledgeGraphResponse> {
    if (closed) fail(503, 'GRAPH_CLOSED');
    const query = validate(input);
    const needle = query.q?.trim().toLowerCase();
    if (principal.id.startsWith('share:')) fail(403, 'FORBIDDEN');
    requireScope(principal, 'knowledge:read');
    barrier();
    hasWriteLeases = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='note_write_leases'")
      .get();
    if (hasWriteLeases && !writeLease)
      writeLease = db.prepare('SELECT owner,lease_until FROM note_write_leases WHERE note_id=?');
    if (query.focus) {
      const focus = db.prepare('SELECT path,active FROM notes WHERE id=?').get(query.focus) as
        | { path: string; active: number }
        | undefined;
      if (!focus?.active) fail(404, 'NOTE_NOT_FOUND');
      if (!canAccessPath(principal, focus.path)) fail(403, 'FORBIDDEN');
    }
    const allowed = graphPathFilter(principal);
    const where = `n.active=1 AND lower(n.path) LIKE '%.md' AND (${allowed.sql})`;
    const key = createHash('sha256')
      .update(JSON.stringify([principal, config.knowledgeRoot]))
      .digest('hex');
    let cycle = cycles.get(key);
    if (!cycle || cycle.after >= cycle.high) {
      cycle = {
        after: 0,
        high: (
          db
            .prepare(`SELECT coalesce(max(rowid),0) AS high FROM notes n WHERE ${where}`)
            .get(...allowed.values) as { high: number }
        ).high,
      };
      if (cycles.size >= 64 && !cycles.has(key)) cycles.delete(cycles.keys().next().value!);
      cycles.set(key, cycle);
    }
    const rows = db
      .prepare(
        `SELECT n.rowid AS sequence,n.id,n.path FROM notes n WHERE ${where} AND n.rowid>? AND n.rowid<=? ORDER BY n.rowid LIMIT ?`,
      )
      .all(...allowed.values, cycle.after, cycle.high, ROUND_FILES) as Row[];
    let scanned = 0,
      indexed = 0,
      bytes = 0,
      deferred = false;
    for (const row of rows) {
      if (!canAccessPath(principal, row.path)) {
        cycle.after = row.sequence;
        continue;
      }
      scanned++;
      try {
        if (isBlocked(row.id)) throw Error('busy source');
        const info = inspect(config.knowledgeRoot, row.path);
        const old = cached.get(row.id) as { fingerprint: string; path: string } | undefined;
        if (old?.fingerprint !== info.version || old.path !== row.path) {
          // Invalidate before deferring so old relations can never survive a changed source.
          drop.run(row.id);
          if (bytes + Number(info.stat.size) > ROUND_BYTES) {
            deferred = true;
            break;
          }
          bytes += Number(info.stat.size);
          const content = readSource(config.knowledgeRoot, row.path, info.version);
          const targets = extractNoteLinks(content, row.path);
          if (targets.length > TARGETS_PER_SOURCE) throw Error('too many source links');
          if (
            !current(row.id, row.path) ||
            inspect(config.knowledgeRoot, row.path).version !== info.version
          )
            throw Error('source changed');
          publish.run(
            row.id,
            row.path,
            info.version,
            Array.from(documentTitle(row.path, content)).slice(0, 256).join(''),
            JSON.stringify(targets),
          );
        }
        clearFailure.run(row.id);
        indexed++;
      } catch {
        drop.run(row.id);
        failure.run(row.id, row.path);
      }
      cycle.after = row.sequence;
      if (scanned % 32 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        barrier();
      }
    }
    if (!deferred && rows.length < ROUND_FILES) cycle.after = cycle.high;
    // Every published endpoint is revalidated, including endpoints outside this round's parse page.
    const candidateClauses: string[] = [],
      candidateArgs: string[] = [];
    if (query.folder) {
      candidateClauses.push('instr(n.path, ?) = 1');
      candidateArgs.push(query.folder + '/');
    }
    if (needle) {
      candidateClauses.push("dooknow_search_contains(g.title || ' ' || n.path, ?) = 1");
      candidateArgs.push(needle);
    }
    const candidateWhere = candidateClauses.length ? ' AND ' + candidateClauses.join(' AND ') : '';
    const candidateOrder = query.focus ? 'CASE WHEN n.id=? THEN 0 ELSE 1 END,n.rowid' : 'n.rowid';
    const candidates = db
      .prepare(
        `SELECT n.rowid AS sequence,n.id,n.path,g.fingerprint,g.title,d.source_revision,d.content_hash FROM notes n JOIN graph_sources g ON g.note_id=n.id AND g.path=n.path LEFT JOIN document_state d ON d.note_id=n.id WHERE ${where}${candidateWhere} ORDER BY ${candidateOrder} LIMIT ?`,
      )
      .all(
        ...allowed.values,
        ...candidateArgs,
        ...(query.focus ? [query.focus] : []),
        GRAPH_CANDIDATES + 1,
      ) as Cached[];
    const candidateTruncated = candidates.length > GRAPH_CANDIDATES;
    const valid = new Map<string, Cached>();
    let verified = 0;
    for (const row of candidates.slice(0, GRAPH_CANDIDATES)) {
      if (!canAccessPath(principal, row.path)) continue;
      try {
        if (
          !current(row.id, row.path) ||
          inspect(config.knowledgeRoot, row.path).version !== row.fingerprint
        )
          throw Error('stale source');
        valid.set(row.id, row);
      } catch {
        drop.run(row.id);
      }
      if (++verified % 32 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        barrier();
      }
    }
    const checkpoint = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      barrier();
    };
    const graphRows = [...valid.values()].filter(
      (row) =>
        (!query.folder || row.path.startsWith(query.folder + '/')) &&
        (!needle || (row.title + ' ' + row.path).toLowerCase().includes(needle)),
    );
    const sourceTargets = db.prepare('SELECT targets FROM graph_sources WHERE note_id=?');
    const relations = await buildRelations(
      graphRows,
      (row) => (sourceTargets.get(row.id) as { targets: string }).targets,
      checkpoint,
    );
    const active = new Uint8Array(graphRows.length).fill(1);
    // Check managed versions after ALL yielding work. This bounded bulk read does
    // not repeat filesystem stats. A completed save can have released its lease
    // already; revision/hash still prove that its old title/edges are obsolete.
    const publicationState =
      db.prepare(`SELECT n.id,n.path,n.active,d.source_revision,d.content_hash,
      coalesce(d.conflict,0) OR
      EXISTS(SELECT 1 FROM write_intents w WHERE w.note_id=n.id AND w.status IN ('prepared','conflicted')) OR
      EXISTS(SELECT 1 FROM file_operations f WHERE f.note_id=n.id AND f.status IN ('queued','running','committing','needs_reconciliation')) AS blocked,
      ${hasWriteLeases ? 'l.owner AS lease_owner,l.lease_until' : 'NULL AS lease_owner,NULL AS lease_until'}
      FROM json_each(?) requested JOIN notes n ON n.id=requested.value
      LEFT JOIN document_state d ON d.note_id=n.id
      ${hasWriteLeases ? 'LEFT JOIN note_write_leases l ON l.note_id=n.id' : ''}`);
    let graph: Awaited<ReturnType<typeof renderGraph>>;
    for (let attempt = 0; ; attempt++) {
      graph = await renderGraph(graphRows, relations, active, query, checkpoint);
      const states = new Map(
        (
          publicationState.all(JSON.stringify(graphRows.map((row) => row.id))) as (Cached & {
            active: number;
            blocked: number;
            lease_owner: string | null;
            lease_until: number | null;
          })[]
        ).map((row) => [row.id, row]),
      );
      let changed = false;
      for (let i = 0; i < graphRows.length; i++) {
        if (!active[i]) continue;
        const row = graphRows[i],
          state = states.get(row.id);
        if (
          !state?.active ||
          state.path !== row.path ||
          state.blocked ||
          state.source_revision !== row.source_revision ||
          state.content_hash !== row.content_hash ||
          (state.lease_owner &&
            ((state.lease_until ?? 0) > Date.now() ||
              operationHasLiveWorkspaceWriter(db, state.lease_owner.split(':')[0])))
        ) {
          active[i] = 0;
          drop.run(row.id);
          changed = true;
        }
      }
      if (!changed) break;
      // Recompute exact degrees/focus/orphans after withdrawals. Bound retries
      // under sustained writes; never return stale data marked complete.
      if (attempt >= 2) fail(409, 'GRAPH_CHANGED', '笔记正在变化，请重试', true);
    }
    const { nodes, edges: visibleEdges, totalNodes, totalEdges } = graph;
    // Coverage is computed across the entire authorized catalog, including
    // invalidations behind the continuation cursor and failures from prior rounds.
    const coverage = db
      .prepare(
        `SELECT
      coalesce(sum(CASE WHEN g.note_id IS NULL AND f.note_id IS NULL THEN 1 ELSE 0 END),0) AS pending,
      coalesce(sum(CASE WHEN f.note_id IS NOT NULL THEN 1 ELSE 0 END),0) AS skipped
      FROM notes n LEFT JOIN graph_sources g ON g.note_id=n.id AND g.path=n.path
      LEFT JOIN graph_failures f ON f.note_id=n.id AND f.path=n.path WHERE ${where}`,
      )
      .get(...allowed.values) as { pending: number; skipped: number };
    const pending = coverage.pending;
    barrier();
    return {
      nodes,
      edges: visibleEdges,
      totalNodes,
      totalEdges,
      truncated:
        candidateTruncated || nodes.length < totalNodes || visibleEdges.length < totalEdges,
      ...(query.focus ? { focus: query.focus } : {}),
      index: {
        scanned,
        indexed,
        skipped: coverage.skipped,
        pending,
        complete: pending === 0 && coverage.skipped === 0,
      },
    };
  }
  return {
    query(principal: Principal, input: GraphQuery = {}) {
      if (closed) {
        try {
          fail(503, 'GRAPH_CLOSED');
        } catch (error) {
          return Promise.reject(error);
        }
      }
      let normalized: GraphQuery;
      try {
        normalized = validate(input);
        if (principal.id.startsWith('share:')) fail(403, 'FORBIDDEN');
        requireScope(principal, 'knowledge:read');
        if (queued >= 8) fail(429, 'GRAPH_BUSY', '图谱忙，请稍后重试', true);
      } catch (error) {
        return Promise.reject(error);
      }
      queued++;
      const result = tail
        .then(() => workspaceRead(db, { kind: 'graph.query' }, () => run(principal, normalized)))
        .finally(() => {
          queued--;
        });
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    async close() {
      closed = true;
      await tail;
      cycles.clear();
    },
  };
}
