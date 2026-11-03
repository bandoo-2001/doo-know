import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import { migrateOrganization } from '../organization/schema.js';
import { syncDirectoryCatalog, directoryByPath } from '../organization/catalog.js';
import {
  prepareOrganization,
  revalidateManifest,
  type OrganizationManifest,
} from '../organization/plan.js';
import { stageOrganization, commitOrganization } from '../organization/journal.js';
import { beginOperation, existingResult, completeOperation } from './operations.js';
import { fail } from './errors.js';
/** Share the multi-document journal with ordinary single moves whenever references change. */
export function journalDocumentMove(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  input: {
    id: string;
    folderPath: string;
    fileName: string;
    expectedModifiedAt: string;
    requestId: string;
    hash: string;
  },
) {
  // Legacy callers already authorize a single move through write scope. This
  // internal projection permits only that fixed action in the shared journal.
  if (p.policyVersion !== 2)
    p = { ...p, scopes: [...new Set([...p.scopes, 'knowledge:organize'])] };
  migrateOrganization(db);
  const outer = beginOperation(db, p, 'move', input.requestId, {
    id: input.id,
    folderPath: input.folderPath,
    fileName: input.fileName,
    expectedModifiedAt: input.expectedModifiedAt,
  });
  if (!outer.fresh && outer.operation.status === 'succeeded')
    return existingResult(outer.operation);
  const requestId = 'move-' + outer.operation.id;
  const state = syncDirectoryCatalog(config, db);
  const parent = input.folderPath ? directoryByPath(db, input.folderPath) : undefined;
  if (input.folderPath && !parent) fail(404, 'DIRECTORY_NOT_FOUND');
  const inner = beginOperation(db, p, 'organization.organize', requestId, {
    moveOperationId: outer.operation.id,
  });
  if (inner.fresh) {
    db.prepare('INSERT INTO organization_jobs(id,status,payload,created_at) VALUES(?,?,?,?)').run(
      inner.operation.id,
      'running',
      JSON.stringify({ principal: p, input: {} }),
      Date.now(),
    );
    try {
      const manifest = prepareOrganization(
        config,
        db,
        p,
        {
          requestId,
          libraryId: state.libraryId,
          expectedStructureRevision: state.structureRevision,
          actions: [
            {
              type: 'move_note',
              noteId: input.id,
              toDirectoryId: parent?.id ?? null,
              fileName: input.fileName,
              expectedModifiedAt: input.expectedModifiedAt,
              expectedContentHash: input.hash,
            },
          ],
        },
        inner.operation.id,
      );
      revalidateManifest(config, db, p, manifest);
      stageOrganization(config, db, manifest);
      revalidateManifest(config, db, p, manifest);
      db.transaction(() => {
        db.prepare("UPDATE organization_jobs SET status='committing',manifest=? WHERE id=?").run(
          JSON.stringify(manifest),
          inner.operation.id,
        );
        db.prepare("UPDATE operations SET status='committing' WHERE id=?").run(inner.operation.id);
      }).immediate();
      commitOrganization(config, db, manifest);
    } catch (error) {
      const row = db
        .prepare('SELECT status FROM organization_jobs WHERE id=?')
        .get(inner.operation.id) as any;
      if (row.status === 'running') {
        db.prepare("UPDATE organization_jobs SET status='failed',error=? WHERE id=?").run(
          (error as any).code ?? 'MOVE_FAILED',
          inner.operation.id,
        );
        db.prepare("UPDATE operations SET status='failed',error=? WHERE id=?").run(
          (error as any).code ?? 'MOVE_FAILED',
          inner.operation.id,
        );
      }
      throw error;
    }
  } else if (inner.operation.status !== 'succeeded') return existingResult(inner.operation);
  return recoverJournalDocumentMove(config, db, p, outer.operation)!;
}

/** Reconstruct the immutable outer receipt after an inner journal committed across a crash. */
export function recoverJournalDocumentMove(
  config: AppConfig,
  db: AppDatabase,
  p: Principal,
  outer: import('./operations.js').OperationRow,
) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='organization_jobs'").get();
  if (!table) return;
  const inner = db
    .prepare(
      "SELECT o.status,j.manifest FROM operations o JOIN organization_jobs j ON j.id=o.id WHERE o.principal=? AND o.client_id=? AND o.kind='organization.organize' AND o.request_id=?",
    )
    .get(p.id, p.clientId, 'move-' + outer.id) as { status: string; manifest: string } | undefined;
  if (inner?.status !== 'succeeded') return;
  const m = JSON.parse(inner.manifest) as OrganizationManifest,
    change = m.changes.find((c) => c.type === 'move_note'),
    file = m.objects.find((o) => o.kind === 'file' && o.note && o.id === change?.id);
  if (!file || file.kind !== 'file' || !file.published) fail(409, 'MOVE_CONFLICT');
  const result = {
    id: file.id,
    relativePath: file.to,
    previousRelativePath: file.from,
    modifiedAt: file.published.mtime,
    contentHash: file.afterHash,
    sizeBytes: file.published.size,
    indexState: 'pending',
    moved: true,
  };
  completeOperation(db, outer.id, result);
  return result;
}
