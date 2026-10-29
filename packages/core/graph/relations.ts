import type { GraphQuery, GraphNode, GraphEdge } from '../../../shared/graph-contracts.js';

type Source = { id: string; path: string; title: string };
type Checkpoint = () => Promise<void>;
// At most 8192 targets between checkpoints, including unresolved targets.
const BATCH_SOURCES = 16;

/** Resolve each JSON list once, retaining compact indices rather than edge objects. */
export async function buildRelations(
  rows: Source[],
  targetsFor: (row: Source) => string,
  checkpoint: Checkpoint,
) {
  const byPath = new Map(rows.map((row, index) => [row.path, index]));
  const adjacency: Uint32Array[] = [];
  for (let source = 0; source < rows.length; source++) {
    const targets: number[] = [];
    for (const path of JSON.parse(targetsFor(rows[source])) as string[]) {
      const target = byPath.get(path);
      if (target !== undefined && target !== source) targets.push(target);
    }
    adjacency.push(Uint32Array.from(targets));
    if ((source + 1) % BATCH_SOURCES === 0) await checkpoint();
  }
  return adjacency;
}

/** Exact induced totals and degrees, independent of the presentation edge cap. */
export async function renderGraph(
  rows: Source[],
  adjacency: Uint32Array[],
  active: Uint8Array,
  query: GraphQuery,
  checkpoint: Checkpoint,
) {
  let selected = active.slice();
  if (query.focus) {
    const reachable = new Uint8Array(rows.length);
    const center = rows.findIndex((row) => row.id === query.focus);
    if (center >= 0 && active[center]) reachable[center] = 1;
    for (let depth = 0; depth < query.depth!; depth++) {
      const previous = reachable.slice();
      for (let source = 0; source < rows.length; source++) {
        if (active[source])
          for (const target of adjacency[source]) {
            if (!active[target]) continue;
            if (previous[source]) reachable[target] = 1;
            if (previous[target]) reachable[source] = 1;
          }
        if ((source + 1) % BATCH_SOURCES === 0) await checkpoint();
      }
    }
    selected = reachable;
  }
  const incoming = new Uint32Array(rows.length),
    outgoing = new Uint32Array(rows.length);
  let totalEdges = 0;
  for (let source = 0; source < rows.length; source++) {
    if (selected[source])
      for (const target of adjacency[source]) {
        if (!selected[target]) continue;
        outgoing[source]++;
        incoming[target]++;
        totalEdges++;
      }
    if ((source + 1) % BATCH_SOURCES === 0) await checkpoint();
  }
  if (query.mode === 'orphans') {
    for (let i = 0; i < rows.length; i++) if (incoming[i] || outgoing[i]) selected[i] = 0;
    totalEdges = 0;
  }
  const ordered = rows.flatMap((_, index) => (selected[index] ? [index] : []));
  if (query.focus)
    ordered.sort((a, b) => Number(rows[b].id === query.focus) - Number(rows[a].id === query.focus));
  const visible = new Uint8Array(rows.length);
  const nodes: GraphNode[] = ordered.slice(0, query.limit).map((index) => {
    visible[index] = 1;
    const row = rows[index];
    return {
      id: row.id,
      title: row.title,
      relativePath: row.path,
      directory: row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : '',
      incoming: incoming[index],
      outgoing: outgoing[index],
    };
  });
  const edges: GraphEdge[] = [];
  for (let source = 0; source < rows.length; source++) {
    if (visible[source])
      for (const target of adjacency[source]) {
        if (!visible[target]) continue;
        const from = rows[source].id,
          to = rows[target].id;
        edges.push({ id: JSON.stringify([from, to]), source: from, target: to });
        if (edges.length >= 5000) break;
      }
    if (edges.length >= 5000) break;
    if ((source + 1) % BATCH_SOURCES === 0) await checkpoint();
  }
  return { nodes, edges, totalNodes: ordered.length, totalEdges };
}
