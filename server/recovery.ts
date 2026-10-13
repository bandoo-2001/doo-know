import {
  mkdirSync,
  lstatSync,
  statSync,
  linkSync,
  unlinkSync,
  readFileSync,
  copyFileSync,
  existsSync,
  constants,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { AppConfig } from '../shared/contracts.js';
import type { AppDatabase } from './db.js';
import type { NoteService } from './notes.js';
import { HttpError } from './errors.js';
import { safePath, validName } from './files.js';
import { mutationCore, webPrincipal } from './knowledge/core.js';
import { randomUUID } from 'node:crypto';
export function recoveryService(config: AppConfig, db: AppDatabase, notes: NoteService) {
  function history(id: string, before?: string) {
    notes.row(id);
    return (
      db
        .prepare(
          'SELECT id,file,created_at AS createdAt,modified_at AS modifiedAt FROM revisions WHERE note_id=? AND (? IS NULL OR rowid<(SELECT rowid FROM revisions WHERE id=? AND note_id=?)) ORDER BY rowid DESC LIMIT 51',
        )
        .all(id, before || null, before || null, id) as {
        id: string;
        file: string;
        createdAt: string;
        modifiedAt: string;
      }[]
    ).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      modifiedAt: r.modifiedAt,
      sizeBytes: statSync(join(config.dataRoot, 'history', r.file)).size,
    }));
  }
  function restoreRevision(id: string, revisionId: string, expected: string) {
    const r = db
      .prepare('SELECT file FROM revisions WHERE id=? AND note_id=?')
      .get(revisionId, id) as { file: string } | undefined;
    if (!r) throw new HttpError(404, '历史版本不存在');
    return notes.saveNote(
      id,
      readFileSync(join(config.dataRoot, 'history', r.file), 'utf8'),
      expected,
    );
  }
  function checkedTrash(id: string, create = false) {
    const archive = join(config.knowledgeRoot, '90-Archive');
    if (create) mkdirSync(archive, { recursive: true, mode: 0o700 });
    safePath(config.knowledgeRoot, '90-Archive', 'folder');
    let path = archive;
    for (const part of ['.trash', id]) {
      path = join(path, part);
      if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
      const s = lstatSync(path);
      if (!s.isDirectory() || s.isSymbolicLink()) throw new HttpError(400, '回收站路径不允许');
    }
    return path;
  }
  function deleteNote(id: string) {
    const n = notes.row(id);
    const version = lstatSync(safePath(config.knowledgeRoot, n.path, 'note'), {
      bigint: true,
    }).mtimeNs.toString();
    mutationCore(config, db).archive(webPrincipal, id, version, randomUUID());
    return { deleted: true };
  }
  function trash() {
    return db
      .prepare(
        'SELECT id,path AS relativePath FROM notes WHERE active=0 AND trash_path IS NOT NULL ORDER BY path',
      )
      .all();
  }
  function restore(id: string, fileName?: string) {
    const n = notes.row(id, true);
    if (n.active || !n.trash_path) throw new HttpError(404, '回收站笔记不存在');
    const name = fileName || basename(n.path);
    if (!validName(name) || !name.toLowerCase().endsWith('.md'))
      throw new HttpError(400, '请输入有效 .md 文件名');
    const path = dirname(n.path) === '.' ? name : `${dirname(n.path)}/${name}`;
    const dest = safePath(config.knowledgeRoot, path, 'note', true),
      source = join(checkedTrash(id), n.trash_path);
    const st = lstatSync(source);
    if (!st.isFile() || st.isSymbolicLink()) throw new HttpError(404, '回收站文件不存在');
    try {
      copyFileSync(source, dest, constants.COPYFILE_EXCL);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new HttpError(409, '原位置已被占用，请选择新文件名');
      throw e;
    }
    try {
      db.transaction(() => {
        db.prepare('UPDATE notes SET path=?,active=1,trash_path=NULL WHERE id=?').run(path, id);
        db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(id);
        unlinkSync(source);
      })();
    } catch (e) {
      let preserved = existsSync(source);
      if (!preserved) {
        try {
          copyFileSync(dest, source, constants.COPYFILE_EXCL);
          preserved = true;
        } catch {}
      }
      if (preserved) {
        try {
          unlinkSync(dest);
        } catch {}
      }
      throw e;
    }
    return notes.getNote(id);
  }
  return { history, restoreRevision, deleteNote, trash, restore };
}
