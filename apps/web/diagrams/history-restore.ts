import type { NoteDocument } from '../../../shared/contracts';
import type { DiagramDocumentType } from '../../../shared/diagram-document';
import { renderPrimaryPng } from './primary-api';
import type { DocumentSnapshot } from './document-session';
import type { HistoryApi } from '../note-history';
import { hashDiagramSource } from './preview-artifact';
import {withOperationPreviews} from './operation-previews';
type Plan = {
  id: string;
  type: DiagramDocumentType;
  source: string;
  sourceHash: string;
  title: string;
  status?: string;
  preparedId?: string;
};

/** Stable request keys and a server receipt allow a lost reply to resume after reopening. */
export async function restoreHistory(
  call: HistoryApi,
  note: Pick<NoteDocument, 'id' | 'relativePath' | 'documentType'>,
  revisionId: string,
  expectedModifiedAt: string,
  requestId: string,
  render: (
    type: DiagramDocumentType,
    snapshot: DocumentSnapshot,
  ) => Promise<Blob> = renderPrimaryPng,
) {
  const url = `/api/notes/${encodeURIComponent(note.id)}/revisions/${encodeURIComponent(revisionId)}`;
  if (!note.documentType || note.documentType === 'markdown' || !/\.md$/i.test(note.relativePath))
    return withOperationPreviews(()=>call(url + '/restore', 'POST', { expectedModifiedAt, requestId }));
  const planRequestId = 'history-plan-' + (await hashDiagramSource(requestId));
  let plan = await withOperationPreviews(()=>call<Plan>(url + '/diagram-restore', 'POST', {
    expectedModifiedAt,
    requestId: planRequestId,
  }));
  const target = '/api/diagram-history-restores/' + encodeURIComponent(plan.id);
  plan = await call<Plan>(target, 'GET');
  if (!plan.preparedId) {
    const png = await render(plan.type, { source: plan.source, title: plan.title, markdown: '' });
    const bytes = new Uint8Array(await png.arrayBuffer());
    let binary = '';
    for (let at = 0; at < bytes.length; at += 8192)
      binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
    await call(target + '/prepare', 'POST', {
      sourceHash: plan.sourceHash,
      pngBase64: btoa(binary),
      requestId: 'history-preview-' + plan.id,
    });
  }
  return call<NoteDocument>(target + '/commit', 'POST', { requestId });
}
