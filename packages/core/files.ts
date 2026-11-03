import { isKnowledgeDataPath, DOO_ASSETS_DIRECTORY } from '../../shared/storage-paths.js';
import { hasDiagramDeclarationSync } from './knowledge/diagram-declaration.js';
import { parseDiagramDocument } from '../../shared/diagram-document.js';
import { fileVersionStamp } from './knowledge/file-reader.js';
import { isDocument } from '../../shared/whiteboard.js';
import { lstatSync, realpathSync, readdirSync, openSync, readFileSync, closeSync, fstatSync, constants } from 'node:fs';
import { join, sep } from 'node:path';
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
  if (isKnowledgeDataPath(path) || parts.some((p) => !validName(p)))
    throw new HttpError(400, '路径不允许');
  if (kind === 'note' && (!isDocument(path) || parts.includes(DOO_ASSETS_DIRECTORY)))
    throw new HttpError(400, '仅允许 Markdown 文档');
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
      const error = new HttpError(404, '文件或目录不存在');
      // Keep filesystem provenance internally; details is serialized to clients.
      Object.defineProperty(error, 'cause', { value: e, writable: true, configurable: true });
      throw error;
    }
  }
  if (!current.startsWith(base + sep)) throw new HttpError(400, '路径不允许');
  return current;
}
export function sourceErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return;
  const source = (error as Error).cause ?? error;
  if (!source || typeof source !== 'object') return;
  const code = (source as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}
export function isMissingSource(error: unknown) {
  return ['ENOENT', 'ENOTDIR'].includes(sourceErrorCode(error) || '');
}
export function readDocument(
  root: string,
  path: string,
  options: { allowDiagramLarge?: boolean } = {},
) {
  const file = safePath(root, path, 'note');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new HttpError(400, '不是普通文件');
    if (before.size > 20n * 1024n * 1024n)
      throw new KnowledgeError(413, 'FILE_TOO_LARGE', '笔记超过大小上限');
    if (
      before.size > 1024n * 1024n &&
      (!options.allowDiagramLarge || !hasDiagramDeclarationSync(file))
    )
      throw new KnowledgeError(409, 'LARGE_FILE_MODE_REQUIRED', '请使用大文件模式读取');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(fd));
    } catch {
      throw new KnowledgeError(422, 'INVALID_UTF8', '原文不是有效 UTF-8，请先确认来源编码');
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size
    )
      throw new HttpError(409, '文件读取期间更新，请重试', {
        currentModifiedAt: after.mtimeNs.toString(),
      });
    const primary =
      !!options.allowDiagramLarge && parseDiagramDocument(content).status === 'diagram';
    if (before.size > 1024n * 1024n && !primary)
      throw new KnowledgeError(409, 'LARGE_FILE_MODE_REQUIRED', '请使用大文件模式读取');
    if (!primary && content.split('\n').some((line) => Buffer.byteLength(line) > 32768))
      throw new KnowledgeError(409, 'LARGE_FILE_MODE_REQUIRED', '请使用大文件模式读取');
    return {
      content,
      signature: fileVersionStamp(after),
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
      if (!validName(item.name) || item.name === DOO_ASSETS_DIRECTORY || item.isSymbolicLink()) continue;
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
  for (const item of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (
      !validName(item.name) ||
      item.name === DOO_ASSETS_DIRECTORY ||
      isKnowledgeDataPath(item.name) ||
      item.isSymbolicLink()
    )
      continue;
    if (item.isDirectory()) {
      folders.push(item.name);
      walk(item.name);
    } else if (item.isFile() && isDocument(item.name)) {
      try {
        safePath(root, item.name, 'note');
        notes.push(item.name);
      } catch {}
    }
  }
  return { folders, notes };
}
