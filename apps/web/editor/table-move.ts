import type { Command, EditorState } from '@tiptap/pm/state';
import {
  CellSelection,
  findCellRange,
  isInTable,
  moveTableColumn,
  moveTableRow,
  selectedRect,
} from '@tiptap/pm/tables';
import type { TableAction } from './contracts';

export const tableMoveActions = ['moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight'] as const;
export type TableMoveAction = Extract<TableAction, typeof tableMoveActions[number]>;
export type TableMoveAvailability = Record<TableMoveAction, boolean>;

export function isTableMoveAction(action: TableAction): action is TableMoveAction {
  return (tableMoveActions as readonly TableAction[]).includes(action);
}

function movableTable(state: EditorState) {
  if (!isInTable(state)) return;
  const cells = findCellRange(state.selection);
  if (!cells || (!(state.selection instanceof CellSelection) && cells[0].pos !== cells[1].pos)) return;
  const rect = selectedRect(state), { table, map } = rect;
  if (map.problems?.length || !map.width) return;
  // GFM has one header row and rectangular, unmerged cells. Reject structures
  // whose movement could silently lose data when the projection serializes them.
  for (let row = 0; row < table.childCount; row++) {
    const current = table.child(row);
    if (current.childCount !== map.width) return;
    for (let column = 0; column < current.childCount; column++) {
      const cell = current.child(column);
      if (cell.type.spec.tableRole !== (row === 0 ? 'header_cell' : 'cell') ||
          cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) return;
    }
  }
  return rect;
}

function availability(rect: ReturnType<typeof movableTable>): TableMoveAvailability {
  return {
    moveRowUp: !!rect && rect.bottom === rect.top + 1 && rect.top > 1,
    moveRowDown: !!rect && rect.bottom === rect.top + 1 && rect.top > 0 && rect.bottom < rect.map.height,
    moveColumnLeft: !!rect && rect.right === rect.left + 1 && rect.left > 0,
    moveColumnRight: !!rect && rect.right === rect.left + 1 && rect.right < rect.map.width,
  };
}

export function tableMoveAvailability(state: EditorState): TableMoveAvailability {
  return availability(movableTable(state));
}

export function moveMarkdownTable(action: TableMoveAction, options: { readOnly?: boolean } = {}): Command {
  return (state, dispatch) => {
    if (options.readOnly) return false;
    const rect = movableTable(state);
    if (!rect || !availability(rect)[action]) return false;
    const row = action === 'moveRowUp' || action === 'moveRowDown';
    const from = row ? rect.top : rect.left;
    const to = from + (action === 'moveRowUp' || action === 'moveColumnLeft' ? -1 : 1);
    return (row ? moveTableRow : moveTableColumn)({ from, to, select: true })(
      state,
      dispatch ? tr => dispatch(tr.scrollIntoView()) : undefined,
    );
  };
}
