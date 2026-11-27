import { Ajv } from 'ajv';
import { valid, validRange } from 'semver';
import type { AppDatabase } from '../../../packages/core/db.js';
import {
  createKnowledgeDataDomain,
  readKnowledgeDataFile,
  type KnowledgeDataDomain,
} from '../../../packages/core/knowledge-data.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { featureConfig } from '../../../shared/feature-config.js';

const keys = ['authorName', 'authorEmail'] as const;
const path = 'plugins/git/state.json';
const metadata = { id: 'git', version: '1.1.4', apiVersion: '^1.0.0' };
type PortableGitState = {
  schemaVersion: 1;
  plugin: typeof metadata;
  config: Record<string, unknown>;
  userData: Record<string, unknown>;
};

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const authors = (values: Record<string, unknown>) =>
  Object.fromEntries(
    keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]),
  );
const validAuthors = new Ajv({ strict: false }).compile(featureConfig.git);

// Read and write the existing portable file format so mixed-version Git
// worktrees continue to share the same author settings.
function validate(input: unknown): PortableGitState {
  if (
    !record(input) ||
    input.schemaVersion !== 1 ||
    !record(input.plugin) ||
    input.plugin.id !== 'git' ||
    typeof input.plugin.version !== 'string' ||
    !valid(input.plugin.version) ||
    typeof input.plugin.apiVersion !== 'string' ||
    !validRange(input.plugin.apiVersion) ||
    !record(input.config) ||
    !record(input.userData)
  )
    fail(503, 'PORTABLE_GIT_SETTINGS_INVALID');
  for (const [key, value] of Object.entries(input.userData)) {
    if (
      key.length > 256 ||
      /[\x00-\x1f]/.test(key) ||
      Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024
    )
      fail(503, 'PORTABLE_GIT_SETTINGS_INVALID');
  }
  if (
    Buffer.byteLength(JSON.stringify(input)) > 16 * 1024 * 1024 ||
    !validAuthors(authors(input.config))
  )
    fail(503, 'PORTABLE_GIT_SETTINGS_INVALID');
  return {
    schemaVersion: 1,
    plugin: { id: 'git', version: input.plugin.version, apiVersion: input.plugin.apiVersion },
    config: input.config,
    userData: Object.fromEntries(
      Object.entries(input.userData).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

export function portableGitSettings(db: AppDatabase, knowledgeRoot: () => string | undefined) {
  db.exec(`CREATE TABLE IF NOT EXISTS portable_plugin_state(
    root TEXT NOT NULL,plugin_id TEXT NOT NULL,metadata_json TEXT NOT NULL,config_json TEXT NOT NULL,
    PRIMARY KEY(root,plugin_id));
    CREATE TABLE IF NOT EXISTS portable_plugin_data(
    root TEXT NOT NULL,plugin_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,
    PRIMARY KEY(root,plugin_id,key));`);
  const registered = new Map<string, KnowledgeDataDomain>();

  function read(root: string): PortableGitState {
    const row = db
      .prepare(
        "SELECT metadata_json,config_json FROM portable_plugin_state WHERE root=? AND plugin_id='git'",
      )
      .get(root) as { metadata_json: string; config_json: string };
    return {
      schemaVersion: 1,
      plugin: JSON.parse(row.metadata_json),
      config: JSON.parse(row.config_json),
      userData: Object.fromEntries(
        (
          db
            .prepare(
              "SELECT key,value FROM portable_plugin_data WHERE root=? AND plugin_id='git' ORDER BY key",
            )
            .all(root) as { key: string; value: string }[]
        ).map((row) => [row.key, JSON.parse(row.value)]),
      ),
    };
  }

  function domain(initial: Record<string, unknown>, create = false) {
    const root = knowledgeRoot();
    if (!root) return;
    let value = registered.get(root);
    if (!value) {
      const bytes = readKnowledgeDataFile(root, path);
      const configured = authors(initial);
      if (
        !bytes &&
        !create &&
        !Object.values(configured).some(Boolean) &&
        !db
          .prepare("SELECT 1 FROM portable_plugin_state WHERE root=? AND plugin_id='git'")
          .get(root)
      )
        return;
      let imported: PortableGitState | undefined;
      if (bytes) {
        try {
          imported = validate(JSON.parse(bytes.toString('utf8')).data);
        } catch {
          fail(503, 'PORTABLE_GIT_SETTINGS_INVALID');
        }
      }
      db.prepare("INSERT OR IGNORE INTO portable_plugin_state VALUES(?,'git',?,?)").run(
        root,
        JSON.stringify(imported?.plugin || metadata),
        JSON.stringify(configured),
      );
      value = createKnowledgeDataDomain({ knowledgeRoot: root }, db, path, {
        workspace: false,
        tables: ['portable_plugin_state', 'portable_plugin_data'],
        rows: {
          portable_plugin_state: { column: 'plugin_id', value: 'git' },
          portable_plugin_data: { column: 'plugin_id', value: 'git' },
        },
        read,
        validate,
        write: (state, boundRoot) => {
          db.prepare(
            `INSERT INTO portable_plugin_state VALUES(?,'git',?,?)
            ON CONFLICT(root,plugin_id) DO UPDATE SET metadata_json=excluded.metadata_json,config_json=excluded.config_json`,
          ).run(boundRoot, JSON.stringify(state.plugin), JSON.stringify(state.config));
          db.prepare("DELETE FROM portable_plugin_data WHERE root=? AND plugin_id='git'").run(
            boundRoot,
          );
          const insert = db.prepare("INSERT INTO portable_plugin_data VALUES(?,'git',?,?)");
          for (const [key, entry] of Object.entries(state.userData))
            insert.run(boundRoot, key, JSON.stringify(entry));
        },
      });
      registered.set(root, value);
    }
    value.refresh();
    return { root, domain: value };
  }

  return {
    read(initial: Record<string, unknown>) {
      const current = domain(initial);
      if (current) return authors(validate(read(current.root)).config);
    },
    prepare(initial: Record<string, unknown>) {
      const current = domain(initial, true);
      if (!current) return;
      const baseline = readKnowledgeDataFile(current.root, path);
      const projection = JSON.stringify(validate(read(current.root)));
      if (
        !baseline ||
        JSON.stringify(validate(JSON.parse(baseline.toString('utf8')).data)) !== projection
      )
        fail(409, 'CONFIG_VERSION_CONFLICT');
      return {
        check() {
          const latest = readKnowledgeDataFile(current.root, path);
          if (
            knowledgeRoot() !== current.root ||
            !latest ||
            !baseline.equals(latest) ||
            JSON.stringify(validate(read(current.root))) !== projection
          )
            fail(409, 'CONFIG_VERSION_CONFLICT');
        },
        write(values: Record<string, unknown>) {
          // Preserve other legacy fields already in the file.
          const config = { ...read(current.root).config, ...authors(values) };
          db.prepare(
            "UPDATE portable_plugin_state SET config_json=? WHERE root=? AND plugin_id='git'",
          ).run(JSON.stringify(config), current.root);
        },
        flush: () => current.domain.flush(),
      };
    },
  };
}
