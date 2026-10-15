import { workspaceWriteSync } from './workspace/gate.js';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  openSync,
  readFileSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
} from 'node:fs';
import { dirname, join, extname, posix } from 'node:path';
import type { AppConfig, NoteDocument } from '../../shared/contracts.js';
import type { AppDatabase } from './db.js';
import type { NoteService } from './notes.js';
import { HttpError } from './errors.js';
import { safePath } from './files.js';
import { references, localReference } from './render.js';
import { hasSavedAssetReference } from './knowledge/asset-references.js';
import { KnowledgeError } from './knowledge/errors.js';
const allowed: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
const max = 10 * 1024 * 1024;
function sniff(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return undefined;
}
export function assetService(config: AppConfig, db: AppDatabase, notes: NoteService) {
  function file(path: string) {
    const mime = allowed[extname(path).toLowerCase()];
    if (!mime) throw new HttpError(404, '附件不存在');
    const p = safePath(config.knowledgeRoot, path, 'asset');
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.size > max) throw new HttpError(404, '附件不存在');
      const bytes = readFileSync(fd);
      if (sniff(bytes) !== mime) throw new HttpError(404, '附件类型不允许');
      return { bytes, mime };
    } finally {
      closeSync(fd);
    }
  }
  function register(path: string) {
    file(path);
    let a = db.prepare('SELECT id,path FROM assets WHERE path=?').get(path) as
      | { id: string; path: string }
      | undefined;
    if (!a) {
      a = { id: randomUUID(), path };
      db.prepare('INSERT INTO assets(id,path) VALUES(?,?)').run(a.id, path);
    }
    return { id: a.id, relativePath: path, mime: allowed[extname(path).toLowerCase()] };
  }
  function byId(id: string) {
    const a = db.prepare('SELECT path FROM assets WHERE id=?').get(id) as
      | { path: string }
      | undefined;
    if (!a) throw new HttpError(404, '附件不存在');
    try {
      return { path: a.path, ...file(a.path) };
    } catch {
      throw new HttpError(404, '附件不存在');
    }
  }
  function paths(n: NoteDocument) {
    return references(n.content)
      .map((url) => localReference(n.relativePath, url))
      .filter((p): p is string => !!p && !!allowed[extname(p).toLowerCase()]);
  }
  function mapUrl(n: NoteDocument, url: string, prefix = '/api/assets/') {
    const path = localReference(n.relativePath, url);
    if (!path) return;
    try {
      return prefix + register(path).id;
    } catch {
      return;
    }
  }
  function list(id: string) {
    const n = notes.exists(id),
      found = new Set<string>();
    try {
      for (const path of paths(notes.getNote(id))) found.add(path);
    } catch (e) {
      if (!(e instanceof KnowledgeError) || e.code !== 'LARGE_FILE_MODE_REQUIRED') throw e;
    }
    const rel = `${dirname(n.path) === '.' ? '' : dirname(n.path) + '/'}assets`;
    try {
      const dir = safePath(config.knowledgeRoot, rel, 'asset');
      for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isFile() && !entry.isSymbolicLink()) found.add(`${rel}/${entry.name}`);
    } catch {}
    return [...found].flatMap((p) => {
      try {
        return [register(p)];
      } catch {
        return [];
      }
    });
  }
  function upload(id: string, name: string, mime: string, bytes: Buffer) {
    const n = notes.exists(id);
    if (bytes.length > max) throw new HttpError(413, '附件不能超过 10 MiB');
    const ext = extname(name).toLowerCase();
    if (!allowed[ext] || allowed[ext] !== mime || sniff(bytes) !== mime)
      throw new HttpError(400, '仅允许真实 PNG/JPEG/GIF/WebP 图片和 PDF');
    const folder = dirname(n.path);
    const rel = folder === '.' ? 'assets' : `${folder}/assets`;
    const directory = safePath(config.knowledgeRoot, rel, 'asset', true);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
      throw new HttpError(400, '附件目录不允许');
    const path = `${rel}/${randomUUID()}${ext}`,
      target = safePath(config.knowledgeRoot, path, 'asset', true);
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    try {
      const a = register(path);
      return { ...a, markdownPath: posix.relative(folder, path) };
    } catch (e) {
      unlinkSync(target);
      throw e;
    }
  }
  async function savedAsset(noteId: string, path: string) {
    const note = notes.exists(noteId);
    if (!allowed[extname(path).toLowerCase()]) throw new HttpError(404, '附件不存在');
    if (
      !(await hasSavedAssetReference(
        safePath(config.knowledgeRoot, note.path, 'note'),
        note.path,
        path,
      ))
    )
      throw new HttpError(404, '附件不存在');
    return { path, ...file(path) };
  }
  async function publicAsset(noteId: string, id: string) {
    const a = db.prepare('SELECT path FROM assets WHERE id=?').get(id) as
      | { path: string }
      | undefined;
    if (!a) throw new HttpError(404, '附件不存在');
    return savedAsset(noteId, a.path);
  }
  async function publicSource(noteId: string, source: string) {
    const note = notes.exists(noteId),
      path = localReference(note.path, source);
    if (!path) throw new HttpError(404, '附件不存在');
    return savedAsset(noteId, path);
  }
  return {
    file,
    register,
    byId,
    mapUrl,
    list,
    upload: (...args: Parameters<typeof upload>) =>
      workspaceWriteSync(db, { kind: 'asset.upload' }, () => upload(...args)),
    publicAsset,
    publicSource,
  };
}
