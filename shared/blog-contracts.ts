export type BlogState = 'draft' | 'published' | 'withdrawn';
export type BlogMetadata = {
  slug: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  pinned: boolean;
  cover: string | null;
};
export type BlogSettings = {
  version: number;
  enabled: boolean;
  title: string;
  description: string;
  author: string;
  baseUrl: string;
  about: string;
  theme: 'light' | 'system';
};
export type BlogPost = BlogMetadata & {
  id: string;
  sourceNoteId: string;
  sourceTitle: string;
  sourceModifiedAt: string;
  sourceHash: string;
  version: number;
  state: BlogState;
  publishedVersionId: string | null;
  publishedAt: string | null;
  updatedAt: string;
  hasUnpublishedChanges: boolean;
  url: string | null;
};
export type BlogDiagramNeed = {
  fenceFrom: number;
  kind: 'svg' | 'mermaid' | 'excalidraw';
  code: string;
  codeHash: string;
  sourceHash: string;
  whiteboardId?: string;
};
export type BlogDiagramPreview = {
  fenceFrom: number;
  kind: BlogDiagramNeed['kind'];
  codeHash: string;
  sourceHash: string;
  pngBase64: string;
};
export type BlogPostDetail = {
  post: BlogPost;
  sourceContent: string;
  previewHtml: string;
  headings: { id: string; text: string }[];
  diagramNeeds: BlogDiagramNeed[];
};
export type BlogDashboard = {
  settings: BlogSettings;
  posts: BlogPost[];
  total: number;
  nextCursor: string | null;
  taxonomy: { categories: { name: string; count: number }[]; tags: { name: string; count: number }[] };
};
export type BlogCreateInput = {
  sourceNoteId: string;
  metadata?: Partial<BlogMetadata>;
  requestId: string;
};
export type BlogUpdateInput = {
  metadata: BlogMetadata;
  expectedVersion: number;
  requestId: string;
};
export type BlogPublishInput = {
  noteId: string;
  expectedModifiedAt: string;
  expectedContentHash: string;
  expectedPublicationVersion: number;
  requestId: string;
  metadata?: Partial<BlogMetadata>;
  diagrams?: BlogDiagramPreview[];
};
export type BlogUnpublishInput = {
  noteId: string;
  expectedPublicationVersion: number;
  requestId: string;
};
export type BlogNoteStatus = {
  siteEnabled: boolean;
  post: BlogPost | null;
  publicationVersion: number;
  source: { noteId: string; title: string; relativePath: string; modifiedAt: string; contentHash: string };
};
