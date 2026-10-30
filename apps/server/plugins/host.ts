import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmSync,
  lstatSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { privateFile } from '../../../packages/core/agent/config.js';
import { Ajv } from 'ajv';
import { valid, satisfies } from 'semver';
import {
  HOST_PLUGIN_API,
  type PluginManifest,
  type PluginCatalogEntry,
  type PluginView,
  type PluginStorage,
  type PluginCallInput,
} from '../../../packages/plugin-contracts/index.js';
import type {
  PluginContext,
  PluginModule,
  PluginCall,
  PluginServices,
  HostCallContext,
  Disposer,
  ProtocolCall,
} from '../../../packages/plugin-sdk/index.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import { fail, KnowledgeError } from '../../../packages/core/knowledge/errors.js';
import { sha256 } from '../../../packages/core/knowledge/operations.js';
import { unpackPlugin, packagePath, type PluginInstallOptions } from './packages.js';
import { remoteAuthGeneration } from '../../../packages/core/auth/remote-auth.js';
import { portablePluginData } from './portable.js';

type Handler = (call: PluginCall) => unknown | Promise<unknown>;
type Active = {
  commands: Map<string, Handler>;
  providers: Map<string, Handler>;
  protocols: Map<string, (call: ProtocolCall) => Promise<void>>;
  disposers: Disposer[];
  validators: ((config: Record<string, any>) => void | Promise<void>)[];
  calls: Set<Promise<unknown>>;
  version: string;
  config: Record<string, any>;
  manifest: PluginManifest;
  files: Record<string, string>;
};
type Row = {
  id: string;
  installed_version: string;
  active_version: string | null;
  installed: number;
  desired_enabled: number;
  config_version: number;
  config_json: string;
  manifest_json: string;
  files_json: string;
  state: PluginView['state'];
  restart_required: number;
  error: string | null;
};
const slots = new Set([
  'navigation',
  'settingsPage',
  'fileDecoration',
  'noteAction',
  'notePanel',
  'libraryAction',
]);
const capabilities = new Set([
  'knowledge:read',
  'knowledge:write',
  'knowledge:index',
  'knowledge:organize',
  'knowledge:archive',
  'knowledge:share',
  'knowledge:manage',
  'blog:read',
  'blog:write',
  'blog:manage',
  'blog:publish',
  'to-doo:read',
  'to-doo:write',
  'to-doo:share',
  'to-doo:integrations',
  'workspace:git',
  'protocol:mcp',
]);
export function pluginHost(
  config: HostConfig & { pluginCatalog?: PluginCatalogEntry[]; pluginRoot?: string },
  db: AppDatabase,
  services?: (id: string, capabilities: string[], context: HostCallContext) => PluginServices,
  knowledgeRoot: () => string | undefined = () => config.knowledgeRoot,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS platform_plugins (
    id TEXT PRIMARY KEY,installed_version TEXT NOT NULL,active_version TEXT,installed INTEGER NOT NULL DEFAULT 1,
    desired_enabled INTEGER NOT NULL DEFAULT 0,config_version INTEGER NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL DEFAULT '{}',manifest_json TEXT NOT NULL,files_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'disabled',restart_required INTEGER NOT NULL DEFAULT 0,error TEXT);
    CREATE TABLE IF NOT EXISTS plugin_data(plugin_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(plugin_id,key));
    CREATE TABLE IF NOT EXISTS plugin_secrets(reference TEXT PRIMARY KEY,plugin_id TEXT NOT NULL,field TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  if (
    !(db.prepare('PRAGMA table_info(plugin_secrets)').all() as any[]).some(
      (c) => c.name === 'auth_generation',
    )
  )
    db.exec('ALTER TABLE plugin_secrets ADD COLUMN auth_generation INTEGER NOT NULL DEFAULT -1');
  const listeners = new Set<() => void | Promise<void>>();
  const changed = async () => {
    for (const listener of listeners) await listener();
  };
  const root = config.pluginRoot || join(config.dataRoot, '..', 'plugins');
  const catalogFile = config.applicationRoot && join(config.applicationRoot, 'catalog.json');
  const catalog: PluginCatalogEntry[] =
    config.pluginCatalog ||
    (catalogFile && existsSync(catalogFile) ? JSON.parse(readFileSync(catalogFile, 'utf8')) : []);
  const active = new Map<string, Active>(),
    loaded = new Map<string, string>();
  const portable = portablePluginData(db, knowledgeRoot);
  const instance = randomUUID();
  let closing = false,
    tail = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const row = (id: string, synchronize = true) => {
    const result = db
      .prepare('SELECT * FROM platform_plugins WHERE id=? AND installed=1')
      .get(id) as Row | undefined;
    if (!result) fail(404, 'PLUGIN_NOT_INSTALLED');
    return synchronize ? syncPortableConfig(result) : result;
  };
  const manifest = (r: Row) => JSON.parse(r.manifest_json) as PluginManifest;
  function syncPortableConfig(r: Row) {
    const m = manifest(r);
    const selected = portable.config(r.id, m);
    if (!selected) return r;
    const previous = JSON.parse(r.config_json), next = { ...previous };
    for (const key of selected.keys) delete next[key];
    Object.assign(next, selected.values);
    const before = { ...defaults(m), ...previous }, after = { ...defaults(m), ...next };
    if (Object.keys(before).length === Object.keys(after).length &&
      Object.entries(before).every(([key, value]) => JSON.stringify(value) === JSON.stringify(after[key]))) return r;
    const restart = active.has(r.id) ? 1 : r.restart_required;
    db.prepare('UPDATE platform_plugins SET config_json=?,config_version=config_version+1,restart_required=? WHERE id=?')
      .run(JSON.stringify(next), restart, r.id);
    return { ...r, config_json: JSON.stringify(next), config_version: r.config_version + 1, restart_required: restart };
  }
  const directory = (id: string, version: string) => join(root, id, version);
  function verifyManifest(m: PluginManifest) {
    if (
      !m ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(m.id) ||
      !valid(m.version) ||
      !m.title ||
      !satisfies(HOST_PLUGIN_API, m.apiVersion) ||
      !packagePath(m.server) ||
      (m.web && (!packagePath(m.web) || !m.web.startsWith('web/'))) ||
      (m.styles &&
        (!Array.isArray(m.styles) ||
          m.styles.some((p) => !packagePath(p) || !p.startsWith('web/') || !p.endsWith('.css')))) ||
      !Array.isArray(m.capabilities) ||
      m.capabilities.some((c) => !capabilities.has(c)) ||
      !m.configSchema ||
      typeof m.configSchema !== 'object' ||
      !Array.isArray(m.contributions)
    )
      fail(400, 'INVALID_PLUGIN_MANIFEST');
    const ids = new Set<string>();
    for (const item of m.contributions) {
      if (
        !item.id?.startsWith(m.id + '.') ||
        ids.has(item.id) ||
        !slots.has(item.slot) ||
        !item.title ||
        item.when?.some(
          (rule) =>
            !/^[a-zA-Z][a-zA-Z0-9.]*$/.test(rule.key) ||
            !['boolean', 'number', 'string'].includes(typeof rule.equals),
        )
      )
        fail(400, 'INVALID_PLUGIN_MANIFEST');
      ids.add(item.id);
    }
    // v1 keeps secret controls explicit. Reject unsupported nested annotations
    // instead of silently storing them as ordinary configuration.
    const secretSchema = (value: any, path: string[] = []) => {
      if (!value || typeof value !== 'object') return;
      if (
        value.writeOnly &&
        (path.length !== 2 ||
          path[0] !== 'properties' ||
          value.type !== 'string' ||
          'default' in value)
      )
        fail(400, 'UNSUPPORTED_PLUGIN_SECRET_SCHEMA');
      for (const [key, child] of Object.entries(value)) secretSchema(child, [...path, key]);
    };
    secretSchema(m.configSchema);
    try {
      new Ajv({ strict: false }).compile(m.configSchema);
    } catch {
      fail(400, 'INVALID_PLUGIN_MANIFEST');
    }
  }
  function storage(id: string): PluginStorage {
    const keyCheck = (key: string) => {
      if (typeof key !== 'string' || key.length > 256 || /[\x00-\x1f]/.test(key))
        fail(400, 'INVALID_PLUGIN_STORAGE_KEY');
    };
    return {
      get: <T>(key: string) => {
        keyCheck(key);
        const found = db
          .prepare('SELECT value FROM plugin_data WHERE plugin_id=? AND key=?')
          .get(id, key) as any;
        return found ? (JSON.parse(found.value) as T) : undefined;
      },
      set: (key, value) => {
        keyCheck(key);
        const data = JSON.stringify(value);
        if (data === undefined || Buffer.byteLength(data) > 1024 * 1024)
          fail(413, 'PLUGIN_DATA_TOO_LARGE');
        db.prepare(
          'INSERT INTO plugin_data VALUES(?,?,?) ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value',
        ).run(id, key, data);
      },
      delete: (key) => {
        keyCheck(key);
        db.prepare('DELETE FROM plugin_data WHERE plugin_id=? AND key=?').run(id, key);
      },
      entries: <T>(prefix = '') =>
        (
          db
            .prepare('SELECT key,value FROM plugin_data WHERE plugin_id=? ORDER BY key')
            .all(id) as any[]
        )
          .filter((r) => r.key.startsWith(prefix))
          .map((r) => ({ key: r.key, value: JSON.parse(r.value) as T })),
    };
  }
  const secretDir = (id: string) =>
    join(
      config.secretFile ? dirname(config.secretFile) : join(config.dataRoot, 'secrets'),
      'plugins',
      id,
    );
  function defaults(m: PluginManifest) {
    return Object.fromEntries(
      Object.entries(m.configSchema.properties || {})
        .filter(([, p]) => p && typeof p === 'object' && 'default' in p)
        .map(([k, p]) => [k, structuredClone((p as any).default)]),
    );
  }
  function plain(r: Row) {
    const values = { ...defaults(manifest(r)), ...JSON.parse(r.config_json) };
    for (const [key, value] of Object.entries(values))
      if (
        manifest(r).configSchema.properties?.[key]?.writeOnly &&
        value &&
        typeof value === 'object' &&
        '$secretRef' in value
      ) {
        const ref = (value as any).$secretRef;
        if (!/^[a-f0-9-]{36}$/.test(ref)) fail(500, 'INVALID_PLUGIN_SECRET_REFERENCE');
        const file = join(secretDir(r.id), ref);
        const info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
          fail(500, 'INVALID_PLUGIN_SECRET_REFERENCE');
        values[key] = readFileSync(file, 'utf8');
      }
    return values;
  }
  function validate(m: PluginManifest, values: Record<string, any>) {
    const data = structuredClone(values),
      ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
    const check = ajv.compile(m.configSchema);
    if (!check(data)) fail(400, 'INVALID_PLUGIN_CONFIG', '插件配置不符合要求');
    return data;
  }
  function view(r: Row): PluginView {
    const values = { ...defaults(manifest(r)), ...JSON.parse(r.config_json) },
      configuredSecrets: string[] = [];
    for (const [key, value] of Object.entries(values))
      if (
        manifest(r).configSchema.properties?.[key]?.writeOnly &&
        value &&
        typeof value === 'object' &&
        '$secretRef' in value
      ) {
        delete values[key];
        configuredSecrets.push(key);
      }
    const running = active.get(r.id),
      web = running?.manifest.web;
    return {
      id: r.id,
      installedVersion: r.installed_version,
      ...(r.active_version ? { activeVersion: r.active_version } : {}),
      desiredEnabled: !!r.desired_enabled,
      state: r.state,
      configVersion: r.config_version,
      restartRequired: !!r.restart_required,
      ...(r.error ? { error: r.error } : {}),
      manifest: manifest(r),
      config: values,
      configuredSecrets,
      ...(running ? { activeManifest: running.manifest } : {}),
      ...(web
        ? {
            webUrl: `/plugins/${r.id}/${running!.version}/${sha256(JSON.stringify(running!.files))}/${web}`,
          }
        : {}),
    };
  }
  async function install(id: string, options: PluginInstallOptions = {}, beforeAction?: () => void) {
    if (closing) fail(503, 'PLUGIN_HOST_STOPPING');
    const entry = catalog.find((e) => e.id === id);
    if (!entry) fail(404, 'PLUGIN_NOT_IN_CATALOG');
    verifyManifest(entry);
    const stage = join(root, `.install-${randomUUID()}`);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    try {
      const files = await unpackPlugin(entry.artifact.url, entry.artifact.sha256, stage, config.distribution, options);
      const m = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8')) as PluginManifest;
      verifyManifest(m);
      if (
        m.id !== entry.id ||
        m.version !== entry.version ||
        !files[m.server] ||
        (m.web && !files[m.web]) ||
        m.styles?.some((p) => !files[p])
      )
        fail(400, 'INVALID_PLUGIN_PACKAGE');
      options.signal?.throwIfAborted();
      beforeAction?.();
      options.onPhase?.('installing');
      const target = directory(m.id, m.version);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (!existsSync(target)) renameSync(stage, target);
      else
        for (const [name, hash] of Object.entries(files))
          if (sha256(readFileSync(join(target, name))) !== hash)
            fail(409, 'PLUGIN_VERSION_CONTENT_CONFLICT');
      db.prepare(
        `INSERT INTO platform_plugins(id,installed_version,manifest_json,files_json) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET installed=1,installed_version=excluded.installed_version,manifest_json=excluded.manifest_json,files_json=excluded.files_json,
        restart_required=CASE WHEN active_version IS NOT NULL AND active_version<>excluded.installed_version THEN 1 ELSE restart_required END`,
      ).run(m.id, m.version, JSON.stringify(m), JSON.stringify(files));
      return view(row(id));
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  async function configure(id: string, input: Record<string, unknown>, expectedVersion: number) {
    const r = row(id),
      m = manifest(r);
    if (active.has(id) && active.get(id)!.version !== r.installed_version)
      fail(409, 'PLUGIN_RESTART_REQUIRED');
    if (r.config_version !== expectedVersion) fail(409, 'CONFIG_VERSION_CONFLICT');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail(400, 'INVALID_PLUGIN_CONFIG');
    const portableUpdate = portable.prepareConfig(id, m);
    const generation = remoteAuthGeneration(db);
    const previous = plain(r),
      previousStored = JSON.parse(r.config_json);
    const values = structuredClone(previous);
    for (const [key, value] of Object.entries(input)) {
      if (value === null && m.configSchema.properties?.[key]?.writeOnly) delete values[key];
      else values[key] = value;
    }
    const validated = validate(m, values);
    for (const validator of active.get(id)?.validators || []) await validator(validated);
    portableUpdate?.check();
    const stored = { ...validated };
    const createdSecrets: { ref: string; field: string; time: number }[] = [];
    for (const [key, property] of Object.entries(m.configSchema.properties || {}))
      if ((property as any).writeOnly && typeof stored[key] === 'string') {
        if (previousStored[key]?.$secretRef && previous[key] === stored[key]) {
          stored[key] = previousStored[key];
          continue;
        }
        const ref = randomUUID();
        mkdirSync(secretDir(id), { recursive: true, mode: 0o700 });
        writeFileSync(join(secretDir(id), ref), stored[key], { mode: 0o600, flag: 'wx' });
        stored[key] = { $secretRef: ref };
        createdSecrets.push({ ref, field: key, time: Date.now() });
      }
    db.transaction(() => {
      if (generation !== remoteAuthGeneration(db)) fail(409, 'AUTHORIZATION_CHANGED');
      portableUpdate?.check();
      const updated = db
        .prepare(
          'UPDATE platform_plugins SET config_json=?,config_version=config_version+1,restart_required=? WHERE id=? AND config_version=?',
        )
        .run(
          JSON.stringify(stored),
          active.has(id) && m.configurationRequiresRestart ? 1 : r.restart_required,
          id,
          expectedVersion,
        );
      if (updated.changes !== 1) fail(409, 'CONFIG_VERSION_CONFLICT');
      for (const secret of createdSecrets)
        db.prepare('INSERT INTO plugin_secrets VALUES(?,?,?,?,?)').run(
          secret.ref,
          id,
          secret.field,
          secret.time,
          generation,
        );
      portableUpdate?.write(stored);
    }).immediate();
    portableUpdate?.flush();
    if (active.has(id) && !m.configurationRequiresRestart) active.get(id)!.config = validated;
    await changed();
    return view(row(id));
  }
  async function stop(id: string, persist: boolean) {
    const running = active.get(id);
    db.prepare(
      `UPDATE platform_plugins SET state='stopping'${persist ? ',desired_enabled=0' : ''} WHERE id=?`,
    ).run(id);
    if (running) {
      // Remove the registry before waiting, so stale browser actions are rejected.
      active.delete(id);
      await changed();
      await Promise.allSettled([...running.calls]);
      let failed = false;
      for (const dispose of [...running.disposers].reverse()) {
        try {
          await dispose();
        } catch {
          failed = true;
        }
      }
      if (failed)
        db.prepare('UPDATE platform_plugins SET restart_required=1,error=? WHERE id=?').run(
          'PLUGIN_CLEANUP_FAILED',
          id,
        );
    }
    db.prepare("UPDATE platform_plugins SET state='disabled' WHERE id=?").run(id);
  }
  async function enable(id: string) {
    if (closing) fail(503, 'PLUGIN_HOST_STOPPING');
    if (active.has(id)) return view(row(id, false));
    let r = row(id, false);
    const m = manifest(r);
    if (loaded.has(id) && loaded.get(id) !== r.installed_version)
      fail(409, 'PLUGIN_RESTART_REQUIRED');
    if (loaded.has(id) && r.restart_required) fail(409, 'PLUGIN_RESTART_REQUIRED');
    db.prepare(
      "UPDATE platform_plugins SET desired_enabled=1,state='starting',error=NULL WHERE id=?",
    ).run(id);
    const running: Active = {
      commands: new Map(),
      providers: new Map(),
      protocols: new Map(),
      disposers: [],
      validators: [],
      calls: new Set(),
      version: r.installed_version,
      config: {},
      manifest: m,
      files: JSON.parse(r.files_json),
    };
    const register = <T>(map: Map<string, T>, key: string, handler: T): Disposer => {
      if (!key.startsWith(id + '.') || map.has(key)) fail(400, 'DUPLICATE_PLUGIN_CONTRIBUTION');
      map.set(key, handler);
      const dispose = () => {
        map.delete(key);
      };
      running.disposers.push(dispose);
      return dispose;
    };
    try {
      r = syncPortableConfig(r);
      for (const [name, hash] of Object.entries(JSON.parse(r.files_json))) {
        const file = join(directory(id, r.installed_version), name),
          info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || sha256(readFileSync(file)) !== hash)
          fail(400, 'PLUGIN_CHECKSUM_MISMATCH');
      }
      running.config = validate(m, plain(r));
      const context: PluginContext = {
        id,
        dataRoot: join(config.dataRoot, 'plugins', id),
        storage: storage(id),
        userData: portable.userData(id),
        config: () => structuredClone(running.config),
        track: (task) => {
          running.calls.add(task);
          void task.then(() => running.calls.delete(task), () => running.calls.delete(task));
          return task;
        },
        secrets: {
          getOrCreate: (name) => {
            if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) fail(400, 'INVALID_PLUGIN_SECRET_NAME');
            const file = join(secretDir(id), 'runtime', name + '.key');
            if (!existsSync(file)) {
              mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
              try {
                writeFileSync(file, randomBytes(48).toString('base64url'), {
                  mode: 0o600,
                  flag: 'wx',
                });
              } catch (e) {
                if ((e as any).code !== 'EEXIST') throw e;
              }
            }
            const value = privateFile(file, 8192).trim();
            if (value.length < 32) fail(500, 'PLUGIN_SECRET_UNAVAILABLE');
            return value;
          },
        },
        registerCommand: (key, handler) => register(running.commands, key, handler),
        registerProvider: (key, handler) => register(running.providers, key, handler),
        registerProtocol: (key, handler) => {
          if (!m.capabilities.includes('protocol:mcp') || id !== 'mcp')
            fail(403, 'PLUGIN_CAPABILITY_REQUIRED');
          return register(running.protocols, key, handler);
        },
        onDispose: (dispose) => {
          running.disposers.push(dispose);
        },
        onConfigure: (validator) => {
          running.validators.push(validator);
        },
      };
      mkdirSync(context.dataRoot, { recursive: true, mode: 0o700 });
      const code = (await import(
        pathToFileURL(join(directory(id, r.installed_version), m.server)).href + '?host=' + instance
      )) as PluginModule;
      loaded.set(id, r.installed_version);
      if (typeof code.activate !== 'function') fail(400, 'INVALID_PLUGIN_ENTRY');
      const dispose = await code.activate(context);
      if (dispose) running.disposers.push(dispose);
      for (const c of m.contributions)
        if (
          (c.command && !running.commands.has(c.command)) ||
          (c.provider && !running.providers.has(c.provider))
        )
          fail(400, 'MISSING_PLUGIN_IMPLEMENTATION');
      active.set(id, running);
      db.prepare(
        "UPDATE platform_plugins SET state='enabled',active_version=?,restart_required=0,error=NULL WHERE id=?",
      ).run(r.installed_version, id);
      await changed();
      return view(row(id, false));
    } catch (e) {
      active.delete(id);
      for (const dispose of [...running.disposers].reverse()) {
        try {
          await dispose();
        } catch {}
      }
      db.prepare("UPDATE platform_plugins SET state='failed',active_version=NULL,error=? WHERE id=?").run(
        (e as any).code || (e as any).details?.code || 'PLUGIN_START_FAILED',
        id,
      );
      throw e;
    }
  }
  async function call(id: string, input: PluginCallInput, context: HostCallContext) {
    const running = active.get(id);
    if (!running || closing) fail(409, 'PLUGIN_DISABLED');
    if (!input || !['command', 'provider'].includes(input.kind) || typeof input.id !== 'string')
      fail(400, 'INVALID_PLUGIN_CALL');
    const handler = (input.kind === 'command' ? running.commands : running.providers).get(input.id);
    if (!handler) fail(404, 'PLUGIN_COMMAND_NOT_FOUND');
    const task = Promise.resolve().then(() =>
      handler({
        ...context,
        input: input.input,
        services: services?.(id, running.manifest.capabilities, context) as PluginServices,
      }),
    );
    running.calls.add(task);
    try {
      return await task;
    } catch (e) {
      if (e instanceof KnowledgeError) throw e;
      const error = e as any;
      if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code))
        fail(
          error.statusCode || error.status || 500,
          error.code,
          error.code,
          !!error.retryable,
          error.publication === 'not_published' ? { publication: 'not_published' } : {},
        );
      fail(500, 'PLUGIN_CALL_FAILED');
    } finally {
      running.calls.delete(task);
    }
  }
  return {
    catalog: () => catalog.map((e) => ({ ...e })),
    list: () =>
      (
        db.prepare('SELECT * FROM platform_plugins WHERE installed=1 ORDER BY id').all() as Row[]
      ).map((r) => {
        try { return view(syncPortableConfig(r)); }
        catch { return { ...view(r), error: 'PORTABLE_PLUGIN_DATA_UNAVAILABLE' }; }
      }),
    dataDependencies: () => portable.dependencies(catalog),
    contributions: () =>
      [...active.entries()].flatMap(([id, running]) =>
        running.manifest.contributions.map((c) => ({ ...c, pluginId: id })),
      ),
    storage,
    call,
    onChange: (listener: () => void | Promise<void>) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dependencyError: (id: string, code?: string) =>
      db.prepare('UPDATE platform_plugins SET error=? WHERE id=?').run(code || null, id),
    privateConfig: (id: string) => plain(row(id)),
    secretInfo: (id: string, field: string) => {
      const r = row(id);
      if (!manifest(r).configSchema.properties?.[field]?.writeOnly) return;
      const reference = JSON.parse(r.config_json)[field]?.$secretRef;
      if (!reference) return;
      const metadata = db
        .prepare(
          'SELECT created_at,auth_generation FROM plugin_secrets WHERE reference=? AND plugin_id=? AND field=?',
        )
        .get(reference, id, field) as any;
      return {
        reference,
        createdAt: metadata?.created_at || 0,
        authGeneration: metadata?.auth_generation ?? -1,
      };
    },
    install: (id: string, options?: PluginInstallOptions, beforeAction?: () => void) => serial(() => {
      beforeAction?.();
      return install(id, options, beforeAction);
    }),
    configure: (id: string, input: Record<string, unknown>, version: number) =>
      serial(() => configure(id, input, version)),
    enable: (id: string, beforeAction?: () => void) => serial(() => {
      beforeAction?.();
      return enable(id);
    }),
    disable: (id: string, beforeAction?: () => void) =>
      serial(async () => {
        beforeAction?.();
        row(id, false);
        await stop(id, true);
        return view(row(id, false));
      }),
    uninstall: (id: string, beforeAction?: () => void) =>
      serial(async () => {
        beforeAction?.();
        row(id, false);
        await stop(id, true);
        db.prepare('UPDATE platform_plugins SET installed=0,active_version=NULL WHERE id=?').run(
          id,
        );
      }),
    start: () =>
      serial(async () => {
        for (const r of db
          .prepare('SELECT id FROM platform_plugins WHERE installed=1 AND desired_enabled=1')
          .all() as { id: string }[]) {
          try {
            await enable(r.id);
          } catch {}
        }
      }),
    close: async () => {
      closing = true;
      await tail;
      for (const id of [...active.keys()]) await stop(id, false);
    },
    asset: (id: string, version: string, path: string) => {
      row(id);
      const running = active.get(id);
      if (!running || version !== running.version || !path.startsWith('web/') || !packagePath(path))
        fail(404, 'PLUGIN_ASSET_NOT_FOUND');
      const hash = running.files[path];
      if (!hash) fail(404, 'PLUGIN_ASSET_NOT_FOUND');
      const bytes = readFileSync(join(directory(id, version), path));
      if (sha256(bytes) !== hash) fail(400, 'PLUGIN_CHECKSUM_MISMATCH');
      return { bytes, hash, bundleHash: sha256(JSON.stringify(running.files)) };
    },
    protocol: async (id: string, key: string, request: ProtocolCall) => {
      const running = active.get(id),
        handler = running?.protocols.get(key);
      if (!handler || closing) fail(404, 'PLUGIN_PROTOCOL_UNAVAILABLE');
      const task = handler({
        ...request,
        call: {
          ...request.call,
          services: services?.(id, running!.manifest.capabilities, request.call) as PluginServices,
        },
      });
      running!.calls.add(task);
      try {
        await task;
      } finally {
        running!.calls.delete(task);
      }
    },
  };
}
