import { readFileSync, statSync } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { sha256 } from './operations.js';
import type { MigrationRow } from './diagram-migration-journal.js';
/** Called only after manifest-verified backup copying. Copied files have fresh filesystem versions. */
export function rebindRestoredWhiteboardMigrations(config: AppConfig, db: AppDatabase) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='whiteboard_migrations'").get()) return;
  for (const row of db
    .prepare(
      "SELECT * FROM whiteboard_migrations WHERE status IN ('planned','prepared','awaiting-native-previews','committing','rolling_back')",
    )
    .all() as MigrationRow[]) {
    try {
      const plan = JSON.parse(row.plan),
        active = db.prepare('SELECT path FROM notes WHERE id=?').get(row.note_id) as {
          path: string;
        };
      if (active.path === row.old_path && row.status !== 'rolling_back') {
        const old = safePath(config.knowledgeRoot, row.old_path, 'note');
        if (sha256(readFileSync(old)) !== plan.oldHash) continue;
        plan.oldModifiedAt = statSync(old, { bigint: true }).mtimeNs.toString();
        db.prepare('UPDATE whiteboard_migrations SET plan=? WHERE id=?').run(
          JSON.stringify(plan),
          row.id,
        );
      }
      const operationId =
        row.status === 'rolling_back' ? row.rollback_operation_id : row.commit_operation_id;
      if (operationId)
        db.prepare(
          "UPDATE write_intents SET status='prepared' WHERE id=? AND kind IN ('whiteboard-migrate','whiteboard-rollback') AND status='conflicted'",
        ).run(operationId);
    } catch {
      /* Keep the explicit conflicted journal and original bytes for owner reconciliation. */
    }
  }
}
