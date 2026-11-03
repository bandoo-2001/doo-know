import { randomUUID } from 'node:crypto';
import { mkdir, rm, rmdir, readdir } from 'node:fs/promises';
import { join, relative, basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { safePath, validName } from '../files.js';
import type { AppConfig } from '../../../shared/contracts.js';
import { portableResourceLimits } from '../../../shared/portable-resource-limits.js';
import type { AppDatabase } from '../db.js';
import { fail } from '../knowledge/errors.js';

export async function portableStaging(config: AppConfig, db: AppDatabase, bytes = 0) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS portable_staging_runs(id TEXT PRIMARY KEY,bytes INTEGER NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS portable_staging_locations(run_id TEXT NOT NULL,directory TEXT NOT NULL,created INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(run_id,directory)); CREATE TABLE IF NOT EXISTS portable_staging_parents(run_id TEXT NOT NULL,directory TEXT NOT NULL,PRIMARY KEY(run_id,directory));',
  );
  // Older locators have unknown creation history, so retain their fail-closed semantics.
  if (
    !(db.prepare('PRAGMA table_info(portable_staging_locations)').all() as { name: string }[]).some(
      (column) => column.name === 'created',
    )
  )
    db.exec('ALTER TABLE portable_staging_locations ADD COLUMN created INTEGER NOT NULL DEFAULT 1');
  const root = join(config.dataRoot, 'portable-staging');
  async function removeLocations(id: string) {
    const missing = new Map<string, string>();
    for (const row of db
      .prepare('SELECT directory,created FROM portable_staging_locations WHERE run_id=?')
      .all(id) as { directory: string; created: number }[]) {
      const parent = relative(config.knowledgeRoot, dirname(row.directory));
      if (parent.startsWith('..') || !basename(row.directory).startsWith('.portable-' + id + '-'))
        fail(409, 'PORTABLE_STAGING_CONFLICT');
      if (!existsSync(row.directory)) {
        // A planned allocation has not returned to its caller, so no payload can have
        // been written. A crash before/inside mkdir must not poison all future staging.
        if (!row.created) {
          db.prepare('DELETE FROM portable_staging_locations WHERE run_id=? AND directory=?').run(
            id,
            row.directory,
          );
          continue;
        }
        missing.set(basename(row.directory), row.directory);
        continue;
      }
      if (parent) safePath(config.knowledgeRoot, parent, 'folder');
      await rm(row.directory, { recursive: true, force: true });
      db.prepare('DELETE FROM portable_staging_locations WHERE run_id=? AND directory=?').run(
        id,
        row.directory,
      );
    }
    // A legitimate folder operation can move an in-flight hidden shard. Resolve only
    // this run's exact private names; never follow a symlink or delete normal content.
    async function findMoved(root: string): Promise<void> {
      const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        const path = join(root, entry.name),
          original = missing.get(entry.name);
        if (original) {
          await rm(path, { recursive: true, force: true });
          db.prepare('DELETE FROM portable_staging_locations WHERE run_id=? AND directory=?').run(
            id,
            original,
          );
          missing.delete(entry.name);
        } else if (missing.size && validName(entry.name)) await findMoved(path);
      }
    }
    if (missing.size) await findMoved(config.knowledgeRoot);
    if (missing.size) fail(409, 'PORTABLE_STAGING_CONFLICT');
    for (const row of db
      .prepare(
        'SELECT directory FROM portable_staging_parents WHERE run_id=? ORDER BY length(directory) DESC',
      )
      .all(id) as { directory: string }[]) {
      const path = relative(config.knowledgeRoot, row.directory);
      if (!path || path.startsWith('..')) fail(409, 'PORTABLE_STAGING_CONFLICT');
      try {
        safePath(config.knowledgeRoot, path, 'folder');
        await rmdir(row.directory);
      } catch (error) {
        if (
          (error as any).statusCode !== 404 &&
          !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as any).code)
        )
          throw error;
      }
    }
    db.prepare('DELETE FROM portable_staging_parents WHERE run_id=?').run(id);
  }

  const stale = db
    .prepare('SELECT id FROM portable_staging_runs WHERE expires<?')
    .all(Date.now()) as { id: string }[];
  for (const row of stale) {
    await removeLocations(row.id);
    await rm(join(root, row.id), { recursive: true, force: true });
    db.prepare('DELETE FROM portable_staging_runs WHERE id=?').run(row.id);
  }
  const id = randomUUID(),
    directory = join(root, id);
  let currentBytes = bytes;
  function resize(bytes: number) {
    db.transaction(() => {
      const staging = (
        db
          .prepare('SELECT coalesce(sum(bytes),0) n FROM portable_staging_runs WHERE id<>?')
          .get(id) as any
      ).n;
      const deliveryTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portable_deliveries'")
        .get();
      const deliveries = deliveryTable
        ? (db.prepare('SELECT coalesce(sum(bytes),0) n FROM portable_deliveries').get() as any).n
        : 0;
      if (
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        staging + deliveries + bytes > portableResourceLimits.stagedBytes
      )
        fail(413, 'PORTABLE_STAGING_QUOTA_EXCEEDED');
      db.prepare(
        'INSERT INTO portable_staging_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET bytes=excluded.bytes,expires=excluded.expires',
      ).run(id, bytes, Date.now() + 60 * 60 * 1000);
    }).immediate();
    currentBytes = bytes;
  }
  resize(bytes);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    db.prepare('DELETE FROM portable_staging_runs WHERE id=?').run(id);
    throw error;
  }
  return {
    id,
    directory,
    reduce: (bytes: number) => resize(currentBytes - bytes),
    addParent: (directory: string) =>
      db.prepare('INSERT OR IGNORE INTO portable_staging_parents VALUES(?,?)').run(id, directory),
    addLocation: (directory: string) =>
      db
        .prepare('INSERT INTO portable_staging_locations(run_id,directory,created) VALUES(?,?,0)')
        .run(id, directory),
    confirmLocation: (directory: string) => {
      if (
        db
          .prepare('UPDATE portable_staging_locations SET created=1 WHERE run_id=? AND directory=?')
          .run(id, directory).changes !== 1
      )
        fail(409, 'PORTABLE_STAGING_CONFLICT');
    },
    resize,
    release: async () => {
      await removeLocations(id);
      await rm(directory, { recursive: true, force: true });
      db.prepare('DELETE FROM portable_staging_runs WHERE id=?').run(id);
    },
  };
}
