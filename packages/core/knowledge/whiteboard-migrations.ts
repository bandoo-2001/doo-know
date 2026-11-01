import {
  refreshMigrationNative,
  verifyNativeMigrationResources,
  recordMigrationNativeProof,
  retainMigrationNativePreparations,
} from './whiteboard-migration-native.js';
import { rewriteMigrationInbound } from './whiteboard-migration-references.js';
import { migrationAliasState } from './migration-alias-state.js';
import { posix, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { WhiteboardMigration } from '../../../shared/whiteboard-migration.js';
import {
  diagramRendererVersions,
  renderPreparedDiagramDocument,
  type PreparedDiagramPrimary,
} from '../../../shared/diagram-primary.js';
import { serializeDiagramRenderInput } from '../../../shared/diagram-document-binding.js';
import type { AppDatabase } from '../db.js';
import type { NoteService } from '../notes.js';
import type { assetService } from '../assets.js';
import { authorizePath } from '../agent/auth.js';
import { isSharePrincipal } from '../share-policy.js';
import { readDocument, safePath } from '../files.js';
import { workspaceWriteSync, workspaceBegin } from '../workspace/gate.js';
import {
  beginOperation,
  completeOperation,
  existingResult,
  sha256,
  type OperationRow,
} from './operations.js';
import { fail } from './errors.js';
import { preflightWhiteboardMigration } from './whiteboard-migration-plan.js';
import {
  immutableMigrationFile,
  finishWhiteboardMigration,
  finishWhiteboardRollback,
  verifyMigrationArtifacts,
  type MigrationRow,
} from './diagram-migration-journal.js';
import { acquireNoteWrite, releaseNoteWrite, assertWritable } from './write-lease.js';
import { mutationCore } from './core.js';
import { validatePng, DIAGRAM_SOURCE_MIMES } from './diagram-artifacts.js';
import { portableLibrary } from '../portable-library.js';
import { captureNativeLinkProof } from './native-link-proof.js';

export function whiteboardMigrationService(
  config: AppConfig,
  db: AppDatabase,
  notes: NoteService,
  assets: ReturnType<typeof assetService>,
  p: Principal,
) {
  const core = mutationCore(config, db);
  const aliases = migrationAliasState(config, db);
  aliases.refresh();
  function owner() {
    if (isSharePrincipal(p)) fail(403, 'FORBIDDEN');
  }
  function row(id: string) {
    owner();
    const r = db
      .prepare('SELECT * FROM whiteboard_migrations WHERE id=? AND principal=? AND client_id=?')
      .get(id, p.id, p.clientId) as MigrationRow | undefined;
    if (!r) fail(404, 'NOT_FOUND');
    authorizePath(p, notes.row(r.note_id).path, 'knowledge:write');
    authorizePath(p, r.old_path, 'knowledge:write');
    authorizePath(p, r.new_path, 'knowledge:write');
    return r;
  }
  function get(id: string): WhiteboardMigration {
    const r = row(id);
    const {
      nativeRewrites: _rewrites,
      originalLegacyPreviews: _legacy,
      ...fixed
    } = JSON.parse(r.plan);
    return {
      ...fixed,
      id: r.id,
      status: r.status,
      backupPath: r.backup_path,
      ...(r.prepared ? { prepared: JSON.parse(r.prepared) } : {}),
      ...(r.markdown ? { markdown: r.markdown } : {}),
      references: (
        JSON.parse(r.references_json) as { noteId: string; status: string; code?: string }[]
      ).map(({ noteId, status, code }) => ({ noteId, status, ...(code ? { code } : {}) })),
    };
  }
  function preflight(id: string) {
    owner();
    return preflightWhiteboardMigration(config, db, notes, p, id);
  }
  function plan(input: { noteId: string; requestId: string }): WhiteboardMigration {
    return workspaceWriteSync(db, { kind: 'whiteboard-migration.plan' }, () => {
      owner();
      const n = notes.row(input.noteId);
      authorizePath(p, n.path, 'knowledge:write');
      const op = workspaceBegin(db, () =>
        beginOperation(db, p, 'whiteboard-migration.plan', input.requestId, {
          noteId: input.noteId,
        }),
      );
      if (!op.fresh && op.operation.status !== 'prepared') {
        const receipt = existingResult(op.operation);
        return get(receipt.id);
      }
      const prior = db
        .prepare("SELECT id FROM whiteboard_migrations WHERE note_id=? AND status<>'rolled_back'")
        .get(input.noteId) as { id: string } | undefined;
      if (prior) {
        const result = get(prior.id);
        completeOperation(db, op.operation.id, { id: prior.id });
        return result;
      }
      const snapshot = preflight(input.noteId);
      authorizePath(p, snapshot.newPath, 'knowledge:write');
      if (snapshot.issues.length)
        fail(409, 'MIGRATION_PREFLIGHT_FAILED', '白板迁移预检未通过', false, {
          issues: snapshot.issues,
        });
      const id = op.operation.id,
        backupPath = posix.join('whiteboard-migrations', id, 'original.excalidraw');
      db.transaction(() => {
        db.prepare(
          'INSERT INTO whiteboard_migrations(id,note_id,principal,client_id,old_path,new_path,status,plan,backup_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          input.noteId,
          p.id,
          p.clientId,
          snapshot.oldPath,
          snapshot.newPath,
          snapshot.inbound.some((r) => r.native) ? 'awaiting-native-previews' : 'planned',
          JSON.stringify(snapshot),
          backupPath,
          Date.now(),
        );
        completeOperation(db, id, { id });
      }).immediate();
      immutableMigrationFile(
        join(config.dataRoot, backupPath),
        notes.getNoteSnapshot(input.noteId).note.content,
      );
      refreshMigrationNative(config, db, notes, p, row(id));
      return get(id);
    });
  }
  function baseline(r: MigrationRow) {
    const fixed = JSON.parse(r.plan),
      n = notes.row(r.note_id);
    if (n.path !== r.old_path) fail(409, 'VERSION_CONFLICT');
    const current = readDocument(config.knowledgeRoot, r.old_path, { allowDiagramLarge: true });
    if (sha256(current.content) !== fixed.oldHash || current.modifiedAt !== fixed.oldModifiedAt)
      fail(409, 'VERSION_CONFLICT');
    if (existsSync(safePath(config.knowledgeRoot, r.new_path, 'note', true)))
      fail(409, 'NAME_CONFLICT');
    const fresh = preflight(r.note_id),
      issues = fresh.issues.filter((x) => !['OPERATION_IN_PROGRESS'].includes(x.code));
    if (issues.length)
      fail(409, 'MIGRATION_PREFLIGHT_FAILED', '迁移依赖已变化，请重新核对', false, { issues });
    const added = fresh.inbound.filter(
      (x) => !fixed.inbound.some((before: any) => before.noteId === x.noteId),
    );
    if (added.length) {
      fixed.inbound.push(...added);
      db.prepare('UPDATE whiteboard_migrations SET plan=? WHERE id=?').run(
        JSON.stringify(fixed),
        r.id,
      );
    }
    return fixed;
  }
  function prepare(input: {
    migrationId: string;
    sourceHash: string;
    pngBase64: string;
    requestId: string;
  }) {
    return workspaceWriteSync(db, { kind: 'whiteboard-migration.prepare' }, () => {
      const r = row(input.migrationId),
        fixed = JSON.parse(r.plan);
      if (input.sourceHash !== fixed.sourceHash) fail(409, 'DIAGRAM_SOURCE_CONFLICT');
      if (
        typeof input.pngBase64 !== 'string' ||
        input.pngBase64.length > 14 * 1024 * 1024 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.pngBase64)
      )
        fail(400, 'INVALID_DIAGRAM_PNG');
      const png = Buffer.from(input.pngBase64, 'base64');
      validatePng(png);
      const { operation } = workspaceBegin(db, () =>
        beginOperation(db, p, 'whiteboard-migration.prepare', input.requestId, {
          migrationId: r.id,
          sourceHash: input.sourceHash,
          previewHash: sha256(png),
        }),
      );
      if (operation.status === 'succeeded') {
        verifyMigrationArtifacts(config, r);
        return get(r.id);
      }
      baseline(r);
      if (!refreshMigrationNative(config, db, notes, p, row(r.id)).ready) return get(r.id);
      assertWritable(db, r.note_id);
      const source = assets.upload(
        r.note_id,
        'migration.excalidraw',
        DIAGRAM_SOURCE_MIMES['.excalidraw'],
        Buffer.from(fixed.source),
        'migration-' + r.id + '-source',
      );
      const preview = assets.upload(
        r.note_id,
        'migration.png',
        'image/png',
        png,
        'migration-' + operation.id + '-preview',
      );
      const prepared: PreparedDiagramPrimary = {
        id: operation.id,
        noteId: r.note_id,
        type: 'whiteboard',
        documentHash: fixed.oldHash,
        baselineSourceHash: fixed.oldHash,
        sourceHash: fixed.sourceHash,
        renderHash: sha256(
          serializeDiagramRenderInput({
            type: 'whiteboard',
            sourceHash: fixed.sourceHash,
            title: fixed.title,
            renderer: diagramRendererVersions.whiteboard,
            config: {},
          }),
        ),
        previewHash: sha256(png),
        title: fixed.title,
        renderer: diagramRendererVersions.whiteboard,
        config: {},
        source,
        preview,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };
      const content = renderPreparedDiagramDocument({
        prepared,
        title: fixed.title,
        source: fixed.source,
      });
      db.transaction(() => {
        db.prepare(
          "UPDATE whiteboard_migrations SET status='prepared',prepared=?,markdown=? WHERE id=?",
        ).run(JSON.stringify(prepared), content, r.id);
        db.prepare(
          'INSERT INTO diagram_prepared_primaries(id,note_id,principal,client_id,document_hash,baseline_source_hash,source_hash,render_hash,preview_hash,result,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          prepared.id,
          r.note_id,
          p.id,
          p.clientId,
          fixed.oldHash,
          fixed.oldHash,
          prepared.sourceHash,
          prepared.renderHash,
          prepared.previewHash,
          JSON.stringify(prepared),
          Date.now(),
          prepared.expiresAt,
        );
        completeOperation(db, operation.id, { id: r.id });
      }).immediate();
      return get(r.id);
    });
  }
  function commit(input: { migrationId: string; requestId: string }) {
    return workspaceWriteSync(db, { kind: 'whiteboard-migration.commit' }, () => {
      let r = row(input.migrationId);
      const op = workspaceBegin(db, () =>
        beginOperation(db, p, 'whiteboard-migration.commit', input.requestId, {
          migrationId: r.id,
        }),
      );
      if (op.operation.status === 'succeeded') {
        if (['committing', 'committed', 'references_pending'].includes(r.status)) resume(r.id);
        return get(r.id);
      }
      if (r.commit_operation_id && r.commit_operation_id !== op.operation.id) {
        resume(r.id);
        const result = get(r.id);
        completeOperation(db, op.operation.id, result);
        return result;
      }
      if (
        r.status !== 'prepared' &&
        r.status !== 'committing' &&
        !(r.status === 'awaiting-native-previews' && r.prepared)
      )
        fail(409, 'MIGRATION_PREVIEW_REQUIRED');
      if (!r.commit_operation_id) {
        baseline(r);
        if (!refreshMigrationNative(config, db, notes, p, r).ready) return get(r.id);
        r = row(r.id);
        verifyNativeMigrationResources(config, db, p, JSON.parse(r.plan), 'before');
        verifyNativeMigrationResources(config, db, p, JSON.parse(r.plan), 'after');
      }
      acquireNoteWrite(db, r.note_id, op.operation.id, r.commit_operation_id || undefined);
      try {
        if (!r.commit_operation_id) {
          const fixed = JSON.parse(r.plan),
            prepared = verifyMigrationArtifacts(config, r);
          rewriteMigrationInbound(db, notes, p, r, () => undefined, true);
          immutableMigrationFile(
            join(config.dataRoot, r.backup_path),
            readDocument(config.knowledgeRoot, r.old_path).content,
          );
          const historyFile = op.operation.id + '.md';
          immutableMigrationFile(
            join(config.dataRoot, 'history', historyFile),
            readFileSync(join(config.dataRoot, r.backup_path), 'utf8'),
          );
          const manifest = {
            type: 'whiteboard',
            nativeLinks: captureNativeLinkProof(
              prepared.source!.relativePath,
              prepared.sourceHash,
              fixed.source,
            ),
            sourceHash: prepared.sourceHash,
            renderHash: prepared.renderHash,
            previewHash: prepared.previewHash,
            resources: [
              { role: 'source', path: prepared.source!.relativePath, hash: prepared.sourceHash },
              { role: 'preview', path: prepared.preview.relativePath, hash: prepared.previewHash },
            ],
          };
          db.transaction(() => {
            db.prepare(
              'INSERT INTO write_intents(id,note_id,path,kind,original_hash,original_mtime,target_hash,revision_id,history_file) VALUES(?,?,?,?,?,?,?,?,?)',
            ).run(
              op.operation.id,
              r.note_id,
              r.new_path,
              'whiteboard-migrate',
              fixed.oldHash,
              fixed.oldModifiedAt,
              sha256(r.markdown!),
              op.operation.id,
              historyFile,
            );
            db.prepare(
              'INSERT INTO diagram_pending_publications(operation_id,note_id,path,document_hash,manifest) VALUES(?,?,?,?,?)',
            ).run(
              op.operation.id,
              r.note_id,
              r.new_path,
              sha256(r.markdown!),
              JSON.stringify(manifest),
            );
            db.prepare(
              "UPDATE whiteboard_migrations SET status='committing',commit_operation_id=? WHERE id=?",
            ).run(op.operation.id, r.id);
          }).immediate();
          r = row(r.id);
        }
        finishWhiteboardMigration(config, db, r, core.record);
      } finally {
        releaseNoteWrite(db, r.note_id, op.operation.id);
      }
      rewriteInbound(r.id);
      portableLibrary(config, db).flush();
      aliases.flush();
      const result = get(r.id);
      completeOperation(db, op.operation.id, result);
      return result;
    });
  }
  function rewriteInbound(id: string) {
    retainMigrationNativePreparations(config, db, p, JSON.parse(row(id).plan));
    rewriteMigrationInbound(db, notes, p, row(id), (id, content, version, requestId) =>
      core.update(p, id, content, version, requestId),
    );
  }
  function resume(id: string) {
    return workspaceWriteSync(db, { kind: 'whiteboard-migration.resume' }, () => {
      const r = row(id);
      if (
        !r.commit_operation_id &&
        ['planned', 'prepared', 'awaiting-native-previews'].includes(r.status)
      ) {
        baseline(r);
        refreshMigrationNative(config, db, notes, p, r);
        return get(id);
      }
      if (r.status === 'rolling_back') {
        acquireNoteWrite(db, r.note_id, r.rollback_operation_id!, r.rollback_operation_id!);
        try {
          finishWhiteboardRollback(config, db, r, core.record);
        } finally {
          releaseNoteWrite(db, r.note_id, r.rollback_operation_id!);
        }
        portableLibrary(config, db).flush();
        aliases.flush();
        return get(id);
      }
      if (r.status === 'committing') {
        acquireNoteWrite(db, r.note_id, r.commit_operation_id!, r.commit_operation_id!);
        try {
          finishWhiteboardMigration(config, db, r, core.record);
        } finally {
          releaseNoteWrite(db, r.note_id, r.commit_operation_id!);
        }
      }
      if (['committing', 'committed', 'references_pending'].includes(r.status)) {
        rewriteInbound(id);
        portableLibrary(config, db).flush();
        aliases.flush();
      }
      return get(id);
    });
  }
  function rollback(input: { migrationId: string; requestId: string }) {
    return workspaceWriteSync(db, { kind: 'whiteboard-migration.rollback' }, () => {
      const r = row(input.migrationId),
        op = workspaceBegin(db, () =>
          beginOperation(db, p, 'whiteboard-migration.rollback', input.requestId, {
            migrationId: r.id,
          }),
        );
      if (op.operation.status === 'succeeded') return existingResult(op.operation);
      if (r.status === 'rolling_back' && r.rollback_operation_id === op.operation.id)
        return resume(r.id);
      if (!['committed', 'references_pending'].includes(r.status))
        fail(409, 'MIGRATION_ROLLBACK_CONFLICT');
      const doc = notes.getNoteSnapshot(r.note_id).note;
      if (doc.relativePath !== r.new_path || sha256(doc.content) !== sha256(r.markdown!))
        fail(409, 'MIGRATION_ROLLBACK_CONFLICT', '迁移后的文档已有修改，原件与新文档均已保留');
      verifyMigrationArtifacts(config, r);
      verifyNativeMigrationResources(config, db, p, JSON.parse(r.plan), 'before');
      verifyNativeMigrationResources(config, db, p, JSON.parse(r.plan), 'after');
      const old = safePath(config.knowledgeRoot, r.old_path, 'note', true);
      if (existsSync(old)) fail(409, 'NAME_CONFLICT');
      const original = readFileSync(join(config.dataRoot, r.backup_path), 'utf8');
      if (sha256(original) !== JSON.parse(r.plan).oldHash) fail(409, 'MIGRATION_BACKUP_CONFLICT');
      const refs = JSON.parse(r.references_json) as {
        noteId: string;
        status: string;
        before?: string;
        afterHash?: string;
      }[];
      // The versioned writer may have committed before its reference journal marker did.
      // Prove those writes before deciding which links rollback must restore or protect.
      for (const ref of refs.filter((x) => x.status !== 'rewritten' && x.afterHash)) {
        const operation = db
          .prepare(
            "SELECT * FROM operations WHERE principal=? AND client_id=? AND kind='update' AND request_id=?",
          )
          .get(p.id, p.clientId, 'migration-ref-' + r.id + '-' + ref.noteId) as
          | OperationRow
          | undefined;
        if (operation?.status === 'succeeded') {
          const receipt = existingResult(operation);
          if (receipt.id !== ref.noteId || receipt.contentHash !== ref.afterHash)
            fail(409, 'MIGRATION_ROLLBACK_CONFLICT');
          ref.status = 'rewritten';
        } else {
          const current = notes.getNoteSnapshot(ref.noteId).note;
          authorizePath(p, current.relativePath, 'knowledge:write');
          if (
            (operation && !['failed', 'cancelled'].includes(operation.status)) ||
            current.content !== ref.before
          )
            fail(409, 'MIGRATION_ROLLBACK_CONFLICT', '关联引用的写入结果仍需核对，保留两版文档');
        }
      }
      // Check every affected document before changing any reference or active mapping.
      for (const ref of refs.filter((x) => x.status === 'rewritten')) {
        const current = notes.getNoteSnapshot(ref.noteId).note;
        authorizePath(p, current.relativePath, 'knowledge:write');
        if (sha256(current.content) !== ref.afterHash && current.content !== ref.before)
          fail(409, 'MIGRATION_ROLLBACK_CONFLICT', '迁移后的引用文档已有修改，保留原件与两版文档');
      }
      db.prepare('UPDATE whiteboard_migrations SET references_json=? WHERE id=?').run(
        JSON.stringify(refs),
        r.id,
      );
      for (const ref of refs.filter((x) => x.status === 'rewritten')) {
        const current = notes.getNoteSnapshot(ref.noteId).note;
        if (current.content !== ref.before)
          core.update(
            p,
            ref.noteId,
            ref.before!,
            current.modifiedAt,
            'migration-rollback-ref-' + r.id + '-' + ref.noteId,
          );
      }
      for (const ref of refs.filter((x) => x.status === 'rewritten'))
        recordMigrationNativeProof(db, JSON.parse(r.plan), ref.noteId, 'before');
      acquireNoteWrite(db, r.note_id, op.operation.id);
      try {
        immutableMigrationFile(
          join(config.dataRoot, 'whiteboard-migrations', r.id, 'migrated.md'),
          doc.content,
        );
        const historyFile = op.operation.id + '.md';
        immutableMigrationFile(join(config.dataRoot, 'history', historyFile), doc.content);
        db.transaction(() => {
          db.prepare(
            'INSERT INTO write_intents(id,note_id,path,kind,original_hash,original_mtime,target_hash,revision_id,history_file) VALUES(?,?,?,?,?,?,?,?,?)',
          ).run(
            op.operation.id,
            r.note_id,
            r.old_path,
            'whiteboard-rollback',
            sha256(doc.content),
            doc.modifiedAt,
            sha256(original),
            op.operation.id,
            historyFile,
          );
          db.prepare(
            "UPDATE whiteboard_migrations SET status='rolling_back',rollback_operation_id=? WHERE id=?",
          ).run(op.operation.id, r.id);
        }).immediate();
        finishWhiteboardRollback(config, db, row(r.id), core.record);
        completeOperation(db, op.operation.id, {
          id: r.id,
          noteId: r.note_id,
          status: 'rolled_back',
        });
      } finally {
        releaseNoteWrite(db, r.note_id, op.operation.id);
      }
      portableLibrary(config, db).flush();
      aliases.flush();
      return { id: r.id, noteId: r.note_id, status: 'rolled_back' };
    });
  }
  return {
    preflight,
    plan,
    prepare,
    commit,
    resume,
    rollback,
    get,
    candidates: () => {
      owner();
      notes.scan();
      return (
        db
          .prepare(
            "SELECT id,path FROM notes WHERE active=1 AND lower(path) LIKE '%.excalidraw' ORDER BY path",
          )
          .all() as { id: string; path: string }[]
      ).map((n) => ({ noteId: n.id, path: n.path }));
    },
    list: () => {
      owner();
      return (
        db
          .prepare(
            'SELECT id FROM whiteboard_migrations WHERE principal=? AND client_id=? ORDER BY created_at',
          )
          .all(p.id, p.clientId) as { id: string }[]
      ).map((r) => {
        const full = get(r.id);
        return { ...full, source: '', markdown: undefined, prepared: undefined };
      });
    },
  };
}
