import { api } from '../api';
import type {
  NoteInfo,
  FileReply,
  ReadPage,
  FileOperation,
} from '../../../shared/knowledge-contracts';
/** Obtain a checked version/hash without downloading a large document's entire body. */
export async function fileBaseline(noteId: string, active: () => boolean = () => true) {
  const meta = await api<NoteInfo>('/api/notes/' + encodeURIComponent(noteId) + '/meta');
  if (!active()) return;
  if (meta.publication) throw Error('原文仍有未完成写入，请先核对后再整理');
  if (meta.contentHash) return meta;
  let polls = 0;
  while (polls < 120) {
    if (!active()) return;
    const read = await api<FileReply<ReadPage>>(
      '/api/notes/' + encodeURIComponent(noteId) + '/read',
      'POST',
      { maxBytes: 4096 },
    );
    if (read.kind === 'ready') {
      if (read.data.modifiedAt !== meta.modifiedAt) throw Error('原文刚刚变化，请刷新后重新整理');
      return { ...meta, contentHash: read.data.sourceHash };
    }
    let operation = read.operation;
    while (['queued', 'running', 'committing'].includes(operation.status) && polls++ < 120) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!active()) return;
      operation = await api<FileOperation>('/api/operations/' + operation.operationId);
    }
    if (operation.status !== 'succeeded') throw Error('原文快照尚未准备完成，请稍后重试');
  }
  throw Error('原文快照仍在准备，请稍后刷新');
}
