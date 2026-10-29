import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db.js';
import { scanFiles, validateRelative } from '../packages/core/files.js';
import {
  syncDirectoryCatalog,
  resolveDirectory,
  directoryByPath,
} from '../packages/core/organization/catalog.js';
import type { AppConfig } from '../shared/contracts.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dooknow-organization-'));
  const config: AppConfig = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    secret: 'test-only-secret-organization-long',
    origin: 'http://localhost',
  };
  mkdirSync(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { config, db };
}
it('discovers new empty ordinary top-level directories and root documents', () => {
  const { config, db } = fixture();
  mkdirSync(join(config.knowledgeRoot, 'New-Topic'));
  mkdirSync(join(config.knowledgeRoot, 'New-Topic/Empty'));
  writeFileSync(join(config.knowledgeRoot, 'Root.md'), '# Root');
  writeFileSync(join(config.knowledgeRoot, 'AGENTS.md'), 'private');
  mkdirSync(join(config.knowledgeRoot, '.private'));
  const files = scanFiles(config.knowledgeRoot);
  expect(files.folders).toEqual(['New-Topic', 'New-Topic/Empty']);
  expect(files.notes).toEqual(['Root.md']);
  expect(() => validateRelative('New-Topic/a.md', 'note')).not.toThrow();
  const a = syncDirectoryCatalog(config, db);
  expect(a.libraryId).toBeTruthy();
  expect(directoryByPath(db, 'New-Topic/Empty')).toMatchObject({
    path: 'New-Topic/Empty',
    parentId: directoryByPath(db, 'New-Topic')!.id,
  });
});
it('follows the same directory identity across rename without granting a replacement old path', () => {
  const { config, db } = fixture();
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'));
  syncDirectoryCatalog(config, db);
  const original = directoryByPath(db, '00-Inbox')!;
  renameSync(join(config.knowledgeRoot, '00-Inbox'), join(config.knowledgeRoot, 'Renamed'));
  mkdirSync(join(config.knowledgeRoot, '00-Inbox'));
  syncDirectoryCatalog(config, db);
  expect(resolveDirectory(db, original.id)?.path).toBe('Renamed');
  expect(directoryByPath(db, '00-Inbox')?.id).not.toBe(original.id);
  expect(directoryByPath(db, 'Renamed')?.id).toBe(original.id);
});
it('changes subtree revision on empty directory creation and remains stable without changes', () => {
  const { config, db } = fixture();
  mkdirSync(join(config.knowledgeRoot, 'Topic'));
  const first = syncDirectoryCatalog(config, db);
  const revision = directoryByPath(db, 'Topic')!.subtreeRevision;
  expect(syncDirectoryCatalog(config, db)).toEqual(first);
  mkdirSync(join(config.knowledgeRoot, 'Topic/Empty'));
  const second = syncDirectoryCatalog(config, db);
  expect(second.structureRevision).not.toBe(first.structureRevision);
  expect(directoryByPath(db, 'Topic')!.subtreeRevision).not.toBe(revision);
});
it('never recreates renamed bootstrap categories or exposes hidden runtime storage', () => {
  const { config, db } = fixture();
  mkdirSync(join(config.knowledgeRoot, '90-Archive'));
  mkdirSync(join(config.knowledgeRoot, '90-Archive/.trash'));
  mkdirSync(join(config.knowledgeRoot, 'Custom'));
  syncDirectoryCatalog(config, db);
  expect(directoryByPath(db, '00-Inbox')).toBeUndefined();
  expect(directoryByPath(db, '90-Archive/.trash')).toBeUndefined();
  expect(() => validateRelative('Custom/../bad.md', 'note')).toThrow();
  expect(() => validateRelative('Custom/AGENTS.md', 'note')).toThrow();
});
