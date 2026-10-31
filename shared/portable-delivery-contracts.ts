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
