import {
  emptySelection,
  type EditorSnapshot,
  type SourceDocument,
  type SourceEdit,
  type SelectionBookmark,
  type CommitResult,
  type EditorKind,
} from './contracts';
import { parseSource, serializeEdits, validateUnitOperation } from './source-codec';
import { createEditorHistory } from './history';
export type EditorSession = ReturnType<typeof createEditorSession>;
export function createEditorSession(input: {
  noteId: string;
  generation: number;
  markdown: string;
}) {
  let markdown = input.markdown,
    revision = 0,
    selection = emptySelection(),
    disposed = false,
    composing = false,
    protectedDoc: SourceDocument | undefined;
  const history = createEditorHistory();
  const waiting: { resolve: (x: EditorSnapshot) => void; reject: (e: Error) => void }[] = [];
  const snapshot = (): EditorSnapshot => ({
    ...input,
    markdown,
    revision,
    selection: { ...selection },
  });
  const stale = (): CommitResult => ({
    ok: false,
    code: 'stale',
    message: '笔记已切换或编辑基准已变化',
  });
  function changeHistory(action: 'undo' | 'redo'): CommitResult {
    if (disposed || composing) return stale();
    const changed = history[action](markdown);
    if (!changed) return { ok: true, markdown, revision, selection };
    markdown = changed.markdown;
    selection = changed.selection;
    revision++;
    protectedDoc = undefined;
    return { ok: true, markdown, revision, selection };
  }
  return {
    snapshot,
    get canUndo() {
      return history.canUndo;
    },
    get canRedo() {
      return history.canRedo;
    },
    get composing() {
      return composing;
    },
    sealHistory() {
      history.seal();
    },
    apply(edit: {
      noteId: string;
      generation: number;
      baseRevision: number;
      origin: EditorKind;
      edits: readonly SourceEdit[];
      selection: SelectionBookmark;
      intent?: 'deleteOpaque';
    }): CommitResult {
      if (
        disposed ||
        edit.noteId !== input.noteId ||
        edit.generation !== input.generation ||
        edit.baseRevision !== revision
      )
        return stale();
      const base =
        edit.origin === 'document'
          ? (protectedDoc ??= parseSource(markdown, revision))
          : { markdown, revision, units: [], eligibility: { allowed: true } };
      base.markdown = markdown;
      base.revision = revision;
      const result =
        edit.origin === 'document'
          ? validateUnitOperation(base, edit.edits, edit.intent || 'edit')
          : serializeEdits(base, edit.edits);
      if (!result.ok) return result;
      history.record(
        markdown,
        result.markdown,
        selection,
        edit.selection,
        composing ? 'composition' : edit.origin,
      );
      markdown = result.markdown;
      revision = result.revision;
      selection = { ...edit.selection };
      if (edit.origin === 'source' || edit.intent === 'deleteOpaque') protectedDoc = undefined;
      else if (protectedDoc) {
        const sorted = [...edit.edits].sort((a, b) => a.from - b.from);
        protectedDoc.units = protectedDoc.units
          .filter((u) => u.opaque)
          .map((u) => {
            let shift = 0;
            for (const e of sorted) {
              if (e.to <= u.from) shift += e.insert.length - (e.to - e.from);
              else if (e.from < u.to && e.to > u.from) {
                const at = e.insert.indexOf(u.raw);
                if (at >= 0)
                  return {
                    ...u,
                    from: e.from + shift + at,
                    to: e.from + shift + at + u.raw.length,
                  };
              }
            }
            return { ...u, from: u.from + shift, to: u.to + shift };
          });
      }
      return { ok: true, markdown, revision, selection };
    },
    setSelection(value: SelectionBookmark) {
      selection = { ...value };
    },
    rejectPendingFlush(message: string) {
      for (const waiter of waiting.splice(0)) waiter.reject(Error(message));
    },
    setComposing(value: boolean) {
      composing = value;
      if (!value) {
        history.seal();
        for (const waiter of waiting.splice(0)) waiter.resolve(snapshot());
      }
    },
    flush(): Promise<EditorSnapshot> {
      if (disposed) return Promise.reject(Error('编辑会话已关闭'));
      if (!composing) return Promise.resolve(snapshot());
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    async prepareSwitch(_target: EditorKind) {
      history.seal();
      if (disposed) throw Error('编辑会话已关闭');
      if (!composing) return snapshot();
      return new Promise<EditorSnapshot>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    undo: () => changeHistory('undo'),
    redo: () => changeHistory('redo'),
    replaceExternal(text: string) {
      if (markdown === text) return;
      markdown = text;
      revision++;
      protectedDoc = undefined;
      selection = emptySelection();
      history.clear();
    },
    dispose() {
      disposed = true;
      for (const waiter of waiting.splice(0)) waiter.reject(Error('编辑会话已关闭'));
      history.clear();
    },
  };
}
