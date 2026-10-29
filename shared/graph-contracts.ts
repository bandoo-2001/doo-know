/** Read-only, explicit Markdown/Wiki references. Counts use the selected authorized scope. */
export type GraphQuery = {
  folder?: string;
  q?: string;
  focus?: string;
  depth?: 1 | 2;
  mode?: 'all' | 'orphans';
  limit?: number;
};
export type GraphNode = {
  id: string;
  title: string;
  relativePath: string;
  directory: string;
  incoming: number;
  outgoing: number;
};
export type GraphEdge = { id: string; source: string; target: string };
export type KnowledgeGraphResponse = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
  focus?: string;
  index: { scanned: number; indexed: number; skipped: number; pending: number; complete: boolean };
};
