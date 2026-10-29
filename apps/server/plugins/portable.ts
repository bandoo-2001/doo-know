import { Ajv } from 'ajv';
import { satisfies, valid, validRange } from 'semver';
import type { AppDatabase } from '../../../packages/core/db.js';
import {
  createKnowledgeDataDomain,
  listKnowledgeDataDirectories,
  readKnowledgeDataFile,
  type KnowledgeDataDomain,
} from '../../../packages/core/knowledge-data.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import {
  HOST_PLUGIN_API,
  type PluginDataDependency,
  type PluginManifest,
  type PluginStorage,
} from '../../../packages/plugin-contracts/index.js';

type Metadata = { id: string; version: string; apiVersion: string };
type State = {
  schemaVersion: 1;
  plugin: Metadata;
  config: Record<string, unknown>;
  userData: Record<string, unknown>;
};
type Installed = {
  id: string;
  installed_version: string;
  state: string;
  manifest_json: string;
  config_json: string;
};
const pluginId = /^[a-z][a-z0-9-]{0,63}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function keyCheck(key: string) {
  if (typeof key !== 'string' || key.length > 256 || /[\x00-\x1f]/.test(key))
    fail(400, 'INVALID_PLUGIN_STORAGE_KEY');
}
function metadata(manifest: PluginManifest): Metadata {
  return { id: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion };
}
function validateState(id: string, input: unknown): State {
  if (
    !record(input) || input.schemaVersion !== 1 || !record(input.plugin) ||
    input.plugin.id !== id || !pluginId.test(id) ||
    typeof input.plugin.version !== 'string' || !valid(input.plugin.version) ||
    typeof input.plugin.apiVersion !== 'string' || !validRange(input.plugin.apiVersion) ||
    !record(input.config) || !record(input.userData)
  ) fail(503, 'PORTABLE_PLUGIN_DATA_INVALID');
  if (Buffer.byteLength(JSON.stringify(input)) > 16 * 1024 * 1024)
    fail(413, 'PLUGIN_DATA_TOO_LARGE');
  for (const [key, value] of Object.entries(input.userData)) {
    keyCheck(key);
    if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024)
      fail(413, 'PLUGIN_DATA_TOO_LARGE');
  }
  return {
    schemaVersion: 1,
    plugin: { id, version: input.plugin.version, apiVersion: input.plugin.apiVersion },
    config: input.config,
    userData: Object.fromEntries(Object.entries(input.userData).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Only explicit, non-secret preferences are part of a knowledge library. */
export function portableConfigFields(manifest: PluginManifest) {
  return Object.fromEntries(
    Object.entries(manifest.configSchema.properties || {}).filter(
      ([key, field]) => record(field) && !field.writeOnly &&
        (field['x-dooknow-portable'] === true ||
          (manifest.id === 'git' && ['authorName', 'authorEmail'].includes(key) && field.type === 'string')),
    ),
  );
}
function selectConfig(manifest: PluginManifest, values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.keys(portableConfigFields(manifest))
      .filter((key) => Object.hasOwn(values, key))
      .map((key) => [key, values[key]]),
  );
}

export function portablePluginData(db: AppDatabase, knowledgeRoot: () => string | undefined) {
  db.exec(`CREATE TABLE IF NOT EXISTS portable_plugin_state(
    root TEXT NOT NULL,plugin_id TEXT NOT NULL,metadata_json TEXT NOT NULL,config_json TEXT NOT NULL,
    PRIMARY KEY(root,plugin_id));
    CREATE TABLE IF NOT EXISTS portable_plugin_data(
    root TEXT NOT NULL,plugin_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,
    PRIMARY KEY(root,plugin_id,key));`);
  const registered = new Map<string, KnowledgeDataDomain>();
  const installed = (id: string) => db.prepare(
    'SELECT id,installed_version,state,manifest_json,config_json FROM platform_plugins WHERE id=? AND installed=1',
  ).get(id) as Installed | undefined;
  const read = (root: string, id: string): State => {
    const row = db.prepare('SELECT metadata_json,config_json FROM portable_plugin_state WHERE root=? AND plugin_id=?')
      .get(root, id) as { metadata_json: string; config_json: string };
    return {
      schemaVersion: 1,
      plugin: JSON.parse(row.metadata_json),
      config: JSON.parse(row.config_json),
      userData: Object.fromEntries((db.prepare(
        'SELECT key,value FROM portable_plugin_data WHERE root=? AND plugin_id=? ORDER BY key',
      ).all(root, id) as { key: string; value: string }[]).map((row) => [row.key, JSON.parse(row.value)])),
    };
  };
  function domain(id: string, refresh = true): { root: string; domain: KnowledgeDataDomain } | undefined {
    if (!pluginId.test(id)) fail(400, 'INVALID_PLUGIN_ID');
    const root = knowledgeRoot();
    if (!root) return;
    const key = root + '\0' + id;
    let value = registered.get(key);
    if (!value) {
      const local = installed(id);
      const manifest = local && JSON.parse(local.manifest_json) as PluginManifest | undefined;
      const bytes = readKnowledgeDataFile(root, `plugins/${id}/state.json`);
      let imported: State | undefined;
      if (bytes) {
        try { imported = validateState(id, JSON.parse(bytes.toString('utf8')).data); }
        catch { fail(503, 'PORTABLE_PLUGIN_DATA_INVALID'); }
      }
      if (!manifest && !imported) return;
      const defaults = manifest ? Object.fromEntries(
        Object.entries(manifest.configSchema.properties || {})
          .filter(([, field]) => record(field) && 'default' in field)
          .map(([name, field]) => [name, structuredClone((field as Record<string, unknown>).default)]),
      ) : {};
      db.prepare('INSERT OR IGNORE INTO portable_plugin_state VALUES(?,?,?,?)').run(
        root, id,
        JSON.stringify(imported?.plugin || metadata(manifest!)),
        JSON.stringify(manifest ? selectConfig(manifest, { ...defaults, ...JSON.parse(local!.config_json) }) : {}),
      );
      value = createKnowledgeDataDomain({ knowledgeRoot: root }, db, `plugins/${id}/state.json`, {
        workspace: false,
        tables: ['portable_plugin_state', 'portable_plugin_data'],
        rows: {
          portable_plugin_state: { column: 'plugin_id', value: id },
          portable_plugin_data: { column: 'plugin_id', value: id },
        },
        read: (boundRoot) => read(boundRoot, id),
        validate: (input) => validateState(id, input),
        write: (state, boundRoot) => {
          db.prepare('INSERT INTO portable_plugin_state VALUES(?,?,?,?) ON CONFLICT(root,plugin_id) DO UPDATE SET metadata_json=excluded.metadata_json,config_json=excluded.config_json')
            .run(boundRoot, id, JSON.stringify(state.plugin), JSON.stringify(state.config));
          db.prepare('DELETE FROM portable_plugin_data WHERE root=? AND plugin_id=?').run(boundRoot, id);
          const insert = db.prepare('INSERT INTO portable_plugin_data VALUES(?,?,?,?)');
          for (const [key, value] of Object.entries(state.userData)) insert.run(boundRoot, id, key, JSON.stringify(value));
        },
      });
      registered.set(key, value);
    }
    if (refresh) value.refresh();
    return { root, domain: value };
  }
  function config(id: string, manifest: PluginManifest) {
    const current = domain(id);
    if (!current) return;
    const values = selectConfig(manifest, read(current.root, id).config);
    const properties = portableConfigFields(manifest);
    const schema = {
      ...manifest.configSchema, type: 'object', properties, additionalProperties: false,
      required: (manifest.configSchema.required || []).filter((key: string) => Object.hasOwn(properties, key)),
    };
    if (!new Ajv({ strict: false }).compile(schema)(values)) fail(503, 'PORTABLE_PLUGIN_CONFIG_INVALID');
    return { values, keys: Object.keys(properties) };
  }
  function prepareConfig(id: string, manifest: PluginManifest) {
    const current = domain(id, false);
    if (!current) return;
    const path = `plugins/${id}/state.json`;
    const baseline = readKnowledgeDataFile(current.root, path);
    const projection = JSON.stringify(validateState(id, read(current.root, id)));
    if (!baseline || JSON.stringify(validateState(id, JSON.parse(baseline.toString('utf8')).data)) !== projection)
      fail(409, 'CONFIG_VERSION_CONFLICT');
    return {
      check: () => {
        const latest = readKnowledgeDataFile(current.root, path);
        if (knowledgeRoot() !== current.root || !latest || !baseline.equals(latest) ||
          JSON.stringify(validateState(id, read(current.root, id))) !== projection)
          fail(409, 'CONFIG_VERSION_CONFLICT');
      },
      write: (values: Record<string, unknown>) => {
        db.prepare('UPDATE portable_plugin_state SET metadata_json=?,config_json=? WHERE root=? AND plugin_id=?')
          .run(JSON.stringify(metadata(manifest)), JSON.stringify(selectConfig(manifest, values)), current.root, id);
        validateState(id, read(current.root, id));
      },
      flush: () => current.domain.flush(),
    };
  }
  function userData(id: string): PluginStorage {
    const ready = () => {
      const current = domain(id);
      if (!current) fail(503, 'KNOWLEDGE_DATA_UNAVAILABLE', '请先配置知识库再保存插件用户资料');
      return current;
    };
    return {
      get: <T>(key: string) => {
        keyCheck(key);
        const { root } = ready();
        const row = db.prepare('SELECT value FROM portable_plugin_data WHERE root=? AND plugin_id=? AND key=?')
          .get(root, id, key) as { value: string } | undefined;
        return row ? JSON.parse(row.value) as T : undefined;
      },
      set: (key, value) => {
        keyCheck(key);
        const serialized = JSON.stringify(value);
        if (serialized === undefined || Buffer.byteLength(serialized) > 1024 * 1024)
          fail(413, 'PLUGIN_DATA_TOO_LARGE');
        const current = ready();
        const row = installed(id);
        if (!row) fail(404, 'PLUGIN_NOT_INSTALLED');
        db.transaction(() => {
          db.prepare('INSERT INTO portable_plugin_data VALUES(?,?,?,?) ON CONFLICT(root,plugin_id,key) DO UPDATE SET value=excluded.value')
            .run(current.root, id, key, serialized);
          db.prepare('UPDATE portable_plugin_state SET metadata_json=? WHERE root=? AND plugin_id=?')
            .run(JSON.stringify(metadata(JSON.parse(row.manifest_json))), current.root, id);
          validateState(id, read(current.root, id));
        }).immediate();
        current.domain.flush();
      },
      delete: (key) => {
        keyCheck(key);
        const current = ready();
        db.prepare('DELETE FROM portable_plugin_data WHERE root=? AND plugin_id=? AND key=?').run(current.root, id, key);
        current.domain.flush();
      },
      entries: <T>(prefix = '') => {
        const { root } = ready();
        return (db.prepare('SELECT key,value FROM portable_plugin_data WHERE root=? AND plugin_id=? ORDER BY key')
          .all(root, id) as { key: string; value: string }[])
          .filter((row) => row.key.startsWith(prefix))
          .map((row) => ({ key: row.key, value: JSON.parse(row.value) as T }));
      },
    };
  }
  function dependencies(catalog: PluginManifest[]): PluginDataDependency[] {
    const root = knowledgeRoot();
    if (!root) return [];
    const ids = new Set([
      ...listKnowledgeDataDirectories(root, 'plugins').filter((id) => pluginId.test(id)),
      ...(db.prepare('SELECT plugin_id FROM portable_plugin_state WHERE root=? ORDER BY plugin_id').all(root) as { plugin_id: string }[]).map((row) => row.plugin_id),
    ]);
    return [...ids].sort().flatMap((id): PluginDataDependency[] => {
      const local = installed(id);
      const available = catalog.find((entry) => entry.id === id);
      try {
        const current = domain(id);
        if (!current) return [];
        const required = read(current.root, id).plugin;
        const currentManifest = local && JSON.parse(local.manifest_json) as PluginManifest | undefined;
        if (currentManifest) config(id, currentManifest);
        const compatible = satisfies(HOST_PLUGIN_API, required.apiVersion);
        const state = !compatible ? 'incompatible' : local
          ? local.installed_version !== required.version ? 'version_mismatch'
            : local.state === 'enabled' ? 'enabled' : 'disabled'
          : available ? 'missing' : 'unavailable';
        return [{ ...required, title: currentManifest?.title || available?.title || id, state,
          ...(local ? { installedVersion: local.installed_version } : {}),
          installAvailable: !!available }];
      } catch {
        return [{ id, title: available?.title || id, state: 'invalid', installAvailable: !!available }];
      }
    });
  }
  return { config, prepareConfig, userData, dependencies };
}
