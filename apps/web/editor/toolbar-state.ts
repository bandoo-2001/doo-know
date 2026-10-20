import type { StyleAction, Alignment } from '../markdown-style';
export type MarkdownAction =
  | StyleAction
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode'
  | 'link'
  | 'codeBlock'
  | 'table'
  | 'rule'
  | 'quote'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'indent'
  | 'outdent'
  | 'paragraph'
  | `heading${1 | 2 | 3 | 4 | 5}`;
export interface MarkdownToolbarState {
  alignment: Alignment;
  color: string | null;
  styleDisabled: boolean;
  heading: number;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  quote: boolean;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
  canUndo: boolean;
  canRedo: boolean;
}
export const emptyToolbarState = (): MarkdownToolbarState => ({
  alignment: 'left',
  color: null,
  styleDisabled: false,
  heading: 0,
  bold: false,
  italic: false,
  strike: false,
  code: false,
  quote: false,
  bullet: false,
  ordered: false,
  task: false,
  canUndo: false,
  canRedo: false,
});
