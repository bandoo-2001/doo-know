import type { AppConfig } from '../../shared/contracts.js';
import type { HostConfig } from '../../shared/platform-contracts.js';
import type { AppDatabase } from '../db.js';
import { platformSettings } from './settings.js';
import { noteService } from '../notes.js';
import { assetService } from '../assets.js';
import { recoveryService } from '../recovery.js';
import { shareService } from '../shares.js';
import { createKnowledgeRuntime } from '../agent/routes.js';
import { assertRoot } from '../indexing/reconcile.js';
import { fail } from '../knowledge/errors.js';
import { loadAgentConfig } from '../agent/config.js';

async function createRuntime(config: AppConfig, db: AppDatabase) {
  if (config.agentConfigFile) config.agent = loadAgentConfig(config.agentConfigFile, config.knowledgeRoot);
  assertRoot(config, db);
  const notes = noteService(config, db);
  const knowledge = await createKnowledgeRuntime(config, db, notes);
  return { config, notes, knowledge, assets: assetService(config, db, notes),
    recovery: recoveryService(config, db, notes), shares: shareService(db, notes) };
}
export function platformRuntime(config: HostConfig, db: AppDatabase) {
  const settings = platformSettings(config, db);
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let activation: Promise<void> | undefined;
  let error: string | undefined, closing = false;
  function activate() {
    if (activation) return activation;
    if (runtime || closing) return Promise.resolve();
    activation = (async () => {
      try {
        const resolved = settings.configured();
        if (!resolved) return;
        runtime = await createRuntime(resolved, db);
        error = undefined;
      } catch (e) { error = (e as any).code || 'RUNTIME_INITIALIZATION_FAILED'; }
    })().finally(() => { activation = undefined; });
    return activation;
  }
  function get() {
    if (closing) fail(503, 'RUNTIME_STOPPING');
    if (!runtime) fail(503, error || 'SETUP_REQUIRED', '知识库尚未就绪', true);
    assertRoot(runtime.config, db);
    return runtime;
  }
  return { settings, activate, get,
    status: () => settings.status(!!runtime, !!activation, error),
    close: async () => {
      closing = true;
      await activation;
      if (!runtime) return;
      const k = runtime.knowledge;
      await k.stopWatching(); await k.worker.close(); await k.files.close();
      await k.snapshots.close(); await k.indexing.close();
    } };
}
export function lazyService<T extends object>(read: () => T): T {
  return new Proxy({} as T, { get: (_target, key) => (...args: unknown[]) => {
    const instance = read(); const member = (instance as any)[key];
    return typeof member === 'function' ? member.apply(instance, args) : member;
  } });
}
