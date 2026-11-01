import type { PreparedDiagramPrimary } from './diagram-primary.js';
export type MigrationIssue = { code: string; path?: string; noteId?: string };
export type MigrationInbound = {
  noteId: string;
  path: string;
  hash: string;
  modifiedAt: string;
  native: boolean;
};
export type WhiteboardMigrationPreflight = {
  noteId: string;
  oldPath: string;
  newPath: string;
  oldHash: string;
  oldModifiedAt: string;
  source: string;
  sourceHash: string;
  title: string;
  inbound: MigrationInbound[];
  issues: MigrationIssue[];
};
export type WhiteboardMigration = WhiteboardMigrationPreflight & {
  id: string;
  status: string;
  backupPath: string;
  nativePreviewNeeds?: {
    noteId: string;
    role: 'primary' | 'embedded';
    documentHash: string;
    sourceHash: string;
    renderHash: string;
    snapshotId: string;
  }[];
  prepared?: PreparedDiagramPrimary;
  markdown?: string;
  references?: { noteId: string; status: string; code?: string }[];
};
