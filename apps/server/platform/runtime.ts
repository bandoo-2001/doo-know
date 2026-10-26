import type { AppConfig } from '../../../shared/contracts.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import { platformSettings } from './settings.js';
import { noteService } from '../../../packages/core/notes.js';
import { assetService } from '../../../packages/core/assets.js';
import { recoveryService } from '../../../packages/core/recovery.js';
import { shareService } from '../../../packages/core/shares.js';
import { createKnowledgeRuntime } from '../agent/routes.js';
import { assertRoot } from '../../../packages/core/indexing/reconcile.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { loadAgentConfig } from '../../../packages/core/agent/config.js';
import { collectionService } from '../../../packages/core/collections/service.js';
import { blogService } from '../../../packages/core/blog/service.js';

async function createRuntime(config: AppConfig, db: AppDatabase) {
  if (config.agentConfigFile)
    config.agent = loadAgentConfig(config.agentConfigFile, config.knowledgeRoot);
  assertRoot(config, db);
  const notes = noteService(config, db);
  const knowledge = await createKnowledgeRuntime(config, db, notes);
  let collections: ReturnType<typeof collectionService>;
  try {
    collections = collectionService(config, db, notes);
  } catch (error) {
    await knowledge.stopWatching();
    await Promise.allSettled([
      knowledge.worker.close(),
      knowledge.files.close(),
      knowledge.snapshots.close(),
      knowledge.indexing.close(),
    ]);
    throw error;
  }
  return {
    config,
    notes,
    knowledge,
    collections,
    blog: blogService(config, db, notes),
    assets: assetService(config, db, notes),
    recovery: recoveryService(config, db, notes),
    shares: shareService(db, notes),
  };
}
export function platformRuntime(config: HostConfig, db: AppDatabase) {
  const settings = platformSettings(config, db);
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let activation: Promise<void> | undefined;
  let error: string | undefined,
    closing = false;
  function activate() {
    if (activation) return activation;
    if (runtime || closing) return Promise.resolve();
    activation = (async () => {
      try {
        const resolved = settings.configured();
        if (!resolved) return;
        runtime = await createRuntime(resolved, db);
        error = undefined;
      } catch (e) {
        error = (e as any).code || 'RUNTIME_INITIALIZATION_FAILED';
      }
    })().finally(() => {
      activation = undefined;
    });
    return activation;
  }
  function get() {
    if (closing) fail(503, 'RUNTIME_STOPPING');
    if (!runtime) fail(503, error || 'SETUP_REQUIRED', '知识库尚未就绪', true);
    assertRoot(runtime.config, db);
    return runtime;
  }
  return {
    settings,
    activate,
    get,
    status: () => {
      const value = settings.status(!!runtime, !!activation, error);
      const search = runtime?.knowledge.worker.readiness();
      value.components.search = !!search?.tokenizerReady && !!search?.vectorReady;
      return value;
    },
    reconfigureSearch: (updates: Partial<AppConfig>) => get().knowledge.reconfigureSearch(updates),
    close: async () => {
      closing = true;
      await activation;
      if (!runtime) return;
      const k = runtime.knowledge;
      await runtime.collections.close();
      await k.stopWatching();
      await k.worker.close();
      await k.files.close();
      await k.snapshots.close();
      await k.indexing.close();
    },
  };
}
export function lazyService<T extends object>(read: () => T): T {
  return new Proxy({} as T, {
    get:
      (_target, key) =>
      (...args: unknown[]) => {
        const instance = read();
        const member = (instance as any)[key];
        return typeof member === 'function' ? member.apply(instance, args) : member;
      },
  });
}
