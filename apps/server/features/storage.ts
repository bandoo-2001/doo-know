import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { privateFile } from '../../../packages/core/agent/config.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import type { FeatureId } from '../../../shared/feature-config.js';
import type { FeatureStorage } from '../../../shared/feature-contracts.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';

export function featureStorage(db: AppDatabase, id: FeatureId): FeatureStorage {
  return {
    get: <T>(key: string) => {
      const row = db
        .prepare('SELECT value FROM plugin_data WHERE plugin_id=? AND key=?')
        .get(id, key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    set(key, value) {
      const data = JSON.stringify(value);
      if (data === undefined || Buffer.byteLength(data) > 1024 * 1024)
        fail(413, 'FEATURE_DATA_TOO_LARGE');
      db.prepare(
        `INSERT INTO plugin_data VALUES(?,?,?)
        ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value`,
      ).run(id, key, data);
    },
    delete(key) {
      db.prepare('DELETE FROM plugin_data WHERE plugin_id=? AND key=?').run(id, key);
    },
    entries: <T>(prefix = '') => {
      const rows = db
        .prepare('SELECT key,value FROM plugin_data WHERE plugin_id=? ORDER BY key')
        .all(id) as { key: string; value: string }[];
      return rows
        .filter((row) => row.key.startsWith(prefix))
        .map((row) => ({ key: row.key, value: JSON.parse(row.value) as T }));
    },
  };
}

export function mcpObjectSecret(config: HostConfig) {
  // Existing MCP references depend on this key and must survive an upgrade.
  const file = join(
    config.secretFile ? dirname(config.secretFile) : join(config.dataRoot, 'secrets'),
    'plugins',
    'mcp',
    'runtime',
    'objects.key',
  );
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const value = privateFile(file, 8192).trim();
  if (value.length < 32) fail(500, 'MCP_SECRET_UNAVAILABLE');
  return value;
}
