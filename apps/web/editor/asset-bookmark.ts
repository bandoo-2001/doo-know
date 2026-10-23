import type { EditorSnapshot, SelectionBookmark } from './contracts';
export type AssetTarget = Pick<EditorSnapshot, 'noteId' | 'generation' | 'revision' | 'selection'>;
export function captureAssetTarget(s: EditorSnapshot): AssetTarget {
  return {
    noteId: s.noteId,
    generation: s.generation,
    revision: s.revision,
    selection: { ...s.selection },
  };
}
export function resolveAssetTarget(
  target: AssetTarget,
  current: EditorSnapshot,
): SelectionBookmark | undefined {
  return target.noteId === current.noteId &&
    target.generation === current.generation &&
    target.revision === current.revision &&
    target.selection.document?.id === current.selection.document?.id
    ? { ...target.selection }
    : undefined;
}
