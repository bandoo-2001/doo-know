import type { AppDatabase } from '../db.js';
import { fail } from '../knowledge/errors.js';
export type OrganizationSettings = { retentionDays: number };
function initializeSettings(db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS organization_settings(
    id INTEGER PRIMARY KEY CHECK(id=1),
    retention_days INTEGER NOT NULL CHECK(typeof(retention_days)='integer' AND retention_days BETWEEN 1 AND 3650)
  ); INSERT OR IGNORE INTO organization_settings(id,retention_days) VALUES(1,30);`);
}
export function readOrganizationSettings(db: AppDatabase): OrganizationSettings {
  initializeSettings(db);
  const row = db.prepare('SELECT retention_days FROM organization_settings WHERE id=1').get() as {
    retention_days: number;
  };
  return { retentionDays: row.retention_days };
}
/** This setting controls future commit expiry only; existing journal expiry is immutable here. */
export function updateOrganizationSettings(
  db: AppDatabase,
  input: OrganizationSettings,
): OrganizationSettings {
  if (
    !input ||
    !Number.isInteger(input.retentionDays) ||
    input.retentionDays < 1 ||
    input.retentionDays > 3650
  )
    fail(400, 'INVALID_RETENTION_DAYS');
  initializeSettings(db);
  db.prepare('UPDATE organization_settings SET retention_days=? WHERE id=1').run(
    input.retentionDays,
  );
  return { retentionDays: input.retentionDays };
}
