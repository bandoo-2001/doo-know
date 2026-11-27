import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { AppDatabase } from '../../../packages/core/db.js';
import {
  type FeatureCall,
  type FeatureRuntimeContext,
  type HostCallContext,
  type IntegrationServices,
  type ProtocolCall,
  type Disposer,
} from '../../../packages/core/integration-ports.js';
import {
  prepareFeatureSettings,
  featureSettingsRow,
} from '../../../packages/core/feature-settings.js';
import { fail, KnowledgeError } from '../../../packages/core/knowledge/errors.js';
import { remoteAuthGeneration } from '../../../packages/core/auth/remote-auth.js';
import {
  featureIds,
  featureConfig,
  featureCapabilities,
  type FeatureId,
} from '../../../shared/feature-config.js';
import type { FeatureCallInput, FeatureView } from '../../../shared/feature-contracts.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import { activate as startGit } from '../git/operations.js';
import { activate as startMcp, validateMcpConfig } from '../mcp/index.js';
import { portableGitSettings } from '../git/portable-settings.js';
import { featureStorage, mcpObjectSecret } from './storage.js';

type Handler = (call: FeatureCall) => unknown | Promise<unknown>;
type Active = {
  commands: Map<string, Handler>;
  providers: Map<string, Handler>;
  protocol?: (call: ProtocolCall) => Promise<void>;
  calls: Set<Promise<unknown>>;
  disposers: Disposer[];
  config: Record<string, any>;
};
const setup = { git: startGit, mcp: startMcp };
const ajv = new Ajv({ strict: false, useDefaults: true });
const validators = { git: ajv.compile(featureConfig.git), mcp: ajv.compile(featureConfig.mcp) };

export function featureRuntime(
  config: HostConfig,
  db: AppDatabase,
  services: (
    id: FeatureId,
    capabilities: string[],
    context: HostCallContext,
  ) => IntegrationServices,
  knowledgeRoot: () => string | undefined,
) {
  prepareFeatureSettings(db);
  const portableGit = portableGitSettings(db, knowledgeRoot);
  const active = new Map<FeatureId, Active>();
  const tails = { git: Promise.resolve(), mcp: Promise.resolve() };
  let closing = false;

  function serialize<T>(id: FeatureId, work: () => Promise<T>): Promise<T> {
    const result = tails[id].then(work);
    tails[id] = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function validate(id: FeatureId, input: Record<string, unknown>) {
    const values = structuredClone(input);
    if (!validators[id](values)) fail(400, 'INVALID_FEATURE_CONFIG', '功能配置不符合要求');
    if (id === 'mcp') validateMcpConfig(values);
    return values;
  }

  function row(id: FeatureId) {
    return featureSettingsRow(db, id);
  }

  function settings(id: FeatureId): FeatureView {
    const current = row(id);
    const stored = JSON.parse(current.config_json);
    const properties = featureConfig[id].properties;
    const values = Object.fromEntries(
      Object.keys(properties)
        .filter((key) => Object.hasOwn(stored, key))
        .map((key) => [key, stored[key]]),
    );
    let { config_version: configVersion, error } = current;
    if (id === 'git') {
      try {
        const portable = portableGit.read(values);
        if (portable) {
          const next = { ...values };
          delete next.authorName;
          delete next.authorEmail;
          Object.assign(next, portable);
          if (
            ['authorName', 'authorEmail'].some((key) => (values[key] || '') !== (next[key] || ''))
          ) {
            db.prepare(
              'UPDATE platform_plugins SET config_json=?,config_version=config_version+1 WHERE id=?',
            ).run(JSON.stringify({ ...stored, authorName: '', authorEmail: '', ...next }), id);
            configVersion++;
            Object.assign(values, { authorName: '', authorEmail: '' }, portable);
            const running = active.get(id);
            if (running) running.config = validate(id, values);
          }
        }
      } catch {
        error = 'PORTABLE_GIT_SETTINGS_UNAVAILABLE';
      }
    }
    const defaults = Object.fromEntries(
      Object.entries(properties)
        .filter(([, schema]) => 'default' in schema)
        .map(([key, schema]) => [key, structuredClone((schema as { default: unknown }).default)]),
    );
    return {
      id,
      desiredEnabled: Boolean(current.desired_enabled),
      state: current.state,
      configVersion,
      config: { ...defaults, ...values },
      ...(error ? { error } : {}),
    };
  }

  function track<T>(running: Active, task: Promise<T>) {
    running.calls.add(task);
    void task.then(
      () => running.calls.delete(task),
      () => running.calls.delete(task),
    );
    return task;
  }

  async function dispose(running: Active) {
    for (const release of running.disposers.reverse()) await release();
  }

  async function start(id: FeatureId) {
    if (active.has(id)) return;
    db.prepare(
      "UPDATE platform_plugins SET desired_enabled=1,state='starting',error=NULL WHERE id=?",
    ).run(id);
    const running: Active = {
      commands: new Map(),
      providers: new Map(),
      calls: new Set(),
      disposers: [],
      config: {},
    };
    try {
      running.config = validate(id, settings(id).config);
      const context: FeatureRuntimeContext = {
        id,
        // Git previews and pending commit intents reference this existing path.
        dataRoot: join(config.dataRoot, 'plugins', id),
        storage: featureStorage(db, id),
        config: () => structuredClone(running.config),
        track: (task) => track(running, task),
        secrets: { getOrCreate: () => mcpObjectSecret(config) },
        registerCommand: (key, handler) => {
          running.commands.set(key, handler);
          return () => {
            running.commands.delete(key);
          };
        },
        registerProvider: (key, handler) => {
          running.providers.set(key, handler);
          return () => {
            running.providers.delete(key);
          };
        },
        registerProtocol: (_key, handler) => {
          running.protocol = handler;
          return () => {
            running.protocol = undefined;
          };
        },
        onDispose: (release) => {
          running.disposers.push(release);
        },
      };
      setup[id](context);
      active.set(id, running);
      db.prepare("UPDATE platform_plugins SET state='enabled' WHERE id=?").run(id);
    } catch (error) {
      active.delete(id);
      await dispose(running);
      const failure = error as { code?: string; details?: { code?: string } };
      db.prepare("UPDATE platform_plugins SET state='failed',error=? WHERE id=?").run(
        failure.code || failure.details?.code || 'FEATURE_START_FAILED',
        id,
      );
      throw error;
    }
  }

  async function stop(id: FeatureId, persist: boolean) {
    db.prepare(
      `UPDATE platform_plugins SET state='stopping'${persist ? ',desired_enabled=0' : ''} WHERE id=?`,
    ).run(id);
    const running = active.get(id);
    active.delete(id);
    if (running) {
      // A Git commit past its publication boundary must retain its write permit
      // and finish before the switch reports that Git has stopped.
      if (id === 'mcp') await dispose(running);
      while (running.calls.size) await Promise.allSettled([...running.calls]);
      if (id === 'git') await dispose(running);
    }
    db.prepare("UPDATE platform_plugins SET state='disabled',error=NULL WHERE id=?").run(id);
  }

  async function configure(id: FeatureId, input: unknown, expectedVersion: number) {
    const current = settings(id);
    if (current.configVersion !== expectedVersion) fail(409, 'CONFIG_VERSION_CONFLICT');
    if (id === 'git' && current.error === 'PORTABLE_GIT_SETTINGS_UNAVAILABLE')
      fail(503, current.error, '暂时无法读取仓库中的 Git 署名设置');
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail(400, 'INVALID_FEATURE_CONFIG');
    const values = validate(id, { ...current.config, ...input });
    const stored = JSON.parse(row(id).config_json);
    const generation = remoteAuthGeneration(db);
    const portable = id === 'git' ? portableGit.prepare(current.config) : undefined;
    db.transaction(() => {
      if (generation !== remoteAuthGeneration(db)) fail(409, 'AUTHORIZATION_CHANGED');
      portable?.check();
      const updated = db
        .prepare(
          'UPDATE platform_plugins SET config_json=?,config_version=config_version+1 WHERE id=? AND config_version=?',
        )
        .run(JSON.stringify({ ...stored, ...values }), id, expectedVersion);
      if (updated.changes !== 1) fail(409, 'CONFIG_VERSION_CONFLICT');
      portable?.write(values);
    }).immediate();
    // Live policy reads use the saved settings. Switch the service snapshot
    // before publishing the portable projection in case that publication fails.
    const running = active.get(id);
    if (running) running.config = values;
    portable?.flush();
    return settings(id);
  }

  function requireActive(id: FeatureId) {
    const running = active.get(id);
    if (!running || closing) fail(409, id === 'git' ? 'GIT_DISABLED' : 'MCP_DISABLED');
    return running;
  }

  return {
    settings,
    enabled: (id: FeatureId) => active.has(id) && !closing,
    async start() {
      for (const id of featureIds) {
        if (!row(id).desired_enabled) continue;
        try {
          await serialize(id, () => start(id));
        } catch {
          /* Show the failure in the feature settings. */
        }
      }
    },
    configure: (id: FeatureId, input: unknown, version: number) =>
      serialize(id, () => configure(id, input, version)),
    setEnabled: (id: FeatureId, enabled: boolean, guard?: () => void) =>
      serialize(id, async () => {
        if (closing) fail(503, 'FEATURES_STOPPING');
        guard?.();
        if (enabled) await start(id);
        else await stop(id, true);
        return settings(id);
      }),
    async close() {
      closing = true;
      await Promise.all(Object.values(tails));
      await Promise.all([...active.keys()].map((id) => stop(id, false)));
    },
    async call(id: FeatureId, input: FeatureCallInput, context: HostCallContext) {
      const running = requireActive(id);
      if (!input || !['command', 'provider'].includes(input.kind) || typeof input.id !== 'string')
        fail(400, 'INVALID_FEATURE_CALL');
      const handler = (input.kind === 'command' ? running.commands : running.providers).get(
        input.id,
      );
      if (!handler) fail(404, 'FEATURE_ACTION_NOT_FOUND');
      const task = Promise.resolve().then(() =>
        handler({
          ...context,
          input: input.input,
          services: services(id, featureCapabilities[id], context),
        }),
      );
      try {
        return await track(running, task);
      } catch (error) {
        if (error instanceof KnowledgeError) throw error;
        const failure = error as {
          code?: string;
          statusCode?: number;
          status?: number;
          retryable?: boolean;
          publication?: string;
        };
        if (failure.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code))
          fail(
            failure.statusCode || failure.status || 500,
            failure.code,
            failure.code,
            !!failure.retryable,
            failure.publication === 'not_published' ? { publication: 'not_published' } : {},
          );
        fail(500, 'FEATURE_CALL_FAILED');
      }
    },
    async mcpRequest(request: Omit<ProtocolCall, 'call'> & { call: HostCallContext }) {
      const running = requireActive('mcp');
      const handler = running.protocol;
      if (!handler) fail(404, 'MCP_DISABLED');
      await track(
        running,
        handler({
          ...request,
          call: {
            ...request.call,
            input: {},
            services: services('mcp', featureCapabilities.mcp, request.call),
          },
        }),
      );
    },
  };
}
