import { api } from '../api';
import { createDraftStore, type DraftScope, type DraftRecord } from '../drafts';
import type { DiagramDocumentType } from '../../../shared/diagram-document';
import type { NoteDocument } from '../../../shared/contracts';
import { createDocumentSession } from './document-session';
import { documentDraft, restoreDocumentDraft } from './document-draft';
import {
  reserveDiagram,
  initialDiagramSource,
  renderPrimaryPng,
  preparePrimary,
  commitPrimary,
  readDiagram,
  type CreationIntent,
} from './primary-api';
import { hashDiagramSource } from './preview-artifact';
export type PendingCreation = {
  path: string;
  type: DiagramDocumentType;
  title: string;
  requestId: string;
  intentId?: string;
  noteId?: string;
  source?: string;
};
const key = (scope: DraftScope) =>
  'dooknow.diagram-creation.v1:' +
  encodeURIComponent(scope.ownerId) +
  ':' +
  encodeURIComponent(scope.knowledgeId);
export function pendingCreation(scope: DraftScope): PendingCreation | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key(scope)) || 'null');
    if (
      value &&
      typeof value.path === 'string' &&
      typeof value.title === 'string' &&
      typeof value.requestId === 'string' &&
      ['whiteboard', 'mindmap', 'flowchart'].includes(value.type)
    )
      return value;
  } catch {}
  return undefined;
}
export async function cancelCreation(scope: DraftScope) {
  const pending = pendingCreation(scope);
  if (pending) {
    const intentId =
      pending.intentId ?? (await reserveDiagram(pending.path, pending.type, pending.requestId)).id;
    await api('/api/diagram-documents/intents/' + intentId, 'DELETE');
  }
  if (pending?.noteId) {
    const store = createDraftStore({ scope });
    const record = await store.load(pending.noteId);
    if (record && !(await store.remove(pending.noteId, record.version)))
      throw Error('草稿已在其他页面变化');
  }
  localStorage.removeItem(key(scope));
}
export async function createPrimaryDocument(
  scope: DraftScope,
  input: PendingCreation,
): Promise<NoteDocument> {
  const previous = pendingCreation(scope);
  if (previous && previous.requestId !== input.requestId)
    throw Error('请先恢复或取消未完成的图形创建');
  if (
    previous &&
    (previous.path !== input.path || previous.type !== input.type || previous.title !== input.title)
  )
    throw Error('创建内容已固定，请先恢复或取消未完成图形');
  const work = {
    ...previous,
    ...input,
    intentId: previous?.intentId ?? input.intentId,
    noteId: previous?.noteId ?? input.noteId,
  };
  localStorage.setItem(key(scope), JSON.stringify({ ...work, source: undefined }));
  let intent: CreationIntent;
  if (work.intentId)
    intent = await api('/api/diagram-documents/intents/' + encodeURIComponent(work.intentId));
  else {
    intent = await reserveDiagram(work.path, work.type, work.requestId);
    work.intentId = intent.id;
    work.noteId = intent.noteId;
    localStorage.setItem(key(scope), JSON.stringify({ ...work, source: undefined }));
  }
  if (['cancelled', 'expired'].includes(intent.status))
    throw Error('创建意图已取消或过期，请取消本地记录后重新创建');
  const store = createDraftStore({ scope });
  let record: DraftRecord | undefined = await store.load(intent.noteId);
  if (intent.status === 'published' && !record?.diagram?.pending) {
    localStorage.removeItem(key(scope));
    return api<NoteDocument>('/api/notes/' + intent.noteId);
  }
  let queue = Promise.resolve();
  const session = createDocumentSession(
    {
      noteId: intent.noteId,
      intentId: intent.id,
      type: work.type,
      markdown: '',
      source: work.source ?? initialDiagramSource(work.type),
      title: work.title,
      documentHash: null,
      sourceHash: null,
    },
    {
      hash: hashDiagramSource,
      render: (s) => renderPrimaryPng(work.type, s),
      prepare: (s, png, target) => preparePrimary(work.type, s, png, target),
      commit: commitPrimary,
      resource: () => readDiagram(intent.noteId),
      persist: async (state) => {
        const snapshot = structuredClone(state);
        const next = queue.then(async () => {
          if (!session.dirty()) {
            if (record) {
              if (!(await store.remove(intent.noteId, record.version)))
                throw Error('草稿已在其他页面变化');
              record = undefined;
            }
            return;
          }
          const draft = documentDraft(snapshot);
          record = await store.put({
            noteId: intent.noteId,
            kind: 'note',
            content: draft.payload,
            baseRevision: 'creation:' + intent.id,
            diagram: draft,
          });
        });
        queue = next.catch(() => {});
        await next;
      },
    },
  );
  if (record) {
    const restored = restoreDocumentDraft(record, session.state);
    session.restore(restored, restored.pending);
  }
  await session.save();
  localStorage.removeItem(key(scope));
  return api<NoteDocument>('/api/notes/' + intent.noteId);
}
