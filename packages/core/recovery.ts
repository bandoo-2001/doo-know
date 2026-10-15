import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../shared/contracts.js';
import type { AppDatabase } from './db.js';
import type { NoteService } from './notes.js';
import { HttpError } from './errors.js';
import { mutationCore, webPrincipal } from './knowledge/core.js';
import { KnowledgeError } from './knowledge/errors.js';
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
  function restoreRevision(id: string, revisionId: string, expected: string, requestId?: string) {
    const r = db
      .prepare('SELECT file FROM revisions WHERE id=? AND note_id=?')
      .get(revisionId, id) as { file: string } | undefined;
    if (!r) throw new HttpError(404, '历史版本不存在');
    return notes.saveNote(
      id,
      readFileSync(join(config.dataRoot, 'history', r.file), 'utf8'),
      expected,
      requestId,
    );
  }
  function deleteNote(id: string, expectedModifiedAt: string, requestId: string) {
    const receipt = mutationCore(config, db).archive(
      webPrincipal,
      id,
      expectedModifiedAt,
      requestId,
    );
    return { deleted: true, receipt };
  }
  function trash() {
    return db
      .prepare(
        'SELECT id,path AS relativePath FROM notes WHERE active=0 AND trash_path IS NOT NULL ORDER BY path',
      )
      .all();
  }
  function restore(id: string, fileName?: string, requestId: string = randomUUID()) {
    const receipt = mutationCore(config, db).restore(webPrincipal, id, fileName, requestId);
    try {
      return { ...notes.getNote(id), receipt };
    } catch (e) {
      return {
        id,
        metadataOnly: true,
        receipt,
        ...(e instanceof KnowledgeError && e.code === 'LARGE_FILE_MODE_REQUIRED'
          ? {}
          : {
              currentReadError: e instanceof KnowledgeError ? e.code : 'CURRENT_READ_UNAVAILABLE',
            }),
      };
    }
  }
  return { history, restoreRevision, deleteNote, trash, restore };
}
