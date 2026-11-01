export type PortableSelection =
  | { kind: 'single'; noteId: string }
  | { kind: 'multiple'; noteIds: string[] }
  | { kind: 'directory'; path: string };
export type PortableDeliveryRequest = { selection: PortableSelection; requestId: string };
export type PortableDelivery = {
  id: string;
  kind: 'markdown' | 'archive';
  fileName: string;
  mime: 'text/markdown' | 'application/gzip';
  sizeBytes: number;
  sha256: string;
  downloadUrl: string;
  manifestVersion?: 1;
};
export type PortableImportResult = {
  id: string;
  notes: { sourcePath: string; relativePath: string; noteId: string }[];
  assets: number;
};
export type PortableOwnerJob = {
  id: string;
  requestId: string;
  kind: 'export' | 'import-archive' | 'import-directory';
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  updatedAt: number;
  needsSource: boolean;
  folderPath?: string;
  result?: PortableDelivery | PortableImportResult;
  error?: string;
  portablePreviews?: PortablePreviewNeed[];
};

export type PortablePreviewNeed = {
  previewId: string;
  document: string;
  role: 'primary' | 'embedded';
  sourceHash: string;
  renderHash: string;
  type: 'whiteboard';
  title: string;
  renderer: string;
  config: Record<string, unknown>;
  expiresAt: number;
  direction: 'export' | 'import';
  sourceBytes: number;
};
