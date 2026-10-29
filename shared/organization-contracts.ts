export type OrganizationAction =
  | { type: 'create_directory'; parentId: string | null; name: string }
  | {
      type: 'move_note';
      noteId: string;
      toDirectoryId: string | null;
      fileName: string;
      expectedModifiedAt: string;
      expectedContentHash: string;
    }
  | {
      type: 'move_directory';
      directoryId: string;
      toDirectoryId: string | null;
      name: string;
      expectedSubtreeRevision: string;
    };
export type OrganizationContext = {
  libraryId: string;
  bindingVersion: number;
  structureRevision: string;
  inboxDirectoryId: string | null;
  limits: {
    actions: number;
    files: number;
    directories: number;
    bodyBytes: number;
    assetBytes: number;
  };
};
export type DirectoryInfo = {
  id: string;
  path: string;
  parentId: string | null;
  subtreeRevision: string;
  name: string;
  writable: boolean;
  organizable: boolean;
};
export type DirectoryListInput = { parentId?: string | null; cursor?: string; limit?: number };
export type DirectoryPage = {
  libraryId: string;
  structureRevision: string;
  items: DirectoryInfo[];
  nextCursor?: string;
};
export type OrganizeInput = {
  requestId: string;
  libraryId: string;
  expectedStructureRevision: string;
  actions: OrganizationAction[];
};
export type OrganizationResult = {
  operationId: string;
  libraryId: string;
  structureRevision: string;
  changes: Array<{ type: string; id: string; from?: string; to: string }>;
  indexState: 'pending' | 'ready';
  undoAvailable: boolean;
};
export type OrganizationOperation = {
  operationId: string;
  requestId: string;
  kind: string;
  status: string;
  result?: OrganizationResult;
  error?: { code: string; retryable: boolean };
};
export type OrganizationReply = { kind: 'accepted'; operation: OrganizationOperation };
export type HistoryInput = { cursor?: string; limit?: number };
export type HistoryPage = { items: OrganizationOperation[]; nextCursor?: string };
export type UndoOrganizationInput = { operationId: string; requestId: string };
