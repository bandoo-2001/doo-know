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
import type { AppConfig, NoteDocument, TreeEntry } from '../shared/contracts.js';
import type { AppDatabase } from './db.js';
import { HttpError, text } from './errors.js';
import { readDocument, safePath, scanFiles, validName } from './files.js';
export interface NoteRow {
  id: string;
  path: string;
  active: number;
  trash_path: string | null;
}
export function noteService(config: AppConfig, db: AppDatabase) {
  function scan() {
    const files = scanFiles(config.knowledgeRoot);
    db.transaction(() => {
      const live = new Set(files.notes);
      for (const row of db.prepare('SELECT * FROM notes WHERE active=1').all() as NoteRow[])
        if (!live.has(row.path)) {
          db.prepare('UPDATE notes SET active=0 WHERE id=?').run(row.id);
          db.prepare('UPDATE shares SET enabled=0 WHERE note_id=?').run(row.id);
        }
      for (const path of files.notes)
        if (!db.prepare('SELECT id FROM notes WHERE path=? AND active=1').get(path))
          db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(randomUUID(), path);
    })();
    return files;
  }
  function row(id: string, deleted = false) {
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
  function createNote(folderPath: string, fileName: string, content: string) {
    if (!validName(fileName) || !fileName.toLowerCase().endsWith('.md'))
      throw new HttpError(400, '请输入有效的 .md 文件名');
    const folder = safePath(config.knowledgeRoot, folderPath, 'folder');
    if (!lstatSync(folder).isDirectory()) throw new HttpError(400, '目标不是目录');
    const path = `${folderPath}/${fileName}`;
    const file = safePath(config.knowledgeRoot, path, 'note', true);
    try {
      writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new HttpError(409, '同名文件已存在');
      throw e;
    }
    const id = randomUUID();
    try {
      db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id, path);
    } catch (e) {
      unlinkSync(file);
      throw e;
    }
    return getNote(id);
  }
  function saveNote(id: string, content: string, expectedModifiedAt: string) {
    const current = getNote(id);
    if (current.modifiedAt !== expectedModifiedAt)
      throw new HttpError(409, '原文件已更新，是否确定覆盖？', {
        currentModifiedAt: current.modifiedAt,
      });
    const file = safePath(config.knowledgeRoot, current.relativePath, 'note'),
      revisionId = randomUUID();
    const historyDir = join(config.dataRoot, 'history');
    mkdirSync(historyDir, { recursive: true, mode: 0o700 });
    const historyFile = `${revisionId}.md`;
    const temp = join(dirname(file), `.doo-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      writeFileSync(join(historyDir, historyFile), current.content, { flag: 'wx', mode: 0o600 });
      fd = openSync(temp, 'wx', Number(statSync(file).mode) & 0o777);
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const latest = readDocument(config.knowledgeRoot, current.relativePath);
      if (latest.modifiedAt !== expectedModifiedAt)
        throw new HttpError(409, '原文件再次更新', { currentModifiedAt: latest.modifiedAt });
      db.prepare(
        'INSERT INTO revisions(id,note_id,file,created_at,modified_at) VALUES(?,?,?,?,?)',
      ).run(revisionId, id, historyFile, new Date().toISOString(), current.modifiedAt);
      renameSync(temp, file);
      const dirFd = openSync(dirname(file), 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      return getNote(id);
    } catch (e) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {}
      throw e;
    }
  }
  function createFolder(parent: string, name: string) {
    if (!validName(name) || name === 'assets') throw new HttpError(400, '文件夹名不允许');
    const folder = safePath(config.knowledgeRoot, parent, 'folder');
    if (!lstatSync(folder).isDirectory()) throw new HttpError(400, '目标不是目录');
    try {
      mkdirSync(safePath(config.knowledgeRoot, `${parent}/${name}`, 'folder', true), {
        mode: 0o700,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, '目录已存在');
      throw e;
    }
    return tree();
  }
  return { scan, row, getNote, tree, createNote, saveNote, createFolder };
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
