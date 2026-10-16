import { workspaceWriteSync } from './workspace/gate.js';
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
import { readDocument, safePath, scanFiles, validName } from './files.js';
import { mutationCore, webPrincipal } from './knowledge/core.js';
import { KnowledgeError } from './knowledge/errors.js';
import { assertRoot } from './indexing/reconcile.js';
export interface NoteRow {
  id: string;
  path: string;
  active: number;
  trash_path: string | null;
}
export function noteService(config: AppConfig, db: AppDatabase) {
  const mutations = mutationCore(config, db);
  function scan() {
    assertRoot(config, db);
    if (
      db.prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')").get()
    )
      throw new KnowledgeError(503, 'SYNC_IN_PROGRESS', '原文同步中', true);
    const files = scanFiles(config.knowledgeRoot);
    assertRoot(config, db);
    db.transaction(() => {
      const live = new Set(files.notes);
      for (const row of db.prepare('SELECT * FROM notes WHERE active=1').all() as NoteRow[])
        if (!live.has(row.path)) {
          db.prepare('UPDATE notes SET active=0 WHERE id=?').run(row.id);
          db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(row.id);
        }
      for (const path of files.notes)
        if (
          !db
            .prepare(
              "SELECT 1 FROM write_intents WHERE path=? AND kind='restore' AND status IN ('prepared','conflicted')",
            )
            .get(path) &&
          !db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path)
        )
          db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(randomUUID(), path);
    })();
    return files;
  }
  function row(id: string, deleted = false) {
    assertRoot(config, db);
    const note = db.prepare('SELECT * FROM notes WHERE id=?').get(id) as NoteRow | undefined;
    if (!note || (!deleted && !note.active)) throw new HttpError(404, '笔记不存在');
    return note;
  }
  function getNote(id: string): NoteDocument {
    const n = row(id);
    try {
      const doc = readDocument(config.knowledgeRoot, n.path);
      return {
        id,
        title: doc.content.match(/^#\s+(.+)$/m)?.[1] || basename(n.path, '.md'),
        relativePath: n.path,
        ...doc,
        shared: !!db.prepare('SELECT 1 FROM shares WHERE note_id=? AND enabled=1').get(id),
      };
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 404) {
        if (
          db
            .prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')")
            .get()
        )
          throw new KnowledgeError(503, 'SYNC_IN_PROGRESS', '原文同步中', true);
        db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(id);
        db.prepare('UPDATE notes SET active=0 WHERE id=?').run(id);
      }
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
  function tree(): TreeEntry[] {
    const files = scan();
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
        updatedAt: modificationTime(n.path, 'note'),
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
    const shared = !!db.prepare('SELECT 1 FROM shares WHERE note_id=? AND enabled=1').get(id);
    const receipt = mutations.update(webPrincipal, id, content, expectedModifiedAt, requestId);
    try {
      const current = getNote(id);
      // A later save may already exist when an old request is replayed. Its
      // response still describes the original write; current state is read via GET.
      return {
        ...current,
        relativePath: receipt.relativePath,
        content,
        title: content.match(/^#\s+(.+)$/m)?.[1] || basename(receipt.relativePath, '.md'),
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
  };
}
export type NoteService = ReturnType<typeof noteService>;
export function saveInput(body: unknown) {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== 'object' || 'force' in b) throw new HttpError(400, '保存请求格式不正确');
  const content = text(b.content, '正文'),
    expectedModifiedAt = text(b.expectedModifiedAt, '版本', 30);
  if (!/^\d+$/.test(expectedModifiedAt)) throw new HttpError(400, '版本格式不正确');
  return { content, expectedModifiedAt };
}
