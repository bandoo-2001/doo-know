import type {
  GraphQuery,
  GraphNode,
  GraphEdge,
  KnowledgeGraphResponse,
} from './graph-contracts.js';

export const graphEntityKinds = [
  'concept',
  'person',
  'organization',
  'place',
  'event',
  'technology',
] as const;
export type GraphEntityKind = (typeof graphEntityKinds)[number];
export type GraphProviderKind = 'none' | 'ollama' | 'openai-compatible';
export type GraphModelSettings = {
  version: number;
  provider: GraphProviderKind;
  baseUrl: string;
  model: string;
  automatic: boolean;
  remoteContentAllowed: boolean;
  apiKeyConfigured: boolean;
  timeoutMs: number;
  maxInputCharacters: number;
  outputFormat?: 'schema' | 'json';
};
export type GraphModelUpdate = Omit<GraphModelSettings, 'version' | 'apiKeyConfigured'> & {
  expectedVersion: number;
  apiKey?: string | null;
};
export type GraphExtractedEntity = {
  name: string;
  kind: GraphEntityKind;
  description?: string;
  aliases?: string[];
  quote: string;
};
export type GraphExtractedRelation = {
  source: string;
  target: string;
  predicate: string;
  description?: string;
  quote: string;
  confidence: number;
};
export type GraphExtraction = {
  entities: GraphExtractedEntity[];
  relations: GraphExtractedRelation[];
};
export type GraphEvidence = {
  id: string;
  noteId: string;
  title: string;
  relativePath: string;
  sourceHash: string;
  sourceRevision: number;
  startLine: number;
  endLine: number;
  quote: string;
  method: 'local' | 'model' | 'manual' | 'embedding';
  model?: string;
  embeddingSpaceId?: string;
  chunkId?: string;
};
export type GraphKnowledgeNode = GraphNode & {
  kind: 'note' | GraphEntityKind;
  description?: string;
  aliases?: string[];
  sourceCount: number;
  community?: string;
  evidence: GraphEvidence[];
};
export type GraphKnowledgeEdge = GraphEdge & {
  kind: 'reference' | 'mentions' | 'cooccurs' | 'similarity' | 'semantic' | 'manual';
  label: string;
  status: 'suggested' | 'accepted' | 'manual';
  confidence: number;
  evidence: GraphEvidence[];
  similarity?: {
    method: 'embedding-cosine';
    score: number;
    spaceId: string;
    dimensions: number;
    aggregation: 'overlap-weighted-mean';
  };
};
export type GraphExploreQuery = Omit<GraphQuery, 'mode'> & {
  view?: 'notes' | 'knowledge';
  mode?: 'all' | 'orphans';
  nodeKinds?: ('note' | GraphEntityKind)[];
  edgeKinds?: GraphKnowledgeEdge['kind'][];
  includeSuggested?: boolean;
  includeSimilarity?: boolean;
  similarityThreshold?: number;
  minConfidence?: number;
  target?: string;
};
export type GraphJobState = 'idle' | 'running' | 'paused' | 'waiting-model' | 'failed' | 'queued';
export type GraphSimilarityStatus = {
  state: 'unconfigured' | 'pending' | 'ready' | 'partial' | 'invalid';
  method: 'embedding';
  spaceId?: string;
  dimensions?: number;
  readyNotes: number;
  totalNotes: number;
  pendingNotes: number;
  invalidNotes: number;
  truncated: boolean;
  reason?: string;
  /** Principal-scoped vector metadata revision, never a hidden-source change counter. */
  revision: string;
};
export type GraphAnalysisStatus = {
  state: GraphJobState;
  automatic: boolean;
  modelReady: boolean;
  provider: GraphProviderKind;
  total: number;
  completed: number;
  pending: number;
  failed: number;
  running: number;
  suggested: number;
  revision: string;
  lastUpdatedAt?: string;
  errors: { noteId: string; title: string; code: string }[];
  similarity?: GraphSimilarityStatus;
};
export type GraphKnowledgeResponse = Omit<KnowledgeGraphResponse, 'nodes' | 'edges'> & {
  nodes: GraphKnowledgeNode[];
  edges: GraphKnowledgeEdge[];
  status: GraphAnalysisStatus;
  path?: string[];
  similarity?: GraphSimilarityStatus;
};
export type GraphReviewItem = {
  id: string;
  source: { id: string; name: string; kind: GraphEntityKind };
  target: { id: string; name: string; kind: GraphEntityKind };
  predicate: string;
  confidence: number;
  status: 'suggested' | 'accepted' | 'ignored' | 'manual';
  evidence: GraphEvidence[];
};
export type GraphReviewQuery = {
  status?: 'suggested' | 'accepted' | 'ignored' | 'manual';
  limit?: number;
  offset?: number;
  q?: string;
};
export type GraphSavedView = {
  id: string;
  name: string;
  query: GraphExploreQuery;
  createdAt: string;
};
export type GraphUserState = {
  version: number;
  views: GraphSavedView[];
};
export type GraphUserCommand = {
  requestId: string;
  expectedVersion: number;
} & (
  | { action: 'review'; id: string; decision: 'accept' | 'ignore' | 'reset'; predicate?: string }
  | { action: 'merge'; from: string; into: string }
  | { action: 'alias'; entityId: string; alias: string }
  | { action: 'manual-relation'; source: string; target: string; predicate: string; noteId: string }
  | { action: 'save-view'; name: string; query: GraphExploreQuery }
  | { action: 'delete-view'; id: string }
);
export type GraphQuestionInput = { question: string; nodeId?: string };
export type GraphQuestionContext = { id: string; text: string; title: string };
export type GraphQuestionAnswer = { answer: string; citations: string[] };
export type GraphQuestionResponse = GraphQuestionAnswer & { evidence: GraphEvidence[] };

export type GraphModelPort = {
  settings(): GraphModelSettings;
  update(input: GraphModelUpdate): GraphModelSettings;
  test(): Promise<{ ok: boolean; message: string }>;
  extract(text: string, signal?: AbortSignal): Promise<GraphExtraction>;
  answer(
    question: string,
    context: GraphQuestionContext[],
    signal?: AbortSignal,
  ): Promise<GraphQuestionAnswer>;
  fingerprint(): string;
};
