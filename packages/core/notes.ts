import {documentTitle,documentType,isWhiteboard,parseWhiteboard,MAX_WHITEBOARD_BYTES,withWhiteboardId,whiteboardId} from '../../shared/whiteboard.js';
import { hasActiveShare } from './share-policy.js';
import { assertOrganizationReadable, workspaceWriteSync } from './workspace/gate.js';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  openSync,
  closeSync,
  fsyncSync,
  lstatSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { AppConfig, NoteDocument, TreeEntry } from '../../shared/contracts.js';
import type { AppDatabase } from './db.js';
import { HttpError, text } from './errors.js';
import { readDocument, safePath, scanFiles, validName, isMissingSource, sourceErrorCode } from './files.js';
import { mutationCore, webPrincipal } from './knowledge/core.js';
import { KnowledgeError } from './knowledge/errors.js';
import { assertRoot } from './indexing/reconcile.js';
import { recoverFolders } from './folders.js';
import { portableLibrary } from './portable-library.js';
export interface NoteRow {
  id: string;
  path: string;
  active: number;
  trash_path: string | null;
}
export function noteService(config: AppConfig, db: AppDatabase) {
  const library = portableLibrary(config, db);
  const mutations = mutationCore(config, db);
  function scan() {
    assertOrganizationReadable(db);
    assertRoot(config, db);
    library.refresh();
    recoverFolders(config, db);
    if (
      db.prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')").get()
    )
      throw new KnowledgeError(503, 'SYNC_IN_PROGRESS', '原文同步中', true);
    const files = scanFiles(config.knowledgeRoot);
    assertRoot(config, db);
    db.transaction(() => {
      const live = new Set(files.notes);
      for (const row of db.prepare('SELECT * FROM notes WHERE active=1').all() as NoteRow[])
        if (
          !live.has(row.path) &&
          !db
            .prepare(
              "SELECT 1 FROM write_intents WHERE note_id=? AND kind='move' AND status IN ('prepared','conflicted')",
            )
            .get(row.id)
        ) {
          db.prepare('UPDATE notes SET active=0 WHERE id=?').run(row.id);
          db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(row.id);
        }
      for (const path of files.notes)
        if (
          !db
            .prepare(
              "SELECT 1 FROM write_intents WHERE path=? AND kind IN ('restore','move','create') AND status IN ('prepared','conflicted')",
            )
            .get(path) &&
          !db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path)
        ) {
          let identity:string|undefined;
          if(isWhiteboard(path))try{identity=whiteboardId(parseWhiteboard(readDocument(config.knowledgeRoot,path).content).dooknow?.id||'');}catch{}
          identity = library.identity(path, identity);
          if (db.prepare('SELECT 1 FROM notes WHERE id=?').get(identity)) {
            db.prepare('UPDATE notes SET path=?,active=1 WHERE id=?').run(path, identity);
            db.prepare('UPDATE document_state SET active=0 WHERE note_id=?').run(identity);
            db.prepare('UPDATE chunks SET active=0 WHERE note_id=?').run(identity);
          }
          else db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(identity, path);
        }
    }).immediate();
    library.flush();
    return files;
  }
  function row(id: string, deleted = false) {
    assertOrganizationReadable(db);
    assertRoot(config, db);
    library.refresh();
    const note = db.prepare('SELECT * FROM notes WHERE id=?').get(id) as NoteRow | undefined;
    if (!note || (!deleted && !note.active)) throw new HttpError(404, '笔记不存在');
    return note;
  }
  function getNote(id: string): NoteDocument {
    const n = row(id);
    try {
      const doc = readDocument(config.knowledgeRoot, n.path);
      if (isWhiteboard(n.path)) { try { parseWhiteboard(doc.content); } catch(e) { throw new HttpError(422, (e as Error).message); } }
      return {
        id,
        title: documentTitle(n.path, doc.content),
        documentType: documentType(n.path),
        relativePath: n.path,
        ...doc,
        shared: hasActiveShare(db, id),
      };
    } catch (e) {
      if (isMissingSource(e)) {
        const confirmedMissing = db.transaction(() => {
          // A changed root, completed move or reappearing file must not let an
          // obsolete read failure delete the current identity or its grants.
          assertRoot(config, db);
          const current = db.prepare('SELECT * FROM notes WHERE id=?').get(id) as NoteRow | undefined;
          if (!current || !current.active) return true;
          if (current.path !== n.path) return false;
          if (
            db.prepare("SELECT 1 FROM write_intents WHERE note_id=? AND kind='move' AND status IN ('prepared','conflicted')").get(id)
          )
            throw new KnowledgeError(409, 'OPERATION_OUTCOME_UNKNOWN', '移动尚未完成，请核对操作状态', true);
          if (db.prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')").get())
            throw new KnowledgeError(503, 'SYNC_IN_PROGRESS', '原文同步中', true);
          try {
            safePath(config.knowledgeRoot, current.path, 'note');
          } catch (confirmation) {
            if (!isMissingSource(confirmation))
              throw new KnowledgeError(503, 'SOURCE_UNAVAILABLE', '原文读取不可用', true);
            db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(id);
            db.prepare('UPDATE notes SET active=0 WHERE id=?').run(id);
            return true;
          }
          return false;
        }).immediate();
        if (!confirmedMissing)
          throw new KnowledgeError(503, 'SOURCE_UNAVAILABLE', '原文读取期间变化，请重试', true);
      }
      if (['EACCES', 'EPERM', 'EIO', 'ESTALE', 'EMFILE', 'ENFILE', 'ETIMEDOUT'].includes(sourceErrorCode(e) || ''))
        throw new KnowledgeError(503, 'SOURCE_UNAVAILABLE', '原文读取不可用', true);
      throw e;
    }
  }
  function modificationTime(path: string, kind: 'note' | 'folder') {
    try {
      return statSync(safePath(config.knowledgeRoot, path, kind)).mtime.toISOString();
    } catch {
      return undefined;
    }
  }
  function tree(ownerId?: string): TreeEntry[] {
    const files = scan();
    const favorites = new Set(
      ownerId
        ? (
            db.prepare('SELECT note_id FROM note_favorites WHERE owner_id=?').all(ownerId) as {
              note_id: string;
            }[]
          ).map((n) => n.note_id)
        : [],
    );
    const all: TreeEntry[] = files.folders.map((path) => ({
      path,
      name: basename(path),
      type: 'folder',
      children: [],
      updatedAt: modificationTime(path, 'folder'),
    }));
    for (const n of db.prepare('SELECT * FROM notes WHERE active=1').all() as NoteRow[])
      all.push({
        id: n.id,
        path: n.path,
        name: basename(n.path),
        type: 'note',
        ...(isWhiteboard(n.path) ? {documentType: 'whiteboard' as const} : {}),
        updatedAt: modificationTime(n.path, 'note'),
        ...(ownerId ? { favorite: favorites.has(n.id) } : {}),
      });
    const map = new Map(all.map((e) => [e.path, e])),
      roots: TreeEntry[] = [];
    for (const e of all) {
      const parent = map.get(dirname(e.path));
      if (parent) parent.children!.push(e);
      else roots.push(e);
    }
    const sort = (items: TreeEntry[]) => {
      items.sort(
        (a, b) =>
          (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) ||
          a.name.localeCompare(b.name, 'zh-CN'),
      );
      items.forEach((i) => i.children && sort(i.children));
    };
    sort(roots);
    return roots;
  }
  function createNote(
    folderPath: string,
    fileName: string,
    content: string,
    requestId: string = randomUUID(),
  ) {
    const result = mutations.create(webPrincipal, folderPath, fileName, content, requestId);
    return getNote(result.id);
  }
  function saveNote(
    id: string,
    content: string,
    expectedModifiedAt: string,
    requestId: string = randomUUID(),
  ) {
    const shared = hasActiveShare(db, id);
    const receipt = mutations.update(webPrincipal, id, content, expectedModifiedAt, requestId);
    if(isWhiteboard(receipt.relativePath))content=withWhiteboardId(content,id);
    try {
      const current = getNote(id);
      // A later save may already exist when an old request is replayed. Its
      // response still describes the original write; current state is read via GET.
      return {
        ...current,
        relativePath: receipt.relativePath,
        content,
        title: documentTitle(receipt.relativePath, content),
        documentType: documentType(receipt.relativePath),
        modifiedAt: receipt.modifiedAt,
        updatedAt: new Date(Number(BigInt(receipt.modifiedAt) / 1000000n)).toISOString(),
        receipt,
      };
    } catch (e) {
      // The committed receipt is authoritative. Optional current-content reads cannot
      // turn a successful mutation into a deterministic HTTP failure.
      const longestLineBytes = content
        .split('\n')
        .reduce((max, line) => Math.max(max, Buffer.byteLength(line)), 0);
      const editorMode = longestLineBytes > 32768 ? ('large' as const) : ('full' as const);
      const title = [
        ...(content.match(/^#\s+(.+)$/m)?.[1] || basename(receipt.relativePath, '.md')),
      ]
        .slice(0, 256)
        .join('');
      const metadata = {
        ...receipt,
        title,
        editorMode,
        longestLineBytes,
        url: `${config.origin}/?note=${encodeURIComponent(id)}`,
        sourceRevision: null,
        readState: 'unknown' as const,
        receipt,
        ...(e instanceof KnowledgeError && e.code === 'LARGE_FILE_MODE_REQUIRED'
          ? {}
          : {
              currentReadError: e instanceof KnowledgeError ? e.code : 'CURRENT_READ_UNAVAILABLE',
            }),
      };
      return editorMode === 'large'
        ? metadata
        : {
            ...metadata,
            content,
            shared,
            updatedAt: new Date(Number(BigInt(receipt.modifiedAt) / 1000000n)).toISOString(),
          };
    }
  }

  function createFolder(parent: string, name: string) {
    if (!validName(name) || name === 'assets') throw new HttpError(400, '文件夹名不允许');
    assertRoot(config, db);
    recoverFolders(config, db);
    const folder =
      parent === '' ? config.knowledgeRoot : safePath(config.knowledgeRoot, parent, 'folder');
    if (!lstatSync(folder).isDirectory()) throw new HttpError(400, '目标不是目录');
    try {
      mkdirSync(
        safePath(config.knowledgeRoot, parent === '' ? name : `${parent}/${name}`, 'folder', true),
        {
          mode: 0o700,
        },
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, '目录已存在');
      throw e;
    }
    return tree();
  }
  const exists = (id: string) => {
    const n = row(id);
    safePath(config.knowledgeRoot, n.path, 'note');
    return n;
  };
  return {
    scan,
    row,
    getNote,
    tree,
    createNote,
    saveNote,
    createFolder: (...args: Parameters<typeof createFolder>) =>
      workspaceWriteSync(db, { kind: 'folder.create' }, () => createFolder(...args)),
    exists,
    setFavorite(ownerId: string, id: string, favorite: unknown) {
      if (typeof favorite !== 'boolean') throw new HttpError(400, '收藏状态必须为布尔值');
      return workspaceWriteSync(db, { kind: 'note.favorite' }, () => {
        library.refresh();
        exists(id);
        if (favorite)
          db.prepare('INSERT OR IGNORE INTO note_favorites(owner_id,note_id) VALUES(?,?)').run(
            ownerId,
            id,
          );
        else
          db.prepare('DELETE FROM note_favorites WHERE owner_id=? AND note_id=?').run(ownerId, id);
        return { favorite };
      });
    },
  };
}
export type NoteService = ReturnType<typeof noteService>;
export function saveInput(body: unknown) {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== 'object' || 'force' in b) throw new HttpError(400, '保存请求格式不正确');
  const content = text(b.content, '正文', MAX_WHITEBOARD_BYTES),
    expectedModifiedAt = text(b.expectedModifiedAt, '版本', 30);
  if (!/^\d+$/.test(expectedModifiedAt)) throw new HttpError(400, '版本格式不正确');
  return { content, expectedModifiedAt };
}
