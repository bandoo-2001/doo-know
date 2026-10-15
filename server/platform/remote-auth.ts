import type { AppDatabase } from '../db.js';
export function remoteAuthGeneration(db: AppDatabase) {
  return Number((db.prepare("SELECT value FROM index_meta WHERE key='remote_auth_generation'").get() as any)?.value || 0);
}
// This must run in the same transaction as password/restore invalidation. Timestamps
// alone cannot distinguish an unused credential issued and revoked in one second.
export function invalidateRemoteAuth(db: AppDatabase) {
  db.prepare("INSERT INTO index_meta VALUES('remote_auth_generation','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1").run();
  db.prepare("INSERT INTO index_meta VALUES('remote_auth_not_before',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(Math.floor(Date.now()/1000)));
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='platform_grants'").get())
    db.prepare('UPDATE platform_grants SET active=0,version=version+1 WHERE active=1').run();
}
