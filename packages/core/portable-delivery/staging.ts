import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../../../shared/contracts.js';
import { portableResourceLimits } from '../../../shared/portable-resource-limits.js';
import type { AppDatabase } from '../db.js';
import { fail } from '../knowledge/errors.js';

export async function portableStaging(config: AppConfig, db: AppDatabase, bytes = 0) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS portable_staging_runs(id TEXT PRIMARY KEY,bytes INTEGER NOT NULL,expires INTEGER NOT NULL);',
  );
  const root = join(config.dataRoot, 'portable-staging');
  const stale = db
    .prepare('SELECT id FROM portable_staging_runs WHERE expires<?')
    .all(Date.now()) as { id: string }[];
  for (const row of stale) {
    await rm(join(root, row.id), { recursive: true, force: true });
    db.prepare('DELETE FROM portable_staging_runs WHERE id=?').run(row.id);
  }
  const id = randomUUID(),
    directory = join(root, id);
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
  }
  resize(bytes);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    db.prepare('DELETE FROM portable_staging_runs WHERE id=?').run(id);
    throw error;
  }
  return {
    directory,
    resize,
    release: async () => {
      await rm(directory, { recursive: true, force: true });
      db.prepare('DELETE FROM portable_staging_runs WHERE id=?').run(id);
    },
  };
}
