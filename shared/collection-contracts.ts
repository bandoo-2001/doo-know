export type CollectionKind = 'recent' | 'favorites';
export interface CollectionNote {
  id: string;
  path: string;
  name: string;
  title: string;
  summary: string;
  summaryState: 'ready' | 'pending' | 'unavailable';
  updatedAt: string | null;
  favorite: boolean;
}
export interface CollectionPage {
  items: CollectionNote[];
  nextCursor: string | null;
  total: number;
  version: string;
}
export interface CollectionStatus {
  version: string;
  total: number;
}
