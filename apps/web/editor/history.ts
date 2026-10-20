import type { SelectionBookmark, SourceEdit } from './contracts';
import { textEdit, serializeEdits } from './source-codec';
type Entry = {
  forward: SourceEdit[];
  back: SourceEdit[];
  before: SelectionBookmark;
  after: SelectionBookmark;
  group: string;
  time: number;
  bytes: number;
};
function apply(text: string, edits: SourceEdit[]) {
  const r = serializeEdits(
    { markdown: text, revision: 0, units: [], eligibility: { allowed: true } },
    edits,
  );
  if (!r.ok) throw Error(r.message);
  return r.markdown;
}
const bytes = (edits: SourceEdit[]) =>
  edits.reduce((n, e) => n + new TextEncoder().encode(e.insert).length + 32, 0);
export function createEditorHistory() {
  const past: Entry[] = [],
    future: Entry[] = [];
  let total = 0,
    sealed = true;
  return {
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    seal() {
      sealed = true;
    },
    clear() {
      past.length = 0;
      future.length = 0;
      total = 0;
      sealed = true;
    },
    record(
      before: string,
      after: string,
      from: SelectionBookmark,
      to: SelectionBookmark,
      group: string,
    ) {
      if (before === after) return;
      future.length = 0;
      const now = Date.now();
      const last = past.at(-1);
      if (!sealed && last && last.group === group && now - last.time < 650) {
        before = apply(before, last.back);
        from = last.before;
        past.pop();
        total -= last.bytes;
      }
      const forward = textEdit(before, after),
        back = textEdit(after, before);
      const size = bytes(forward) + bytes(back);
      past.push({ forward, back, before: from, after: to, group, time: now, bytes: size });
      total += size;
      sealed = false;
      while (past.length > 200 || total > 4 * 1024 * 1024) {
        total -= past.shift()!.bytes;
      }
    },
    undo(text: string) {
      const entry = past.pop();
      if (!entry) return;
      total -= entry.bytes;
      future.push(entry);
      sealed = true;
      return { markdown: apply(text, entry.back), selection: entry.before };
    },
    redo(text: string) {
      const entry = future.pop();
      if (!entry) return;
      past.push(entry);
      total += entry.bytes;
      sealed = true;
      return { markdown: apply(text, entry.forward), selection: entry.after };
    },
  };
}
