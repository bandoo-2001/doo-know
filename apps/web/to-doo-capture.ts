import type { ToDooCommand } from '../../shared/to-doo-contracts';

type Input = {
  noteId: string;
  title: string;
  markdown: string;
  savedMarkdown: string;
  contentHash?: string | null;
  selection?: { anchor: number; head: number };
};
type Draft = Extract<ToDooCommand, { action: 'create_task' }>['payload'];

export function toDooCaptureFromNote(input: Input): Draft {
  const anchor = Math.max(0, Math.min(input.markdown.length, input.selection?.anchor ?? 0));
  const head = Math.max(0, Math.min(input.markdown.length, input.selection?.head ?? anchor));
  const from = Math.min(anchor, head),
    to = Math.max(anchor, head);
  const selected = input.markdown.slice(from, to).trim();
  const draft = input.markdown !== input.savedMarkdown;
  const quote = (selected || (draft ? input.markdown : '')).trim().slice(0, 65536);
  const line = quote
    .split(/\r?\n/)
    .find((value) => value.trim())
    ?.replace(/^\s*(?:[-*+]\s+\[[ xX]\]\s*|#{1,6}\s+|[-*+]\s+)/, '')
    .trim();
  return {
    title: (selected && line ? line : `跟进：${input.title}`).slice(0, 256),
    description: selected ? quote : '',
    noteRefs: [{ noteId: input.noteId, role: 'source' }],
    source: {
      noteId: input.noteId,
      quote,
      contentHash: draft ? null : (input.contentHash ?? null),
      draft,
      ...(quote ? { startLineHint: selected ? input.markdown.slice(0, from).split('\n').length : 1 } : {}),
    },
  };
}
