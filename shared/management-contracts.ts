import type { StorageUsage } from './platform-contracts.js';
export interface ManagementPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface ManagementOverview {
  username: string;
  library: { name: string | null; path: string | null; timeZone: string; ready: boolean };
  release: { version: string; environment: string };
  capabilities: { shares: boolean; trash: boolean; sessions: true; diagnostics: true };
}
export type ManagementStorageCategory =
  | 'notes'
  | 'assets'
  | 'history'
  | 'trash'
  | 'index'
  | 'models'
  | 'upgradeBackups';
export interface ManagementStorage {
  categories: Record<ManagementStorageCategory, StorageUsage>;
  scannedAt: string;
  limits: { entriesPerCategory: number; depth: number };
  warnings: string[];
}
export interface ManagementShare {
  id: string;
  title: string;
  relativePath: string;
  enabled: boolean;
  url: string | null;
}
export interface ManagementSession {
  id: string;
  device: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  current: boolean;
}
export interface ManagementBatchInput {
  ids: string[];
  requestId: string;
}
export interface ManagementItemResult {
  id: string;
  ok: boolean;
  code?: string;
  relativePath?: string;
}
export interface ManagementBatchResult {
  results: ManagementItemResult[];
}
export interface ManagementTrashItem {
  id: string;
  title: string;
  relativePath: string;
  deletedAt: string | null;
  sizeBytes: number | null;
  available: boolean;
}
export interface ManagementTrashPage extends ManagementPage<ManagementTrashItem> {
  snapshotId: string;
}
export interface ManagementTrashRestoreInput extends ManagementBatchInput {
  fileNames?: Record<string, string>;
}
export interface ManagementTrashPurgeInput extends ManagementBatchInput {
  snapshotId: string;
  confirm: 'PERMANENTLY_DELETE';
}
export interface ManagementDiagnostics {
  generatedAt: string;
  release: { version: string; environment: string };
  platform: { phase: string; knowledge: boolean; search: boolean };
  counts: {
    activeNotes: number;
    trashNotes: number;
    enabledShares: number;
    writeConflicts: number;
  };
  scope: 'redacted-status-only';
}

export interface ManagementTrashPurgeResult extends ManagementBatchResult {
  scope: 'selected-trash-source-files';
  retained: ['history', 'backups', 'metadata'];
}
