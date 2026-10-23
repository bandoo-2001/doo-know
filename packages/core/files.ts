import {isDocument,isWhiteboard,MAX_WHITEBOARD_BYTES} from '../../shared/whiteboard.js';
import {
  lstatSync,
  realpathSync,
  readdirSync,
  openSync,
  readFileSync,
  closeSync,
  fstatSync,
  constants,
} from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { HttpError } from './errors.js';
import { KnowledgeError } from './knowledge/errors.js';
export const categories = [
  '00-Inbox',
  '10-Projects',
  '20-Areas',
  '30-Knowledge',
  '40-Resources',
  '50-Journal',
  '90-Archive',
  '99-System',
];
export function validName(name: string) {
  return (
    name.length > 0 &&
    Buffer.byteLength(name, 'utf8') <= 180 &&
    !/[\x00-\x1f/\\:]/.test(name) &&
    !name.startsWith('.') &&
    !name.endsWith(' ') &&
    name !== '.' &&
    name !== '..' &&
    name.toLowerCase() !== 'agents.md'
  );
}
export function validateRelative(path: string, kind: 'note' | 'folder' | 'asset') {
  if (
    typeof path !== 'string' ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0')
  )
    throw new HttpError(400, '路径不允许');
  if (path === 'README.md' && kind === 'note') return;
  const parts = path.split('/');
  if (
    !(categories.includes(parts[0]) || (kind === 'asset' && parts[0] === 'assets')) ||
    parts.some((p) => !validName(p))
  )
    throw new HttpError(400, '路径不允许');
  if (kind === 'note' && (!isDocument(path) || parts.includes('assets')))
    throw new HttpError(400, '仅允许 Markdown 或 Excalidraw 白板文件');
}
export function safePath(
  root: string,
  path: string,
  kind: 'note' | 'folder' | 'asset',
  missingLeaf = false,
) {
  validateRelative(path, kind);
  const base = realpathSync(root),
    parts = path.split('/');
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try {
      const s = lstatSync(current);
      if (
        s.isSymbolicLink() ||
        (!s.isDirectory() && i < parts.length - 1) ||
        (kind === 'note' && i === parts.length - 1 && !s.isFile()) ||
        (s.isFile() && s.nlink > 1n)
      )
        throw new HttpError(400, '不允许软链接或共享硬链接');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && missingLeaf && i === parts.length - 1)
        break;
      if (e instanceof HttpError) throw e;
      throw new HttpError(404, '文件或目录不存在');
    }
  }
  if (!current.startsWith(base + sep)) throw new HttpError(400, '路径不允许');
  return current;
}
export function readDocument(root: string, path: string) {
  const file = safePath(root, path, 'note');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new HttpError(400, '不是普通文件');
    const board = isWhiteboard(path);
    if (board && before.size > BigInt(MAX_WHITEBOARD_BYTES)) throw new KnowledgeError(413, 'FILE_TOO_LARGE', '白板不能超过 8 MiB');
    if (before.size > 20n * 1024n * 1024n)
      throw new KnowledgeError(413, 'FILE_TOO_LARGE', '笔记超过大小上限');
    if (!board && before.size > 1024n * 1024n)
      throw new KnowledgeError(409, 'LARGE_FILE_MODE_REQUIRED', '请使用大文件模式读取');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(fd));
    } catch {
      throw new KnowledgeError(422, 'INVALID_UTF8', '原文不是有效 UTF-8，请先确认来源编码');
    }
    const after = fstatSync(fd, { bigint: true });
    if (before.mtimeNs !== after.mtimeNs)
      throw new HttpError(409, '文件读取期间更新，请重试', {
        currentModifiedAt: after.mtimeNs.toString(),
      });
    if (!board && content.split('\n').some((line) => Buffer.byteLength(line) > 32768))
      throw new KnowledgeError(409, 'LARGE_FILE_MODE_REQUIRED', '请使用大文件模式读取');
    return {
      content,
      modifiedAt: after.mtimeNs.toString(),
      updatedAt: new Date(Number(after.mtimeMs)).toISOString(),
    };
  } finally {
    closeSync(fd);
  }
}
export function scanFiles(root: string) {
  try {
    const s = lstatSync(root);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error();
    readdirSync(root);
  } catch {
    throw new KnowledgeError(503, 'SOURCE_UNAVAILABLE', '原文目录不可用', true);
  }
  const folders: string[] = [],
    notes: string[] = [];
  function walk(path: string) {
    const absolute = safePath(root, path, 'folder');
    for (const item of readdirSync(absolute, { withFileTypes: true })) {
      if (!validName(item.name) || item.name === 'assets' || item.isSymbolicLink()) continue;
      const rel = `${path}/${item.name}`;
      if (item.isDirectory()) {
        folders.push(rel);
        walk(rel);
      } else if (item.isFile() && isDocument(item.name)) {
        try {
          safePath(root, rel, 'note');
          notes.push(rel);
        } catch {}
      }
    }
  }
  for (const cat of categories) {
    try {
      if (
        lstatSync(join(root, cat)).isDirectory() &&
        !lstatSync(join(root, cat)).isSymbolicLink()
      ) {
        folders.push(cat);
        walk(cat);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (e instanceof HttpError) throw e;
      throw new KnowledgeError(503, 'SOURCE_UNAVAILABLE', '原文目录不可读', true);
    }
  }
  try {
    safePath(root, 'README.md', 'note');
    notes.push('README.md');
  } catch {}
  return { folders, notes };
}
