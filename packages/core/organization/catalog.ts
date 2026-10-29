import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import { scanFiles } from '../files.js';
import { fail } from '../knowledge/errors.js';
import { sha256 } from '../knowledge/operations.js';
import { migrateOrganization, organizationPending } from './schema.js';
export type DirectoryRecord = {
  id: string;
  path: string;
  parentId: string | null;
  subtreeRevision: string;
};
type Row = {
  id: string;
  path: string;
  parent_id: string | null;
  subtree_revision: string;
  dev: string;
  ino: string;
  birthtime_ns: string;
  active: number;
};
export function libraryIdentity(db: AppDatabase) {
  migrateOrganization(db);
  const row = db.prepare('SELECT * FROM organization_library WHERE id=1').get() as any;
  return row
    ? {
        libraryId: row.library_id as string,
        bindingVersion: row.binding_version as number,
        structureRevision: row.structure_revision as string,
      }
    : undefined;
}
const record = (r: Row): DirectoryRecord => ({
  id: r.id,
  path: r.path,
  parentId: r.parent_id,
  subtreeRevision: r.subtree_revision,
});
export function resolveDirectory(db: AppDatabase, id: string): DirectoryRecord | undefined {
  migrateOrganization(db);
  const r = db.prepare('SELECT * FROM organization_directories WHERE id=? AND active=1').get(id) as
    | Row
    | undefined;
  return r && record(r);
}
export function directoryByPath(db: AppDatabase, path: string): DirectoryRecord | undefined {
  migrateOrganization(db);
  const r = db
    .prepare('SELECT * FROM organization_directories WHERE path=? AND active=1')
    .get(path) as Row | undefined;
  return r && record(r);
}
export function syncDirectoryCatalog(
  config: AppConfig,
  db: AppDatabase,
  options: { recovering?: boolean } = {},
) {
  migrateOrganization(db);
  if (!options.recovering && organizationPending(db))
    fail(503, 'ORGANIZATION_RECOVERY_REQUIRED', '工作区整理恢复中', true);
  const root = lstatSync(config.knowledgeRoot, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) fail(503, 'SOURCE_UNAVAILABLE');
  const rootIdentity = JSON.stringify({
    path: realpathSync(config.knowledgeRoot),
    dev: String(root.dev),
    ino: String(root.ino),
  });
  const existing = db.prepare('SELECT * FROM organization_library WHERE id=1').get() as any;
  if (existing && existing.root_identity !== rootIdentity) fail(503, 'LIBRARY_BINDING_CHANGED');
  const files = scanFiles(config.knowledgeRoot),
    libraryId = existing?.library_id || randomUUID();
  const snapshots = files.folders.map((path) => {
    const s = lstatSync(join(config.knowledgeRoot, path), { bigint: true });
    return { path, dev: String(s.dev), ino: String(s.ino), birthtime: String(s.birthtimeNs) };
  });
  const members = [
    ...snapshots.map((s) => `${s.path}:d:${s.dev}:${s.ino}:${s.birthtime}`),
    ...files.notes.map((path) => {
      const s = lstatSync(join(config.knowledgeRoot, path), { bigint: true });
      return `${path}:f:${s.dev}:${s.ino}:${s.birthtimeNs}:${s.mtimeNs}:${s.size}`;
    }),
  ].sort();
  const inventoryHash = sha256(JSON.stringify(members));
  return db
    .transaction(() => {
      if (!existing)
        db.prepare(
          'INSERT INTO organization_library(id,library_id,root_identity) VALUES(1,?,?)',
        ).run(libraryId, rootIdentity);
      const rows = db
        .prepare('SELECT * FROM organization_directories WHERE library_id=?')
        .all(libraryId) as Row[];
      db.prepare('UPDATE organization_directories SET active=0 WHERE library_id=?').run(libraryId);
      const selected = new Map<string, string>(),
        used = new Set<string>();
      for (const snap of snapshots) {
        const old = rows.find(
          (r) =>
            !used.has(r.id) &&
            r.dev === snap.dev &&
            r.ino === snap.ino &&
            r.birthtime_ns === snap.birthtime,
        );
        const id = old?.id || randomUUID();
        used.add(id);
        selected.set(snap.path, id);
      }
      for (const snap of snapshots) {
        const id = selected.get(snap.path)!,
          parent = dirname(snap.path),
          parentId = parent === '.' ? null : selected.get(parent) || null;
        const subtree = sha256(
          JSON.stringify(
            members.filter((m) => m.startsWith(snap.path + ':') || m.startsWith(snap.path + '/')),
          ),
        );
        db.prepare(
          'INSERT INTO organization_directories(id,library_id,parent_id,path,active,dev,ino,birthtime_ns,subtree_revision) VALUES(?,?,?,?,1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,path=excluded.path,active=1,dev=excluded.dev,ino=excluded.ino,birthtime_ns=excluded.birthtime_ns,subtree_revision=excluded.subtree_revision',
        ).run(id, libraryId, parentId, snap.path, snap.dev, snap.ino, snap.birthtime, subtree);
      }
      if (!existing?.inbox_directory_id && selected.has('00-Inbox'))
        db.prepare('UPDATE organization_library SET inbox_directory_id=? WHERE id=1').run(
          selected.get('00-Inbox'),
        );
      const revision =
        existing?.inventory_hash === inventoryHash
          ? existing.structure_revision
          : String(BigInt(existing?.structure_revision || '0') + 1n);
      db.prepare(
        'UPDATE organization_library SET structure_revision=?,inventory_hash=?,graph_revision=CASE WHEN inventory_hash<>? THEN CAST(CAST(graph_revision AS INTEGER)+1 AS TEXT) ELSE graph_revision END WHERE id=1',
      ).run(revision, inventoryHash, inventoryHash);
      return { libraryId, structureRevision: revision as string };
    })
    .immediate();
}
export { rebindRestoredOrganization } from './restore.js';
