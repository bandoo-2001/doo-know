import type { AppDatabase } from './db.js';
import { featureIds, type FeatureId } from '../../shared/feature-config.js';
import type { FeatureView } from '../../shared/feature-contracts.js';

type SettingsRow = {
  id: FeatureId;
  desired_enabled: number;
  config_version: number;
  config_json: string;
  state: FeatureView['state'];
  error: string | null;
};

export function initializeFeatureSettings(db: AppDatabase) {
  // Keep the settings and operation identities used by earlier releases. A
  // rollback can still read its original installation metadata and preferences.
  db.exec(`CREATE TABLE IF NOT EXISTS platform_plugins (
    id TEXT PRIMARY KEY,installed_version TEXT NOT NULL,active_version TEXT,installed INTEGER NOT NULL DEFAULT 1,
    desired_enabled INTEGER NOT NULL DEFAULT 0,config_version INTEGER NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL DEFAULT '{}',manifest_json TEXT NOT NULL,files_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'disabled',restart_required INTEGER NOT NULL DEFAULT 0,error TEXT);
    CREATE TABLE IF NOT EXISTS plugin_data(
      plugin_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(plugin_id,key)
    );`);
}

export function prepareFeatureSettings(db: AppDatabase) {
  initializeFeatureSettings(db);
  db.transaction(() => {
    const insert = db.prepare(`INSERT OR IGNORE INTO platform_plugins
      (id,installed_version,installed,manifest_json,files_json) VALUES (?,'0.0.0',0,'{}','{}')`);
    for (const id of featureIds) insert.run(id);
    db.prepare(
      "UPDATE platform_plugins SET state='disabled',error=NULL WHERE id IN ('git','mcp')",
    ).run();
  }).immediate();
}

export function featureSettingsRow(db: AppDatabase, id: FeatureId): SettingsRow {
  return db
    .prepare(
      'SELECT id,desired_enabled,config_version,config_json,state,error FROM platform_plugins WHERE id=?',
    )
    .get(id) as SettingsRow;
}

export function readFeatureConfig(db: AppDatabase, id: FeatureId, enabledOnly = false) {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_plugins'").get()
  )
    return;
  const row = db.prepare('SELECT config_json,state FROM platform_plugins WHERE id=?').get(id) as
    | { config_json: string; state: string }
    | undefined;
  if (row && (!enabledOnly || row.state === 'enabled'))
    return JSON.parse(row.config_json) as Record<string, any>;
}
