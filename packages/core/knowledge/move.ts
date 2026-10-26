import {isDocument,isWhiteboard} from '../../../shared/whiteboard.js';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  fsyncSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { AppDatabase } from '../db.js';
import { safePath, validName, readDocument } from '../files.js';
import { references, localReference } from '../render.js';
import { authorizePath } from '../agent/auth.js';
import { assertRoot } from '../indexing/reconcile.js';
import { workspaceBegin, workspaceWriteSync } from '../workspace/gate.js';
import { assertWritable, fsyncDirectory, restoreHash } from './core.js';
import { acquireNoteWrite, releaseNoteWrite } from './write-lease.js';
import { beginOperation, existingResult, sha256 } from './operations.js';
import { fail, KnowledgeError } from './errors.js';

export function moveService(config: AppConfig, db: AppDatabase, record: (intent: any) => any) {
  const stageFor = (intent: any) =>
    join(dirname(join(config.knowledgeRoot, intent.path)), `.doo-move-${intent.id}.tmp`);
  function finish(intent: any) {
    const current = db
      .prepare(
        'SELECT o.*,w.status AS intent_status FROM write_intents w JOIN operations o ON o.id=w.id WHERE w.id=?',
      )
      .get(intent.id) as any;
    if (current?.intent_status === 'recorded') return existingResult(current);
    if (
      current?.intent_status !== 'prepared' ||
      !['prepared', 'committing', 'needs_reconciliation'].includes(current.status)
    )
      fail(409, 'OPERATION_OUTCOME_UNKNOWN');
    assertRoot(config, db);
    assertWritable(db, intent.note_id, intent.id, intent.id);
    const note = db.prepare('SELECT * FROM notes WHERE id=?').get(intent.note_id) as any;
    if (!note?.active || join(config.knowledgeRoot, note.path) !== intent.temp_path)
      fail(409, 'MOVE_CONFLICT');
    if (
      db
        .prepare('SELECT 1 FROM notes WHERE path=? AND active=1 AND id<>?')
        .get(intent.path, intent.note_id) ||
      db
        .prepare(
          "SELECT 1 FROM write_intents WHERE path=? AND id<>? AND status IN ('prepared','conflicted')",
        )
        .get(intent.path, intent.id)
    )
      fail(409, 'NAME_CONFLICT');
    // A published target still shares our publication inode until recovery
    // removes that private name. Validate the parent, then check that exact
    // inode below instead of rejecting our own temporary hard link.
    const targetParent =
        dirname(intent.path) === '.'
          ? config.knowledgeRoot
          : safePath(config.knowledgeRoot, dirname(intent.path), 'folder'),
      source = safePath(config.knowledgeRoot, note.path, 'note', true),
      dest = join(targetParent, basename(intent.path)),
      stage = stageFor(intent),
      publication = `${stage}.publish`,
      evidence = JSON.parse(intent.original_hash);
    if (
      dirname(note.path) !== dirname(intent.path) &&
      evidence.referencesChecked !== intent.target_hash
    )
      fail(
        409,
        'CROSS_DIRECTORY_MOVE_REQUIRES_REVIEW',
        '跨目录移动缺少相对引用核对证据，请先人工核对',
      );
    const sourceMatches = () => {
      const s = lstatSync(source, { bigint: true });
      return (
        s.isFile() &&
        !s.isSymbolicLink() &&
        s.nlink === 1n &&
        String(s.dev) === evidence.source.dev &&
        String(s.ino) === evidence.source.ino &&
        s.mtimeNs.toString() === intent.original_mtime &&
        restoreHash(source) === intent.target_hash
      );
    };
    const privateMatches = (file: string) => {
      const s = lstatSync(file);
      return (
        s.isFile() &&
        !s.isSymbolicLink() &&
        s.nlink === 1 &&
        restoreHash(file) === intent.target_hash
      );
    };
    const syncFile = (file: string) => {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDirectory(dirname(file));
    };
    if (existsSync(source) && !sourceMatches()) fail(409, 'MOVE_CONFLICT', '移动原件发生变化');
    if (!existsSync(stage)) {
      if (!existsSync(source)) fail(409, 'MOVE_CONFLICT', '移动原件证据缺失');
      copyFileSync(source, stage, constants.COPYFILE_EXCL);
      syncFile(stage);
    }
    if (!privateMatches(stage)) fail(409, 'MOVE_CONFLICT', '移动暂存副本需要核对');
    syncFile(stage);
    if (!evidence.publication) {
      if (existsSync(dest) || existsSync(publication)) fail(409, 'NAME_CONFLICT');
      copyFileSync(stage, publication, constants.COPYFILE_EXCL);
      syncFile(publication);
      if (!privateMatches(publication)) fail(409, 'MOVE_CONFLICT');
      const s = lstatSync(publication, { bigint: true });
      evidence.publication = { dev: String(s.dev), ino: String(s.ino) };
      intent.original_hash = JSON.stringify(evidence);
      db.prepare('UPDATE write_intents SET original_hash=? WHERE id=?').run(
        intent.original_hash,
        intent.id,
      );
    }
    if (!existsSync(dest)) {
      if (!existsSync(publication) || !privateMatches(publication)) fail(409, 'MOVE_CONFLICT');
      const pub = lstatSync(publication, { bigint: true });
      if (
        String(pub.dev) !== evidence.publication.dev ||
        String(pub.ino) !== evidence.publication.ino
      )
        fail(409, 'MOVE_CONFLICT');
      try {
        linkSync(publication, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail(409, 'NAME_CONFLICT');
        throw e;
      }
      fsyncDirectory(dirname(dest));
    }
    const destinationMatches = () => {
      const s = lstatSync(dest, { bigint: true });
      return (
        s.isFile() &&
        !s.isSymbolicLink() &&
        String(s.dev) === evidence.publication.dev &&
        String(s.ino) === evidence.publication.ino &&
        restoreHash(dest) === intent.target_hash
      );
    };
    if (!destinationMatches()) fail(409, 'MOVE_CONFLICT', '移动目标发生外部变化');
    if (existsSync(publication)) {
      const s = lstatSync(publication, { bigint: true });
      if (
        String(s.dev) !== evidence.publication.dev ||
        String(s.ino) !== evidence.publication.ino ||
        s.isSymbolicLink()
      )
        fail(409, 'MOVE_CONFLICT');
      unlinkSync(publication);
      fsyncDirectory(dirname(dest));
    }
    const result = db
      .transaction(() => {
        if (!destinationMatches()) fail(409, 'MOVE_CONFLICT');
        if (existsSync(source)) {
          if (!sourceMatches()) fail(409, 'MOVE_CONFLICT');
          unlinkSync(source);
          fsyncDirectory(dirname(source));
        }
        return record(intent);
      })
      .immediate();
    try {
      if (destinationMatches() && privateMatches(stage)) {
        unlinkSync(stage);
        fsyncDirectory(dirname(stage));
      }
    } catch {
      /* The committed receipt remains authoritative. */
    }
    return result;
  }
  function move(
    p: Principal,
    id: string,
    folderPath: string,
    fileName: string,
    expectedModifiedAt: string,
    requestId: string,
  ) {
    assertRoot(config, db);
    if (
      typeof folderPath !== 'string' ||
      typeof fileName !== 'string' ||
      !validName(fileName) ||
      !isDocument(fileName)
    )
      fail(400, 'INVALID_INPUT');
    if (typeof expectedModifiedAt !== 'string' || !/^\d+$/.test(expectedModifiedAt))
      fail(400, 'INVALID_VERSION');
    const path = folderPath === '' ? fileName : `${folderPath}/${fileName}`,
      note = db.prepare('SELECT * FROM notes WHERE id=?').get(id) as any;
    if (!note) fail(404, 'NOT_FOUND');
    if (isWhiteboard(note.path) !== isWhiteboard(fileName)) fail(400, 'INVALID_INPUT', '改名时请保留原文件类型');
    authorizePath(p, note.path, 'knowledge:write');
    authorizePath(p, path, 'knowledge:write');
    const op = workspaceBegin(db, () =>
      beginOperation(db, p, 'move', requestId, { id, folderPath, fileName, expectedModifiedAt }),
    );
    if (!op.fresh) return existingResult(op.operation);
    let prepared = false,
      owned = false;
    try {
      acquireNoteWrite(db, id, op.operation.id);
      owned = true;
      if (!note.active) fail(404, 'NOT_FOUND');
      if (path === note.path) fail(400, 'SAME_PATH');
      const source = safePath(config.knowledgeRoot, note.path, 'note'),
        dest = safePath(config.knowledgeRoot, path, 'note', true),
        s = lstatSync(source, { bigint: true });
      if (s.mtimeNs.toString() !== expectedModifiedAt) fail(409, 'VERSION_CONFLICT');
      if (existsSync(dest) || db.prepare('SELECT 1 FROM notes WHERE path=? AND active=1').get(path))
        fail(409, 'NAME_CONFLICT');
      const hash = restoreHash(source);
      let referencesChecked: string | undefined;
      if (dirname(note.path) !== dirname(path)) {
        let document: ReturnType<typeof readDocument>;
        try {
          document = readDocument(config.knowledgeRoot, note.path);
        } catch (error) {
          if (
            error instanceof KnowledgeError &&
            ['LARGE_FILE_MODE_REQUIRED', 'FILE_TOO_LARGE', 'INVALID_UTF8'].includes(error.code)
          )
            fail(
              409,
              'CROSS_DIRECTORY_MOVE_REQUIRES_REVIEW',
              '当前正文无法安全核对相对引用，暂不支持跨目录移动；可在原目录改名',
            );
          throw error;
        }
        if (document.modifiedAt !== expectedModifiedAt || sha256(document.content) !== hash)
          fail(409, 'VERSION_CONFLICT');
        if (
          (!isWhiteboard(note.path) && references(document.content).some((url) => localReference(note.path, url) !== undefined))
        )
          fail(
            409,
            'RELATIVE_REFERENCES_REQUIRE_REVIEW',
            '正文含有相对链接或附件引用，请先核对并调整引用；可在原目录改名',
          );
        referencesChecked = hash;
      }
      if (lstatSync(source, { bigint: true }).mtimeNs !== s.mtimeNs) fail(409, 'VERSION_CONFLICT');
      db.transaction(() => {
        assertWritable(db, id, undefined, op.operation.id);
        const latest = db.prepare('SELECT path,active FROM notes WHERE id=?').get(id) as any;
        if (!latest?.active || latest.path !== note.path) fail(409, 'VERSION_CONFLICT');
        if (
          db.prepare('SELECT 1 FROM notes WHERE path=? AND active=1').get(path) ||
          db
            .prepare(
              "SELECT 1 FROM write_intents WHERE path=? AND status IN ('prepared','conflicted')",
            )
            .get(path)
        )
          fail(409, 'NAME_CONFLICT');
        db.prepare(
          'INSERT INTO write_intents(id,note_id,path,kind,original_hash,original_mtime,target_hash,temp_path) VALUES(?,?,?,?,?,?,?,?)',
        ).run(
          op.operation.id,
          id,
          path,
          'move',
          JSON.stringify({
            source: { dev: String(s.dev), ino: String(s.ino) },
            ...(referencesChecked ? { referencesChecked } : {}),
          }),
          expectedModifiedAt,
          hash,
          source,
        );
      }).immediate();
      prepared = true;
      return finish(db.prepare('SELECT * FROM write_intents WHERE id=?').get(op.operation.id));
    } catch (e) {
      const error = e as any;
      db.prepare('UPDATE operations SET status=?,error=?,updated_at=? WHERE id=?').run(
        prepared ? 'needs_reconciliation' : 'failed',
        JSON.stringify({
          status: error.statusCode || 500,
          code: error.code || 'MOVE_FAILED',
          retryable: prepared,
        }),
        Date.now(),
        op.operation.id,
      );
      if (prepared)
        db.prepare("UPDATE write_intents SET status='conflicted' WHERE id=?").run(op.operation.id);
      throw e;
    } finally {
      if (owned) releaseNoteWrite(db, id, op.operation.id);
    }
  }
  return {
    move: (...args: Parameters<typeof move>) =>
      workspaceWriteSync(db, { kind: 'core.move' }, () => move(...args)),
    finish,
  };
}
