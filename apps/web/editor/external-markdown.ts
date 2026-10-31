import { diffChars } from 'diff';
import { Transaction, type EditorState, type TransactionSpec } from '@codemirror/state';
/** External model changes are derived updates, rather than another user undo step. */
export function externalMarkdownUpdate(state: EditorState, next: string): TransactionSpec {
  const changes: { from: number; to: number; insert: string }[] = [];
  let position = 0,
    pending: { from: number; to: number; insert: string } | undefined;
  const flush = () => {
    if (pending) {
      changes.push(pending);
      pending = undefined;
    }
  };
  for (const part of diffChars(state.doc.toString(), next)) {
    if (!part.added && !part.removed) {
      flush();
      position += part.value.length;
      continue;
    }
    pending ??= { from: position, to: position, insert: '' };
    if (part.removed) {
      position += part.value.length;
      pending.to = position;
    } else pending.insert += part.value;
  }
  flush();
  return { changes, annotations: Transaction.addToHistory.of(false) };
}
