import type { MarkdownAction, MarkdownToolbarState } from '../markdown-format';
export type EditorKind = 'document' | 'source';
export type ImageReplacementTarget = {
  position: number;
  src: string;
  revision: number;
  projectionId: string;
};
export type NoteView = 'edit' | 'read';
export type SelectionBookmark = {
  anchor: number;
  head: number;
  affinity: 'before' | 'after';
  document?: { id: string; anchor: number; head: number };
};
export type SourceEdit = { from: number; to: number; insert: string };
export type SourceUnit = {
  id: string;
  from: number;
  to: number;
  raw: string;
  kind: string;
  opaque: boolean;
  dependencies: string[];
};
export type Eligibility = {
  allowed: boolean;
  reason?: 'large-file' | 'size' | 'units' | 'depth' | 'syntax' | 'disabled';
  message?: string;
};
export type SourceDocument = {
  markdown: string;
  revision: number;
  units: SourceUnit[];
  eligibility: Eligibility;
};
export type CommitResult =
  | { ok: true; markdown: string; revision: number; selection: SelectionBookmark }
  | { ok: false; code: 'stale' | 'unsupported' | 'invalid'; message: string };
export type EditorSnapshot = {
  noteId: string;
  generation: number;
  revision: number;
  markdown: string;
  selection: SelectionBookmark;
};
export type TableAction =
  | 'addRowBefore'
  | 'addRowAfter'
  | 'deleteRow'
  | 'moveRowUp'
  | 'moveRowDown'
  | 'addColumnBefore'
  | 'addColumnAfter'
  | 'deleteColumn'
  | 'moveColumnLeft'
  | 'moveColumnRight'
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'deleteTable';
export type EditorHandle = {
  flush(): Promise<EditorSnapshot>;
  execute(action: MarkdownAction): boolean;
  format(action: MarkdownAction): boolean;
  editHistory(action: 'undo' | 'redo'): boolean;
  focus(bookmark?: SelectionBookmark): void;
  goToLine(line: number): void;
  state(): MarkdownToolbarState;
  insertAsset(markdown: string, bookmark?: SelectionBookmark): boolean;
  selection(): SelectionBookmark;
};
export const emptySelection = (): SelectionBookmark => ({ anchor: 0, head: 0, affinity: 'after' });
