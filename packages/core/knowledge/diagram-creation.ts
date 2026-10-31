import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
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
const inputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .refine((path) => /\.md$/i.test(path)),
    type: z.enum(['whiteboard', 'mindmap', 'flowchart']),
    requestId: z.string().min(1).max(128),
  })
  .strict();
type CreationStatus = 'reserved' | 'prepared' | 'published' | 'cancelled' | 'expired';
export type DiagramCreationIntent = {
  id: string;
  noteId: string;
  relativePath: string;
  documentType: DiagramDocumentType;
  status: CreationStatus;
  createdAt: number;
  expiresAt: number;
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
};
function project(row: CreationRow): DiagramCreationIntent {
  return {
    id: row.id,
    noteId: row.note_id,
    relativePath: row.path,
    documentType: row.document_type,
    status:
      ['reserved', 'prepared'].includes(row.status) && row.expires_at <= Date.now()
        ? 'expired'
        : row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Only the bound principal/client can prepare or publish a reserved document identity. */
export function diagramCreationService(config: AppConfig, db: AppDatabase, principal: Principal) {
  function owned(id: string) {
    assertRoot(config, db);
    const row = db.prepare('SELECT * FROM diagram_creation_intents WHERE id=?').get(id) as
      | CreationRow
      | undefined;
    if (!row || row.principal !== principal.id || row.client_id !== principal.clientId)
      fail(404, 'NOT_FOUND');
    authorizePath(principal, row.path, 'knowledge:write');
    return row;
  }
  function get(id: string): DiagramCreationIntent {
    return project(owned(id));
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
            "UPDATE diagram_creation_intents SET status='expired' WHERE path=? AND status IN ('reserved','prepared') AND expires_at<=?",
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
