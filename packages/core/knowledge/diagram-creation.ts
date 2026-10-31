import { diagramCreationSchema as inputSchema } from '../../../shared/diagram-document-contracts.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { DiagramDocumentType } from '../../../shared/diagram-document.js';
import type { AppDatabase } from '../db.js';
import { authorizePath } from '../agent/auth.js';
import { safePath } from '../files.js';
import { workspaceWriteSync } from '../workspace/gate.js';
import { assertRoot } from '../indexing/reconcile.js';
import { assertWritable } from './write-lease.js';
import { beginOperation, completeOperation, existingResult } from './operations.js';
import { fail } from './errors.js';

export const DIAGRAM_CREATION_LEASE_MS = 24 * 60 * 60 * 1000;
type CreationStatus =
  | 'reserved'
  | 'prepared'
  | 'committing'
  | 'published'
  | 'cancelled'
  | 'expired';
export type DiagramCreationIntent = {
  id: string;
  noteId: string;
  relativePath: string;
  documentType: DiagramDocumentType;
  status: CreationStatus;
  createdAt: number;
  expiresAt: number;
  commitOperationId?: string;
};
type CreationRow = {
  id: string;
  note_id: string;
  path: string;
  document_type: DiagramDocumentType;
  principal: string;
  client_id: string;
  status: CreationStatus;
  created_at: number;
  expires_at: number;
  commit_operation_id: string | null;
};
function project(row: CreationRow): DiagramCreationIntent {
  return {
    id: row.id,
    noteId: row.note_id,
    relativePath: row.path,
    documentType: row.document_type,
    status:
      row.commit_operation_id && ['reserved', 'prepared'].includes(row.status)
        ? 'committing'
        : ['reserved', 'prepared'].includes(row.status) && row.expires_at <= Date.now()
          ? 'expired'
          : row.status,
    ...(row.commit_operation_id ? { commitOperationId: row.commit_operation_id } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Only the bound principal/client can prepare or publish a reserved document identity. */
export function diagramCreationService(config: AppConfig, db: AppDatabase, principal: Principal) {
  function owned(id: string, scope: 'knowledge:read' | 'knowledge:write' = 'knowledge:write') {
    assertRoot(config, db);
    const row = db.prepare('SELECT * FROM diagram_creation_intents WHERE id=?').get(id) as
      | CreationRow
      | undefined;
    if (!row || row.principal !== principal.id || row.client_id !== principal.clientId)
      fail(404, 'NOT_FOUND');
    let path = row.path;
    if (row.status === 'published') {
      // The reservation path is immutable history; access follows the active note after publication.
      const current = db.prepare('SELECT path FROM notes WHERE id=? AND active=1').get(row.note_id) as
        | { path: string }
        | undefined;
      if (!current) fail(404, 'NOT_FOUND');
      path = current.path;
    }
    authorizePath(principal, path, scope);
    return row;
  }
  function get(id: string, options: { scope?: 'knowledge:read' | 'knowledge:write' } = {}): DiagramCreationIntent {
    return project(owned(id, options.scope));
  }
  function reserve(value: {
    path: string;
    type: DiagramDocumentType;
    requestId: string;
  }): DiagramCreationIntent {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) fail(400, 'INVALID_INPUT', '图形创建请求格式不正确');
    const input = parsed.data;
    authorizePath(principal, input.path, 'knowledge:write');
    return workspaceWriteSync(db, { kind: 'diagram-creation.reserve' }, () => {
      assertRoot(config, db);
      assertWritable(db);
      // Resolve against actual directories; neither an invalid path nor a symlink gets reserved.
      const target = safePath(config.knowledgeRoot, input.path, 'note', true);
      return db
        .transaction(() => {
          const { operation, fresh } = beginOperation(
            db,
            principal,
            'diagram-creation.reserve',
            input.requestId,
            { path: input.path, type: input.type },
          );
          if (!fresh) {
            const receipt = existingResult(operation) as { id: string };
            return get(receipt.id);
          }
          const now = Date.now();
          db.prepare(
            "UPDATE diagram_creation_intents SET status='expired' WHERE path=? AND status IN ('reserved','prepared') AND expires_at<=? AND commit_operation_id IS NULL",
          ).run(input.path, now);
          if (
            existsSync(target) ||
            db.prepare('SELECT 1 FROM notes WHERE path=? AND active=1').get(input.path) ||
            db
              .prepare(
                "SELECT 1 FROM diagram_creation_intents WHERE path=? AND status IN ('reserved','prepared')",
              )
              .get(input.path)
          )
            fail(409, 'NAME_CONFLICT');
          const noteId = randomUUID();
          db.prepare(
            'INSERT INTO diagram_creation_intents(id,note_id,path,document_type,principal,client_id,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
          ).run(
            operation.id,
            noteId,
            input.path,
            input.type,
            principal.id,
            principal.clientId,
            'reserved',
            now,
            now + DIAGRAM_CREATION_LEASE_MS,
          );
          const result = get(operation.id);
          completeOperation(db, operation.id, { id: result.id });
          return result;
        })
        .immediate();
    });
  }
  function cancel(id: string): DiagramCreationIntent {
    return workspaceWriteSync(db, { kind: 'diagram-creation.cancel' }, () =>
      db
        .transaction(() => {
          const row = owned(id),
            current = project(row);
          if (row.commit_operation_id && row.status !== 'published')
            fail(409, 'CREATION_COMMIT_IN_PROGRESS', '提交结果待确认，请先完成恢复');
          if (current.status === 'published') fail(409, 'CREATION_ALREADY_PUBLISHED');
          if (current.status === 'cancelled' || current.status === 'expired') return current;
          assertWritable(db);
          db.prepare(
            "UPDATE diagram_creation_intents SET status='cancelled' WHERE id=? AND status IN ('reserved','prepared')",
          ).run(id);
          return get(id);
        })
        .immediate(),
    );
  }
  return { reserve, get, cancel };
}
