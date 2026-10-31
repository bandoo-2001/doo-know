import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  readFileSync,
  statSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { WhiteboardMigrationPreflight } from '../../../shared/whiteboard-migration.js';
import type { PreparedDiagramPrimary } from '../../../shared/diagram-primary.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { sha256, completeOperation } from './operations.js';
import { fail } from './errors.js';
import { verifyPendingDiagramPublication } from './diagram-publications.js';
export type MigrationRow = {
  id: string;
  note_id: string;
  principal: string;
  client_id: string;
  old_path: string;
  new_path: string;
  status: string;
  plan: string;
  prepared: string | null;
  markdown: string | null;
  backup_path: string;
  commit_operation_id: string | null;
  rollback_operation_id: string | null;
  references_json: string;
};
export function syncMigrationDirectory(path: string) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function immutableMigrationFile(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(dirname(file), '.doo-migration-' + basename(file) + '.tmp');
  const discardTemp = () => {
    if (!existsSync(temp)) return;
    const info = lstatSync(temp);
    if (!info.isFile() || info.isSymbolicLink()) fail(409, 'MIGRATION_BACKUP_CONFLICT');
    unlinkSync(temp);
  };
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || sha256(readFileSync(file)) !== sha256(content))
      fail(409, 'MIGRATION_BACKUP_CONFLICT');
    discardTemp();
    return;
  }
  // Only a private staging name may be replaced. The authoritative destination is never truncated.
  discardTemp();
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  linkSync(temp, file);
  unlinkSync(temp);
  syncMigrationDirectory(dirname(file));
  syncMigrationDirectory(dirname(dirname(file)));
}
export function verifyMigrationArtifacts(config: AppConfig, row: MigrationRow) {
  if (!row.prepared || !row.markdown) fail(409, 'MIGRATION_PREVIEW_REQUIRED');
  const p = JSON.parse(row.prepared) as PreparedDiagramPrimary;
  for (const [asset, hash] of [
    [p.source, p.sourceHash],
    [p.preview, p.previewHash],
  ] as const) {
    try {
      if (
        !asset ||
        sha256(readFileSync(safePath(config.knowledgeRoot, asset.relativePath, 'asset'))) !== hash
      )
        throw Error();
    } catch {
      fail(409, 'DIAGRAM_ARTIFACT_CONFLICT');
    }
  }
  return p;
}
/** Recoverable cutover: old remains readable until the complete target and fixed resources are durable. */
export function finishWhiteboardMigration(
  config: AppConfig,
  db: AppDatabase,
  row: MigrationRow,
  record: (intent: any, content?: string) => any,
) {
  const plan = JSON.parse(row.plan) as WhiteboardMigrationPreflight;
  verifyMigrationArtifacts(config, row);
  const old = safePath(config.knowledgeRoot, row.old_path, 'note', true),
    target = safePath(config.knowledgeRoot, row.new_path, 'note', true),
    backup = join(config.dataRoot, row.backup_path);
  if (!existsSync(backup) || sha256(readFileSync(backup)) !== plan.oldHash)
    fail(409, 'MIGRATION_BACKUP_CONFLICT');
  const current = db.prepare('SELECT path FROM notes WHERE id=?').get(row.note_id) as {
    path: string;
  };
  const intent = db
    .prepare('SELECT * FROM write_intents WHERE id=?')
    .get(row.commit_operation_id) as any;
  if (!intent) fail(409, 'MIGRATION_INTENT_MISSING');
  if (current.path === row.old_path) {
    if (
      !existsSync(old) ||
      sha256(readFileSync(old)) !== plan.oldHash ||
      statSync(old, { bigint: true }).mtimeNs.toString() !== plan.oldModifiedAt
    )
      fail(409, 'VERSION_CONFLICT');
    if (existsSync(target)) {
      if (sha256(readFileSync(target)) !== sha256(row.markdown!)) fail(409, 'NAME_CONFLICT');
    } else {
      const temp = join(dirname(target), `.doo-${row.commit_operation_id}.tmp`);
      immutableMigrationFile(temp, row.markdown!);
      linkSync(temp, target);
      unlinkSync(temp);
      syncMigrationDirectory(dirname(target));
    }
    verifyPendingDiagramPublication(config, db, row.commit_operation_id!);
    record(intent, row.markdown!);
  } else if (current.path !== row.new_path) fail(409, 'MIGRATION_IDENTITY_CONFLICT');
  const stage = join(dirname(target), `.doo-${row.commit_operation_id}.tmp`);
  if (existsSync(stage)) {
    if (sha256(readFileSync(stage)) !== sha256(row.markdown!))
      fail(409, 'MIGRATION_BACKUP_CONFLICT');
    unlinkSync(stage);
    syncMigrationDirectory(dirname(stage));
  }
  // A retry after later edits must not require the current Markdown to equal the original migration.
  // It only removes the original path when that file still matches the controlled original.
  if (existsSync(old)) {
    if (sha256(readFileSync(old)) !== plan.oldHash) fail(409, 'MIGRATION_ORIGINAL_CONFLICT');
    unlinkSync(old);
    syncMigrationDirectory(dirname(old));
  }
  db.prepare("UPDATE whiteboard_migrations SET status=? WHERE id=? AND status='committing'").run(
    plan.inbound.length ? 'references_pending' : 'committed',
    row.id,
  );
}

/** Rollback has its own durable intent; it can only publish the controlled original. */
export function finishWhiteboardRollback(
  config: AppConfig,
  db: AppDatabase,
  row: MigrationRow,
  record: (intent: any, content?: string) => any,
) {
  const fixed = JSON.parse(row.plan),
    backup = join(config.dataRoot, row.backup_path),
    original = readFileSync(backup, 'utf8');
  if (sha256(original) !== fixed.oldHash) fail(409, 'MIGRATION_BACKUP_CONFLICT');
  const old = safePath(config.knowledgeRoot, row.old_path, 'note', true),
    target = safePath(config.knowledgeRoot, row.new_path, 'note', true);
  const current = db.prepare('SELECT path FROM notes WHERE id=?').get(row.note_id) as {
    path: string;
  };
  if (current.path === row.new_path) {
    if (!existsSync(target) || sha256(readFileSync(target)) !== sha256(row.markdown!))
      fail(409, 'MIGRATION_ROLLBACK_CONFLICT');
    if (existsSync(old)) {
      if (sha256(readFileSync(old)) !== fixed.oldHash) fail(409, 'NAME_CONFLICT');
    } else immutableMigrationFile(old, original);
    const intent = db
      .prepare('SELECT * FROM write_intents WHERE id=?')
      .get(row.rollback_operation_id) as any;
    if (!intent) fail(409, 'MIGRATION_INTENT_MISSING');
    record(intent, original);
  } else if (current.path !== row.old_path) fail(409, 'MIGRATION_IDENTITY_CONFLICT');
  if (existsSync(target)) {
    if (sha256(readFileSync(target)) !== sha256(row.markdown!))
      fail(409, 'MIGRATION_ROLLBACK_CONFLICT');
    unlinkSync(target);
    syncMigrationDirectory(dirname(target));
  }
  db.prepare("UPDATE whiteboard_migrations SET status='rolled_back' WHERE id=?").run(row.id);
  completeOperation(db, row.rollback_operation_id!, {
    id: row.id,
    noteId: row.note_id,
    status: 'rolled_back',
  });
}
