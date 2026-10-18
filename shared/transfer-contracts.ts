/** Owner-only durable background operations. No credentials or payload contents appear here. */
export type TransferKind = 'import' | 'export' | 'backup' | 'restore';
export type TransferState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface ImportEntry {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
}
export interface ImportRequest {
  entries: ImportEntry[];
  /** Defaults to 00-Inbox. Empty string preserves full category paths from a portable export. */
  folderPath?: string;
  collision: 'skip' | 'rename';
  requestId: string;
}
export interface ImportPreviewItem {
  path: string;
  targetPath: string;
  kind: 'note' | 'asset';
  bytes: number;
  decision: 'create' | 'skip' | 'rename';
}
export interface ImportPreview {
  items: ImportPreviewItem[];
  totalBytes: number;
  warnings: string[];
}
export interface TransferItem {
  path: string;
  targetPath: string;
  kind: 'note' | 'asset';
  state: 'pending' | 'succeeded' | 'skipped' | 'failed';
  noteId?: string;
  error?: string;
}
export interface RestoreVerification {
  verified: true;
  notes: number;
  assets: number;
  dataRoot: string;
  knowledgeRoot?: string;
  profileFile: string;
  restoreReceipt: string;
  pluginsDisabled: true;
  sessionsRevoked: true;
  sharesRevoked: true;
  searchNeedsPreparation: true;
  activationRequired: true;
  guidance: string;
}
export interface TransferTask {
  id: string;
  kind: TransferKind;
  state: TransferState;
  createdAt: string;
  updatedAt: string;
  cancellable: boolean;
  progress: { completed: number; total: number; phase: string };
  items?: TransferItem[];
  error?: string;
  downloadAvailable: boolean;
  result?: {
    notes?: number;
    assets?: number;
    bytes?: number;
    scope?: string;
    backupId?: string;
    verification?: RestoreVerification;
    warnings?: string[];
  };
}
export interface TransferTaskList {
  items: TransferTask[];
  nextCursor?: string;
}
export interface ManagedBackup {
  id: string;
  taskId: string;
  createdAt: string;
  bytes: number;
  encrypted: true;
  /** Unknown until decryption for externally uploaded encrypted backups. */
  knowledgeIncluded?: boolean;
  keyFingerprint: string;
  external: boolean;
}
export interface ManagedBackupList {
  items: ManagedBackup[];
  nextCursor?: string;
}
export interface ExportRequest {
  folderPath?: string;
  requestId: string;
}
export interface RestoreRequest {
  backupId: string;
  requestId: string;
}
/** Routes: GET tasks/list or /:id; POST /:id/cancel or /:id/retry; GET /:id/download.
 * POST import/preview accepts Omit<ImportRequest,'requestId'>; POST import returns TransferTask.
 * POST export, POST backups {requestId}, POST restores return TransferTask.
 * GET backups returns ManagedBackupList; GET backups/:id/download streams encrypted bytes.
 * POST backups/key {currentPassword} returns attachment application/octet-stream, never JSON.
 * POST restores/upload multipart fields 'backup' (encrypted, <=128MiB), 'key' (<=16KiB)
 * and 'requestId' returns TransferTask; private uploaded key removed after execution.
 * Imports <=200 entries, <=20MiB decoded total, note <=1MiB, asset <=10MiB.
 */
