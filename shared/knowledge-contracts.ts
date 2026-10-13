export type Principal = {
  id: string;
  clientId: string;
  scopes: string[];
  allowedPrefixes: string[];
  tokenIssuedAt?: number;
};
export type AgentConfig = {
  serviceToken: string;
  assertionSecret: string;
  issuer: string;
  audience: string;
  policies: Principal[];
};
export type NoteInfo = {
  id: string;
  title: string;
  relativePath: string;
  url: string;
  sizeBytes: number;
  modifiedAt: string;
  contentHash: string | null;
  sourceRevision: number | null;
  editorMode: 'full' | 'large' | 'metadata';
  longestLineBytes: number | null;
  readState: 'unknown' | 'preparing' | 'ready';
  shared?: boolean;
};
export type ReadInput = {
  snapshotId?: string;
  cursor?: string;
  maxBytes?: number;
  range?: { startLine: number; endLine?: number; lineByteOffset?: number };
};
export type ReadPage = {
  snapshotId: string;
  sourceHash: string;
  modifiedAt: string;
  content: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  bytesReturned: number;
  hasMore: boolean;
  nextCursor?: string;
  budgetRemainingBytes: number;
  rangeHash: string;
  lineByteOffset: number;
};
export type PatchEdit =
  | { type: 'replace_text'; before: string; after: string }
  | {
      type: 'replace_range';
      startByte: number;
      endByte: number;
      expectedRangeHash: string;
      insert: string;
    };
export type PatchInput = {
  snapshotId: string;
  expectedModifiedAt: string;
  expectedContentHash: string;
  requestId: string;
  edits: PatchEdit[];
};
export type PatchResult = {
  modifiedAt: string;
  contentHash: string;
  sizeBytes: number;
  editCount: number;
  indexState: string;
};
export type FileOperation = {
  operationId: string;
  requestId: string;
  kind: 'prepare_snapshot' | 'patch';
  status:
    | 'queued'
    | 'running'
    | 'committing'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'needs_reconciliation';
  snapshotId?: string;
  result?: PatchResult;
  error?: { code: string; retryable: boolean };
};
export type FileReply<T> =
  | { kind: 'ready'; data: T }
  | { kind: 'accepted'; operation: FileOperation };
export type SourceVersion = { noteId: string; sourceRevision: number; contentHash: string };
export type Chunk = {
  chunkId: string;
  noteId: string;
  sourceHash: string;
  chunkerId: string;
  ordinal: number;
  headingPath: string[];
  startLine: number;
  endLine: number;
  content: string;
  embeddingInputHash: string;
};
export type RankedChunk = { chunkId: string; rank: number; score: number };
export type RecoveryReport = { recovered: number; unapplied: number; conflicted: number };
export type StopHandle = () => void;
export type IndexMode = 'text' | 'semantic' | 'hybrid';
export type SearchInput = {
  query: string;
  mode?: IndexMode;
  freshness?: 'indexed' | 'strict';
  filters?: { directory?: string; category?: string; tags?: string[]; updatedAfter?: string };
  limit?: number;
  cursor?: string;
};
export type Hit = {
  noteId: string;
  chunkId: string;
  title: string;
  relativePath: string;
  url: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  snippet: string;
  sourceHash: string;
  matchedBy: ('text' | 'semantic')[];
  sourceRevision: number;
};
export type NoteSearchResult = Pick<Hit, 'noteId' | 'title' | 'relativePath' | 'url'> & {
  matches: Hit[];
};
export type SearchOutput = {
  results: NoteSearchResult[];
  nextCursor?: string;
  degraded: boolean;
  reasons: string[];
  index: { checkedAt: string | null; pending: number; generation: string | null };
};
export type IndexJob = SourceVersion & {
  id: string;
  target: 'text' | 'vector';
  embeddingSpaceId: string | null;
  status: string;
  attempts: number;
  leaseEpoch: number;
  leaseUntil: string | null;
};
export type PreparedVectorBatch = SourceVersion & {
  generation: string;
  baseGeneration: string | null;
  embeddingSpaceId: string;
  manifestPath: string;
  checksum: string;
};
export type OutlinePage = {
  snapshotId: string;
  sourceHash: string;
  modifiedAt: string;
  items: { title: string; level: number; line: number; startByte: number }[];
  nextCursor?: string;
};
