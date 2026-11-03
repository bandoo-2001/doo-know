import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/** A partially moved library must be resumed from its fixed plan, never served as ordinary live state. */
export function assertStorageMigrationComplete(dataRoot: string) {
  const root = join(dataRoot, 'directory-migrations');
  if (!existsSync(root)) return;
  if (lstatSync(root).isSymbolicLink()) throw Error('目录迁移记录不可用');
  for (const item of readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    const file = join(root, item.name, 'plan.json');
    if (!existsSync(file)) continue;
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024)
      throw Error('目录迁移记录不可用');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record.status !== 'complete')
      throw Error('知识库目录迁移尚未完成，请先恢复迁移：' + item.name);
  }
}
