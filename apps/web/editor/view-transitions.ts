import type { EditorKind, EditorSnapshot, SelectionBookmark } from './contracts';

export type EditorViewState = { kind: EditorKind; mode: 'edit' | 'preview' | 'split' };
export type EditorViewChange =
  | { kind: EditorKind; sourceOffset?: number }
  | { mode: EditorViewState['mode'] };

export function createEditorViewTransitions(options: {
  current: () => EditorViewState;
  context?: () => unknown;
  flush: () => Promise<EditorSnapshot | undefined>;
  apply: (change: EditorViewChange) => void;
  afterRender: () => Promise<unknown>;
  focus: (bookmark: SelectionBookmark) => void;
  cancelPendingFocus: () => void;
  error: (cause: unknown) => void;
}) {
  let request = 0;
  return {
    async select(change: EditorViewChange) {
      const selected = ++request;
      const context = options.context?.();
      const isCurrent = () => selected === request && context === options.context?.();
      options.cancelPendingFocus();
      const current = options.current();
      if (
        'kind' in change &&
        current.kind === change.kind &&
        current.mode === 'edit' &&
        change.sourceOffset === undefined
      )
        return;
      try {
        const saved = await options.flush();
        if (!isCurrent()) return;
        options.apply(change);
        if ('kind' in change) {
          await options.afterRender();
          if (!isCurrent() || !saved) return;
          options.focus(
            change.sourceOffset === undefined
              ? saved.selection
              : {
                  anchor: change.sourceOffset,
                  head: change.sourceOffset,
                  affinity: 'after',
                },
          );
        }
      } catch (cause) {
        if (isCurrent()) options.error(cause);
      }
    },
    cancel() {
      request++;
      options.cancelPendingFocus();
    },
  };
}
