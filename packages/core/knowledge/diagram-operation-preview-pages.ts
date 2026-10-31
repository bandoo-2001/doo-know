import { diagramOperationWorkspace } from './diagram-operation-previews.js';
import { archivedDiagramRoot } from './archived-diagram-context.js';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import { authorizePath } from '../agent/auth.js';
import { decodeCursor, signCursor } from '../agent/budgets.js';
import { sha256 } from './operations.js';
import { fail } from './errors.js';
import type { NativePreviewNeed } from './native-link-plans.js';
export type DiagramPreviewNeedsPage = {
  planId: string;
  operationId: string;
  documents: NativePreviewNeed[];
  totalCount: number;
  nextCursor?: string;
};
/** A bounded actor-bound view of every pending snapshot; no silent truncation. */
export function diagramOperationPreviewNeeds(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  input: { operationId: string; cursor?: string; limit?: number },
): DiagramPreviewNeedsPage {
  const row = db
    .prepare('SELECT principal,client_id,status,error FROM operations WHERE id=?')
    .get(input.operationId) as any;
  if (!row || row.principal !== p.id || row.client_id !== p.clientId)
    fail(404, 'OPERATION_NOT_FOUND');
  if (row.status !== 'awaiting_preview') fail(409, 'DIAGRAM_OPERATION_NOT_PENDING');
  const details = JSON.parse(row.error).details,
    documents = details?.documents as NativePreviewNeed[];
  if (!Array.isArray(documents) || !documents.length) fail(409, 'DIAGRAM_OPERATION_NOT_PENDING');
  const workspace = diagramOperationWorkspace(config, db);
  // Recheck the complete dependency scope before exposing even the first page.
  for (const need of documents) {
    const snapshotRow = db
      .prepare('SELECT principal,client_id,snapshot FROM diagram_operation_previews WHERE id=?')
      .get(need.snapshotId) as any;
    if (!snapshotRow || snapshotRow.principal !== p.id || snapshotRow.client_id !== p.clientId)
      fail(403, 'DEPENDENCY_FORBIDDEN');
    const snapshot = JSON.parse(snapshotRow.snapshot),
      note = db.prepare('SELECT path,active FROM notes WHERE id=?').get(need.noteId) as any;
    if (snapshot.workspace !== workspace) fail(409, 'LIBRARY_BINDING_CHANGED');
    if (!note || (!note.active && !snapshot.input.archive)) fail(409, 'VERSION_CONFLICT');
    if (snapshot.input.archive) archivedDiagramRoot(config, db, snapshot.input.archive);
    for (const path of new Set<string>([
      note.path,
      snapshot.input.documentPath,
      ...(snapshot.input.permissions ?? []),
    ]))
      authorizePath(p, path, 'knowledge:write');
  }
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) fail(400, 'INVALID_LIMIT');
  const fingerprint = sha256(
    JSON.stringify([
      input.operationId,
      row.error,
      p.id,
      p.clientId,
      p.scopes,
      p.allowedPrefixes,
      p.permissionPolicy,
      p.knowledgeAll,
    ]),
  );
  let offset = 0;
  if (input.cursor) {
    const c = decodeCursor(config.secret, input.cursor);
    if (c.fingerprint !== fingerprint || c.expires <= Date.now()) fail(409, 'CURSOR_INVALIDATED');
    offset = c.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= documents.length)
      fail(400, 'INVALID_CURSOR');
  }
  const end = Math.min(documents.length, offset + limit);
  return {
    planId: details.planId,
    operationId: input.operationId,
    documents: documents.slice(offset, end),
    totalCount: documents.length,
    ...(end < documents.length
      ? {
          nextCursor: signCursor(config.secret, {
            fingerprint,
            offset: end,
            expires: Date.now() + 15 * 60000,
          }),
        }
      : {}),
  };
}
