import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../../../packages/core/db.js';

const key = 'to_doo_installation_id';
export function getToDooInstallationId(db: AppDatabase): string {
  const row = db.prepare('SELECT value FROM index_meta WHERE key=?').get(key) as
    | { value: string }
    | undefined;
  if (row && /^[a-f0-9-]{36}$/.test(row.value)) return row.value;
  const id = randomUUID();
  db.prepare('INSERT OR REPLACE INTO index_meta(key,value) VALUES(?,?)').run(key, id);
  return id;
}

/** Only the supported restore flow calls this; normal restarts preserve activation. */
export function resetToDooLocalConnections(db: AppDatabase) {
  const localTables = [
    'to_doo_push_config',
    'to_doo_push_devices',
    'to_doo_push_outbox',
    'to_doo_push_seen',
    'to_doo_feed_tokens',
    'to_doo_calendar_connections',
    'to_doo_import_previews',
    'to_doo_import_jobs',
    'todo_instance_state',
  ];
  db.transaction(() => {
    for (const table of localTables)
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        db.exec(`DELETE FROM "${table}"`);
    db.prepare('DELETE FROM index_meta WHERE key=?').run(key);
    getToDooInstallationId(db);
  }).immediate();
}
