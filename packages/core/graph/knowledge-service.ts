import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type {
  GraphModelPort,
  GraphExploreQuery,
  GraphKnowledgeNode,
  GraphKnowledgeEdge,
  GraphKnowledgeResponse,
  GraphAnalysisStatus,
  GraphReviewItem,
  GraphReviewQuery,
  GraphUserCommand,
  GraphQuestionInput,
  GraphEvidence,
} from '../../../shared/graph-semantic-contracts.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import { workspaceReadSync, workspaceWriteSync, workspaceRead } from '../workspace/gate.js';
import { fail } from '../knowledge/errors.js';
import { migrateLookup } from './analysis-lookup.js';
import { migrateAnalysis } from './analysis-schema.js';
import { sourceAccess, hash, type SourceVersion } from './analysis-source.js';
import { analysisWorker } from './analysis-worker.js';
import { knowledgeState, canonical, validateQuery, type Portable } from './knowledge-state.js';
import { terms, type Analysis } from './analysis-content.js';
import {
  createGraphVectorSimilarity,
  type GraphVectorSimilarityPlan,
} from './vector-similarity.js';
type SnapshotMetadata = SourceVersion & {
  note_id: string;
  fingerprint: string;
  config_hash: string;
  updated_at: string;
  data_bytes?: number;
};
type Snapshot = SnapshotMetadata & { analysis: Analysis };
type ReadBudget = { used: number };
const MAX_SOURCE_JSON_BYTES = 16 * 1024 * 1024;
const SOURCE_METADATA =
  's.note_id,n.id,s.path,s.fingerprint,s.source_revision,s.managed_hash,s.config_hash,s.updated_at';
const MAX_SOURCES = 512,
  MAX_NODES = 6000,
  MAX_EDGES = 20000;
function acl(p: Principal) {
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
export function createKnowledgeGraph(
  config: AppConfig,
  db: AppDatabase,
  _notes: NoteService,
  model: GraphModelPort,
) {
  migrateAnalysis(db);
  migrateLookup(db);
  const access = sourceAccess(config, db),
    state = knowledgeState(config, db),
    worker = analysisWorker(config, db, model, access),
    similarity = createGraphVectorSimilarity(config, db);
  let closed = false,
    queued = 0;
  function authorize(p: Principal, owner = false) {
    if (closed) fail(503, 'GRAPH_CLOSED');
    access.authorize(p, owner);
  }
  function snapshots(
    p: Principal,
    query: GraphExploreQuery,
    portable: Portable,
    anchors?: string[],
    budget: ReadBudget = { used: 0 },
    additionalNoteIds: readonly string[] = [],
  ) {
    const filter = acl(p),
      args: unknown[] = [...filter.args],
      clauses = [`n.active=1 AND (${filter.sql})`];
    if (query.folder) {
      clauses.push('instr(n.path,?)=1');
      args.push(query.folder + '/');
    }
    const baseWhere = clauses.join(' AND '),
      found = new Map<string, Snapshot>();
    let truncated = false;
    const considered = new Set<string>();
    const equivalents = (ids: string[]) => [
      ...new Set([
        ...ids,
        ...Object.keys(portable.merges).filter((id) => ids.includes(canonical(portable, id))),
      ]),
    ];
    const select = (extra: string, values: unknown[], limit = MAX_SOURCES + 1) =>
      db
        .prepare(
          `SELECT ${SOURCE_METADATA},length(CAST(s.data AS BLOB)) AS data_bytes FROM graph_analysis_sources s JOIN notes n ON n.id=s.note_id WHERE ${baseWhere} AND (${extra}) ORDER BY n.rowid LIMIT ?`,
        )
        .all(...args, ...values, limit) as SnapshotMetadata[];
    function add(rows: SnapshotMetadata[]) {
      for (const row of rows) {
        if (considered.has(row.id)) continue;
        considered.add(row.id);
        if (found.size >= MAX_SOURCES) {
          truncated = true;
          break;
        }
        if (!access.allowed(p, row.path)) continue;
        if (row.config_hash !== model.fingerprint() || !access.valid(row)) {
          worker.enqueue(row.id);
          continue;
        }
        const remaining = MAX_SOURCE_JSON_BYTES - budget.used;
        if ((row.data_bytes ?? 0) > remaining) {
          truncated = true;
          continue;
        }
        // The SQL predicate rechecks the actual byte size so a concurrent replacement
        // cannot exceed the budget between the metadata page and payload read.
        const payload = db
          .prepare(
            'SELECT data,length(CAST(data AS BLOB)) AS bytes FROM graph_analysis_sources WHERE note_id=? AND fingerprint=? AND config_hash=? AND source_revision IS ? AND managed_hash IS ? AND length(CAST(data AS BLOB))<=?',
          )
          .get(
            row.id,
            row.fingerprint,
            row.config_hash,
            row.source_revision,
            row.managed_hash,
            remaining,
          ) as { data: string; bytes: number } | undefined;
        if (!payload) {
          truncated = true;
          continue;
        }
        budget.used += payload.bytes;
        found.set(row.id, { ...row, analysis: JSON.parse(payload.data) });
      }
    }
    if (additionalNoteIds.length && query.focus) {
      const ids = equivalents([query.focus, ...(query.target ? [query.target] : [])]);
      add(select('n.id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)]));
      add(
        select(
          'EXISTS(SELECT 1 FROM graph_analysis_lookup l WHERE l.note_id=n.id AND l.node_id IN (SELECT value FROM json_each(?)))',
          [JSON.stringify(ids)],
        ),
      );
    }
    if (additionalNoteIds.length)
      add(select('n.id IN (SELECT value FROM json_each(?))', [JSON.stringify(additionalNoteIds)]));
    if (anchors) {
      for (const anchor of anchors)
        add(
          select(
            'EXISTS(SELECT 1 FROM graph_analysis_lookup l WHERE l.note_id=n.id AND l.node_id=?)',
            [anchor],
            1,
          ),
        );
      add(
        select(
          'EXISTS(SELECT 1 FROM graph_analysis_lookup l WHERE l.note_id=n.id AND l.node_id IN (SELECT value FROM json_each(?)))',
          [JSON.stringify(anchors)],
        ),
      );
    } else if (query.focus) {
      const anchors = equivalents([query.focus, ...(query.target ? [query.target] : [])]);
      // Put exact note endpoints first so a broad shared concept cannot crowd them out.
      add(select('n.id IN (SELECT value FROM json_each(?))', [JSON.stringify(anchors)]));
      add(
        select(
          'EXISTS(SELECT 1 FROM graph_analysis_lookup l WHERE l.note_id=n.id AND l.node_id IN (SELECT value FROM json_each(?)))',
          [JSON.stringify(anchors)],
        ),
      );
      for (
        let hop = 0;
        hop < (query.target ? 8 : (query.depth ?? 1)) && found.size < MAX_SOURCES;
        hop++
      ) {
        const rows = [...found.values()],
          ids = rows.map((r) => r.id),
          paths = rows.flatMap((r) => r.analysis.links),
          ownPaths = rows.map((r) => r.path);
        const entities =
          query.view === 'notes'
            ? []
            : equivalents(
                [
                  ...new Set(
                    rows.flatMap((r) => r.analysis.entities.map((e) => canonical(portable, e.id))),
                  ),
                ].slice(0, 6000),
              );
        const before = found.size;
        if (query.view !== 'notes') {
          const reachable = new Set(entities.map((id) => canonical(portable, id)));
          const connections = portable.manual.filter(
            (edge) =>
              reachable.has(canonical(portable, edge.source)) ||
              reachable.has(canonical(portable, edge.target)),
          );
          // A manual edge is traversable only when its evidence note is visible and current.
          add(
            select('n.id IN (SELECT value FROM json_each(?))', [
              JSON.stringify([...new Set(connections.map((edge) => edge.noteId))]),
            ]),
          );
          const endpoints = equivalents([
            ...new Set(
              connections
                .filter((edge) => found.has(edge.noteId))
                .flatMap((edge) => [
                  canonical(portable, edge.source),
                  canonical(portable, edge.target),
                ]),
            ),
          ]);
          if (endpoints.length)
            add(
              select(
                'EXISTS(SELECT 1 FROM graph_analysis_lookup l WHERE l.note_id=n.id AND l.node_id IN (SELECT value FROM json_each(?)))',
                [JSON.stringify(endpoints)],
              ),
            );
        }
        add(
          select(
            `n.id NOT IN (SELECT value FROM json_each(?)) AND (n.path IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM graph_analysis_links l WHERE l.note_id=n.id AND l.target_path IN (SELECT value FROM json_each(?))) OR EXISTS(SELECT 1 FROM graph_analysis_lookup l WHERE l.note_id=n.id AND l.node_id IN (SELECT value FROM json_each(?))))`,
            [
              JSON.stringify(ids),
              JSON.stringify(paths),
              JSON.stringify(ownPaths),
              JSON.stringify(entities),
            ],
            MAX_SOURCES - found.size + 1,
          ),
        );
        if (found.size === before) break;
      }
    } else if (query.q?.trim()) {
      const needle = query.q.trim().toLowerCase(),
        aliasIds = equivalents(
          Object.entries(portable.aliases)
            .filter(([, aliases]) => aliases.some((a) => a.toLowerCase().includes(needle)))
            .map(([id]) => id),
        );
      add(
        select(
          `dooknow_search_contains(n.path,?)=1 OR EXISTS(SELECT 1 FROM graph_analysis_lookup l WHERE l.note_id=n.id AND (dooknow_search_contains(l.search_text,?)=1 OR l.node_id IN (SELECT value FROM json_each(?))))`,
          [needle, needle, JSON.stringify(aliasIds)],
        ),
      );
    } else add(select('1', []));
    return { rows: [...found.values()], truncated };
  }
  function portableFor(p: Principal): Portable {
    const saved = state.read();
    // Unanchored owner annotations are private; manual relations have explicit note anchors.
    return p.id === 'web-owner'
      ? saved
      : {
          ...saved,
          merges: {},
          aliases: {},
          decisions: Object.fromEntries(
            Object.entries(saved.decisions).map(([id, value]) => [
              id,
              { decision: value.decision },
            ]),
          ),
        };
  }
  function similaritySeeds(p: Principal, query: GraphExploreQuery): string[] | undefined {
    if (!query.focus && !query.q?.trim()) return;
    const portable = portableFor(p),
      filter = acl(p),
      ids = [query.focus, query.target].filter((id): id is string => !!id),
      needle = query.q?.trim().toLowerCase() ?? '';
    if (!query.focus)
      ids.push(
        ...Object.entries(portable.aliases)
          .filter(([, aliases]) => aliases.some((a) => a.toLowerCase().includes(needle)))
          .map(([id]) => id),
      );
    const equivalents = [
      ...new Set([
        ...ids,
        ...Object.keys(portable.merges).filter((id) => ids.includes(canonical(portable, id))),
      ]),
    ];
    // Seed discovery reads only principal-scoped metadata. The adapter validates source currency.
    const seeds = (
      db
        .prepare(
          `SELECT n.id FROM notes n WHERE n.active=1 AND (${filter.sql}) AND (?='' OR instr(n.path,?)=1) AND (n.id IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM graph_analysis_lookup l WHERE l.note_id=n.id AND (l.node_id IN (SELECT value FROM json_each(?)) OR (?<>'' AND dooknow_search_contains(l.search_text,?)=1))) OR (?<>'' AND dooknow_search_contains(n.path,?)=1)) ORDER BY CASE WHEN n.id=? THEN 0 WHEN n.id=? THEN 1 ELSE 2 END,n.rowid LIMIT ?`,
        )
        .all(
          ...filter.args,
          query.folder ?? '',
          query.folder ? query.folder + '/' : '',
          JSON.stringify(equivalents),
          JSON.stringify(equivalents),
          query.focus ? '' : needle,
          needle,
          query.focus ? '' : needle,
          needle,
          query.focus ?? '',
          query.target ?? '',
          MAX_SOURCES,
        ) as { id: string }[]
    ).map((row) => row.id);
    if (
      !query.focus ||
      (!query.target && (query.depth ?? 1) < 2) ||
      (query.edgeKinds?.length && !query.edgeKinds.includes('reference')) ||
      (query.nodeKinds?.length && !query.nodeKinds.includes('note'))
    )
      return seeds;
    // A reference can consume the first graph hop before a similarity edge. Discover
    // that frontier from indexed links, without parsing the source analysis twice.
    const currentSources = (extra: string, values: string[]) =>
      (
        db
          .prepare(
            `SELECT ${SOURCE_METADATA} FROM graph_analysis_sources s JOIN notes n ON n.id=s.note_id WHERE n.active=1 AND (${filter.sql}) AND (?='' OR instr(n.path,?)=1) AND s.config_hash=? AND (${extra}) ORDER BY n.rowid LIMIT ?`,
          )
          .all(
            ...filter.args,
            query.folder ?? '',
            query.folder ? query.folder + '/' : '',
            model.fingerprint(),
            ...values,
            MAX_SOURCES,
          ) as SnapshotMetadata[]
      ).filter((row) => access.allowed(p, row.path) && access.valid(row));
    const anchors = currentSources('n.id IN (SELECT value FROM json_each(?))', [
      JSON.stringify(seeds),
    ]);
    if (!anchors.length) return seeds;
    const outgoing = (
      db
        .prepare(
          `SELECT n.id,n.path FROM notes n WHERE n.active=1 AND (${filter.sql}) AND (?='' OR instr(n.path,?)=1) AND n.path IN (SELECT l.target_path FROM graph_analysis_links l WHERE l.note_id IN (SELECT value FROM json_each(?))) ORDER BY n.rowid LIMIT ?`,
        )
        .all(
          ...filter.args,
          query.folder ?? '',
          query.folder ? query.folder + '/' : '',
          JSON.stringify(anchors.map((row) => row.id)),
          MAX_SOURCES,
        ) as { id: string; path: string }[]
    ).filter((row) => access.allowed(p, row.path) && access.current(row.id)?.path === row.path);
    const incoming = currentSources(
      'EXISTS(SELECT 1 FROM graph_analysis_links l WHERE l.note_id=n.id AND l.target_path IN (SELECT value FROM json_each(?)))',
      [JSON.stringify(anchors.map((row) => row.path))],
    );
    // Preparation applies its smaller seed budget and explicitly reports truncation.
    return [
      ...new Set([...seeds, ...outgoing.map((row) => row.id), ...incoming.map((row) => row.id)]),
    ];
  }
  function aggregate(
    p: Principal,
    query: GraphExploreQuery = {},
    includeIgnored = false,
    anchors?: string[],
    budget: ReadBudget = { used: 0 },
    plan?: GraphVectorSimilarityPlan,
  ) {
    const portable = portableFor(p),
      source = snapshots(p, query, portable, anchors, budget, plan?.noteIds);
    if (anchors?.every((id) => id.startsWith('relation:'))) {
      const ids = new Set(anchors),
        endpoints = new Set(
          source.rows.flatMap((r) =>
            r.analysis.relations.filter((e) => ids.has(e.id)).flatMap((e) => [e.source, e.target]),
          ),
        );
      for (const row of source.rows)
        row.analysis = {
          ...row.analysis,
          entities: row.analysis.entities.filter((e) => endpoints.has(e.id)),
          relations: row.analysis.relations.filter((e) => ids.has(e.id)),
          links: [],
        };
    }
    const nodes = new Map<string, GraphKnowledgeNode>(),
      edges = new Map<string, GraphKnowledgeEdge>(),
      ignored = new Set<string>();
    let truncated = source.truncated || !!plan?.truncated;
    const base = (
      id: string,
      title: string,
      kind: GraphKnowledgeNode['kind'],
      relativePath = '',
    ): GraphKnowledgeNode => ({
      id,
      title,
      kind,
      relativePath,
      directory: relativePath.includes('/')
        ? relativePath.slice(0, relativePath.lastIndexOf('/'))
        : '',
      incoming: 0,
      outgoing: 0,
      sourceCount: 0,
      evidence: [],
    });
    function evidenceInto(target: GraphEvidence[], evidence: GraphEvidence[]) {
      for (const e of evidence)
        if (target.length < 12 && !target.some((x) => x.id === e.id)) target.push(e);
    }
    const sourceIds = new Map<string, Set<string>>();
    function addNode(node: GraphKnowledgeNode, noteId: string) {
      const previous = nodes.get(node.id);
      if (previous) {
        evidenceInto(previous.evidence, node.evidence);
        previous.aliases = [
          ...new Set([...(previous.aliases ?? []), ...(node.aliases ?? [])]),
        ].slice(0, 32);
      } else if (nodes.size < MAX_NODES) nodes.set(node.id, node);
      else {
        truncated = true;
        return;
      }
      const ids = sourceIds.get(node.id) ?? new Set<string>();
      ids.add(noteId);
      sourceIds.set(node.id, ids);
      nodes.get(node.id)!.sourceCount = ids.size;
    }
    function addEdge(edge: GraphKnowledgeEdge) {
      if (edge.source === edge.target || !nodes.has(edge.source) || !nodes.has(edge.target)) return;
      const prev = edges.get(edge.id);
      if (prev) {
        evidenceInto(prev.evidence, edge.evidence);
        prev.confidence = Math.max(prev.confidence, edge.confidence);
      } else if (edges.size < MAX_EDGES) edges.set(edge.id, edge);
      else truncated = true;
    }
    for (const row of source.rows) {
      const note = base(row.id, row.analysis.title, 'note', row.path);
      note.evidence = row.analysis.entities.flatMap((e) => e.evidence).slice(0, 4);
      addNode(note, row.id);
      for (const entity of row.analysis.entities) {
        const id = canonical(portable, entity.id),
          node = base(id, entity.name, entity.kind);
        node.description = entity.description;
        node.aliases = [...new Set([...entity.aliases, ...(portable.aliases[id] ?? [])])];
        node.evidence = entity.evidence.slice();
        addNode(node, row.id);
      }
    }
    // Prepared vector nodes are source-validated even without entity-analysis snapshots.
    // Copy request data before rendering mutates counts, evidence and communities.
    for (const node of plan?.nodes ?? [])
      if (!query.folder || node.relativePath.startsWith(query.folder + '/'))
        addNode(
          { ...node, incoming: 0, outgoing: 0, evidence: node.evidence.map((e) => ({ ...e })) },
          node.id,
        );
    // An explicitly chosen merge target gets its visible label, never metadata from a hidden source.
    for (const row of source.rows)
      for (const entity of row.analysis.entities) {
        const id = canonical(portable, entity.id);
        if (entity.id === id && nodes.has(id)) {
          nodes.get(id)!.title = entity.name;
          nodes.get(id)!.kind = entity.kind;
        }
      }
    const byPath = new Map(
      [...nodes.values()]
        .filter((node) => node.kind === 'note')
        .map((node) => [node.relativePath, node.id]),
    );
    for (const row of source.rows) {
      for (const entity of row.analysis.entities) {
        const id = canonical(portable, entity.id);
        addEdge({
          id: 'mentions:' + hash(row.id + '\0' + id).slice(0, 24),
          source: row.id,
          target: id,
          kind: 'mentions',
          label: '提及',
          status: 'accepted',
          confidence: 1,
          evidence: entity.evidence.slice(),
        });
      }
      for (const relation of row.analysis.relations) {
        const decision = portable.decisions[relation.id];
        if (decision?.decision === 'ignore') {
          ignored.add(relation.id);
          if (!includeIgnored) continue;
        }
        addEdge({
          id: relation.id,
          source: canonical(portable, relation.source),
          target: canonical(portable, relation.target),
          kind: relation.method === 'model' ? 'semantic' : 'cooccurs',
          label: decision?.predicate ?? relation.predicate,
          status:
            decision?.decision === 'accept' || relation.method === 'local'
              ? 'accepted'
              : 'suggested',
          confidence: relation.confidence,
          evidence: relation.evidence.slice(),
        });
      }
      for (const path of row.analysis.links) {
        const target = byPath.get(path);
        if (target)
          addEdge({
            id: 'reference:' + hash(row.id + '\0' + target).slice(0, 24),
            source: row.id,
            target,
            kind: 'reference',
            label: '引用',
            status: 'accepted',
            confidence: 1,
            evidence: row.analysis.linkEvidence?.[path] ?? [],
          });
      }
    }
    for (const manual of portable.manual) {
      const row = source.rows.find((r) => r.id === manual.noteId);
      if (!row) continue;
      const evidence = row.analysis.entities
        .flatMap((e) => e.evidence)
        .slice(0, 1)
        .map((e) => ({ ...e, method: 'manual' as const }));
      if (!evidence.length) continue;
      addEdge({
        id: manual.id,
        source: canonical(portable, manual.source),
        target: canonical(portable, manual.target),
        kind: 'manual',
        label: manual.predicate,
        status: 'manual',
        confidence: 1,
        evidence,
      });
    }
    for (const edge of plan?.edges ?? [])
      addEdge({ ...edge, evidence: edge.evidence.map((e) => ({ ...e })) });
    return { nodes, edges, ignored, source, portable, truncated };
  }
  function fence(graph: ReturnType<typeof aggregate>) {
    access.barrier();
    for (const row of graph.source.rows)
      if (row.config_hash !== model.fingerprint() || !access.valid(row)) {
        worker.enqueue(row.id);
        fail(409, 'GRAPH_CHANGED');
      }
  }
  function statusInternal(
    p: Principal,
    existing?: ReturnType<typeof aggregate>,
  ): GraphAnalysisStatus {
    const filter = acl(p),
      portable = state.read();
    // Both endpoint responses observe the same principal-wide metadata. Polling does
    // not parse derived JSON or synchronously re-stat the library; explore fences its sources.
    const sourceRows = db
      .prepare(
        `SELECT ${SOURCE_METADATA} FROM graph_analysis_sources s JOIN notes n ON n.id=s.note_id WHERE n.active=1 AND (${filter.sql}) ORDER BY n.rowid LIMIT ?`,
      )
      .all(...filter.args, MAX_SOURCES) as SnapshotMetadata[];
    const where = `n.active=1 AND lower(n.path) LIKE '%.md' AND instr(n.path,'_data/')<>1 AND (${filter.sql})`;
    const counts = db
      .prepare(
        `SELECT count(*) AS total,coalesce(sum(j.state='done'),0) AS completed,coalesce(sum(j.state='failed'),0) AS failed,coalesce(sum(j.state='running'),0) AS running FROM notes n LEFT JOIN graph_analysis_jobs j ON j.note_id=n.id WHERE ${where}`,
      )
      .get(...filter.args) as { total: number; completed: number; failed: number; running: number };
    const { completed, failed, running } = counts,
      pending = counts.total - completed - failed - running;
    const settings = model.settings();
    const suggested = (
      db
        .prepare(
          `SELECT count(DISTINCT c.id) AS count FROM graph_analysis_candidates c JOIN notes n ON n.id=c.note_id JOIN graph_analysis_sources s ON s.note_id=n.id LEFT JOIN document_state d ON d.note_id=n.id WHERE ${where} AND n.path=s.path AND s.config_hash=? AND coalesce(d.active,1)=1 AND coalesce(d.conflict,0)=0 AND d.source_revision IS s.source_revision AND d.content_hash IS s.managed_hash AND NOT EXISTS(SELECT 1 FROM write_intents w WHERE w.note_id=n.id AND w.status IN ('prepared','conflicted')) AND NOT EXISTS(SELECT 1 FROM file_operations f WHERE f.note_id=n.id AND f.status IN ('queued','running','committing','needs_reconciliation')) AND c.id NOT IN (SELECT key FROM json_each(?))`,
        )
        .get(...filter.args, model.fingerprint(), JSON.stringify(portable.decisions)) as {
        count: number;
      }
    ).count;
    const errors = (
      db
        .prepare(
          `SELECT n.id,n.path,j.error FROM notes n JOIN graph_analysis_jobs j ON j.note_id=n.id WHERE ${where} AND j.error IS NOT NULL ORDER BY n.rowid LIMIT 20`,
        )
        .all(...filter.args) as { id: string; path: string; error: string }[]
    )
      .filter((r) => access.allowed(p, r.path) && access.current(r.id))
      .map((r) => ({
        noteId: r.id,
        title:
          existing?.source.rows.find((s) => s.id === r.id)?.analysis.title ??
          r.path.split('/').at(-1)!,
        code: r.error,
      }));
    const visibleDecisions =
      p.id === 'web-owner'
        ? []
        : (
            db
              .prepare(
                `SELECT DISTINCT c.id FROM graph_analysis_candidates c JOIN notes n ON n.id=c.note_id WHERE n.active=1 AND (${filter.sql}) AND c.id IN (SELECT key FROM json_each(?)) ORDER BY c.id LIMIT 5000`,
              )
              .all(...filter.args, JSON.stringify(portable.decisions)) as { id: string }[]
          ).map((r) => [r.id, portable.decisions[r.id].decision]);
    const lastUpdatedAt =
      (
        db
          .prepare(
            `SELECT max(s.updated_at) AS latest FROM graph_analysis_sources s JOIN notes n ON n.id=s.note_id WHERE n.active=1 AND (${filter.sql}) AND s.config_hash=?`,
          )
          .get(...filter.args, model.fingerprint()) as { latest: string | null }
      ).latest ?? undefined;
    const similarityStatus = similarity.status(p);
    const revision = hash(
      JSON.stringify([
        sourceRows.map((r) => [r.id, r.fingerprint, r.config_hash]),
        p.id === 'web-owner' ? portable.version : visibleDecisions,
        completed,
        pending,
        failed,
        running,
        settings.version,
        suggested,
        lastUpdatedAt,
        similarityStatus.revision,
      ]),
    ).slice(0, 24);
    if (existing) fence(existing);
    else access.barrier();
    return {
      state:
        worker.paused() || (!settings.automatic && !worker.manual())
          ? 'paused'
          : running
            ? 'running'
            : pending
              ? 'queued'
              : failed
                ? 'failed'
                : settings.provider === 'none'
                  ? 'waiting-model'
                  : 'idle',
      automatic: settings.automatic,
      modelReady: settings.provider !== 'none' && !!settings.model,
      provider: settings.provider,
      total: counts.total,
      completed,
      pending,
      failed,
      running,
      suggested,
      revision,
      lastUpdatedAt,
      errors,
      similarity: similarityStatus,
    };
  }
  function render(
    p: Principal,
    input: GraphExploreQuery,
    query: GraphExploreQuery,
    plan?: GraphVectorSimilarityPlan,
  ): GraphKnowledgeResponse {
    const graph = aggregate(p, query, false, undefined, undefined, plan),
      needle = query.q?.trim().toLowerCase();
    let nodes = [...graph.nodes.values()].filter(
      (n) =>
        (query.view !== 'notes' || n.kind === 'note') &&
        (!query.nodeKinds?.length || query.nodeKinds.includes(n.kind)) &&
        (!needle ||
          (n.title + ' ' + n.relativePath + ' ' + (n.aliases ?? []).join(' '))
            .toLowerCase()
            .includes(needle)),
    );
    let chosen = new Set(nodes.map((n) => n.id));
    let edges = [...graph.edges.values()].filter(
      (e) =>
        chosen.has(e.source) &&
        chosen.has(e.target) &&
        (!query.edgeKinds?.length || query.edgeKinds.includes(e.kind)) &&
        (query.includeSuggested !== false || e.kind !== 'semantic' || e.status !== 'suggested') &&
        (e.kind === 'similarity' || e.confidence >= (query.minConfidence ?? 0)),
    );
    const adjacent = new Map<string, Set<string>>();
    for (const e of edges) {
      for (const [a, b] of [
        [e.source, e.target],
        [e.target, e.source],
      ]) {
        const set = adjacent.get(a) ?? new Set<string>();
        set.add(b);
        adjacent.set(a, set);
      }
    }
    let path: string[] | undefined;
    if (query.focus) {
      if (!chosen.has(query.focus)) fail(404, 'GRAPH_NODE_NOT_FOUND');
      if (query.target) {
        if (!chosen.has(query.target)) fail(404, 'GRAPH_NODE_NOT_FOUND');
        const previous = new Map<string, string | undefined>([[query.focus, undefined]]),
          queue = [query.focus];
        for (let i = 0; i < queue.length && !previous.has(query.target); i++)
          for (const id of adjacent.get(queue[i]) ?? [])
            if (!previous.has(id)) {
              previous.set(id, queue[i]);
              queue.push(id);
            }
        path = [];
        if (previous.has(query.target)) {
          let at: string | undefined = query.target;
          while (at) {
            path.unshift(at);
            at = previous.get(at);
          }
        }
        chosen = new Set(path);
      } else {
        chosen = new Set([query.focus]);
        let frontier = [query.focus];
        for (let depth = 0; depth < query.depth!; depth++) {
          const next: string[] = [];
          for (const at of frontier)
            for (const id of adjacent.get(at) ?? [])
              if (!chosen.has(id)) {
                chosen.add(id);
                next.push(id);
              }
          frontier = next;
        }
      }
      nodes = nodes.filter((n) => chosen.has(n.id));
      edges = edges.filter((e) => chosen.has(e.source) && chosen.has(e.target));
    } else if (query.target) fail(400, 'PATH_REQUIRES_FOCUS');
    for (const e of edges) {
      graph.nodes.get(e.source)!.outgoing++;
      graph.nodes.get(e.target)!.incoming++;
    }
    if (query.mode === 'orphans') {
      nodes = nodes.filter((n) => !n.incoming && !n.outgoing);
      edges = [];
    }
    // Connected components are bounded, deterministic topological communities (not semantic claims).
    const visible = new Set(nodes.map((n) => n.id)),
      visited = new Set<string>();
    for (const node of nodes)
      if (!visited.has(node.id)) {
        const queue = [node.id],
          community = 'community:' + hash(node.id).slice(0, 8);
        visited.add(node.id);
        for (let i = 0; i < queue.length; i++) {
          graph.nodes.get(queue[i])!.community = community;
          for (const id of adjacent.get(queue[i]) ?? [])
            if (visible.has(id) && !visited.has(id)) {
              visited.add(id);
              queue.push(id);
            }
        }
      }
    nodes.sort(
      (a, b) =>
        Number(b.id === query.focus) - Number(a.id === query.focus) ||
        b.incoming + b.outgoing - (a.incoming + a.outgoing) ||
        a.title.localeCompare(b.title),
    );
    const totalNodes = nodes.length,
      totalEdges = edges.length;
    nodes = nodes.slice(0, query.limit);
    const selected = new Set(nodes.map((n) => n.id));
    edges = edges
      .filter((e) => selected.has(e.source) && selected.has(e.target))
      .slice(0, input.limit ? Math.min(5000, query.limit! * 5) : 120);
    const status = statusInternal(p, graph);
    return {
      nodes,
      edges,
      totalNodes,
      totalEdges,
      truncated: graph.truncated || nodes.length < totalNodes || edges.length < totalEdges,
      ...(query.focus ? { focus: query.focus } : {}),
      ...(path ? { path } : {}),
      status,
      ...(plan ? { similarity: plan.status } : {}),
      index: {
        scanned: graph.source.rows.length,
        indexed: status.completed,
        skipped: status.failed,
        pending: status.pending + status.running,
        complete:
          status.pending === 0 &&
          status.running === 0 &&
          status.failed === 0 &&
          !graph.truncated &&
          (!plan || plan.status.state === 'ready'),
      },
    };
  }
  function reviewInternal(p: Principal, input: GraphReviewQuery) {
    if (
      (input.status !== undefined &&
        !['suggested', 'accepted', 'ignored', 'manual'].includes(input.status)) ||
      (input.limit !== undefined &&
        (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))
    )
      fail(400, 'INVALID_INPUT');
    if (
      (input.offset !== undefined &&
        (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 10000)) ||
      (input.q !== undefined && (typeof input.q !== 'string' || input.q.length > 256))
    )
      fail(400, 'INVALID_INPUT');
    const portable = state.read(),
      filter = acl(p),
      wantedStatus = input.status ?? 'suggested';
    const decisions = JSON.stringify(
      p.id === 'web-owner'
        ? portable.decisions
        : Object.fromEntries(
            Object.entries(portable.decisions).map(([id, v]) => [id, { decision: v.decision }]),
          ),
    );
    let selected: string[] | undefined;
    if (wantedStatus !== 'manual') {
      const rows = db
        .prepare(
          `WITH visible AS (SELECT c.*,coalesce(json_extract(?, '$."'||c.id||'".decision'),'suggested') AS decision,coalesce(json_extract(?, '$."'||c.id||'".predicate'),c.predicate) AS label FROM graph_analysis_candidates c JOIN notes n ON n.id=c.note_id JOIN graph_analysis_sources s ON s.note_id=n.id LEFT JOIN document_state d ON d.note_id=n.id WHERE n.active=1 AND (${filter.sql}) AND n.path=s.path AND s.config_hash=? AND coalesce(d.active,1)=1 AND coalesce(d.conflict,0)=0 AND d.source_revision IS s.source_revision AND d.content_hash IS s.managed_hash AND NOT EXISTS(SELECT 1 FROM write_intents w WHERE w.note_id=n.id AND w.status IN ('prepared','conflicted')) AND NOT EXISTS(SELECT 1 FROM file_operations f WHERE f.note_id=n.id AND f.status IN ('queued','running','committing','needs_reconciliation'))) SELECT id,max(confidence) AS confidence FROM visible c WHERE decision=? AND (?='' OR dooknow_search_contains(label,?)=1 OR EXISTS(SELECT 1 FROM graph_analysis_lookup l WHERE l.note_id=c.note_id AND l.node_id IN (c.source,c.target) AND dooknow_search_contains(l.search_text,?)=1)) GROUP BY id ORDER BY confidence DESC,id LIMIT ? OFFSET ?`,
        )
        .all(
          decisions,
          decisions,
          ...filter.args,
          model.fingerprint(),
          wantedStatus === 'accepted'
            ? 'accept'
            : wantedStatus === 'ignored'
              ? 'ignore'
              : 'suggested',
          input.q?.toLowerCase() ?? '',
          input.q?.toLowerCase() ?? '',
          input.q?.toLowerCase() ?? '',
          input.limit ?? 50,
          input.offset ?? 0,
        ) as { id: string }[];
      selected = rows.map((r) => r.id);
    }
    const graph = aggregate(p, input.q ? { q: input.q } : {}, true, selected),
      items: GraphReviewItem[] = [];
    for (const edge of graph.edges.values()) {
      if (edge.kind !== 'semantic' && edge.kind !== 'manual') continue;
      const a = graph.nodes.get(edge.source)!,
        b = graph.nodes.get(edge.target)!;
      if (a.kind === 'note' || b.kind === 'note') continue;
      const status = graph.ignored.has(edge.id) ? 'ignored' : edge.status;
      if (status !== (input.status ?? 'suggested')) continue;
      if (
        input.q &&
        !(edge.label + ' ' + a.title + ' ' + b.title).toLowerCase().includes(input.q.toLowerCase())
      )
        continue;
      items.push({
        id: edge.id,
        source: { id: a.id, name: a.title, kind: a.kind },
        target: { id: b.id, name: b.title, kind: b.kind },
        predicate: edge.label,
        confidence: edge.confidence,
        status,
        evidence: edge.evidence,
      });
    }
    fence(graph);
    return items
      .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
      .slice(
        selected ? 0 : (input.offset ?? 0),
        selected ? (input.limit ?? 50) : (input.offset ?? 0) + (input.limit ?? 50),
      );
  }
  return {
    start() {
      worker.start();
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([worker.close(), similarity.close()]);
    },
    async explore(p: Principal, query: GraphExploreQuery = {}) {
      authorize(p);
      if (queued >= 8) fail(429, 'GRAPH_BUSY');
      queued++;
      try {
        return await workspaceRead(db, { kind: 'graph.explore' }, async () => {
          authorize(p);
          const validated = validateQuery(query),
            plan = validated.includeSimilarity
              ? await similarity.prepare(p, validated, similaritySeeds(p, validated))
              : undefined;
          const response = render(p, query, validated, plan);
          if (plan) similarity.assertFresh(p, plan);
          return response;
        });
      } finally {
        queued--;
      }
    },
    status(p: Principal) {
      return workspaceReadSync(db, { kind: 'graph.status' }, () => {
        authorize(p);
        return statusInternal(p);
      });
    },
    control(p: Principal, input: { action: 'pause' | 'resume' | 'retry' | 'rebuild' | 'cancel' }) {
      return workspaceWriteSync(db, { kind: 'graph.control' }, () => {
        authorize(p, true);
        if (!input || !['pause', 'resume', 'retry', 'rebuild', 'cancel'].includes(input.action))
          fail(400, 'INVALID_INPUT');
        worker.control(input.action);
        return statusInternal(p);
      });
    },
    review(p: Principal, input: GraphReviewQuery = {}) {
      return workspaceReadSync(db, { kind: 'graph.review' }, () => {
        authorize(p);
        return reviewInternal(p, input);
      });
    },
    userState(p: Principal) {
      return workspaceReadSync(db, { kind: 'graph.state' }, () => {
        authorize(p, true);
        return state.user();
      });
    },
    command(p: Principal, input: GraphUserCommand) {
      return workspaceWriteSync(db, { kind: 'graph.command' }, () => {
        authorize(p, true);
        return state.command(input, (command) => {
          const focus =
            command.action === 'review'
              ? command.id
              : command.action === 'merge'
                ? command.from
                : command.action === 'alias'
                  ? command.entityId
                  : command.action === 'manual-relation'
                    ? command.source
                    : undefined;
          const target =
            command.action === 'merge'
              ? command.into
              : command.action === 'manual-relation'
                ? command.noteId
                : undefined;
          const graph =
              command.action === 'manual-relation'
                ? aggregate(p, {}, true, [command.source, command.target, command.noteId])
                : aggregate(p, focus ? { focus, target } : {}, true),
            has = (id: string) => {
              if (!graph.nodes.has(id) || graph.nodes.get(id)!.kind === 'note')
                fail(404, 'GRAPH_NODE_NOT_FOUND');
            };
          if (command.action === 'review') {
            if (
              !graph.edges.has(command.id) ||
              !['semantic', 'cooccurs'].includes(graph.edges.get(command.id)!.kind)
            )
              fail(404, 'GRAPH_RELATION_NOT_FOUND');
          }
          if (command.action === 'merge') {
            has(command.from);
            has(command.into);
          }
          if (command.action === 'alias') has(command.entityId);
          if (command.action === 'manual-relation') {
            has(command.source);
            has(command.target);
            if (!graph.source.rows.some((r) => r.id === command.noteId))
              fail(404, 'NOTE_NOT_FOUND');
          }
        });
      });
    },
    async questionContext(p: Principal, input: GraphQuestionInput): Promise<GraphEvidence[]> {
      authorize(p);
      if (
        !input ||
        typeof input.question !== 'string' ||
        !input.question.trim() ||
        input.question.length > 2000 ||
        (input.nodeId !== undefined &&
          (typeof input.nodeId !== 'string' || input.nodeId.length > 256))
      )
        fail(400, 'INVALID_INPUT');
      return workspaceRead(db, { kind: 'graph.question' }, async () => {
        authorize(p);
        const wanted = new Set(terms(input.question).map((t) => t.toLowerCase())),
          evidence = new Map<string, GraphEvidence>();
        const queries = input.nodeId
          ? [{ focus: input.nodeId }]
          : [...wanted].slice(0, 8).map((q) => ({ q }));
        const budget: ReadBudget = { used: 0 };
        for (const query of queries) {
          const graph = aggregate(p, query, false, undefined, budget);
          if (input.nodeId && !graph.nodes.has(input.nodeId)) fail(404, 'GRAPH_NODE_NOT_FOUND');
          const candidates = input.nodeId
            ? [graph.nodes.get(input.nodeId)!]
            : [...graph.nodes.values()].filter((n) =>
                terms(n.title + ' ' + (n.aliases ?? []).join(' ')).some((t) =>
                  wanted.has(t.toLowerCase()),
                ),
              );
          for (const node of candidates)
            for (const item of node.evidence) if (evidence.size < 16) evidence.set(item.id, item);
          fence(graph);
          if (evidence.size >= 12) break;
        }
        return [...evidence.values()].slice(0, 12);
      });
    },
  };
}
export type KnowledgeGraphService = ReturnType<typeof createKnowledgeGraph>;
