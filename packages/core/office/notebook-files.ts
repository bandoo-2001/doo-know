import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { OfficeDocument } from '../../../shared/office.js';
import { officeFormat } from '../../../shared/office.js';
import { isDooAssetPath } from '../../../shared/storage-paths.js';
import { HttpError } from '../errors.js';
import { safePath, scanFiles } from '../files.js';
import { fileVersionStamp } from '../knowledge/file-reader.js';
import { maxOfficeFileBytes, officeFileName, validateOfficeFile } from './formats.js';

export const officeDigest = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
const notebookId = (path: string) => 'file-' + officeDigest(path);

export function notebookFolderIdentity(root: string, folder: string) {
  if (isDooAssetPath(folder)) throw new HttpError(400, '请选择笔记本目录');
  const directory = folder ? safePath(root, folder, 'folder') : root;
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory()) throw new HttpError(400, '目标不是目录');
  return [stat.dev, stat.ino].join(':');
}

// This derived lookup is repopulated by the same scan that builds the notebook tree.
// IDs depend on the relative path so a backup or a Git checkout needs no ID database.
let catalog: { root: string; paths: Map<string, string> } | undefined;
export function notebookOfficePaths(root: string, inventory?: string[]) {
  if (!catalog || catalog.root !== root || inventory) {
    const paths = inventory ?? scanFiles(root, true).office;
    catalog = { root, paths: new Map(paths.map((path) => [notebookId(path), path])) };
  }
  return catalog.paths;
}

function notebookItem(root: string, path: string, id = notebookId(path)): OfficeDocument {
  const fileType = officeFormat(path);
  if (!fileType || isDooAssetPath(path)) throw new HttpError(400, '请选择笔记本中的办公文件');
  const info = lstatSync(safePath(root, path, 'asset'));
  if (!info.isFile() || info.nlink !== 1) throw new HttpError(400, '请选择普通文件');
  return {
    id,
    name: basename(path),
    relativePath: path,
    fileType,
    sizeBytes: info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

export function notebookOfficeItems(root: string, inventory: string[]) {
  const items: OfficeDocument[] = [];
  for (const [id, path] of notebookOfficePaths(root, inventory)) {
    try {
      items.push(notebookItem(root, path, id));
    } catch (error) {
      if (!(error instanceof HttpError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
  }
  return items;
}

function readNotebookBytes(root: string, path: string) {
  const file = safePath(root, path, 'asset');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new HttpError(400, '请选择普通文件');
    if (before.size > BigInt(maxOfficeFileBytes)) throw new HttpError(413, '文件不能超过 10 MiB');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (
      offset !== bytes.length ||
      fileVersionStamp(before) !==
        fileVersionStamp(lstatSync(safePath(root, path, 'asset'), { bigint: true }))
    )
      throw new HttpError(409, '文件读取期间已被修改，请重试');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function pathForId(root: string, id: string, refreshMissing = false) {
  let path = notebookOfficePaths(root).get(id);
  if (!path && refreshMissing)
    path = notebookOfficePaths(root, scanFiles(root, true).office).get(id);
  if (!path) throw new HttpError(404, '文件不存在，请刷新目录');
  return path;
}

export function readNotebookOffice(root: string, id: string, refreshMissing: boolean) {
  const path = pathForId(root, id, refreshMissing);
  const metadata = notebookItem(root, path, id);
  const bytes = readNotebookBytes(root, path);
  return { metadata, bytes, digest: officeDigest(bytes) };
}

function writeNotebookFile(root: string, path: string, bytes: Buffer, expected?: string) {
  const file = safePath(root, path, 'asset', true);
  // Pin the selected directory while publishing. An external move must not redirect a save.
  const dir = openSync(
    dirname(file),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const pinned = '/proc/self/fd/' + dir;
  const temp = join(pinned, '.dooknow-' + randomUUID() + '.tmp');
  const target = join(pinned, basename(file));
  let staged = false;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    staged = true;
    try {
      writeFileSync(fd, bytes);
      if (expected !== undefined) fchmodSync(fd, lstatSync(target).mode & 0o777);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const currentDir = lstatSync(dirname(safePath(root, path, 'asset', true)), { bigint: true });
    const originalDir = fstatSync(dir, { bigint: true });
    if (currentDir.dev !== originalDir.dev || currentDir.ino !== originalDir.ino)
      throw new HttpError(409, '目标目录已变化，请重新选择');
    if (expected === undefined) {
      try {
        linkSync(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new HttpError(409, '目录中已有同名文件，请更换文件名');
        throw error;
      }
      unlinkSync(temp);
    } else {
      if (officeDigest(readNotebookBytes(root, path)) !== expected)
        throw new HttpError(409, '原件已更新，请重新打开后再保存');
      renameSync(temp, target);
    }
    staged = false;
    fsyncSync(dir);
  } finally {
    try {
      if (staged) unlinkSync(temp);
    } finally {
      closeSync(dir);
    }
  }
}

export function addNotebookOffice(root: string, folder: string, name: string, bytes: Buffer) {
  const file = officeFileName(name);
  validateOfficeFile(bytes, file.fileType);
  const path = folder ? folder + '/' + file.name : file.name;
  if (isDooAssetPath(path)) throw new HttpError(400, '请选择笔记本目录');
  writeNotebookFile(root, path, bytes);
  const metadata = notebookItem(root, path);
  if (catalog?.root === root) catalog.paths.set(metadata.id, path);
  return metadata;
}

export function saveNotebookOffice(root: string, id: string, bytes: Buffer, digest: string) {
  const path = pathForId(root, id);
  writeNotebookFile(root, path, bytes, digest);
  return notebookItem(root, path, id);
}
