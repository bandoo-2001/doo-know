import { mkdir, readdir, lstat, cp, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import {resetRestoredState} from './platform/restore-state.js';
import Database from 'better-sqlite3';
import type { AppConfig } from '../../shared/contracts.js';
import { hashFile } from '../../packages/core/knowledge/file-reader.js';
export async function inventory(root: string) {
  const entries: Record<string, string> = {};
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name),
        s = await lstat(p, { bigint: true });
      if (s.isSymbolicLink() || (s.isFile() && s.nlink > 1n))
        throw new Error('备份拒绝软链接与外部共享硬链接');
      if (s.isDirectory()) await walk(p);
      else if (s.isFile()) entries[relative(root, p)] = `${s.size}:${s.mtimeNs}`;
    }
  }
  await walk(root);
  return entries;
}
export async function checksums(root: string) {
  const files = await inventory(root),
    result: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) result[path] = await hashFile(join(root, path));
  return result;
}
export function independent(path: string, other: string) {
  const a = resolve(path),
    b = resolve(other);
  if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/'))
    throw new Error('备份与恢复目录必须相互独立');
}
export async function emptyTarget(path: string) {
  try {
    if ((await readdir(path)).length) throw new Error('恢复目标必须为空，拒绝覆盖已有数据');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}
export async function backup(config: AppConfig, destination: string) {
  independent(destination, config.knowledgeRoot);
  independent(destination, config.dataRoot);
  await mkdir(destination, { mode: 0o700 });
  const before = await inventory(config.knowledgeRoot),
    db = new Database(join(config.dataRoot, 'app.sqlite'));
  try {
    await cp(config.knowledgeRoot, join(destination, 'knowledge'), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await mkdir(join(destination, 'data'), { mode: 0o700 });
    await db.backup(join(destination, 'data/app.sqlite'));
    try {
      await access(join(config.dataRoot, 'history'));
      await cp(join(config.dataRoot, 'history'), join(destination, 'data/history'), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const after = await inventory(config.knowledgeRoot);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error('备份期间原文变化，请暂停编辑后重新备份');
    await writeFile(
      join(destination, 'manifest.json'),
      JSON.stringify(
        { version: 1, createdAt: new Date().toISOString(), files: await checksums(destination) },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } finally {
    db.close();
  }
}
export async function restore(source: string, config: AppConfig) {
  independent(source, config.knowledgeRoot);
  independent(source, config.dataRoot);
  independent(config.knowledgeRoot, config.dataRoot);
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as {
    version: number;
    files: Record<string, string>;
  };
  if (manifest.version !== 1) throw new Error('不支持的备份版本');
  const actual = await checksums(source);
  delete actual['manifest.json'];
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error('备份校验失败，拒绝恢复');
  await emptyTarget(config.knowledgeRoot);
  await emptyTarget(config.dataRoot);
  for (const [from, to] of [
    [join(source, 'knowledge'), config.knowledgeRoot],
    [join(source, 'data'), config.dataRoot],
  ])
    for (const entry of await readdir(from))
      await cp(join(from, entry), join(to, entry), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
  const db = new Database(join(config.dataRoot, 'app.sqlite'));
  try {
    resetRestoredState(db,config);
  } finally {
    db.close();
  }
}
