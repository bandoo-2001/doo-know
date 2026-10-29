import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath } from '../files.js';
import { assertRoot } from '../indexing/reconcile.js';
import { gitState } from '../indexing/git-state.js';
import {
  workspaceBegin,
  workspaceWrite,
  operationHasLiveWorkspaceWriter,
} from '../workspace/gate.js';
import { enqueueSource, fsyncDirectory, restoreHash, webPrincipal } from './core.js';
import {
  beginOperation,
  completeOperation,
  existingResult,
  releaseSnapshotRef,
} from './operations.js';
import { fail } from './errors.js';
import { limits } from './limits.js';

export function conflictService(config: AppConfig, db: AppDatabase) {
  function inspect(path: string) {
    const file = safePath(config.knowledgeRoot, path, 'note'),
      before = lstatSync(file, { bigint: true });
    if (before.size > BigInt(limits.file)) fail(409, 'FILE_TOO_LARGE');
    const contentHash = restoreHash(file),
      after = lstatSync(file, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.size !== after.size
    )
      fail(409, 'VERSION_CONFLICT');
    return {
      file,
      dev: String(after.dev),
      ino: String(after.ino),
      modifiedAt: after.mtimeNs.toString(),
      contentHash,
      sizeBytes: Number(after.size),
    };
  }
  const rows = () =>
    db
      .prepare(
        "SELECT w.*,o.status AS operation_status FROM write_intents w JOIN operations o ON o.id=w.id WHERE w.status='conflicted' OR o.status='needs_reconciliation' ORDER BY o.created_at,w.id",
      )
      .all() as any[];
  function eligibility(intent: any, syncBlocked: boolean) {
    if (syncBlocked) return 'GIT_MANUAL_RECONCILIATION_REQUIRED';
    if (!['create', 'update', 'patch'].includes(intent.kind))
      return 'MULTI_FILE_RECONCILIATION_REQUIRED';
    const note = db.prepare('SELECT * FROM notes WHERE id=?').get(intent.note_id) as any;
    if (!note || note.path !== intent.path || (!note.active && intent.kind !== 'create'))
      return 'NOTE_IDENTITY_REQUIRES_REVIEW';
    if (
      db
        .prepare('SELECT 1 FROM notes WHERE path=? AND active=1 AND id<>?')
        .get(intent.path, intent.note_id)
    )
      return 'NOTE_IDENTITY_REQUIRES_REVIEW';
    if (operationHasLiveWorkspaceWriter(db, intent.id)) return 'OPERATION_IN_PROGRESS';
    const lease = db
      .prepare(
        "SELECT 1 FROM file_operations WHERE id=? AND status IN ('running','committing') AND lease_until>?",
      )
      .get(intent.id, Date.now());
    if (lease) return 'OPERATION_IN_PROGRESS';
    return undefined;
  }
  async function syncStatus() {
    const syncConflicts = (
      db
        .prepare(
          "SELECT id,status FROM sync_runs WHERE status IN ('running','needs_reconciliation')",
        )
        .all() as any[]
    ).map((row) => ({
      ...row,
      resolvable: false as const,
      reason: 'GIT_MANUAL_RECONCILIATION_REQUIRED',
    }));
    const git = await gitState(config.knowledgeRoot);
    if (git.conflicts.length && !syncConflicts.length)
      syncConflicts.push({
        id: 'git-working-tree',
        status: 'needs_reconciliation',
        resolvable: false,
        reason: 'GIT_MANUAL_RECONCILIATION_REQUIRED',
      });
    return syncConflicts;
  }
  async function list() {
    assertRoot(config, db);
    const syncConflicts = await syncStatus();
    const items = rows().map((intent) => {
      let disk: ReturnType<typeof inspect> | undefined,
        reason = eligibility(intent, syncConflicts.length > 0);
      try {
        disk = inspect(intent.path);
      } catch {
        reason ||= 'DISK_STATE_REQUIRES_REVIEW';
      }
      return {
        id: intent.id,
        noteId: intent.note_id,
        kind: intent.kind,
        status: intent.operation_status,
        relativePath: intent.path,
        resolvable: !reason,
        ...(reason ? { reason } : {}),
        disk: disk
          ? {
              modifiedAt: disk.modifiedAt,
              contentHash: disk.contentHash,
              sizeBytes: disk.sizeBytes,
            }
          : null,
      };
    });
    const hasOrganization = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='organization_jobs'")
      .get();
    const organizationConflicts = hasOrganization
      ? (
          db
            .prepare(
              "SELECT id AS operationId,status,error AS code FROM organization_jobs WHERE status IN ('committing','needs_reconciliation') ORDER BY created_at DESC,id LIMIT 50",
            )
            .all() as {
            operationId: string;
            status: 'committing' | 'needs_reconciliation';
            code: string | null;
          }[]
        ).map((row) => ({
          ...row,
          code:
            typeof row.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.code)
              ? row.code
              : 'ORGANIZATION_RECOVERY_REQUIRED',
        }))
      : [];
    return {
      items,
      syncConflicts,
      ...(organizationConflicts.length ? { organizationConflicts } : {}),
    };
  }
  function ensureDirectory(path: string) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink()) fail(409, 'EVIDENCE_CONFLICT');
  }
  function preserve(source: string, dest: string) {
    const before = lstatSync(source, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      fail(409, 'EVIDENCE_CONFLICT');
    const hash = restoreHash(source);
    if (!existsSync(dest)) copyFileSync(source, dest, constants.COPYFILE_EXCL);
    const saved = lstatSync(dest);
    if (
      !saved.isFile() ||
      saved.isSymbolicLink() ||
      saved.nlink !== 1 ||
      restoreHash(dest) !== hash
    )
      fail(409, 'EVIDENCE_CONFLICT');
    const fd = openSync(dest, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const after = lstatSync(source, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.size !== after.size
    )
      fail(409, 'VERSION_CONFLICT');
    return { name: basename(dest), contentHash: hash, sizeBytes: Number(after.size) };
  }
  async function resolve(id: string, input: any) {
    if (input?.strategy !== 'keep_disk') fail(400, 'INVALID_RESOLUTION');
    if (
      typeof input.expectedModifiedAt !== 'string' ||
      !/^\d+$/.test(input.expectedModifiedAt) ||
      typeof input.expectedContentHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.expectedContentHash)
    )
      fail(400, 'INVALID_VERSION');
    return workspaceWrite(db, { kind: 'conflict.resolve' }, async () => {
      assertRoot(config, db);
      const op = workspaceBegin(db, () =>
        beginOperation(db, webPrincipal, 'resolve_conflict', input.requestId, {
          id,
          strategy: input.strategy,
          expectedModifiedAt: input.expectedModifiedAt,
          expectedContentHash: input.expectedContentHash,
        }),
      );
      if (!op.fresh && op.operation.status !== 'prepared') return existingResult(op.operation);
      const intent = rows().find((row) => row.id === id);
      if (!intent) fail(404, 'CONFLICT_NOT_FOUND');
      const reason = eligibility(intent, (await syncStatus()).length > 0);
      if (reason) fail(409, reason);
      const disk = inspect(intent.path);
      if (
        disk.modifiedAt !== input.expectedModifiedAt ||
        disk.contentHash !== input.expectedContentHash
      )
        fail(409, 'VERSION_CONFLICT');
      const root = join(config.dataRoot, 'reconciliation'),
        evidencePath = join(root, op.operation.id);
      ensureDirectory(root);
      ensureDirectory(evidencePath);
      const artifacts = [preserve(disk.file, join(evidencePath, 'disk.md'))];
      if (intent.temp_path && existsSync(intent.temp_path)) {
        if (
          dirname(intent.temp_path) !== dirname(disk.file) ||
          !basename(intent.temp_path).startsWith('.doo-')
        )
          fail(409, 'EVIDENCE_CONFLICT');
        artifacts.push(preserve(intent.temp_path, join(evidencePath, 'staged.md')));
      }
      if (intent.history_file) {
        if (basename(intent.history_file) !== intent.history_file) fail(409, 'EVIDENCE_CONFLICT');
        const history = join(config.dataRoot, 'history', intent.history_file);
        if (!existsSync(history)) fail(409, 'EVIDENCE_MISSING');
        artifacts.push(preserve(history, join(evidencePath, 'history.md')));
      }
      const manifest = JSON.stringify(
          {
            conflict: intent,
            resolutionOperationId: op.operation.id,
            strategy: 'keep_disk',
            disk,
            artifacts,
          },
          null,
          2,
        ),
        manifestFile = join(evidencePath, 'manifest.json');
      if (!existsSync(manifestFile)) {
        const fd = openSync(manifestFile, 'wx', 0o600);
        try {
          writeFileSync(fd, manifest, 'utf8');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } else if (readFileSync(manifestFile, 'utf8') !== manifest) fail(409, 'EVIDENCE_CONFLICT');
      fsyncDirectory(evidencePath);
      fsyncDirectory(root);
      fsyncDirectory(config.dataRoot);
      return db
        .transaction(() => {
          const currentOperation = db
            .prepare('SELECT * FROM operations WHERE id=?')
            .get(op.operation.id) as any;
          if (currentOperation.status === 'succeeded') return existingResult(currentOperation);
          const currentIntent = rows().find((row) => row.id === id);
          if (!currentIntent) fail(409, 'CONFLICT_ALREADY_RESOLVED');
          if (
            (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as any)?.active ||
            db
              .prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')")
              .get()
          )
            fail(503, 'SYNC_IN_PROGRESS');
          const latest = inspect(intent.path);
          if (
            latest.dev !== disk.dev ||
            latest.ino !== disk.ino ||
            latest.modifiedAt !== disk.modifiedAt ||
            latest.contentHash !== disk.contentHash
          )
            fail(409, 'VERSION_CONFLICT');
          if (eligibility(currentIntent, false)) fail(409, 'OPERATION_IN_PROGRESS');
          db.prepare('UPDATE notes SET active=1 WHERE id=?').run(intent.note_id);
          enqueueSource(
            db,
            config,
            intent.note_id,
            disk.contentHash,
            disk.modifiedAt,
            disk.sizeBytes,
          );
          db.prepare(
            'UPDATE document_state SET longest_line_bytes=NULL,conflict=0 WHERE note_id=?',
          ).run(intent.note_id);
          db.prepare("UPDATE write_intents SET status='resolved' WHERE id=?").run(id);
          db.prepare(
            "UPDATE operations SET status='failed',error='OWNER_KEPT_DISK',updated_at=? WHERE id=?",
          ).run(Date.now(), id);
          db.prepare(
            "UPDATE file_operations SET status='failed',error='OWNER_KEPT_DISK' WHERE id=?",
          ).run(id);
          releaseSnapshotRef(db, id);
          // Dead writer cleanup must leave the original staged evidence in place.
          db.prepare("UPDATE workspace_gate SET artifacts='[]' WHERE operation_id=?").run(id);
          const result = {
            id,
            operationId: op.operation.id,
            resolved: true,
            strategy: 'keep_disk',
            relativePath: intent.path,
            modifiedAt: disk.modifiedAt,
            contentHash: disk.contentHash,
            sizeBytes: disk.sizeBytes,
            evidencePreserved: true,
          };
          completeOperation(db, op.operation.id, result);
          return result;
        })
        .immediate();
    });
  }
  return { list, resolve };
}
